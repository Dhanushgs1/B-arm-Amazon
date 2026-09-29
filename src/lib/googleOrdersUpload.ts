import Papa from "papaparse";
import * as XLSX from "xlsx";
import { supabasePublic } from "@/lib/amazonReportUpload";
import { toDate as parseFlexibleDate } from "@/lib/meeshoReportUpload";
import { detectBarmOrdersLayout, findBarmOrdersHeader, mapBarmOfflineRows, type BarmOrdersLayout } from "@/lib/barmOfflineOrderRules";

// Google (direct/website) orders upload — the seller's own hand-kept "B-Arm
// Orders" workbook for direct/Google-driven sales that don't come through
// Amazon, Flipkart or Meesho at all. Unlike every other upload in this app,
// this channel has no ad campaign export of any kind (no Spend/CPC/ACOS to
// parse) — just a flat list of order lines (S no, Date, Invoice, Sku, Qty,
// Price). Every row needs a Date now (see google_orders_table.sql) so the Ad
// Spend Report can scope this channel's Orders/Sales to its date range the
// same way it already does for Amazon/Flipkart/Meesho, instead of the old
// dateless behaviour of showing a running cumulative total on every report.
// Run scripts/google_orders_table.sql once in the Supabase SQL Editor before
// the first upload — barm_daily_google_orders doesn't exist otherwise.
//
// Feeds the Ad Spend Report's "Google" Summary row and Ad spend report
// sheet's Google section (see fetchGoogleOrders in adSpendReportExport.ts)
// with Orders (Quantity) and Sales (Quantity x Price) only — there is no
// Spend/CPC/ACOS for this channel.

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

function normalizeHeaderKey(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Header lookup tolerant of trailing spaces / case, same approach as
 *  meeshoReportUpload.ts's makePicker. */
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

async function readWorkbook(file: File): Promise<XLSX.WorkBook> {
  const buf = await file.arrayBuffer();
  return XLSX.read(buf, { type: "array" });
}

// The seller's workbook carries a title line ("B-Arm Orders:04") above the
// real header row — sheet_to_json's default header:1 object mode would read
// that title as row 1's single column instead of skipping to the real
// header, so the header row is located explicitly: the legacy layout by its own
// "S no" cell (unchanged), the offline layout by its Date / Quantity / SKU ID
// header (see findBarmOrdersHeader in barmOfflineOrderRules.ts).
function readSheetRows(ws: XLSX.WorkSheet): { layout: BarmOrdersLayout | null; rows: RawRow[] } {
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" }) as unknown[][];
  const header = findBarmOrdersHeader(aoa);
  if (!header) return { layout: null, rows: [] };
  const [headerCells, ...dataRows] = aoa.slice(header.index);
  const headers = headerCells.map((h) => str(h));
  const rows = dataRows
    .filter((cells) => cells.some((c) => str(c) !== ""))
    .map((cells) => {
      const row: RawRow = {};
      headers.forEach((key, i) => { if (key) row[key] = cells[i] ?? ""; });
      return row;
    });
  return { layout: header.layout, rows };
}

async function readRows(file: File): Promise<{ layout: BarmOrdersLayout | null; rows: RawRow[] }> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const wb = await readWorkbook(file);
    return readSheetRows(wb.Sheets[wb.SheetNames[0]]);
  }
  const rows = await new Promise<RawRow[]>((resolve, reject) => {
    Papa.parse<RawRow>(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h: string) => h.trim(),
      complete: (results) => resolve(results.data),
      error: (err: Error) => reject(err),
    });
  });
  // A CSV always went through the legacy mapper (no "S no" check); only a CSV whose header is
  // the offline layout's is routed to the offline rules now.
  const layout = detectBarmOrdersLayout(Object.keys(rows[0] || {})) === "offline" ? "offline" : "legacy";
  return { layout, rows };
}

function mapOrderRow(row: RawRow) {
  const p = makePicker(row);
  return {
    serial_no: int(p("S no", "S No", "SNo")),
    order_date: parseFlexibleDate(p("Date", "Order Date")),
    invoice: str(p("Invoice")),
    // The seller's column here is headed "Sku" (a SKU code, e.g.
    // "B-BRESHE-SNOW"), not a human product name — there's no separate
    // "Product" column in this workbook at all. "Product" is tried first
    // only in case a future version of the sheet adds a real name column.
    product_name: str(p("Product", "Sku", "SKU")),
    quantity: int(p("Qty", "Quantity")),
    price: num(p("Price")),
    raw: row,
  };
}

const REQUIRED_FIELDS = ["invoice", "order_date"];

async function upsertInChunks(table: string, rows: Record<string, unknown>[], onConflict: string, chunkSize = 300): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const { error } = await supabasePublic.from(table).upsert(rows.slice(i, i + chunkSize), { onConflict });
    if (error) throw new Error(`Upsert into ${table} failed: ${error.message}`);
  }
}

export interface GoogleOrdersParseResult {
  /** null when no recognised header row was found (nothing to save). */
  layout: BarmOrdersLayout | null;
  totalRows: number;
  /** Rows ready for barm_daily_google_orders, in file order. */
  rows: Record<string, unknown>[];
  skippedRows: number;
  /** Offline layout only: saved rows whose file gives no price (price saved as null). */
  rowsWithoutPrice: number;
  minDate: string | null;
  maxDate: string | null;
}

/** Reads and maps the file without writing anything — the upload below saves exactly these rows. */
export async function parseGoogleOrdersFile(file: File): Promise<GoogleOrdersParseResult> {
  const { layout, rows: rawRows } = await readRows(file);
  let rows: Record<string, unknown>[];
  let rowsWithoutPrice = 0;
  if (layout === "offline") {
    const parsed = mapBarmOfflineRows(rawRows);
    rows = parsed.rows as unknown as Record<string, unknown>[];
    rowsWithoutPrice = parsed.rowsWithoutPrice;
  } else {
    rows = rawRows.map(mapOrderRow).filter((r) => REQUIRED_FIELDS.every((f) => r[f as keyof typeof r] !== null && r[f as keyof typeof r] !== undefined && r[f as keyof typeof r] !== ""));
  }
  const dates = rows.map((r) => r.order_date as string | null).filter((d): d is string => !!d).sort();
  return {
    layout,
    totalRows: rawRows.length,
    rows,
    skippedRows: rawRows.length - rows.length,
    rowsWithoutPrice,
    minDate: dates[0] ?? null,
    maxDate: dates[dates.length - 1] ?? null,
  };
}

export interface GoogleOrdersUploadResult {
  totalRows: number;
  savedRows: number;
  skippedRows: number;
  layout: BarmOrdersLayout | null;
  rowsWithoutPrice: number;
  minDate: string | null;
  maxDate: string | null;
}

export async function uploadGoogleOrdersFile(file: File): Promise<GoogleOrdersUploadResult> {
  const parsed = await parseGoogleOrdersFile(file);
  const { rows, ...summary } = parsed;
  if (!rows.length) return { ...summary, savedRows: 0, skippedRows: parsed.totalRows };

  await upsertInChunks("barm_daily_google_orders", rows, "invoice");

  return { ...summary, savedRows: rows.length };
}

export interface GoogleOrdersDataInfo {
  rowCount: number;
  totalUnits: number;
  totalValue: number;
  minDate: string | null;
  maxDate: string | null;
  error?: string;
}

// "Data on file" is still a running total across every upload so far (not
// scoped to whatever date range the Ad Spend Report is currently generated
// for), same convention as the Price/FBA Inventory snapshot cards in
// amazonReportUpload.ts — but now that order_date exists, its min/max is
// shown alongside the total so it's visible which dates are actually on
// file, same as the combined "Ad Spend Report" upload card above it.
export async function fetchGoogleOrdersDataInfo(): Promise<GoogleOrdersDataInfo> {
  const { data, error, count } = await supabasePublic
    .from("barm_daily_google_orders")
    .select("quantity, price, order_date", { count: "exact" });
  if (error) return { rowCount: 0, totalUnits: 0, totalValue: 0, minDate: null, maxDate: null, error: error.message };
  const rows = (data || []) as { quantity: number | null; price: number | null; order_date: string | null }[];
  const totalUnits = rows.reduce((s, r) => s + (r.quantity || 0), 0);
  const totalValue = rows.reduce((s, r) => s + (r.quantity || 0) * (r.price || 0), 0);
  const dates = rows.map((r) => r.order_date).filter((d): d is string => !!d).sort();
  return {
    rowCount: count || 0,
    totalUnits,
    totalValue: Math.round(totalValue * 100) / 100,
    minDate: dates[0] || null,
    maxDate: dates[dates.length - 1] || null,
  };
}
