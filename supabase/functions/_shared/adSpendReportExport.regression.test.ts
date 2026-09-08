import { assertEquals } from "https://deno.land/std@0.224.0/testing/asserts.ts";
import { spendTax, computeCpc, computeAcos, getDateWindow, groupProductsByName } from "./adSpendReportExport.ts";

Deno.test("spendTax applies the flat 1.18 GST multiplier when none is tagged", () => {
  assertEquals(spendTax({ spend: 100, units: 5 }), 118);
});

Deno.test("computeCpc falls back to spendTax when units is 0", () => {
  assertEquals(computeCpc({ spend: 100, units: 0 }), 118);
});

Deno.test("computeAcos is CPC / price, and 0 when price is 0", () => {
  assertEquals(computeAcos({ spend: 100, units: 10 }, 20), 118 / 10 / 20);
  assertEquals(computeAcos({ spend: 100, units: 10 }, 0), 0);
});

Deno.test("getDateWindow computes a pure UTC-midnight trailing window, not local time", () => {
  assertEquals(getDateWindow("2026-09-08", 7), { start: "2026-09-02", end: "2026-09-08" });
});

Deno.test("groupProductsByName sums spend/units across SKU variants of the same product", () => {
  const rows = groupProductsByName([
    { platform: "Amazon" as const, sku: "SKU-A", name: "Widget", price: 100, day: { spend: 10, units: 1 }, range: { spend: 50, units: 5 } },
    { platform: "Amazon" as const, sku: "SKU-B", name: "widget", price: 0, day: { spend: 5, units: 1 }, range: { spend: 20, units: 2 } },
  ]);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].day.spend, 15);
  assertEquals(rows[0].range.units, 7);
  assertEquals(rows[0].sku, "SKU-A, SKU-B");
});
