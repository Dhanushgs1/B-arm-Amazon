import test from "node:test";
import assert from "node:assert/strict";
import { parseDisplayValue, formatDisplayValue } from "./animatedValue.ts";

const roundTrip = (s: string) => {
  const p = parseDisplayValue(s);
  assert.ok(p, `should parse ${s}`);
  return formatDisplayValue(p, p.value);
};

test("the final frame is exactly the string the page passed", () => {
  for (const s of ["₹12,48,300", "₹0", "3.42x", "0.00x", "18.50%", "0.00%", "1,204", "₹1,23,45,678", "-₹500", "₹-500", "42 units", "₹8.75"]) {
    assert.equal(roundTrip(s), s);
  }
});

test("prefix, decimals, grouping and suffix are read from the display string", () => {
  assert.deepEqual(parseDisplayValue("₹12,48,300"), { prefix: "₹", value: 1248300, decimals: 0, grouped: true, suffix: "" });
  assert.deepEqual(parseDisplayValue("3.42x"), { prefix: "", value: 3.42, decimals: 2, grouped: false, suffix: "x" });
  assert.deepEqual(parseDisplayValue("18.5%"), { prefix: "", value: 18.5, decimals: 1, grouped: false, suffix: "%" });
});

test("intermediate frames keep the final format (Indian grouping, fixed decimals)", () => {
  const rupees = parseDisplayValue("₹12,48,300")!;
  assert.equal(formatDisplayValue(rupees, 624150.4), "₹6,24,150");
  const ratio = parseDisplayValue("3.40x")!;
  assert.equal(formatDisplayValue(ratio, 1.7), "1.70x");
  // A value written without grouping never gains commas mid-count.
  const plain = parseDisplayValue("1204")!;
  assert.equal(formatDisplayValue(plain, 1100), "1100");
});

test("values that can't be counted safely are left alone", () => {
  assert.equal(parseDisplayValue("—"), null);
  assert.equal(parseDisplayValue("N/A"), null);
  assert.equal(parseDisplayValue("12 / 30"), null);
  assert.equal(parseDisplayValue("₹1,200 (3 orders)"), null);
});
