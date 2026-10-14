import test from "node:test";
import assert from "node:assert/strict";
import { analyzeGodown, coverageOf, productTrend, stockView, productSeries, calendar, addDays, mondayKey, GA_RULES, type GodownDailyRow } from "./godownAnalytics.ts";
import type { ConsolidatedRow } from "./consolidatedStock.ts";

const AS_OF = "2026-10-11";
// 30 days of history ending AS_OF; f(i) → units on day i (0 = oldest), null = no upload that day.
function hist(product: string, f: (i: number) => number | null, days = 30, end = AS_OF): GodownDailyRow[] {
  const out: GodownDailyRow[] = [];
  for (let i = 0; i < days; i++) {
    const u = f(i);
    if (u !== null) out.push({ date: addDays(end, i - (days - 1)), product, stockOut: u, closing: 100 - i });
  }
  return out;
}
const byDate = (rows: GodownDailyRow[]) => new Map(rows.map((r) => [r.date, r.stockOut]));
const row = (product: string, currentStock: number, avgPerDay: number, extra: Partial<ConsolidatedRow> = {}): ConsolidatedRow => ({
  product, days: [], avgPerDay, need180: avgPerDay * 180, need90: avgPerDay * 90, need45: avgPerDay * 45, currentStock,
  stockIntransit: null, orderPlaced: null, qtyToRestock: avgPerDay * 180 - currentStock, purchaseQty: null,
  finalQtyToRestock: Math.max(avgPerDay * 180 - currentStock, 0), comboQty: null, peakQty: null, peakDate: null,
  daysOfStock: avgPerDay > 0 ? currentStock / avgPerDay : null, discontinued: false, ...extra,
});

test("coverage counts real days only and lists the missing ranges", () => {
  const c = coverageOf(["2026-08-25", "2026-08-26", "2026-09-10", "2026-09-11", "2026-10-01", "2026-10-03"]);
  assert.equal(c.calendarDays, 40);
  assert.equal(c.coveredDays, 6);
  assert.equal(c.missingDays, 34);
  assert.deepEqual(c.missingRanges, [
    { from: "2026-08-27", to: "2026-09-09", days: 14 },
    { from: "2026-09-12", to: "2026-09-30", days: 19 },
    { from: "2026-10-02", to: "2026-10-02", days: 1 },
  ]);
  assert.equal(c.seasonalityReady, false);
  assert.ok(c.warnings.some((w) => w.includes("Seasonality is not available")));
  assert.ok(c.warnings.some((w) => w.includes("2026-10-02") && w.includes("gaps, not zero")));
});

test("no history at all", () => {
  const c = coverageOf([]);
  assert.equal(c.coveredDays, 0);
  assert.equal(c.coveragePct, null);
  const a = analyzeGodown([row("X", 10, 1)], [], AS_OF);
  assert.deepEqual(a.daily, []);
  assert.equal(a.products[0].status, "INSUFFICIENT DATA");
});

test("seasonality only becomes ready with a year of covered days", () => {
  const year = calendar("2025-10-11", "2026-10-10");
  assert.equal(year.length, 365);
  assert.equal(coverageOf(year).seasonalityReady, true);
  assert.equal(coverageOf(year.slice(1)).seasonalityReady, false);
});

test("missing dates are gaps: averages are per covered day, never diluted by zeros", () => {
  // 10/day every day, but days 20–24 (inside the 8–30 window) have no upload
  const t = productTrend("A", byDate(hist("A", (i) => (i >= 20 && i <= 24 ? null : 10))), AS_OF);
  assert.equal(t.covered30, 25);
  assert.equal(t.units30, 250);
  assert.equal(t.rate30, 10);          // 250 / 25, not 250 / 30
  assert.equal(t.ratePrior, 10);
  assert.equal(t.growthPct, 0);
  assert.equal(t.status, "STABLE");
});

test("series and totals keep missing dates as null, real zero days as 0", () => {
  const rows = hist("A", (i) => (i === 3 ? null : i === 4 ? 0 : 5));
  const s = productSeries(rows, "A", addDays(AS_OF, -29), AS_OF);
  assert.equal(s.length, 30);
  assert.equal(s[3].units, null);
  assert.equal(s[4].units, 0);
  assert.equal(s[5].units, 5);
  const a = analyzeGodown([row("A", 50, 5)], rows, AS_OF);
  assert.equal(a.daily.length, 30);
  assert.equal(a.daily[3].units, null);
  assert.equal(a.daily[4].units, 0);
});

test("zero sales with stock on hand = NO SALES and NOT SELLING", () => {
  const a = analyzeGodown([row("Z", 40, 0)], hist("Z", () => 0), AS_OF);
  const p = a.products[0];
  assert.equal(p.status, "NO SALES");
  assert.equal(p.units30, 0);
  assert.equal(p.peakQty, null);
  assert.equal(p.lastSaleDate, null);
  assert.equal(p.risk, "NOT SELLING");
  assert.equal(p.daysLeft, null);
});

test("negative growth: last 7 days below days 8–30 → DROPPING with the right %", () => {
  const t = productTrend("D", byDate(hist("D", (i) => (i >= 23 ? 4 : 10))), AS_OF);
  assert.equal(t.rate7, 4);
  assert.equal(t.ratePrior, 10);
  assert.equal(t.growthPct, -60);
  assert.equal(t.status, "DROPPING");
});

test("growth thresholds: growing, spike, stable, and restarted after nothing", () => {
  assert.equal(productTrend("G", byDate(hist("G", (i) => (i >= 23 ? 13 : 10))), AS_OF).status, "GROWING");
  assert.equal(productTrend("S", byDate(hist("S", (i) => (i >= 23 ? 25 : 10))), AS_OF).status, "SPIKE");
  assert.equal(productTrend("T", byDate(hist("T", (i) => (i >= 23 ? 11 : 10))), AS_OF).status, "STABLE");
  const r = productTrend("R", byDate(hist("R", (i) => (i >= 23 ? 3 : 0))), AS_OF);
  assert.equal(r.growthPct, null);
  assert.equal(r.status, "SPIKE");
});

test("low volume is not trended", () => {
  // 1 unit on 5 of 30 days → 0.17/day
  const t = productTrend("L", byDate(hist("L", (i) => (i % 6 === 0 ? 1 : 0))), AS_OF);
  assert.equal(t.status, "LOW VOLUME");
});

test("insufficient history: too few covered days in either window", () => {
  // only the last 10 days uploaded → days 8–30 have 3 covered days
  const t = productTrend("I", byDate(hist("I", (i) => (i >= 20 ? 10 : null))), AS_OF);
  assert.equal(t.status, "INSUFFICIENT DATA");
  assert.match(t.statusWhy, /has 7 and 3/);
  // last 7 days mostly missing
  const u = productTrend("J", byDate(hist("J", (i) => (i >= 23 && i <= 26 ? null : 10))), AS_OF);
  assert.equal(u.covered7, 3);
  assert.equal(u.status, "INSUFFICIENT DATA");
});

test("peak = best single day, latest on a tie; history after asOf is ignored", () => {
  const rows = [...hist("P", (i) => (i === 5 || i === 9 ? 30 : 2)), { date: addDays(AS_OF, 1), product: "P", stockOut: 99, closing: 0 }];
  const a = analyzeGodown([row("P", 100, 2)], rows, AS_OF);
  assert.equal(a.products[0].peakQty, 30);
  assert.equal(a.products[0].peakDate, addDays(AS_OF, -20));
  assert.equal(a.coverage.lastDate, AS_OF);
});

test("stock risk bands, days left and run-out date use the Consolidated 10-day average", () => {
  assert.deepEqual(stockView({ currentStock: 70, avgPerDay: 10 }, AS_OF), { currentStock: 70, avgPerDay: 10, daysLeft: 7, runOutDate: "2026-10-18", risk: "CRITICAL" });
  assert.equal(stockView({ currentStock: 200, avgPerDay: 10 }, AS_OF).risk, "HIGH");
  assert.equal(stockView({ currentStock: 400, avgPerDay: 10 }, AS_OF).risk, "WATCH");
  assert.equal(stockView({ currentStock: 450, avgPerDay: 10 }, AS_OF).risk, "OK");
  assert.equal(stockView({ currentStock: 0, avgPerDay: 3 }, AS_OF).risk, "OUT OF STOCK");
  assert.equal(stockView({ currentStock: -2, avgPerDay: 3 }, AS_OF).daysLeft, 0);
  assert.equal(stockView({ currentStock: 9, avgPerDay: 0 }, AS_OF).risk, "NOT SELLING");
  // 15.0 days is HIGH, not CRITICAL; 29.9 is HIGH; 30 is WATCH
  assert.equal(stockView({ currentStock: 150, avgPerDay: 10 }, AS_OF).risk, "HIGH");
  assert.equal(stockView({ currentStock: 299, avgPerDay: 10 }, AS_OF).risk, "HIGH");
  assert.equal(stockView({ currentStock: 300, avgPerDay: 10 }, AS_OF).risk, "WATCH");
});

test("restock numbers are the Consolidated sheet's, unchanged", () => {
  const r = row("Q", 100, 5, { stockIntransit: 20, orderPlaced: 30, qtyToRestock: 750, purchaseQty: 900, finalQtyToRestock: 900, comboQty: 12 });
  const p = analyzeGodown([r], hist("Q", () => 5), AS_OF).products[0];
  assert.equal(p.qtyToRestock, 750);
  assert.equal(p.purchaseQty, 900);
  assert.equal(p.finalQtyToRestock, 900);
  assert.equal(p.comboQty, 12);
  assert.equal(p.stockIntransit, 20);
  assert.equal(p.orderPlaced, 30);
  assert.equal(p.need180, 900);
});

test("product names match the Consolidated key (case and spaces)", () => {
  const a = analyzeGodown([row("Gluco  Spark Bare", 10, 1)], hist("gluco spark bare ", () => 3), AS_OF);
  assert.equal(a.products[0].units30, 90);
});

test("weekly and monthly totals carry covered days and flag partial periods", () => {
  const rows = hist("A", (i) => (i === 10 ? null : 2));
  const a = analyzeGodown([row("A", 10, 2)], rows, AS_OF);
  const sep = a.monthly.find((m) => m.start === "2026-09")!;
  assert.equal(sep.calendarDays, 19);   // 12–30 Sep
  assert.ok(sep.partial);
  assert.equal(sep.coveredDays, 18);    // 22 Sep missing
  assert.equal(sep.units, 36);
  const oct = a.monthly.find((m) => m.start === "2026-10")!;
  assert.equal(oct.coveredDays, 11);
  assert.equal(oct.ratePerDay, 2);
  assert.equal(mondayKey("2026-10-11"), "2026-10-05");
  assert.equal(mondayKey("2026-10-12"), "2026-10-12");
  const total = a.weekly.reduce((s, w) => s + w.units, 0);
  assert.equal(total, 29 * 2);
});

test("rules are the documented ones", () => {
  assert.equal(GA_RULES.highDays, 30);
  assert.equal(GA_RULES.seasonalityMinDays, 365);
});

test("history: mean and median per godown day, vs-avg, peak month, best month needs 7+ godown days", async () => {
  const { productHistory } = await import("./godownAnalytics.ts");
  // Sep 25–30: 6 days at 20/day (too few for best month); Oct 1–11: 10/day, but 3 Oct missing
  const m = new Map<string, number>();
  for (let d = 25; d <= 30; d++) m.set(`2026-09-${d}`, 20);
  for (let d = 1; d <= 11; d++) if (d !== 3) m.set(`2026-10-${String(d).padStart(2, "0")}`, 10);
  const h = productHistory(m, AS_OF, 12, "2026-09-30");
  assert.equal(h.coveredDays, 16);
  assert.equal(h.meanPerDay, (6 * 20 + 10 * 10) / 16);
  assert.equal(h.medianPerDay, 10);
  assert.equal(h.peakMonth, "2026-09");
  assert.equal(h.bestMonth?.month, "2026-10");           // Sep has only 6 godown days
  assert.equal(h.bestMonth?.coveredDays, 10);
  assert.equal(h.bestMonth?.partial, true);
  assert.equal(Math.round(h.vsAvgPct as number), -13);   // 12 vs 13.75
  const empty = productHistory(new Map(), AS_OF, null, null);
  assert.equal(empty.meanPerDay, null);
  assert.equal(empty.medianPerDay, null);
  assert.equal(empty.bestMonth, null);
});

test("recommendation follows risk first, then status", async () => {
  const { recommendation } = await import("./godownAnalytics.ts");
  const base = { risk: "OK" as const, status: "STABLE" as const, daysLeft: 90, finalQtyToRestock: 0, currentStock: 100, discontinued: false, growthPct: 5 };
  assert.match(recommendation({ ...base, risk: "CRITICAL", daysLeft: 7.6, finalQtyToRestock: 500 }), /^Restock now: about 7 days.*500/);
  assert.match(recommendation({ ...base, risk: "OUT OF STOCK" }), /^Out of stock/);
  assert.match(recommendation({ ...base, status: "DROPPING", growthPct: -40 }), /down 40%/);
  assert.match(recommendation({ ...base, status: "NO SALES", risk: "NOT SELLING", daysLeft: null }), /No sales in 30 days with 100 in stock/);
  assert.equal(recommendation({ ...base, discontinued: true, risk: "CRITICAL" }), "Discontinued — no restock.");
  assert.equal(recommendation(base), "No action needed.");
});

test("unusual days are flagged with original value and typical level, never removed from peak or averages", async () => {
  const { unusualDays } = await import("./godownAnalytics.ts");
  const rows = hist("U", (i) => (i === 20 ? 120 : i === 25 ? 19 * 5 : 3)); // 120 on one day; 95 is ≥20 and ≥5× too
  const flags = unusualDays(byDate(rows), AS_OF);
  assert.deepEqual(flags.map((f) => [f.date, f.units, f.typical]), [[addDays(AS_OF, -9), 120, 3], [addDays(AS_OF, -4), 95, 3]]);
  // below 20 units is never unusual, however big the ratio
  assert.deepEqual(unusualDays(byDate(hist("V", (i) => (i === 20 ? 19 : 1))), AS_OF), []);
  // too few selling days around it to judge → not flagged
  assert.deepEqual(unusualDays(byDate(hist("W", (i) => (i === 20 ? 100 : i % 4 === 0 ? 1 : 0))), AS_OF), []);
  const a = analyzeGodown([row("U", 500, 3)], rows, AS_OF).products[0];
  assert.equal(a.peakQty, 120);                       // peak is the real best day
  assert.equal(a.peakUnusual?.units, 120);            // …and says it is unusual
  assert.deepEqual(a.peakExUnusual, { qty: 3, date: AS_OF });
  assert.equal(a.units30, 120 + 95 + 28 * 3);         // still counted
});

test("renamed products count under their current name (evidence-backed aliases only)", () => {
  const rows: GodownDailyRow[] = [
    { date: "2026-08-20", product: "Teething tube combo (Green red yellow)", stockOut: 4, closing: 10 },
    { date: "2026-10-11", product: "Teething tube combo (Green,red,yellow)", stockOut: 2, closing: 8 },
  ];
  const p = analyzeGodown([row("Teething tube combo (Green,red,yellow)", 8, 1)], rows, AS_OF).products[0];
  assert.equal(p.peakQty, 4);
  assert.equal(p.peakDate, "2026-08-20");
  assert.equal(productSeries(rows, "Teething tube combo (Green,red,yellow)", "2026-08-20", "2026-08-20")[0].units, 4);
});

test("seasonality: gated on a year of history, from first sale, high/low months, year-on-year", async () => {
  const { seasonalityOf } = await import("./godownAnalytics.ts");
  const mk = (month: string, rate: number, coveredDays = 28) => ({ month, units: rate * coveredDays, coveredDays, daysInMonth: 30, ratePerDay: rate, partial: true });
  const months = [mk("2024-11", 0), mk("2024-12", 0), // before first sale: ignored
    ...["2025-01", "2025-02", "2025-03", "2025-04", "2025-05", "2025-06", "2025-07", "2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01"]
      .map((m) => mk(m, m.endsWith("-06") ? 20 : m.endsWith("-12") ? 4 : 10)), mk("2026-02", 12, 5) /* 5 godown days: unused */];
  assert.match(seasonalityOf(months, false, 62).text, /^Not available — 62 godown days/);
  const s = seasonalityOf(months, true, 600);
  assert.equal(s.ready, true);
  assert.equal(s.monthsUsed, 13);
  assert.deepEqual(s.highMonths, ["Jun"]);
  assert.deepEqual(s.lowMonths, ["Dec"]);
  assert.match(s.text, /^High: Jun\* · Low: Dec\* \(\* seen in one year only\)$/);
  assert.equal(s.yoyMonth, "2026-01");
  assert.equal(s.yoyPct, 0);
  assert.match(seasonalityOf(months.slice(0, 8), true, 600).text, /^Not enough history since first sale/);
  assert.match(seasonalityOf(months.map((m) => ({ ...m, ratePerDay: m.ratePerDay / 100, units: m.units / 100 })), true, 600).text, /^Too few sales/);
  const flat = months.map((m) => ({ ...m, ratePerDay: m.units ? 10 : 0 }));
  assert.equal(seasonalityOf(flat, true, 600).text, "No clear season (every month within ±30% of usual)");
});
