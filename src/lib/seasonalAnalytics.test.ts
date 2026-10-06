import test from "node:test";
import assert from "node:assert/strict";
import { analyze, detectSeasonality, addDays, daysBetween, type SeasonalPayload, type MonthPoint } from "./seasonalAnalytics.ts";

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
const recentStart = N - 28;

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
  assert.equal(Math.round(g.metrics.growthPct!), 125);
  assert.equal(g.metrics.changeStart, addDays(START, recentStart));
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
  assert.match(d.analysis.statusReason, /78% below/);
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

test("one historical spike does not move the baseline (median of weeks)", () => {
  const p = payload(START, END, [{ mk: "Amazon", sku: "X", product: "Spike once", f: (i) => (i === 30 ? 2000 : 20) }]);
  const m = analyze(p).masters[0];
  assert.equal(m.metrics.baseline, 20);
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
