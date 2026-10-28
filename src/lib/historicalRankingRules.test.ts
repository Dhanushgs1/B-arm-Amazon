import test from "node:test";
import assert from "node:assert/strict";
import { isRankable, rankableAcos, bestPerforming, worstPerforming } from "./historicalRankingRules.ts";

const camp = (name: string, spendTax: number, advUnits: number, price: number) => ({ name, spendTax, advUnits, price });

test("a campaign with zero or missing price is not rankable and gets no ACOS", () => {
  assert.equal(isRankable({ spendTax: 500, advUnits: 4, price: 0 }), false);
  assert.equal(rankableAcos({ spendTax: 500, advUnits: 4, price: 0 }), null);
  assert.equal(rankableAcos({ spendTax: 500, advUnits: 4, price: Number.NaN }), null);
});

test("a campaign with no attributed units is not rankable, even with spend", () => {
  assert.equal(rankableAcos({ spendTax: 500, advUnits: 0, price: 1000 }), null);
});

test("a campaign with no spend is not rankable", () => {
  assert.equal(rankableAcos({ spendTax: 0, advUnits: 5, price: 1000 }), null);
});

test("ACOS is CPC divided by price", () => {
  // CPC = 1000 / 5 = 200; ACOS = 200 / 1000 = 0.2
  assert.equal(rankableAcos({ spendTax: 1000, advUnits: 5, price: 1000 }), 0.2);
});

test("best performing ignores zero-price 0% campaigns and returns the lowest real ACOS", () => {
  const rows = [
    camp("Catch All (no price)", 800, 0, 0),        // would read 0% under the old code
    camp("Branded", 1000, 10, 1000),                // ACOS 0.1
    camp("Generic", 1000, 2, 1000),                 // ACOS 0.5
    camp("Zero spend", 0, 3, 1000),
  ];
  const best = bestPerforming(rows, 5).map((r) => r.name);
  assert.deepEqual(best, ["Branded", "Generic"]);
});

test("optimize list ranks highest ACOS first and skips unrankable rows", () => {
  const rows = [
    camp("Low", 1000, 10, 1000),                    // 0.1
    camp("High", 1000, 1, 1000),                    // 1.0
    camp("No units", 900, 0, 1000),
  ];
  assert.deepEqual(worstPerforming(rows, 5).map((r) => r.name), ["High", "Low"]);
});

test("limit is applied after ranking, and ties keep input order", () => {
  const rows = [camp("A", 1000, 5, 1000), camp("B", 1000, 5, 1000), camp("C", 2000, 5, 1000)];
  assert.deepEqual(bestPerforming(rows, 2).map((r) => r.name), ["A", "B"]);
});
