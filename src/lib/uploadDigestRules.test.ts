import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDigest, channelDay, digestDay, digestWaitingFor, type DigestInput } from "./uploadDigestRules.ts";

const period = (sales: number, orders: number) => ({ sales, units: orders, orders, allReturns: 0, customerReturns: 0, netOrders: orders, adSpendTax: null });
const summary = (day: string, sales: number, orders: number, prevSales: number) => ({
  current: period(sales, orders), previous: period(prevSales, 0),
  currentRange: { start: day, end: day }, previousRange: { start: day, end: day }, dataThrough: day,
});
const ad = (date: string, id: string, spend: number, sales: number) => ({ date, id, name: id, spend, sales, orders: 1 });
const spend = (total: number, campaigns: { name: string; spend: number; clicks: number }[] = []) => ({ days: [], campaigns, coveredDays: 1, totalDays: 1, spend: total, clicks: 0 });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const detail = (sales: number, netOrders: number): any => ({ source: "x", orders: [], netOrders, sales, aov: 0, spend: null, coveredNetOrders: netOrders, coveredSales: sales, roas: null, costPerOrder: null, cpc: null, daily: [] });

test("the digest day is yesterday in IST", () => {
  assert.equal(digestDay(new Date("2026-11-13T07:00:00Z")), "2026-11-12"); // 12:30 IST on the 13th
  assert.equal(digestDay(new Date("2026-11-12T19:00:00Z")), "2026-11-12"); // 00:30 IST on the 13th
  assert.equal(digestDay(new Date("2026-11-12T18:00:00Z")), "2026-11-11"); // 23:30 IST on the 12th
});

test("a marketplace shows the newest day that has both orders and ads", () => {
  assert.equal(channelDay("2026-11-12", "2026-11-12", "2026-11-12"), "2026-11-12");
  assert.equal(channelDay("2026-11-12", "2026-11-11", "2026-11-12"), "2026-11-12"); // ads in, orders not yet: the day, orders show 0
  assert.equal(channelDay("2026-11-12", "2026-11-11", "2026-11-10"), "2026-11-10"); // both trail: the newest day with both
  assert.equal(channelDay("2026-11-12", "2026-11-12", "2026-11-01"), null);         // too old to show
  assert.equal(channelDay("2026-11-12", null, "2026-11-12"), "2026-11-12"); // ads in, no order rows at all: orders show 0
  assert.equal(channelDay("2026-11-12", null, "2026-11-10"), null);
});

test("names the uploads still missing", () => {
  assert.deepEqual(digestWaitingFor({ workbook: true, google: true, meta: true }), []);
  assert.deepEqual(digestWaitingFor({ workbook: true, google: false, meta: false }), ["Google Ads", "Meta ads"]);
  assert.deepEqual(digestWaitingFor({ workbook: false, google: true, meta: true }), ["the Last 7 days workbook"]);
});

const D = "2026-11-12";
const input = (): DigestInput => ({
  day: D,
  markets: [
    { key: "amazon", label: "Amazon", day: D, summary: summary(D, 100000, 200, 80000),
      ads: [ad(D, "Good", 1000, 10000), ad(D, "Bad", 800, 1000), ad(D, "Tiny", 50, 0), ad("2026-11-11", "Good", 900, 9000)] },
    { key: "flipkart", label: "Flipkart", day: "2026-11-10", summary: summary("2026-11-10", 30000, 60, 30000), ads: [ad("2026-11-10", "FK", 500, 2500)] },
    { key: "meesho", label: "Meesho", day: null, summary: null, ads: [] },
  ],
  shopify: summary(D, 20000, 10, 10000),
  paid: [
    { key: "google", label: "Google Ads", now: spend(2000, [{ name: "Search", spend: 1500, clicks: 90 }, { name: "PMax", spend: 500, clicks: 0 }]), before: spend(1000), detail: detail(8000, 4), prevDetail: detail(4000, 2) },
    { key: "meta", label: "Meta Ads", now: spend(1000), before: spend(1000), detail: detail(0, 0), prevDetail: detail(0, 0) },
  ],
});

test("one row per channel, in order, each for its own day", () => {
  const d = buildDigest(input());
  assert.deepEqual(d.rows.map((r) => r.key), ["amazon", "flipkart", "meesho", "shopify", "google", "meta"]);
  const [am, fk, ms, shop, google, meta] = d.rows;
  assert.deepEqual([am.sales, am.orders, am.adSpend, am.adSales, am.late], [100000, 200, 1850, 11000, false]); // the 11th's ad row is not the 12th's
  assert.equal(am.salesGrowth, 25);
  assert.deepEqual([fk.day, fk.late, fk.sales], ["2026-11-10", true, 30000]);
  assert.deepEqual([ms.day, ms.late, ms.sales, ms.orders, ms.adSpend], [D, false, 0, 0, 0]); // no data at all: marked 0
  assert.deepEqual([shop.sales, shop.adSpend, shop.salesGrowth], [20000, null, 100]); // its ads are the Google / Meta rows
  assert.deepEqual([google.sales, google.orders, google.adSpend, google.adSales, google.roas, google.acos], [null, 4, 2000, 8000, 4, 25]);
  assert.deepEqual([meta.adSales, meta.roas, meta.acos], [0, 0, null]);
});

test("totals are the digest day only: late channels stay out, Google / Meta sales are not added twice", () => {
  const t = buildDigest(input()).total;
  assert.equal(t.sales, 120000);        // Amazon + Shopify; Flipkart is the 10th's, Google's 8,000 is inside Shopify
  assert.equal(t.orders, 210);
  assert.equal(t.salesGrowth, (120000 - 90000) / 90000 * 100);
  assert.equal(t.adSpend, 4850);        // Amazon 1,850 + Google 2,000 + Meta 1,000
  assert.equal(t.adSales, 19000);
  assert.equal(Math.round(t.adSpendGst), 5723);
  assert.equal(Math.round(t.tacos! * 100) / 100, Math.round((4850 * 1.18 / 120000) * 10000) / 100);
});

test("late and missing channels are explained; campaigns are judged on the channel's day", () => {
  const d = buildDigest(input());
  assert.equal(d.lateNotes.length, 2);
  assert.match(d.lateNotes[0], /Flipkart: latest data is 10\.11\.2026/);
  assert.equal(d.lateNotes[1], "Meesho: data for 12.11.2026 is not available — marked as 0.");
  const am = d.campaigns.find((c) => c.key === "amazon")!;
  assert.deepEqual(am.best.map((c) => c.name), ["Good"]);  // ACOS 10%
  assert.deepEqual(am.losing.map((c) => c.name), ["Bad"]); // ACOS 80%; "Tiny" is under the minimum spend
  const google = d.campaigns.find((c) => c.key === "google")!;
  assert.equal(google.spendOnly, true);
  assert.deepEqual(google.top.map((c) => [c.name, c.spend, c.clicks]), [["Search", 1500, 90], ["PMax", 500, null]]);
  assert.equal(d.campaigns.some((c) => c.key === "meta" || c.key === "meesho"), false); // nothing to list
  assert.ok(d.good.some((i) => i.platform === "Amazon" && /Sales up 25\.0%/.test(i.text)));
  assert.ok(d.watch.some((i) => i.platform === "Meta Ads" && /no sales credited/.test(i.text)));
});

test("Shopify's ads are noted once, under Google Ads / Meta Ads", () => {
  const d = buildDigest(input());
  assert.equal([...d.good, ...d.watch].some((i) => i.platform === "Shopify" && /ads|Ad spend/i.test(i.text)), false);
});

test("orders not uploaded yet for the digest day show as 0 with a note, and stay in the totals", () => {
  const i = input();
  i.markets[1] = { key: "flipkart", label: "Flipkart", day: D, ordersIn: false, summary: summary(D, 0, 0, 30000), ads: [ad(D, "FK", 500, 2500)] };
  const d = buildDigest(i);
  const fk = d.rows.find((r) => r.key === "flipkart")!;
  assert.deepEqual([fk.day, fk.late, fk.sales, fk.orders, fk.adSpend], [D, false, 0, 0, 500]);
  assert.equal(d.total.adSpend, 5350); // Amazon 1,850 + Flipkart 500 + Google 2,000 + Meta 1,000
  assert.ok(d.lateNotes.includes("Flipkart: orders data for 12.11.2026 is not available — marked as 0."));
});
