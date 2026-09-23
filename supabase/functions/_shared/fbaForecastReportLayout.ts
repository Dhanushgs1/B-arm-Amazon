// supabase/functions/_shared/fbaForecastReportLayout.ts
// Presentation layer for the FBA Forecast Report — takes the already-
// computed FbaAnalysisRow[] (fbaForecastCalc.ts, unchanged) plus the raw
// ingestion rows, and lays them out to look like the user's manual
// "FBA_forecast sheet(30 days).xlsx": same sheet names and order, same
// column order, fonts and colour rules (copied from that workbook's own
// conditional formatting, applied here as fixed cell styles).
//
// Sheets kept from the manual workbook: FBA analysis, Sheet5 (as "To be
// sent"), SKU,name, 30_days_sales, FBA_stock, intranit (as "intransit"),
// recently _act (as "recently_act"), booked. Left out: the PIVOT_30 /
// PIVOT_fba / Pivot_booked / pivot_intansit / pivot_act lookup sheets (their
// sums are already the FBA analysis columns), and the hand-typed Sheet1,
// Sheet6 and "multiple listings" notes.
//
// Pure layout: NO calculation here beyond per-active-date splits of the
// same active quantities. Every forecast number comes straight from
// computeFbaAnalysis.
import XLSX from "npm:xlsx-js-style@1.2.0";
import type { FbaAnalysisRow } from "./fbaForecastCalc.ts";

export interface LayoutSalesRow { purchase_date: string; fulfillment_channel: string | null; product_name: string; sku: string; quantity: number; ship_state: string; zone: string; }
export interface LayoutStockRow { report_date: string; fnsku: string | null; fulfillment_center: string; asin: string | null; msku: string; disposition: string | null; ending_warehouse_balance: number; zone: string; }
export interface LayoutStatusRow { product: string | null; sku: string; quantity: number; fc: string; status_raw: string | null; zone: string; booked_date: string | null; pickup_date: string | null; source_month: string; active_date?: string | null; }

export interface FbaForecastLayoutInput {
  reportDate: string | null;
  rows: FbaAnalysisRow[];
  sales: LayoutSalesRow[];
  stock: LayoutStockRow[];
  booked: LayoutStatusRow[];
  intransit: LayoutStatusRow[];
  active: LayoutStatusRow[];
}

export const SHEET = {
  analysis: "FBA analysis",
  toBeSent: "To be sent",
  skuNames: "SKU,name",
  sales: "30_days_sales",
  stock: "FBA_stock",
  intransit: "intransit",
  active: "recently_act",
  booked: "booked",
} as const;

// The manual sheet's own zone order (FBA analysis!D, repeated per SKU).
export const ZONE_ORDER = [
  "Karnataka_zone", "WestBengal_zone", "Assam_zone", "Tamilnadu_zone", "Delhi_zone", "Rajasthan_zone", "Maharashtra_zone",
  "Uttarpradesh_zone", "Nagpur_zone", "Telangana_zone", "Punjab_zone", "Odisha_zone", "bihar_zone", "gujarat_zone",
];

// ── Palette: the manual workbook's colours ─────────────────────────────────
const C = {
  band: "BDD7EE",        // FBA analysis SKU-block band (theme accent5, 60% tint)
  greyBand: "D9D9D9",    // Sheet5 SKU-block band (white, 15% darker)
  headerYellow: "FFFF00",
  headerBlue: "4472C4",  // 30_days_sales "FC zone" / "id + zone" headers (accent1)
  redFill: "FFC7CE", redFont: "9C0006",       // Excel "Bad"
  greenFill: "C6EFCE", greenFont: "006100",   // Excel "Good"
  yellowFill: "FFEB9C", yellowFont: "9C5700", // Excel "Neutral"
  black: "000000", white: "FFFFFF",
};
// "STOCK RUNS OUT IN" turns red below this many days (manual rule: < 31).
export const STOCKOUT_RED_BELOW_DAYS = 31;

const thin = { style: "thin", color: { rgb: C.black } };
const BORDER = { top: thin, bottom: thin, left: thin, right: thin };
const FMT_PCT = "0.00%";
const FMT_DEC = "0.00";

type Style = Record<string, unknown>;
const fillOf = (rgb: string | null): Style => (rgb ? { fill: { patternType: "solid", fgColor: { rgb } } } : {});
const calibri = (extra: Style = {}): Style => ({ name: "Calibri", sz: 11, color: { rgb: C.black }, ...extra });

// ISO 'YYYY-MM-DD' -> Excel serial (timezone-free), or the original text.
function isoToSerial(iso: string | null | undefined): number | string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (!m) return String(iso);
  return (Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000;
}
// ISO -> "dd.mm.yyyy", the manual sheet's active-date convention.
function isoToDotted(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

export const RECENT_ACTIVE_DAYS = 3;

// The RECENT_ACTIVE_DAYS ISO dates ending on the report date, oldest first.
// Without a report date, falls back to the latest active date on file.
function recentActiveDates(reportDate: string | null, active: LayoutStatusRow[]): string[] {
  const latest = active.map((a) => (a.active_date || "").slice(0, 10)).filter(Boolean).sort().pop();
  const end = /^\d{4}-\d{2}-\d{2}/.test(reportDate || "") ? reportDate!.slice(0, 10) : latest;
  if (!end) return [];
  const endMs = Date.parse(`${end}T00:00:00Z`);
  return Array.from({ length: RECENT_ACTIVE_DAYS }, (_, i) =>
    new Date(endMs - (RECENT_ACTIVE_DAYS - 1 - i) * 86400000).toISOString().slice(0, 10));
}

const zoneRank = (zone: string) => {
  const i = ZONE_ORDER.indexOf(zone);
  return i === -1 ? ZONE_ORDER.length : i;
};

function cell(v: unknown, s: Style, fmt?: string): XLSX.CellObject {
  if (v === null || v === undefined || v === "") return { t: "s", v: "", s } as XLSX.CellObject;
  if (typeof v === "number") return { t: "n", v, s, ...(fmt ? { z: fmt } : {}) } as XLSX.CellObject;
  if (typeof v === "boolean") return { t: "b", v, s } as XLSX.CellObject;
  return { t: "s", v: String(v), s } as XLSX.CellObject;
}

// Alternating fill per SKU block (every row of one SKU shares it), first
// block filled — the manual sheets band every 14 rows, i.e. one SKU's zones.
function skuBlockBands<T>(rows: T[], skuOf: (r: T) => string, fill: string): (r: T) => string | null {
  const bySku = new Map<string, string | null>();
  let on = true;
  for (const r of rows) if (!bySku.has(skuOf(r))) { bySku.set(skuOf(r), on ? fill : null); on = !on; }
  return (r) => bySku.get(skuOf(r)) ?? null;
}

// ── Generic table writer ───────────────────────────────────────────────────
interface Col<T> {
  header: string;
  width: number;
  value: (r: T) => unknown;
  fmt?: string;
  bold?: boolean;
  headerFill?: string;
  headerStyle?: Style;
  // Colour rule overriding the band: [fill, fontColour] when it applies.
  rule?: (r: T, v: unknown) => [string, string | null] | null;
}

interface TableOpts<T> {
  headerStyle: Style;
  body: (bold: boolean) => Style; // font + alignment for data cells
  band?: (r: T) => string | null;
  freezeCols?: number;
  headerHeight?: number;
}

function buildTableSheet<T>(rows: T[], cols: Col<T>[], opts: TableOpts<T>): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {};
  cols.forEach((c, ci) => {
    const s = { ...(c.headerStyle ?? opts.headerStyle), ...fillOf(c.headerFill ?? null) };
    ws[XLSX.utils.encode_cell({ r: 0, c: ci })] = cell(c.header, s);
  });
  rows.forEach((r, ri) => {
    const band = opts.band ? opts.band(r) : null;
    cols.forEach((c, ci) => {
      const v = c.value(r);
      const base = opts.body(!!c.bold);
      const hit = c.rule ? c.rule(r, v) : null;
      const s = hit
        ? { ...base, ...fillOf(hit[0]), ...(hit[1] ? { font: { ...(base.font as Style), color: { rgb: hit[1] } } } : {}) }
        : { ...base, ...fillOf(band) };
      ws[XLSX.utils.encode_cell({ r: ri + 1, c: ci })] = cell(v, s, c.fmt);
    });
  });
  const ref = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(rows.length, 1), c: cols.length - 1 } });
  ws["!ref"] = ref;
  ws["!autofilter"] = { ref };
  ws["!cols"] = cols.map((c) => ({ wch: c.width }));
  if (opts.headerHeight) ws["!rows"] = [{ hpt: opts.headerHeight }];
  ws["!views"] = [{ state: "frozen", ySplit: 1, xSplit: opts.freezeCols ?? 0 }];
  return ws;
}

// Plain raw-sheet look: bold Calibri header, no fill, unbordered data.
const rawHeader = (sz = 11): Style => ({ font: calibri({ bold: true, sz }) });
const rawBody = (bold: boolean): Style => ({ font: calibri({ bold }) });

// ── Sheet: FBA analysis ────────────────────────────────────────────────────
// Same left-to-right order and headings as the manual "FBA analysis" sheet.
// Not carried over: F "Total peak orders (30d) in last 14 months" and W
// "Current Stock present per SKU ID for FBA" (both blank in the manual
// sheet). X "Stock present per SKU ID for FBA - booked" comes from the
// uploaded manual sheet (barm_fba_manual_plan).
// With a manual plan, its rows keep the manual's own row order and any rows
// it doesn't list follow; otherwise top seller first, zones in manual order.
function orderAnalysisRows(rows: FbaAnalysisRow[]): FbaAnalysisRow[] {
  const byData = (a: FbaAnalysisRow, b: FbaAnalysisRow) =>
    b.totalOrders30dSku - a.totalOrders30dSku || a.sku.localeCompare(b.sku) || zoneRank(a.zone) - zoneRank(b.zone) || a.zone.localeCompare(b.zone);
  return [...rows].sort((a, b) => {
    if (a.planOrder !== null && b.planOrder !== null) return a.planOrder - b.planOrder;
    if (a.planOrder !== null) return -1;
    if (b.planOrder !== null) return 1;
    return byData(a, b);
  });
}

function buildAnalysisSheet(ordered: FbaAnalysisRow[], activeDates: string[], activeByKeyDate: Map<string, number>): XLSX.WorkSheet {
  const sno = new Map<FbaAnalysisRow, number>();
  ordered.forEach((r, i) => sno.set(r, i + 1));
  const positive = (fill: string, font: string | null) => (_r: FbaAnalysisRow, v: unknown): [string, string | null] | null =>
    typeof v === "number" && v > 0 ? [fill, font] : null;
  const col = (header: string, width: number, value: (r: FbaAnalysisRow) => unknown, extra: Partial<Col<FbaAnalysisRow>> = {}): Col<FbaAnalysisRow> =>
    ({ header, width, value, ...extra });
  const dateHeader: Style = { font: calibri({ bold: true, sz: 12 }), alignment: { horizontal: "center", vertical: "center" } };

  const cols: Col<FbaAnalysisRow>[] = [
    col("S.No", 6, (r) => sno.get(r)),
    col("skuid", 22, (r) => r.sku),
    col("product name", 27, (r) => r.productName),
    col("zone", 18, (r) => r.zone),
    col("id + zone", 28, (r) => r.sku + r.zone),
    col("Total orders in last 30 days (REGION WISE)", 10, (r) => r.sales30d),
    col("Order frequency", 9, (r) => r.dailyRate, { fmt: FMT_DEC }),
    col("120 days forecast (REGION WISE)", 10, (r) => r.forecast120dZone),
    col("Total Order per SKUID (last month)", 10, (r) => r.totalOrders30dSku, { bold: true }),
    col("120 days forecast (SKUID WISE)", 10, (r) => r.totalForecast120dSku, { bold: true }),
    col("max quantity per product", 10, (r) => r.maxForecastPerProduct, { bold: true }),
    col("Minimum stock needed", 10, (r) => r.minStockNeededZone),
    col("Sales % per region", 10, (r) => r.salesPctRegion, { fmt: FMT_PCT }),
    col("Current Stock PRESENT REGION WISE", 10, (r) => r.currentStockZone, { headerFill: C.headerYellow, rule: positive(C.redFill, C.redFont) }),
    col("total stock present in ALL FBAs per SKUID", 10, (r) => r.totalStockSku, { bold: true }),
    col("Stock needed REGION WISE", 10, (r) => r.stockNeededZone),
    col("BOOKED", 10, (r) => r.bookedZone, { rule: positive(C.greenFill, C.greenFont) }),
    col("INTRANSIT", 10, (r) => r.intransitZone, { rule: positive(C.greenFill, C.greenFont) }),
    col("Booked + Intransit to FBA", 10, (r) => r.bookedPlusIntransitZone, { headerFill: C.headerYellow }),
    col("stock needed after intransit", 10, (r) => r.stockNeededAfterInboundZone),
    col("total stock needed after intransit (all regions)", 11, (r) => r.totalStockNeededAfterInboundSku, { bold: true }),
    // Manual column X, typed per SKU in the uploaded manual sheet (blank without one).
    col("Stock present per SKU ID for FBA - booked", 12, (r) => r.stockToSendSku ?? "", { headerFill: C.headerYellow }),
    col("to be sent (region wise)", 10, (r) => r.toBeSentZone),
    col("stock to be ordered per SKUID", 10, (r) => r.stockToBeOrderedZone),
    col("STOCK RUNS OUT IN", 10, (r) => r.daysUntilStockout, {
      rule: (_r, v) => (typeof v === "number" && v < STOCKOUT_RED_BELOW_DAYS ? [C.redFill, C.redFont] : null),
    }),
    // Recently activated quantity per active date, like the manual sheet's
    // trailing date columns (from pivot_act).
    ...activeDates.map((d) => col(isoToDotted(d), 11, (r) => activeByKeyDate.get(`${r.sku} ${r.zone} ${d}`) || 0,
      { headerStyle: dateHeader, rule: positive(C.yellowFill, C.yellowFont) })),
  ];

  return buildTableSheet(ordered, cols, {
    headerStyle: {
      font: { name: "Bookman Old Style", sz: 11, bold: true, color: { rgb: C.black } },
      alignment: { horizontal: "center", vertical: "center", wrapText: true },
      border: BORDER,
    },
    body: (bold) => ({ font: calibri({ bold }), alignment: { horizontal: "center", vertical: "center" } }),
    band: skuBlockBands(ordered, (r) => r.sku, C.band),
    freezeCols: 5,
    headerHeight: 60,
  });
}

// ── Workbook assembly ──────────────────────────────────────────────────────
export function buildFbaForecastLayout(input: FbaForecastLayoutInput): XLSX.WorkBook {
  const ordered = orderAnalysisRows(input.rows);

  // Like the manual sheet's recently _act / pivot_act: only shipments that
  // went active in the last RECENT_ACTIVE_DAYS days ending on the report
  // date, one column per day (a day with no activations still gets one).
  const activeDates = recentActiveDates(input.reportDate, input.active);
  const recentActive = input.active
    .filter((a) => !!a.active_date && activeDates.includes(a.active_date.slice(0, 10)))
    .sort((a, b) => a.active_date!.localeCompare(b.active_date!));
  const activeByKeyDate = new Map<string, number>();
  for (const a of recentActive) {
    const k = `${a.sku} ${a.zone} ${a.active_date!.slice(0, 10)}`;
    activeByKeyDate.set(k, (activeByKeyDate.get(k) || 0) + a.quantity);
  }

  const wb = XLSX.utils.book_new();
  const add = (ws: XLSX.WorkSheet, name: string) => XLSX.utils.book_append_sheet(wb, ws, name);

  add(buildAnalysisSheet(ordered, activeDates, activeByKeyDate), SHEET.analysis);

  // Manual "Sheet5": the send list, grey-banded per SKU.
  const toBeSent = ordered.filter((r) => r.toBeSentZone > 0);
  add(buildTableSheet(toBeSent, [
    { header: "SKUID", width: 22, value: (r) => r.sku },
    { header: "product name", width: 37, value: (r) => r.productName },
    { header: "ZONE", width: 18, value: (r) => r.zone },
    { header: "QUANTITY TO BE SENT", width: 12, value: (r) => r.toBeSentZone },
  ], {
    headerStyle: { font: calibri({ bold: true }), alignment: { horizontal: "center", vertical: "center" } },
    body: rawBody,
    band: skuBlockBands(toBeSent, (r) => r.sku, C.greyBand),
  }), SHEET.toBeSent);

  const names = new Map<string, string>();
  for (const r of ordered) if (!names.has(r.sku)) names.set(r.sku, r.productName);
  add(buildTableSheet([...names.entries()].sort((a, b) => a[0].localeCompare(b[0])), [
    { header: "SKUID", width: 26, value: (r) => r[0] },
    { header: "Product", width: 50, value: (r) => r[1] },
  ], { headerStyle: rawHeader(), body: rawBody }), SHEET.skuNames);

  const blueHeader: Style = {
    font: calibri({ bold: true, color: { rgb: C.white } }), ...fillOf(C.headerBlue),
    alignment: { horizontal: "center", vertical: "center" }, border: BORDER,
  };
  add(buildTableSheet(input.sales, [
    { header: "purchase-date", width: 15, value: (r) => isoToSerial(r.purchase_date), fmt: "dd/mm/yyyy" },
    { header: "fulfillment-channel", width: 19, value: (r) => r.fulfillment_channel || "" },
    { header: "product-name", width: 32, value: (r) => r.product_name },
    { header: "ship-state", width: 23, value: (r) => r.ship_state },
    { header: "sku", width: 16, value: (r) => r.sku },
    { header: "quantity", width: 11, value: (r) => r.quantity },
    { header: "FC zone", width: 30, value: (r) => r.zone, headerStyle: blueHeader },
    { header: "id + zone", width: 43, value: (r) => r.sku + r.zone, headerStyle: blueHeader },
  ], { headerStyle: rawHeader(), body: rawBody }), SHEET.sales);

  add(buildTableSheet(input.stock, [
    { header: "Date", width: 14, value: (r) => isoToSerial(r.report_date), fmt: "mm-dd-yy" },
    { header: "FNSKU", width: 12, value: (r) => r.fnsku || "" },
    { header: "Fulfillment Center", width: 18, value: (r) => r.fulfillment_center },
    { header: "ASIN", width: 14, value: (r) => r.asin || "" },
    { header: "MSKU", width: 23, value: (r) => r.msku },
    { header: "Disposition", width: 12, value: (r) => r.disposition || "" },
    { header: "Ending Warehouse Balance", width: 26, value: (r) => r.ending_warehouse_balance },
    { header: "ZONE", width: 35, value: (r) => r.zone },
    { header: "FULL_NAME", width: 51, value: (r) => r.msku + r.zone },
  ], { headerStyle: rawHeader(), body: rawBody }), SHEET.stock);

  const statusCols = (skuHeader: string, extra: Col<LayoutStatusRow>[] = []): Col<LayoutStatusRow>[] => [
    { header: "Product", width: 24, value: (r) => r.product || "" },
    { header: skuHeader, width: 29, value: (r) => r.sku },
    { header: "Quantity", width: 16, value: (r) => r.quantity },
    { header: "FC", width: 11, value: (r) => r.fc },
    { header: "Status", width: 17, value: (r) => r.status_raw || "" },
    { header: "zone", width: 25, value: (r) => r.zone },
    { header: "fullname", width: 44, value: (r) => r.sku + r.zone },
    ...extra,
  ];
  const statusOpts = { headerStyle: rawHeader(12), body: rawBody };
  add(buildTableSheet(input.intransit, statusCols("SKUID"), statusOpts), SHEET.intransit);
  add(buildTableSheet(recentActive, statusCols("SKU", [
    { header: "active date", width: 13, value: (r) => (r.active_date ? isoToDotted(r.active_date) : "") },
  ]), statusOpts), SHEET.active);
  add(buildTableSheet(input.booked, statusCols("SKU"), statusOpts), SHEET.booked);

  return wb;
}
