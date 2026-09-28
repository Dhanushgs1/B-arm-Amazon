import test from "node:test";
import assert from "node:assert/strict";
import { classifyMeeshoSheet, returnStageFromName } from "./meeshoFileRules.ts";

const ORDERS = ["Reason for Credit Entry", "Sub Order No", "Catalog ID", "Order Date", "Order source", "SKU", "Quantity"];
const RETURNS = ["S No", "Product Name", "SKU", "Qty", "Order Number", "Suborder Number", "Dispatch Date", "Return Created Date", "Type of Return"];
const ADS = ["Date", "Campaign name", "Product", "SKU ID", "Spend", "Views", "Clicks", "Orders by ad"];

test("the raw workbook's sheets are told apart by their headers", () => {
  assert.deepEqual(classifyMeeshoSheet("Orders", ORDERS), { kind: "orders" });
  assert.deepEqual(classifyMeeshoSheet("Returns In Transit", RETURNS), { kind: "returns", stage: "In Transit" });
  assert.deepEqual(classifyMeeshoSheet("Returns Delivered", RETURNS), { kind: "returns", stage: "Delivered" });
  assert.deepEqual(classifyMeeshoSheet("Returns OFD", RETURNS), { kind: "returns", stage: "Out for Delivery" });
});

test("an Ads export is recognised whatever its sheet is called", () => {
  assert.deepEqual(classifyMeeshoSheet("Sheet1", ADS), { kind: "ads" });
  assert.deepEqual(classifyMeeshoSheet("Sheet1", [" date ", "CAMPAIGN NAME", "spend"]), { kind: "ads" });
});

test("headers decide the kind, not the sheet name", () => {
  assert.deepEqual(classifyMeeshoSheet("Returns Delivered", ORDERS), { kind: "orders" });
  assert.deepEqual(classifyMeeshoSheet("Sheet1", ORDERS), { kind: "orders" });
});

test("standalone CSVs: the stage comes from the file name, In Transit when it doesn't say", () => {
  assert.deepEqual(classifyMeeshoSheet("Meesho return intransit 21-08-2026.csv", RETURNS), { kind: "returns", stage: "In Transit" });
  assert.deepEqual(classifyMeeshoSheet("meesho_returns_delivered.csv", RETURNS), { kind: "returns", stage: "Delivered" });
  assert.deepEqual(classifyMeeshoSheet("returns.csv", RETURNS), { kind: "returns", stage: "In Transit" });
});

test("unrelated sheets are not recognised", () => {
  assert.equal(classifyMeeshoSheet("Meesho Price Marketing", ["SKU ID", "Product Name", "Price (₹)"]), null);
  assert.equal(classifyMeeshoSheet("Sheet1", []), null);
});

test("stage names: delivered / OFD / out for delivery / in transit", () => {
  assert.equal(returnStageFromName("Returns Delivered"), "Delivered");
  assert.equal(returnStageFromName("returns-ofd"), "Out for Delivery");
  assert.equal(returnStageFromName("Out for Delivery"), "Out for Delivery");
  assert.equal(returnStageFromName("Returns In Transit"), "In Transit");
  assert.equal(returnStageFromName("Orders"), null);
  // "ofd" must be a word, not part of another one
  assert.equal(returnStageFromName("offdays"), null);
});
