// Pure rules for the seller's "B-ARM Offline Orders" file (Date, Product, Quantity, Price per
// Product, Total Price, SKU ID) — kept dependency-free so they can be unit tested directly.
// googleOrdersUpload.ts reads the file and writes the rows these rules produce into
// barm_daily_google_orders; the older "B-Arm Orders" layout (S no, Invoice, Sku, Qty, Price) keeps
// its own unchanged mapper there.
//
// Price is taken ONLY from the file: "Price per Product", else "Total Price" ÷ Quantity. A row with
// neither is saved with price null — never a price borrowed from Amazon or any other channel, and
// never a guess — so its Sales shows as blank/0 until a priced file is uploaded.
//
// The file carries no invoice number, so each row is keyed "OFFLINE-<date>-<SKU>-<n>", n being the
// 1st, 2nd … line for that SKU on that date in file order. Uploading the same file again (for
// example after filling in prices) produces the same keys and updates those rows in place.

import { meeshoDate } from "./meeshoReturnRules.ts";

type RawRow = Record<string, unknown>;

export type BarmOrdersLayout = "legacy" | "offline";

function norm(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Which layout a header row belongs to, or null. The legacy workbook is recognised exactly as it
 *  always was — by an "S no" cell — and is checked first so its behaviour never changes. A header
 *  with an Invoice column is never read as the offline layout: invoices are the legacy key. */
export function detectBarmOrdersLayout(headers: unknown[]): BarmOrdersLayout | null {
  const h = new Set(headers.map(norm));
  if (h.has("s no")) return "legacy";
  if (h.has("sku id") && h.has("date") && h.has("quantity") && !h.has("invoice")) return "offline";
  return null;
}

/** The header row of a sheet (as an array of arrays). The legacy "S no" row is searched for first,
 *  over the whole sheet, exactly as the legacy reader always did; only a sheet without one is
 *  checked for the offline header. */
export function findBarmOrdersHeader(aoa: unknown[][]): { layout: BarmOrdersLayout; index: number } | null {
  for (const layout of ["legacy", "offline"] as const) {
    const index = aoa.findIndex((row) => detectBarmOrdersLayout(row || []) === layout);
    if (index >= 0) return { layout, index };
  }
  return null;
}

function pick(row: RawRow, name: string): unknown {
  const key = Object.keys(row).find((k) => norm(k) === name);
  return key === undefined ? "" : row[key];
}

function numOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v ?? "").replace(/[^0-9.eE+-]/g, "");
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/** Per-unit price from the file's own columns, or null when the file gives none. */
export function offlineRowPrice(row: RawRow, quantity: number): number | null {
  const perUnit = numOrNull(pick(row, "price per product"));
  if (perUnit !== null && perUnit > 0) return Math.round(perUnit * 100) / 100;
  const total = numOrNull(pick(row, "total price"));
  if (total !== null && total > 0 && quantity > 0) return Math.round((total / quantity) * 100) / 100;
  return null;
}

export interface BarmOfflineOrderRow {
  serial_no: number;
  order_date: string;
  invoice: string;
  /** The SKU code — this table's product_name has always held the SKU (the Ad Spend Report reads it). */
  product_name: string;
  quantity: number;
  price: number | null;
  raw: RawRow;
}

export type BarmOfflineSkipReason = "no date" | "no SKU" | "no quantity";

export interface BarmOfflineParseResult {
  rows: BarmOfflineOrderRow[];
  skipped: { line: number; reason: BarmOfflineSkipReason }[];
  rowsWithoutPrice: number;
}

/** Map the offline layout's data rows (header -> value objects, file order). `line` numbers in
 *  `skipped` are 1-based data-row positions, for the upload message. */
export function mapBarmOfflineRows(rows: RawRow[]): BarmOfflineParseResult {
  const occurrence = new Map<string, number>();
  const out: BarmOfflineOrderRow[] = [];
  const skipped: BarmOfflineParseResult["skipped"] = [];
  let rowsWithoutPrice = 0;

  rows.forEach((row, i) => {
    // Blank spreadsheet lines are not data rows at all.
    if (Object.values(row).every((v) => String(v ?? "").trim() === "")) return;
    const date = meeshoDate(pick(row, "date"));
    const sku = String(pick(row, "sku id") ?? "").trim();
    const quantity = Math.round(numOrNull(pick(row, "quantity")) ?? 0);
    if (!date) return void skipped.push({ line: i + 1, reason: "no date" });
    if (!sku) return void skipped.push({ line: i + 1, reason: "no SKU" });
    if (quantity <= 0) return void skipped.push({ line: i + 1, reason: "no quantity" });

    const key = `${date}|${sku}`;
    const n = (occurrence.get(key) || 0) + 1;
    occurrence.set(key, n);
    const price = offlineRowPrice(row, quantity);
    if (price === null) rowsWithoutPrice++;
    out.push({
      serial_no: i + 1,
      order_date: date,
      invoice: `OFFLINE-${date}-${sku}-${n}`,
      product_name: sku,
      quantity,
      price,
      raw: row,
    });
  });

  return { rows: out, skipped, rowsWithoutPrice };
}
