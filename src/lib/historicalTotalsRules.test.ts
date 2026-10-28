import test from "node:test";
import assert from "node:assert/strict";
import { computeGrandTotals, type GrandPairInput, type GrandSkuInput } from "./historicalTotalsRules.ts";

// Fixture: SKU A is advertised by TWO campaigns (C1, C2), so its SKU-grain figures repeat on both rows.
// SKU B is advertised by one campaign (C1). Naive row sums would count A's orders/returns/units twice.
const PRICE_A = 500;
const PRICE_B = 200;
const pairs: GrandPairInput[] = [
  { sku: "A", price: PRICE_A, spendTax: 118, advUnits: 5 }, // C1 x A
  { sku: "A", price: PRICE_A, spendTax: 59, advUnits: 3 },  // C2 x A
  { sku: "B", price: PRICE_B, spendTax: 24, advUnits: 2 },  // C1 x B
];
const skus: GrandSkuInput[] = [
  { sku: "A", price: PRICE_A, totalUnits: 30, orderUnits: 10, returns: 2 },
  { sku: "B", price: PRICE_B, totalUnits: 6, orderUnits: 4, returns: 0 },
];

test("Orders and Returns are counted once per SKU, not once per campaign row", () => {
  const t = computeGrandTotals(pairs, skus);
  // Naive row sum would be 10 + 10 + 4 = 24 orders and 2 + 2 = 4 returns.
  assert.equal(t.orderUnits, 14);
  assert.equal(t.returns, 2);
});

test("a plain SUM of the row-level Orders column over-counts; the grand total does not", () => {
  // Row-level Orders repeat each SKU's figure on every campaign row, exactly as the Analysis sheet writes them.
  // Summing that column (what a reader's Excel SUM does) gives 10 + 10 + 4 = 24, not the 14 real orders.
  const rowOrders = pairs.map((p) => skus.find((s) => s.sku === p.sku)!.orderUnits);
  const columnSum = rowOrders.reduce((s, v) => s + v, 0);
  assert.equal(columnSum, 24);
  assert.equal(computeGrandTotals(pairs, skus).orderUnits, 14);
});

test("Total Units is counted once per SKU", () => {
  const t = computeGrandTotals(pairs, skus);
  // Naive row sum would be 30 + 30 + 6 = 66.
  assert.equal(t.totalUnits, 36);
});

test("Spend+Tax and Advertised Units are summed over pairs (each pair's own figures)", () => {
  const t = computeGrandTotals(pairs, skus);
  assert.equal(t.spendTax, 201);
  assert.equal(t.advUnits, 10);
});

test("Final is Orders minus Returns, unclamped, and equals the sum of SKU finals", () => {
  const t = computeGrandTotals(pairs, skus);
  assert.equal(t.final, 12);
  const perSku = skus.reduce((s, r) => s + (r.orderUnits - r.returns), 0);
  assert.equal(t.final, perSku);
});

test("a negative net (returns with no in-window orders) stays negative at grand-total level", () => {
  const t = computeGrandTotals(
    [{ sku: "C", price: 300, spendTax: 0, advUnits: 0 }],
    [{ sku: "C", price: 300, totalUnits: 0, orderUnits: 0, returns: 5 }],
  );
  assert.equal(t.final, -5);
});

test("ACOS is aggregate spend over Σ(price × advertised units), not an average of row ratios", () => {
  const t = computeGrandTotals(pairs, skus);
  // Denominator: 500×5 + 500×3 + 200×2 = 4400.
  assert.equal(t.acosDenom, 4400);
  assert.ok(Math.abs(t.acos - 201 / 4400) < 1e-12);
});

test("ACOS denominator uses the SKU price on every campaign row, so a duplicated SKU is not re-priced", () => {
  const t = computeGrandTotals(pairs, skus);
  const naiveAvg = (118 / (PRICE_A * 5) + 59 / (PRICE_A * 3) + 24 / (PRICE_B * 2)) / 3;
  assert.notEqual(Number(t.acos.toFixed(9)), Number(naiveAvg.toFixed(9)));
});

test("CPC is Spend+Tax over advertised units at grand level", () => {
  const t = computeGrandTotals(pairs, skus);
  assert.ok(Math.abs(t.cpc - 201 / 10) < 1e-12);
});

test("TACOS uses each SKU's total spend over Σ(price × net orders), net floored per SKU", () => {
  const t = computeGrandTotals(pairs, skus);
  // Net per SKU: A = 10-2 = 8, B = 4. Denominator: 500×8 + 200×4 = 4800.
  assert.equal(t.tacosDenom, 4800);
  assert.ok(Math.abs(t.tacos - 201 / 4800) < 1e-12);
});

test("a SKU whose returns exceed its orders adds nothing to the TACOS denominator", () => {
  const t = computeGrandTotals(
    [...pairs, { sku: "C", price: 300, spendTax: 40, advUnits: 1 }],
    [...skus, { sku: "C", price: 300, totalUnits: 1, orderUnits: 1, returns: 3 }],
  );
  // C contributes 0 to the denominator (floored), but its spend still counts in the numerator.
  assert.equal(t.tacosDenom, 4800);
  assert.ok(Math.abs(t.tacos - (201 + 40) / 4800) < 1e-12);
  assert.equal(t.final, 12 - 2);
});

test("a SKU advertised by three campaigns is still counted once for Orders, Returns and Units", () => {
  const triple: GrandPairInput[] = [
    { sku: "A", price: PRICE_A, spendTax: 10, advUnits: 1 },
    { sku: "A", price: PRICE_A, spendTax: 10, advUnits: 1 },
    { sku: "A", price: PRICE_A, spendTax: 10, advUnits: 1 },
  ];
  const t = computeGrandTotals(triple, [skus[0]]);
  assert.equal(t.orderUnits, 10);
  assert.equal(t.returns, 2);
  assert.equal(t.totalUnits, 30);
  assert.equal(t.spendTax, 30);
});

test("empty input yields zero totals and no division by zero", () => {
  const t = computeGrandTotals([], []);
  assert.equal(t.spendTax, 0);
  assert.equal(t.acos, 0);
  assert.equal(t.tacos, 0);
  assert.equal(t.cpc, 0);
});
