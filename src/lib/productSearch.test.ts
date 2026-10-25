import test from "node:test";
import assert from "node:assert/strict";
import { matchesProductQuery } from "./productSearch.ts";

const NAME = "Glucospark Blood Glucose Test Strips – Pack of 50";

test("empty or blank query matches everything", () => {
  assert.equal(matchesProductQuery("", NAME, "SC50"), true);
  assert.equal(matchesProductQuery("   ", NAME, "SC50"), true);
});

test("case-insensitive, words in any order, across name and SKU", () => {
  assert.equal(matchesProductQuery("glucose 50", NAME, "SC50"), true);
  assert.equal(matchesProductQuery("STRIPS glucospark", NAME, "SC50"), true);
  assert.equal(matchesProductQuery("sc50", NAME, "SC50"), true);
  assert.equal(matchesProductQuery("glucose sc5", NAME, "SC50"), true);
});

test("every word must match", () => {
  assert.equal(matchesProductQuery("glucose thermometer", NAME, "SC50"), false);
});

test("SKU lists and missing fields are handled", () => {
  assert.equal(matchesProductQuery("b-dummy", "Blood Sugar Control", ["B-DUMMY", "X1"]), true);
  assert.equal(matchesProductQuery("x1", null, undefined, ["B-DUMMY", "X1"]), true);
  assert.equal(matchesProductQuery("x2", null, undefined, []), false);
});
