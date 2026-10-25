import test from "node:test";
import assert from "node:assert/strict";
import { axisTick } from "./axisTick.ts";

test("Indian short form with the prefix kept", () => {
  assert.equal(axisTick(0, "₹"), "₹0");
  assert.equal(axisTick(450), "450");
  assert.equal(axisTick(75000, "₹"), "₹75K");
  assert.equal(axisTick(100000, "₹"), "₹1L");
  assert.equal(axisTick(125000, "₹"), "₹1.3L");
  assert.equal(axisTick(1250000, "₹"), "₹13L");
  assert.equal(axisTick(25000000, "₹"), "₹2.5Cr");
});

test("negatives and odd input", () => {
  assert.equal(axisTick(-75000, "₹"), "-₹75K");
  assert.equal(axisTick("12.345"), "12.35");
  assert.equal(axisTick("n/a", "₹"), "₹n/a");
});
