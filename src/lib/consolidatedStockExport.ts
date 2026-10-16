// "Export Excel" for the Consolidated Stock Sheet, styled like the client's own Consolidate sheet
// (user, 2026-10-12: "sheet colour full ah venum"): green bold Bookman headers with thin black
// borders, a day's cell yellow when it is lower than the day before, and "runs out in" under 30
// days in light red with dark red text (the client's conditional formats, applied as fixed colours).

import * as XS from "xlsx-js-style";
import { runningOut, salesDropped, noSales, NO_SALES_MIN_STOCK, RUNNING_OUT_DAYS, CONSOLIDATED_DAYS, type ConsolidatedRow } from "./consolidatedStock.ts";
import { NOT_LISTED_PRODUCTS } from "./notListedProducts.ts";
import type { Coverage, ProductAnalytics } from "./godownAnalytics.ts";

// xlsx-js-style is CommonJS: under plain Node (node --test) its API is on .default; bundlers give it directly.
const XLSX = ((XS as unknown as { default?: typeof XS }).default ?? XS) as typeof XS;

const thin = { style: "thin", color: { rgb: "000000" } };
const border = { top: thin, bottom: thin, left: thin, right: thin };
const FONT = "Bookman Old Style";
const HEAD = { font: { name: FONT, sz: 10, bold: true }, fill: { fgColor: { rgb: "C5E0B3" } }, alignment: { horizontal: "center", vertical: "center", wrapText: true }, border };
const NAME = { font: { name: FONT, sz: 11 }, alignment: { horizontal: "center", vertical: "center", wrapText: true }, border };
const num = (z: string) => ({ font: { name: "Calibri", sz: 11 }, alignment: { horizontal: "center", vertical: "center" }, border, numFmt: z });
const YELLOW = { fill: { fgColor: { rgb: "FFFF00" } } };
const RED = { font: { name: "Calibri", sz: 11, color: { rgb: "9C0006" } }, fill: { fgColor: { rgb: "FFC7CE" } } };

type Cell = { v: string | number; t: "s" | "n" | "e"; s: Record<string, unknown> };
const s = (v: string, style = NAME): Cell => ({ v, t: "s", s: style });
const n = (v: number | null | undefined, z = "0", extra: Record<string, unknown> = {}): Cell =>
  v === null || v === undefined || !Number.isFinite(v) ? { v: "", t: "s", s: num(z) } : { v, t: "n", s: { ...num(z), ...extra } };

/** Same as n(), plus an Excel formula; v is the value Excel shows before it recalculates. */
const f = (formula: string, v: number | null | undefined, z = "0", extra: Record<string, unknown> = {}): Cell & { f: string } =>
  ({ ...n(v ?? 0, z, extra), f: formula });

function sheet(rows: (Cell & { f?: string })[][], widths: number[], headerHeight = 42) {
  const ws = XLSX.utils.aoa_to_sheet(rows.map((r) => r.map((c) => c.v)));
  rows.forEach((r, ri) => r.forEach((c, ci) => {
    const addr = XLSX.utils.encode_cell({ r: ri, c: ci });
    if (!ws[addr]) return;
    ws[addr].s = c.s;
    if (c.t === "e") Object.assign(ws[addr], { t: "e", v: 0x07, w: "#DIV/0!" });
    if (c.t === "n") ws[addr].z = (c.s as { numFmt?: string }).numFmt;
    if (c.f) ws[addr].f = c.f;
  }));
  ws["!cols"] = widths.map((wch) => ({ wch }));
  ws["!rows"] = [{ hpt: headerHeight }];
  return ws;
}

/** Day cells, yellow where a day is lower than the one before it (the client's C2<B2 rule). */
const dayCells = (days: (number | null)[]) => days.map((v, i) => {
  const prev = i > 0 ? days[i - 1] ?? 0 : null;
  return n(v ?? 0, "0", prev !== null && (v ?? 0) < prev ? YELLOW : {});
});
const coverCell = (d: number | null) => n(d === null ? null : d, "0", d !== null && d < RUNNING_OUT_DAYS ? RED : {});
/** Runs out in: current ÷ average, #DIV/0! when nothing sold — as the client's sheet shows it (user, 2026-10-15). */
const runsOutCell = (d: number | null): Cell => (d === null ? { v: "#DIV/0!", t: "e", s: num("0") } : coverCell(d));

/** Peak sales: best single day over every godown day up to the sheet's date (blank = never shipped). */
const peakCells = (r: ConsolidatedRow) => [n(r.peakQty), s(r.peakDate ? r.peakDate.split("-").reverse().join("-") : "")];

/** Where one restock input came from: a restock upload ("current" = the client's Current stock sheet,
 *  "upload" = the tool's Stock Purchase / Components Sheet) or the Monday snapshot, whichever is newer. */
export type RestockSource = { from: "snapshot" | "upload" | "current" | "none"; date: string | null; at: string | null };
/** status: the Monday snapshot's, or "ok" once every input has a source (upload or snapshot). */
type WeeklyInfo = { weekStart: string; status: "ok" | "missing" | "failed"; capturedAt: string | null; error: string | null; transit?: RestockSource; purchase?: RestockSource; components?: RestockSource };
/** Godown Stock Analytics over the same products (src/lib/godownAnalytics.ts), for the "Seasonal Analytics" sheet. */
export type SeasonalSheetData = { coverage: Coverage; products: ProductAnalytics[] };
export type ConsolidatedExportData = { snapshotDate: string | null; dates: string[]; rows: ConsolidatedRow[]; weekly?: WeeklyInfo | null; seasonal?: SeasonalSheetData | null };

const dmy = (iso: string) => iso.split("-").reverse().join("-");
const istStamp = (ts: string) => new Date(ts).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " IST";

/** One line for the page and the workbook: where the Stock Purchase / Components columns come from. */
export function weeklyLabel(w: WeeklyInfo | null | undefined): string {
  if (!w) return "Stock Purchase / Components: no week (no godown data)";
  const snapText = `Monday ${dmy(w.weekStart)} snapshot, captured ${w.capturedAt ? istStamp(w.capturedAt) : "?"}`;
  // In transit / order placed: the Current stock sheet when one was uploaded, else the snapshot.
  // Purchase sheet qty and Combo: the snapshot only (user, 2026-10-14).
  const t = w.transit;
  const curText = t?.from === "current" ? `Current stock sheet of ${dmy(t.date!)} (uploaded ${istStamp(t.at!)})` : null;
  if (w.status === "ok") return curText ? `In transit / Order placed: ${curText} · Purchase sheet qty / Combo: ${snapText}` : `Stock Purchase / Components: ${snapText}`;
  const why = `no Monday ${dmy(w.weekStart)} snapshot (${w.status === "failed" ? "capture failed" + (w.error ? ": " + w.error : "") : "not captured"})`;
  if (curText) return `WARNING: ${why}. Stock purchase sheet qty and Combo show 0; Final qty is the 180-day need only. In transit / Order placed: ${curText}`;
  return `WARNING: ${why}${w.transit ? " and no Current stock sheet upload" : ""}. `
    + "Stock Intransit, Order placed, Stock purchase sheet qty and Combo show 0; Final qty is the 180-day need only.";
}

export function buildConsolidatedWorkbook(data: ConsolidatedExportData) {
  const dayHdr = data.dates.map((x, i) => `DAY ${data.dates.length - i} (${dmy(x)})`);
  const H = (t: string) => s(t, HEAD);
  const wb = XLSX.utils.book_new();

  // Consolidated first (user, 2026-10-12), with the client's formulas live in the cells:
  //   avg = SUM(days)/10, need = avg × 180/90/45, qty = need180 − (current + in transit + order placed),
  //   final = MAX(qty, purchase qty, 0), runs out in = current ÷ avg. In transit / order placed /
  //   purchase qty (Suggested RFQ) are read live from Supabase product_forecast_summary_v; combo from components_sheet.
  const nd = data.dates.length;
  const C = (i: number) => XLSX.utils.encode_col(i);
  const [cAvg, c180, cCur, , cOrd, cQty, cBuy] = [nd + 1, nd + 2, nd + 5, nd + 6, nd + 7, nd + 8, nd + 9].map(C);
  XLSX.utils.book_append_sheet(wb, sheet([
    [H("Product"), ...dayHdr.map(H), H("Average shipping per day"), H("Stock needed for next 180 days"), H("Stock needed for next 90 days"),
      H("Stock needed for next 45 days"), H("Current stock"), H("Stock Intransit"), H("Order placed"), H("Quantity to be restocked"),
      H("Stock purchase sheet Qty to be restocked"), H("Final Qty to be restocked"), H("Stock to be purchased for Combo products"),
      H("Stock running out of stock in (days)")],
    ...data.rows.map((r, i) => {
      const x = i + 2;
      return [s(r.product), ...dayCells(r.days),
        f(`SUM(B${x}:${C(nd)}${x})/${CONSOLIDATED_DAYS}`, r.avgPerDay, "0.0"),
        f(`${cAvg}${x}*180`, r.need180, "0.0"), f(`${cAvg}${x}*90`, r.need90, "0.0"), f(`${cAvg}${x}*45`, r.need45, "0.0"),
        n(r.currentStock ?? 0), n(r.stockIntransit ?? 0), n(r.orderPlaced ?? 0),
        f(`${c180}${x}-SUM(${cCur}${x}:${cOrd}${x})`, r.qtyToRestock),
        n(r.purchaseQty ?? 0, "0.00"),
        f(`MAX(${cQty}${x},${cBuy}${x},0)`, r.finalQtyToRestock, "0.00"),
        n(r.comboQty ?? 0),
        { ...runsOutCell(r.daysOfStock), f: `${cCur}${x}/${cAvg}${x}` },
      ];
    }),
  ], [63, ...dayHdr.map(() => 9), 11, 13, 11, 11, 11, 11, 11, 12, 14, 12, 14, 14], 62), "Consolidated");
  const conCols = nd + 13;
  setLayout(wb, "Consolidated", { freeze: true, filter: tableRef(conCols, data.rows.length) });
  const finalCol = C(nd + 10);

  XLSX.utils.book_append_sheet(wb, sheet([
    [H("Product"), ...dayHdr.map(H), H("Current stock"), H("Peak sales (units/day)"), H("Peak sales date")],
    ...noSales(data.rows).map((r) => [s(r.product), ...dayCells(r.days), n(r.currentStock), ...peakCells(r)]),
  ], [60, ...dayHdr.map(() => 11), 11, 12, 13]), "No Sales products");
  setLayout(wb, "No Sales products", { freeze: true, filter: tableRef(nd + 4, noSales(data.rows).length) });

  const last3 = dayHdr.slice(-3);
  XLSX.utils.book_append_sheet(wb, sheet([
    [H("Product"), ...last3.map(H), H("Current stock")],
    ...salesDropped(data.rows).map((r) => [s(r.product), ...dayCells(r.days.slice(-3)), n(r.currentStock)]),
  ], [60, 11, 11, 11, 11]), "Sales dropped products");
  setLayout(wb, "Sales dropped products", { freeze: true, filter: tableRef(5, salesDropped(data.rows).length) });

  XLSX.utils.book_append_sheet(wb, sheet([
    [H("Product"), H("Current stock"), H("Stock running out of stock in (days)")],
    ...runningOut(data.rows).map((r) => [s(r.product), n(r.currentStock), coverCell(r.daysOfStock)]),
  ], [58, 14, 22]), "Products running out of stock");
  setLayout(wb, "Products running out of stock", { freeze: true, filter: tableRef(3, runningOut(data.rows).length) });

  XLSX.utils.book_append_sheet(wb, sheet([
    [H("Product Name"), H("Quantity")],
    ...NOT_LISTED_PRODUCTS.map(([p, q]) => [s(p), typeof q === "number" ? n(q) : s(q)]),
  ], [58, 22]), "Products not listed on platform");
  setLayout(wb, "Products not listed on platform", { freeze: true, filter: tableRef(2, NOT_LISTED_PRODUCTS.length) });

  let statusCol: string | null = null, riskCol: string | null = null;
  if (data.seasonal) {
    const sea = seasonalSheet(data.seasonal);
    XLSX.utils.book_append_sheet(wb, sea.ws, "Seasonal Analytics");
    setLayout(wb, "Seasonal Analytics", { freeze: true, filter: tableRef(sea.cols, sea.rows) });
    statusCol = C(SEASONAL_HEAD.indexOf("Status"));
    riskCol = C(SEASONAL_HEAD.indexOf("Stock-out risk"));
    const un = unusualSheet(data.seasonal);
    XLSX.utils.book_append_sheet(wb, un.ws, "Unusual Stock Out days");
    setLayout(wb, "Unusual Stock Out days", { freeze: true, filter: tableRef(un.cols, un.rows) });
  }

  const about = sheet([
    [H("Consolidate sheet"), H("")],
    [s("Days"), s(data.dates.length ? `${dmy(data.dates[0])} to ${dmy(data.dates[data.dates.length - 1])} (${data.dates.length} godown days)` : "none")],
    [s("Current stock as on"), s(data.snapshotDate ? dmy(data.snapshotDate) : "-")],
    [s("Stock Purchase / Components"), s(weeklyLabel(data.weekly))],
  ], [30, 110], 22);
  if (data.weekly && data.weekly.status !== "ok") about["B4"].s = { font: { bold: true, color: { rgb: "9C0006" } }, fill: { fgColor: { rgb: "FFC7CE" } }, alignment: { wrapText: true } };
  XLSX.utils.book_append_sheet(wb, about, "About");

  // Summary is the first sheet
  XLSX.utils.book_append_sheet(wb, summarySheet(data, finalCol, statusCol, riskCol), "Summary");
  wb.SheetNames.unshift(wb.SheetNames.pop() as string);
  return wb;
}


// ── "Seasonal Analytics" sheet (user, 2026-10-13) ───────────────────────────────────────────────
// The Seasonal Analytics tab's columns, built only from the godown sheet's own daily Stock Out.
// Missing dates are gaps (averages per godown day, never diluted by zeros). Yellow headers =
// estimates. Unusually high days are flagged with their original value and kept in every figure:
// none could be shown to be a bulk transfer (see UNUSUAL_RULES in src/lib/godownAnalytics.ts).
const EST = { ...HEAD, fill: { fgColor: { rgb: "FFF2CC" } } };
const ML = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthName = (ym: string | null) => (ym ? `${ML[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}` : "");
const TEXT: typeof NAME = { ...NAME, alignment: { horizontal: "left", vertical: "center", wrapText: true } };
const STATUS_FILL: Record<string, string> = { SPIKE: "FFE699", GROWING: "C6EFCE", DROPPING: "FFC7CE", "NO SALES": "D9D9D9" };
const RISK_FILL: Record<string, string> = { "OUT OF STOCK": "FF0000", CRITICAL: "FFC7CE", HIGH: "F8CBAD", WATCH: "FFF2CC" };
const tag = (v: string, fill?: string) => s(v, fill ? ({ ...NAME, fill: { fgColor: { rgb: fill } }, font: { ...NAME.font, bold: true } } as typeof NAME) : NAME);
const pctCell = (v: number | null) => n(v === null ? null : v / 100, "0%");
const RISK_ORDER = ["OUT OF STOCK", "CRITICAL", "HIGH", "WATCH", "OK", "NOT SELLING"];
const UNUSUAL_NOTE = "Kept in every total, average and peak: no evidence it was a bulk transfer (FBA shipment records Jul–Oct 2026 do not show up in godown Stock Out).";

export const SEASONAL_HEAD = [
  "Product", "Current stock", "Shipped last 7 days", "Avg/day last 7 days (est.)", "Avg/day last 30 days (est.)", "Overall avg/day, all godown days (est.)",
  "Median/day (est.)", "Peak sales (units/day)", "Peak sales date", "Peak month", "Peak check", "Best day not flagged unusual (reference)", "Unusual days flagged",
  "Growth % — last 7 vs days 8–30 (est.)", "vs overall avg % (est.)", "Best month — avg/day (est.)", "Seasonality", "Same month last year % (est.)", "Status",
  "Why", "Recommendation", "Days of stock left (est.)", "Runs out on (est.)", "Stock-out risk", "Final qty to restock (est.)",
] as const;

function seasonalSheet({ coverage: c, products }: SeasonalSheetData) {
  const best = (p: ProductAnalytics) => (p.bestMonth ? `${monthName(p.bestMonth.month)} · ${p.bestMonth.ratePerDay.toFixed(1)}/day${p.bestMonth.partial ? ` (${p.bestMonth.coveredDays} of ${p.bestMonth.daysInMonth} days)` : ""}` : "");
  const peakCheck = (p: ProductAnalytics) => (p.peakQty === null ? "" : p.peakUnusual
    ? `Unusual: ${p.peakUnusual.units} vs typical ${p.peakUnusual.typical}/day (×${Math.round(p.peakUnusual.ratio)}) — kept, no bulk evidence` : "Normal");
  const yoy = (p: ProductAnalytics) => (p.seasonality.yoyMonth ? pctCell(p.seasonality.yoyPct) : n(null));
  const rows = [...products].sort((a, b) => RISK_ORDER.indexOf(a.risk) - RISK_ORDER.indexOf(b.risk) || (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity) || a.product.localeCompare(b.product));
  const estCols = new Set([3, 4, 5, 6, 13, 14, 15, 17, 21, 22, 24]);
  const ws = sheet([SEASONAL_HEAD.map((h, i) => s(h, estCols.has(i) ? EST : HEAD)), ...rows.map((p) => [
    s(p.product, TEXT), n(p.currentStock), n(p.units7), n(p.rate7, "0.0"), n(p.rate30, "0.0"),
    n(p.meanPerDay, "0.0"), n(p.medianPerDay, "0.0"), n(p.peakQty), s(p.peakDate ? dmy(p.peakDate) : ""), s(monthName(p.peakMonth)),
    tag(peakCheck(p), p.peakUnusual ? "FFE699" : undefined), s(p.peakUnusual && p.peakExUnusual ? `${p.peakExUnusual.qty} on ${dmy(p.peakExUnusual.date)}` : ""), n(p.unusual.length),
    pctCell(p.growthPct), pctCell(p.vsAvgPct), s(best(p)), s(p.seasonality.text, TEXT), yoy(p), tag(p.status, STATUS_FILL[p.status]),
    s(p.statusWhy, TEXT), s(p.recommendation, TEXT), coverCell(p.daysLeft), s(p.runOutDate ? dmy(p.runOutDate) : ""), tag(p.risk, RISK_FILL[p.risk]), n(p.finalQtyToRestock),
  ])], [46, 10, 10, 10, 10, 12, 10, 10, 12, 10, 30, 18, 10, 12, 10, 22, 34, 12, 14, 44, 50, 11, 12, 13, 11], 62);
  const notes = [
    `History: ${c.firstDate ? dmy(c.firstDate) : "-"} to ${c.lastDate ? dmy(c.lastDate) : "-"} — ${c.coveredDays} godown days of ${c.calendarDays}.`,
    ...c.warnings,
    "Green headers = actual (godown sheet). Yellow headers = estimates calculated from it. Averages count godown days only; a date with no upload is a gap, not zero.",
    `Peak check: a day with 20+ units and 5× the product's usual selling day is flagged "Unusual". ${UNUSUAL_NOTE} Each one is listed on the "Unusual Stock Out days" sheet.`,
    "Seasonality: months with 7+ godown days from the first month the product sold; High = 30%+ above the product's usual month, Low = 30%+ below.",
  ];
  XLSX.utils.sheet_add_aoa(ws, notes.map((t) => [t]), { origin: rows.length + 2 });
  notes.forEach((_, i) => { const a = XLSX.utils.encode_cell({ r: rows.length + 2 + i, c: 0 }); ws[a].s = { font: { italic: true, color: { rgb: "7F6000" } } }; });
  return { ws, rows: rows.length, cols: SEASONAL_HEAD.length };
}

function unusualSheet({ products }: SeasonalSheetData) {
  const list = products.flatMap((p) => p.unusual.map((u) => ({ p: p.product, ...u }))).sort((a, b) => b.ratio - a.ratio || a.p.localeCompare(b.p) || (a.date < b.date ? -1 : 1));
  const head = ["Product", "Date", "Stock Out (original)", "Typical selling day (median, ±30 godown days)", "× typical", "Classification", "Reason"];
  const ws = sheet([head.map((h) => s(h, HEAD)), ...list.map((u) => [
    s(u.p, TEXT), s(dmy(u.date)), n(u.units), n(u.typical), n(u.ratio, "0.0"), tag("Unusual – unverified", "FFE699"),
    s(`${u.units} units vs a usual ${u.typical}/day. ${UNUSUAL_NOTE}`, TEXT),
  ])], [46, 12, 12, 16, 9, 20, 70], 48);
  return { ws, rows: list.length, cols: head.length };
}

type Line = [string, Cell & { f?: string }, string];

/** Summary first (user, 2026-10-13): every figure is a live formula over the detail sheets, so it
 *  always reconciles with them; the value shown before Excel recalculates is the same count. */
function summarySheet(data: ConsolidatedExportData, finalCol: string, statusCol: string | null, riskCol: string | null) {
  const rows = data.rows;
  const a = data.seasonal?.products ?? [];
  const cnt = (st: string) => a.filter((p) => p.status === st).length;
  const q = (sheetName: string) => `'${sheetName}'`;
  const restock = rows.reduce((t, r) => t + r.finalQtyToRestock, 0);
  const lines: Line[] = [
    ["Products on the sheet", f(`COUNTA(Consolidated!A:A)-1`, rows.length), "Consolidated"],
    ["Running out of stock (under 30 days left)", f(`COUNTA(${q("Products running out of stock")}!A:A)-1`, runningOut(rows).length), "Products running out of stock"],
  ];
  if (riskCol) lines.push(["  of which out of stock while selling", f(`COUNTIF(${q("Seasonal Analytics")}!${riskCol}:${riskCol},"OUT OF STOCK")`, a.filter((p) => p.risk === "OUT OF STOCK").length), "Seasonal Analytics → Stock-out risk"]);
  if (statusCol) lines.push(
    ["Growing (last 7 days 20%+ above days 8–30)", f(`COUNTIF(${q("Seasonal Analytics")}!${statusCol}:${statusCol},"GROWING")`, cnt("GROWING")), "Seasonal Analytics → Status"],
    ["Spike (100%+ above days 8–30)", f(`COUNTIF(${q("Seasonal Analytics")}!${statusCol}:${statusCol},"SPIKE")`, cnt("SPIKE")), "Seasonal Analytics → Status"],
    ["Declining (last 7 days 20%+ below days 8–30)", f(`COUNTIF(${q("Seasonal Analytics")}!${statusCol}:${statusCol},"DROPPING")`, cnt("DROPPING")), "Seasonal Analytics → Status"],
  );
  lines.push(
    ["Sales dropped 3 days in a row (Day 3 > Day 2 > Day 1)", f(`COUNTA(${q("Sales dropped products")}!A:A)-1`, salesDropped(rows).length), "Sales dropped products"],
    [`No sales in 10 days (stock ${NO_SALES_MIN_STOCK}+, not discontinued)`, f(`COUNTA(${q("No Sales products")}!A:A)-1`, noSales(rows).length), "No Sales products"],
    ["Total final qty to restock (units)", f(`SUM(Consolidated!${finalCol}:${finalCol})`, restock, "#,##0"), "Consolidated → Final Qty to be restocked"],
  );
  if (data.seasonal) lines.push(["Unusual Stock Out days flagged (kept in totals)", f(`COUNTA(${q("Unusual Stock Out days")}!A:A)-1`, a.reduce((t, p) => t + p.unusual.length, 0)), "Unusual Stock Out days"]);
  const title = `Summary — Consolidate sheet ${data.dates.length ? dmy(data.dates[data.dates.length - 1]) : ""}`;
  const B = { ...NAME, font: { ...NAME.font, bold: true }, alignment: { horizontal: "left", vertical: "center", wrapText: false } } as typeof NAME;
  const ws = sheet([
    [s(title, B), s(""), s("")],
    [s("Measure", HEAD), s("Count / total", HEAD), s("Detail sheet", HEAD)],
    ...lines.map(([label, cell, src]) => [s(label, TEXT), { ...cell, s: { ...cell.s, font: { name: "Calibri", sz: 12, bold: true } } }, s(src, TEXT)]),
  ], [54, 16, 40], 26);
  // product lists side by side, under the figures
  const top = lines.length + 4;
  const lists: { title: string; items: [string, string | number][] }[] = [
    { title: "Running out (days left)", items: runningOut(rows).map((r) => [r.product, r.daysOfStock === null ? "" : Math.round(r.daysOfStock)]) },
  ];
  if (statusCol) lists.push(
    { title: "Growing / spike (growth %)", items: a.filter((p) => p.status === "GROWING" || p.status === "SPIKE").sort((x, y) => (y.growthPct ?? Infinity) - (x.growthPct ?? Infinity)).map((p) => [p.product, p.growthPct === null ? "new" : `+${Math.round(p.growthPct)}%`]) },
    { title: "Declining (growth %)", items: a.filter((p) => p.status === "DROPPING").sort((x, y) => (x.growthPct ?? 0) - (y.growthPct ?? 0)).map((p) => [p.product, `${Math.round(p.growthPct ?? 0)}%`]) },
  );
  lists.push({ title: "No sales in 10 days (current stock)", items: noSales(rows).map((r) => [r.product, r.currentStock]) });
  lists.forEach((l, i) => {
    const c0 = i * 3;
    XLSX.utils.sheet_add_aoa(ws, [[`${l.title} — ${l.items.length}`, ""], ...l.items], { origin: { r: top, c: c0 } });
    for (let r = top; r <= top + l.items.length; r++) for (let c = c0; c < c0 + 2; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell) cell.s = r === top ? HEAD : c === c0 ? TEXT : num("0");
    }
  });
  ws["!cols"] = lists.flatMap((_, i) => [{ wch: i === 0 ? 54 : 44 }, { wch: 16 }, { wch: i === 0 ? 40 : 3 }]);
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }];
  return ws;
}

// ── frozen header row / Product column + filters (user, 2026-10-13) ─────────────────────────────
// SheetJS writes filters but not frozen panes, so the panes are added to each sheet's XML after
// writing; nothing else in the file is touched.
type Layout = { freeze?: boolean; filter?: string };
const layouts = new WeakMap<XS.WorkBook, Record<string, Layout>>();

function setLayout(wb: XS.WorkBook, name: string, layout: Layout) {
  const m = layouts.get(wb) ?? {};
  m[name] = layout;
  layouts.set(wb, m);
  if (layout.filter) wb.Sheets[name]["!autofilter"] = { ref: layout.filter };
}
const tableRef = (cols: number, rows: number) => `A1:${XLSX.utils.encode_col(cols - 1)}${rows + 1}`;

const PANE = '<sheetView workbookViewId="0"><pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/><selection pane="bottomRight"/></sheetView>';

/** The workbook as .xlsx bytes, with the frozen panes. */
export function consolidatedWorkbookBytes(wb: XS.WorkBook): Uint8Array {
  const layout = layouts.get(wb) ?? {};
  const bytes = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  const zip = XLSX.CFB.read(new Uint8Array(bytes), { type: "array" });
  wb.SheetNames.forEach((name, i) => {
    if (!layout[name]?.freeze) return;
    const entry = zip.FileIndex[zip.FullPaths.findIndex((p: string) => p.endsWith(`/xl/worksheets/sheet${i + 1}.xml`))];
    const xml = new TextDecoder().decode(entry.content as Uint8Array);
    const out = xml.replace('<sheetView workbookViewId="0"/>', PANE);
    if (out === xml) throw new Error(`Could not freeze panes on "${name}"`);
    const content = new TextEncoder().encode(out);
    entry.content = content as unknown as typeof entry.content;
    entry.size = content.length;
  });
  return XLSX.CFB.write(zip, { fileType: "zip", type: "array" }) as Uint8Array;
}

export function exportConsolidatedWorkbook(data: ConsolidatedExportData) {
  const bytes = consolidatedWorkbookBytes(buildConsolidatedWorkbook(data));
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `Consolidate sheet -${dmy(data.dates.at(-1) ?? data.snapshotDate ?? "")}.xlsx` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ── "Send mail" (user, 2026-10-16): three separate mails, each with its own file ──────────────────
// Recipients are fixed server-side per kind (src/pages/api/consolidated-mail.ts).
export type ConsolidatedMailKind = "nosales" | "runningout" | "consolidated";
export const CONSOLIDATED_MAIL_TITLE: Record<ConsolidatedMailKind, string> = {
  nosales: "No sales & Sales dropped",
  runningout: "Products running out of stock",
  consolidated: "Consolidate sheet",
};
const MAIL_SHEETS: Record<ConsolidatedMailKind, string[] | null> = {
  nosales: ["No Sales products", "Sales dropped products"],
  runningout: ["Products running out of stock"],
  consolidated: ["Consolidated"],                       // the Consolidated sheet only, not the full report (user, 2026-10-16)
};

/** Only `names` of `wb` (sheets and their frozen panes / filters shared, not copied). */
function pickSheets(wb: XS.WorkBook, names: string[]): XS.WorkBook {
  const out = XLSX.utils.book_new();
  const lay = layouts.get(wb) ?? {};
  for (const n of names) {
    XLSX.utils.book_append_sheet(out, wb.Sheets[n], n);
    if (lay[n]) setLayout(out, n, lay[n]);
  }
  return out;
}

/** The three mail attachments: kind, file name, .xlsx bytes, rows in it. */
export function consolidatedMailFiles(data: ConsolidatedExportData) {
  const wb = buildConsolidatedWorkbook(data);
  const date = dmy(data.dates.at(-1) ?? data.snapshotDate ?? "");
  const rows: Record<ConsolidatedMailKind, number> = {
    nosales: noSales(data.rows).length + salesDropped(data.rows).length,
    runningout: runningOut(data.rows).length,
    consolidated: data.rows.length,
  };
  return (Object.keys(MAIL_SHEETS) as ConsolidatedMailKind[]).map((kind) => {
    const names = MAIL_SHEETS[kind];
    return { kind, date, rows: rows[kind], filename: `${CONSOLIDATED_MAIL_TITLE[kind]} -${date}.xlsx`, bytes: consolidatedWorkbookBytes(names ? pickSheets(wb, names) : wb) };
  });
}
