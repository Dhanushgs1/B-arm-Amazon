/**
 * Pure parsing/classification rules for the FBA Forecast Report upload
 * pipeline — no Supabase, no XLSX/Papaparse imports, no `@/lib/...` aliases
 * — so these can be unit tested directly with plain `node --test` on a
 * relative path (see fbaForecastRules.test.ts), the same convention as
 * mergeByConflictKey.ts. The I/O-heavy upload functions in
 * fbaForecastUpload.ts import this module; they must never duplicate this
 * logic inline.
 */

export type StatusCategory = "booked" | "picked_up" | "active";

/**
 * Classifies the FBA & FBF Details workbook's FIRST "STATUS" column value
 * (case/whitespace-insensitive, exact match on "booked" / "picked up" /
 * "active"). Anything else — "cancelled before 24hrs of pickup", "Didn't
 * send to FBA", blank, etc. — is excluded from every downstream table:
 * return null, never guess.
 */
export function classifyStatus(rawStatus: string): StatusCategory | null {
  switch (rawStatus.trim().toLowerCase()) {
    case "booked":
      return "booked";
    case "picked up":
      return "picked_up";
    case "active":
      return "active";
    default:
      return null;
  }
}

// Both the long and short spellings the real workbook is known to use are
// supported (the brief's own examples: JUNE not JUN, JULY not JUL, SEPT not
// SEP, APRIL not APR are the real variants seen — but the short forms are
// kept too, defensively, since a sheet name typo/older convention could use
// either).
const MONTH_ALIASES: Record<string, number> = {
  JAN: 1,
  JANUARY: 1,
  FEB: 2,
  FEBRUARY: 2,
  MAR: 3,
  MARCH: 3,
  APR: 4,
  APRIL: 4,
  MAY: 5,
  JUN: 6,
  JUNE: 6,
  JUL: 7,
  JULY: 7,
  AUG: 8,
  AUGUST: 8,
  SEP: 9,
  SEPT: 9,
  SEPTEMBER: 9,
  OCT: 10,
  OCTOBER: 10,
  NOV: 11,
  NOVEMBER: 11,
  DEC: 12,
  DECEMBER: 12,
};

/**
 * Parses a "FBA <MONTHNAME><YY>" sheet name (e.g. "FBA SEPT26", "FBA
 * JUL26") into a comparable (year, month). Sheets with no 2-digit year
 * suffix, or an unrecognized month token, can't be reliably dated and
 * return null rather than being guessed at.
 */
export function parseMonthSheetName(name: string): { year: number; month: number } | null {
  const m = name.trim().toUpperCase().match(/^FBA\s+([A-Z]+)(\d{2})$/);
  if (!m) return null;
  const month = MONTH_ALIASES[m[1]];
  if (!month) return null;
  return { year: 2000 + parseInt(m[2], 10), month };
}

export interface MonthSheet {
  sheetName: string;
  sourceMonth: string; // 'YYYY-MM'
  year: number;
  month: number;
}

/**
 * Picks the current calendar month's sheet plus the previous 2 (by name),
 * per the confirmed rule that Active records from all 3 sheets are always
 * included together in one upload. `asOf` defaults to real "today" in
 * production and is passed explicitly in tests. Sheets dated after `asOf`
 * (shouldn't normally occur, but a workbook could contain a stray
 * future-dated sheet) are excluded.
 */
export function detectMonthSheets(sheetNames: string[], asOf: Date = new Date()): MonthSheet[] {
  const parsed = sheetNames
    .map((sheetName) => ({ sheetName, parsed: parseMonthSheetName(sheetName) }))
    .filter((s): s is { sheetName: string; parsed: { year: number; month: number } } => s.parsed !== null);

  const currentKey = asOf.getUTCFullYear() * 12 + (asOf.getUTCMonth() + 1);
  return parsed
    .map((s) => ({ ...s, key: s.parsed.year * 12 + s.parsed.month }))
    .filter((s) => s.key <= currentKey)
    .sort((a, b) => b.key - a.key)
    .slice(0, 3)
    .map((s) => ({
      sheetName: s.sheetName,
      sourceMonth: `${s.parsed.year}-${String(s.parsed.month).padStart(2, "0")}`,
      year: s.parsed.year,
      month: s.parsed.month,
    }));
}

export interface FbfRawRow {
  product: string;
  sku: string;
  quantity: number;
  fc: string;
  /** ISO 'YYYY-MM-DD', or '' if the cell was blank/unparseable. */
  bookedDate: string;
  /** ISO 'YYYY-MM-DD', or '' if the cell was blank/unparseable. */
  pickupDate: string;
  statusRaw: string;
  /** ISO 'YYYY-MM-DD' from the second STATUS column (the date an Active
   *  shipment went active), or '' if blank/not a date. */
  activeDate: string;
}

// Excel's date epoch is 1899-12-30 (day 0), with a well-known off-by-one
// leap-year bug baked into the serial numbering that every spreadsheet tool
// reproduces identically — this is the standard conversion, not a guess.
function excelSerialToIso(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Normalizes a raw grid cell (string, Excel serial number, or blank) from
 * the "Booked date" / "Pickup Date" columns into an ISO 'YYYY-MM-DD', or ''
 * if blank/unparseable. Text dates are read as DD/MM/YYYY (or DD-MM-YYYY),
 * matching this Indian workbook's convention — not US MM/DD/YYYY.
 */
function normalizeSheetDate(raw: unknown): string {
  if (raw === null || raw === undefined || raw === "") return "";
  if (typeof raw === "number" && Number.isFinite(raw)) return excelSerialToIso(raw);
  const s = String(raw).trim();
  if (!s) return "";
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) {
    // Day-first (DD/MM/YYYY or DD.MM.YYYY) — this workbook's own convention
    // for Booked date/Pickup Date/Active date (confirmed real examples:
    // "05.08.2026", "22.09.2026"). The dot-separated form was previously
    // unhandled entirely (fell through to "") — since these dates are part
    // of fbfIdentityKey, every row's booked/pickup date silently collapsed
    // to the same empty string, so rows that only matched on
    // sku+fc+quantity were wrongly deduped away even when their real
    // booked/pickup dates differed (confirmed: 28 Active rows and 1
    // Intransit row incorrectly collapsed this way).
    const day = m[1].padStart(2, "0");
    const month = m[2].padStart(2, "0");
    return `${m[3]}-${month}-${day}`;
  }
  return "";
}

const FBF_REQUIRED_COLUMNS = ["Product", "SKU ID", "Final shipped quantity", "FC", "Booked date", "Pickup Date", "STATUS"];

/**
 * Maps a "FBA & FBF Details-Updated" month sheet's raw grid (row 0 =
 * headers, as produced by `XLSX.utils.sheet_to_json(ws, { header: 1 })`)
 * into rows, locating every column BY HEADER NAME rather than a fixed
 * letter — an "ATS/NON-ATS" column shifts every later column by one
 * position on some sheets, so a fixed-letter read silently misreads data on
 * those sheets. `headers.indexOf("STATUS")` deliberately finds only the
 * FIRST "STATUS" column — every month sheet also has a second, later
 * column literally named "STATUS" that must never be read as the actual
 * status. On Active rows that second column holds the date the shipment
 * went active (e.g. "08.09.2026", confirmed against the seller's manual
 * recently _act sheet), read here as `activeDate`; anything that isn't a
 * date there comes through as ''.
 */
export function parseMonthSheetGrid(grid: unknown[][]): FbfRawRow[] {
  if (grid.length === 0) return [];
  const headers = (grid[0] as unknown[]).map((h) => String(h ?? "").trim());
  const col = (name: string) => headers.indexOf(name);

  const productCol = col("Product");
  const skuCol = col("SKU ID");
  const qtyCol = col("Final shipped quantity");
  const fcCol = col("FC");
  const bookedCol = col("Booked date");
  const pickupCol = col("Pickup Date");
  const statusCol = col("STATUS");
  const secondStatusCol = headers.lastIndexOf("STATUS");
  const activeDateCol = secondStatusCol > statusCol ? secondStatusCol : -1;

  const indices = [productCol, skuCol, qtyCol, fcCol, bookedCol, pickupCol, statusCol];
  if (indices.some((i) => i === -1)) {
    const missing = FBF_REQUIRED_COLUMNS.filter((_, i) => indices[i] === -1);
    throw new Error(`Sheet is missing required column(s): ${missing.join(", ")}`);
  }

  return grid
    .slice(1)
    .filter((row) => row.length > 0 && String(row[skuCol] ?? "").trim() !== "")
    .map((row) => ({
      product: String(row[productCol] ?? "").trim(),
      sku: String(row[skuCol] ?? "").trim(),
      quantity: Number(row[qtyCol]) || 0,
      fc: String(row[fcCol] ?? "").trim(),
      bookedDate: normalizeSheetDate(row[bookedCol]),
      pickupDate: normalizeSheetDate(row[pickupCol]),
      statusRaw: String(row[statusCol] ?? "").trim(),
      activeDate: activeDateCol === -1 ? "" : normalizeSheetDate(row[activeDateCol]),
    }));
}

/**
 * Generic de-duplication by an arbitrary identity key — keeps the FIRST row
 * seen for each key, drops later rows whose key matches. Order-preserving.
 */
export function dedupeByIdentityKey<T>(rows: T[], keyOf: (r: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const key = keyOf(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/**
 * The identity key for de-duplicating booked/intransit/active rows across
 * the 3 combined month sheets of one FBA & FBF Details upload: `(sku, fc,
 * quantity, booked_date, pickup_date)`. The FBA team's process re-lists an
 * unresolved shipment in the next month's sheet unchanged, so naively
 * inserting every row from all 3 sheets risks counting the same physical
 * shipment 2-3 times — this key collapses those re-listed duplicates.
 *
 * Known, accepted limitation: booked_date/pickup_date are frequently blank
 * in the source workbook, so two genuinely DISTINCT shipments that happen
 * to share sku+fc+quantity with both dates blank would incorrectly
 * collapse into one row. This is an accepted tradeoff of the available
 * source columns (there is no better natural key in the data) — per
 * explicit instruction not to invent a key from data that isn't there.
 */
export function fbfIdentityKey(r: { sku: string; fc: string; quantity: number; bookedDate: string; pickupDate: string }): string {
  return [r.sku.trim().toUpperCase(), r.fc.trim().toUpperCase(), String(r.quantity), r.bookedDate || "", r.pickupDate || ""].join("|");
}

export interface CleanResult<Reason extends string> {
  keep: boolean;
  reason?: Reason;
}

export interface DailySalesRawRow {
  amazonOrderId: string;
  /** ISO 'YYYY-MM-DD'. */
  purchaseDate: string;
  orderStatus: string;
  fulfillmentChannel: string;
}

export type DailySalesRejectReason = "s_prefix_order" | "today_order" | "outside_window" | "cancelled" | "merchant";

/**
 * True if `dateIso` falls within the trailing `days`-day window ending at
 * (and including) `reportDate`: `[reportDate - (days-1), reportDate]`. Both
 * dates must be ISO 'YYYY-MM-DD' — used to enforce a genuine trailing
 * 30-day sales window anchored on the dashboard's selected date, rather
 * than trusting whatever date range the uploaded file happens to contain.
 */
export function isWithinTrailingWindow(dateIso: string, reportDate: string, days: number): boolean {
  if (!dateIso || !reportDate) return false;
  const d = new Date(`${dateIso}T00:00:00Z`).getTime();
  const end = new Date(`${reportDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(d) || !Number.isFinite(end)) return false;
  const start = end - (days - 1) * 86400000;
  return d >= start && d <= end;
}

/**
 * The 30-day sales cleaning rules (Amazon "All Orders" export), applied in
 * this order: drop an `amazon-order-id` starting with "S"; drop rows dated
 * exactly `reportDate` (the SOP's "drop today's rows" rule, anchored on the
 * dashboard's selected date rather than the server's real today); drop
 * rows outside the trailing 30-day window ending at `reportDate`; drop
 * `order-status === 'Cancelled'` (case-sensitive, exactly as specified);
 * drop `fulfillment-channel === 'Merchant'`. `reportDate` must be the
 * dashboard's own selected date (ISO 'YYYY-MM-DD') — never the real
 * server-clock "today". Returns which rule rejected the row (if any) so
 * the caller can tally an audit breakdown.
 */
export function cleanDailySalesRow(row: DailySalesRawRow, reportDate: string): CleanResult<DailySalesRejectReason> {
  if (row.amazonOrderId.startsWith("S")) return { keep: false, reason: "s_prefix_order" };
  if (row.purchaseDate === reportDate) return { keep: false, reason: "today_order" };
  if (!isWithinTrailingWindow(row.purchaseDate, reportDate, 30)) return { keep: false, reason: "outside_window" };
  if (row.orderStatus === "Cancelled") return { keep: false, reason: "cancelled" };
  if (row.fulfillmentChannel === "Merchant") return { keep: false, reason: "merchant" };
  return { keep: true };
}

export interface StockSnapshotRawRow {
  /** ISO 'YYYY-MM-DD'. */
  reportDate: string;
  fulfillmentCenter: string;
  disposition: string;
}

export type StockSnapshotRejectReason = "older_stock_date" | "vsnc" | "non_sellable";

/**
 * The FBA stock cleaning rules (Custom Report Builder export), applied in
 * this order: keep only the report's selected anchor date (see
 * `selectStockSnapshotDate` — the latest date on file that is `<=` the
 * dashboard's selected report date, NOT blindly the max date in the file);
 * drop `Fulfillment Center === 'VSNC'`; keep only `Disposition ===
 * 'SELLABLE'`. Returns which rule rejected the row (if any) for the audit
 * breakdown.
 */
export function cleanStockSnapshotRow(row: StockSnapshotRawRow, anchorDate: string): CleanResult<StockSnapshotRejectReason> {
  if (row.reportDate !== anchorDate) return { keep: false, reason: "older_stock_date" };
  if (row.fulfillmentCenter === "VSNC") return { keep: false, reason: "vsnc" };
  if (row.disposition !== "SELLABLE") return { keep: false, reason: "non_sellable" };
  return { keep: true };
}

/**
 * Picks the FBA stock snapshot's "anchor date" out of every date present in
 * the uploaded file: the LATEST date that is `<=` the dashboard's selected
 * `reportDate` — never blindly the max date in the file, which could be
 * later than the report the user intends to generate (e.g. a stock file
 * that happens to include a date after the selected report date). Returns
 * '' if no eligible date exists.
 */
export function selectStockSnapshotDate(dates: string[], reportDate: string): string {
  const eligible = dates.filter((d) => !!d && d <= reportDate).sort();
  return eligible[eligible.length - 1] || "";
}

/**
 * Parses a US-style `MM/DD/YYYY` date (the FBA stock report's "Date"
 * column format, per Amazon's Custom Report Builder export) into ISO
 * 'YYYY-MM-DD'. Deliberately separate from `normalizeSheetDate` above,
 * which reads the FBA & FBF Details workbook's Booked/Pickup date columns
 * as DD/MM/YYYY (Indian convention) — these are two different source
 * files with two different date conventions, not the same format twice.
 * Returns '' if blank/unparseable.
 */
export function parseUsSlashDate(raw: string): string {
  if (!raw) return "";
  const s = raw.trim();
  if (!s) return "";
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) {
    const month = m[1].padStart(2, "0");
    const day = m[2].padStart(2, "0");
    return `${m[3]}-${month}-${day}`;
  }
  return "";
}

// ── Manual plan (the seller's own "FBA_forecast sheet(30 days)" workbook) ─

export interface ManualPlanRow {
  sku: string;
  zone: string;
  /** Column X "Stock present per SKU ID for FBA - booked"; null when blank
   *  or not a number (e.g. a typed "-"). */
  stock_to_send: number | null;
  /** 0-based position among the kept rows — the manual's own row order. */
  row_order: number;
}

/**
 * Reads the manual "FBA analysis" sheet's grid (row 0 = headers) into its
 * typed-in SKU × zone list plus column X, located BY HEADER: "skuid",
 * "zone" and the header starting "Stock present per SKU ID for FBA".
 * Rows with no zone typed (SKUs added to the bottom of the list without
 * their 14 zone rows) are skipped and counted, since they can't match any
 * zone's data.
 */
export function parseManualPlanGrid(grid: unknown[][]): { rows: ManualPlanRow[]; skippedNoZone: number } {
  const headers = ((grid[0] || []) as unknown[]).map((h) => String(h ?? "").trim());
  const skuCol = headers.indexOf("skuid");
  const zoneCol = headers.indexOf("zone");
  const xCol = headers.findIndex((h) => h.toLowerCase().startsWith("stock present per sku id for fba"));
  const missing = [skuCol === -1 && "skuid", zoneCol === -1 && "zone", xCol === -1 && "Stock present per SKU ID for FBA - booked"].filter(Boolean);
  if (missing.length) {
    throw new Error(`This doesn't look like the manual FBA analysis sheet — missing column(s): ${missing.join(", ")}.`);
  }

  const rows: ManualPlanRow[] = [];
  let skippedNoZone = 0;
  for (const row of grid.slice(1)) {
    const sku = String(row[skuCol] ?? "").trim();
    if (!sku) continue;
    const zone = String(row[zoneCol] ?? "").trim();
    if (!zone) { skippedNoZone++; continue; }
    const rawX = row[xCol];
    const x = typeof rawX === "number" ? rawX : String(rawX ?? "").trim() === "" ? NaN : Number(String(rawX).trim());
    rows.push({ sku, zone, stock_to_send: Number.isFinite(x) ? x : null, row_order: rows.length });
  }
  return { rows, skippedNoZone };
}
