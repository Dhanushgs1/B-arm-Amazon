import { assertEquals } from "https://deno.land/std@0.224.0/testing/asserts.ts";
import { computeFbaAnalysis, type SalesRow, type StockRow, type StatusRow } from "./fbaForecastCalc.ts";

// Two SKUs ("A", "B") sharing one product name ("Widget"), across two zones
// (Z1, Z2) — enough to exercise every column's formula, including the SKU-
// level rollups and the cross-SKU max-forecast-per-product dedup. Expected
// values hand-computed against the exact formulas in docs/superpowers/
// specs/2026-09-22-fba-forecast-refresh-design.md.
const names: Record<string, string> = { A: "Widget", B: "Widget" };
const resolveProductName = (sku: string) => names[sku] || sku;

const salesRows: SalesRow[] = [
  { sku: "A", zone: "Z1", quantity: 60 },
  { sku: "A", zone: "Z2", quantity: 30 },
  { sku: "B", zone: "Z1", quantity: 150 },
];
const stockRows: StockRow[] = [
  { sku: "A", zone: "Z1", quantity: 50 },
  { sku: "A", zone: "Z2", quantity: 10 },
  { sku: "B", zone: "Z1", quantity: 20 },
];
const statusRows: StatusRow[] = [
  { sku: "A", zone: "Z1", quantity: 5, category: "booked" },
  { sku: "A", zone: "Z1", quantity: 5, category: "picked_up" },
  { sku: "A", zone: "Z2", quantity: 2, category: "picked_up" },
  { sku: "B", zone: "Z1", quantity: 40, category: "active" },
];
function rowFor(rows: ReturnType<typeof computeFbaAnalysis>, sku: string, zone: string) {
  const row = rows.find((r) => r.sku === sku && r.zone === zone);
  if (!row) throw new Error(`no row for ${sku}/${zone}`);
  return row;
}

Deno.test("computeFbaAnalysis: per-zone forecast/stock/inbound math", () => {
  const rows = computeFbaAnalysis(salesRows, stockRows, statusRows, resolveProductName);
  const az1 = rowFor(rows, "A", "Z1");
  assertEquals(az1.sales30d, 60);
  assertEquals(az1.dailyRate, 2);
  assertEquals(az1.forecast120dZone, 240);
  assertEquals(az1.currentStockZone, 50);
  assertEquals(az1.bookedZone, 5);
  assertEquals(az1.intransitZone, 5);
  assertEquals(az1.stockNeededZone, 190);
  assertEquals(az1.stockNeededAfterInboundZone, 180);
  assertEquals(az1.daysUntilStockout, 30);

  const az2 = rowFor(rows, "A", "Z2");
  assertEquals(az2.forecast120dZone, 120);
  assertEquals(az2.stockNeededAfterInboundZone, 108);
  assertEquals(az2.daysUntilStockout, 12);
});

Deno.test("computeFbaAnalysis: SKU-level rollups sum across that SKU's zones", () => {
  const rows = computeFbaAnalysis(salesRows, stockRows, statusRows, resolveProductName);
  const az1 = rowFor(rows, "A", "Z1");
  const az2 = rowFor(rows, "A", "Z2");
  assertEquals(az1.totalOrders30dSku, 90);
  assertEquals(az1.totalForecast120dSku, 360);
  assertEquals(az1.totalStockSku, 60);
  assertEquals(az1.totalStockNeededAfterInboundSku, 288);
  // Same SKU-level total on every one of that SKU's zone rows.
  assertEquals(az2.totalStockNeededAfterInboundSku, 288);
});

Deno.test("computeFbaAnalysis: max-forecast-per-product dedups SKUs sharing a product name", () => {
  const rows = computeFbaAnalysis(salesRows, stockRows, statusRows, resolveProductName);
  // SKU B's own 120-day forecast (600) exceeds SKU A's (360) — both SKUs'
  // rows report B's larger figure since they share the "Widget" product name.
  assertEquals(rowFor(rows, "A", "Z1").maxForecastPerProduct, 600);
  assertEquals(rowFor(rows, "B", "Z1").maxForecastPerProduct, 600);
});

Deno.test("computeFbaAnalysis: to-be-sent/stock-to-be-ordered are the uncapped need directly (no manual shipment cap)", () => {
  const rows = computeFbaAnalysis(salesRows, stockRows, statusRows, resolveProductName);
  const az1 = rowFor(rows, "A", "Z1");
  const az2 = rowFor(rows, "A", "Z2");
  const bz1 = rowFor(rows, "B", "Z1");
  // toBeSentZone === that row's own stockNeededAfterInboundZone; stockToBeOrderedZone
  // === that row's own totalStockNeededAfterInboundSku — both surfaced directly, no
  // ratio-against-a-cap transformation.
  assertEquals(az1.toBeSentZone, az1.stockNeededAfterInboundZone);
  assertEquals(az1.toBeSentZone, 180);
  assertEquals(az1.stockToBeOrderedZone, az1.totalStockNeededAfterInboundSku);
  assertEquals(az1.stockToBeOrderedZone, 288);

  assertEquals(az2.toBeSentZone, az2.stockNeededAfterInboundZone);
  assertEquals(az2.toBeSentZone, 108);
  assertEquals(az2.stockToBeOrderedZone, 288);

  assertEquals(bz1.toBeSentZone, bz1.stockNeededAfterInboundZone);
  assertEquals(bz1.toBeSentZone, 580);
  assertEquals(bz1.stockToBeOrderedZone, bz1.totalStockNeededAfterInboundSku);
  assertEquals(bz1.stockToBeOrderedZone, 580);
});

Deno.test("computeFbaAnalysis: active quantity accumulates per (sku, zone), independent of booked/intransit", () => {
  const rows = computeFbaAnalysis(salesRows, stockRows, statusRows, resolveProductName);
  assertEquals(rowFor(rows, "B", "Z1").activeZoneAccumulated, 40);
  assertEquals(rowFor(rows, "A", "Z1").activeZoneAccumulated, 0);
});

Deno.test("computeFbaAnalysis: sales-% region is this zone's share of the SKU's total forecast", () => {
  const rows = computeFbaAnalysis(salesRows, stockRows, statusRows, resolveProductName);
  assertEquals(rowFor(rows, "A", "Z1").salesPctRegion, 240 / 360);
  assertEquals(rowFor(rows, "B", "Z1").salesPctRegion, 1);
});

Deno.test("computeFbaAnalysis: zero 30-day sales floors the forecast at 5 and blanks days-until-stockout", () => {
  const rows = computeFbaAnalysis(
    [], // no sales rows at all for C — absence, not a quantity:0 row
    [{ sku: "C", zone: "Z1", quantity: 9 }],
    [],
    () => "Zero Sales Product"
  );
  const c = rowFor(rows, "C", "Z1");
  assertEquals(c.forecast120dZone, 5);
  assertEquals(c.daysUntilStockout, "--");
});
