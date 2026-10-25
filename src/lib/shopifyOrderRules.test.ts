// Shopify tab totals and breakdowns, checked against the real orders in barm_shopify_orders_v2 as
// returned by barm_shopify_orders_summary on 24 Oct 2026 (order numbers, IST dates, totals, statuses,
// source label and product line only — no customer data). Source-table recount: 12 orders,
// 1 cancelled (#1076), 11 net, sales ₹12,643.00, AOV ₹1,149.36, item value ₹12,073.00.
import test from "node:test";
import assert from "node:assert/strict";
import {
  mapShopifyRpcRows,
  shopifyTotals,
  shopifyProductSales,
  shopifyDailySeries,
  shopifyPaymentSplit,
  shopifyFulfilmentSplit,
  shopifySourceSplit,
} from "./shopifyOrderRules.ts";

type Real = [number, string, number, boolean, string, string | null, string, string, string, number];
const REAL: Real[] = [
  // order_number, IST date, total, cancelled, payment, fulfilment, source, product, sku, line total
  [1067, "2026-10-22", 1129, false, "pending", "fulfilled", "meta_ads", "Bulb Catheter (Pack of 10)", "B-BULB-CATH-PK10", 1099],
  [1068, "2026-10-22", 1069, false, "pending", null, "google_organic", "Blood Sugar Control & Headache Relief (Pack of 1)", "B-DUMMY", 999],
  [1069, "2026-10-22", 2699, false, "paid", "fulfilled", "google_organic", "Postpartum Recovery Essentials kit", "A001", 2699],
  [1070, "2026-10-22", 1069, false, "pending", null, "google_organic", "Blood Sugar Control & Headache Relief (Pack of 1)", "B-DUMMY", 999],
  [1071, "2026-10-22", 755, false, "pending", null, "google_ads", "Dual Insemination Kit (Pack of 4)", "B-BULB-CATH-PK4", 685],
  [1072, "2026-10-22", 669, false, "pending", "fulfilled", "meta_ads", "At-Home Bulb Insemination Kit (Pack of 5)", "B-BULB-10.5-INSEM-PK5", 599],
  [1073, "2026-10-23", 2729, false, "pending", null, "google_organic", "Postpartum Recovery Essentials kit", "A001", 2699],
  [1074, "2026-10-23", 669, false, "pending", null, "meta_ads", "At-Home Bulb Insemination Kit (Pack of 5)", "B-BULB-10.5-INSEM-PK5", 599],
  [1075, "2026-10-23", 829, false, "paid", null, "direct", "Medical Vaginal Dilator Therapy Set (Firm)", "A019", 789],
  [1076, "2026-10-23", 1069, true, "pending", "restocked", "google_organic", "Soft Medical Dilator Set (Pack of 5)", "B-VD-TPE-PK5", 999],
  [1077, "2026-10-24", 669, false, "pending", null, "google_ads", "At-Home Bulb Insemination Kit (Pack of 5)", "B-BULB-10.5-INSEM-PK5", 599],
  [1078, "2026-10-24", 357, false, "paid", null, "google_organic", "Glucospark Blood Glucose Test Strips (Pack of 50)", "SC50", 307],
];

const rpcRow = ([n, date, total, cancelled, payment, fulfilment, source, title, sku, lineTotal]: Real) => ({
  order_gid: `gid://shopify/Order/${n}`,
  order_name: `#${n}`,
  order_number: n,
  order_date: date,
  order_created_at: `${date}T10:${String(n % 60).padStart(2, "0")}:00Z`, // later order number = later time
  financial_status: payment,
  fulfillment_status: fulfilment,
  is_cancelled: cancelled,
  cancel_reason: cancelled ? "customer" : null,
  source_name: "web",
  tags: "v2-sync",
  currency: "INR",
  order_total_price: total.toFixed(2), // PostgREST returns numeric as a string
  order_current_total_price: total.toFixed(2),
  order_subtotal_price: lineTotal.toFixed(2),
  order_total_tax: "0.00",
  order_total_shipping: (total - lineTotal).toFixed(2),
  order_total_discounts: "0.00",
  line_count: 1,
  item_quantity: 1,
  items: [{ title, variant_title: null, sku, quantity: 1, refunded_quantity: 0, price: lineTotal.toFixed(2), line_total: lineTotal.toFixed(2) }],
  ad_channel: source,
});
const ORDERS = mapShopifyRpcRows(REAL.map(rpcRow));

test("totals match the source table: 12 orders, 11 net, ₹12,643.00 sales, AOV ₹1,149.36", () => {
  const t = shopifyTotals(ORDERS);
  assert.equal(t.orders, 12);
  assert.equal(t.cancelled, 1);
  assert.equal(t.netOrders, 11);
  assert.equal(t.sales, 12643);
  assert.equal(Math.round(t.aov * 100) / 100, 1149.36);
  assert.equal(t.units, 11);
});

test("a cancelled order stays in the list but is left out of sales, net orders and AOV", () => {
  assert.ok(ORDERS.some((o) => o.order_number === 1076 && o.is_cancelled));
  const onlyCancelled = shopifyTotals(ORDERS.filter((o) => o.order_number === 1076));
  assert.deepEqual(onlyCancelled, { orders: 1, cancelled: 1, netOrders: 0, sales: 0, aov: 0, units: 0 });
});

test("an order returned twice (e.g. a re-sent webhook) counts once", () => {
  const rows = [...REAL.map(rpcRow), rpcRow(REAL[3]), rpcRow(REAL[11])];
  const t = shopifyTotals(mapShopifyRpcRows(rows));
  assert.equal(t.orders, 12);
  assert.equal(t.sales, 12643);
});

test("orders are listed oldest first and rows without an order date are ignored", () => {
  const orders = mapShopifyRpcRows([rpcRow(REAL[5]), rpcRow(REAL[0]), { ...rpcRow(REAL[1]), order_date: null }]);
  assert.deepEqual(orders.map((o) => o.order_number), [1067, 1072]);
});

test("product-wise: item value per product name, cancelled left out, highest first", () => {
  const rows = shopifyProductSales(ORDERS);
  assert.deepEqual(rows.map((r) => [r.title, r.units, r.orders, r.itemSales]), [
    ["Postpartum Recovery Essentials kit", 2, 2, 5398],
    ["Blood Sugar Control & Headache Relief (Pack of 1)", 2, 2, 1998],
    ["At-Home Bulb Insemination Kit (Pack of 5)", 3, 3, 1797],
    ["Bulb Catheter (Pack of 10)", 1, 1, 1099],
    ["Medical Vaginal Dilator Therapy Set (Firm)", 1, 1, 789],
    ["Dual Insemination Kit (Pack of 4)", 1, 1, 685],
    ["Glucospark Blood Glucose Test Strips (Pack of 50)", 1, 1, 307],
  ]);
  assert.equal(rows.reduce((t, r) => t + r.itemSales, 0), 12073); // = ₹12,643 sales − ₹570 shipping
  assert.equal(Math.round(rows.reduce((t, r) => t + r.share, 0) * 1e9) / 1e9, 1);
  assert.ok(!rows.some((r) => r.skus.includes("B-VD-TPE-PK5")), "cancelled #1076's product must not appear");
});

test("product-wise: two different products sharing a placeholder SKU stay separate", () => {
  const a = rpcRow(REAL[1]);
  const b = { ...rpcRow(REAL[3]), items: [{ ...rpcRow(REAL[3]).items[0], title: "Another Product" }] };
  const rows = shopifyProductSales(mapShopifyRpcRows([a, b]));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.skus), [["B-DUMMY"], ["B-DUMMY"]]);
});

test("daily series: one zero-filled row per IST day, matching the per-day totals", () => {
  const days = shopifyDailySeries(ORDERS, "2026-10-21", "2026-10-25");
  assert.deepEqual(days.map((d) => [d.date, d.orders, d.netOrders, d.sales]), [
    ["2026-10-21", 0, 0, 0],
    ["2026-10-22", 6, 6, 7390],
    ["2026-10-23", 4, 3, 4227],
    ["2026-10-24", 2, 2, 1026],
    ["2026-10-25", 0, 0, 0],
  ]);
});

test("payment split (net orders): 3 paid ₹3,885, 8 pending ₹8,758", () => {
  assert.deepEqual(shopifyPaymentSplit(ORDERS).map((r) => [r.key, r.orders, r.sales]), [["paid", 3, 3885], ["pending", 8, 8758]]);
});

test("fulfilment split (net orders): 3 fulfilled ₹4,497, 8 unfulfilled ₹8,146 — cancelled 'restocked' not counted", () => {
  assert.deepEqual(shopifyFulfilmentSplit(ORDERS).map((r) => [r.key, r.orders, r.sales]), [["fulfilled", 3, 4497], ["unfulfilled", 8, 8146]]);
});

test("order source split (net orders) adds back up to Sales", () => {
  const rows = shopifySourceSplit(ORDERS);
  assert.deepEqual(rows.map((r) => [r.label, r.orders, r.sales]), [
    ["Google Ads", 2, 1424],
    ["Meta Ads", 3, 2467],
    ["Google (organic)", 5, 7923],
    ["Direct", 1, 829],
  ]);
  assert.equal(rows.reduce((t, r) => t + r.sales, 0), 12643);
});

test("an order with no source label is shown as Unknown, not dropped", () => {
  const rows = shopifySourceSplit(mapShopifyRpcRows([{ ...rpcRow(REAL[0]), ad_channel: null }]));
  assert.deepEqual(rows.map((r) => [r.label, r.orders]), [["Unknown", 1]]);
});
