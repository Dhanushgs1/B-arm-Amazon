import Papa from "papaparse";
import { createClient } from "@supabase/supabase-js";
import { lazySupabase, SUPABASE_URL, SUPABASE_ANON_KEY } from "@/lib/supabaseLazy";

// The shared `supabase` client (src/lib/supabaseClient.ts) is pinned to the
// `barm` Postgres schema, which turns out to be empty in this project — every
// real table (shop_data, amazon_ads_advertised_product_dashboard, the
// flipkart_*_dashboard tables, etc.) actually lives in the default `public`
// schema. The tables this file writes to were created there too, so this
// second client targets `public` explicitly rather than reusing the `barm`
// one and silently hitting a schema with nothing in it.
// Built on first use, not at import — see src/lib/supabaseLazy.ts. This module is pulled into the
// client bundle by the Upload and Reports pages, so constructing eagerly meant a missing
// NEXT_PUBLIC_SUPABASE_* variable crashed those pages outright instead of just this feature.
export const supabasePublic = lazySupabase(() => createClient(SUPABASE_URL, SUPABASE_ANON_KEY));

export type UploadReportType =
  | "sp_advertised_product"
  | "sb_campaign"
  | "sd_campaign"
  | "am_orders"
  | "am_returns"
  | "fba_returns"
  | "price_listing"
  | "fba_inventory"
  | "inventory_ledger"
  | "sf_return";

export const REPORT_LABEL: Record<UploadReportType, string> = {
  sp_advertised_product: "Sponsored Products — Advertised Product report",
  sb_campaign: "Sponsored Brands — Campaign report",
  sd_campaign: "Sponsored Display — Campaign report",
  am_orders: "Amazon Orders (AM orders)",
  am_returns: "Amazon Returns (AM returns)",
  fba_returns: "FBA Customer Returns",
  price_listing: "Price (All Listings report)",
  fba_inventory: "FBA Inventory report",
  inventory_ledger: "Inventory Ledger report",
  sf_return: "SellerFlex (SF) Returns",
};

export const REPORT_TABLE: Record<UploadReportType, string> = {
  sp_advertised_product: "barm_amazon_sp_advertised_product",
  sb_campaign: "barm_amazon_sb_campaign",
  sd_campaign: "barm_amazon_sd_campaign",
  am_orders: "barm_amazon_am_orders",
  am_returns: "barm_amazon_am_returns",
  fba_returns: "barm_amazon_fba_returns",
  price_listing: "barm_amazon_price_listing",
  fba_inventory: "barm_amazon_fba_inventory",
  inventory_ledger: "barm_amazon_inventory_ledger",
  sf_return: "barm_amazon_sf_return",
};

// Ad-report tables (SP/SB/SD) have a clean natural key (date+campaign+[sku]) —
// re-uploading an overlapping period is a plain per-row upsert.
const ON_CONFLICT: Partial<Record<UploadReportType, string>> = {
  sp_advertised_product: "report_date,campaign_name,ad_group_name,advertised_sku",
  sb_campaign: "report_date,campaign_name",
  sd_campaign: "report_date,campaign_name",
};

// Orders/returns/ledger exports have no reliable natural key: Amazon's own
// CSVs truncate large numeric "order-item-id" / "Order Item ID" values into
// scientific notation (e.g. "6.55574E+13"), which collapses many distinct
// real IDs into the same string, and even (order, sku) / license-plate-number
// have a handful of genuine duplicates in real data (split shipments, repeat
// return requests). So these tables are re-ingested as "replace whatever date
// range this file covers, then insert everything" instead of per-row upsert —
// idempotent for re-uploads without depending on a fragile key.
const REPLACE_DATE_FIELD: Partial<Record<UploadReportType, string>> = {
  am_orders: "purchase_date",
  am_returns: "return_request_date",
  fba_returns: "return_date",
  inventory_ledger: "ledger_date",
  sf_return: "pickup_date",
};
// fba_returns.return_date is a timestamptz; the others are plain dates.
const REPLACE_IS_TIMESTAMP: Partial<Record<UploadReportType, boolean>> = {
  fba_returns: true,
};

// Price and FBA-inventory exports are current-moment catalog/stock snapshots
// with no date column at all — each upload represents "the current state",
// so re-uploading truncates and replaces the whole table rather than merging
// by any key (a delisted SKU shouldn't linger as a stale row forever).
const FULL_REPLACE_TYPES: Partial<Record<UploadReportType, true>> = {
  price_listing: true,
  fba_inventory: true,
};

// The date column each report's table is scoped by — used to show "data on
// file: X to Y" per upload card. price_listing/fba_inventory are absent here
// (snapshots, no date column) — that card just shows a row count instead.
const DATE_COLUMN: Partial<Record<UploadReportType, string>> = {
  sp_advertised_product: "report_date",
  sb_campaign: "report_date",
  sd_campaign: "report_date",
  am_orders: "purchase_date",
  am_returns: "return_request_date",
  fba_returns: "return_date",
  inventory_ledger: "ledger_date",
  sf_return: "pickup_date",
};

// Rows whose required natural-key fields didn't parse (bad/blank date, no
// campaign/sku) are dropped client-side rather than sent to Supabase, where a
// NOT NULL violation would abort the whole chunk.
const REQUIRED_FIELDS: Record<UploadReportType, string[]> = {
  sp_advertised_product: ["report_date", "campaign_name", "advertised_sku"],
  sb_campaign: ["report_date", "campaign_name"],
  sd_campaign: ["report_date", "campaign_name"],
  am_orders: ["amazon_order_id", "order_item_id", "purchase_date", "sku"],
  am_returns: ["order_id"],
  fba_returns: ["return_date", "sku", "license_plate_number"],
  price_listing: ["seller_sku"],
  fba_inventory: ["sku"],
  inventory_ledger: ["ledger_date", "msku"],
  sf_return: ["customer_order_id", "sku"],
};

// ── generic row/value parsing helpers ───────────────────────────────────────

type RawRow = Record<string, string>;

// Amazon's own CSV headers are inconsistent about trailing spaces and the
// currency symbol in parentheses often arrives mangled by export encoding
// (e.g. "7 Day Total Sales (?)" instead of "(₹)") — match by regex against the
// stable part of the header instead of the exact string.
function pick(row: RawRow, re: RegExp): string {
  const key = Object.keys(row).find((k) => re.test(k));
  return key ? (row[key] ?? "").trim() : "";
}

// Numbers arrive as "?123.45" / "₹123.45" / "1,234.56" depending on the
// export's encoding — strip everything but digits/minus/decimal point.
function toNum(v: string): number {
  if (!v) return 0;
  const cleaned = v.replace(/[^0-9.-]/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function toInt(v: string): number {
  return Math.round(toNum(v));
}

// "17.2186%" -> 0.172186, matching the fraction convention the live Analysis
// Report (analysisReportExport.ts) already uses for ACOS/CTR/conversion rate.
function toPercentFraction(v: string): number | null {
  if (!v) return null;
  return toNum(v) / 100;
}

// ROAS is a plain ratio (e.g. "5.81"), never a percentage.
function toRatio(v: string): number | null {
  if (!v) return null;
  const n = toNum(v);
  return Number.isFinite(n) ? n : null;
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

// "Jun 20, 2026" -> "2026-06-20" (SP/SB/SD "Date" column)
function parseLongDate(v: string): string | null {
  const m = /^([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+(\d{4})$/.exec(v.trim());
  if (!m) return null;
  const mm = MONTHS[m[1].toLowerCase().slice(0, 3)];
  if (!mm) return null;
  return `${m[3]}-${mm}-${m[2].padStart(2, "0")}`;
}

// "09-Jul-26" -> "2026-07-09" (AM returns "Order date" / "Return request date")
function parseDDMonYY(v: string): string | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const mm = MONTHS[m[2].toLowerCase()];
  if (!mm) return null;
  const year = 2000 + Number(m[3]);
  return `${year}-${mm}-${m[1].padStart(2, "0")}`;
}

// "07/22/2026" -> "2026-07-22" (Inventory ledger "Date" column, US MM/DD/YYYY)
function parseMDY(v: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v.trim());
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

// "2026-07-19T18:23:41+00:00" -> "2026-07-19"
function isoDateOnly(v: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
  return m ? m[1] : null;
}

function parseAnyAmazonDate(v: string): string | null {
  if (!v) return null;
  return isoDateOnly(v) || parseLongDate(v) || parseDDMonYY(v);
}

// SF (SellerFlex) returns export date format isn't pinned down to one seen
// sample — tries every format the other report types use, MM/DD/YYYY last
// since it's the most ambiguous (could misread a DD/MM/YYYY file).
function parseAnySfDate(v: string): string | null {
  if (!v) return null;
  return isoDateOnly(v) || parseLongDate(v) || parseDDMonYY(v) || parseMDY(v);
}

// ── CSV parsing ──────────────────────────────────────────────────────────────

export function parseCsvFile(file: File): Promise<RawRow[]> {
  return new Promise((resolve, reject) => {
    Papa.parse<RawRow>(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h: string) => h.trim(),
      complete: (results) => resolve(results.data),
      error: (err: Error) => reject(err),
    });
  });
}

// ── per-report-type row mappers ─────────────────────────────────────────────

function mapSpRow(row: RawRow) {
  return {
    report_date: parseAnyAmazonDate(pick(row, /^Date$/i)),
    portfolio_name: pick(row, /^Portfolio/i),
    currency: pick(row, /^Currency$/i),
    campaign_name: pick(row, /^Campaign Name$/i),
    ad_group_name: pick(row, /^Ad Group Name$/i),
    country: pick(row, /^Country$/i),
    advertised_sku: pick(row, /^Advertised SKU$/i),
    advertised_asin: pick(row, /^Advertised ASIN$/i),
    impressions: toInt(pick(row, /^Impressions$/i)),
    clicks: toInt(pick(row, /^Clicks$/i)),
    ctr: toPercentFraction(pick(row, /Click-Through Rate/i)),
    cpc: toRatio(pick(row, /Cost Per Click/i)),
    spend: toNum(pick(row, /^Spend$/i)),
    sales_7d: toNum(pick(row, /7 Day Total Sales/i)),
    acos: toPercentFraction(pick(row, /Advertising Cost of Sales/i)),
    roas: toRatio(pick(row, /Return on Advertising Spend/i)),
    orders_7d: toInt(pick(row, /7 Day Total Orders/i)),
    units_7d: toInt(pick(row, /7 Day Total Units/i)),
    conversion_rate_7d: toPercentFraction(pick(row, /7 Day Conversion Rate/i)),
    advertised_sku_units_7d: toInt(pick(row, /7 Day Advertised SKU Units/i)),
    other_sku_units_7d: toInt(pick(row, /7 Day Other SKU Units/i)),
    advertised_sku_sales_7d: toNum(pick(row, /7 Day Advertised SKU Sales/i)),
    other_sku_sales_7d: toNum(pick(row, /7 Day Other SKU Sales/i)),
    raw: row,
  };
}

// SB and SD "Campaign report" exports share the same core column set — both
// are campaign-level only (Amazon doesn't expose a SKU column on either), and
// both use a 14-day attribution window.
function mapCampaignCommon(row: RawRow) {
  return {
    report_date: parseAnyAmazonDate(pick(row, /^Date$/i)),
    portfolio_name: pick(row, /^Portfolio/i),
    currency: pick(row, /^Currency$/i),
    campaign_name: pick(row, /^Campaign Name$/i),
    cost_type: pick(row, /^Cost Type$/i),
    country: pick(row, /^Country$/i),
    impressions: toInt(pick(row, /^Impressions$/i)),
    clicks: toInt(pick(row, /^Clicks$/i)),
    ctr: toPercentFraction(pick(row, /Click-Through Rate/i)),
    cpc: toRatio(pick(row, /Cost Per Click/i)),
    spend: toNum(pick(row, /^Spend$/i)),
    acos: toPercentFraction(pick(row, /Advertising Cost of Sales/i)),
    roas: toRatio(pick(row, /Return on Advertising Spend/i)),
    raw: row,
  };
}

function mapSbRow(row: RawRow) {
  return {
    ...mapCampaignCommon(row),
    sales: toNum(pick(row, /14 Day Total Sales/i)),
    orders: toInt(pick(row, /14 Day Total Orders/i)),
    units: toInt(pick(row, /14 Day Total Units/i)),
    conversion_rate: toPercentFraction(pick(row, /14 Day Conversion Rate/i)),
  };
}

function mapSdRow(row: RawRow) {
  return {
    ...mapCampaignCommon(row),
    status: pick(row, /^Status$/i),
    sales_14d: toNum(pick(row, /14 Day Total Sales/i)),
    orders_14d: toInt(pick(row, /14 Day Total Orders/i)),
    units_14d: toInt(pick(row, /14 Day Total Units/i)),
  };
}

function mapOrderRow(row: RawRow) {
  const purchaseRaw = pick(row, /^purchase-date$/i);
  return {
    amazon_order_id: pick(row, /^amazon-order-id$/i),
    order_item_id: pick(row, /^order-item-id$/i),
    purchase_date: isoDateOnly(purchaseRaw),
    purchase_datetime: purchaseRaw || null,
    order_status: pick(row, /^order-status$/i),
    fulfillment_channel: pick(row, /^fulfillment-channel$/i),
    sales_channel: pick(row, /^sales-channel$/i),
    product_name: pick(row, /^product-name$/i),
    sku: pick(row, /^sku$/i),
    asin: pick(row, /^asin$/i),
    item_status: pick(row, /^item-status$/i),
    quantity: toInt(pick(row, /^quantity$/i)),
    currency: pick(row, /^currency$/i),
    item_price: toNum(pick(row, /^item-price$/i)),
    item_tax: toNum(pick(row, /^item-tax$/i)),
    shipping_price: toNum(pick(row, /^shipping-price$/i)),
    item_promotion_discount: toNum(pick(row, /^item-promotion-discount$/i)),
    ship_city: pick(row, /^ship-city$/i),
    ship_state: pick(row, /^ship-state$/i),
    ship_postal_code: pick(row, /^ship-postal-code$/i),
    raw: row,
  };
}

function mapAmReturnRow(row: RawRow) {
  return {
    order_id: pick(row, /^Order ID$/i),
    order_item_id: pick(row, /^Order Item ID$/i),
    order_date: parseDDMonYY(pick(row, /^Order date$/i)),
    return_request_date: parseDDMonYY(pick(row, /^Return request date$/i)),
    return_request_status: pick(row, /^Return request status$/i),
    asin: pick(row, /^ASIN$/i),
    merchant_sku: pick(row, /Merchant SKU/i),
    item_name: pick(row, /^Item Name$/i),
    return_quantity: toInt(pick(row, /^Return quantity$/i)),
    return_reason: pick(row, /^Return reason$/i),
    in_policy: pick(row, /^In policy$/i),
    return_type: pick(row, /^Return type$/i),
    resolution: pick(row, /^Resolution$/i),
    order_amount: toNum(pick(row, /^Order Amount$/i)),
    order_quantity: toInt(pick(row, /^Order quantity$/i)),
    category: pick(row, /^Category$/i),
    raw: row,
  };
}

function mapFbaReturnRow(row: RawRow) {
  return {
    return_date: pick(row, /^return-date$/i) || null,
    order_id: pick(row, /^order-id$/i),
    sku: pick(row, /^sku$/i),
    asin: pick(row, /^asin$/i),
    fnsku: pick(row, /^fnsku$/i),
    product_name: pick(row, /^product-name$/i),
    quantity: toInt(pick(row, /^quantity$/i)),
    fulfillment_center_id: pick(row, /^fulfillment-center-id$/i),
    detailed_disposition: pick(row, /^detailed-disposition$/i),
    reason: pick(row, /^reason$/i),
    license_plate_number: pick(row, /^license-plate-number$/i),
    customer_comments: pick(row, /^customer-comments$/i),
    raw: row,
  };
}

function mapPriceListingRow(row: RawRow) {
  return {
    seller_sku: pick(row, /^seller-sku$/i),
    item_name: pick(row, /^item-name$/i),
    price: toNum(pick(row, /^price$/i)),
    business_price: toNum(pick(row, /^Business Price$/i)),
    quantity: toInt(pick(row, /^quantity$/i)),
    fulfillment_channel: pick(row, /^fulfillment-channel$/i),
    asin1: pick(row, /^asin1$/i),
    item_condition: pick(row, /^item-condition$/i),
    raw: row,
  };
}

function mapFbaInventoryRow(row: RawRow) {
  return {
    sku: pick(row, /^sku$/i),
    fnsku: pick(row, /^fnsku$/i),
    asin: pick(row, /^asin$/i),
    product_name: pick(row, /^product-name$/i),
    condition: pick(row, /^condition$/i),
    your_price: toNum(pick(row, /^your-price$/i)),
    mfn_fulfillable_quantity: toInt(pick(row, /^mfn-fulfillable-quantity$/i)),
    afn_fulfillable_quantity: toInt(pick(row, /^afn-fulfillable-quantity$/i)),
    afn_total_quantity: toInt(pick(row, /^afn-total-quantity$/i)),
    afn_unsellable_quantity: toInt(pick(row, /^afn-unsellable-quantity$/i)),
    afn_reserved_quantity: toInt(pick(row, /^afn-reserved-quantity$/i)),
    afn_inbound_working_quantity: toInt(pick(row, /^afn-inbound-working-quantity$/i)),
    afn_inbound_shipped_quantity: toInt(pick(row, /^afn-inbound-shipped-quantity$/i)),
    afn_inbound_receiving_quantity: toInt(pick(row, /^afn-inbound-receiving-quantity$/i)),
    raw: row,
  };
}

function mapInventoryLedgerRow(row: RawRow) {
  return {
    ledger_date: parseMDY(pick(row, /^Date$/i)),
    fnsku: pick(row, /^FNSKU$/i),
    asin: pick(row, /^ASIN$/i),
    msku: pick(row, /^MSKU$/i),
    title: pick(row, /^Title$/i),
    disposition: pick(row, /^Disposition$/i),
    starting_balance: toInt(pick(row, /^Starting Warehouse Balance$/i)),
    ending_balance: toInt(pick(row, /^Ending Warehouse Balance$/i)),
    customer_shipments: toInt(pick(row, /^Customer Shipments$/i)),
    customer_returns: toInt(pick(row, /^Customer Returns$/i)),
    location: pick(row, /^Location$/i),
    raw: row,
  };
}

// SellerFlex (Amazon's India seller-fulfilled) returns export. Column names
// per Amazon's own report (header match is case-insensitive and tolerant of
// the stray space Amazon's export has in "Pick -up date").
function mapSfReturnRow(row: RawRow) {
  return {
    return_type: pick(row, /^Return Type$/i),
    customer_order_id: pick(row, /^Customer Order ID$/i),
    shipment_id: pick(row, /^Shipment ID$/i),
    sku: pick(row, /^SKU$/i),
    msku: pick(row, /^mSKU$/i),
    asin: pick(row, /^ASIN$/i),
    external_id_1: pick(row, /^External ID1$/i),
    external_id_2: pick(row, /^External ID2$/i),
    external_id_3: pick(row, /^External ID3$/i),
    units: toInt(pick(row, /^Units$/i)),
    forward_leg_tracking_id: pick(row, /^Forward Leg Tracking ID$/i),
    reverse_leg_tracking_id: pick(row, /^Reverse Leg Tracking ID$/i),
    rma_id: pick(row, /^RMA ID$/i),
    return_status: pick(row, /^Return Status$/i),
    carrier: pick(row, /^Carrier$/i),
    pickup_date: parseAnySfDate(pick(row, /^Pick\s*-?\s*up date$/i)),
    last_updated_on: parseAnySfDate(pick(row, /^Last Updated On$/i)),
    returned_with_otp: pick(row, /^Returned with OTP$/i),
    days_in_transit: toInt(pick(row, /^Days In-?transit$/i)),
    days_since_return_complete: toInt(pick(row, /^Days Since Return Complete$/i)),
    raw: row,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REPORT_MAPPER: Record<UploadReportType, (row: RawRow) => any> = {
  sp_advertised_product: mapSpRow,
  sb_campaign: mapSbRow,
  sd_campaign: mapSdRow,
  am_orders: mapOrderRow,
  am_returns: mapAmReturnRow,
  fba_returns: mapFbaReturnRow,
  price_listing: mapPriceListingRow,
  fba_inventory: mapFbaInventoryRow,
  inventory_ledger: mapInventoryLedgerRow,
  sf_return: mapSfReturnRow,
};

// ── Supabase writes ──────────────────────────────────────────────────────────

export async function upsertInChunks(
  table: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rows: any[],
  onConflict: string,
  chunkSize = 300
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabasePublic.from(table).upsert(chunk, { onConflict });
    if (error) throw new Error(`Upsert into ${table} failed: ${error.message}`);
  }
}

async function insertInChunks(
  table: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rows: any[],
  chunkSize = 300
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabasePublic.from(table).insert(chunk);
    if (error) throw new Error(`Insert into ${table} failed: ${error.message}`);
  }
}

function nextDayIso(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Deletes every existing row in [minDate, maxDate] before a fresh insert, so
// re-uploading a file that overlaps a previous upload fully replaces that
// range instead of attempting a per-row upsert on a key that isn't reliably
// unique (see REPLACE_DATE_FIELD above).
async function replaceDateRange(
  table: string,
  dateCol: string,
  isTimestamp: boolean,
  minDate: string,
  maxDate: string
): Promise<void> {
  let query = supabasePublic.from(table).delete();
  if (isTimestamp) {
    query = query.gte(dateCol, `${minDate}T00:00:00Z`).lt(dateCol, `${nextDayIso(maxDate)}T00:00:00Z`);
  } else {
    query = query.gte(dateCol, minDate).lte(dateCol, maxDate);
  }
  const { error } = await query;
  if (error) throw new Error(`Delete existing ${table} rows in range failed: ${error.message}`);
}

// Wipes the whole table before inserting — for the two catalog/stock snapshot
// types (see FULL_REPLACE_TYPES) where every upload supersedes the last one
// entirely rather than merging by date or key. `.gte("id", 0)` matches every
// row since these tables all use a bigint identity column starting at 1
// (Supabase requires an explicit filter on delete — there's no bare "delete
// everything").
async function truncateAndInsert(
  table: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rows: any[]
): Promise<void> {
  const { error } = await supabasePublic.from(table).delete().gte("id", 0);
  if (error) throw new Error(`Truncate ${table} failed: ${error.message}`);
  await insertInChunks(table, rows);
}

export interface UploadResult {
  totalRows: number;
  validRows: number;
  skippedRows: number;
}

// Parses a CSV file client-side and writes every row with a usable natural
// key into its Supabase table, using one of three strategies depending on the
// report type: ad-report files (SP/SB/SD) upsert on a clean date+campaign
// (+SKU) key; orders/returns/ledger files replace whatever date range the
// file covers (see REPLACE_DATE_FIELD); catalog/stock snapshots with no date
// column at all (price_listing, fba_inventory) truncate and fully replace the
// table (see FULL_REPLACE_TYPES). Either way, re-uploading a file that
// overlaps previous data converges to the new data rather than duplicating it.
export async function uploadReportFile(type: UploadReportType, file: File): Promise<UploadResult> {
  const rawRows = await parseCsvFile(file);
  const mapper = REPORT_MAPPER[type];
  const required = REQUIRED_FIELDS[type];
  const mapped = rawRows.map(mapper);
  const valid = mapped.filter((r) => required.every((f) => r[f] !== null && r[f] !== undefined && r[f] !== ""));

  const table = REPORT_TABLE[type];
  const onConflict = ON_CONFLICT[type];
  const replaceDateField = REPLACE_DATE_FIELD[type];

  if (onConflict) {
    await upsertInChunks(table, valid, onConflict);
  } else if (FULL_REPLACE_TYPES[type]) {
    await truncateAndInsert(table, valid);
  } else if (replaceDateField && valid.length > 0) {
    const dates = valid.map((r) => r[replaceDateField]).filter(Boolean).sort();
    const minDate = dates[0].slice(0, 10);
    const maxDate = dates[dates.length - 1].slice(0, 10);
    await replaceDateRange(table, replaceDateField, !!REPLACE_IS_TIMESTAMP[type], minDate, maxDate);
    await insertInChunks(table, valid);
  }

  return {
    totalRows: rawRows.length,
    validRows: valid.length,
    skippedRows: rawRows.length - valid.length,
  };
}

// ── date-range + campaign/SKU mapping helpers (used by the upload page) ────

export async function fetchUploadedDateRange(): Promise<{ min: string | null; max: string | null }> {
  const sources: Array<[string, string]> = [
    ["barm_amazon_sp_advertised_product", "report_date"],
    ["barm_amazon_sb_campaign", "report_date"],
    ["barm_amazon_sd_campaign", "report_date"],
    ["barm_amazon_am_orders", "purchase_date"],
  ];
  let min: string | null = null;
  let max: string | null = null;
  for (const [table, col] of sources) {
    const [{ data: minRows }, { data: maxRows }] = await Promise.all([
      supabasePublic.from(table).select(col).order(col, { ascending: true }).limit(1),
      supabasePublic.from(table).select(col).order(col, { ascending: false }).limit(1),
    ]);
    const lo = (minRows?.[0] as Record<string, string> | undefined)?.[col];
    const hi = (maxRows?.[0] as Record<string, string> | undefined)?.[col];
    if (lo && (!min || lo < min)) min = lo;
    if (hi && (!max || hi > max)) max = hi;
  }
  return { min, max };
}

export interface ReportDataInfo {
  rowCount: number;
  minDate: string | null;
  maxDate: string | null;
}

// Per-card "data on file" summary — a date range for date-scoped reports, or
// just a row count for the two snapshot types (Price / FBA Inventory).
export async function fetchReportDataInfo(type: UploadReportType): Promise<ReportDataInfo> {
  const table = REPORT_TABLE[type];
  const dateCol = DATE_COLUMN[type];

  if (!dateCol) {
    const { count } = await supabasePublic.from(table).select("*", { count: "exact", head: true });
    return { rowCount: count || 0, minDate: null, maxDate: null };
  }

  const [{ data: minRows, count }, { data: maxRows }] = await Promise.all([
    supabasePublic.from(table).select(dateCol, { count: "exact" }).order(dateCol, { ascending: true }).limit(1),
    supabasePublic.from(table).select(dateCol).order(dateCol, { ascending: false }).limit(1),
  ]);
  const minDate = (minRows?.[0] as Record<string, string> | undefined)?.[dateCol] ?? null;
  const maxDate = (maxRows?.[0] as Record<string, string> | undefined)?.[dateCol] ?? null;
  return { rowCount: count || 0, minDate: minDate ? minDate.slice(0, 10) : null, maxDate: maxDate ? maxDate.slice(0, 10) : null };
}

export async function fetchAllReportDataInfo(): Promise<Record<UploadReportType, ReportDataInfo>> {
  const types = Object.keys(REPORT_TABLE) as UploadReportType[];
  const results = await Promise.all(types.map((t) => fetchReportDataInfo(t)));
  return Object.fromEntries(types.map((t, i) => [t, results[i]])) as Record<UploadReportType, ReportDataInfo>;
}

export async function fetchUnmappedCampaigns(): Promise<string[]> {
  const [{ data: sb }, { data: sd }, { data: mapped }] = await Promise.all([
    supabasePublic.from("barm_amazon_sb_campaign").select("campaign_name"),
    supabasePublic.from("barm_amazon_sd_campaign").select("campaign_name"),
    supabasePublic.from("barm_amazon_campaign_sku_map").select("campaign_name"),
  ]);
  const mappedSet = new Set((mapped || []).map((r: { campaign_name: string }) => r.campaign_name));
  const all = new Set<string>();
  (sb || []).forEach((r: { campaign_name: string }) => all.add(r.campaign_name));
  (sd || []).forEach((r: { campaign_name: string }) => all.add(r.campaign_name));
  return [...all].filter((c) => !mappedSet.has(c)).sort();
}

export async function setCampaignSku(campaignName: string, sku: string): Promise<void> {
  const { error } = await supabasePublic
    .from("barm_amazon_campaign_sku_map")
    .upsert(
      { campaign_name: campaignName, sku, updated_at: new Date().toISOString() },
      { onConflict: "campaign_name" }
    );
  if (error) throw new Error(error.message);
}
