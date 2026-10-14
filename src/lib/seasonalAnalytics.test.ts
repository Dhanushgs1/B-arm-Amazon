import test from "node:test";
import assert from "node:assert/strict";
import { analyze, detectSeasonality, addDays, daysBetween, coverageText, contributionSummary, type SeasonalPayload, type MonthPoint } from "./seasonalAnalytics.ts";

// Builds a payload: each sku gets a function day-index -> units (null = no row that day).
function payload(start: string, end: string, skus: { mk: string; sku: string; product: string | null; f: (i: number) => number | null }[], opts: { coverage?: Record<string, [string, string]>; stockNow?: [string, number][] } = {}): SeasonalPayload {
  const n = daysBetween(start, end) + 1;
  const daily: [number, string, number][] = [];
  const mkts = [...new Set(skus.map((s) => s.mk))];
  skus.forEach((s, idx) => {
    for (let i = 0; i < n; i++) {
      const u = s.f(i);
      const d = addDays(start, i);
      const r = opts.coverage?.[s.mk];
      if (r && (d < r[0] || d > r[1])) continue;
      if (u !== null && u !== 0) daily.push([idx, d, u]);
    }
  });
  return {
    skus: skus.map((s) => [s.mk, s.sku, s.product ?? "Unknown", s.product !== null]),
    daily,
    coverage: mkts.map((mk) => {
      const [a, b] = opts.coverage?.[mk] ?? [start, end];
      const dates: string[] = [];
      for (let d = a; d <= b; d = addDays(d, 1)) dates.push(d);
      return { marketplace: mk, first_date: a, last_date: b, days_with_data: dates.length, dates };
    }),
    quality: [], unmatched: [], stock_now: opts.stockNow ?? [], stock_daily: [], ad_daily: [],
  };
}

const START = "2026-04-15", END = "2026-10-01";
const N = daysBetween(START, END) + 1;
const recentStart = N - 30; // step changes line up with the 30-day "recent" window

test("stable product stays STABLE and the master groups its SKUs across marketplaces", () => {
  const p = payload(START, END, [
    { mk: "Amazon", sku: "A-1", product: "BP Monitor", f: () => 10 },
    { mk: "Flipkart", sku: "F-1", product: "BP Monitor", f: () => 5 },
  ]);
  const r = analyze(p);
  assert.equal(r.masters.length, 1);
  const m = r.masters[0];
  assert.deepEqual(m.skuIds.sort(), ["A-1", "F-1"]);
  assert.equal(m.metrics.baseline, 15);
  assert.equal(m.metrics.recentAvg, 15);
  assert.equal(m.analysis.status, "STABLE");
  assert.equal(r.skus.length, 2);
});

test("sustained growth is HIGH GROWTH with a start date; a single-day spike is not", () => {
  const p = payload(START, END, [
    { mk: "Amazon", sku: "G", product: "Grower", f: (i) => (i >= recentStart ? 45 : 20) },
    { mk: "Amazon", sku: "S", product: "Spiker", f: (i) => (i === N - 3 ? 300 : 20) },
  ]);
  const r = analyze(p);
  const g = r.masters.find((m) => m.master === "Grower")!;
  assert.equal(g.analysis.status, "HIGH GROWTH");
  assert.equal(g.analysis.pattern, "Sustained");
  assert.equal(Math.round(g.metrics.growthPct!), Math.round((45 / (((20) * recentStart + (45) * (N - recentStart)) / N) - 1) * 100)); // recent vs overall average
  assert.equal(g.metrics.changeStart, addDays(START, N - 28)); // found by walking back whole weeks
  assert.equal(g.metrics.changeDurationDays, 28);
  const s = r.masters.find((m) => m.master === "Spiker")!;
  assert.notEqual(s.analysis.status, "HIGH GROWTH");
  assert.equal(s.analysis.status, "UNUSUAL SPIKE");
  assert.equal(s.analysis.pattern, "Short-term");
});

test("demand drop: sustained vs temporary, and reasons are never invented", () => {
  const p = payload(START, END, [
    { mk: "Amazon", sku: "D", product: "Dropper", f: (i) => (i >= recentStart ? 10 : 45) },
    { mk: "Amazon", sku: "T", product: "Dipper", f: (i) => (i >= N - 7 ? 2 : 30) },
  ]);
  const r = analyze(p);
  const d = r.masters.find((m) => m.master === "Dropper")!;
  assert.equal(d.analysis.status, "DEMAND DROP");
  assert.equal(d.analysis.pattern, "Sustained");
  assert.match(d.analysis.statusReason, new RegExp(`${Math.round((1 - 10 / (((45) * recentStart + (10) * (N - recentStart)) / N)) * 100)}% below the overall average`));
  assert.match(d.analysis.likelyReason, /cause not confirmed/i);
  const t = r.masters.find((m) => m.master === "Dipper")!;
  assert.equal(t.analysis.status, "UNUSUAL DECLINE");
  assert.equal(t.analysis.likelyReason, "Cause not confirmed from available data.");
});

test("current stock at zero is cited as inventory evidence for a drop", () => {
  const p = payload(START, END, [{ mk: "Amazon", sku: "D", product: "Dropper", f: (i) => (i >= recentStart ? 10 : 45) }], { stockNow: [["Dropper", 0]] });
  const d = analyze(p).masters[0];
  assert.match(d.analysis.likelyReason, /low inventory availability/);
  assert.ok(d.analysis.evidence.some((e) => e.includes("Current Stock = 0")));
  assert.notEqual(d.analysis.confidence, "HIGH");
});

test("usual sales = overall average: a one-off spike lifts it a little but is not growth", () => {
  const p = payload(START, END, [{ mk: "Amazon", sku: "X", product: "Spike once", f: (i) => (i === 30 ? 2000 : 20) }]);
  const m = analyze(p).masters[0];
  assert.ok(Math.abs(m.metrics.baseline! - (20 * (N - 1) + 2000) / N) < 1e-9);
  assert.equal(m.metrics.peakQty, 2000);
  assert.equal(m.metrics.peakDate, addDays(START, 30));
  assert.equal(m.analysis.status, "STABLE");
});

test("insufficient history and low volume are labelled, not classified", () => {
  const p = payload("2026-09-01", END, [{ mk: "Amazon", sku: "N", product: "New", f: () => 10 }]);
  assert.equal(analyze(p).masters[0].analysis.status, "INSUFFICIENT DATA");
  const q = payload(START, END, [{ mk: "Amazon", sku: "L", product: "Rare", f: (i) => (i % 20 === 0 ? 1 : 0) }]);
  assert.equal(analyze(q).masters[0].analysis.status, "LOW VOLUME");
});

test("missing days are not zeros: a marketplace that starts later does not fake growth", () => {
  const p = payload(START, END, [
    { mk: "Amazon", sku: "A", product: "Mixed", f: () => 10 },
    { mk: "Meesho", sku: "M", product: "Mixed", f: () => 10 },
  ], { coverage: { Meesho: ["2026-07-01", END] } });
  const r = analyze(p);
  const m = r.masters[0];
  assert.equal(m.analysis.status, "STABLE");
  assert.deepEqual(m.metrics.excludedMarketplaces, []); // Meesho covers ≥ half of baseline and all of recent
  assert.equal(m.metrics.baseline, 20);
  // a day before Meesho's data is missing for Meesho, not 0
  const meesho = r.skus.find((s) => s.marketplace === "Meesho")!;
  assert.equal(meesho.metrics.coveredDays, daysBetween("2026-07-01", END) + 1);
});

test("unmapped SKUs are kept apart, never merged into a master", () => {
  const p = payload(START, END, [
    { mk: "Amazon", sku: "OK", product: "Real", f: () => 5 },
    { mk: "Amazon", sku: "??", product: null, f: () => 5 },
  ]);
  const r = analyze(p);
  assert.equal(r.masters.length, 1);
  assert.equal(r.unmapped.length, 1);
  assert.deepEqual(r.quality.unmappedSkus, ["Amazon|??"]);
});

test("seasonality needs the same month in two years; one year is not determinable", () => {
  const mk = (month: string, rate: number): MonthPoint => ({ month, units: rate * 30, coveredDays: 30, daysInMonth: 30, rate, complete: true });
  const oneYear = detectSeasonality(["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"].map((m) => mk(m, m.endsWith("10") ? 90 : 30)));
  assert.equal(oneYear.determinable, false);
  assert.deepEqual(oneYear.recurringHigh, []);
  const months = ["07", "08", "09", "10", "11"];
  const twoYears = detectSeasonality(["2024", "2025"].flatMap((y) => months.map((m) => mk(`${y}-${m}`, m === "10" ? 80 : 30))));
  assert.equal(twoYears.determinable, true);
  assert.deepEqual(twoYears.recurringHigh, [10]);
  assert.equal(twoYears.confidence, "MEDIUM");
});

test("peak approaching fires in September when October recurs high", () => {
  // two prior years with an October peak, analysed as of mid-September of the third
  const start = "2024-07-01", end = "2026-09-15";
  const p = payload(start, end, [{ mk: "Amazon", sku: "P", product: "Peaky", f: (i) => (addDays(start, i).slice(5, 7) === "10" ? 60 : 20) }]);
  const m = analyze(p).masters[0];
  assert.deepEqual(m.analysis.seasonality.recurringHigh, [10]);
  assert.equal(m.analysis.peakApproaching, true);
  assert.ok(m.analysis.evidence.some((e) => /not a forecast/.test(e)));
});

test("stock coverage = total stock ÷ total current sales of the same SKUs (172 ÷ 32.4 ≈ 5.3 days)", () => {
  // two SKUs of one master: 20.4 + 12 = 32.4 units/day combined
  const p = payload(START, END, [
    { mk: "Amazon", sku: "A-1", product: "Glucometer", f: () => 20.4 },
    { mk: "Flipkart", sku: "F-1", product: "Glucometer", f: () => 12 },
  ], { stockNow: [["Glucometer", 172]] });
  const g = analyze(p).masters[0];
  assert.equal(Math.round(g.metrics.currentAvg! * 10) / 10, 32.4);
  assert.equal(g.currentStock, 172);
  assert.equal(g.stockCoverage.kind, "ok");
  if (g.stockCoverage.kind !== "ok") return;
  assert.equal(Math.round(g.stockCoverage.days * 10) / 10, 5.3);
  assert.equal(g.stockCoverage.days, g.currentStock! / g.metrics.currentAvg!); // reconciles with the shown numbers
  assert.equal(coverageText(g.stockCoverage), "5.3 days at current sales rate");
  assert.match(g.analysis.recommendation, /^Reorder now — approximately 5 days of stock remaining/);
  assert.notEqual(g.stockCoverage.days, g.metrics.coveredDays); // not the days-of-history count
});

test("stock coverage handles zero sales, missing stock and a marketplace-subset scope", () => {
  const zero = analyze(payload(START, END, [{ mk: "Amazon", sku: "Z", product: "Idle", f: (i) => (i < recentStart ? 5 : 0) }], { stockNow: [["Idle", 50]] })).masters[0];
  assert.equal(zero.stockCoverage.kind, "no-sales");
  assert.equal(coverageText(zero.stockCoverage), "No sales — coverage cannot be calculated");

  const noStock = analyze(payload(START, END, [{ mk: "Amazon", sku: "N", product: "Unstocked", f: () => 5 }])).masters[0];
  assert.equal(coverageText(noStock.stockCoverage), "Stock data unavailable");

  // stock is product-level across marketplaces; Amazon-only sales would overstate coverage
  const p = payload(START, END, [
    { mk: "Amazon", sku: "A-1", product: "Glucometer", f: () => 20 },
    { mk: "Flipkart", sku: "F-1", product: "Glucometer", f: () => 12 },
  ], { stockNow: [["Glucometer", 172]] });
  assert.equal(analyze(p, { marketplaces: ["Amazon"] }).masters[0].stockCoverage.kind, "scope-mismatch");
  assert.equal(analyze(p).masters[0].stockCoverage.kind, "ok");
});

test("contribution to change reconciles with SKU data and the master's change", () => {
  // baseline 10/day each; recent 4 weeks: +7.7, +5.8, +1.9, +2.1, −1.5 units/day
  const lifts = { "K-1": 7.7, "K-3": 5.8, "K-2": 1.9, "K-4": 2.1, "K-5": -1.5 } as Record<string, number>;
  const p = payload(START, END, Object.entries(lifts).map(([sku, lift]) => ({ mk: "Amazon", sku, product: "Insem kit", f: (i: number) => (i >= recentStart ? 10 + lift : 10) })));
  const r = analyze(p);
  const m = r.masters[0];
  const cs = contributionSummary(m);
  const sku = (k: string) => r.skus.find((s) => s.key === `Amazon|${k}`)!;
  const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

  for (const [k, lift] of Object.entries(lifts)) {
    const s = sku(k), row = cs.rows.get(`Amazon|${k}`)!;
    close(row.deltaPerDay, s.metrics.recentAvg! - s.metrics.baseline!); // change = Recent 4-wk − Hist. avg
    close(row.deltaPerDay, lift * (1 - (N - recentStart) / N)); // recent − overall average (which includes the recent month)
    close(s.metrics.growthPct!, ((s.metrics.recentAvg! - s.metrics.baseline!) / s.metrics.baseline!) * 100); // Growth %
    if (lift > 0) close(row.sharePct!, (row.deltaPerDay / cs.increase) * 100); // share of the CHANGE, not of sales
    else assert.equal(row.sharePct, null); // opposite direction: no share
  }
  const k = 1 - (N - recentStart) / N;
  close(cs.increase, 17.5 * k); close(cs.decrease, -1.5 * k); close(cs.netSkuChange, 16 * k);
  close(cs.masterChange!, cs.netSkuChange); // constant weeks → medians add up, so it matches exactly
  const shown = [...cs.rows.values()].filter((x) => x.shareShown !== null).map((x) => x.shareShown!);
  assert.equal(shown.reduce((a, b) => a + b, 0), 100);
  assert.deepEqual(cs.drivers.map((d) => [d.key, d.shareShown]), [["Amazon|K-1", 44], ["Amazon|K-3", 33], ["Amazon|K-4", 12]]);
});
