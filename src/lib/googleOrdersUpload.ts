import Papa from "papaparse";
import * as XLSX from "xlsx";
import { supabasePublic } from "@/lib/amazonReportUpload";
import { toDate as parseFlexibleDate } from "@/lib/meeshoReportUpload";
import { detectBarmOrdersLayout, fillDownBarmDates, findBarmOrdersHeader, mapBarmOfflineRows, mapBarmShopifyRows, mergeDuplicateBarmInvoices, orderDateFromFileName, type BarmOrdersLayout } from "@/lib/barmOfflineOrderRules";
import { isGoogleAdSpendSheet, parseGoogleAdSpendSheet } from "@/lib/googleAdSpendRules";

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

function sheetAoa(ws: XLSX.WorkSheet): unknown[][] {
  return XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" }) as unknown[][];
}

async function readRows(file: File): Promise<{ layout: BarmOrdersLayout | null; rows: RawRow[] }> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const wb = await readWorkbook(file);
    // The first sheet that is not a Google Ads campaign report (those go to the spend table, see
    // uploadGoogleFile) — for an orders-only workbook that is still SheetNames[0], as before.
    const ordersSheet = wb.SheetNames.find((n) => !isGoogleAdSpendSheet(sheetAoa(wb.Sheets[n])));
    if (!ordersSheet) return { layout: null, rows: [] };
    return readSheetRows(wb.Sheets[ordersSheet]);
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
  const detected = detectBarmOrdersLayout(Object.keys(rows[0] || {}));
  const layout = detected === "offline" || detected === "shopify" ? detected : "legacy";
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
    // A blank / 0 price is saved as null (never ₹0, never a guess) and flagged on the upload card.
    price: num(p("Price")) > 0 ? num(p("Price")) : null,
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
  /** Saved rows whose file gives no price (price saved as null). */
  rowsWithoutPrice: number;
  /** 1-based data-row positions (below the header) of the rows counted in rowsWithoutPrice. */
  linesWithoutPrice: number[];
  minDate: string | null;
  maxDate: string | null;
}

/** Reads and maps the file without writing anything — the upload below saves exactly these rows. */
export async function parseGoogleOrdersFile(file: File): Promise<GoogleOrdersParseResult> {
  const { layout, rows: rawRows } = await readRows(file);
  let rows: Record<string, unknown>[];
  let linesWithoutPrice: number[];
  if (layout === "shopify") {
    // Shopify's "Total sales by product" export has no date column — the day comes from the file
    // name (see mapBarmShopifyRows in barmOfflineOrderRules.ts).
    const date = orderDateFromFileName(file.name);
    if (!date) throw new Error(`Shopify "Total sales by product" file has no date — name it with the order date, e.g. "B-arm order 24_10_2026.xlsx". Nothing saved.`);
    const parsed = mapBarmShopifyRows(rawRows, date);
    rows = parsed.rows as unknown as Record<string, unknown>[];
    linesWithoutPrice = parsed.rows.filter((r) => r.price === null).map((r) => r.serial_no);
  } else if (layout === "offline") {
    const parsed = mapBarmOfflineRows(rawRows);
    rows = parsed.rows as unknown as Record<string, unknown>[];
    // The offline rules set serial_no to the row's 1-based data-row position.
    linesWithoutPrice = parsed.rows.filter((r) => r.price === null).map((r) => r.serial_no);
  } else {
    // Newer copies of this workbook drop the Invoice column (S no, Date, sku, Qty, Price) — such a
    // row is keyed "ORDER-<date>-<SKU>-<n>" (n = 1st, 2nd … line for that SKU on that date, file
    // order) like the offline layout, so re-uploading the same file updates rows in place.
    // Same SKU on two lines = 2 units (Google-only rule): a blank-Date line takes the date above it,
    // and lines sharing an Invoice are summed/re-keyed instead of overwriting each other on upsert.
    const occurrence = new Map<string, number>();
    const mapped = fillDownBarmDates(rawRows.map((raw, i) => ({ ...mapOrderRow(raw), line: i + 1 })));
    const kept = mergeDuplicateBarmInvoices(mapped.map((r) => {
      if (r.invoice || !r.order_date || !r.product_name) return r;
      const key = `${r.order_date}|${r.product_name}`;
      const n = (occurrence.get(key) || 0) + 1;
      occurrence.set(key, n);
      return { ...r, invoice: `ORDER-${r.order_date}-${r.product_name}-${n}` };
    }).filter((r) => REQUIRED_FIELDS.every((f) => r[f as keyof typeof r] !== null && r[f as keyof typeof r] !== undefined && r[f as keyof typeof r] !== "")));
    // `line` is only for the upload message — it isn't a barm_daily_google_orders column.
    rows = kept.map((r) => { const row: Record<string, unknown> = { ...r }; delete row.line; return row; });
    linesWithoutPrice = kept.filter((r) => r.price === null).map(({ line }) => line);
  }
  const dates = rows.map((r) => r.order_date as string | null).filter((d): d is string => !!d).sort();
  return {
    layout,
    totalRows: rawRows.length,
    rows,
    skippedRows: rawRows.length - rows.length,
    rowsWithoutPrice: linesWithoutPrice.length,
    linesWithoutPrice,
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
  linesWithoutPrice: number[];
  minDate: string | null;
  maxDate: string | null;
}

/** Throws (nothing saved) when the file is blank or none of its rows can be saved, so the upload
 *  card shows it as a problem instead of a green "0 rows saved". */
export async function uploadGoogleOrdersFile(file: File): Promise<GoogleOrdersUploadResult> {
  const parsed = await parseGoogleOrdersFile(file);
  const { rows, ...summary } = parsed;
  if (!parsed.layout) throw new Error("No \"S no\", \"Date / Quantity / SKU ID\" or Shopify \"Product title / Net items sold\" header row found — nothing saved. Check the file.");
  if (!parsed.totalRows) throw new Error("The file has no order rows (blank) — nothing saved.");
  if (!rows.length) throw new Error(`None of the ${parsed.totalRows} rows could be saved — each row needs a Date, a SKU and a Qty. Nothing saved.`);

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

// ── Google Ads spend ──────────────────────────────────────────────────────────
// The same Google card also takes Google Ads' "Campaign report" export (see googleAdSpendRules.ts):
// a sheet with a Campaign + Cost header is ad spend and goes to barm_daily_google_ad_spend (see
// scripts/barm_daily_google_ad_spend_table.sql); a B-Arm orders sheet goes to
// barm_daily_google_orders exactly as before. Rows are keyed on (report_start, report_end,
// campaign_name) like the Meta table, so a single-day export and a 7-day export (one file with
// both sheets, or two uploads) are both kept, and re-uploading a file updates its rows in place.
// The Ad Spend Report's Google row picks between them the same way it does for Meta.

export const GOOGLE_AD_SPEND_TABLE = "barm_daily_google_ad_spend";

export interface GoogleAdSpendSavedWindow {
  start: string;
  end: string;
  days: number;
  spend: number;
  campaigns: number;
}

export interface GoogleAdSpendUploadResult {
  savedRows: number;
  windows: GoogleAdSpendSavedWindow[];
}

export interface GoogleUploadResult {
  /** null when the file had no B-Arm orders sheet. */
  orders: GoogleOrdersUploadResult | null;
  /** null when the file had no Google Ads campaign report sheet. */
  spend: GoogleAdSpendUploadResult | null;
}

async function uploadGoogleAdSpendSheets(sheets: unknown[][][]): Promise<GoogleAdSpendUploadResult> {
  // Parse every sheet first, so a bad sheet saves nothing at all.
  const parsed = sheets.map(parseGoogleAdSpendSheet);
  for (const p of parsed) {
    if (p.accountTotal !== null && Math.abs(p.accountTotal - p.campaignTotal) > 0.01) {
      throw new Error(`Google Ads report ${p.report_start} → ${p.report_end}: campaigns add up to ₹${p.campaignTotal} but its "Total: Account" line says ₹${p.accountTotal} — nothing saved. Download the report again without filters.`);
    }
  }
  // One row per window + campaign: the same window in two sheets is the same figure copied, so the
  // later sheet replaces it (Postgres also rejects an upsert batch touching one row twice).
  const byKey = new Map<string, Record<string, unknown>>();
  const windows = new Map<string, GoogleAdSpendSavedWindow>();
  for (const p of parsed) {
    const wKey = `${p.report_start}|${p.report_end}`;
    windows.set(wKey, {
      start: p.report_start,
      end: p.report_end,
      days: Math.round((Date.parse(p.report_end) - Date.parse(p.report_start)) / 86_400_000) + 1,
      spend: p.campaignTotal,
      campaigns: p.campaigns.length,
    });
    for (const c of p.campaigns) {
      byKey.set(`${wKey}|${c.campaign_name.toLowerCase()}`, {
        report_start: p.report_start,
        report_end: p.report_end,
        campaign_name: c.campaign_name,
        spend: c.spend,
        clicks: c.clicks,
        conversions: c.conversions,
        conv_value: c.conv_value,
        currency: c.currency,
        raw: c.lines,
      });
    }
  }
  const rows = [...byKey.values()];
  if (!rows.length) throw new Error("The Google Ads report has no campaign rows — nothing saved.");
  await upsertInChunks(GOOGLE_AD_SPEND_TABLE, rows, "report_start,report_end,campaign_name");
  return {
    savedRows: rows.length,
    windows: [...windows.values()].sort((a, b) => a.end.localeCompare(b.end) || b.days - a.days),
  };
}

/** The Google card's upload: a Google Ads campaign report (spend), a B-Arm orders sheet, or a
 *  workbook with both — each sheet goes to its own table. */
export async function uploadGoogleFile(file: File): Promise<GoogleUploadResult> {
  const name = file.name.toLowerCase();
  if (!name.endsWith(".xlsx") && !name.endsWith(".xls")) return { orders: await uploadGoogleOrdersFile(file), spend: null };

  const wb = await readWorkbook(file);
  const aoas = wb.SheetNames.map((n) => sheetAoa(wb.Sheets[n]));
  const spendSheets = aoas.filter(isGoogleAdSpendSheet);
  const hasOrdersSheet = aoas.some((a) => !isGoogleAdSpendSheet(a) && findBarmOrdersHeader(a));
  if (!spendSheets.length) return { orders: await uploadGoogleOrdersFile(file), spend: null };

  const spend = await uploadGoogleAdSpendSheets(spendSheets);
  const orders = hasOrdersSheet ? await uploadGoogleOrdersFile(file) : null;
  return { orders, spend };
}

export interface GoogleAdSpendDataInfo {
  rowCount: number;
  minDate: string | null;
  maxDate: string | null;
  error?: string;
}

export async function fetchGoogleAdSpendDataInfo(): Promise<GoogleAdSpendDataInfo> {
  const [minRes, maxRes, countRes] = await Promise.all([
    supabasePublic.from(GOOGLE_AD_SPEND_TABLE).select("report_start").order("report_start", { ascending: true }).limit(1),
    supabasePublic.from(GOOGLE_AD_SPEND_TABLE).select("report_end").order("report_end", { ascending: false }).limit(1),
    supabasePublic.from(GOOGLE_AD_SPEND_TABLE).select("id", { count: "exact", head: true }),
  ]);
  const failure = minRes.error || maxRes.error || countRes.error;
  if (failure) return { rowCount: 0, minDate: null, maxDate: null, error: failure.message };
  const minDate = (minRes.data?.[0] as { report_start: string } | undefined)?.report_start ?? null;
  const maxDate = (maxRes.data?.[0] as { report_end: string } | undefined)?.report_end ?? null;
  return { rowCount: countRes.count || 0, minDate: minDate?.slice(0, 10) ?? null, maxDate: maxDate?.slice(0, 10) ?? null };
}
