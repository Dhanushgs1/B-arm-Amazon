// Meesho tab breakdowns: same rules as the Meesho summary / weekly report (meeshoSkuPeriodData.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { meeshoBreakdowns, meeshoLatestPriceBySku, type MeeshoBreakdownRow } from "./meeshoBreakdownRules.ts";

const row = (o: Partial<MeeshoBreakdownRow>): MeeshoBreakdownRow => ({
  order_status: "DELIVERED",
  sub_order_no: "S1_1",
  order_date: "2026-10-20",
  customer_state: "Tamil Nadu",
  product_name: "Product A",
  sku: "SKU-A",
  quantity: 1,
  supplier_listed_price: 100,
  ...o,
});

const ROWS: MeeshoBreakdownRow[] = [
  row({ sub_order_no: "1001_1", order_date: "2026-10-20", sku: "SKU-A", quantity: 2, supplier_listed_price: 100, customer_state: "Tamil Nadu" }),
  row({ sub_order_no: "1001_2", order_date: "2026-10-20", sku: "SKU-B", product_name: "Product B", quantity: 1, supplier_listed_price: 250, customer_state: "Tamil Nadu" }),
  row({ sub_order_no: "1002_1", order_date: "2026-10-21", sku: "SKU-A", quantity: 1, supplier_listed_price: null, order_status: "SHIPPED", customer_state: "Kerala" }), // no price -> latest SKU-A price
  row({ sub_order_no: "1003_1", order_date: "2026-10-21", sku: "SKU-B", product_name: "Product B", quantity: 3, supplier_listed_price: 250, order_status: "CANCELLED", customer_state: "Kerala" }),
  row({ sub_order_no: "1004_1", order_date: "2026-10-22", sku: "SKU-A", quantity: 1, supplier_listed_price: 120, order_status: "RTO", customer_state: "karnataka" }),
  row({ sub_order_no: "0999_1", order_date: "2026-09-01", sku: "SKU-A", quantity: 5, supplier_listed_price: 90 }), // outside the range
];

test("latest listed price per SKU is the most recent order's price", () => {
  const p = meeshoLatestPriceBySku(ROWS);
  assert.equal(p.get("SKU-A"), 120);
  assert.equal(p.get("SKU-B"), 250);
});

test("totals: cancelled left out, missing price uses the SKU's latest price, sub-orders counted once", () => {
  const b = meeshoBreakdowns(ROWS, "2026-10-20", "2026-10-22");
  // 2×100 + 1×250 + 1×120 (fallback) + 1×120 (RTO still counts, like the summary) = 690; units 5
  assert.deepEqual(b.totals, { units: 5, gross: 690, orders: 3, cancelledUnits: 3 });
});

test("daily series is zero-filled and adds up to the totals", () => {
  const b = meeshoBreakdowns(ROWS, "2026-10-19", "2026-10-23");
  assert.deepEqual(b.daily.map((d) => [d.date, d.units, d.gross]), [
    ["2026-10-19", 0, 0],
    ["2026-10-20", 3, 450],
    ["2026-10-21", 1, 120],
    ["2026-10-22", 1, 120],
    ["2026-10-23", 0, 0],
  ]);
});

test("product-wise per SKU, highest gross first, cancelled excluded", () => {
  const b = meeshoBreakdowns(ROWS, "2026-10-20", "2026-10-22");
  assert.deepEqual(b.products.map((p) => [p.sku, p.units, p.orders, p.gross]), [["SKU-A", 4, 3, 440], ["SKU-B", 1, 1, 250]]);
  assert.equal(b.products.reduce((t, p) => t + p.gross, 0), b.totals.gross);
});

test("status split shows cancelled too, but only counted statuses carry sales", () => {
  const b = meeshoBreakdowns(ROWS, "2026-10-20", "2026-10-22");
  assert.deepEqual(b.statuses.map((s) => [s.key, s.units, s.gross, s.counted]), [
    ["DELIVERED", 3, 450, true],
    ["SHIPPED", 1, 120, true],
    ["RTO", 1, 120, true],
    ["CANCELLED", 3, 0, false],
  ]);
});

test("state split: case-insensitive, cancelled excluded, adds up to gross", () => {
  const b = meeshoBreakdowns(ROWS, "2026-10-20", "2026-10-22");
  assert.deepEqual(b.states.map((s) => [s.label, s.units, s.gross]), [["Tamil Nadu", 3, 450], ["Karnataka", 1, 120], ["Kerala", 1, 120]]);
  assert.equal(b.states.reduce((t, s) => t + s.gross, 0), b.totals.gross);
});
