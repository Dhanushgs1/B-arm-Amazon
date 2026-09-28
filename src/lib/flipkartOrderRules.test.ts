import test from "node:test";
import assert from "node:assert/strict";
import { isFkSkeletonOrderRow } from "./flipkartOrderRules.ts";

test("a row without order_item_id is a skeleton row", () => {
  assert.equal(isFkSkeletonOrderRow({ order_item_id: "" }), true);
  assert.equal(isFkSkeletonOrderRow({ order_item_id: "   " }), true);
  assert.equal(isFkSkeletonOrderRow({ order_item_id: null }), true);
  assert.equal(isFkSkeletonOrderRow({}), true);
});

test("every real order line (any status) is kept", () => {
  for (const status of ["DELIVERED", "RETURNED", "READY_TO_SHIP", "CANCELLED", ""]) {
    assert.equal(isFkSkeletonOrderRow({ order_item_id: "OI:338633328704545100", order_item_status: status } as never), false, status);
  }
});

test("filtering skeletons leaves one row per real order line (the duplicated pair from fk_orders)", () => {
  const rows = [
    { order_item_id: "OI:1", order_id: "OD1", sku: "S", quantity: 1, order_item_status: "DELIVERED" },
    { order_item_id: "", order_id: "OD1", sku: "S", quantity: 1, order_item_status: "" }, // skeleton copy
    { order_item_id: "OI:2", order_id: "OD2", sku: "S", quantity: 2, order_item_status: "READY_TO_SHIP" },
  ];
  const kept = rows.filter((r) => !isFkSkeletonOrderRow(r));
  assert.equal(kept.reduce((s, r) => s + r.quantity, 0), 3);
});
