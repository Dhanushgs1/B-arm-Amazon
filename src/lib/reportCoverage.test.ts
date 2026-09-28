import test from "node:test";
import assert from "node:assert/strict";
import { staleSourceWarnings } from "./reportCoverage.ts";

const C = "returns are understated for those days.";

test("warns for a source that stops before the end date (AM returns stopped on 3 Sep)", () => {
  const out = staleSourceWarnings([{ label: "AM returns", maxDate: "2026-09-03" }], "2026-09-17", C);
  assert.equal(out.length, 1);
  assert.match(out[0], /AM returns only reaches 2026-09-03, but this report runs to 2026-09-17/);
  assert.match(out[0], /missing from the synced data, not zero/);
});

test("no warning when a source reaches the end date exactly or beyond", () => {
  assert.deepEqual(staleSourceWarnings([{ label: "FBA returns", maxDate: "2026-09-17" }, { label: "SF", maxDate: "2026-09-20" }], "2026-09-17", C), []);
});

test("an unreadable or empty source is flagged as unchecked rather than trusted", () => {
  const out = staleSourceWarnings([{ label: "SellerFlex returns", maxDate: null, error: "timeout" }, { label: "FBA returns", maxDate: null }], "2026-09-17", C);
  assert.equal(out.length, 2);
  assert.match(out[0], /could not check how far SellerFlex returns reaches \(timeout\)/);
});

test("month boundary compares as dates, and the formatter is applied", () => {
  const out = staleSourceWarnings([{ label: "AM returns", maxDate: "2026-08-31" }], "2026-09-01", C, (d) => d.split("-").reverse().join("."));
  assert.match(out[0], /reaches 31\.08\.2026, but this report runs to 01\.09\.2026/);
});
