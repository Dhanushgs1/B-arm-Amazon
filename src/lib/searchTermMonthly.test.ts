import test from "node:test";
import assert from "node:assert/strict";
import { periodForMonth, periodContaining, periodDueOn, latestDuePeriod, bucketRows, toRow } from "./searchTermMonthly.ts";

test("period is the whole calendar month: 31-day, 30-day and February", () => {
  assert.deepEqual(periodForMonth(2026, 10), { start: "2026-10-01", end: "2026-10-31", label: "Oct 2026" });
  assert.deepEqual(periodForMonth(2026, 9), { start: "2026-09-01", end: "2026-09-30", label: "Sep 2026" });
  assert.deepEqual(periodForMonth(2026, 11), { start: "2026-11-01", end: "2026-11-30", label: "Nov 2026" });
  assert.deepEqual(periodForMonth(2026, 12), { start: "2026-12-01", end: "2026-12-31", label: "Dec 2026" });
  assert.deepEqual(periodForMonth(2027, 2), { start: "2027-02-01", end: "2027-02-28", label: "Feb 2027" });
  assert.equal(periodForMonth(2028, 2).end, "2028-02-29");
  const ends31 = [1, 3, 5, 7, 8, 10, 12], ends30 = [4, 6, 9, 11];
  for (const m of ends31) assert.equal(periodForMonth(2026, m).end.slice(8), "31");
  for (const m of ends30) assert.equal(periodForMonth(2026, m).end.slice(8), "30");
  assert.equal(periodContaining("2026-10-31").label, "Oct 2026");
});

test("mail is due only on the month's last day", () => {
  assert.equal(periodDueOn("2026-10-31")?.label, "Oct 2026");
  assert.equal(periodDueOn("2026-10-30"), null);
  assert.equal(periodDueOn("2026-09-30")?.label, "Sep 2026");
  assert.equal(periodDueOn("2027-02-28")?.label, "Feb 2027");
  assert.equal(periodDueOn("2028-02-28"), null);
  assert.equal(latestDuePeriod("2026-10-16").label, "Sep 2026");
  assert.equal(latestDuePeriod("2026-10-31").label, "Oct 2026");
  assert.equal(latestDuePeriod("2026-11-01").label, "Oct 2026");
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
