import * as XLSX from "xlsx";
import { supabasePublic, dedupeExactRows, type ReportDataInfo } from "@/lib/amazonReportUpload";
import { toDate as parseFlexibleDate } from "@/lib/meeshoReportUpload";
import { amazonPurchaseIstDate, chunk, planReplaceByKey } from "@/lib/amazonOrderUploadRules";
import { collectSkuLessSpend, spCampaignDays, isSplitCoveredCampaignRow, type AmAdsSpendRow, type SkuLessCampaignDay } from "@/lib/amazonSpendRules";
import { isCampaignCardRow } from "@/lib/amazonAdSourceRules";

// Ingests the seller's own hand-assembled "Last 7 days - DD-MM-YYYY.xlsx"
// workbook in one shot. Writes each sheet's raw rows into its own dedicated
// barm_daily_<sheet> table (one table per sheet — a full copy of the file).
//
// Only the 7-Day Ad Spend Report may use this upload (user rule, 27 Oct 2026);
// every other report reads the dedicated Upload-page cards. So the Amazon
// sheets are kept in their barm_daily_* copies alone: "AM ads" in
// barm_daily_am_ads (which the 7-Day Ad Spend Report reads — see
// amazonAdSourceRules.ts) and "AM ord" in barm_daily_am_orders. They used to be
// written into the SP card table and the Amazon Orders card table too, on the
// same key the cards use, so the last upload overwrote the other's rows and
// every report read a mix. Flipkart's sheets still also go into
// barm_flipkart_fsn_report / barm_flipkart_order_report (REPORT_TARGETS below)
// — unchanged until its source rule is decided. Meesho ads are read straight
// from the barm_daily_ms_barm_ads copy, and Meesho orders come from
// meesho_barm_ord instead, so "MS BARM ord" is only archived.
//
// Sponsored Brands / Display spend reaches "AM ads" two ways: as the seller's
// own per-SKU split, or as one unsplit campaign row with no Advertised SKU.
// Both stay in barm_daily_am_ads; checkSkuLessAmAdsSpend below only warns about
// unsplit spend no campaign-to-SKU mapping covers.

export interface SheetUploadOutcome {
  sheet: string;
  label: string;
  status: "ok" | "empty" | "missing" | "error";
  detail: string;
  /** Spend this upload could not attribute to a product — shown in amber under the sheet's result. */
  warnings?: string[];
}

const SHEET_LABELS: Record<string, string> = {
  "AM ads": "Amazon Sponsored Products (Advertised Product report)",
  "AM ord": "Amazon Orders",
  "FK ads": "Flipkart Ads (FSN/Spend report)",
  "FK ord": "Flipkart Orders",
  "MS BARM ads": "Meesho Ads — BARM store",
  "MS BARM ord": "Meesho Orders — BARM store",
  "MS MW ads": "Meesho Ads — MW store",
  "MS MW ord": "Meesho Orders — MW store",
};

function findSheet(wb: XLSX.WorkBook, name: string): XLSX.WorkSheet | null {
  const hit = wb.SheetNames.find((n) => n.trim().toLowerCase() === name.trim().toLowerCase());
  return hit ? wb.Sheets[hit] : null;
}

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function numOf(v: unknown): number {
  const n = parseFloat(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function intOf(v: unknown): number {
  return Math.round(numOf(v));
}

/** Header lookup tolerant of trailing spaces / case (source headers like
 *  "Total Advertising Cost of Sales (ACOS) " carry a trailing space). */
function makePicker(row: Record<string, unknown>) {
  const normalized = new Map<string, string>();
  Object.keys(row).forEach((k) => normalized.set(k.replace(/\s+/g, " ").trim().toLowerCase(), k));
  return (...candidates: string[]): unknown => {
    for (const cand of candidates) {
      const hit = normalized.get(cand.replace(/\s+/g, " ").trim().toLowerCase());
      if (hit !== undefined) return row[hit];
    }
    return "";
  };
}

// ── per-sheet "barm_daily_*" raw mirror ─────────────────────────────────────
//
// Every sheet in the workbook gets its own full raw copy written into a
// dedicated barm_daily_<sheet> table (see scripts/barm_daily_sheet_tables.sql)
// — the only tables this uploader writes to. `raw` on every row keeps the
// entire original sheet row, so nothing is lost even for columns not pulled
// out as their own field.

interface DailyMirrorSpec {
  table: string;
  buildRow: (r: Record<string, unknown>) => Record<string, unknown> | null;
  /** When set, existing rows are replaced per value of this column (e.g. per order) instead of
   *  clearing the file's whole report_date range — see amazonOrderUploadRules.ts for why. */
  replaceBy?: string;
  /** Per-row identity used to drop repeated lines within one file before inserting. */
  identityOf?: (row: Record<string, unknown>) => string;
}

// Deletes every row of `table` whose `column` is one of `values`, chunked so the IN-list stays
// well inside PostgREST's URL limit.
async function deleteWhereIn(table: string, column: string, values: string[]): Promise<string | null> {
  for (const part of chunk(values, 200)) {
    const { error } = await supabasePublic.from(table).delete().in(column, part);
    if (error) return error.message;
  }
  return null;
}

interface DailyMirrorOutcome {
  table: string;
  status: "ok" | "empty" | "error";
  detail: string;
}

async function mirrorSheetToDailyTable(ws: XLSX.WorkSheet, spec: DailyMirrorSpec): Promise<DailyMirrorOutcome> {
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });
  let mapped = raw.map(spec.buildRow).filter((r): r is Record<string, unknown> => r !== null);

  if (!mapped.length) {
    return { table: spec.table, status: "empty", detail: `0/${raw.length} rows had identifying data.` };
  }
  if (spec.replaceBy) {
    const plan = planReplaceByKey(mapped, spec.replaceBy, spec.identityOf);
    mapped = plan.insertRows;
    const delErr = await deleteWhereIn(spec.table, spec.replaceBy, plan.deleteKeys);
    if (delErr) {
      return { table: spec.table, status: "error", detail: `Replacing existing rows by ${spec.replaceBy} failed: ${delErr}` };
    }
  }
  const dates = spec.replaceBy ? [] : mapped.map((r) => r.report_date as string | null).filter((d): d is string => !!d).sort();
  if (dates.length) {
    const { error: delErr } = await supabasePublic
      .from(spec.table)
      .delete()
      .gte("report_date", dates[0])
      .lte("report_date", dates[dates.length - 1]);
    if (delErr) {
      return { table: spec.table, status: "error", detail: `Clearing ${dates[0]}..${dates[dates.length - 1]} failed: ${delErr.message}` };
    }
  }

  const chunkSize = 300;
  for (let i = 0; i < mapped.length; i += chunkSize) {
    const { error } = await supabasePublic.from(spec.table).insert(mapped.slice(i, i + chunkSize));
    if (error) {
      return { table: spec.table, status: "error", detail: `Insert failed: ${error.message}` };
    }
  }

  return { table: spec.table, status: "ok", detail: `${mapped.length} rows mirrored to ${spec.table}.` };
}

const MIRROR_AM_ADS: DailyMirrorSpec = {
  table: "barm_daily_am_ads",
  buildRow: (r) => {
    const p = makePicker(r);
    const campaign_name = str(p("Campaign Name"));
    const sku = str(p("Advertised SKU"));
    const report_date = parseFlexibleDate(p("Start Date"));
    if (!report_date && !campaign_name && !sku) return null;
    return {
      report_date,
      end_date: parseFlexibleDate(p("End Date")),
      portfolio_name: str(p("Portfolio name")),
      campaign_name,
      ad_group_name: str(p("Ad Group Name")),
      sku,
      asin: str(p("Advertised ASIN")),
      impressions: intOf(p("Impressions")),
      clicks: intOf(p("Clicks")),
      spend: numOf(p("Spend")),
      sales_7d: numOf(p("7 Day Total Sales (₹)")),
      acos: numOf(p("Total Advertising Cost of Sales (ACOS)")),
      orders_7d: intOf(p("7 Day Total Orders (#)")),
      units_7d: intOf(p("7 Day Total Units (#)")),
      raw: r,
    };
  },
};

const MIRROR_AM_ORD: DailyMirrorSpec = {
  table: "barm_daily_am_orders",
  // Replace per order, never per date range, and store the IST business day — see
  // amazonOrderUploadRules.ts for the data loss the old UTC date + range delete caused.
  replaceBy: "order_id",
  identityOf: (row) => str((row.raw as Record<string, unknown> | undefined)?.["order-item-id"]),
  buildRow: (r) => {
    const p = makePicker(r);
    const order_id = str(p("amazon-order-id"));
    const sku = str(p("sku"));
    const purchaseDateRaw = p("purchase-date");
    if (!order_id && !sku) return null;
    return {
      order_id,
      report_date: amazonPurchaseIstDate(purchaseDateRaw) ?? parseFlexibleDate(purchaseDateRaw),
      purchase_datetime: str(purchaseDateRaw) || null,
      order_status: str(p("order-status")),
      sku,
      asin: str(p("asin")),
      product_name: str(p("product-name")),
      quantity: intOf(p("quantity")),
      item_price: numOf(p("item-price")),
      ship_city: str(p("ship-city")),
      ship_state: str(p("ship-state")),
      raw: r,
    };
  },
};

const MIRROR_FK_ADS: DailyMirrorSpec = {
  table: "barm_daily_fk_ads",
  buildRow: (r) => {
    const p = makePicker(r);
    const campaign_name = str(p("Campaign Name"));
    const sku = str(p("Sku Id"));
    const report_date = parseFlexibleDate(p("Date"));
    if (!report_date && !campaign_name && !sku) return null;
    return {
      report_date,
      campaign_id: str(p("Campaign ID")),
      campaign_name,
      ad_group_name: str(p("AdGroup Name")),
      sku,
      product_name: str(p("Product Name")),
      views: intOf(p("Views")),
      clicks: intOf(p("Clicks")),
      units_sold: intOf(p("Direct Units Sold")) + intOf(p("Indirect Units Sold")),
      revenue: numOf(p("Total Revenue (Rs.)")),
      ad_spend: numOf(p("Ad Spend")),
      roi: numOf(p("ROI")),
      raw: r,
    };
  },
};

const MIRROR_FK_ORD: DailyMirrorSpec = {
  table: "barm_daily_fk_orders",
  buildRow: (r) => {
    const p = makePicker(r);
    // Same old-header/new-header fallback as FK_ORD_SPEC below (REPORT_TARGETS)
    // — Flipkart's raw export moved from Title Case to snake_case headers,
    // and this mirror parses the same "FK ord" sheet independently.
    const order_item_id = str(p("ORDER ITEM ID", "Order Item ID", "order_item_id"));
    const orderedOn = p("Ordered On", "order_date");
    if (!order_item_id) return null;
    return {
      order_item_id,
      order_id: str(p("Order Id", "Order ID", "order_id")),
      report_date: parseFlexibleDate(orderedOn),
      order_datetime: str(orderedOn) || null,
      order_status: str(p("Order State", "order_item_status")),
      sku: str(p("SKU")),
      fsn: str(p("FSN")),
      product_name: str(p("Product", "product_title")),
      quantity: intOf(p("Quantity")),
      tracking_id: str(p("Tracking ID", "delivery_tracking_id")),
      raw: r,
    };
  },
};

function meeshoAdsMirror(table: string): DailyMirrorSpec {
  return {
    table,
    buildRow: (r) => {
      const p = makePicker(r);
      const campaign_name = str(p("Campaign name", "Campaign Name"));
      const sku = str(p("SKU ID", "SKU"));
      const report_date = parseFlexibleDate(p("Date"));
      if (campaign_name === "-" || (!campaign_name && !sku && !report_date)) return null;
      return {
        report_date,
        campaign_name,
        product_name: str(p("Product")),
        sku,
        spend: numOf(p("Spend")),
        views: intOf(p("Views")),
        clicks: intOf(p("Clicks")),
        orders_by_ad: intOf(p("Orders by ad")),
        raw: r,
      };
    },
  };
}

function meeshoOrdersMirror(table: string): DailyMirrorSpec {
  return {
    table,
    buildRow: (r) => {
      const p = makePicker(r);
      const sub_order_no = str(p("Sub Order No"));
      if (!sub_order_no || sub_order_no === "-") return null;
      return {
        order_status: str(p("Reason for Credit Entry")),
        sub_order_no,
        catalog_id: str(p("Catalog ID")),
        report_date: parseFlexibleDate(p("Order Date")),
        order_source: str(p("Order source")),
        customer_state: str(p("Customer State")),
        product_name: str(p("Product Name")),
        sku: str(p("SKU")),
        size: str(p("Size")),
        quantity: intOf(p("Quantity")),
        listed_price: numOf(p("Supplier Listed Price (Incl. GST + Commission)", "Supplier Listed Price")),
        discounted_price: numOf(p("Supplier Discounted Price (Incl GST and Commision)", "Supplier Discounted Price (Incl GST and Commission)", "Supplier Discounted Price")),
        packet_id: str(p("Packet Id")),
        raw: r,
      };
    },
  };
}

// Each of the 8 known sheets maps 1:1 to its own barm_daily_<sheet> table —
// this is the complete set of tables this uploader ever touches.
const SHEET_MIRRORS: Record<string, DailyMirrorSpec> = {
  "AM ads": MIRROR_AM_ADS,
  "AM ord": MIRROR_AM_ORD,
  "FK ads": MIRROR_FK_ADS,
  "FK ord": MIRROR_FK_ORD,
  "MS BARM ads": meeshoAdsMirror("barm_daily_ms_barm_ads"),
  "MS BARM ord": meeshoOrdersMirror("barm_daily_ms_barm_orders"),
  "MS MW ads": meeshoAdsMirror("barm_daily_ms_mw_ads"),
  "MS MW ord": meeshoOrdersMirror("barm_daily_ms_mw_orders"),
};

// "Data on file" caption for the combined-upload card, in the same
// {rowCount, minDate, maxDate} shape the per-report cards already show —
// aggregated across all 8 barm_daily_* tables (every mirror uses the same
// "report_date" column) rather than one per sheet, since the card itself is
// a single drop zone, not eight. A table that doesn't exist yet (e.g.
// scripts/barm_daily_sheet_tables.sql not run) is skipped rather than
// failing the whole caption.
export async function fetchDailyTablesDataInfo(): Promise<ReportDataInfo> {
  const tables = Object.values(SHEET_MIRRORS).map((m) => m.table);
  let minDate: string | null = null;
  let maxDate: string | null = null;
  let rowCount = 0;

  for (const table of tables) {
    const [minRes, maxRes] = await Promise.all([
      supabasePublic.from(table).select("report_date", { count: "exact" }).not("report_date", "is", null).order("report_date", { ascending: true }).limit(1),
      supabasePublic.from(table).select("report_date").not("report_date", "is", null).order("report_date", { ascending: false }).limit(1),
    ]);
    if (minRes.error || maxRes.error) continue;
    rowCount += minRes.count || 0;
    const lo = (minRes.data?.[0] as Record<string, string> | undefined)?.report_date;
    const hi = (maxRes.data?.[0] as Record<string, string> | undefined)?.report_date;
    if (lo && (!minDate || lo < minDate)) minDate = lo;
    if (hi && (!maxDate || hi > maxDate)) maxDate = hi;
  }

  return { rowCount, minDate: minDate ? minDate.slice(0, 10) : null, maxDate: maxDate ? maxDate.slice(0, 10) : null };
}

// ── Flipkart: also written into the tables the Ad Spend Report reads ───────
//
// These specs write the Flipkart sheets into barm_flipkart_fsn_report /
// barm_flipkart_order_report using each table's own column names and
// conflict/replace strategy — matching what the standalone Flipkart upload
// cards do for the SAME tables, just reading this workbook's column headers.
// The Amazon sheets no longer go anywhere but their barm_daily_* copies (see
// the header comment).

interface ReportTableSpec {
  table: string;
  dateCol: string;
  strategy: "upsert" | "replaceRange" | "replaceKeys";
  onConflict?: string;
  /** "replaceKeys" only: rows are replaced per value of this column (e.g. per order). */
  replaceBy?: string;
  /**
   * Amazon's own SP export has one row per keyword/targeting expression, not
   * one per SKU — so several rows can share the same (date, campaign, ad
   * group, SKU), which is exactly the conflict key. Postgres's `ON CONFLICT
   * DO UPDATE` errors ("cannot affect row a second time") if one upsert
   * statement contains that key twice, so those rows must be merged first —
   * summing `sumFields`, keeping the first row's value for everything else.
   */
  mergeSumFields?: string[];
  buildRow: (r: Record<string, unknown>) => Record<string, unknown> | null;
}

function mergeByConflictKey(rows: Record<string, unknown>[], keyCols: string[], sumFields: string[]): Record<string, unknown>[] {
  const merged = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const key = keyCols.map((c) => row[c]).join("");
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...row });
      continue;
    }
    for (const f of sumFields) existing[f] = (Number(existing[f]) || 0) + (Number(row[f]) || 0);
  }
  return [...merged.values()];
}

// "AM ads" lines in the SP table's row shape. Not written to that table any more (27 Oct 2026): the
// daily combined upload feeds the 7-Day Ad Spend Report alone, which reads barm_daily_am_ads, and the
// SP card is the only writer of barm_amazon_sp_advertised_product (amazonAdSourceRules.ts). Still
// built so the Upload page can tell whether this upload carried any Sponsored Products rows, which is
// what releases the daily High ACOS email.
function amAdsReportRow(r: Record<string, unknown>): Record<string, unknown> | null {
  const p = makePicker(r);
  const report_date = parseFlexibleDate(p("Start Date"));
  const advertised_sku = str(p("Advertised SKU"));
  if (!report_date || !advertised_sku) return null;
  return {
    report_date,
    portfolio_name: str(p("Portfolio name")),
    currency: str(p("Currency")),
    campaign_name: str(p("Campaign Name")),
    ad_group_name: str(p("Ad Group Name")),
    advertised_sku,
    advertised_asin: str(p("Advertised ASIN")),
    impressions: intOf(p("Impressions")),
    clicks: intOf(p("Clicks")),
    ctr: numOf(p("Click-Thru Rate (CTR)")),
    cpc: numOf(p("Cost Per Click (CPC)")),
    spend: numOf(p("Spend")),
    sales_7d: numOf(p("7 Day Total Sales (₹)")),
    acos: numOf(p("Total Advertising Cost of Sales (ACOS)")),
    roas: numOf(p("Total Return on Advertising Spend (ROAS)")),
    orders_7d: intOf(p("7 Day Total Orders (#)")),
    units_7d: intOf(p("7 Day Total Units (#)")),
    conversion_rate_7d: numOf(p("7 Day Conversion Rate")),
    advertised_sku_units_7d: intOf(p("7 Day Advertised SKU Units (#)")),
    other_sku_units_7d: intOf(p("7 Day Other SKU Units (#)")),
    advertised_sku_sales_7d: numOf(p("7 Day Advertised SKU Sales (₹)")),
    other_sku_sales_7d: numOf(p("7 Day Other SKU Sales (₹)")),
    raw: r,
  };
}

// Amazon has no entry here: "AM ads" and "AM ord" are kept in their barm_daily_* copies only, so the
// SP card and Amazon Orders card tables hold card data alone. Flipkart's targets are unchanged.
const REPORT_TARGETS: Record<string, ReportTableSpec> = {
  "FK ads": {
    table: "barm_flipkart_fsn_report",
    dateCol: "report_date",
    strategy: "upsert",
    onConflict: "report_date,campaign_id,adgroup_id,sku_id",
    // Flipkart's own FSN export sometimes splits one SKU/day/campaign/ad
    // group's stats across two rows (seen in practice: one row with blank
    // Product Name and a handful of views, another with the real product
    // name and the rest of the views/clicks/spend) — same conflict key,
    // same Postgres "cannot affect row a second time" failure as AM ads
    // above, so it needs the same merge-before-upsert treatment.
    mergeSumFields: ["views", "clicks", "direct_units_sold", "indirect_units_sold", "total_revenue", "ad_spend"],
    buildRow: (r) => {
      const p = makePicker(r);
      const report_date = parseFlexibleDate(p("Date"));
      const sku_id = str(p("Sku Id"));
      const campaign_id = str(p("Campaign ID"));
      if (!report_date || (!campaign_id && !sku_id)) return null;
      return {
        report_date,
        campaign_id,
        campaign_name: str(p("Campaign Name")),
        adgroup_id: str(p("AdGroup ID")),
        adgroup_name: str(p("AdGroup Name")),
        sku_id,
        product_name: str(p("Product Name")),
        views: intOf(p("Views")),
        clicks: intOf(p("Clicks")),
        direct_units_sold: intOf(p("Direct Units Sold")),
        indirect_units_sold: intOf(p("Indirect Units Sold")),
        total_revenue: numOf(p("Total Revenue (Rs.)")),
        conversion_rate: numOf(p("Conversion Rate")),
        roi: numOf(p("ROI")),
        ad_spend: numOf(p("Ad Spend")),
        raw: r,
      };
    },
  },
  "FK ord": {
    table: "barm_flipkart_order_report",
    dateCol: "order_date",
    strategy: "replaceRange",
    buildRow: (r) => {
      const p = makePicker(r);
      // Flipkart switched this report's headers from Title Case ("ORDER ITEM
      // ID", "Ordered On") to snake_case matching our own DB column names
      // ("order_item_id", "order_date") at some point — every candidate here
      // tries the old header first, the new one second, so either export era
      // uploads cleanly. "order_date" in the new format already carries a
      // full ISO timestamp ("2026-09-15 00:03:45"), which parseFlexibleDate's
      // ISO regex handles the same as it always has.
      const order_item_id = str(p("ORDER ITEM ID", "Order Item ID", "order_item_id"));
      const orderedOn = p("Ordered On", "order_date");
      const order_date = parseFlexibleDate(orderedOn);
      if (!order_item_id || !order_date) return null;
      return {
        order_item_id,
        order_id: str(p("Order Id", "Order ID", "order_id")),
        order_date,
        order_datetime: str(orderedOn) || null,
        order_item_status: str(p("Order State", "order_item_status")),
        sku: str(p("SKU")),
        fsn: str(p("FSN")),
        product_title: str(p("Product", "product_title")),
        quantity: intOf(p("Quantity")),
        delivery_tracking_id: str(p("Tracking ID", "delivery_tracking_id")),
        raw: r,
      };
    },
  },
};

async function upsertRows(table: string, rows: Record<string, unknown>[], onConflict: string): Promise<string> {
  const chunkSize = 300;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const { error } = await supabasePublic.from(table).upsert(rows.slice(i, i + chunkSize), { onConflict });
    if (error) throw new Error(`Upsert into ${table} failed: ${error.message}`);
  }
  return `${rows.length} rows -> ${table}`;
}

async function replaceRangeRows(table: string, dateCol: string, rows: Record<string, unknown>[]): Promise<string> {
  // Amazon's and Flipkart's own orders exports occasionally contain a literal
  // duplicate line (every column identical) — the standalone per-report
  // upload page (amazonReportUpload.ts's uploadReportFile) already guards
  // against this for am_orders via dedupeExactRows, but this combined-workbook
  // path was inserting every row as-is. Left unfixed, those duplicate lines
  // double-count units sold in the Ad Spend Report (Orders/QTS inflated) while
  // ad-spend figures — sourced from a separate table entirely — stayed
  // correct, which is exactly the mismatch pattern seen against a hand-built
  // reference report: Spend within a few %, Orders 40-57% too high.
  const deduped = dedupeExactRows(rows);
  const dates = deduped.map((r) => r[dateCol] as string | null).filter((d): d is string => !!d).sort();
  if (dates.length) {
    const { error: delErr } = await supabasePublic.from(table).delete().gte(dateCol, dates[0]).lte(dateCol, dates[dates.length - 1]);
    if (delErr) throw new Error(`Clearing ${table} failed: ${delErr.message}`);
  }
  const chunkSize = 300;
  for (let i = 0; i < deduped.length; i += chunkSize) {
    const { error } = await supabasePublic.from(table).insert(deduped.slice(i, i + chunkSize));
    if (error) throw new Error(`Insert into ${table} failed: ${error.message}`);
  }
  return `${deduped.length} rows -> ${table}`;
}

async function replaceKeyRows(table: string, keyCol: string, rows: Record<string, unknown>[]): Promise<string> {
  // Same exact-duplicate guard as replaceRangeRows, plus one row per order-item-id.
  const { deleteKeys, insertRows } = planReplaceByKey(dedupeExactRows(rows), keyCol, (r) => str(r.order_item_id));
  const delErr = await deleteWhereIn(table, keyCol, deleteKeys);
  if (delErr) throw new Error(`Replacing ${table} rows by ${keyCol} failed: ${delErr}`);
  for (const part of chunk(insertRows, 300)) {
    const { error } = await supabasePublic.from(table).insert(part);
    if (error) throw new Error(`Insert into ${table} failed: ${error.message}`);
  }
  return `${insertRows.length} rows -> ${table}`;
}

async function writeReportTable(ws: XLSX.WorkSheet, spec: ReportTableSpec): Promise<{ detail: string; rows: Record<string, unknown>[] }> {
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });
  let mapped = raw.map(spec.buildRow).filter((r): r is Record<string, unknown> => r !== null);
  if (!mapped.length) return { detail: `0/${raw.length} rows usable for the report`, rows: [] };
  if (spec.strategy === "upsert" && spec.mergeSumFields) {
    mapped = mergeByConflictKey(mapped, spec.onConflict!.split(","), spec.mergeSumFields);
  }
  const detail = spec.strategy === "upsert" ? await upsertRows(spec.table, mapped, spec.onConflict!)
    : spec.strategy === "replaceKeys" ? await replaceKeyRows(spec.table, spec.replaceBy!, mapped)
    : await replaceRangeRows(spec.table, spec.dateCol, mapped);
  return { detail, rows: mapped };
}

// ── SKU-less "AM ads" spend ─────────────────────────────────────────────────
//
// A Brand/Display campaign the seller hasn't split per SKU reaches "AM ads" as
// a row with no Advertised SKU — 15 Oct 2026's three Brand-ad campaigns
// (₹1,486.32) once vanished from the Ad Spend Report that way. Those rows stay
// in barm_daily_am_ads, and the 7-Day Ad Spend Report turns each into a
// campaign row (dailyAmAdsReportRows), spread over the campaign's mapped SKUs —
// or listed as unmapped. The check below warns about the unmapped ones.

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type CampaignTableRow = { report_date: string; campaign_name: string; raw?: { source?: string } | null };
const CARD_CAMPAIGN_TABLES = ["barm_amazon_sb_campaign", "barm_amazon_sd_campaign"] as const;
const dayKey = (date: string, campaign: string) => `${String(date).slice(0, 10)}|${campaign}`;

/** Campaign-days the SB or SD card already has — Amazon's own campaign report, the fuller source. */
async function fetchCardCampaignDays(days: SkuLessCampaignDay[]): Promise<Set<string>> {
  if (!days.length) return new Set();
  const dates = days.map((d) => d.report_date).sort();
  const out = new Set<string>();
  for (const table of CARD_CAMPAIGN_TABLES) {
    const { data, error } = await supabasePublic
      .from(table)
      .select("report_date, campaign_name, raw")
      .gte("report_date", dates[0])
      .lte("report_date", dates[dates.length - 1])
      .in("campaign_name", [...new Set(days.map((d) => d.campaign_name))]);
    if (error) throw new Error(`Reading ${table} failed: ${error.message}`);
    ((data || []) as CampaignTableRow[]).filter(isCampaignCardRow).forEach((r) => out.add(dayKey(r.report_date, r.campaign_name)));
  }
  return out;
}

/** Campaign names with any row on the Upload page's campaign-to-SKU mapping — the Ad Spend Report's
 *  campaignShares treats a missing/zero weight as 1, so one mapping row is enough to spread the spend. */
async function fetchMappedCampaigns(): Promise<Set<string>> {
  const { data, error } = await supabasePublic.from("barm_amazon_campaign_sku_map").select("campaign_name");
  if (error) throw new Error(`Reading the campaign-to-SKU mapping failed: ${error.message}`);
  return new Set((data || []).map((r: { campaign_name?: string }) => r.campaign_name || "").filter(Boolean));
}

/** Checks the "AM ads" sheet's SKU-less Brand/Display spend (see above) and returns one line per thing the
 *  seller needs to act on: spend whose campaign has no SKU mapping, and spend with no campaign at all.
 *  Writes nothing — that spend stays in barm_daily_am_ads, where the 7-Day Ad Spend Report reads it
 *  (amazonAdSourceRules.ts). It used to be saved into the SB/SD card tables, which mixed daily-upload
 *  rows into every other report (27 Oct 2026). */
export async function checkSkuLessAmAdsSpend(ws: XLSX.WorkSheet): Promise<{ detail: string; warnings: string[] }> {
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });
  const rows: AmAdsSpendRow[] = raw.map((r) => {
    const p = makePicker(r);
    return {
      report_date: parseFlexibleDate(p("Start Date")),
      campaign_name: str(p("Campaign Name")),
      ad_type: str(p("Ad Type")),
      advertised_sku: str(p("Advertised SKU")),
      spend: numOf(p("Spend")),
    };
  });
  const collected = collectSkuLessSpend(rows);
  const { unattributable } = collected;
  // This sheet's own per-SKU split (its named first split row) — the report skips those campaign-days.
  const splitDays = spCampaignDays(rows.filter((r) => r.advertised_sku));
  const campaignDays = collected.campaignDays.filter((d) => !isSplitCoveredCampaignRow(d, splitDays));
  const alreadySplit = collected.campaignDays.length - campaignDays.length;
  const warnings: string[] = [];
  unattributable.forEach((u) =>
    warnings.push(`${u.report_date}: ${inr(u.spend)} of ad spend has neither an Advertised SKU nor a Campaign Name (${u.rows} row${u.rows === 1 ? "" : "s"}) — it can't reach any product. Fill in the SKU or campaign in "AM ads" and re-upload.`),
  );
  const splitNote = alreadySplit ? `${alreadySplit} Brand/Display campaign-day${alreadySplit === 1 ? "" : "s"} with no SKU here also split per SKU in this sheet, counted once` : "";
  if (!campaignDays.length) return { detail: splitNote, warnings };

  const onCard = await fetchCardCampaignDays(campaignDays);
  const open = campaignDays.filter((d) => !onCard.has(dayKey(d.report_date, d.campaign_name)));
  const keptCardRows = campaignDays.length - open.length;
  const mapped = await fetchMappedCampaigns();
  const unmapped = open.filter((d) => !mapped.has(d.campaign_name));
  const unmappedByCampaign = new Map<string, { spend: number; dates: string[] }>();
  unmapped.forEach((d) => {
    const e = unmappedByCampaign.get(d.campaign_name) || { spend: 0, dates: [] };
    e.spend += d.spend;
    e.dates.push(d.report_date);
    unmappedByCampaign.set(d.campaign_name, e);
  });
  unmappedByCampaign.forEach((e, campaign) =>
    warnings.push(`"${campaign}": ${inr(e.spend)} of Brand/Display spend with no SKU split (${e.dates.join(", ")}) and no SKU mapping on the Upload page — the 7-Day Ad Spend Report will list it as unmapped, not under any product. Map this campaign to its SKUs (or split it per SKU in "AM ads"), then regenerate the report.`),
  );
  const total = open.reduce((s, d) => s + d.spend, 0);
  const detail = open.length
    ? `${open.length} Brand/Display campaign-day${open.length === 1 ? "" : "s"} with no SKU split (${inr(total)}) kept for the 7-Day Ad Spend Report's campaign-to-SKU mapping` +
      (unmapped.length ? `, ${unmapped.length} of them unmapped` : ", all mapped") +
      (keptCardRows ? `; ${keptCardRows} already on the SB/SD campaign report card, which the report uses instead` : "")
    : `${campaignDays.length} Brand/Display campaign-day${campaignDays.length === 1 ? "" : "s"} with no SKU split already on the SB/SD campaign report card, which the report uses instead`;
  return { detail: [detail, splitNote].filter(Boolean).join("; "), warnings };
}

export interface CombinedUploadResult {
  results: SheetUploadOutcome[];
  /** "AM ads" rows in the SP table's shape (not saved there) — the upload page runs the High ACOS
   *  alert (src/lib/uploadAcosAlert.ts) when there are any, same as the separate SP report upload does. */
  spAdsRows: Record<string, unknown>[];
}

export async function uploadCombinedWorkbook(
  file: File,
  onProgress?: (p: { done: number; total: number; step?: string }) => void,
): Promise<CombinedUploadResult> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const results: SheetUploadOutcome[] = [];
  let spAdsRows: Record<string, unknown>[] = [];

  const sheets = Object.keys(SHEET_LABELS);
  for (const [i, sheet] of sheets.entries()) {
    onProgress?.({ done: i, total: sheets.length, step: SHEET_LABELS[sheet] });
    const ws = findSheet(wb, sheet);
    if (!ws) {
      results.push({ sheet, label: SHEET_LABELS[sheet], status: "missing", detail: `No "${sheet}" sheet found in this file.` });
      continue;
    }
    try {
      const mirror = await mirrorSheetToDailyTable(ws, SHEET_MIRRORS[sheet]);
      if (sheet === "AM ads") {
        spAdsRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" })
          .map(amAdsReportRow)
          .filter((r): r is Record<string, unknown> => r !== null);
        // A failure here must not read as success: the rows are saved, but the spend check didn't run.
        let skuLess: { detail: string; warnings: string[] };
        try {
          skuLess = await checkSkuLessAmAdsSpend(ws);
        } catch (err) {
          skuLess = { detail: "", warnings: [`Brand/Display spend with no SKU split could NOT be checked — ${err instanceof Error ? err.message : String(err)}. Its rows are saved in the daily copy; re-upload to re-run the check.`] };
        }
        results.push({
          sheet,
          label: SHEET_LABELS[sheet],
          status: mirror.status,
          detail: `${mirror.detail} · 7-Day Ad Spend Report: ${spAdsRows.length} rows with an Advertised SKU${skuLess.detail ? ` · ${skuLess.detail}` : ""}.`,
          ...(skuLess.warnings.length ? { warnings: skuLess.warnings } : {}),
        });
        continue;
      }
      const reportSpec = REPORT_TARGETS[sheet];
      if (!reportSpec) {
        results.push({ sheet, label: SHEET_LABELS[sheet], status: mirror.status, detail: mirror.detail });
        continue;
      }
      const report = await writeReportTable(ws, reportSpec);
      results.push({ sheet, label: SHEET_LABELS[sheet], status: mirror.status, detail: `${mirror.detail} · Ad Spend Report: ${report.detail}.` });
    } catch (err) {
      results.push({ sheet, label: SHEET_LABELS[sheet], status: "error", detail: err instanceof Error ? err.message : String(err) });
    }
  }

  return { results, spAdsRows };
}
