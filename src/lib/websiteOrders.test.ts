// Duplicate prevention and historical-data preservation for the B-ARM website's two order sources:
// WooCommerce (barm_online_orders, before the Shopify move) and Shopify (barm_shopify_orders_v2 via
// barm_shopify_orders_summary). Row shapes copied from the real tables.
import test from "node:test";
import assert from "node:assert/strict";
import { buildBarmOnlineOrders } from "./barmOnlineOrderRules.ts";
import { mapShopifyRpcRows, shopifyTotals } from "./shopifyOrderRules.ts";

const woo = (o: Record<string, unknown>) => ({
  "Order Number": "29072", "Order Status": "Received", "Order Date": "20-09-2026 05:53:00", "SKU": "B-INSEM-KIT-PK5",
  "Item Name": "Home Insemination Kit", "Quantity": "1", "Order Total Amount": "521", "Order Total Tax Amount": "", "COD Fee": "",
  "created at": "2026-09-26 10:14:07+00", ...o,
});

test("WooCommerce: the same order line loaded twice counts once, latest load wins", () => {
  const orders = buildBarmOnlineOrders([
    woo({ "Order Total Amount": "500", "created at": "2026-09-22 07:35:37+00" }),
    woo({ "Order Total Amount": "521", "created at": "2026-09-26 10:14:07+00" }),
  ]);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].total, 521);
  assert.equal(orders[0].lines.length, 1);
});

test("WooCommerce: a two-line order is one order, total counted once", () => {
  const orders = buildBarmOnlineOrders([
    woo({ "Order Number": "29076", "SKU": "A", "Order Total Amount": "5499" }),
    woo({ "Order Number": "29076", "SKU": "B", "Order Total Amount": "5499" }),
  ]);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].total, 5499);
  assert.equal(orders[0].lines.length, 2);
});

test("WooCommerce: SKU-only rows pasted in after the Shopify move never become orders", () => {
  // Real shape: rows from 21 Sep onwards with only a date, SKU and quantity. Those sales are Shopify
  // orders — counting them here too would double count the website.
  const orders = buildBarmOnlineOrders([
    woo({}),
    { "Order Number": "", "Invoice Number": "", "Order Status": "", "Order Date": "21-10-2026 10:20:14", "SKU": "B-MENO-CASSETTE-PK3", "Quantity": "1", "Order Total Amount": "", "created at": "2026-10-24 05:15:12+00" },
    { "Order Number": "", "Order Status": "", "Order Date": "16-10-2026 22:35:05", "SKU": "B-BULB-10.5-INSEM-PK2", "Quantity": "2", "created at": "2026-10-24 05:15:12+00" },
  ]);
  assert.deepEqual(orders.map((o) => o.order_number), ["29072"]);
});

test("WooCommerce: historical non-sales stay out of sales, genuine history is untouched", () => {
  const orders = buildBarmOnlineOrders([
    woo({ "Order Number": "29174", "Order Status": "Failed" }),
    woo({ "Order Number": "29221", "Order Total Tax Amount": "cancelled" }),
    woo({ "Order Number": "29186", "COD Fee": "RETURNED" }),
    woo({ "Order Number": "29078", "Order Date": "21-09-2026 08:05:00", "Order Total Amount": "257" }),
    woo({ "Order Number": "28652", "Order Date": "04-05-2026 10:00:00", "Order Total Amount": "1,299" }),
  ]);
  assert.deepEqual(orders.map((o) => [o.order_number, o.order_date, o.total]).sort(), [
    ["28652", "2026-05-04", 1299],
    ["29078", "2026-09-21", 257],
  ]);
});

test("WooCommerce: rows with a shifted, unparseable date are skipped, not guessed", () => {
  assert.equal(buildBarmOnlineOrders([woo({ "Order Date": "Kumar, 2nd floor" })]).length, 0);
  assert.equal(buildBarmOnlineOrders([woo({ "Order Date": "20-13-2026 05:53:00" })]).length, 0);
});

const shopRow = (o: Record<string, unknown>) => ({
  order_gid: "gid://shopify/Order/1", order_name: "#1073", order_number: 1073, order_date: "2026-10-23",
  order_created_at: "2026-10-23T12:13:33Z", is_cancelled: false, order_total_price: "2729.00", item_quantity: 1,
  items: [{ title: "Postpartum Recovery Essentials kit", quantity: 1, price: "2699.00", line_total: "2699.00" }], ...o,
});

test("Shopify: the same order read twice is one order", () => {
  const orders = mapShopifyRpcRows([shopRow({}), shopRow({ order_total_price: "2729.00" })]);
  assert.equal(orders.length, 1);
  assert.equal(shopifyTotals(orders).sales, 2729);
});

test("Shopify: cancelled orders stay listed but are not sales", () => {
  const orders = mapShopifyRpcRows([
    shopRow({}),
    shopRow({ order_gid: "gid://shopify/Order/2", order_name: "#1076", order_total_price: "1069.00", is_cancelled: true, order_created_at: "2026-10-23T18:17:52Z" }),
  ]);
  assert.deepEqual(orders.map((o) => o.order_name), ["#1073", "#1076"]);
  assert.deepEqual(shopifyTotals(orders), { orders: 2, cancelled: 1, netOrders: 1, sales: 2729, aov: 2729, units: 1 });
});

test("Shopify: rows without an order id or date are ignored", () => {
  assert.equal(mapShopifyRpcRows([shopRow({ order_gid: null }), shopRow({ order_date: null })]).length, 0);
  assert.equal(mapShopifyRpcRows(null).length, 0);
});

test("the two sources never share an order key", () => {
  // WooCommerce numbers are 28652–29242, Shopify's start at #1001; keys are also kept per source.
  const wooKeys = buildBarmOnlineOrders([woo({}), woo({ "Order Number": "29078" })]).map((o) => `woocommerce:${o.order_number}`);
  const shopKeys = mapShopifyRpcRows([shopRow({})]).map((o) => `shopify:${o.order_gid}`);
  assert.equal(new Set([...wooKeys, ...shopKeys]).size, wooKeys.length + shopKeys.length);
});
