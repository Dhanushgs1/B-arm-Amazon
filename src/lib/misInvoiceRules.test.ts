import test from "node:test";
import assert from "node:assert/strict";
import { dayLabel, effectiveDate, monthEnd, splitPeriod, summarizeMisLines, type MisLine } from "./misInvoiceRules.ts";

const line = (o: Partial<MisLine>): MisLine => ({ invoice_date: "2026-08-10", invoice_month: "2026-08-01", order_id: "A", quantity: 1, sales_with_tax: 0, returns_with_tax: 0, ...o });

test("monthEnd handles 30/31-day months and February", () => {
  assert.equal(monthEnd("2026-08-01"), "2026-08-31");
  assert.equal(monthEnd("2026-09-01"), "2026-09-30");
  assert.equal(monthEnd("2028-02-01"), "2028-02-29");
});

test("a line counts on its invoice date, kept inside its report month", () => {
  assert.equal(effectiveDate(line({ invoice_date: "2026-05-24", invoice_month: "2026-06-01" })), "2026-06-01");
  assert.equal(effectiveDate(line({ invoice_date: "2026-07-02", invoice_month: "2026-06-01" })), "2026-06-30");
  assert.equal(effectiveDate(line({ invoice_date: "2026-06-15", invoice_month: "2026-06-01" })), "2026-06-15");
  assert.equal(effectiveDate(line({ invoice_date: null, invoice_month: "2026-06-01" })), "2026-06-01");
});

test("August 2026 Amazon lines reproduce the ERP's Sales and Qty", () => {
  // the ERP's transaction-type totals for Aug 2026: Shipment 8,956 units ₹59,23,984; FreeReplacement 38 units ₹0; Refund −613 units
  const lines = [
    line({ order_id: "s1", quantity: 8956, sales_with_tax: 5923984 }),
    line({ order_id: "f1", quantity: 38, sales_with_tax: 0 }),
    line({ order_id: "r1", quantity: -613, sales_with_tax: 0, returns_with_tax: 457099 }),
    line({ order_id: "x", invoice_month: "2026-09-01", invoice_date: "2026-08-31", quantity: 5, sales_with_tax: 999 }), // September report: not August
  ];
  const t = summarizeMisLines(lines, "2026-08-01", "2026-08-31");
  assert.equal(t.sales, 5923984);
  assert.equal(t.units, 8994);
  assert.equal(t.allReturns, 613);
  assert.equal(t.netOrders, 8381); // the ERP's Qty
  assert.equal(t.returnsValue, 457099);
  assert.equal(t.orders, 2);
});

test("Flipkart cancellations count as returns and return cancellations as sales, as in the ERP", () => {
  const lines = [
    line({ order_id: "a", quantity: 5560, sales_with_tax: 1979728 }),
    line({ order_id: "b", quantity: 24, sales_with_tax: 7439 }),
    line({ order_id: "c", quantity: -970, returns_with_tax: 352511 }),
    line({ order_id: "d", quantity: -58, returns_with_tax: 18596 }),
  ];
  const t = summarizeMisLines(lines, "2026-08-01", "2026-08-31");
  assert.equal(t.sales, 1987167);
  assert.equal(t.netOrders, 4556);
});

test("splitPeriod: invoice days first, order-report days after the ERP's last day", () => {
  assert.deepEqual(splitPeriod("2026-09-13", "2026-10-12", "2026-09-30"), { mis: { start: "2026-09-13", end: "2026-09-30" }, orders: { start: "2026-10-01", end: "2026-10-12" } });
  assert.deepEqual(splitPeriod("2026-08-01", "2026-08-31", "2026-09-30"), { mis: { start: "2026-08-01", end: "2026-08-31" }, orders: null });
  assert.deepEqual(splitPeriod("2026-10-13", "2026-11-11", "2026-09-30"), { mis: null, orders: { start: "2026-10-13", end: "2026-11-11" } });
  assert.deepEqual(splitPeriod("2026-10-13", "2026-11-11", null), { mis: null, orders: { start: "2026-10-13", end: "2026-11-11" } });
  assert.deepEqual(splitPeriod("2026-12-31", "2027-01-05", "2026-12-31"), { mis: { start: "2026-12-31", end: "2026-12-31" }, orders: { start: "2027-01-01", end: "2027-01-05" } });
});

test("dayLabel", () => assert.equal(dayLabel("2026-09-30"), "30 Sep 2026"));
