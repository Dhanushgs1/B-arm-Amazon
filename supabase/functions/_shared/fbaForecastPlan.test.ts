import { assertEquals } from "https://deno.land/std@0.224.0/testing/asserts.ts";
import { buildPlan } from "./fbaForecastPlan.ts";

Deno.test("buildPlan applies each SKU's saved X to every one of its zones", () => {
  const plan = buildPlan(
    [
      { row_order: 1, sku: "A", zone: "Z2" },
      { row_order: 0, sku: "A", zone: "Z1" },
      { row_order: 2, sku: "B", zone: "Z1" },
      { row_order: 3, sku: "C", zone: "Z1" },
    ],
    [{ sku: "A", stock_to_send: "35" }, { sku: "B", stock_to_send: null }],
  );
  assertEquals(plan, [
    { sku: "A", zone: "Z1", stockToSend: 35, order: 0 },
    { sku: "A", zone: "Z2", stockToSend: 35, order: 1 },
    { sku: "B", zone: "Z1", stockToSend: null, order: 2 }, // blank X
    { sku: "C", zone: "Z1", stockToSend: null, order: 3 }, // no X row
  ]);
});

Deno.test("buildPlan returns undefined when no SKU x zone plan is stored", () => {
  assertEquals(buildPlan([], [{ sku: "A", stock_to_send: 5 }]), undefined);
});
