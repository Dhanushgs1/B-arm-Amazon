import test from "node:test";
import assert from "node:assert/strict";
import { shopifySourceDetail, isPaidSource } from "./shopifySourceRules.ts";
import { resolveDailySpend } from "./adSpendDailyRules.ts";
import type { ShopifyOrder } from "./shopifyOrderRules.ts";

const order = (n: number, date: string, total: number, source: string | null, cancelled = false): ShopifyOrder => ({
  order_gid: `gid://shopify/Order/${n}`, order_name: `#${n}`, order_number: n, order_date: date, order_created_at: `${date}T10:${String(n % 60).padStart(2, "0")}:00Z`,
  financial_status: "pending", fulfillment_status: null, is_cancelled: cancelled, cancel_reason: null, source_name: "web", tags: null, currency: "INR",
  total, subtotal: total, tax: 0, shipping: 0, discounts: 0, item_quantity: 1, items: [], ad_channel: source,
});

// Real Meta Ads orders from 22–24 Oct: #1067 ₹1,129 (22), #1072 ₹669 (22), #1074 ₹669 (23); plus noise from other sources.
const ORDERS = [
  order(1067, "2026-10-22", 1129, "meta_ads"),
  order(1072, "2026-10-22", 669, "meta_ads"),
  order(1074, "2026-10-23", 669, "meta_ads"),
  order(1071, "2026-10-22", 755, "google_ads"),
  order(1069, "2026-10-22", 2699, "google_organic"),
  order(1099, "2026-10-24", 500, "meta_ads", true), // cancelled
];
// Real Meta 1-day spend: 22 Oct ₹917.77, 23 Oct ₹584.77; no 1-day report for 24 Oct.
const META_SPEND = resolveDailySpend(
  [
    { report_start: "2026-10-22", report_end: "2026-10-22", campaign_name: "C1", spend: 917.77 },
    { report_start: "2026-10-23", report_end: "2026-10-23", campaign_name: "C1", spend: 584.77 },
  ],
  "2026-10-22", "2026-10-24",
);

test("paid source: ROAS and cost per order use only days whose spend is known", () => {
  const d = shopifySourceDetail(ORDERS, "meta_ads", META_SPEND, "2026-10-22", "2026-10-24");
  assert.equal(d.netOrders, 3);
  assert.equal(d.sales, 2467);
  assert.equal(d.spend!.spend, 1502.54);
  assert.equal(d.coveredNetOrders, 3);
  assert.equal(d.coveredSales, 2467);
  assert.equal(Math.round(d.roas! * 100) / 100, 1.64);
  assert.equal(Math.round(d.costPerOrder! * 100) / 100, 500.85);
  assert.equal(d.orders.length, 4, "cancelled order listed, not counted");
  assert.deepEqual(d.daily.map((x) => [x.date, x.orders, x.sales, x.spend]), [
    ["2026-10-22", 2, 1798, 917.77], ["2026-10-23", 1, 669, 584.77], ["2026-10-24", 0, 0, null],
  ]);
});

test("an order on a day without spend data is kept in Sales but left out of ROAS", () => {
  const withLate = [...ORDERS, order(1080, "2026-10-24", 1000, "meta_ads")];
  const d = shopifySourceDetail(withLate, "meta_ads", META_SPEND, "2026-10-22", "2026-10-24");
  assert.equal(d.sales, 3467);
  assert.equal(d.coveredSales, 2467);
  assert.equal(d.coveredNetOrders, 3);
});

test("unpaid source has no spend, ROAS or cost per order", () => {
  const d = shopifySourceDetail(ORDERS, "google_organic", null, "2026-10-22", "2026-10-24");
  assert.equal(d.netOrders, 1);
  assert.equal(d.sales, 2699);
  assert.equal(d.roas, null);
  assert.equal(d.costPerOrder, null);
});

test("orders without a source label count as 'unknown'", () => {
  const d = shopifySourceDetail([order(1, "2026-10-22", 100, null)], "unknown", null, "2026-10-22", "2026-10-22");
  assert.equal(d.netOrders, 1);
});

test("paid source list", () => {
  assert.equal(isPaidSource("google_ads"), true);
  assert.equal(isPaidSource("meta_ads"), true);
  assert.equal(isPaidSource("direct"), false);
});
