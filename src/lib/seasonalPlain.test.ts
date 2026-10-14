import test from "node:test";
import assert from "node:assert/strict";
import { analyze, addDays, daysBetween, type SeasonalPayload, type Seasonality } from "./seasonalAnalytics.ts";
import { marketplaceInsight, perDay, units, salesChangeText, seasonalityText, stockLeft, whyText, recommendationText, findings } from "./seasonalPlain.ts";

const START = "2026-04-15", END = "2026-10-01";
const N = daysBetween(START, END) + 1, recentStart = N - 30;

function payload(skus: { mk: string; sku: string; f: (i: number) => number }[], stock: number | null): SeasonalPayload {
  const daily: [number, string, number][] = [];
  skus.forEach((s, idx) => { for (let i = 0; i < N; i++) { const u = s.f(i); if (u) daily.push([idx, addDays(START, i), u]); } });
  const dates: string[] = [];
  for (let d = START; d <= END; d = addDays(d, 1)) dates.push(d);
  return {
    skus: skus.map((s) => [s.mk, s.sku, "Kit", true]), daily,
    coverage: [...new Set(skus.map((s) => s.mk))].map((mk) => ({ marketplace: mk, first_date: START, last_date: END, days_with_data: dates.length, dates })),
    quality: [], unmatched: [], stock_now: stock === null ? [] : [["Kit", stock]], stock_daily: [], ad_daily: [],
  };
}
const TECH = /baseline|product_forecast|usable month|SKU-level|concentration|units\/day\)|n\/a/i;

test("popup wording: 172 units ÷ 32.4 units/day → '5.3 days' and the same number drives the recommendation", () => {
  // usual 17.5/day; last 4 weeks 32.4/day across two SKUs → growing fast, ~5 days of stock
  const m = analyze(payload([
    { mk: "Amazon", sku: "K-1", f: (i) => (i >= recentStart ? 20.4 : 10) },
    { mk: "Flipkart", sku: "K-2", f: (i) => (i >= recentStart ? 12 : 7.5) },
  ], 172)).masters[0];
  assert.equal(perDay(m.metrics.currentAvg), "32.4 units/day");
  assert.equal(units(m.currentStock), "172 units");
  const left = stockLeft(m.stockCoverage);
  assert.equal(left.value, "5.3 days");
  assert.equal(left.sub, "at current sales rate (172 ÷ 32.4)");
  assert.ok(left.low);
  const rec = recommendationText(m.analysis, m.stockCoverage);
  assert.equal(rec[0], "Reorder now — only about 5 days of stock remain at the current sales rate.");
  assert.equal(rec[1], "Sales are growing strongly — keep enough stock available.");
  assert.equal(whyText(m.analysis), "Sales have been consistently higher than usual.");
  const f = findings(m.metrics, m.analysis, { stock: m.currentStock, coverage: m.stockCoverage });
  assert.ok(f.includes("Sales are currently 32.4 units/day."));
  assert.ok(f.includes("Current stock is 172 units."));
  assert.ok(f.includes("At the current sales rate, about 5.3 days of stock remain."));
  assert.ok(f.includes("Seasonality cannot be confirmed yet because there is not enough historical data."));
  for (const line of [...f, ...rec, whyText(m.analysis), left.value, left.sub]) assert.doesNotMatch(line, TECH, line);
});

test("zero and missing values are explicit, never silently zero", () => {
  assert.equal(perDay(0), "0 units/day");
  assert.equal(perDay(null), "Data unavailable");
  assert.equal(units(0), "0 units");
  assert.equal(units(null), "Data unavailable");

  const out = analyze(payload([{ mk: "Amazon", sku: "K", f: () => 5 }], 0)).masters[0];
  assert.deepEqual(stockLeft(out.stockCoverage), { value: "0 days", sub: "Out of stock", low: true });
  assert.equal(recommendationText(out.analysis, out.stockCoverage)[0], "Out of stock — reorder now.");
  assert.ok(findings(out.metrics, out.analysis, { stock: 0, coverage: out.stockCoverage }).includes("The product is out of stock."));

  const idle = analyze(payload([{ mk: "Amazon", sku: "K", f: (i) => (i < recentStart ? 5 : 0) }], 50)).masters[0];
  assert.deepEqual(stockLeft(idle.stockCoverage), { value: "Stock coverage unavailable", sub: "No sales — coverage cannot be calculated", low: false });

  const none = analyze(payload([{ mk: "Amazon", sku: "K", f: () => 5 }], null)).masters[0];
  assert.equal(stockLeft(none.stockCoverage).sub, "Stock data unavailable");
  assert.equal(recommendationText(none.analysis, none.stockCoverage)[0], "Sales are stable — continue monitoring.");
});

test("sales change and seasonality read as plain sentences", () => {
  assert.equal(salesChangeText(85.2), "Sales are 85% higher than usual");
  assert.equal(salesChangeText(-30), "Sales are 30% lower than usual");
  assert.equal(salesChangeText(null), "Not enough history to compare");
  const s = (o: Partial<Seasonality>): Seasonality => ({ determinable: true, yearsObserved: 2, recurringHigh: [], recurringLow: [], label: "", evidence: [], confidence: "HIGH", observedPeakMonth: null, observedLowMonth: null, ...o });
  assert.equal(seasonalityText(s({ determinable: false })), "Not enough history to confirm a seasonal pattern.");
  assert.equal(seasonalityText(s({ recurringHigh: [9] })), "Seasonal pattern detected: sales usually increase during September.");
  assert.equal(seasonalityText(s({})), "No clear seasonal pattern found.");
});

test("marketplace comparison: same status rules per marketplace, and a plain 'up here, down there' insight", () => {
  const r = analyze(payload([
    { mk: "Amazon", sku: "A", f: (i) => (i >= recentStart ? 30 : 10) }, // +200%, sustained
    { mk: "Flipkart", sku: "F", f: (i) => (i >= recentStart ? 4 : 10) }, // −60%, sustained
    { mk: "Meesho", sku: "M", f: () => 8 }, // steady
  ], 500));
  const m = r.masters[0];
  const by = Object.fromEntries(m.byMarketplace.map((x) => [x.marketplace, x]));
  assert.equal(by.Amazon.status, "HIGH GROWTH");
  assert.equal(by.Flipkart.status, "DEMAND DROP");
  assert.equal(by.Meesho.status, "STABLE");
  const g = (before: number, after: number) => Math.round((after / ((before * recentStart + after * (N - recentStart)) / N) - 1) * 100);
  assert.equal(Math.round(by.Amazon.growth!), g(10, 30));
  assert.equal(Math.round(by.Flipkart.growth!), g(10, 4));
  // slices add back up to the product (constant weeks, so medians add exactly)
  assert.ok(Math.abs(m.byMarketplace.reduce((a, x) => a + x.recent!, 0) - m.metrics.recentAvg!) < 1e-9);
  assert.equal(marketplaceInsight(m.byMarketplace)!.text, `Selling well on Amazon (+${g(10, 30)}%) but falling on Flipkart (${g(10, 4)}%).`);

  // filtered to one marketplace → one slice, nothing to compare
  const amazonOnly = analyze(payload([{ mk: "Amazon", sku: "A", f: () => 5 }, { mk: "Flipkart", sku: "F", f: () => 5 }], 50), { marketplaces: ["Amazon"] }).masters[0];
  assert.equal(amazonOnly.byMarketplace.length, 1);
  assert.equal(marketplaceInsight(amazonOnly.byMarketplace), null);
  assert.equal(amazonOnly.stockCoverage.kind, "scope-mismatch");
});

test("marketplace insight wording for one-sided and uniform trends", () => {
  const sl = (marketplace: string, status: Parameters<typeof marketplaceInsight>[0][number]["status"], growth: number | null) => ({ marketplace, status, growth, current: 1, recent: 1, baseline: 1, totalUnits: 1 });
  assert.equal(marketplaceInsight([sl("Amazon", "HIGH GROWTH", 80), sl("Flipkart", "STABLE", 5)])!.text, "Growing only on Amazon (+80%) — steady on Flipkart.");
  assert.equal(marketplaceInsight([sl("Amazon", "STABLE", 0), sl("Meesho", "DEMAND DROP", -50)])!.text, "Falling only on Meesho (-50%) — steady on Amazon.");
  assert.equal(marketplaceInsight([sl("Amazon", "HIGH GROWTH", 80), sl("Flipkart", "UNUSUAL SPIKE", 90)])!.kind, "all-up");
  assert.equal(marketplaceInsight([sl("Amazon", "STABLE", 0), sl("Flipkart", "STABLE", 3)]), null);
  assert.equal(marketplaceInsight([sl("Amazon", "HIGH GROWTH", 80), sl("Meesho", "LOW VOLUME", null)]), null); // too few sales to compare
});
