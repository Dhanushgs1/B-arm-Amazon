import test from "node:test";
import assert from "node:assert/strict";
import { meeshoDate, mapMeeshoReturnRow, dedupeReturnsByStage } from "./meeshoReturnRules.ts";

test("Excel serial days read as the same calendar day (46253 = 19 Aug 2026)", () => {
  assert.equal(meeshoDate(46253), "2026-08-19");
  assert.equal(meeshoDate(46277), "2026-09-12");
  assert.equal(meeshoDate("2026-09-16"), "2026-09-16");
  assert.equal(meeshoDate("16/09/2026"), "2026-09-16");
  assert.equal(meeshoDate(""), null);
});

const inTransitRow = {
  "S No": 1, "Product Name": "Suture Pad", SKU: " B-SUTPRAC-PAD", Qty: 1,
  "Suborder Number": "328513185016225024_1", "Return Created Date": 46281,
  "Type of Return": "Courier Return (RTO)", Status: "Returned", "Return Reason": "NA",
};

test("a return row is trimmed, dated and staged", () => {
  const r = mapMeeshoReturnRow(inTransitRow, "In Transit", "Returns In Transit")!;
  assert.equal(r.sku, "B-SUTPRAC-PAD");
  assert.equal(r.order_number, "328513185016225024");
  assert.equal(r.return_created_date, "2026-09-16");
  assert.equal(r.return_status, "Returned");
  assert.equal(r.return_reason, "");
  assert.equal(r.quantity, 1);
});

test("Delivered sheet rows get status Delivered; rows without a suborder are skipped", () => {
  const r = mapMeeshoReturnRow({ ...inTransitRow, Status: undefined }, "Delivered", "Returns Delivered")!;
  assert.equal(r.return_status, "Delivered");
  assert.equal(mapMeeshoReturnRow({ SKU: "X" }, "Delivered", "Returns Delivered"), null);
});

test("a suborder on two sheets keeps its furthest stage, whatever the sheet order", () => {
  const t = mapMeeshoReturnRow(inTransitRow, "In Transit", "Returns In Transit")!;
  const d = mapMeeshoReturnRow(inTransitRow, "Delivered", "Returns Delivered")!;
  assert.deepEqual(dedupeReturnsByStage([d, t]).map((r) => r.return_stage), ["Delivered"]);
  assert.deepEqual(dedupeReturnsByStage([t, d]).map((r) => r.return_stage), ["Delivered"]);
});
