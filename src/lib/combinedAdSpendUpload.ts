import * as XLSX from "xlsx";
import { supabasePublic, type ReportDataInfo } from "@/lib/amazonReportUpload";
import { toDate as parseFlexibleDate } from "@/lib/meeshoReportUpload";

// Ingests the seller's own hand-assembled "Last 7 days - DD-MM-YYYY.xlsx"
// workbook in one shot. Writes each sheet's raw rows into its own dedicated
// barm_daily_<sheet> table (one table per sheet — a full archival copy,
// unrelated to reporting) AND — see REPORT_TARGETS/writeReportTable below —
// into the actual barm_amazon_sp_advertised_product/barm_amazon_am_orders/
// barm_flipkart_fsn_report/barm_flipkart_order_report/barm_meesho_ads/
// barm_meesho_orders tables "Generate Ad Spend Report" reads, using this
// workbook's own column headers instead of each platform's native export
// headers. Previously this uploader deliberately left those tables alone —
// that's what made the one-file upload insufficient on its own and forced a
// second round of per-report uploads for the exact same data every day.
//
// Sponsored Brands and Sponsored Display are the one gap this file can never
// close: this workbook has no SB/SD sheet at all (only Sponsored Products,
// via "AM ads"), because Amazon doesn't offer a combined SP+SB+SD download —
// those two still need their own separate upload on the Amazon Upload page.

export interface SheetUploadOutcome {
  sheet: string;
  label: string;
  status: "ok" | "empty" | "missing" | "error";
  detail: string;
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
}

interface DailyMirrorOutcome {
  table: string;
  status: "ok" | "empty" | "error";
  detail: string;
}

async function mirrorSheetToDailyTable(ws: XLSX.WorkSheet, spec: DailyMirrorSpec): Promise<DailyMirrorOutcome> {
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });
  const mapped = raw.map(spec.buildRow).filter((r): r is Record<string, unknown> => r !== null);

  if (!mapped.length) {
    return { table: spec.table, status: "empty", detail: `0/${raw.length} rows had identifying data.` };
  }

  const dates = mapped.map((r) => r.report_date as string | null).filter((d): d is string => !!d).sort();
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
  buildRow: (r) => {
    const p = makePicker(r);
    const order_id = str(p("amazon-order-id"));
    const sku = str(p("sku"));
    const purchaseDateRaw = p("purchase-date");
    if (!order_id && !sku) return null;
    return {
      order_id,
      report_date: parseFlexibleDate(purchaseDateRaw),
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
    const order_item_id = str(p("ORDER ITEM ID", "Order Item ID"));
    const orderedOn = p("Ordered On");
    if (!order_item_id) return null;
    return {
      order_item_id,
      order_id: str(p("Order Id", "Order ID")),
      report_date: parseFlexibleDate(orderedOn),
      order_datetime: str(orderedOn) || null,
      order_status: str(p("Order State")),
      sku: str(p("SKU")),
      fsn: str(p("FSN")),
      product_name: str(p("Product")),
      quantity: intOf(p("Quantity")),
      tracking_id: str(p("Tracking ID")),
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

// ── writing straight into the tables the Ad Spend Report reads ─────────────
//
// The mirror above only ever wrote to barm_daily_* — a backup copy the Ad
// Spend Report never touches. That meant this one-file upload could never be
// enough on its own, no matter how often it ran. These specs write the same
// sheets into the REAL tables (barm_amazon_sp_advertised_product,
// barm_amazon_am_orders, barm_flipkart_fsn_report, barm_flipkart_order_report,
// barm_meesho_ads, barm_meesho_orders) using each table's own column names
// and conflict/replace strategy — matching what the standalone per-report
// upload pages already do for the SAME tables, just reading this workbook's
// column headers instead of each platform's native export headers.
//
// Sponsored Brands and Sponsored Display are NOT covered here — this
// workbook never contains them (no SB/SD sheet exists in the seller's "Last
// 7 days" file at all), so that gap can only be closed by uploading those
// two reports separately on the Amazon Upload page.

interface ReportTableSpec {
  table: string;
  dateCol: string;
  strategy: "upsert" | "replaceRange";
  onConflict?: string;
  buildRow: (r: Record<string, unknown>) => Record<string, unknown> | null;
}

const REPORT_TARGETS: Record<string, ReportTableSpec> = {
  "AM ads": {
    table: "barm_amazon_sp_advertised_product",
    dateCol: "report_date",
    strategy: "upsert",
    onConflict: "report_date,campaign_name,ad_group_name,advertised_sku",
    buildRow: (r) => {
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
    },
  },
  "AM ord": {
    table: "barm_amazon_am_orders",
    dateCol: "purchase_date",
    strategy: "replaceRange",
    buildRow: (r) => {
      const p = makePicker(r);
      const amazon_order_id = str(p("amazon-order-id"));
      const purchaseRaw = p("purchase-date");
      const purchase_date = parseFlexibleDate(purchaseRaw);
      if (!amazon_order_id || !purchase_date) return null;
      return {
        amazon_order_id,
        order_item_id: str(p("order-item-id")),
        purchase_date,
        purchase_datetime: str(purchaseRaw) || null,
        order_status: str(p("order-status")),
        fulfillment_channel: str(p("fulfillment-channel")),
        sales_channel: str(p("sales-channel")),
        product_name: str(p("product-name")),
        sku: str(p("sku")),
        asin: str(p("asin")),
        item_status: str(p("item-status")),
        quantity: intOf(p("quantity")),
        currency: str(p("currency")),
        item_price: numOf(p("item-price")),
        item_tax: numOf(p("item-tax")),
        shipping_price: numOf(p("shipping-price")),
        item_promotion_discount: numOf(p("item-promotion-discount")),
        ship_city: str(p("ship-city")),
        ship_state: str(p("ship-state")),
        ship_postal_code: str(p("ship-postal-code")),
        raw: r,
      };
    },
  },
  "FK ads": {
    table: "barm_flipkart_fsn_report",
    dateCol: "report_date",
    strategy: "upsert",
    onConflict: "report_date,campaign_id,adgroup_id,sku_id",
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
      const order_item_id = str(p("ORDER ITEM ID", "Order Item ID"));
      const orderedOn = p("Ordered On");
      const order_date = parseFlexibleDate(orderedOn);
      if (!order_item_id || !order_date) return null;
      return {
        order_item_id,
        order_id: str(p("Order Id", "Order ID")),
        order_date,
        order_datetime: str(orderedOn) || null,
        order_item_status: str(p("Order State")),
        sku: str(p("SKU")),
        fsn: str(p("FSN")),
        product_title: str(p("Product")),
        quantity: intOf(p("Quantity")),
        delivery_tracking_id: str(p("Tracking ID")),
        raw: r,
      };
    },
  },
  "MS BARM ads": {
    table: "barm_meesho_ads",
    dateCol: "report_date",
    strategy: "upsert",
    onConflict: "report_date,campaign_name,sku",
    buildRow: (r) => {
      const p = makePicker(r);
      const report_date = parseFlexibleDate(p("Date"));
      const campaign_name = str(p("Campaign name", "Campaign Name"));
      const sku = str(p("SKU ID", "SKU"));
      if (!report_date || !campaign_name || !sku) return null;
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
  },
  "MS BARM ord": {
    table: "barm_meesho_orders",
    dateCol: "order_date",
    strategy: "upsert",
    onConflict: "sub_order_no",
    buildRow: (r) => {
      const p = makePicker(r);
      const sub_order_no = str(p("Sub Order No"));
      if (!sub_order_no || sub_order_no === "-") return null;
      return {
        order_status: str(p("Reason for Credit Entry")),
        sub_order_no,
        catalog_id: str(p("Catalog ID")),
        order_date: parseFlexibleDate(p("Order Date")),
        order_source: str(p("Order source")),
        customer_state: str(p("Customer State")),
        product_name: str(p("Product Name")),
        sku: str(p("SKU")),
        size: str(p("Size")),
        quantity: intOf(p("Quantity")),
        supplier_listed_price: numOf(p("Supplier Listed Price (Incl. GST + Commission)", "Supplier Listed Price")),
        supplier_discounted_price: numOf(
          p("Supplier Discounted Price (Incl GST and Commision)", "Supplier Discounted Price (Incl GST and Commission)", "Supplier Discounted Price")
        ),
        packet_id: str(p("Packet Id")),
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
  const dates = rows.map((r) => r[dateCol] as string | null).filter((d): d is string => !!d).sort();
  if (dates.length) {
    const { error: delErr } = await supabasePublic.from(table).delete().gte(dateCol, dates[0]).lte(dateCol, dates[dates.length - 1]);
    if (delErr) throw new Error(`Clearing ${table} failed: ${delErr.message}`);
  }
  const chunkSize = 300;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const { error } = await supabasePublic.from(table).insert(rows.slice(i, i + chunkSize));
    if (error) throw new Error(`Insert into ${table} failed: ${error.message}`);
  }
  return `${rows.length} rows -> ${table}`;
}

async function writeReportTable(ws: XLSX.WorkSheet, spec: ReportTableSpec): Promise<string> {
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });
  const mapped = raw.map(spec.buildRow).filter((r): r is Record<string, unknown> => r !== null);
  if (!mapped.length) return `0/${raw.length} rows usable for the report`;
  return spec.strategy === "upsert" ? upsertRows(spec.table, mapped, spec.onConflict!) : replaceRangeRows(spec.table, spec.dateCol, mapped);
}

export async function uploadCombinedWorkbook(file: File): Promise<SheetUploadOutcome[]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const results: SheetUploadOutcome[] = [];

  for (const sheet of Object.keys(SHEET_LABELS)) {
    const ws = findSheet(wb, sheet);
    if (!ws) {
      results.push({ sheet, label: SHEET_LABELS[sheet], status: "missing", detail: `No "${sheet}" sheet found in this file.` });
      continue;
    }
    try {
      const mirror = await mirrorSheetToDailyTable(ws, SHEET_MIRRORS[sheet]);
      const reportSpec = REPORT_TARGETS[sheet];
      if (!reportSpec) {
        results.push({ sheet, label: SHEET_LABELS[sheet], status: mirror.status, detail: mirror.detail });
        continue;
      }
      const reportDetail = await writeReportTable(ws, reportSpec);
      results.push({ sheet, label: SHEET_LABELS[sheet], status: mirror.status, detail: `${mirror.detail} · Ad Spend Report: ${reportDetail}.` });
    } catch (err) {
      results.push({ sheet, label: SHEET_LABELS[sheet], status: "error", detail: err instanceof Error ? err.message : String(err) });
    }
  }

  return results;
}
