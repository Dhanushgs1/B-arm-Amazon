import test from "node:test";
import assert from "node:assert/strict";
import { detectBarmOrdersLayout, findBarmOrdersHeader, offlineRowPrice, mapBarmOfflineRows, fillDownBarmDates, mergeDuplicateBarmInvoices } from "./barmOfflineOrderRules.ts";

const OFFLINE_HEADER = ["Date", "Product", "Quantity", "Price per Product", "Total Price", "SKU ID"];

test("the legacy B-Arm Orders header is still recognised first, by its S no cell", () => {
  assert.equal(detectBarmOrdersLayout(["S no", "Date", "Invoice", "Sku", "Qty", "Price"]), "legacy");
  // Even a sheet that also happens to have SKU ID/Date/Quantity stays legacy when S no is there.
  assert.equal(detectBarmOrdersLayout(["S no", "Date", "Quantity", "SKU ID"]), "legacy");
});

test("the offline layout is recognised by SKU ID + Date + Quantity, tolerant of case/spaces", () => {
  assert.equal(detectBarmOrdersLayout(OFFLINE_HEADER), "offline");
  assert.equal(detectBarmOrdersLayout([" date ", "QUANTITY", "Sku  Id"]), "offline");
  assert.equal(detectBarmOrdersLayout(["Date", "Quantity"]), null);
  // An Invoice column means the legacy key exists — never read as the offline layout.
  assert.equal(detectBarmOrdersLayout(["Date", "Invoice", "Quantity", "SKU ID"]), null);
  assert.equal(detectBarmOrdersLayout(["Foo"]), null);
});

test("the header row is found below a title line", () => {
  assert.deepEqual(findBarmOrdersHeader([["B-Arm Orders:04"], ["S no", "Date", "Invoice"]]), { layout: "legacy", index: 1 });
  assert.deepEqual(findBarmOrdersHeader([OFFLINE_HEADER, [46253, "", 20, "", "", "B-SENBR"]]), { layout: "offline", index: 0 });
  assert.equal(findBarmOrdersHeader([["nothing"], []]), null);
});

test("price comes only from the file: Price per Product, else Total Price ÷ Quantity, else null", () => {
  assert.equal(offlineRowPrice({ "Price per Product": 299, "Total Price": 5000 }, 20), 299);
  assert.equal(offlineRowPrice({ "Price per Product": "", "Total Price": 5980 }, 20), 299);
  assert.equal(offlineRowPrice({ "Price per Product": "₹1,250.50" }, 1), 1250.5);
  assert.equal(offlineRowPrice({ "Price per Product": "", "Total Price": "" }, 20), null);
  assert.equal(offlineRowPrice({ "Price per Product": 0, "Total Price": 0 }, 20), null);
  assert.equal(offlineRowPrice({}, 5), null);
});

const row = (date: unknown, qty: unknown, sku: string, price: unknown = "", total: unknown = "") => ({
  Date: date, Product: "", Quantity: qty, "Price per Product": price, "Total Price": total, "SKU ID": sku,
});

test("rows map to date, SKU, quantity and a stable OFFLINE key; Excel serials and DD-MM-YYYY both read", () => {
  const { rows, skipped, rowsWithoutPrice } = mapBarmOfflineRows([
    row(46253, 20, "B-SENBR"),
    row("19-08-2026", 2, " SCGSB1 ", 150),
    row(46030.00011574074, 1, "SC-LACTO-25S25L"),
  ]);
  assert.deepEqual(skipped, []);
  assert.equal(rowsWithoutPrice, 2);
  assert.deepEqual(rows.map((r) => [r.order_date, r.product_name, r.quantity, r.price, r.invoice]), [
    ["2026-08-19", "B-SENBR", 20, null, "OFFLINE-2026-08-19-B-SENBR-1"],
    ["2026-08-19", "SCGSB1", 2, 150, "OFFLINE-2026-08-19-SCGSB1-1"],
    ["2026-01-08", "SC-LACTO-25S25L", 1, null, "OFFLINE-2026-01-08-SC-LACTO-25S25L-1"],
  ]);
});

test("the same SKU twice on one day gets -1 and -2, and re-parsing gives the same keys", () => {
  const input = [row(46267, 5, "A005"), row(46267, 3, "A005"), row(46268, 1, "A005")];
  const keys = mapBarmOfflineRows(input).rows.map((r) => r.invoice);
  assert.deepEqual(keys, ["OFFLINE-2026-09-02-A005-1", "OFFLINE-2026-09-02-A005-2", "OFFLINE-2026-09-03-A005-1"]);
  assert.deepEqual(mapBarmOfflineRows(input).rows.map((r) => r.invoice), keys);
});

test("rows without a date, SKU or quantity are skipped with a reason; blank lines are ignored", () => {
  const { rows, skipped } = mapBarmOfflineRows([
    row("", 5, "A005"),
    row(46267, 5, ""),
    row(46267, 0, "A005"),
    row("", "", ""),
    row(46267, 5, "A005"),
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(skipped, [
    { line: 1, reason: "no date" },
    { line: 2, reason: "no SKU" },
    { line: 3, reason: "no quantity" },
  ]);
});

test("legacy: a same-SKU line with a blank Date takes the date above it (1 + 1 = 2 units)", () => {
  const out = fillDownBarmDates([
    { order_date: "2026-10-06", product_name: "Sensory brush", quantity: 1 },
    { order_date: null, product_name: "Sensory brush", quantity: 1 },
    { order_date: null, product_name: "", quantity: 0 },
  ]);
  assert.deepEqual(out.map((r) => r.order_date), ["2026-10-06", "2026-10-06", null]);
  assert.equal(fillDownBarmDates([{ order_date: null, product_name: "X", quantity: 1 }])[0].order_date, null);
});

test("legacy: same invoice + same SKU sums to one line; other SKUs on it get their own key", () => {
  const out = mergeDuplicateBarmInvoices([
    { invoice: "B1500", product_name: "Sensory brush", quantity: 1, price: 399 },
    { invoice: "B1500", product_name: "sensory  brush", quantity: 1, price: 399 },
    { invoice: "B1501", product_name: "Sensory brush", quantity: 1, price: 399 },
    { invoice: "B1501", product_name: "OT DT", quantity: 1, price: 599 },
    { invoice: "B1502", product_name: "10PIC KIT", quantity: 1, price: 2699 },
    { invoice: "", product_name: "Sensory brush", quantity: 1, price: 399 },
  ]);
  assert.deepEqual(out.map((r) => [r.invoice, r.quantity]), [
    ["B1500", 2],
    ["B1501-Sensory brush", 1],
    ["B1501-OT DT", 1],
    ["B1502", 1],
    ["", 1],
  ]);
  assert.equal(out.reduce((s, r) => s + r.quantity, 0), 6);
});
