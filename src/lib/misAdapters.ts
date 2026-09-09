import { fetchAllRows } from "@/lib/amazonReportShared";
import { supabasePublic } from "@/lib/amazonReportUpload";
import type { UploadReportType } from "@/lib/amazonReportUpload";

// Adapters for the 6 report tables the client moved from this app's own
// upload-populated barm_* tables to the pre-existing MIS (management
// information system) database — a live Amazon/Flipkart order+return feed
// synced by an external pipeline this app doesn't control:
//
//   barm_amazon_am_orders     -> amazon_orders
//   barm_amazon_am_returns    -> amazon_returns
//   barm_amazon_fba_returns   -> amazon_fba_returns
//   barm_amazon_sf_return     -> amazon_seller_flex_return
//   barm_flipkart_order_report -> fk_orders
//   barm_flipkart_returns     -> fk_returns
//
// The MIS tables have a completely different column shape (hyphenated/spaced
// JSON-style keys, numbers-as-strings, different date formats) than the
// barm_* tables the rest of the app's report logic (amazonReportShared.ts,
// each *ReportExport.ts file) was written against. Rather than touch that
// hard-won business logic, each function below queries the MIS table and maps
// every row into the EXACT SAME field-name shape mapOrderRow/mapAmReturnRow/
// mapFbaReturnRow/mapSfReturnRow (src/lib/amazonReportUpload.ts) and
// parseOrderReport/parseReturnsReport (src/lib/flipkartReportUpload.ts)
// already produce — so every existing consumer keeps working unchanged, only
// the data source moves.
//
// Do NOT import these adapters from any upload/write path
// (amazonReportUpload.ts, flipkartReportUpload.ts, combinedAdSpendUpload.ts) —
// CSV uploads keep writing to the barm_* tables exactly as before. These are
// READ-only replacements for report-generation call sites.

// ── generic value parsing (small local copies of amazonReportUpload.ts's /
// flipkartReportUpload.ts's private helpers — not imported from there so this
// file never has to touch, or even import from the module namespace of, those
// upload/write-path files) ──────────────────────────────────────────────────

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function toNum(v: unknown): number {
  const s = str(v);
  if (!s) return 0;
  const cleaned = s.replace(/[^0-9.-]/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function toInt(v: unknown): number {
  return Math.round(toNum(v));
}

// Flipkart (fk_orders) wraps a handful of id-like columns with a type tag
// ("OI:", "OD:", "R:", "DTr:", "SKU:", "FSN:") — same artefact
// flipkartReportUpload.ts's own `clean()` strips for the barm_flipkart_*
// upload path. Reproduced here (not imported) so this read-only adapter file
// never touches that write-path module.
function cleanTag(v: unknown): string {
  let s = str(v);
  const tag = /^(SKU|OI|OD|R|DTr|FSN):/i.exec(s);
  if (tag) s = s.slice(tag[0].length).trim();
  return s;
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

// "08-May-26" -> "2026-05-08" — same DD-Mon-YY format amazonReportUpload.ts's
// parseDDMonYY handles for AM returns/SF returns, and flipkartReportUpload.ts's
// toDate() handles for the Returns report; the MIS tables carry the identical
// format on amazon_returns, amazon_seller_flex_return and fk_returns.
function parseDDMonYY(v: unknown): string | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/.exec(str(v));
  if (!m) return null;
  const mm = MONTHS[m[2].toLowerCase()];
  if (!mm) return null;
  const year = 2000 + Number(m[3]);
  return `${year}-${mm}-${m[1].padStart(2, "0")}`;
}

// Takes the "YYYY-MM-DD" prefix off an ISO-ish value ("2026-05-11" or
// "2026-05-11 10:15:22"), same as flipkartReportUpload.ts's toDate() does for
// its own already-ISO inputs. Returns null for blank/unparseable values.
function dateOnly(v: unknown): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(str(v));
  return m ? m[1] : null;
}

// amazon_orders' "purchase-date" arrives as "YYYY-MM-DD HH:mm:ss" with NO
// timezone offset. Verified directly against this table's own
// "last-updated-date" (which DOES carry an explicit "+00:00" UTC offset and,
// per Amazon's own order lifecycle, is always at or after purchase time):
// treating "purchase-date" as a UTC instant put last-updated-date BEFORE
// purchase-date on 31 of 50 sampled rows (impossible); treating it as IST
// (UTC+5:30) instead gave zero such inversions across the same 50 rows, with
// a plausible few-minutes-to-few-hours gap every time. So "purchase-date" is
// IST wall-clock time, not UTC — this converts it to the genuine UTC instant
// (explicit "+05:30" offset, so the result doesn't depend on the server
// process's own timezone).
function istWallClockToUtcIso(v: unknown): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(str(v));
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}+05:30`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ── in-memory filter shim ───────────────────────────────────────────────────
//
// Every existing report file filters fetchAllRows() with an
// `apply: (q) => q.gte(field, value).lt(field, value)` callback written
// against the OLD normalized field names (purchase_datetime, return_date,
// pickup_date, ...) — which don't exist as columns on the MIS tables (whose
// raw columns are hyphenated/spaced, e.g. "purchase-date"), and whose date
// VALUES are in a different format besides (see istWallClockToUtcIso above).
// Forwarding those callbacks straight into a Supabase query against the MIS
// table would either 500 ("column ... does not exist") or silently filter on
// the wrong instant.
//
// Instead, each fetchMis*() below pulls the whole MIS table (paginated via
// fetchAllRows, unfiltered) and maps every row into the OLD field shape
// FIRST, then replays the exact same `apply` callback here — as a stand-in
// query-builder that only records .gte/.lte/.lt/.gt/.eq calls — against the
// mapped, already-correctly-shaped rows in memory. This lets every call site
// keep its existing `(q) => q.gte("purchase_datetime", ...)`-style filter
// completely unchanged.
type FilterOp = "gte" | "lte" | "lt" | "gt" | "eq";
interface FilterCall {
  field: string;
  op: FilterOp;
  value: unknown;
}

class MemoryFilterBuilder {
  filters: FilterCall[] = [];
  private add(field: string, op: FilterOp, value: unknown): this {
    this.filters.push({ field, op, value });
    return this;
  }
  gte(field: string, value: unknown): this { return this.add(field, "gte", value); }
  lte(field: string, value: unknown): this { return this.add(field, "lte", value); }
  lt(field: string, value: unknown): this { return this.add(field, "lt", value); }
  gt(field: string, value: unknown): this { return this.add(field, "gt", value); }
  eq(field: string, value: unknown): this { return this.add(field, "eq", value); }
  // fetchAllRows-style callers sometimes chain .order(...) too (it's a no-op
  // here — ordering doesn't affect which rows are kept).
  order(): this { return this; }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyMemoryFilter<T extends Record<string, any>>(rows: T[], apply: (q: any) => any): T[] {
  const builder: MemoryFilterBuilder = apply(new MemoryFilterBuilder());
  const filters = builder.filters;
  if (!filters.length) return rows;
  return rows.filter((row) =>
    filters.every(({ field, op, value }) => {
      const v = row[field];
      if (v === undefined || v === null || v === "") return false;
      // Filter values are always the date strings / numeric bounds these
      // report files pass to fetchAllRows's own .gte/.lt/.lte callbacks.
      const cmp = value as string | number;
      switch (op) {
        case "gte": return v >= cmp;
        case "lte": return v <= cmp;
        case "lt": return v < cmp;
        case "gt": return v > cmp;
        case "eq": return v === cmp;
        default: return true;
      }
    })
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApplyFn = (q: any) => any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawRow = Record<string, any>;

// ── per-table row mappers (-> old barm_* field shape) ───────────────────────

// -> mapOrderRow's shape in amazonReportUpload.ts.
function mapMisAmazonOrderRow(row: RawRow) {
  const purchaseUtcIso = istWallClockToUtcIso(row["purchase-date"]);
  // Patch the raw payload's own "purchase-date" key (Amazon's own CSV export
  // uses this exact key name) to hold the corrected genuine-UTC instant
  // instead of the MIS pipeline's IST wall-clock string. Downstream consumers
  // that read dates straight off `.raw` — e.g.
  // historicalAnalysisReportExport.ts's "IST with Time"/"Date " raw-sheet
  // columns, computed via istSerial(get("purchase-date")) — expect
  // raw["purchase-date"] to already BE a UTC instant exactly like it was for
  // the old CSV-sourced barm_amazon_am_orders table; leaving the MIS value
  // as-is there would double-apply the +5:30 IST shift.
  const raw: RawRow = { ...row, "purchase-date": purchaseUtcIso ?? row["purchase-date"] };
  return {
    amazon_order_id: str(row["amazon-order-id"]),
    // amazon_orders has no per-line-item id column — a multi-SKU order shares
    // one "amazon-order-id" across its rows (verified: 25 of 1000 sampled
    // order ids repeat). The row's own unique uuid `id` stands in: it's
    // always unique, so it's safe for the dedup keys some report files build
    // as `${order_item_id}|${item_status}|${quantity}` (e.g.
    // adSpendReportExport.ts) — never accidentally collapsing two genuinely
    // distinct line items that happen to share status+quantity.
    order_item_id: str(row.id),
    purchase_date: purchaseUtcIso ? purchaseUtcIso.slice(0, 10) : null,
    purchase_datetime: purchaseUtcIso,
    order_status: str(row["order-status"]),
    fulfillment_channel: str(row["fulfillment-channel"]),
    sales_channel: str(row["sales-channel"]),
    product_name: str(row["product-name"]),
    sku: str(row.sku),
    asin: str(row.asin),
    item_status: str(row["item-status"]),
    quantity: toInt(row.quantity),
    currency: str(row.currency),
    item_price: toNum(row["item-price"]),
    item_tax: toNum(row["item-tax"]),
    shipping_price: toNum(row["shipping-price"]),
    item_promotion_discount: toNum(row["item-promotion-discount"]),
    ship_city: str(row["ship-city"]),
    ship_state: str(row["ship-state"]),
    ship_postal_code: str(row["ship-postal-code"]),
    raw,
  };
}

// -> mapAmReturnRow's shape.
function mapMisAmReturnRow(row: RawRow) {
  return {
    order_id: str(row["Order ID"]),
    order_item_id: str(row["Order Item ID"]),
    order_date: parseDDMonYY(row["Order date"]),
    return_request_date: parseDDMonYY(row["Return request date"]),
    return_request_status: str(row["Return request status"]),
    asin: str(row.ASIN),
    merchant_sku: str(row["Merchant SKU"]),
    item_name: str(row["Item Name"]),
    return_quantity: toInt(row["Return quantity"]),
    return_reason: str(row["Return reason"]),
    in_policy: str(row["In policy"]),
    return_type: str(row["Return type"]),
    resolution: str(row.Resolution),
    order_amount: toNum(row["Order Amount"]),
    order_quantity: toInt(row["Order quantity"]),
    category: str(row.Category),
    raw: row,
  };
}

// -> mapFbaReturnRow's shape. "return-date" already carries an explicit UTC
// offset ("2026-05-14T12:06:09+00:00"), so — unlike amazon_orders'
// "purchase-date" — it's passed through unchanged.
function mapMisFbaReturnRow(row: RawRow) {
  return {
    return_date: str(row["return-date"]) || null,
    order_id: str(row["order-id"]),
    sku: str(row.sku),
    asin: str(row.asin),
    fnsku: str(row.fnsku),
    product_name: str(row["product-name"]),
    quantity: toInt(row.quantity),
    fulfillment_center_id: str(row["fulfillment-center-id"]),
    detailed_disposition: str(row["detailed-disposition"]),
    reason: str(row.reason),
    license_plate_number: str(row["license-plate-number"]),
    customer_comments: str(row["customer-comments"]),
    raw: row,
  };
}

// -> mapSfReturnRow's shape (that mapper has no "reason"-equivalent field
// either — amazon_seller_flex_return's own "Return Reason" column is still
// available to any consumer that reads `.raw` directly).
function mapMisSfReturnRow(row: RawRow) {
  return {
    return_type: str(row["Return Type"]),
    customer_order_id: str(row["Customer Order ID"]),
    shipment_id: str(row["Shipment ID"]),
    sku: str(row.SKU),
    msku: str(row.mSKU),
    asin: str(row.ASIN),
    external_id_1: str(row["External ID1"]),
    external_id_2: str(row["External ID2"]),
    external_id_3: str(row["External ID3"]),
    units: toInt(row.Units),
    forward_leg_tracking_id: str(row["Forward Leg Tracking ID"]),
    reverse_leg_tracking_id: str(row["Reverse Leg Tracking ID"]),
    rma_id: str(row["RMA ID"]),
    return_status: str(row["Return Status"]),
    carrier: str(row.Carrier),
    // Column name has a stray space in the MIS table itself: "Pick -up date".
    pickup_date: parseDDMonYY(row["Pick -up date"]),
    last_updated_on: parseDDMonYY(row["Last Updated On"]),
    returned_with_otp: str(row["Returned with OTP"]),
    days_in_transit: toInt(row["Days In-transit"]),
    days_since_return_complete: toInt(row["Days Since Return Complete"]),
    raw: row,
  };
}

// -> parseOrderReport's shape in flipkartReportUpload.ts. fk_orders already
// uses the same snake_case column convention (not hyphenated), so this is
// mostly a straight field copy plus id-tag stripping and numeric coercion.
function mapMisFkOrderRow(row: RawRow) {
  const orderDateRaw = str(row.order_date);
  return {
    order_item_id: cleanTag(row.order_item_id),
    order_id: cleanTag(row.order_id),
    fulfilment_source: str(row.fulfilment_source),
    fulfilment_type: str(row.fulfilment_type),
    order_date: dateOnly(orderDateRaw),
    order_datetime: orderDateRaw || null,
    order_approval_date: str(row.order_approval_date) || null,
    order_item_status: str(row.order_item_status),
    sku: cleanTag(row.sku),
    fsn: cleanTag(row.fsn),
    product_title: cleanTag(row.product_title),
    quantity: toInt(row.quantity),
    delivery_logistics_partner: str(row.delivery_logistics_partner),
    pickup_logistics_partner: str(row.pickup_logistics_partner),
    delivery_tracking_id: cleanTag(row.delivery_tracking_id),
    order_cancellation_date: dateOnly(row.order_cancellation_date),
    cancellation_reason: str(row.cancellation_reason),
    cancellation_sub_reason: str(row.cancellation_sub_reason),
    order_return_approval_date: dateOnly(row.order_return_approval_date),
    return_id: cleanTag(row.return_id),
    return_reason: str(row.return_reason),
    return_sub_reason: str(row.return_sub_reason),
    dispatched_date: dateOnly(row.dispatched_date),
    order_delivery_date: dateOnly(row.order_delivery_date),
    dispatch_sla_breached: str(row.dispatch_sla_breached),
    delivery_sla_breached: str(row.delivery_sla_breached),
    raw: row,
  };
}

// -> parseReturnsReport's shape.
function mapMisFkReturnRow(row: RawRow) {
  return {
    order_id: str(row["Order ID"]),
    order_item_id: str(row["Order Item ID"]),
    return_id: str(row["Return ID"]),
    sku: str(row.SKU),
    fsn: str(row.FSN),
    product_title: str(row.Product),
    total_price: toNum(row["Total Price"]),
    quantity: toInt(row.Quantity),
    ff_type: str(row["FF Type"]),
    return_requested_date: parseDDMonYY(row["Return Requested Date"]),
    return_approval_date: parseDDMonYY(row["Return Approval Date"]),
    completed_date: parseDDMonYY(row["Completed Date"]),
    return_status: str(row["Return Status"]),
    completion_status: str(row["Completion Status"]),
    return_type: str(row["Return Type"]),
    return_reason: str(row["Return Reason"]),
    return_sub_reason: str(row["Return Sub-reason"]),
    location_name: str(row["Location Name"]),
    raw: row,
  };
}

// ── public fetchers — one per table pair, mirroring fetchAllRows's
// (apply) => filtered-rows signature ────────────────────────────────────────
//
// Every fetcher below USED to pull the whole MIS table unfiltered (see the
// in-memory filter shim above) before replaying the caller's date filter in
// memory — fine when these tables were a few thousand rows, but
// amazon_orders alone is now 34,000+ and growing every day via the external
// sync, and pulling all of it (paginated 1000 rows at a time, ordered by a
// random UUID id that needs a full sort each page) started hard-failing in
// production: "Fetch amazon_orders failed: canceling statement due to
// statement timeout" on the Historical Analysis Report.
//
// Fix: for the 3 tables whose raw date column is lexically/chronologically
// sortable as a plain string (amazon_orders' "purchase-date", ISO-ish;
// amazon_fba_returns' "return-date", full ISO timestamptz; fk_orders'
// "order_date", ISO-ish), peek the caller's date-range bound BEFORE
// fetching and push an equivalent (deliberately widened) range down to
// Postgres via peekDateBound/fetchMisDateFiltered — cutting the rows
// actually fetched from "the whole table" to "roughly the requested
// window." The caller's EXACT original filter still runs via
// applyMemoryFilter afterward, so a widened pushdown only costs a few extra
// fetched rows, never correctness.
//
// The other 3 (amazon_returns' "Return request date", amazon_seller_flex_
// return's "Pick -up date", fk_returns' "Return Requested Date") are all
// "DD-Mon-YY" text — NOT chronologically sortable as a plain string
// ("15-Feb-26" < "01-Jan-26" alphabetically, despite Feb being after Jan) —
// so a naive gte/lte pushdown on them would silently return the WRONG rows,
// not just extra ones. Left as full-table fetches for now; smaller tables
// today, but the same timeout risk applies once they grow.

/** Peeks the gte/gt and lt/lte bounds an `apply` callback sets on `field`,
 *  without touching real rows. */
function peekDateBound(apply: ApplyFn, field: string): { start?: string; end?: string } {
  const builder = new MemoryFilterBuilder();
  apply(builder);
  let start: string | undefined, end: string | undefined;
  builder.filters.forEach((f) => {
    if (f.field !== field || typeof f.value !== "string") return;
    if (f.op === "gte" || f.op === "gt") start = f.value;
    if (f.op === "lte" || f.op === "lt") end = f.value;
  });
  return { start, end };
}

function addDays(dateOnly: string, days: number): string {
  const d = new Date(`${dateOnly.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Fetches `table`, pushing a (marginDays-widened) range on `rawCol` down to
 *  Postgres when `apply` filters `mappedField` by date — instead of always
 *  pulling the whole table. Uses a half-open gte/lt range (never lte) so the
 *  comparison stays correct whether rawCol carries a bare date or a full
 *  "YYYY-MM-DD HH:mm:ss" string ("...23:59:00" is NOT <= "2026-08-27", but
 *  it IS < "2026-08-28"). Falls back to an unfiltered fetch if the caller
 *  didn't filter by the expected field, so this is never less complete than
 *  before, only faster in the common case. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchMisDateFiltered<T extends Record<string, any>>(
  table: string,
  rawCol: string,
  mappedField: string,
  marginDays: number,
  apply: ApplyFn,
  mapRow: (row: RawRow) => T
): Promise<T[]> {
  const { start, end } = peekDateBound(apply, mappedField);
  // Ordered by (rawCol, id) instead of fetchAllRows's default "id" whenever this call actually
  // filters by date — rawCol is what the WHERE clause above is on, so Postgres can (if that column
  // is indexed, as report_date is on the barm_* tables) satisfy the ORDER BY from the same index
  // scan instead of a separate Sort over every matching row on each paginated page. Without this,
  // fetchMisAmazonOrders/fetchMisFbaReturns hit a statement timeout once these MIS tables grew —
  // same root cause and fix as adSpendReportExport.ts's fetchDailyAmazonOrders/fetchDailyFlipkartOrders.
  // "id" stays as a tiebreaker for .range() pagination stability (fetchAllRows's own requirement).
  const orderBy = start || end ? [rawCol, "id"] : "id";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await fetchAllRows(table, (q: any) => {
    let qq = q;
    if (start) qq = qq.gte(rawCol, addDays(start, -marginDays));
    if (end) qq = qq.lt(rawCol, addDays(end, marginDays + 1));
    return qq;
  }, orderBy);
  return applyMemoryFilter(rows.map(mapRow), apply);
}

export async function fetchMisAmazonOrders(apply: ApplyFn): Promise<ReturnType<typeof mapMisAmazonOrderRow>[]> {
  // purchase-date is IST wall-clock, purchase_datetime (what callers filter
  // on) is UTC — up to a day apart, hence the 1-day margin.
  return fetchMisDateFiltered("amazon_orders", "purchase-date", "purchase_datetime", 1, apply, mapMisAmazonOrderRow);
}

export async function fetchMisAmazonReturns(apply: ApplyFn): Promise<ReturnType<typeof mapMisAmReturnRow>[]> {
  const rows = await fetchAllRows("amazon_returns", (q) => q);
  return applyMemoryFilter(rows.map(mapMisAmReturnRow), apply);
}

export async function fetchMisFbaReturns(apply: ApplyFn): Promise<ReturnType<typeof mapMisFbaReturnRow>[]> {
  // return-date already carries an explicit UTC offset — same timeline as
  // the return_date filter callers pass, so no margin needed.
  return fetchMisDateFiltered("amazon_fba_returns", "return-date", "return_date", 0, apply, mapMisFbaReturnRow);
}

export async function fetchMisSellerFlexReturns(apply: ApplyFn): Promise<ReturnType<typeof mapMisSfReturnRow>[]> {
  const rows = await fetchAllRows("amazon_seller_flex_return", (q) => q);
  return applyMemoryFilter(rows.map(mapMisSfReturnRow), apply);
}

export async function fetchMisFkOrders(apply: ApplyFn): Promise<ReturnType<typeof mapMisFkOrderRow>[]> {
  // order_date is the same field name and timeline raw and mapped — still a
  // 1-day margin since callers may pass a bare date while the raw column
  // carries a full timestamp.
  return fetchMisDateFiltered("fk_orders", "order_date", "order_date", 1, apply, mapMisFkOrderRow);
}

export async function fetchMisFkReturns(apply: ApplyFn): Promise<ReturnType<typeof mapMisFkReturnRow>[]> {
  const rows = await fetchAllRows("fk_returns", (q) => q);
  return applyMemoryFilter(rows.map(mapMisFkReturnRow), apply);
}

// ── "data on file" summaries for the Upload page ────────────────────────────
//
// am_orders/am_returns/fba_returns/sf_return's report-generation call sites
// (above) already read from the MIS tables, not the barm_* CSV-upload
// tables — so the Upload page's "data on file" caption for those 4 cards
// needs the same source, or it shows the barm_* table's count (0 once a
// seller stops uploading CSVs the report no longer reads) instead of what
// the report actually uses.
export interface MisReportDataInfo {
  rowCount: number;
  minDate: string | null;
  maxDate: string | null;
  /** Set when this source's fetch failed — rowCount/minDate/maxDate are
   *  meaningless zero/null placeholders in that case, not "table is empty". */
  error?: string;
}

function summarizeDates<T extends Record<string, unknown>>(rows: T[], dateField: keyof T): MisReportDataInfo {
  // fba_returns' return_date is a full timestamptz ("...+00:00"); sorting the
  // raw strings still gives the right min/max instant, but the card should
  // display just the date part like every other card's caption does.
  const dates = rows.map((r) => r[dateField] as string | null).filter((d): d is string => !!d).sort();
  const toDateOnly = (d: string | undefined) => (d ? d.slice(0, 10) : null);
  return { rowCount: rows.length, minDate: toDateOnly(dates[0]), maxDate: toDateOnly(dates[dates.length - 1]) };
}

// Cheap "data on file" summary for a table whose raw date column is
// chronologically sortable as a plain string (see fetchMisDateFiltered's
// header comment above for which MIS tables qualify) — count + min + max via
// 3 small indexed queries instead of pulling every row into memory and
// sorting client-side. fetchMisAmazonOrdersInfo/fetchMisFbaReturnsInfo used
// to call their real fetchMisAmazonOrders/fetchMisFbaReturns with an
// unfiltered `(q) => q`, which meant peekDateBound found nothing to push down
// and fetchAllRows pulled the WHOLE table — exactly the "canceling statement
// due to statement timeout" fetchAllRows was fixed for on amazon_orders
// elsewhere, just re-triggered here since this caption never actually needed
// the rows, only the 3 numbers.
async function fetchTableSummary(table: string, rawCol: string): Promise<MisReportDataInfo> {
  const [{ count, error: countErr }, minRes, maxRes] = await Promise.all([
    supabasePublic.from(table).select("*", { count: "exact", head: true }),
    supabasePublic.from(table).select("*").not(rawCol, "is", null).order(rawCol, { ascending: true }).limit(1),
    supabasePublic.from(table).select("*").not(rawCol, "is", null).order(rawCol, { ascending: false }).limit(1),
  ]);
  if (countErr) throw new Error(`Fetch ${table} summary failed: ${countErr.message}`);
  if (minRes.error) throw new Error(`Fetch ${table} min date failed: ${minRes.error.message}`);
  if (maxRes.error) throw new Error(`Fetch ${table} max date failed: ${maxRes.error.message}`);
  const minVal = (minRes.data?.[0] as Record<string, unknown> | undefined)?.[rawCol];
  const maxVal = (maxRes.data?.[0] as Record<string, unknown> | undefined)?.[rawCol];
  const toDateOnly = (v: unknown) => (typeof v === "string" && v ? v.slice(0, 10) : null);
  return { rowCount: count || 0, minDate: toDateOnly(minVal), maxDate: toDateOnly(maxVal) };
}

export async function fetchMisAmazonOrdersInfo(): Promise<MisReportDataInfo> {
  return fetchTableSummary("amazon_orders", "purchase-date");
}

// amazon_returns' and amazon_seller_flex_return's raw date columns are
// "DD-Mon-YY" text (see the "DD-Mon-YY text" comment above
// fetchMisDateFiltered) — NOT chronologically sortable as a plain string, so
// fetchTableSummary's Postgres-side ORDER BY would silently return the wrong
// min/max row. But the previous fix here (fetchMisAmazonReturns((q) => q),
// i.e. a full `select("*")` of every column) is exactly the unbounded
// full-table fetch that hit "canceling statement due to statement timeout"
// for amazon_orders/amazon_fba_returns — same risk here as those tables grow.
// Compromise: a fast indexed count (safe regardless of column format) plus a
// full-table fetch of ONLY the raw date column (not select("*")), parsed and
// sorted client-side for a correct min/max at a fraction of the payload.
async function fetchTextDateTableSummary(table: string, rawCol: string): Promise<MisReportDataInfo> {
  const [{ count, error: countErr }, rows] = await Promise.all([
    supabasePublic.from(table).select("*", { count: "exact", head: true }),
    fetchAllRows(table, (q) => q.select(rawCol).not(rawCol, "is", null)),
  ]);
  if (countErr) throw new Error(`Fetch ${table} summary failed: ${countErr.message}`);
  const dates = (rows as Record<string, unknown>[])
    .map((r) => parseDDMonYY(r[rawCol]))
    .filter((d): d is string => !!d)
    .sort();
  return { rowCount: count || 0, minDate: dates[0] ?? null, maxDate: dates[dates.length - 1] ?? null };
}

export async function fetchMisAmazonReturnsInfo(): Promise<MisReportDataInfo> {
  return fetchTextDateTableSummary("amazon_returns", "Return request date");
}

export async function fetchMisFbaReturnsInfo(): Promise<MisReportDataInfo> {
  return fetchTableSummary("amazon_fba_returns", "return-date");
}

export async function fetchMisSellerFlexReturnsInfo(): Promise<MisReportDataInfo> {
  return fetchTextDateTableSummary("amazon_seller_flex_return", "Pick -up date");
}

/** The Upload cards whose "data on file" caption should reflect the MIS feed. */
export const MIS_BACKED_UPLOAD_TYPES: UploadReportType[] = ["am_orders", "am_returns", "fba_returns", "sf_return"];

// One failed MIS source (e.g. amazon_returns timing out) must never blank out
// the other 3 cards — each fetch settles independently, and a rejected one
// becomes an explicit error result instead of taking the whole call down.
function toSettledInfo(result: PromiseSettledResult<MisReportDataInfo>): MisReportDataInfo {
  if (result.status === "fulfilled") return result.value;
  return { rowCount: 0, minDate: null, maxDate: null, error: result.reason instanceof Error ? result.reason.message : String(result.reason) };
}

export async function fetchAllMisReportDataInfo(): Promise<Partial<Record<UploadReportType, MisReportDataInfo>>> {
  const [am_orders, am_returns, fba_returns, sf_return] = (
    await Promise.allSettled([
      fetchMisAmazonOrdersInfo(),
      fetchMisAmazonReturnsInfo(),
      fetchMisFbaReturnsInfo(),
      fetchMisSellerFlexReturnsInfo(),
    ])
  ).map(toSettledInfo);
  return { am_orders, am_returns, fba_returns, sf_return };
}

// Same idea, for the 2 Flipkart Upload cards backed by the MIS feed:
//   barm_flipkart_order_report -> fk_orders
//   barm_flipkart_returns      -> fk_returns
export async function fetchMisFkOrdersInfo(): Promise<MisReportDataInfo> {
  return summarizeDates(await fetchMisFkOrders((q) => q), "order_date");
}

export async function fetchMisFkReturnsInfo(): Promise<MisReportDataInfo> {
  return summarizeDates(await fetchMisFkReturns((q) => q), "return_requested_date");
}

export async function fetchAllMisFlipkartReportDataInfo(): Promise<{ order_report: MisReportDataInfo; returns: MisReportDataInfo }> {
  const [order_report, returns] = await Promise.all([fetchMisFkOrdersInfo(), fetchMisFkReturnsInfo()]);
  return { order_report, returns };
}
