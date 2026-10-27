import Papa from "papaparse";
import * as XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";
import { lazySupabase, SUPABASE_URL, SUPABASE_ANON_KEY } from "@/lib/supabaseLazy";
import { orderStatusHistoryRows, ORDER_STATUS_HISTORY_KEY } from "@/lib/historicalReportRules";

// The 20 barm_* tables (the ones in REPORT_TABLE below, plus barm_alert_state
// and barm_amazon_campaign_sku_map) live in the default `public` schema —
// moved back here after Supabase's Data API gateway wouldn't reliably expose
// a separate `barm` schema (the "Exposed schemas" dashboard setting showed
// `barm` as saved, but the live API kept rejecting requests with
// PGRST106/"Invalid schema: barm" even after a project restart).
// Built on first use, not at import — see src/lib/supabaseLazy.ts. This module is pulled into the
// client bundle by the Upload and Reports pages, so constructing eagerly meant a missing
// NEXT_PUBLIC_SUPABASE_* variable crashed those pages outright instead of just this feature.
export const supabasePublic = lazySupabase(() =>
  createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
);

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
// Of those, the ledger DOES have a unique natural key — one row per day × FNSKU × MSKU × disposition ×
// warehouse, enforced by a unique constraint. Two ledger files uploaded at the same moment used to
// both run "delete range" before either inserted, storing the overlapping days twice; upserting on
// the key after the range delete makes concurrent and repeated uploads converge instead.
const REPLACE_UPSERT_KEY: Partial<Record<UploadReportType, string>> = {
  inventory_ledger: "ledger_date,fnsku,msku,disposition,location",
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

// These two report tables (plus Flipkart's fsn_report/order_report — see
// PRUNE_TO_UPLOAD_RANGE in flipkartReportUpload.ts) are meant to hold only
// the date range the seller's own export covers, not full history: the
// seller's "Last N days" downloads are themselves the retention window, so
// once a fresh file lands, any row outside that file's min/max date is from
// an earlier upload's window and should be dropped rather than accumulate
// forever.
const PRUNE_TO_UPLOAD_RANGE: Partial<Record<UploadReportType, true>> = {
  sp_advertised_product: true,
  am_orders: true,
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
  // campaign_name is deliberately NOT required here — some sellers' exports
  // carry SKU-level spend rows with no campaign attached (a manual
  // allocation row rather than a tracked-campaign one), and dropping those
  // would silently lose real spend instead of just saving it uncategorized.
  sp_advertised_product: ["report_date", "advertised_sku"],
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

// "07/22/2026" or "08-09-2026" -> "2026-07-22" / "2026-08-09" (Inventory
// ledger "Date" column, US MM/DD/YYYY — Amazon's export has been seen with
// both "/" and "-" separators).
function parseMDY(v: string): string | null {
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(v.trim());
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

// ── CSV/XLSX parsing ─────────────────────────────────────────────────────────

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

async function parseXlsxFile(file: File): Promise<RawRow[]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { raw: false, defval: "" });
  return rows.map((row) => {
    const out: RawRow = {};
    for (const [k, v] of Object.entries(row)) out[k.trim()] = v == null ? "" : String(v).trim();
    return out;
  });
}

// Seller Central's catalog/inventory downloads (Price / FBA Inventory /
// Inventory Ledger) come out as either .csv or .xlsx depending on how the
// seller exported them — a seller CSV export has repeatedly arrived corrupted
// (Amazon's own report tool wrapping the whole tab-separated row into a
// single quoted CSV field, so every column-name regex in the mappers above
// misses and every row gets dropped as missing its required fields) while the
// .xlsx export from the same report is clean, so dispatch on extension
// instead of assuming CSV.
export function parseReportFile(file: File): Promise<RawRow[]> {
  return /\.xlsx?$/i.test(file.name) ? parseXlsxFile(file) : parseCsvFile(file);
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
    // The custom-column All-Listings export (Manage All Inventory) can carry
    // only "maximum-retail-price" and no "price" — user rule (2026-10-26):
    // store the MRP as the price then, instead of 0 for every SKU.
    price: toNum(pick(row, /^price$/i) || pick(row, /^maximum-retail-price$/i)),
    business_price: toNum(pick(row, /^Business Price$/i)),
    quantity: toInt(pick(row, /^quantity$/i)),
    fulfillment_channel: pick(row, /^fulfillment-channel$/i),
    asin1: pick(row, /^asin1$/i),
    item_condition: pick(row, /^item-condition$/i),
    // "Active" / "Inactive" on Amazon's own All-Listings export — lets a report
    // tell a genuinely delisted SKU apart from one that simply sold nothing
    // this window. Blank when the export doesn't carry the column at all
    // (older exports), which callers must treat as "unknown", not "inactive".
    status: pick(row, /^status$/i),
    raw: row,
  };
}

// Amazon has two FBA stock exports with different column names for the same quantities:
//   "Manage FBA Inventory"  — afn-fulfillable-quantity, afn-reserved-quantity, afn-unsellable-quantity,
//                             afn-inbound-{working,shipped,receiving}-quantity, mfn-fulfillable-quantity
//   "FBA Inventory" (planning) — available, Total Reserved Quantity, unfulfillable-quantity,
//                             inbound-{working,shipped,received}, snapshot-date
// Reading only the first set silently stored 0 for every quantity of the second. Each field takes
// whichever column the file has; a column neither format has stays null (unknown), never 0.
function pickInt(row: RawRow, ...res: RegExp[]): number | null {
  for (const re of res) {
    if (Object.keys(row).some((k) => re.test(k))) return toInt(pick(row, re));
  }
  return null;
}

export function mapFbaInventoryRow(row: RawRow) {
  const fulfillable = pickInt(row, /^afn-fulfillable-quantity$/i, /^available$/i);
  const reserved = pickInt(row, /^afn-reserved-quantity$/i, /^Total Reserved Quantity$/i);
  const unsellable = pickInt(row, /^afn-unsellable-quantity$/i, /^unfulfillable-quantity$/i);
  const inWorking = pickInt(row, /^afn-inbound-working-quantity$/i, /^inbound-working$/i);
  const inShipped = pickInt(row, /^afn-inbound-shipped-quantity$/i, /^inbound-shipped$/i);
  const inReceiving = pickInt(row, /^afn-inbound-receiving-quantity$/i, /^inbound-received$/i);
  const total = pickInt(row, /^afn-total-quantity$/i)
    ?? [fulfillable, reserved, unsellable, inWorking, inShipped, inReceiving].reduce<number>((a, v) => a + (v ?? 0), 0);
  const snapshot = pick(row, /^snapshot-date$/i);
  return {
    sku: pick(row, /^sku$/i),
    fnsku: pick(row, /^fnsku$/i),
    asin: pick(row, /^asin$/i),
    product_name: pick(row, /^product-name$/i),
    condition: pick(row, /^condition$/i),
    your_price: toNum(pick(row, /^your-price$/i)),
    mfn_fulfillable_quantity: pickInt(row, /^mfn-fulfillable-quantity$/i),
    afn_fulfillable_quantity: fulfillable ?? 0,
    afn_total_quantity: total,
    afn_unsellable_quantity: unsellable ?? 0,
    afn_reserved_quantity: reserved ?? 0,
    afn_inbound_working_quantity: inWorking ?? 0,
    afn_inbound_shipped_quantity: inShipped ?? 0,
    afn_inbound_receiving_quantity: inReceiving ?? 0,
    // the date Amazon took the snapshot; null for the Manage-Inventory export, which carries none
    snapshot_date: /^\d{4}-\d{2}-\d{2}/.test(snapshot) ? snapshot.slice(0, 10) : null,
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

// Additive metrics to sum when two rows in the same file collapse onto the
// same upsert key — only possible now that sp_advertised_product no longer
// requires campaign_name: two campaign-less rows for the same SKU/date have
// an identical key (date, "", "", sku) despite being genuinely separate
// spend entries, and Postgres upsert errors ("cannot affect row a second
// time") if a single batch has two rows with the same conflict key.
const SUMMABLE_FIELDS: Partial<Record<UploadReportType, string[]>> = {
  sp_advertised_product: [
    "impressions", "clicks", "spend", "sales_7d", "orders_7d", "units_7d",
    "advertised_sku_units_7d", "other_sku_units_7d", "advertised_sku_sales_7d", "other_sku_sales_7d",
  ],
  sb_campaign: ["impressions", "clicks", "spend", "sales", "orders", "units"],
  sd_campaign: ["impressions", "clicks", "spend", "sales_14d", "orders_14d", "units_14d"],
};

// Ratio/rate fields can't be summed (that double-counts fractions) — they're
// recomputed from the merged group's summed base counts instead.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function recomputeRatios(type: UploadReportType, row: any): void {
  const n = (v: unknown) => Number(v) || 0;
  if (type === "sp_advertised_product") {
    row.ctr = n(row.impressions) ? n(row.clicks) / n(row.impressions) : null;
    row.cpc = n(row.clicks) ? n(row.spend) / n(row.clicks) : null;
    row.acos = n(row.sales_7d) ? n(row.spend) / n(row.sales_7d) : null;
    row.roas = n(row.spend) ? n(row.sales_7d) / n(row.spend) : null;
    row.conversion_rate_7d = n(row.clicks) ? n(row.orders_7d) / n(row.clicks) : null;
  } else if (type === "sb_campaign") {
    row.ctr = n(row.impressions) ? n(row.clicks) / n(row.impressions) : null;
    row.cpc = n(row.clicks) ? n(row.spend) / n(row.clicks) : null;
    row.acos = n(row.sales) ? n(row.spend) / n(row.sales) : null;
    row.roas = n(row.spend) ? n(row.sales) / n(row.spend) : null;
    row.conversion_rate = n(row.clicks) ? n(row.orders) / n(row.clicks) : null;
  } else if (type === "sd_campaign") {
    row.ctr = n(row.impressions) ? n(row.clicks) / n(row.impressions) : null;
    row.cpc = n(row.clicks) ? n(row.spend) / n(row.clicks) : null;
    row.acos = n(row.sales_14d) ? n(row.spend) / n(row.sales_14d) : null;
    row.roas = n(row.spend) ? n(row.sales_14d) / n(row.spend) : null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mergeDuplicateKeyRows(type: UploadReportType, rows: any[], onConflict: string): any[] {
  const summable = SUMMABLE_FIELDS[type];
  if (!summable) return rows;
  const keyFields = onConflict.split(",");
  const groups = new Map<string, typeof rows>();
  rows.forEach((r) => {
    const key = keyFields.map((f) => String(r[f] ?? "")).join(" ");
    const list = groups.get(key) || [];
    list.push(r);
    groups.set(key, list);
  });

  const out: typeof rows = [];
  groups.forEach((list) => {
    if (list.length === 1) {
      out.push(list[0]);
      return;
    }
    const merged = { ...list[0] };
    summable.forEach((f) => {
      merged[f] = list.reduce((sum, r) => sum + (Number(r[f]) || 0), 0);
    });
    merged.raw = list.map((r) => r.raw);
    recomputeRatios(type, merged);
    out.push(merged);
  });
  return out;
}

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

// Deletes every row OUTSIDE [minDate, maxDate] — the opposite of
// replaceDateRange/deleteDateRange, which only clear the overlapping range
// before a fresh insert. Used for PRUNE_TO_UPLOAD_RANGE report types, where
// the latest upload's own date span defines everything that should still be
// on file.
export async function pruneOutsideRange(table: string, dateCol: string, minDate: string, maxDate: string): Promise<void> {
  const { error: belowErr } = await supabasePublic.from(table).delete().lt(dateCol, minDate);
  if (belowErr) throw new Error(`Pruning ${table} rows before ${minDate} failed: ${belowErr.message}`);
  const { error: aboveErr } = await supabasePublic.from(table).delete().gt(dateCol, maxDate);
  if (aboveErr) throw new Error(`Pruning ${table} rows after ${maxDate} failed: ${aboveErr.message}`);
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
  // A file with zero usable rows (wrong report, renamed columns) must never wipe the
  // existing snapshot — the delete below would otherwise leave the table empty.
  if (rows.length === 0) throw new Error("No valid rows found in this file — check it is the right report. Existing data was left unchanged.");
  const { error } = await supabasePublic.from(table).delete().gte("id", 0);
  if (error) throw new Error(`Truncate ${table} failed: ${error.message}`);
  await insertInChunks(table, rows);
}

export interface UploadResult {
  totalRows: number;
  validRows: number;
  skippedRows: number;
  // Only populated for the upsert path (SP/SB/SD ad reports) — lets the
  // upload page check the just-uploaded campaigns for high ACOS without a
  // second round-trip to Supabase.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rows?: any[];
  /** Orders card only: status rows appended to barm_amazon_order_status_history (after duplicates
   *  within the file collapse), or why that step was skipped. The upload itself never fails on it. */
  statusHistory?: { rows: number } | { error: string };
}

// Orders card uploads also append each line's status to barm_amazon_order_status_history, which —
// unlike barm_amazon_am_orders — is never pruned to the latest file's date range, so a cancellation
// Amazon reported stays on record after an upload of another range. Insert-or-ignore on the
// (order, SKU, last-updated-date, status) key, so re-uploading the same file adds nothing. Best-effort:
// a failure (e.g. the table not created yet) is reported back but never fails the orders upload.
async function appendOrderStatusHistory(rows: Parameters<typeof orderStatusHistoryRows>[0], sourceFile: string): Promise<{ rows: number } | { error: string }> {
  const history = orderStatusHistoryRows(rows, sourceFile);
  try {
    for (let i = 0; i < history.length; i += 300) {
      const { error } = await supabasePublic
        .from("barm_amazon_order_status_history")
        .upsert(history.slice(i, i + 300), { onConflict: ORDER_STATUS_HISTORY_KEY, ignoreDuplicates: true });
      if (error) throw new Error(error.message);
    }
    return { rows: history.length };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn("[orders upload] status history not saved:", message);
    return { error: message };
  }
}

// Amazon's own orders/returns exports occasionally contain a literal
// duplicate line (every column identical, not just the natural key) — with
// no per-row upsert possible here (see REPLACE_DATE_FIELD above), those would
// otherwise both get inserted and double-count in reports. Only rows that
// match on EVERY field are collapsed; a genuine split-shipment row sharing
// just order+SKU always differs in at least one other field (quantity,
// order-item-id, ...) and is left untouched.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function dedupeExactRows(rows: any[]): any[] {
  const seen = new Set<string>();
  const out: typeof rows = [];
  for (const r of rows) {
    const key = JSON.stringify(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
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
  const rawRows = await parseReportFile(file);
  const mapper = REPORT_MAPPER[type];
  const required = REQUIRED_FIELDS[type];
  const mapped = rawRows.map(mapper);
  const valid = mapped.filter((r) => required.every((f) => r[f] !== null && r[f] !== undefined && r[f] !== ""));

  const table = REPORT_TABLE[type];
  const onConflict = ON_CONFLICT[type];
  const replaceDateField = REPLACE_DATE_FIELD[type];

  if (onConflict) {
    const deduped = mergeDuplicateKeyRows(type, valid, onConflict);
    await upsertInChunks(table, deduped, onConflict);
    if (PRUNE_TO_UPLOAD_RANGE[type] && deduped.length > 0) {
      const dateCol = DATE_COLUMN[type]!;
      const dates = deduped.map((r) => r[dateCol]).filter(Boolean).sort();
      await pruneOutsideRange(table, dateCol, dates[0].slice(0, 10), dates[dates.length - 1].slice(0, 10));
    }
    return {
      totalRows: rawRows.length,
      validRows: valid.length,
      skippedRows: rawRows.length - valid.length,
      rows: deduped,
    };
  } else if (FULL_REPLACE_TYPES[type]) {
    await truncateAndInsert(table, valid);
    return {
      totalRows: rawRows.length,
      validRows: valid.length,
      skippedRows: rawRows.length - valid.length,
    };
  } else if (replaceDateField && valid.length > 0) {
    const deduped = dedupeExactRows(valid);
    const dates = deduped.map((r) => r[replaceDateField]).filter(Boolean).sort();
    const minDate = dates[0].slice(0, 10);
    const maxDate = dates[dates.length - 1].slice(0, 10);
    await replaceDateRange(table, replaceDateField, !!REPLACE_IS_TIMESTAMP[type], minDate, maxDate);
    const naturalKey = REPLACE_UPSERT_KEY[type];
    if (naturalKey) {
      // last row wins per key (one upsert chunk may not touch the same key twice)
      const byKey = new Map(deduped.map((r) => [naturalKey.split(",").map((f) => String(r[f] ?? "")).join("|"), r]));
      await upsertInChunks(table, [...byKey.values()], naturalKey);
    } else {
      await insertInChunks(table, deduped);
    }
    const statusHistory = type === "am_orders" ? await appendOrderStatusHistory(deduped, file.name) : undefined;
    if (PRUNE_TO_UPLOAD_RANGE[type]) {
      await pruneOutsideRange(table, replaceDateField, minDate, maxDate);
    }
    return {
      totalRows: rawRows.length,
      validRows: deduped.length,
      skippedRows: rawRows.length - deduped.length,
      ...(statusHistory ? { statusHistory } : {}),
    };
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

  // Rows with no date yet (e.g. an SF/AM return not picked up, so its
  // pickup/return-request date is still blank) must be excluded here —
  // Postgres sorts NULLs FIRST on a descending order by default, so without
  // this filter the "max date" query returns one of those blank rows instead
  // of the latest real date, showing an empty end date in the upload card.
  const [{ data: minRows, count }, { data: maxRows }] = await Promise.all([
    supabasePublic.from(table).select(dateCol, { count: "exact" }).not(dateCol, "is", null).order(dateCol, { ascending: true }).limit(1),
    supabasePublic.from(table).select(dateCol).not(dateCol, "is", null).order(dateCol, { ascending: false }).limit(1),
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

export interface CampaignSkuWeight {
  sku: string;
  /** Relative share, not a fraction — see setCampaignSkus. */
  weight: number;
}

/**
 * Replace a campaign's whole SKU allocation.
 *
 * Amazon's Sponsored Brands / Display exports carry no SKU column, so a
 * campaign's spend has to be routed to SKUs by the seller. `weight` is a
 * RELATIVE share: the export divides each weight by the campaign's total, so
 * {2,1,1} and {50,25,25} allocate identically and adding a SKU never forces
 * the existing rows to be rebalanced.
 *
 * Rows are replaced, not merged — a SKU dropped from `entries` is removed from
 * the map, which is what makes this safe to call straight from the editor UI.
 */
export async function setCampaignSkus(campaignName: string, entries: CampaignSkuWeight[]): Promise<void> {
  const clean = entries
    .map((e) => ({ sku: e.sku.trim(), weight: Number(e.weight) }))
    .filter((e) => e.sku && Number.isFinite(e.weight) && e.weight > 0);

  const { error: delErr } = await supabasePublic
    .from("barm_amazon_campaign_sku_map")
    .delete()
    .eq("campaign_name", campaignName);
  if (delErr) throw new Error(delErr.message);

  if (!clean.length) return;

  const now = new Date().toISOString();
  const { error } = await supabasePublic
    .from("barm_amazon_campaign_sku_map")
    .upsert(
      clean.map((e) => ({ campaign_name: campaignName, sku: e.sku, weight: e.weight, updated_at: now })),
      { onConflict: "campaign_name,sku" }
    );
  if (error) throw new Error(error.message);
}

/** Single-SKU convenience wrapper — the whole campaign goes to one SKU. */
export async function setCampaignSku(campaignName: string, sku: string): Promise<void> {
  return setCampaignSkus(campaignName, [{ sku, weight: 1 }]);
}

export interface CampaignAllocation {
  campaignName: string;
  /** Which export the campaign came from — Sponsored Brands or Display. */
  source: "SB" | "SD";
  /** Total uploaded spend for the campaign, so the UI can price the split. */
  spend: number;
  skus: CampaignSkuWeight[];
}

/**
 * Every Sponsored Brands / Display campaign with its current weighted SKU
 * allocation — including ones already mapped, so an existing split stays
 * editable (fetchUnmappedCampaigns only ever surfaces the untouched ones).
 */
export async function fetchCampaignAllocations(): Promise<CampaignAllocation[]> {
  // Supabase caps an unbounded select at 1000 rows; page explicitly so a long
  // upload history cannot silently hide campaigns.
  const pageAll = async (table: string): Promise<{ campaign_name: string; spend: number | null }[]> => {
    const out: { campaign_name: string; spend: number | null }[] = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabasePublic
        .from(table)
        .select("campaign_name, spend")
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      const rows = data || [];
      out.push(...rows);
      if (rows.length < PAGE) return out;
    }
  };

  const [sb, sd, weights] = await Promise.all([
    pageAll("barm_amazon_sb_campaign"),
    pageAll("barm_amazon_sd_campaign"),
    fetchCampaignSkuWeights(),
  ]);

  const byName = new Map<string, CampaignAllocation>();
  const add = (rows: { campaign_name: string; spend: number | null }[], source: "SB" | "SD") => {
    rows.forEach((r) => {
      if (!r.campaign_name) return;
      const cur = byName.get(r.campaign_name) || { campaignName: r.campaign_name, source, spend: 0, skus: [] };
      cur.spend += Number(r.spend) || 0;
      byName.set(r.campaign_name, cur);
    });
  };
  add(sb, "SB");
  add(sd, "SD");
  byName.forEach((c) => { c.skus = weights.get(c.campaignName) || []; });

  // Unmapped first (they are what needs attention), then by spend descending.
  return [...byName.values()].sort((a, b) => {
    const am = a.skus.length === 0 ? 0 : 1;
    const bm = b.skus.length === 0 ? 0 : 1;
    if (am !== bm) return am - bm;
    return b.spend - a.spend;
  });
}

/** campaign name -> its weighted SKU allocation, for the report exporters. */
export async function fetchCampaignSkuWeights(): Promise<Map<string, CampaignSkuWeight[]>> {
  const { data, error } = await supabasePublic
    .from("barm_amazon_campaign_sku_map")
    .select("campaign_name, sku, weight");
  if (error) throw new Error(error.message);
  const map = new Map<string, CampaignSkuWeight[]>();
  (data || []).forEach((r: { campaign_name: string; sku: string; weight: number | string | null }) => {
    const weight = Number(r.weight);
    const list = map.get(r.campaign_name) || [];
    list.push({ sku: r.sku, weight: Number.isFinite(weight) && weight > 0 ? weight : 1 });
    map.set(r.campaign_name, list);
  });
  return map;
}
