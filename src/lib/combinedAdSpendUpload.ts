import * as XLSX from "xlsx";
import { supabasePublic, type ReportDataInfo } from "@/lib/amazonReportUpload";
import { toDate as parseFlexibleDate } from "@/lib/meeshoReportUpload";

// Ingests the seller's own hand-assembled "Last 7 days - DD-MM-YYYY.xlsx"
// workbook in one shot. Deliberately does NOT touch the shared reporting
// tables (barm_amazon_*/barm_flipkart_*/barm_meesho_ads/barm_meesho_orders) —
// "Generate Ad Spend Report" reads those, and they're populated by the
// per-report upload cards below instead. This uploader only writes each
// sheet's raw rows into its own dedicated barm_daily_<sheet> table (one table
// per sheet — Amazon, Flipkart and Meesho never share a table, and the two
// Meesho stores never share a table either), so the one-file upload can never
// clobber or race with whatever the per-report cards have already saved.

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
      results.push({ sheet, label: SHEET_LABELS[sheet], status: mirror.status, detail: mirror.detail });
    } catch (err) {
      results.push({ sheet, label: SHEET_LABELS[sheet], status: "error", detail: err instanceof Error ? err.message : String(err) });
    }
  }

  return results;
}
