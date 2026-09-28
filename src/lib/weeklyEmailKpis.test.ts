import test from "node:test";
import assert from "node:assert/strict";
import { weekAdKpis, roasOf, acosPctOf, productMapForPeriod } from "./weeklyEmailKpis.ts";

const days = ["2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17"];

test("weekAdKpis sums SP sales_7d over every day of the week, not just the end date", () => {
  const sp = days.map((d) => ({ report_date: d, spend: 100, sales_7d: 400 }));
  const { spend, adSales } = weekAdKpis(sp, [], [], "2026-09-11", "2026-09-17");
  assert.equal(spend, 700);
  assert.equal(adSales, 2800); // the old end-date-only reading gave 400
  assert.equal(acosPctOf({ spend, adSales }), 25);
  assert.equal(roasOf({ spend, adSales }), 4);
});

test("weekAdKpis sums SB sales and SD sales_14d over every in-range day and ignores out-of-range rows", () => {
  const sb = [{ report_date: "2026-09-10", spend: 999, sales: 999 }, { report_date: "2026-09-11", spend: 10, sales: 50 }, { report_date: "2026-09-17", spend: 10, sales: 50 }];
  const sd = [{ report_date: "2026-09-12", spend: 5, sales_14d: 20 }, { report_date: "2026-09-16", spend: 5, sales_14d: 20 }, { report_date: "2026-09-18", spend: 999, sales_14d: 999 }];
  assert.deepEqual(weekAdKpis([], sb, sd, "2026-09-11", "2026-09-17"), { spend: 30, adSales: 140 });
});

test("weekAdKpis includes both boundary days and skips rows with no date", () => {
  const sp = [{ report_date: "2026-09-11", spend: 1, sales_7d: 2 }, { report_date: "2026-09-17", spend: 1, sales_7d: 2 }, { spend: 50, sales_7d: 50 }];
  assert.deepEqual(weekAdKpis(sp, [], [], "2026-09-11", "2026-09-17"), { spend: 2, adSales: 4 });
});

test("weekAdKpis applies the SP spend divisor to spend only, never to sales", () => {
  const sp = [{ report_date: "2026-09-12", spend: 90, sales_7d: 300 }];
  assert.deepEqual(weekAdKpis(sp, [], [], "2026-09-11", "2026-09-17", () => 3), { spend: 30, adSales: 300 });
});

test("ROAS/ACOS are 0, not NaN/Infinity, with no spend or no sales", () => {
  assert.equal(roasOf({ spend: 0, adSales: 100 }), 0);
  assert.equal(acosPctOf({ spend: 100, adSales: 0 }), 0);
});

test("productMapForPeriod uses the workbook's net Total Sales and gross Orders per SKU", () => {
  const products = [
    { sku: "A", name: "Alpha", category: "Gynecology", periods: { W2: { orders: 4, totalSales: 0 } } }, // fully returned
    { sku: "B", name: "Beta", category: "Pediatrics", periods: { W1: { orders: 2, totalSales: 500 } } },
  ];
  const w2 = productMapForPeriod(products, "W2");
  assert.equal(w2.size, 1);
  assert.deepEqual(w2.get("A"), { name: "Alpha", sku: "A", category: "Gynecology", sales: 0, units: 4 });
});
