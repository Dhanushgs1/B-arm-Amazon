import Papa from "papaparse";
import * as XLSX from "xlsx";
import { supabasePublic } from "@/lib/amazonReportUpload";
import { mapMeeshoReturnRow, dedupeReturnsByStage, type MeeshoReturnRow } from "@/lib/meeshoReturnRules";
import { classifyMeeshoSheet } from "@/lib/meeshoFileRules";

// Meesho counterpart of amazonReportUpload.ts / flipkartReportUpload.ts — parsed
// in the browser and written into the barm_meesho_* raw tables. The Meesho
// Upload page has ONE card (uploadMeeshoFile below): whatever Meesho file is
// dropped there is split sheet by sheet, by its headers (meeshoFileRules.ts),
// into barm_meesho_ads / barm_meesho_orders / barm_meesho_returns.
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

export const MS_REPORT_TABLE: Record<MeeshoUploadReportType, string> = {
  ads: "barm_meesho_ads",
  orders: "barm_meesho_orders",
};

// Filled from the raw workbook's Returns sheets (or a returns CSV) — see uploadMeeshoFile.
export const MS_RETURNS_TABLE = "barm_meesho_returns";

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

function isWorkbookFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith(".xlsx") || name.endsWith(".xls");
}

interface SheetPart {
  /** Sheet name, or the file name for a CSV — also where a returns stage is read from. */
  name: string;
  headers: string[];
  rows: RawRow[];
}

// Every sheet of a workbook, or the single table of a CSV.
async function readParts(file: File): Promise<SheetPart[]> {
  if (isWorkbookFile(file)) {
    const wb = await readWorkbook(file);
    return wb.SheetNames.map((name) => {
      const ws = wb.Sheets[name];
      const headerRow = (XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" })[0] || []) as unknown[];
      return { name, headers: headerRow.map((h) => str(h)), rows: readSheetRows(ws) };
    });
  }
  const parsed = await new Promise<{ data: RawRow[]; meta: { fields?: string[] } }>((resolve, reject) => {
    Papa.parse<RawRow>(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h: string) => h.trim(),
      complete: resolve,
      error: (err: Error) => reject(err),
    });
  });
  return [{ name: file.name, headers: parsed.meta.fields || [], rows: parsed.data }];
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

export type MeeshoFileKind = "ads" | "orders" | "returns";

export const MS_KIND_TABLE: Record<MeeshoFileKind, string> = {
  ads: "barm_meesho_ads",
  orders: "barm_meesho_orders",
  returns: "barm_meesho_returns",
};

export interface MeeshoFilePartSummary {
  kind: MeeshoFileKind;
  /** Sheets (or the CSV) this kind was read from, with the rows each had, e.g. { "Returns OFD": 7 }. */
  sheets: Record<string, number>;
  totalRows: number;
  savedRows: number;
  /** Repeats of a key already in the file (same Sub Order No, or same date+campaign+SKU) — merged. */
  duplicateRows: number;
  /** Rows missing a required field (e.g. no Sub Order No). */
  skippedRows: number;
  minDate: string | null;
  maxDate: string | null;
}

export interface MeeshoFileParseResult {
  /** Rows ready to upsert, per table. */
  rows: Record<MeeshoFileKind, Record<string, unknown>[]>;
  /** One entry per kind found in the file, in ads / orders / returns order. */
  parts: MeeshoFilePartSummary[];
  /** Sheets whose headers matched no Meesho export — left untouched. */
  ignoredSheets: string[];
}

/** Keeps the last row per key, in the order each key was last seen. */
function lastByKey(rows: Record<string, unknown>[], keyFields: string[]): Record<string, unknown>[] {
  const byKey = new Map<string, Record<string, unknown>>();
  rows.forEach((r) => {
    const key = keyFields.map((f) => String(r[f] ?? "")).join("\u0000");
    byKey.delete(key);
    byKey.set(key, r);
  });
  return [...byKey.values()];
}

const DATE_FIELD: Record<MeeshoFileKind, string> ={ ads: "report_date", orders: "order_date", returns: "return_created_date" };

/** Reads the file and splits it sheet by sheet (meeshoFileRules.ts) without writing anything —
 *  uploadMeeshoFile saves exactly these rows. */
export async function parseMeeshoFile(file: File): Promise<MeeshoFileParseResult> {
  const sheets: Record<MeeshoFileKind, Record<string, number>> = { ads: {}, orders: {}, returns: {} };
  const totals: Record<MeeshoFileKind, number> = { ads: 0, orders: 0, returns: 0 };
  const rows: Record<MeeshoFileKind, Record<string, unknown>[]> = { ads: [], orders: [], returns: [] };
  const returnRows: MeeshoReturnRow[] = [];
  const ignoredSheets: string[] = [];

  for (const part of await readParts(file)) {
    const found = classifyMeeshoSheet(part.name, part.headers);
    if (!found) {
      ignoredSheets.push(part.name);
      continue;
    }
    sheets[found.kind][part.name] = part.rows.length;
    totals[found.kind] += part.rows.length;
    if (found.kind === "returns") {
      part.rows.forEach((row) => {
        const r = mapMeeshoReturnRow(row, found.stage, part.name);
        if (r) returnRows.push(r);
      });
    } else {
      const required = REQUIRED_FIELDS[found.kind];
      part.rows
        .map(MAPPER[found.kind])
        .filter((r) => required.every((f) => r[f] !== null && r[f] !== undefined && r[f] !== ""))
        .forEach((r) => rows[found.kind].push(r));
    }
  }
  // A suborder on two return sheets keeps its furthest stage (and is saved once).
  rows.returns = dedupeReturnsByStage(returnRows) as unknown as Record<string, unknown>[];
  // One upsert batch must not name the same key twice (Postgres rejects the whole batch). Meesho's
  // Orders sheet can list one Sub Order No twice (seen: 318957562313365696_1 on 12 and 18 Aug in the
  // Aug 12 - Sep 10 file); the table holds it once either way, so the file's last copy is kept.
  const duplicates: Record<MeeshoFileKind, number> = { ads: 0, orders: 0, returns: 0 };
  for (const k of ["ads", "orders"] as const) {
    const before = rows[k].length;
    rows[k] = lastByKey(rows[k], ON_CONFLICT[k].split(","));
    duplicates[k] = before - rows[k].length;
  }

  const parts = (["ads", "orders", "returns"] as const)
    .filter((k) => Object.keys(sheets[k]).length)
    .map((k): MeeshoFilePartSummary => {
      const dates = rows[k].map((r) => r[DATE_FIELD[k]] as string | null).filter((x): x is string => !!x).sort();
      return {
        kind: k,
        sheets: sheets[k],
        totalRows: totals[k],
        savedRows: rows[k].length,
        duplicateRows: duplicates[k],
        skippedRows: totals[k] - rows[k].length - duplicates[k],
        minDate: dates[0] ?? null,
        maxDate: dates[dates.length - 1] ?? null,
      };
    });
  return { rows, parts, ignoredSheets };
}

const KIND_ON_CONFLICT: Record<MeeshoFileKind, string> = { ...ON_CONFLICT, returns: "sub_order_no" };

/** The Meesho Upload page's one card: any Meesho file — the raw workbook (Orders + Returns sheets),
 *  an Ads export, or a single Orders/Returns CSV — each sheet saved to its own table. */
export async function uploadMeeshoFile(file: File): Promise<Omit<MeeshoFileParseResult, "rows">> {
  const { rows, parts, ignoredSheets } = await parseMeeshoFile(file);
  if (!parts.length) {
    throw new Error(
      `Couldn't find Meesho Ads, Orders or Returns data in "${file.name}" (sheets: ${ignoredSheets.join(", ") || "none"}). Nothing was saved.`
    );
  }
  for (const p of parts) {
    if (rows[p.kind].length) await upsertInChunks(MS_KIND_TABLE[p.kind], rows[p.kind], KIND_ON_CONFLICT[p.kind]);
  }
  return { parts, ignoredSheets };
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

/** Returns on file (barm_meesho_returns), by Return Created Date — shown on the Orders card,
 *  which is where the raw workbook carrying them is uploaded. */
export async function fetchMeeshoReturnsDataInfo(): Promise<MeeshoReportDataInfo> {
  const dateCol = "return_created_date";
  const [minRes, maxRes] = await Promise.all([
    supabasePublic.from(MS_RETURNS_TABLE).select(dateCol, { count: "exact" }).not(dateCol, "is", null).order(dateCol, { ascending: true }).limit(1),
    supabasePublic.from(MS_RETURNS_TABLE).select(dateCol).not(dateCol, "is", null).order(dateCol, { ascending: false }).limit(1),
  ]);
  const failure = minRes.error || maxRes.error;
  if (failure) return { rowCount: 0, minDate: null, maxDate: null, error: failure.message };
  const minDate = (minRes.data?.[0] as unknown as Record<string, string> | undefined)?.[dateCol] ?? null;
  const maxDate = (maxRes.data?.[0] as unknown as Record<string, string> | undefined)?.[dateCol] ?? null;
  return { rowCount: minRes.count || 0, minDate: minDate ? minDate.slice(0, 10) : null, maxDate: maxDate ? maxDate.slice(0, 10) : null };
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
