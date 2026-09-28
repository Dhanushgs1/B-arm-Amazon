import test from "node:test";
import assert from "node:assert/strict";
import { buildPeriods } from "./salesReportPeriods.ts";

const TODAY = new Date("2026-09-24T12:00:00+05:30");

test("daily: exactly the selected days — the start date is never widened", () => {
  const p = buildPeriods("2026-09-17", "2026-09-17", "daily", TODAY);
  assert.deepEqual(p.map((x) => x.start), ["2026-09-17"]);
  assert.equal(p[0].label, "17.09.2026");
});

test("daily: the last two days before today are flagged not-full (sync lag), older days full", () => {
  const p = buildPeriods("2026-09-20", "2026-09-23", "daily", TODAY);
  assert.deepEqual(p.map((x) => [x.start, x.isFull]), [["2026-09-20", true], ["2026-09-21", true], ["2026-09-22", true], ["2026-09-23", false]]);
});

test("weekly: a trailing partial week is kept (flagged), so the range still ends on the selected date", () => {
  const p = buildPeriods("2026-08-31", "2026-09-17", "weekly", TODAY); // Mon 31 Aug .. Thu 17 Sep
  assert.deepEqual(p.map((x) => [x.start, x.end, x.isFull]), [
    ["2026-08-31", "2026-09-06", true],
    ["2026-09-07", "2026-09-13", true],
    ["2026-09-14", "2026-09-17", false],
  ]);
  assert.equal(p[p.length - 1].end, "2026-09-17");
});

test("weekly: a mid-week start snaps later buckets onto Monday-Sunday weeks, and the short first bucket is not full", () => {
  const p = buildPeriods("2026-09-03", "2026-09-13", "weekly", TODAY); // Thu .. Sun
  assert.deepEqual(p.map((x) => [x.start, x.end, x.isFull]), [["2026-09-03", "2026-09-06", false], ["2026-09-07", "2026-09-13", true]]);
});

test("monthly: month boundaries, a mid-month first bucket is not full, year boundary", () => {
  const p = buildPeriods("2026-11-17", "2027-01-31", "monthly", TODAY);
  assert.deepEqual(p.map((x) => [x.start, x.end, x.isFull]), [
    ["2026-11-17", "2026-11-30", false],
    ["2026-12-01", "2026-12-31", true],
    ["2027-01-01", "2027-01-31", true],
  ]);
});

test("buckets tile the selected range exactly, with no gaps or overlaps (leap February)", () => {
  for (const g of ["daily", "weekly", "monthly"] as const) {
    const p = buildPeriods("2028-02-10", "2028-03-05", g, TODAY);
    assert.equal(p[0].start, "2028-02-10", g);
    assert.equal(p[p.length - 1].end, "2028-03-05", g);
    for (let i = 1; i < p.length; i++) {
      const next = new Date(p[i - 1].end + "T00:00:00Z"); next.setUTCDate(next.getUTCDate() + 1);
      assert.equal(p[i].start, next.toISOString().slice(0, 10), `${g} gap at ${i}`);
    }
  }
});

test("labels do not depend on the machine timezone", () => {
  const prev = process.env.TZ;
  for (const tz of ["Asia/Kolkata", "America/Los_Angeles"]) {
    process.env.TZ = tz;
    assert.equal(buildPeriods("2026-09-01", "2026-09-01", "daily", TODAY)[0].label, "01.09.2026", tz);
  }
  process.env.TZ = prev;
});
