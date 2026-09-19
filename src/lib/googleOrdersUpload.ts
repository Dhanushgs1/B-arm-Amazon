import Papa from "papaparse";
import * as XLSX from "xlsx";
import { supabasePublic } from "@/lib/amazonReportUpload";

// Google (direct/website) orders upload — the seller's own hand-kept "B-Arm
// Orders" workbook for direct/Google-driven sales that don't come through
// Amazon, Flipkart or Meesho at all. Unlike every other upload in this app,
// this channel has no ad campaign export of any kind (no Spend/CPC/ACOS to
// parse) and its own file carries no date column — just a flat list of order
// lines (S no, Invoice, Product, Qty, Price) for whatever period the seller
// last compiled it over. Run scripts/google_orders_table.sql once in the
// Supabase SQL Editor before the first upload — barm_daily_google_orders doesn't
// exist otherwise.
//
// Feeds the Ad Spend Report's "Google" Summary row and Ad spend report
// sheet's Google section (see fetchGoogleOrdersSummary in adSpendReportExport.ts)
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
// header, so the header row is located explicitly by its own "S no" cell
// instead of assuming it's always row 1.
function readSheetRows(ws: XLSX.WorkSheet): RawRow[] {
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" }) as unknown[][];
  const headerIdx = aoa.findIndex((row) => row.some((c) => normalizeHeaderKey(str(c)) === "s no"));
  if (headerIdx < 0) return [];
  const [headerCells, ...dataRows] = aoa.slice(headerIdx);
  const headers = headerCells.map((h) => str(h));
  return dataRows
    .filter((cells) => cells.some((c) => str(c) !== ""))
    .map((cells) => {
      const row: RawRow = {};
      headers.forEach((key, i) => { if (key) row[key] = cells[i] ?? ""; });
      return row;
    });
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

function mapOrderRow(row: RawRow) {
  const p = makePicker(row);
  return {
    serial_no: int(p("S no", "S No", "SNo")),
    invoice: str(p("Invoice")),
    product_name: str(p("Product")),
    quantity: int(p("Qty", "Quantity")),
    price: num(p("Price")),
    raw: row,
  };
}

const REQUIRED_FIELDS = ["invoice"];

async function upsertInChunks(table: string, rows: Record<string, unknown>[], onConflict: string, chunkSize = 300): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const { error } = await supabasePublic.from(table).upsert(rows.slice(i, i + chunkSize), { onConflict });
    if (error) throw new Error(`Upsert into ${table} failed: ${error.message}`);
  }
}

export interface GoogleOrdersUploadResult {
  totalRows: number;
  savedRows: number;
  skippedRows: number;
}

export async function uploadGoogleOrdersFile(file: File): Promise<GoogleOrdersUploadResult> {
  const rawRows = await readRows(file);
  const mapped = rawRows.map(mapOrderRow);
  const valid = mapped.filter((r) => REQUIRED_FIELDS.every((f) => r[f as keyof typeof r] !== null && r[f as keyof typeof r] !== undefined && r[f as keyof typeof r] !== ""));

  if (!valid.length) {
    return { totalRows: rawRows.length, savedRows: 0, skippedRows: rawRows.length };
  }

  await upsertInChunks("barm_daily_google_orders", valid, "invoice");

  return { totalRows: rawRows.length, savedRows: valid.length, skippedRows: rawRows.length - valid.length };
}

export interface GoogleOrdersDataInfo {
  rowCount: number;
  totalUnits: number;
  totalValue: number;
  error?: string;
}

// No date column on this table (see the file-level comment) — "data on file"
// is a running total across every upload so far, not a date range, same
// convention as the Price/FBA Inventory snapshot cards in amazonReportUpload.ts.
export async function fetchGoogleOrdersDataInfo(): Promise<GoogleOrdersDataInfo> {
  const { data, error, count } = await supabasePublic
    .from("barm_daily_google_orders")
    .select("quantity, price", { count: "exact" });
  if (error) return { rowCount: 0, totalUnits: 0, totalValue: 0, error: error.message };
  const rows = (data || []) as { quantity: number | null; price: number | null }[];
  const totalUnits = rows.reduce((s, r) => s + (r.quantity || 0), 0);
  const totalValue = rows.reduce((s, r) => s + (r.quantity || 0) * (r.price || 0), 0);
  return { rowCount: count || 0, totalUnits, totalValue: Math.round(totalValue * 100) / 100 };
}
