import test from "node:test";
import assert from "node:assert/strict";
import { cpcFormula, cpcPerNetOrder, hasWindowActivity, NOT_APPLICABLE, tacosFormula, tacosSheetRowIncluded, tacosValue } from "./historicalTacosRules.ts";

const w = (spendTax: number, orderUnits: number, returns: number) => ({ spendTax, orderUnits, returns });

// ── Row selection ──────────────────────────────────────────────────────────

test("a SKU with spend but no orders or returns is kept (spend-only)", () => {
  assert.equal(tacosSheetRowIncluded(w(1143.99, 0, 0), false), true);
});

test("a SKU with orders but no spend is kept", () => {
  assert.equal(tacosSheetRowIncluded(w(0, 4, 0), false), true);
});

test("a SKU with returns only is kept (return-only SKUs stay listed)", () => {
  assert.equal(tacosSheetRowIncluded(w(0, 0, 1), false), true);
});

test("a zero-spend, zero-order, zero-return catalogue SKU is left out", () => {
  assert.equal(tacosSheetRowIncluded(w(0, 0, 0), false), false);
});

test("the UNMAPPED placeholder is never a TACOS row, even with spend", () => {
  assert.equal(tacosSheetRowIncluded(w(500, 3, 1), true), false);
});

test("hasWindowActivity is true for any one of spend, orders or returns", () => {
  assert.equal(hasWindowActivity(w(0.01, 0, 0)), true);
  assert.equal(hasWindowActivity(w(0, 1, 0)), true);
  assert.equal(hasWindowActivity(w(0, 0, 1)), true);
  assert.equal(hasWindowActivity(w(0, 0, 0)), false);
});

test("a negative Final alone (returns with no in-window orders) still counts as return activity", () => {
  assert.equal(tacosSheetRowIncluded(w(0, 0, 5), false), true);
});

// ── N/A behaviour ──────────────────────────────────────────────────────────

test("spend with zero net orders: CPC and TACOS are N/A, never zero", () => {
  assert.equal(cpcPerNetOrder(1143.99, 0), NOT_APPLICABLE);
  assert.equal(tacosValue(1143.99, 0, 2699), NOT_APPLICABLE);
});

test("net orders negative (returns above orders): CPC and TACOS are N/A", () => {
  assert.equal(cpcPerNetOrder(500, -2), NOT_APPLICABLE);
  assert.equal(tacosValue(500, -2, 2699), NOT_APPLICABLE);
});

test("price zero with net orders: CPC is numeric but TACOS is N/A", () => {
  assert.equal(cpcPerNetOrder(300, 3), 100);
  assert.equal(tacosValue(300, 3, 0), NOT_APPLICABLE);
});

test("normal case: CPC and TACOS are numeric", () => {
  assert.equal(cpcPerNetOrder(300, 3), 100);
  assert.ok(Math.abs((tacosValue(300, 3, 500) as number) - 0.2) < 1e-12);
});

test("TACOS is never reported as zero when there are no net orders", () => {
  for (const [spend, final, price] of [[0, 0, 500], [1000, 0, 500], [1000, -3, 500], [1000, 2, 0]] as const) {
    assert.notEqual(tacosValue(spend, final, price), 0);
  }
});

// ── Excel formulas mirror the same N/A rule ───────────────────────────────

test("CPC formula returns N/A when Final orders is zero or negative", () => {
  assert.equal(cpcFormula("C5", "F5"), 'IF(F5>0,C5/F5,"N/A")');
});

test("TACOS formula returns N/A when CPC is not a number or price is zero", () => {
  assert.equal(tacosFormula("E5", "B5"), 'IF(AND(ISNUMBER(E5),B5>0),E5/B5,"N/A")');
});
