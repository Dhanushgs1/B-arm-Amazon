import test from "node:test";
import assert from "node:assert/strict";
import { dailyFallbackStart, dailyAmRowAsMis, dailyFkRowAsMis, dedupeOrderLines } from "./dailyOrderFallbackRules.ts";

test("fills only the days after the last MIS day, inside the range", () => {
  // 26 Oct 2026: MIS through 22 Oct, Overall on 25 Oct (prev period 24 Oct) → 24 Oct onward from the upload
  assert.equal(dailyFallbackStart("2026-10-22 23:59:42", "2026-10-24", "2026-10-25"), "2026-10-24");
  assert.equal(dailyFallbackStart("2026-10-22", "2026-10-19", "2026-10-25"), "2026-10-23");
  assert.equal(dailyFallbackStart("2026-10-25", "2026-10-19", "2026-10-25"), null);
  assert.equal(dailyFallbackStart("2026-10-31", "2026-10-19", "2026-10-25"), null);
  assert.equal(dailyFallbackStart(null, "2026-10-19", "2026-10-25"), "2026-10-19");
  assert.equal(dailyFallbackStart("2026-10-31", "2026-11-01", "2026-11-07"), "2026-11-01");
});

test("daily Amazon row reads like an MIS amazon_orders row", () => {
  const r = dailyAmRowAsMis({
    id: 9, report_date: "2026-10-25", order_id: "403-6461490-1609903", purchase_datetime: "2026-10-24T18:30:45+00:00",
    order_status: "Shipped", sku: " A001-5 ", product_name: "Postpartum kit", quantity: 2, item_price: "5080.0",
    raw: { "order-item-id": "69410584752682", "item-status": "Unshipped" },
  });
  assert.equal(r.amazon_order_id, "403-6461490-1609903");
  assert.equal(r.order_item_id, "69410584752682");
  assert.equal(r.purchase_date, "2026-10-25");
  assert.equal(r.purchase_datetime, "2026-10-24T18:30:45+00:00");
  assert.equal(r.item_status, "Unshipped");
  assert.equal(r.sku, "A001-5");
  assert.equal(r.quantity, 2);
  assert.equal(r.item_price, 5080);
});

test("daily Flipkart row reads like an MIS fk_orders row", () => {
  const r = dailyFkRowAsMis({ report_date: "2026-10-25", order_id: "OD1", order_item_id: "OI:1", order_status: "CANCELLED", sku: "B-CT-R-1", quantity: 1 });
  assert.deepEqual(r, { order_item_id: "OI:1", order_id: "OD1", order_date: "2026-10-25", order_item_status: "CANCELLED", sku: "B-CT-R-1", quantity: 1 });
});

test("an exact repeat line is dropped once, a different status is kept", () => {
  const rows = [
    { order_item_id: "1", quantity: 1, s: "Shipped" },
    { order_item_id: "1", quantity: 1, s: "Shipped" },
    { order_item_id: "1", quantity: 1, s: "Cancelled" },
    { order_item_id: "2", quantity: 1, s: "Shipped" },
  ];
  assert.equal(dedupeOrderLines(rows, (r) => r.s).length, 3);
});
