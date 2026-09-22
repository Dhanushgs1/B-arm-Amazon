import Papa from "papaparse";
import * as XLSX from "xlsx";
import { supabasePublic } from "@/lib/amazonReportUpload";

// Meesho counterpart of amazonReportUpload.ts / flipkartReportUpload.ts — same
// shape (one card per seller-downloaded export, parsed in the browser and
// written into a barm_meesho_* raw table).
//
// Unlike Amazon/Flipkart, no native Meesho export has been seen directly here
// — the column names below come from the seller's own hand-assembled "Last 7
// days" workbook (its "MS BARM ads" / "MS BARM ord" sheets). If Meesho's own
// downloaded file uses different header text, `pick()`'s regex matching may
// need adjusting, but the two-report split and table shape should still hold.
// Run scripts/meesho_tables.sql once in the Supabase SQL Editor before the
// first upload — these two tables don't exist yet otherwise.
//
// Only two report types, both accept CSV or XLSX (Meesho's own download
// format isn't pinned down, so both are supported defensively):
//   ads    -> barm_meesho_ads    (Date, Campaign name, Product, SKU ID, Spend,
//             Views, Clicks, Orders by ad) — upserted on (date, campaign, sku).
//   orders -> barm_meesho_orders (Reason for Credit Entry, Sub Order No,
//             Catalog ID, Order Date, Order source, Customer State, Product
//             Name, SKU, Size, Quantity, Supplier Listed/Discounted Price,
//             Packet Id) — upserted on Sub Order No, which looks designed to
//             be a unique line-item id (e.g. "319200575035818816_1").

export type MeeshoUploadReportType = "ads" | "orders";

export const MS_REPORT_LABEL: Record<MeeshoUploadReportType, string> = {
  ads: "Meesho Ads report",
  orders: "Meesho Orders / Payments report",
};

export const MS_REPORT_HINT: Record<MeeshoUploadReportType, string> = {
  ads: "Meesho Ads Manager — campaign performance export: Date, Campaign name, Product, SKU ID, Spend, Views, Clicks, Orders by ad.",
  orders:
    "Meesho Supplier Panel — order/payment report, line-item level: Sub Order No, Catalog ID, Order Date, Product Name, SKU, Quantity, Supplier Listed/Discounted Price.",
};

export const MS_REPORT_ACCEPT: Record<MeeshoUploadReportType, string> = {
  ads: ".csv,.xlsx,.xls",
  orders: ".csv,.xlsx,.xls",
};

export const MS_REPORT_TABLE: Record<MeeshoUploadReportType, string> = {
  ads: "barm_meesho_ads",
  orders: "barm_meesho_orders",
};

export const MS_DATE_COLUMN: Record<MeeshoUploadReportType, string> = {
  ads: "report_date",
  orders: "order_date",
};

// ── value parsing ───────────────────────────────────────────────────────────

type RawRow = Record<string, unknown>;

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}
function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = str(v).replace(/[^0-9.eE+-]/g, "");
  if (!s) return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}
function int(v: unknown): number {
  return Math.round(num(v));
}

const MONTH_ABBR: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

// Handles an Excel serial date (cell typed as a date when the sheet came from
// an .xlsx), a plain ISO date, DD/MM/YYYY or MM/DD/YYYY (ambiguous — DD/MM is
// tried first since this seller's other exports are IN-locale), and "13-Aug-26".
export function toDate(v: unknown): string | null {
  if (typeof v === "number" && v > 0) {
    const d = XLSX.SSF.parse_date_code(v);
    if (!d) return null;
    return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  }
  const s = str(v);
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return iso[0];
  // "/" or "-" as always, plus "." — the B-Arm Orders workbook's own title line
  // ("B-arm order19.09.2026") shows the seller writing dates dot-separated, so
  // a hand-typed Date column in that same file is likely to use it too.
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(s);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  const dMonY = /^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/.exec(s);
  if (dMonY) {
    const mon = MONTH_ABBR[dMonY[2].toLowerCase()];
    if (mon) {
      const year = dMonY[3].length === 2 ? `20${dMonY[3]}` : dMonY[3];
      return `${year}-${mon}-${dMonY[1].padStart(2, "0")}`;
    }
  }
  // "Aug 20, 2026" / "August 20 2026" — Flipkart's order-report "Ordered On"
  // column, month name first instead of last.
  const monDY = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (monDY) {
    const mon = MONTH_ABBR[monDY[1].slice(0, 3).toLowerCase()];
    if (mon) return `${monDY[3]}-${mon}-${monDY[2].padStart(2, "0")}`;
  }
  return null;
}

function normalizeHeaderKey(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Header lookup tolerant of trailing spaces / case, same approach as
 *  flipkartReportUpload.ts's makePicker. */
function makePicker(row: RawRow) {
  const keys = Object.keys(row);
  const normalized = new Map<string, string>();
  keys.forEach((k) => normalized.set(normalizeHeaderKey(k), k));
  return (...candidates: string[]): unknown => {
    for (const cand of candidates) {
      const hit = normalized.get(normalizeHeaderKey(cand));
      if (hit !== undefined) return row[hit];
    }
    return "";
  };
}

// ── file readers ─────────────────────────────────────────────────────────────

async function readWorkbook(file: File): Promise<XLSX.WorkBook> {
  const buf = await file.arrayBuffer();
  return XLSX.read(buf, { type: "array" });
}

function readSheetRows(ws: XLSX.WorkSheet): RawRow[] {
  return XLSX.utils.sheet_to_json<RawRow>(ws, { defval: "", raw: true });
}

async function readRows(file: File): Promise<RawRow[]> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const wb = await readWorkbook(file);
    return readSheetRows(wb.Sheets[wb.SheetNames[0]]);
  }
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

// ── per-report row mappers ──────────────────────────────────────────────────

function mapAdsRow(row: RawRow) {
  const p = makePicker(row);
  return {
    report_date: toDate(p("Date")),
    campaign_name: str(p("Campaign name", "Campaign Name")),
    product_name: str(p("Product")),
    sku: str(p("SKU ID", "SKU")),
    spend: num(p("Spend")),
    views: int(p("Views")),
    clicks: int(p("Clicks")),
    orders_by_ad: int(p("Orders by ad")),
    raw: row,
  };
}

function mapOrderRow(row: RawRow) {
  const p = makePicker(row);
  return {
    order_status: str(p("Reason for Credit Entry")),
    sub_order_no: str(p("Sub Order No")),
    catalog_id: str(p("Catalog ID")),
    order_date: toDate(p("Order Date")),
    order_source: str(p("Order source")),
    customer_state: str(p("Customer State")),
    product_name: str(p("Product Name")),
    sku: str(p("SKU")),
    size: str(p("Size")),
    quantity: int(p("Quantity")),
    supplier_listed_price: num(p("Supplier Listed Price (Incl. GST + Commission)", "Supplier Listed Price")),
    supplier_discounted_price: num(p("Supplier Discounted Price (Incl GST and Commision)", "Supplier Discounted Price (Incl GST and Commission)", "Supplier Discounted Price")),
    packet_id: str(p("Packet Id")),
    raw: row,
  };
}

const MAPPER: Record<MeeshoUploadReportType, (row: RawRow) => Record<string, unknown>> = {
  ads: mapAdsRow,
  orders: mapOrderRow,
};
const REQUIRED_FIELDS: Record<MeeshoUploadReportType, string[]> = {
  ads: ["report_date", "campaign_name", "sku"],
  orders: ["sub_order_no"],
};
const ON_CONFLICT: Record<MeeshoUploadReportType, string> = {
  ads: "report_date,campaign_name,sku",
  orders: "sub_order_no",
};

// ── Supabase writes ──────────────────────────────────────────────────────────

async function upsertInChunks(table: string, rows: Record<string, unknown>[], onConflict: string, chunkSize = 300): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const { error } = await supabasePublic.from(table).upsert(rows.slice(i, i + chunkSize), { onConflict });
    if (error) throw new Error(`Upsert into ${table} failed: ${error.message}`);
  }
}

export interface MeeshoUploadResult {
  totalRows: number;
  savedRows: number;
  skippedRows: number;
  minDate: string | null;
  maxDate: string | null;
}

export async function uploadMeeshoReportFile(type: MeeshoUploadReportType, file: File): Promise<MeeshoUploadResult> {
  const rawRows = await readRows(file);
  const mapped = rawRows.map(MAPPER[type]);
  const required = REQUIRED_FIELDS[type];
  const valid = mapped.filter((r) => required.every((f) => r[f] !== null && r[f] !== undefined && r[f] !== ""));

  if (!valid.length) {
    return { totalRows: rawRows.length, savedRows: 0, skippedRows: rawRows.length, minDate: null, maxDate: null };
  }

  await upsertInChunks(MS_REPORT_TABLE[type], valid, ON_CONFLICT[type]);

  const dateCol = MS_DATE_COLUMN[type];
  const dates = valid.map((r) => r[dateCol] as string | null).filter((d): d is string => !!d).sort();

  return {
    totalRows: rawRows.length,
    savedRows: valid.length,
    skippedRows: rawRows.length - valid.length,
    minDate: dates[0] ?? null,
    maxDate: dates[dates.length - 1] ?? null,
  };
}

// ── "data on file" summaries for the upload cards ───────────────────────────

export interface MeeshoReportDataInfo {
  rowCount: number;
  minDate: string | null;
  maxDate: string | null;
  error?: string;
}

export async function fetchMeeshoReportDataInfo(type: MeeshoUploadReportType): Promise<MeeshoReportDataInfo> {
  const table = MS_REPORT_TABLE[type];
  const dateCol = MS_DATE_COLUMN[type];

  const [minRes, maxRes] = await Promise.all([
    supabasePublic.from(table).select(dateCol, { count: "exact" }).not(dateCol, "is", null).order(dateCol, { ascending: true }).limit(1),
    supabasePublic.from(table).select(dateCol).not(dateCol, "is", null).order(dateCol, { ascending: false }).limit(1),
  ]);
  const failure = minRes.error || maxRes.error;
  if (failure) return { rowCount: 0, minDate: null, maxDate: null, error: failure.message };

  const minDate = (minRes.data?.[0] as unknown as Record<string, string> | undefined)?.[dateCol] ?? null;
  const maxDate = (maxRes.data?.[0] as unknown as Record<string, string> | undefined)?.[dateCol] ?? null;
  return {
    rowCount: minRes.count || 0,
    minDate: minDate ? minDate.slice(0, 10) : null,
    maxDate: maxDate ? maxDate.slice(0, 10) : null,
  };
}

/** Never rejects — one unreachable table must not blank the other card's caption. */
export async function fetchAllMeeshoReportDataInfo(): Promise<Record<MeeshoUploadReportType, MeeshoReportDataInfo>> {
  const types = Object.keys(MS_REPORT_TABLE) as MeeshoUploadReportType[];
  const results = await Promise.allSettled(types.map((t) => fetchMeeshoReportDataInfo(t)));
  return Object.fromEntries(
    types.map((t, i) => {
      const r = results[i];
      return [
        t,
        r.status === "fulfilled"
          ? r.value
          : { rowCount: 0, minDate: null, maxDate: null, error: r.reason instanceof Error ? r.reason.message : String(r.reason) },
      ];
    })
  ) as Record<MeeshoUploadReportType, MeeshoReportDataInfo>;
}
