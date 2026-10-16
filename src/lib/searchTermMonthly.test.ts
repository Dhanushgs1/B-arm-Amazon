import test from "node:test";
import assert from "node:assert/strict";
import { periodForMonth, periodContaining, periodDueOn, latestDuePeriod, bucketRows, toRow } from "./searchTermMonthly.ts";

test("period ends on the 30th; a 31st opens the next month's period", () => {
  assert.deepEqual(periodForMonth(2026, 10), { start: "2026-10-01", end: "2026-10-30", label: "Oct 2026" }); // Sep has 30 days
  assert.deepEqual(periodForMonth(2026, 11), { start: "2026-10-31", end: "2026-11-30", label: "Nov 2026" });
  assert.deepEqual(periodForMonth(2027, 1), { start: "2026-12-31", end: "2027-01-30", label: "Jan 2027" });
  assert.equal(periodContaining("2026-10-31").label, "Nov 2026");
  assert.equal(periodContaining("2026-12-31").label, "Jan 2027");
});

test("February ends on its last day; March then starts on the 1st", () => {
  assert.deepEqual(periodForMonth(2027, 2), { start: "2027-01-31", end: "2027-02-28", label: "Feb 2027" });
  assert.equal(periodForMonth(2028, 2).end, "2028-02-29");
  assert.equal(periodForMonth(2027, 3).start, "2027-03-01");
});

test("mail is due only on the period's last day", () => {
  assert.equal(periodDueOn("2026-10-30")?.label, "Oct 2026");
  assert.equal(periodDueOn("2026-10-29"), null);
  assert.equal(periodDueOn("2026-10-31"), null);
  assert.equal(periodDueOn("2027-02-28")?.label, "Feb 2027");
  assert.equal(latestDuePeriod("2026-10-16").label, "Sep 2026");
  assert.equal(latestDuePeriod("2026-10-31").label, "Oct 2026");
  assert.equal(latestDuePeriod("2026-10-30").label, "Oct 2026");
});

test("sheets: orders 0 with spend, then non-overlapping ACOS bands", () => {
  const rows = [
    { searchTerm: "zero", spend: 100, sales: 0, orders: 0 },
    { searchTerm: "zero-no-spend", spend: 0, sales: 0, orders: 0 },
    { searchTerm: "a60", spend: 60, sales: 100, orders: 1 },
    { searchTerm: "a50", spend: 50, sales: 100, orders: 1 },
    { searchTerm: "a25", spend: 25, sales: 100, orders: 1 },
    { searchTerm: "a13", spend: 13, sales: 100, orders: 1 },
    { searchTerm: "a10", spend: 10, sales: 100, orders: 1 },
  ].map(toRow);
  const b = bucketRows(rows);
  const names = (k: string) => b[k].map((r) => r.searchTerm);
  assert.deepEqual(names("orders0"), ["zero"]);
  assert.deepEqual(names("acos50"), ["a60"]);
  assert.deepEqual(names("acos25"), ["a50", "a25"]);
  assert.deepEqual(names("acos13"), ["a13"]);
});
