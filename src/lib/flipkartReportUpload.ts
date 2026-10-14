import Papa from "papaparse";
import * as XLSX from "xlsx";
import { supabasePublic, pruneOutsideRange } from "@/lib/amazonReportUpload";
import { mergeByConflictKey } from "@/lib/mergeByConflictKey";

// Flipkart counterpart of src/lib/amazonReportUpload.ts — same shape (one card
// per seller-downloaded export, parsed in the browser and written into a
// barm_flipkart_* raw table), with two differences that come from Flipkart's
// own exports rather than from any design choice here:
//
// 1. Three of the four reports are .xlsx, not .csv, so parsing goes through
//    SheetJS instead of Papa. Flipkart's writer emits a LYING <dimension> tag
//    ("A1:AM1" on a 5,200-row sheet), so the used range is recomputed from the
//    actual cells before reading — see readSheetRows.
// 2. The FSN (ad) report carries no per-row date at all. Its first two lines
//    are a "Start Time"/"End Time" preamble for the single day it covers, and
//    that is where report_date comes from.
//
// Re-uploading an overlapping period converges to the new data rather than
// duplicating it, using the same three strategies as the Amazon uploader:
// per-row upsert on a clean natural key (FSN), or replace-whatever-date-range-
// this-file-covers (the other three, whose rows have no reliable unique key).

export type FlipkartUploadReportType =
  | "fsn_report"
  | "order_report"
  | "earn_more"
  | "returns"
  | "listings";

// Labels are deliberately the seller's own names for these downloads (the ones
// they use when sharing the files), not Flipkart's console menu wording.
export const FK_REPORT_LABEL: Record<FlipkartUploadReportType, string> = {
  fsn_report: "Flipkart FSN report",
  order_report: "Flipkart order report",
  earn_more: "Flipkart earn more report",
  returns: "Flipkart returns report",
  listings: "Flipkart listings (price/stock)",
};

export const FK_REPORT_HINT: Record<FlipkartUploadReportType, string> = {
  fsn_report:
    "Ads › Reports › FSN report — one CSV per day (its Start Time line sets the date), or a multi-day XLSX with a 'Spend' sheet (Date column per row).",
  order_report: "Orders › Download orders — order-item level XLSX.",
  earn_more: "Growth › Earn more — per-day, per-SKU sales XLSX.",
  returns:
    "Returns › Returns report — one row per return, richer than the order report's status (tracks in-transit/completed returns the order report can still show as pending).",
  listings:
    "Listings › Manage Listings export — current Price/MRP/Stock/Status snapshot. Each upload fully replaces the previous one (it's a current-moment snapshot, not date-scoped).",
};

export const FK_REPORT_ACCEPT: Record<FlipkartUploadReportType, string> = {
  fsn_report: ".csv,.xlsx,.xls",
  order_report: ".csv,.xlsx,.xls",
  earn_more: ".xlsx,.xls",
  returns: ".csv,.xlsx,.xls",
  listings: ".xls,.xlsx",
};

export const FK_REPORT_TABLE: Record<FlipkartUploadReportType, string> = {
  fsn_report: "barm_flipkart_fsn_report",
  order_report: "barm_flipkart_order_report",
  earn_more: "barm_flipkart_earn_more",
  returns: "barm_flipkart_returns",
  listings: "barm_flipkart_listings",
};

// The date column each report's "data on file" caption is scoped by. Listings
// has no date column at all — see FULL_REPLACE_TYPES below — so it's absent
// here, same as Amazon's price_listing/fba_inventory in amazonReportUpload.ts.
export const FK_DATE_COLUMN: Partial<Record<FlipkartUploadReportType, string>> = {
  fsn_report: "report_date",
  order_report: "order_date",
  earn_more: "order_date",
  returns: "return_requested_date",
};

// Current-moment catalog snapshot, no date column — each upload represents
// "the current state", so re-uploading truncates and replaces the whole table
// (a delisted SKU shouldn't linger as a stale row forever). Mirrors Amazon's
// FULL_REPLACE_TYPES in amazonReportUpload.ts.
const FULL_REPLACE_TYPES: Partial<Record<FlipkartUploadReportType, true>> = {
  listings: true,
};

// Same idea as PRUNE_TO_UPLOAD_RANGE in amazonReportUpload.ts: these two
// tables should only ever hold the date range the seller's latest export
// covers, so anything outside a fresh upload's min/max date is stale and gets
// deleted rather than kept as accumulating history.
const PRUNE_TO_UPLOAD_RANGE: Partial<Record<FlipkartUploadReportType, true>> = {
  fsn_report: true,
  order_report: true,
};

// ── value parsing ───────────────────────────────────────────────────────────

type RawRow = Record<string, unknown>;

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

// Flipkart wraps some text columns in tripled quotes ("""SKU:B-ARM-1""") and
// prefixes ids with a type tag ("OI:", "OD:", "R:", "DTr:", "SKU:") — both are
// artefacts of their CSV-to-XLSX writer, not part of the value.
function clean(v: unknown): string {
  let s = str(v).replace(/^"+|"+$/g, "").trim();
  const tag = /^(SKU|OI|OD|R|DTr|FSN):/i.exec(s);
  if (tag) s = s.slice(tag[0].length).trim();
  return s;
}

function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = str(v).replace(/[^0-9.eE+-]/g, "");
  if (!s || s === "NA") return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

const MONTH_ABBR: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

// Flipkart dates arrive as "2026-07-01", "2026-07-01 07:29:36", an Excel serial
// number when the cell was typed as a date, or (the Returns report CSV) as
// "02-Aug-26". "NA"/"" mean absent.
function toDate(v: unknown): string | null {
  if (typeof v === "number" && v > 0) {
    const d = XLSX.SSF.parse_date_code(v);
    if (!d) return null;
    return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  }
  const s = str(v);
  if (!s || s.toUpperCase() === "NA") return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return iso[0];
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(s);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  const dMonY = /^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/.exec(s);
  if (dMonY) {
    const mon = MONTH_ABBR[dMonY[2].toLowerCase()];
    if (mon) return `20${dMonY[3]}-${mon}-${dMonY[1].padStart(2, "0")}`;
  }
  return null;
}

/** Collapses whitespace/newlines and lowercases, so two header cells that
 *  read the same to a human (one wrapped onto two lines, one with a trailing
 *  space) are treated as the same column everywhere in this file. */
function normalizeHeaderKey(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

// ── file readers ────────────────────────────────────────────────────────────

/**
 * Read one sheet as objects.
 *
 * `headerRow` is the 0-based row the column names live on — some Flipkart
 * exports put a merged "group" caption row above the real header, needing
 * headerRow=1 instead of the default 0.
 *
 * The used range is recomputed from the sheet's own cells because Flipkart's
 * exporter writes a `<dimension ref="A1:AM1"/>` that describes only the header
 * row even when 5,200 data rows follow — trusting it silently yields zero rows.
 *
 * Rows are hand-built from the header array rather than via
 * `sheet_to_json`'s object mode so that a duplicated header keeps its FIRST
 * occurrence rather than its last. SheetJS itself already renames exact
 * byte-for-byte duplicate headers (appending "_1", "_2", ...), but every
 * lookup in this file goes through `makePicker`, which re-normalizes keys by
 * collapsing whitespace/newlines and lowercasing — so two headers that are
 * only equal *after* that normalization (e.g. one wrapped onto two lines)
 * still collide there, last-column-wins. The seller's combined workbooks
 * append a PivotTable summary to the right of the real table (separated by a
 * gap of blank-header columns) that reuses the real header's text (e.g.
 * "Date" again on Spend, "Return Requested Date" again on Returns); dedup'ing
 * with the same normalization makePicker uses guarantees the surviving key is
 * the real column's, however the two headers happen to differ at the byte
 * level.
 */
function readSheetRows(ws: XLSX.WorkSheet, headerRow = 0): RawRow[] {
  const addrs = Object.keys(ws).filter((k) => k[0] !== "!");
  if (!addrs.length) return [];
  const range = { s: { r: Infinity, c: Infinity }, e: { r: 0, c: 0 } };
  addrs.forEach((a) => {
    const { r, c } = XLSX.utils.decode_cell(a);
    range.s.r = Math.min(range.s.r, r);
    range.s.c = Math.min(range.s.c, c);
    range.e.r = Math.max(range.e.r, r);
    range.e.c = Math.max(range.e.c, c);
  });
  ws["!ref"] = XLSX.utils.encode_range(range);

  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    range: headerRow,
    defval: "",
  }) as unknown[][];
  const [headerCells, ...dataRows] = aoa;
  if (!headerCells) return [];

  const seen = new Set<string>();
  const headers = headerCells.map((h) => {
    const key = str(h);
    if (!key || seen.has(normalizeHeaderKey(key))) return null;
    seen.add(normalizeHeaderKey(key));
    return key;
  });

  return dataRows.map((cells) => {
    const row: RawRow = {};
    headers.forEach((key, i) => {
      if (key === null) return;
      row[key] = cells[i] ?? "";
    });
    return row;
  });
}

/**
 * Index of the row that actually holds the column names.
 *
 * Some Flipkart exports put a preamble above the header — the FSN "Spend" sheet
 * leads with `Start Time` / `End Time` rows describing the window, exactly like
 * its CSV sibling does. Reading from row 0 there names the columns "Start Time"
 * and a timestamp, so every real column lookup misses and every row is dropped
 * as undated: the upload reports "0 rows saved, N skipped" while the file is
 * perfectly good. Locating the header by one of its own column names handles
 * both layouts without hardcoding how tall the preamble is.
 *
 * Returns 0 when no probe matches, so a sheet whose header genuinely is the
 * first row behaves exactly as before.
 */
function findHeaderRow(ws: XLSX.WorkSheet, probes: string[], maxScan = 12): number {
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" }) as unknown[][];
  const want = probes.map((p) => normalizeHeaderKey(p));
  for (let r = 0; r < Math.min(maxScan, aoa.length); r++) {
    const cells = (aoa[r] || []).map((c) => normalizeHeaderKey(str(c)));
    if (want.some((w) => cells.includes(w))) return r;
  }
  return 0;
}

async function readWorkbook(file: File): Promise<XLSX.WorkBook> {
  const buf = await file.arrayBuffer();
  return XLSX.read(buf, { type: "array" });
}

/**
 * Picks a sheet by name, case/space-insensitively, with an index fallback.
 *
 * Falls back to a PREFIX match before the index, because the seller also
 * uploads a single hand-assembled workbook holding every export as one sheet
 * each, and those tabs carry descriptive names rather than Flipkart's own
 * ("Listing and Price ", not "listing"). Without the prefix step that workbook
 * silently resolved to sheet 0 — the seller's own summary tab — which parses to
 * zero rows and reads as "nothing in the file" rather than "wrong sheet".
 */
function pickSheet(wb: XLSX.WorkBook, wanted: string, fallbackIndex = 0): XLSX.WorkSheet {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const target = norm(wanted);
  const name =
    wb.SheetNames.find((n) => norm(n) === target) ||
    wb.SheetNames.find((n) => norm(n).startsWith(target)) ||
    wb.SheetNames[fallbackIndex];
  const ws = wb.Sheets[name];
  if (!ws) throw new Error(`Sheet "${wanted}" not found — this file has: ${wb.SheetNames.join(", ")}`);
  return ws;
}

/** Header lookup tolerant of Flipkart's trailing spaces and embedded newlines. */
function makePicker(row: RawRow) {
  const keys = Object.keys(row);
  const normalized = new Map<string, string>();
  keys.forEach((k) => normalized.set(normalizeHeaderKey(k), k));
  return (...candidates: (string | RegExp)[]): unknown => {
    for (const cand of candidates) {
      if (typeof cand === "string") {
        const hit = normalized.get(normalizeHeaderKey(cand));
        if (hit !== undefined) return row[hit];
      } else {
        const hit = keys.find((k) => cand.test(k.replace(/\s+/g, " ").trim()));
        if (hit !== undefined) return row[hit];
      }
    }
    return "";
  };
}

// ── per-report parsers ──────────────────────────────────────────────────────

export interface ParsedUpload {
  rows: Record<string, unknown>[];
  totalRows: number;
  /** Date range the file covers, on that report's own date column. */
  minDate: string | null;
  maxDate: string | null;
  /**
   * Rows that carried real ad spend but were dropped before ever reaching
   * `rows` — usually because their "Date" cell didn't parse (see `toDate`).
   * Distinct from ordinary skipped rows (blank spacer rows, zero-spend rows
   * with no campaign/SKU) which are expected and not worth surfacing.
   */
  droppedWithSpend?: { count: number; totalSpend: number };
}

/** Dispatches on file extension: the seller's native per-day CSV export, or a
 *  hand-assembled multi-day XLSX (see parseFsnReportXlsx) used for backfilling
 *  a historical range in one upload. */
async function parseFsnReport(file: File): Promise<ParsedUpload> {
  const name = file.name.toLowerCase();
  return name.endsWith(".xlsx") || name.endsWith(".xls")
    ? parseFsnReportXlsx(file)
    : parseFsnReportCsv(file);
}

/** Parses one CSV line into its cells, quote-aware (a plain split(",") would
 *  break on a quoted header cell containing a comma). */
function csvHeaderCells(line: string): string[] {
  // Cast: same Papa overload-resolution quirk noted below on the full-file
  // parse — a plain string input still resolves to the async signature.
  const result = Papa.parse<string[]>(line) as unknown as { data: string[][] };
  return (result.data[0] || []).map((c) => normalizeHeaderKey(c));
}

/**
 * FSN (ad performance) CSV — two layouts seen from the seller:
 *
 * Single-day (Flipkart's own per-day download):
 *   Start Time, 2026-07-30 00:00:00
 *   End Time, 2026-07-30 23:59:59
 *   Campaign ID,Campaign Name,AdGroup ID,...
 *   <data, no per-row date>
 * The whole file is one calendar day, taken from the Start Time line.
 *
 * Multi-day (a backfill export covering a date range, same shape as the
 * "Spend" sheet parseFsnReportXlsx reads — see there):
 *   Date,Campaign ID,Campaign Name,AdGroup ID,...
 *   <data, dated per row by its own "Date" cell>
 * Distinguished by the header row itself carrying a "Date" column — if it
 * doesn't, this is the single-day layout and the "Start Time" preamble is the
 * only place a date exists, so a file uploaded without it is rejected rather
 * than silently dated today.
 */
async function parseFsnReportCsv(file: File): Promise<ParsedUpload> {
  const text = await file.text();
  const lines = text.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => csvHeaderCells(l).includes("campaign id"));
  if (headerIdx < 0) {
    throw new Error("Not an FSN report — no 'Campaign ID' header row found.");
  }
  const hasDateColumn = csvHeaderCells(lines[headerIdx]).includes("date");

  let singleDayDate: string | null = null;
  if (!hasDateColumn) {
    const preamble = lines.slice(0, headerIdx).join("\n");
    const startMatch = /start\s*time\s*,\s*"?(\d{4}-\d{2}-\d{2})/i.exec(preamble);
    if (!startMatch) {
      throw new Error(
        "FSN report has no 'Start Time' line — that line is the only place the report date exists, so the file can't be dated."
      );
    }
    singleDayDate = startMatch[1];
  }

  // Cast: Papa's overloads resolve a config carrying `transformHeader` to the
  // async LocalFile signature (which returns void), even though the input here
  // is a plain string and the call is synchronous.
  const parsed = Papa.parse<Record<string, string>>(lines.slice(headerIdx).join("\n"), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h: string) => h.trim(),
  }) as unknown as { data: Record<string, string>[] };

  const parsedRows = parsed.data.map((r) => {
    const p = makePicker(r);
    return {
      report_date: singleDayDate ?? toDate(p("Date")),
      campaign_id: clean(p("Campaign ID")),
      campaign_name: str(p("Campaign Name")),
      adgroup_id: clean(p("AdGroup ID", "Ad Group ID")),
      adgroup_name: str(p("AdGroup Name", "Ad Group Name")),
      sku_id: clean(p("Sku Id", "SKU ID", "SKU Id")),
      product_name: str(p("Product Name", "Product Title")),
      views: num(p("Views", /^Impressions$/i)),
      clicks: num(p("Clicks")),
      direct_units_sold: num(p("Direct Units Sold")),
      indirect_units_sold: num(p("Indirect Units Sold")),
      total_revenue: num(p(/^Total Revenue/i)),
      conversion_rate: num(p("Conversion Rate")),
      roi: num(p("ROI")),
      ad_spend: num(p("Ad Spend")),
      raw: r,
    };
  });
  const rows = parsedRows.filter((r) => r.report_date && (r.campaign_id || r.sku_id));
  const dropped = parsedRows.filter((r) => !(r.report_date && (r.campaign_id || r.sku_id)) && r.ad_spend > 0);

  return {
    rows,
    totalRows: parsed.data.length,
    ...(singleDayDate ? { minDate: singleDayDate, maxDate: singleDayDate } : dateBounds(rows, "report_date")),
    droppedWithSpend: dropped.length ? { count: dropped.length, totalSpend: dropped.reduce((s, r) => s + r.ad_spend, 0) } : undefined,
  };
}

/**
 * FSN (ad performance) XLSX — a multi-day export with one row per
 * campaign x ad group x SKU x day, dated by its own "Date" column, rather than
 * a single-day preamble. Used to backfill a historical range in one upload
 * instead of one file per day. Reads a sheet named "Spend" (falling back to
 * the first sheet), and — like the other XLSX readers — recomputes the used
 * range first since Flipkart-derived exports can carry a lying <dimension> tag.
 */
async function parseFsnReportXlsx(file: File): Promise<ParsedUpload> {
  const wb = await readWorkbook(file);
  const sheet = pickSheet(wb, "Spend", 0);
  // The seller's combined workbook keeps the CSV's Start Time / End Time
  // preamble above the real header on this sheet — see findHeaderRow.
  const raw = readSheetRows(sheet, findHeaderRow(sheet, ["Date", "Campaign ID"]));
  const parsed = raw.map((r) => {
    const p = makePicker(r);
    return {
      report_date: toDate(p("Date")),
      campaign_id: clean(p("Campaign ID")),
      campaign_name: str(p("Campaign Name")),
      adgroup_id: clean(p("AdGroup ID", "Ad Group ID")),
      adgroup_name: str(p("AdGroup Name", "Ad Group Name")),
      sku_id: clean(p("Sku Id", "SKU ID", "SKU Id")),
      product_name: str(p("Product Name", "Product Title")),
      views: num(p("Views", /^Impressions$/i)),
      clicks: num(p("Clicks")),
      direct_units_sold: num(p("Direct Units Sold")),
      indirect_units_sold: num(p("Indirect Units Sold")),
      total_revenue: num(p(/^Total Revenue/i)),
      conversion_rate: num(p("Conversion Rate")),
      roi: num(p("ROI")),
      ad_spend: num(p("Ad Spend")),
      raw: r,
    };
  });
  const rows = parsed.filter((r) => r.report_date && (r.campaign_id || r.sku_id));

  // A row with real ad spend that got dropped (almost always a "Date" cell
  // toDate() couldn't parse) silently understates the total — unlike a blank
  // spacer row or a zero-spend row missing both IDs, which are expected noise.
  const dropped = parsed.filter((r) => !(r.report_date && (r.campaign_id || r.sku_id)) && r.ad_spend > 0);

  return {
    rows,
    totalRows: raw.length,
    ...dateBounds(rows, "report_date"),
    droppedWithSpend: dropped.length ? { count: dropped.length, totalSpend: dropped.reduce((s, r) => s + r.ad_spend, 0) } : undefined,
  };
}

/** Order report — the "Orders" sheet (XLSX/XLS) or a raw CSV export, one row
 *  per order item (or per return leg of a partially-returned item). Same
 *  CSV-or-XLSX acceptance as parseReturnsReport, for sellers whose Orders >
 *  Download orders export comes back as a plain CSV rather than the combined
 *  workbook's "Orders" tab. */
async function parseOrderReport(file: File): Promise<ParsedUpload> {
  const name = file.name.toLowerCase();
  let raw: RawRow[];
  if (name.endsWith(".csv")) {
    const text = await file.text();
    raw = (Papa.parse<Record<string, string>>(text, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h: string) => h.trim(),
    }) as unknown as { data: Record<string, string>[] }).data;
  } else {
    const wb = await readWorkbook(file);
    raw = readSheetRows(pickSheet(wb, "Orders", wb.SheetNames.length - 1));
  }
  const rows = raw
    .map((r) => {
      const p = makePicker(r);
      const orderDateRaw = str(p("order_date"));
      return {
        order_item_id: clean(p("order_item_id")),
        order_id: clean(p("order_id")),
        fulfilment_source: str(p("fulfilment_source", "fulfillment_source")),
        fulfilment_type: str(p("fulfilment_type", "fulfillment_type")),
        order_date: toDate(p("order_date")),
        order_datetime: orderDateRaw || null,
        order_approval_date: str(p("order_approval_date")) || null,
        order_item_status: str(p("order_item_status")),
        sku: clean(p("sku")),
        fsn: clean(p("fsn")),
        product_title: clean(p("product_title")),
        quantity: num(p("quantity")),
        delivery_logistics_partner: str(p("delivery_logistics_partner")),
        pickup_logistics_partner: str(p("pickup_logistics_partner")),
        delivery_tracking_id: clean(p("delivery_tracking_id")),
        order_cancellation_date: toDate(p("order_cancellation_date")),
        cancellation_reason: str(p("cancellation_reason")),
        cancellation_sub_reason: str(p("cancellation_sub_reason")),
        order_return_approval_date: toDate(p("order_return_approval_date")),
        return_id: clean(p("return_id")),
        return_reason: str(p("return_reason")),
        return_sub_reason: str(p("return_sub_reason")),
        dispatched_date: toDate(p("dispatched_date")),
        order_delivery_date: toDate(p("order_delivery_date")),
        dispatch_sla_breached: str(p("dispatch_sla_breached")),
        delivery_sla_breached: str(p("delivery_sla_breached")),
        raw: r,
      };
    })
    .filter((r) => r.order_item_id && r.order_date);

  return { rows, totalRows: raw.length, ...dateBounds(rows, "order_date") };
}

/** "Earn more" XLSX — per-day, per-SKU sales summary. */
async function parseEarnMore(file: File): Promise<ParsedUpload> {
  const wb = await readWorkbook(file);
  const raw = readSheetRows(pickSheet(wb, "earn_more_report", 0));
  const rows = raw
    .map((r) => {
      const p = makePicker(r);
      return {
        order_date: toDate(p("Order Date")),
        product_id: clean(p("Product Id", "Product ID")),
        sku_id: clean(p("SKU ID", "Sku Id", "Seller SKU")),
        category: str(p("Category")),
        brand: str(p("Brand")),
        vertical: str(p("Vertical")),
        fulfillment_type: str(p("Fulfillment Type", "Fulfilment Type")),
        location_id: str(p("Location Id", "Location ID")),
        gross_units: num(p("Gross Units")),
        gmv: num(p("GMV")),
        cancellation_units: num(p("Cancellation Units")),
        cancellation_amount: num(p("Cancellation Amount")),
        return_units: num(p("Return Units")),
        return_amount: num(p("Return Amount")),
        final_sale_units: num(p("Final Sale Units")),
        final_sale_amount: num(p("Final Sale Amount")),
        raw: r,
      };
    })
    .filter((r) => r.order_date && r.sku_id);

  return { rows, totalRows: raw.length, ...dateBounds(rows, "order_date") };
}

/**
 * Returns report CSV — one row per return, scoped by Return Requested Date.
 * Richer than the Order report's order_item_status: a return sits here the
 * moment it's requested, tracked through in-transit/completed, independent of
 * whatever status the original order line still shows. Order Item ID/Return ID
 * arrive truncated to scientific notation for large values (same Excel/CSV
 * numeric-overflow issue as Amazon's order-item IDs — see amazonReportUpload.ts),
 * so they're kept for reference only, never used as a join/dedupe key.
 */
async function parseReturnsReport(file: File): Promise<ParsedUpload> {
  // Flipkart's own Returns download is a CSV, but the seller's combined
  // workbook carries the same columns on a "Returns" sheet — accept both rather
  // than making them re-export a file they already have.
  const name = file.name.toLowerCase();
  let sourceRows: RawRow[];
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const wb = await readWorkbook(file);
    sourceRows = readSheetRows(pickSheet(wb, "Returns", 0));
  } else {
    const text = await file.text();
    sourceRows = (Papa.parse<Record<string, string>>(text, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h: string) => h.trim(),
    }) as unknown as { data: Record<string, string>[] }).data;
  }

  const rows = sourceRows
    .map((r) => {
      const p = makePicker(r);
      return {
        order_id: clean(p("Order ID")),
        order_item_id: clean(p("Order Item ID")),
        return_id: clean(p("Return ID")),
        sku: clean(p("SKU")),
        fsn: clean(p("FSN")),
        product_title: str(p("Product")),
        total_price: num(p("Total Price")),
        quantity: num(p("Quantity")),
        ff_type: str(p("FF Type")),
        return_requested_date: toDate(p("Return Requested Date")),
        return_approval_date: toDate(p("Return Approval Date")),
        completed_date: toDate(p("Completed Date")),
        return_status: str(p("Return Status")),
        completion_status: str(p("Completion Status")),
        return_type: str(p("Return Type")),
        return_reason: str(p("Return Reason")),
        return_sub_reason: str(p("Return Sub-reason")),
        location_name: str(p("Location Name")),
        raw: r,
      };
    })
    .filter((r) => r.return_requested_date && (r.sku || r.order_id));

  return { rows, totalRows: sourceRows.length, ...dateBounds(rows, "return_requested_date") };
}

/**
 * Listings (Manage Listings) export — current Price/MRP/Stock/Status snapshot,
 * one row per SKU. Flipkart's own template puts a human-readable description of
 * each column directly under the header row ("Title of your product as on
 * Flipkart.com", "Your Identifier for a product", ...) rather than real data.
 *
 * That row is detected and dropped rather than sliced off by position: in
 * Flipkart's raw export the sheet name is a random per-export id so pickSheet
 * lands on sheet 0, but in the seller's combined workbook the tab is named
 * "Listing and Price " and has NO description row, where a blind slice(1) ate
 * a real SKU instead.
 */
async function parseListingsReport(file: File): Promise<ParsedUpload> {
  const wb = await readWorkbook(file);
  const all = readSheetRows(pickSheet(wb, "listing", 0));
  // Flipkart's template describes the SKU column as "Your Identifier for a
  // product"; a real row there is an actual SKU code.
  const isTemplateHint = (r: RawRow) => /^your identifier for a product$/i.test(clean(makePicker(r)("Seller SKU Id")));
  const raw = all.length && isTemplateHint(all[0]) ? all.slice(1) : all;
  const rows = raw
    .map((r) => {
      const p = makePicker(r);
      return {
        listing_id: clean(p("Listing ID")),
        seller_sku_id: clean(p("Seller SKU Id")),
        product_title: str(p("Product Title")),
        selling_price: num(p("Your Selling Price")),
        mrp: num(p("MRP")),
        stock_count: num(p("System Stock count")),
        listing_status: str(p("Listing Status")),
        updated_at: new Date().toISOString(),
      };
    })
    .filter((r) => r.seller_sku_id);

  return { rows, totalRows: raw.length, minDate: null, maxDate: null };
}

function dateBounds(rows: Record<string, unknown>[], field: string): { minDate: string | null; maxDate: string | null } {
  const dates = rows.map((r) => r[field] as string | null).filter((d): d is string => !!d).sort();
  return { minDate: dates[0] ?? null, maxDate: dates[dates.length - 1] ?? null };
}

const PARSER: Record<FlipkartUploadReportType, (file: File) => Promise<ParsedUpload>> = {
  fsn_report: parseFsnReport,
  order_report: parseOrderReport,
  earn_more: parseEarnMore,
  returns: parseReturnsReport,
  listings: parseListingsReport,
};

// ── Supabase writes ─────────────────────────────────────────────────────────

async function insertInChunks(table: string, rows: Record<string, unknown>[], chunkSize = 300): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const { error } = await supabasePublic.from(table).insert(rows.slice(i, i + chunkSize));
    if (error) throw new Error(`Insert into ${table} failed: ${error.message}`);
  }
}

async function upsertInChunks(
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string,
  chunkSize = 300
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const { error } = await supabasePublic.from(table).upsert(rows.slice(i, i + chunkSize), { onConflict });
    if (error) throw new Error(`Upsert into ${table} failed: ${error.message}`);
  }
}

async function deleteDateRange(table: string, dateCol: string, minDate: string, maxDate: string): Promise<void> {
  const { error } = await supabasePublic.from(table).delete().gte(dateCol, minDate).lte(dateCol, maxDate);
  if (error) throw new Error(`Clearing existing ${table} rows in range failed: ${error.message}`);
}

// Wipes the whole table before inserting — for FULL_REPLACE_TYPES (listings),
// a current-moment snapshot with no date column, where every upload supersedes
// the last one entirely. Mirrors truncateAndInsert in amazonReportUpload.ts.
async function truncateAndInsert(table: string, rows: Record<string, unknown>[]): Promise<void> {
  // A file with zero usable rows (wrong report, renamed columns) must never wipe the
  // existing snapshot — the delete below would otherwise leave the table empty.
  if (rows.length === 0) throw new Error("No valid rows found in this file — check it is the right report. Existing data was left unchanged.");
  const { error } = await supabasePublic.from(table).delete().gte("id", 0);
  if (error) throw new Error(`Truncate ${table} failed: ${error.message}`);
  await insertInChunks(table, rows);
}

/**
 * A file can contain two rows that are identical in EVERY column — Flipkart's
 * order export does this occasionally. With no per-row upsert key available
 * (see the table comments), both would insert and double-count. Only fully
 * identical rows are collapsed; a genuine partial return, which differs in
 * status/quantity/return_id, is untouched.
 */
function dedupeExactRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    const key = JSON.stringify(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * Order report: collapse only rows that repeat an (order item ID, status,
 * quantity) triple — a verbatim re-export of the same line item.
 *
 * This deliberately does NOT key on (order ID, SKU, quantity), which an earlier
 * version did: Flipkart splits a 2-unit order of one SKU into two SEPARATE
 * order_item_ids of quantity 1 each, so that looser key silently destroyed one
 * leg of every such order. Measured against the seller's own 30-day workbook
 * that was 27 real units lost, which is exactly why Orders read low for
 * B-CT-SPIRAL-G (166 vs 168), SCGSB1 (506 vs 512) and B-OT-DT12-1 (59 vs 63).
 *
 * Status and quantity are part of the key because a partially-returned item
 * exports as two rows sharing ONE order_item_id (quantity=2 RETURNED +
 * quantity=1 DELIVERED); keying on the id alone would collapse those two legs
 * back into one and lose the same way.
 */
function dedupeOrderReportRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    const key = `${r.order_item_id}|${r.order_item_status}|${r.quantity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

export interface FlipkartUploadResult {
  totalRows: number;
  savedRows: number;
  skippedRows: number;
  minDate: string | null;
  maxDate: string | null;
  /** Extra work done beyond the raw table, surfaced in the card's status line. */
  mirrored?: string;
  /** Rows with real ad spend dropped before saving — see ParsedUpload. */
  droppedWithSpend?: { count: number; totalSpend: number };
}

/**
 * The FSN report and the earn-more report are also the sources the ORIGINAL
 * Flipkart dashboard pages read (barm_flipkart_campaign_performance and
 * barm_flipkart_overall_sales — see src/lib/flipkartData.ts). Those two tables
 * are kept in sync here so one upload lights up both the new report and every
 * existing Overview/Campaigns/Sales/Products page, instead of the seller having
 * to upload the same file twice on two different pages.
 *
 * Both mirrors delete the covered date range first, which also fixes the legacy
 * Upload Data tab's append-only behaviour for overall_sales (re-uploading a day
 * there duplicated it).
 *
 * `rows` may span many distinct report_date values at once (the multi-day XLSX
 * backfill path in parseFsnReportXlsx), not just the single day the per-day CSV
 * upload produces — so each distinct date covered is cleared individually
 * rather than assuming one date for the whole batch.
 */
async function mirrorFsnToCampaignPerformance(rows: Record<string, unknown>[]): Promise<string> {
  const table = "barm_flipkart_campaign_performance";
  const dates = [...new Set(rows.map((r) => r.report_date as string).filter(Boolean))];
  for (const date of dates) {
    const { error: delErr } = await supabasePublic.from(table).delete().eq("report_date", date);
    if (delErr) throw new Error(`Refreshing ${table} for ${date} failed: ${delErr.message}`);
  }
  const now = new Date().toISOString();
  await insertInChunks(
    table,
    rows.map((r) => {
      const direct = Number(r.direct_units_sold) || 0;
      const indirect = Number(r.indirect_units_sold) || 0;
      return {
        campaign_name: r.campaign_name || null,
        campaign_type: null,
        sku_id: r.sku_id || null,
        product_name: r.product_name || null,
        product_title: r.product_name || null,
        impressions: Number(r.views) || 0,
        clicks: Number(r.clicks) || 0,
        ad_spend: Number(r.ad_spend) || 0,
        total_revenue_rs: Number(r.total_revenue) || 0,
        direct_units: direct,
        indirect_units: indirect,
        total_orders: direct + indirect,
        report_date: r.report_date,
        created_at: now,
      };
    })
  );
  return dates.length > 1 ? `dashboard campaign data refreshed for ${dates.length} days` : "dashboard campaign data refreshed";
}

async function mirrorEarnMoreToOverallSales(
  rows: Record<string, unknown>[],
  minDate: string,
  maxDate: string
): Promise<string> {
  const table = "barm_flipkart_overall_sales";
  await deleteDateRange(table, "order_date", minDate, maxDate);
  const now = new Date().toISOString();
  await insertInChunks(
    table,
    rows.map((r) => ({
      order_date: r.order_date,
      sku_id: r.sku_id || null,
      seller_sku_id: r.sku_id || null,
      product_name: r.vertical || null,
      product_title: r.vertical || null,
      final_sale_amount: Number(r.final_sale_amount) || 0,
      final_sale_units: Number(r.final_sale_units) || 0,
      gmv: Number(r.gmv) || 0,
      gross_units: Number(r.gross_units) || 0,
      cancellation_units: Number(r.cancellation_units) || 0,
      return_units: Number(r.return_units) || 0,
      created_at: now,
    }))
  );
  return "dashboard sales data refreshed";
}

// The FSN report's own conflict key — several rows can share it when
// Flipkart's export splits one SKU/day/campaign/ad group's stats across two
// rows (seen in practice: one row with a blank Product Name and a handful of
// views, another with the real product name and the rest of the views/
// clicks/spend). dedupeExactRows only catches byte-identical rows, so it
// misses this; left unmerged, one upsert statement would carry the same
// conflict key twice and Postgres would throw "ON CONFLICT DO UPDATE command
// cannot affect row a second time" for the whole upload. Same convention as
// combinedAdSpendUpload.ts's "FK ads"/"AM ads" REPORT_TARGETS specs.
const FSN_CONFLICT_KEY = ["report_date", "campaign_id", "adgroup_id", "sku_id"];
const FSN_MERGE_SUM_FIELDS = ["views", "clicks", "direct_units_sold", "indirect_units_sold", "total_revenue", "ad_spend"];

/**
 * Parse one Flipkart export in the browser and write it to its barm_flipkart_*
 * table. The FSN report upserts per row on (date, campaign, ad group, SKU); the
 * other three replace whatever date range the file covers, because none of them
 * has a column that is reliably unique (a partially returned order item is two
 * rows sharing one order_item_id; a settlement line repeats per NEFT payout).
 */
export async function uploadFlipkartReportFile(
  type: FlipkartUploadReportType,
  file: File
): Promise<FlipkartUploadResult> {
  const parsed = await PARSER[type](file);
  const table = FK_REPORT_TABLE[type];
  const dateCol = FK_DATE_COLUMN[type];
  let rows = type === "order_report" ? dedupeOrderReportRows(parsed.rows) : dedupeExactRows(parsed.rows);
  if (type === "fsn_report") {
    rows = mergeByConflictKey(rows, FSN_CONFLICT_KEY, FSN_MERGE_SUM_FIELDS);
  }

  if (!rows.length) {
    return {
      totalRows: parsed.totalRows,
      savedRows: 0,
      skippedRows: parsed.totalRows,
      minDate: null,
      maxDate: null,
      droppedWithSpend: parsed.droppedWithSpend,
    };
  }

  let mirrored: string | undefined;
  if (type === "fsn_report") {
    await upsertInChunks(table, rows, FSN_CONFLICT_KEY.join(","));
    mirrored = await mirrorFsnToCampaignPerformance(rows);
  } else if (FULL_REPLACE_TYPES[type]) {
    await truncateAndInsert(table, rows);
  } else {
    await deleteDateRange(table, dateCol!, parsed.minDate!, parsed.maxDate!);
    await insertInChunks(table, rows);
    if (type === "earn_more") {
      mirrored = await mirrorEarnMoreToOverallSales(rows, parsed.minDate!, parsed.maxDate!);
    }
  }

  if (PRUNE_TO_UPLOAD_RANGE[type] && parsed.minDate && parsed.maxDate) {
    await pruneOutsideRange(table, dateCol!, parsed.minDate, parsed.maxDate);
  }

  return {
    totalRows: parsed.totalRows,
    savedRows: rows.length,
    skippedRows: parsed.totalRows - rows.length,
    minDate: parsed.minDate,
    maxDate: parsed.maxDate,
    mirrored,
    droppedWithSpend: parsed.droppedWithSpend,
  };
}

// ── "data on file" summaries for the upload cards ───────────────────────────

export interface FlipkartReportDataInfo {
  rowCount: number;
  minDate: string | null;
  maxDate: string | null;
  /** Set when the lookup itself failed, so the UI can say so instead of "No data". */
  error?: string;
}

export async function fetchFlipkartReportDataInfo(
  type: FlipkartUploadReportType
): Promise<FlipkartReportDataInfo> {
  const table = FK_REPORT_TABLE[type];
  const dateCol = FK_DATE_COLUMN[type];

  // Listings has no date column at all (current-moment snapshot) — just report
  // the row count, same as Amazon's price_listing/fba_inventory.
  if (!dateCol) {
    const { count, error } = await supabasePublic.from(table).select("*", { count: "exact", head: true });
    if (error) return { rowCount: 0, minDate: null, maxDate: null, error: error.message };
    return { rowCount: count || 0, minDate: null, maxDate: null };
  }

  // The `error` field matters here: a failed query returns data:null, which is
  // indistinguishable from an empty table if you only read `data`. Reporting
  // that as "No data" is the worst possible answer — the seller re-uploads a
  // file that was never going to save.
  //
  // Rows with no date yet must be excluded here — Postgres sorts NULLs FIRST on
  // a descending order by default, so without this filter the "max date" query
  // could return a blank-date row instead of the latest real date (see the same
  // fix in amazonReportUpload.ts's fetchReportDataInfo).
  const [minRes, maxRes] = await Promise.all([
    supabasePublic.from(table).select(dateCol, { count: "exact" }).not(dateCol, "is", null).order(dateCol, { ascending: true }).limit(1),
    supabasePublic.from(table).select(dateCol).not(dateCol, "is", null).order(dateCol, { ascending: false }).limit(1),
  ]);
  const failure = minRes.error || maxRes.error;
  if (failure) return { rowCount: 0, minDate: null, maxDate: null, error: failure.message };

  // Cast through unknown: with a runtime-only column name, supabase-js types the
  // row as its error-shaped union rather than a plain record.
  const minDate = (minRes.data?.[0] as unknown as Record<string, string> | undefined)?.[dateCol] ?? null;
  const maxDate = (maxRes.data?.[0] as unknown as Record<string, string> | undefined)?.[dateCol] ?? null;
  return {
    rowCount: minRes.count || 0,
    minDate: minDate ? minDate.slice(0, 10) : null,
    maxDate: maxDate ? maxDate.slice(0, 10) : null,
  };
}

/**
 * Never rejects — one unreachable table must not blank the date caption on the
 * other three cards, which is what a plain Promise.all would do.
 */
export async function fetchAllFlipkartReportDataInfo(): Promise<
  Record<FlipkartUploadReportType, FlipkartReportDataInfo>
> {
  const types = Object.keys(FK_REPORT_TABLE) as FlipkartUploadReportType[];
  const results = await Promise.allSettled(types.map((t) => fetchFlipkartReportDataInfo(t)));
  return Object.fromEntries(
    types.map((t, i) => {
      const r = results[i];
      return [
        t,
        r.status === "fulfilled"
          ? r.value
          : {
              rowCount: 0,
              minDate: null,
              maxDate: null,
              error: r.reason instanceof Error ? r.reason.message : String(r.reason),
            },
      ];
    })
  ) as Record<FlipkartUploadReportType, FlipkartReportDataInfo>;
}

/** Widest date range covered by any uploaded Flipkart report. */
export function flipkartUploadedDateRange(
  info: Partial<Record<FlipkartUploadReportType, FlipkartReportDataInfo>>
): { min: string | null; max: string | null } {
  let min: string | null = null;
  let max: string | null = null;
  Object.values(info).forEach((i) => {
    if (!i) return;
    if (i.minDate && (!min || i.minDate < min)) min = i.minDate;
    if (i.maxDate && (!max || i.maxDate > max)) max = i.maxDate;
  });
  return { min, max };
}
