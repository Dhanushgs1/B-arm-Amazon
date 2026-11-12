import test from "node:test";
import assert from "node:assert/strict";
import { addDaysIso } from "../bi/forecast.ts";
import { answerFromData, inrShort, periodOf } from "./chatAnswers.ts";
import type { BiDataset, Series } from "../bi/types.ts";

const START = "2026-07-01", N = 120;
const dates = Array.from({ length: N }, (_, i) => addDaysIso(START, i));
const asOf = dates[N - 1]; // 2026-10-28
const ser = (f: (i: number) => number | null): Series => dates.map((_, i) => f(i));

function dataset(): BiDataset {
  return {
    generatedAt: "x", asOf, dates,
    channels: [
      { id: "amazon", label: "Amazon", basis: "b", firstDate: START, dataThrough: asOf, revenue: ser(() => 10000), units: ser(() => 100), returns: ser(() => 5), returnsTracked: true },
      { id: "flipkart", label: "Flipkart", basis: "b", firstDate: START, dataThrough: asOf, revenue: ser(() => 4000), units: ser(() => 40), returns: ser(() => 2), returnsTracked: true },
    ],
    productDates: dates,
    products: [
      { channel: "amazon", sku: "A1", name: "Nebulizer Mesh Portable Silent Machine For Kids And Adults", category: null, units: dates.map(() => 3), revenue: dates.map(() => 900), returns: dates.map((_, i) => (i % 10 === 0 ? 1 : 0)) },
      { channel: "amazon", sku: "B2", name: "Chewy Tube", category: null, units: dates.map(() => 1), revenue: dates.map(() => 200), returns: dates.map(() => 0) },
      { channel: "flipkart", sku: "F1", name: "Lamp", category: null, units: dates.map(() => 2), revenue: dates.map(() => 500), returns: dates.map(() => 1) },
    ],
    ads: [{ id: "amazon", label: "Amazon Ads", spend: ser(() => 1000), sales: ser(() => 5000), adsThrough: asOf, salesBasis: "x" }],
    campaignWindow: { start: dates[N - 30], end: asOf, prevStart: dates[N - 60], prevEnd: dates[N - 31] },
    campaigns: [],
    stock: [{ sku: "A1", name: "Neb", available: 0, asOf }, { sku: "B2", name: "Chewy", available: 10, asOf }],
    warehouse: [],
    intervals: null,
    gstMultiplier: 1.18, errors: [], notes: [],
  };
}

test("inrShort uses lakh and crore", () => {
  assert.equal(inrShort(5_420_000), "₹54.2 L");
  assert.equal(inrShort(30_000_000), "₹3.00 Cr");
  assert.equal(inrShort(8450), "₹8,450");
});

test("periods: last month, named month, yesterday, last N days, default 30 days", () => {
  assert.deepEqual(periodOf("how much did we sell last month", "2026-10-28").w, { start: "2026-09-01", end: "2026-09-30", days: 30 });
  assert.deepEqual(periodOf("sales in august", "2026-10-28").w, { start: "2026-08-01", end: "2026-08-31", days: 31 });
  assert.deepEqual(periodOf("sales in november", "2026-10-28").w, { start: "2025-11-01", end: "2025-11-30", days: 30 }); // not in the future
  assert.deepEqual(periodOf("this month", "2026-10-28").w, { start: "2026-10-01", end: "2026-10-28", days: 28 });
  assert.deepEqual(periodOf("yesterday", "2026-10-28").w, { start: "2026-10-28", end: "2026-10-28", days: 1 });
  assert.deepEqual(periodOf("last 14 days", "2026-10-28").w.days, 14);
  assert.equal(periodOf("sales", "2026-10-28").explicit, false);
});

test("sales last month adds up every channel and splits them", () => {
  const a = answerFromData(dataset(), "How much did we sell last month?")!;
  // September: 30 days × (10,000 + 4,000)
  assert.match(a.text, /₹4\.2 L/);
  assert.match(a.text, /Amazon: \*\*₹3\.0 L\*\*/);
  assert.match(a.text, /Flipkart/);
});

test("sales for one channel only", () => {
  const a = answerFromData(dataset(), "flipkart revenue last 7 days")!;
  assert.match(a.text, /₹28,000/);
  assert.doesNotMatch(a.text, /Amazon/);
});

test("top products, out of stock, returns, ad spend", () => {
  const ds = dataset();
  assert.match(answerFromData(ds, "What are our top 2 products?")!.text, /1\. Nebulizer Mesh Portable Silent Machine For…/);
  const stock = answerFromData(ds, "Which products are out of stock?")!.text;
  assert.match(stock, /\*\*1\*\* selling products have \*\*0\*\* available/);
  assert.match(answerFromData(ds, "Which product has the most returns?")!.text, /Lamp \(flipkart\): \*\*30\*\* returns/);
  const ads = answerFromData(ds, "ad spend last 30 days")!.text;
  assert.match(ads, /₹30,000\*\* before GST/);
  assert.match(ads, /ROAS \*\*5\.00x\*\*/);
});

test("unrecognised questions go to AI", () => {
  assert.equal(answerFromData(dataset(), "write me a poem about nebulizers"), null);
  assert.equal(answerFromData(dataset(), "   "), null);
});

import { homeHeadlines, homeTiles, lastFullMonths } from "./headlines.ts";

test("home: last full month, headlines and tiles", () => {
  assert.deepEqual(lastFullMonths("2026-11-11"), { cur: { start: "2026-10-01", end: "2026-10-31", days: 31 }, prev: { start: "2026-09-01", end: "2026-09-30", days: 30 } });
  const ds = dataset();
  const h = homeHeadlines(ds);
  // September has 30 days to August's 31: Amazon −₹10,000, Flipkart −₹4,000
  assert.match(h[0].text, /^Sales fell \*\*3\.2%\*\* in September 2026, mostly \*\*Amazon\*\* \(−₹10,000\)/);
  assert.ok(h.some((x) => /\*\*1\*\* selling products have \*\*0\*\* FBA stock/.test(x.text)));
  const t = homeTiles(ds);
  assert.equal(t[0].label, "Sales · September 2026");
  assert.equal(t[0].value, "₹4.2 L");
  assert.equal(t.length, 5);
});

import { basisOf, comparableChannel, likeForLike } from "../bi/analytics.ts";

test("ERP months vs order-report months are compared on the order reports", () => {
  const ds = dataset();
  // Amazon: ERP figures (main series) 8,000 a day for Jul–Sep; the order reports say 10,000 every day
  ds.misCoverage = { amazon: { start: "2026-07-01", end: "2026-09-30" } };
  const amz = ds.channels[0];
  amz.orders = { revenue: amz.revenue.slice(), units: amz.units.slice(), returns: amz.returns.slice() };
  amz.revenue = dates.map((d) => (d <= "2026-09-30" ? 8000 : 10000));
  const sep = { start: "2026-09-01", end: "2026-09-30", days: 30 }, aug = { start: "2026-08-01", end: "2026-08-30", days: 30 };
  const oct = { start: "2026-10-01", end: "2026-10-28", days: 28 };
  assert.equal(basisOf(ds, "amazon", sep), "erp");
  assert.equal(basisOf(ds, "amazon", oct), "orders");
  assert.equal(basisOf(ds, "amazon", { start: "2026-09-20", end: "2026-10-05", days: 16 }), "mixed");
  assert.equal(comparableChannel(ds, amz, sep, aug), amz); // both ERP: the ERP figures
  assert.equal(comparableChannel(ds, amz, oct, { ...sep, days: 28, end: "2026-09-28" }).revenue, amz.orders.revenue);
  // October vs the 28 days before: 10,000 vs 10,000 on the order reports, not +25% against ERP's 8,000
  const lfl = likeForLike(ds, oct, { start: "2026-09-03", end: "2026-09-30", days: 28 }, ["amazon"]);
  assert.equal(lfl.revenuePct, 0);
});

import { dayOf, followUpQuestion } from "./chatAnswers.ts";

test("today, named days and follow-ups", () => {
  const asOf = "2026-10-28";
  assert.deepEqual(periodOf("today sales", asOf).w, { start: asOf, end: asOf, days: 1 });
  assert.match(periodOf("today sales", asOf).label, /latest day on file/);
  assert.equal(dayOf("sales on 10 nov", "2026-11-11"), "2026-11-10");
  assert.equal(dayOf("sales nov 5th", "2026-11-11"), "2026-11-05");
  assert.equal(dayOf("sales 05.11.2026", "2026-11-11"), "2026-11-05");
  assert.equal(dayOf("sales 15 dec", "2026-11-11"), "2025-12-15"); // not in the future
  assert.equal(dayOf("top 5 products", "2026-11-11"), null);
  assert.equal(dayOf("sales in august", "2026-11-11"), null);
  assert.deepEqual(periodOf("sales 10 oct", asOf).w, { start: "2026-10-10", end: "2026-10-10", days: 1 });
  // "today sales" answered for the latest day: 10,000 + 4,000
  assert.match(answerFromData(dataset(), "today sales")!.text, /₹14,000/);
  // "i ask today" after "sales last month" → sales for the latest day
  const f = followUpQuestion("i ask today", "How much did we sell last month?", asOf)!;
  assert.ok(f && !/last month/.test(f) && /today/.test(f));
  assert.match(answerFromData(dataset(), f)!.text, /₹14,000/);
  assert.equal(followUpQuestion("write a poem", "sales last month", asOf), null);
  assert.equal(followUpQuestion("flipkart sales yesterday", "sales last month", asOf), null); // already a full question
});

import { shopifyLiveLine } from "./chatAnswers.ts";

test("old website / offline channel is left out; 'website' means Shopify; Shopify live today", () => {
  const ds = dataset();
  ds.channels.push({ id: "barm", label: "B-ARM website & offline", basis: "b", firstDate: START, dataThrough: asOf, revenue: ser(() => 0), units: ser(() => 3), returns: ser(() => 0), returnsTracked: true });
  const a = answerFromData(ds, "sales last month")!.text;
  assert.doesNotMatch(a, /B-ARM website/);
  ds.channels.push({ id: "shopify", label: "Shopify", basis: "b", firstDate: START, dataThrough: asOf, revenue: ser(() => 0), units: ser(() => 0), returns: ser(() => null), returnsTracked: false });
  assert.match(answerFromData(ds, "sales last month")!.text, /Shopify: no orders/);
  assert.match(answerFromData(ds, "website sales yesterday")!.text, /^Shopify sales on/);
  const orders = [{ order_date: "2026-11-12", is_cancelled: false, total: 1500, item_quantity: 2 }, { order_date: "2026-11-12", is_cancelled: true, total: 900, item_quantity: 1 }, { order_date: "2026-11-11", is_cancelled: false, total: 700, item_quantity: 1 }];
  assert.equal(shopifyLiveLine(orders, "2026-11-12"), "Shopify today (12.11.2026, live): **1** order, **₹1,500**, 2 units.");
  assert.match(shopifyLiveLine(orders, "2026-11-13"), /no orders yet/);
});
