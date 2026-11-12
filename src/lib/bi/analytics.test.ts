import test from "node:test";
import assert from "node:assert/strict";
import { addDaysIso } from "./forecast.ts";
import {
  windowEnding, previousWindow, monthToDate, daysInMonth, totals, likeForLike, productRows, rankProducts,
  healthScore, buildInsights, channelForecasts, shopifyCompleteFrom, shortName, combineForecasts, monthEndEstimate, campaignFindings, adChannels,
} from "./analytics.ts";
import type { BiDataset, Series } from "./types.ts";

const START = "2026-07-01", N = 120;
const dates = Array.from({ length: N }, (_, i) => addDaysIso(START, i));
const asOf = dates[N - 1]; // 2026-10-28
const ser = (f: (i: number) => number | null): Series => dates.map((_, i) => f(i));

function dataset(): BiDataset {
  return {
    generatedAt: "x", asOf, dates,
    channels: [
      { id: "amazon", label: "Amazon", basis: "b", firstDate: START, dataThrough: asOf, revenue: ser((i) => 10000 + 50 * i), units: ser(() => 100), returns: ser(() => 5), returnsTracked: true },
      // Flipkart stops 3 days early: it must be left out of totals for windows that include those days
      { id: "flipkart", label: "Flipkart", basis: "b", firstDate: START, dataThrough: dates[N - 4], revenue: ser((i) => (i <= N - 4 ? 4000 : null)), units: ser((i) => (i <= N - 4 ? 40 : null)), returns: ser(() => 0), returnsTracked: true },
      // Shopify starts late: no like-for-like comparison against a window before it began
      { id: "shopify", label: "Shopify", basis: "b", firstDate: dates[100], dataThrough: asOf, revenue: ser((i) => (i >= 100 ? 2000 : null)), units: ser((i) => (i >= 100 ? 5 : null)), returns: ser(() => null), returnsTracked: false },
    ],
    productDates: dates,
    products: [
      { channel: "amazon", sku: "RISE", name: "Riser", category: null, units: dates.map((_, i) => (i >= N - 28 ? 2 + Math.floor((i - (N - 28)) / 7) * 3 : 2)), revenue: dates.map(() => 100), returns: dates.map(() => 0) },
      { channel: "amazon", sku: "FALL", name: "Faller", category: null, units: dates.map((_, i) => (i >= N - 28 ? 12 - Math.floor((i - (N - 28)) / 7) * 3 : 12)), revenue: dates.map(() => 100), returns: dates.map(() => 1) },
    ],
    ads: [{ id: "amazon", label: "Amazon", spend: ser(() => 1000), sales: ser(() => 5000), adsThrough: asOf, salesBasis: "x" }],
    campaignWindow: { start: dates[N - 30], end: asOf, prevStart: dates[N - 60], prevEnd: dates[N - 31] },
    campaigns: [
      { channel: "amazon", name: "Waste", spend: 3000, sales: 0, orders: 0, prevSpend: 1000, prevSales: 0 },
      { channel: "amazon", name: "Star", spend: 2000, sales: 20000, orders: 50, prevSpend: 2000, prevSales: 18000 },
    ],
    stock: [{ sku: "RISE", name: "Riser", available: 30, asOf }],
    gstMultiplier: 1.18, errors: [], notes: [],
  };
}

test("windows: month-to-date compares the same number of days; month lengths", () => {
  assert.deepEqual(monthToDate("2026-11-10"), { current: { start: "2026-11-01", end: "2026-11-10", days: 10 }, previous: { start: "2026-10-01", end: "2026-10-10", days: 10 } });
  assert.deepEqual(monthToDate("2026-03-31").previous, { start: "2026-02-01", end: "2026-02-28", days: 28 });
  assert.equal(daysInMonth("2026-02-10"), 28);
  assert.deepEqual(previousWindow(windowEnding("2026-10-30", 30)), { start: "2026-09-01", end: "2026-09-30", days: 30 });
});

test("totals leave out a channel with missing days (never counted as zero)", () => {
  const ds = dataset();
  const t = totals(ds, windowEnding(asOf, 7));
  assert.deepEqual(t.included, ["amazon", "shopify"]);
  assert.deepEqual(t.partial.map((p) => [p.id, p.covered]), [["flipkart", 4]]);
  const early = totals(ds, windowEnding(dates[N - 10], 7));
  assert.deepEqual(early.included, ["amazon", "flipkart", "shopify"]);
});

test("growth is like-for-like: a channel that did not exist in the earlier window is not counted as growth", () => {
  const ds = dataset();
  const w = windowEnding(dates[N - 10], 7);
  const l = likeForLike(ds, w, previousWindow(w));
  assert.deepEqual(l.channels, ["amazon", "flipkart"]);
  assert.ok(l.revenuePct !== null && l.revenuePct > 0 && l.revenuePct < 5);
});

test("product rankings: rules and stated reasons", () => {
  const ds = dataset();
  const rows = productRows(ds, 30);
  const r = rankProducts(rows);
  assert.deepEqual(r.gainingMomentum.map((p) => p.sku), ["RISE"]);
  assert.match(r.gainingMomentum[0].reason, /rose three weeks running: 14 → 35 → 56 → 77/);
  assert.deepEqual(r.declining.map((p) => p.sku), ["FALL"]);
  assert.deepEqual(r.stockRisk.map((p) => p.sku), ["RISE"]);
  assert.match(r.stockRisk[0].reason, /30 units available in FBA on 28.10.2026/);
  assert.deepEqual(r.highReturns.map((p) => p.sku), ["FALL"]);
});

test("forecasts: channels combine; month-end estimate is at least what is already sold", () => {
  const ds = dataset();
  const fs = channelForecasts(ds);
  const c = combineForecasts(fs, 30);
  assert.ok(c.revenue && c.revenue.low <= c.revenue.total && c.revenue.total <= c.revenue.high);
  assert.ok(c.channels.includes("amazon"));
  assert.ok(c.skipped.some((s) => s.id === "shopify")); // too little history to forecast
  const me = monthEndEstimate(ds, fs);
  assert.equal(me.month, "2026-10");
  assert.ok(me.estimate >= me.actualSoFar && me.low >= me.actualSoFar);
});

test("advertising, health score and insights are built from the data and labelled", () => {
  const ds = dataset();
  const w = windowEnding(asOf, 30);
  const ad = adChannels(ds, w)[0];
  assert.equal(ad.roas, 5);
  assert.equal(ad.acos, 20);
  assert.ok(Math.abs(ad.spendGst! - 35400) < 1e-6);
  const f = campaignFindings(ds);
  assert.deepEqual(f.wasted.map((c) => c.name), ["Waste"]);
  assert.deepEqual(f.strong.map((c) => c.name), ["Star"]);
  const h = healthScore(ds, w);
  assert.ok(h.score !== null && h.score >= 0 && h.score <= 100);
  assert.equal(h.parts.reduce((s, p) => s + p.weight, 0), 100);
  const ins = buildInsights(ds, w);
  assert.ok(ins.some((i) => i.kind === "recommendation" && /Waste/.test(i.title)));
  assert.ok(ins.some((i) => i.kind === "estimate"));
  assert.ok(ins.every((i) => i.period.length > 0));
});

test("Shopify history counts from where order numbers become continuous", () => {
  const o = (n: number, d: string) => ({ order_number: n, order_date: d });
  // #1023–#1043 never captured; #1049 and #1051–1052 small gaps (deleted/test orders) are tolerated
  const orders = [o(1011, "2026-09-17"), o(1022, "2026-09-28"), o(1044, "2026-10-12"), o(1048, "2026-10-14"), o(1050, "2026-10-15"), o(1053, "2026-10-16"), o(1054, "2026-10-17")];
  assert.equal(shopifyCompleteFrom(orders), "2026-10-12");
  assert.equal(shopifyCompleteFrom([]), null);
  // an odd high number entered by hand does not hide the real newest order
  assert.equal(shopifyCompleteFrom([...orders, o(9999, "2026-10-10")]), "2026-10-12");
});

test("product names in insight titles are shortened", () => {
  assert.equal(shortName("B-Arm Digital Infrared Thermometer | 1 Sec Quick Read"), "B-Arm Digital Infrared Thermometer | 1…");
  assert.equal(shortName("Flange Finder Kit"), "Flange Finder Kit");
});

test("month-end estimate: a channel last uploaded in the previous month only forecasts this month's days", () => {
  const ds2 = dataset();
  const dd: string[] = [];
  for (let d = "2026-08-01"; d <= "2026-11-09"; d = addDaysIso(d, 1)) dd.push(d);
  const through = "2026-10-29";
  const flat: Series = dd.map((d) => (d <= through ? 1000 : null));
  ds2.asOf = "2026-11-09"; ds2.dates = dd;
  ds2.channels = [{ ...ds2.channels[0], dataThrough: through, firstDate: dd[0], revenue: flat, units: flat, returns: flat }];
  const me = monthEndEstimate(ds2, channelForecasts(ds2));
  // 30 November days at about 1,000 a day; the 2 October days after the last upload are not counted
  assert.ok(Math.abs(me.estimate - 30000) < 300, `estimate ${me.estimate}`);
  assert.equal(me.actualSoFar, 0);
});
