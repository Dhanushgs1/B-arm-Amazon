// "Export Excel" for Godown Stock Analytics: the product table (the rows on screen, in screen
// order), the daily total with missing dates left blank, monthly totals with covered days, and a
// Data coverage sheet with the warnings. Column headers say which values are actual and which are
// estimates.

import * as XLSX from "xlsx-js-style";
import type { GodownAnalytics, ProductAnalytics } from "@/lib/godownAnalytics";

const thin = { style: "thin", color: { rgb: "000000" } };
const border = { top: thin, bottom: thin, left: thin, right: thin };
const HEAD = { font: { bold: true, sz: 10 }, fill: { fgColor: { rgb: "C5E0B3" } }, alignment: { horizontal: "center", vertical: "center", wrapText: true }, border };
const EST_HEAD = { ...HEAD, fill: { fgColor: { rgb: "FFF2CC" } } };
const CELL = { border, alignment: { vertical: "center" } };

type Col = { head: string; est?: boolean; width: number; fmt?: string; get: (p: ProductAnalytics) => string | number | null };
const dmy = (iso: string | null) => (iso ? iso.split("-").reverse().join("-") : "");

export const EXPORT_COLUMNS: Col[] = [
  { head: "Product", width: 42, get: (p) => p.product },
  { head: "Status", width: 16, get: (p) => p.status },
  { head: "Why", width: 48, get: (p) => p.statusWhy },
  { head: "Shipped last 7 days (actual)", width: 13, get: (p) => p.units7 },
  { head: "Godown days in last 7", width: 11, get: (p) => p.covered7 },
  { head: "Shipped last 30 days (actual)", width: 13, get: (p) => p.units30 },
  { head: "Godown days in last 30", width: 11, get: (p) => p.covered30 },
  { head: "Avg/day last 7 (est.)", est: true, width: 11, fmt: "0.0", get: (p) => p.rate7 },
  { head: "Avg/day days 8–30 (est.)", est: true, width: 11, fmt: "0.0", get: (p) => p.ratePrior },
  { head: "Growth % (est.)", est: true, width: 10, fmt: "0", get: (p) => p.growthPct },
  { head: "Peak day qty (actual)", width: 10, get: (p) => p.peakQty },
  { head: "Peak date", width: 12, get: (p) => dmy(p.peakDate) },
  { head: "Last sale date", width: 12, get: (p) => dmy(p.lastSaleDate) },
  { head: "Current stock (actual)", width: 11, get: (p) => p.currentStock },
  { head: "Avg/day, 10 godown days (est.)", est: true, width: 12, fmt: "0.0", get: (p) => p.avgPerDay },
  { head: "Days of stock left (est.)", est: true, width: 11, fmt: "0", get: (p) => p.daysLeft },
  { head: "Runs out on (est.)", est: true, width: 12, get: (p) => dmy(p.runOutDate) },
  { head: "Stock-out risk", width: 13, get: (p) => p.risk },
  { head: "Stock in transit (Monday snapshot)", width: 12, get: (p) => p.stockIntransit },
  { head: "Order placed (Monday snapshot)", width: 12, get: (p) => p.orderPlaced },
  { head: "Need for 180 days (est.)", est: true, width: 11, fmt: "0", get: (p) => p.need180 },
  { head: "Qty to restock (est.)", est: true, width: 11, fmt: "0", get: (p) => p.qtyToRestock },
  { head: "Stock purchase sheet qty (Monday snapshot)", width: 13, get: (p) => p.purchaseQty },
  { head: "Final qty to restock (est.)", est: true, width: 11, fmt: "0", get: (p) => p.finalQtyToRestock },
  { head: "Combo component qty (Monday snapshot)", width: 12, get: (p) => p.comboQty },
];

function styled(aoa: (string | number | null)[][], widths: number[], headStyles: Record<string, unknown>[], fmts: (string | undefined)[] = []) {
  const ws = XLSX.utils.aoa_to_sheet(aoa.map((r) => r.map((v) => (v === null || (typeof v === "number" && !Number.isFinite(v)) ? "" : v))));
  aoa.forEach((r, ri) => r.forEach((_, ci) => {
    const a = XLSX.utils.encode_cell({ r: ri, c: ci });
    if (!ws[a]) return;
    ws[a].s = ri === 0 ? headStyles[ci] ?? HEAD : CELL;
    if (ri > 0 && fmts[ci] && ws[a].t === "n") ws[a].z = fmts[ci];
  }));
  ws["!cols"] = widths.map((wch) => ({ wch }));
  ws["!rows"] = [{ hpt: 48 }];
  return ws;
}

export function buildGodownAnalyticsWorkbook(a: GodownAnalytics, rows: ProductAnalytics[]) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, styled(
    [EXPORT_COLUMNS.map((c) => c.head), ...rows.map((p) => EXPORT_COLUMNS.map((c) => c.get(p)))],
    EXPORT_COLUMNS.map((c) => c.width), EXPORT_COLUMNS.map((c) => (c.est ? EST_HEAD : HEAD)), EXPORT_COLUMNS.map((c) => c.fmt),
  ), "Product analytics");
  XLSX.utils.book_append_sheet(wb, styled(
    [["Date", "Units shipped (all products)", "Note"], ...a.daily.map((d) => [dmy(d.date), d.units, d.units === null ? "No godown upload — gap, not zero" : ""])],
    [12, 16, 36], [HEAD, HEAD, HEAD],
  ), "Daily stock out");
  XLSX.utils.book_append_sheet(wb, styled(
    [["Month", "Units shipped (actual)", "Godown days", "Calendar days in range", "Avg/day per godown day (est.)", "Partial month"],
      ...a.monthly.map((m) => [m.label, m.units, m.coveredDays, m.calendarDays, m.ratePerDay, m.partial ? "Yes" : "No"])],
    [12, 14, 11, 12, 14, 10], [HEAD, HEAD, HEAD, HEAD, EST_HEAD, HEAD], [undefined, undefined, undefined, undefined, "0.0"],
  ), "Monthly");
  const c = a.coverage;
  XLSX.utils.book_append_sheet(wb, styled(
    [["Data coverage", ""],
      ["History", c.firstDate ? `${dmy(c.firstDate)} to ${dmy(c.lastDate)}` : "none"],
      ["Godown days with data", c.coveredDays],
      ["Calendar days in range", c.calendarDays],
      ["Days with no upload (gaps)", c.missingDays],
      ["Seasonality", c.seasonalityReady ? "Available" : "Not available — needs 365+ days of history"],
      ...c.missingRanges.map((r) => ["Missing", r.days === 1 ? dmy(r.from) : `${dmy(r.from)} to ${dmy(r.to)} (${r.days} days)`]),
      ...c.warnings.map((w) => ["Warning", w]),
      ["Legend", "Green headers = actual values from the godown sheet or the Monday snapshot. Yellow headers = estimates calculated from them."]],
    [28, 100], [HEAD, HEAD],
  ), "Data coverage");
  return wb;
}

export function exportGodownAnalytics(a: GodownAnalytics, rows: ProductAnalytics[]) {
  XLSX.writeFile(buildGodownAnalyticsWorkbook(a, rows), `Godown stock analytics -${dmy(a.asOf)}.xlsx`);
}
