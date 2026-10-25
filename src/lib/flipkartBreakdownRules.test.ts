// Flipkart tab breakdowns: same rules as the "Sales, Orders & Returns" strip (fetchFlipkartOrderSummary).
import test from "node:test";
import assert from "node:assert/strict";
import { flipkartBreakdowns, flipkartPriceBySku, type FlipkartBreakdownRow } from "./flipkartBreakdownRules.ts";

const row = (o: Partial<FlipkartBreakdownRow>): FlipkartBreakdownRow => ({
  order_item_id: "OI1",
  order_id: "OD1",
  order_date: "2026-10-20",
  order_item_status: "DELIVERED",
  sku: "SKU-A",
  product_title: "Product A",
  quantity: 1,
  fulfilment_type: "NON_FBF",
  ...o,
});

const LISTINGS = [
  { seller_sku_id: "SKU-A", selling_price: "200" },
  { seller_sku_id: "SKU-A", selling_price: "999" }, // later duplicate: the first one wins
  { seller_sku_id: "SKU-B", selling_price: 500 },
  { seller_sku_id: "SKU-Z", selling_price: 0 }, // no price
];

const ROWS: FlipkartBreakdownRow[] = [
  row({ order_item_id: "1", order_id: "A", order_date: "2026-10-20", sku: "SKU-A", quantity: 2 }),
  row({ order_item_id: "2", order_id: "A", order_date: "2026-10-20T10:15:00", sku: "SKU-B", product_title: "Product B", quantity: 1, fulfilment_type: "FBF" }),
  row({ order_item_id: "3", order_id: "B", order_date: "2026-10-21", sku: "SKU-A", quantity: 1, order_item_status: "SHIPPED" }),
  row({ order_item_id: "4", order_id: "C", order_date: "2026-10-21", sku: "SKU-B", quantity: 3, order_item_status: "CANCELLED" }),
  row({ order_item_id: "5", order_id: "D", order_date: "2026-10-22", sku: "SKU-Z", product_title: "Product Z", quantity: 1, order_item_status: "RETURNED" }),
  row({ order_item_id: "", order_id: "E", order_date: "2026-10-22", sku: "SKU-A", quantity: 9 }), // skeleton row: never counts
  row({ order_item_id: "7", order_id: "F", order_date: "2026-09-01", sku: "SKU-A", quantity: 4 }), // outside the range
];

test("price per SKU: first listing row wins, zero prices ignored", () => {
  const p = flipkartPriceBySku(LISTINGS);
  assert.equal(p.get("SKU-A"), 200);
  assert.equal(p.get("SKU-B"), 500);
  assert.equal(p.has("SKU-Z"), false);
});

test("totals: cancelled and skeleton rows left out, unlisted SKU adds units but no value", () => {
  const b = flipkartBreakdowns(ROWS, LISTINGS, "2026-10-20", "2026-10-22");
  // units 2 + 1 + 1 + 1 = 5; gross 2×200 + 1×500 + 1×200 + 1×0 = 1100; orders A, B, D
  assert.deepEqual(b.totals, { units: 5, gross: 1100, orders: 3, cancelledUnits: 3, unpricedUnits: 1 });
});

test("daily series: timestamps fall on their date, zero-filled", () => {
  const b = flipkartBreakdowns(ROWS, LISTINGS, "2026-10-19", "2026-10-23");
  assert.deepEqual(b.daily.map((d) => [d.date, d.units, d.gross]), [
    ["2026-10-19", 0, 0],
    ["2026-10-20", 3, 900],
    ["2026-10-21", 1, 200],
    ["2026-10-22", 1, 0],
    ["2026-10-23", 0, 0],
  ]);
});

test("product-wise per SKU adds up to the totals; unlisted SKU flagged", () => {
  const b = flipkartBreakdowns(ROWS, LISTINGS, "2026-10-20", "2026-10-22");
  assert.deepEqual(b.products.map((p) => [p.sku, p.units, p.orders, p.gross, p.priced]), [
    ["SKU-A", 3, 2, 600, true],
    ["SKU-B", 1, 1, 500, true],
    ["SKU-Z", 1, 1, 0, false],
  ]);
  assert.equal(b.products.reduce((t, p) => t + p.units, 0), b.totals.units);
});

test("status split includes cancelled (not counted); fulfilment split covers counted units", () => {
  const b = flipkartBreakdowns(ROWS, LISTINGS, "2026-10-20", "2026-10-22");
  assert.deepEqual(b.statuses.map((s) => [s.key, s.units, s.counted]), [["DELIVERED", 3, true], ["SHIPPED", 1, true], ["RETURNED", 1, true], ["CANCELLED", 3, false]]);
  assert.deepEqual(b.fulfilment.map((f) => [f.label, f.units, f.gross]), [["Seller shipped (Non-FBF)", 4, 600], ["Fulfilled by Flipkart (FBF)", 1, 500]]);
});
