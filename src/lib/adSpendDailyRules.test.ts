import test from "node:test";
import assert from "node:assert/strict";
import { resolveDailySpend, type AdSpendRow } from "./adSpendDailyRules.ts";

const r = (start: string, end: string, campaign: string, spend: number, clicks = 0, created_at = "2026-10-24T00:00:00Z"): AdSpendRow =>
  ({ report_start: start, report_end: end, campaign_name: campaign, spend, clicks, created_at });

test("1-day reports are used as-is; overlapping 7-day reports never add on top", () => {
  const rows = [
    ...["20", "21", "22", "23", "24", "25", "26"].map((d) => r(`2026-10-${d}`, `2026-10-${d}`, "Camp A", 100, 10)),
    r("2026-10-20", "2026-10-26", "Camp A", 700, 70),
    r("2026-10-19", "2026-10-25", "Camp A", 650, 65), // overlaps too
  ];
  const s = resolveDailySpend(rows, "2026-10-20", "2026-10-26");
  assert.equal(s.spend, 700); // not 700 + 700 + 650
  assert.equal(s.clicks, 70);
  assert.equal(s.coveredDays, 7);
  assert.ok(s.days.every((d) => d.source === "daily"));
});

test("a missing day is worked out exactly from a 7-day report when the other 6 days are known", () => {
  const rows = [
    ...["17", "18", "19", "20", "21", "23"].map((d) => r(`2026-10-${d}`, `2026-10-${d}`, "Meta 1", 1000, 0)),
    r("2026-10-17", "2026-10-23", "Meta 1", 7202.14, 0),
  ];
  const s = resolveDailySpend(rows, "2026-10-22", "2026-10-22");
  assert.deepEqual(s.days, [{ date: "2026-10-22", spend: 1202.14, clicks: 0, source: "derived" }]);
});

test("derivation chains: a derived day can unlock another window", () => {
  const rows = [
    r("2026-10-01", "2026-10-01", "A", 10), r("2026-10-02", "2026-10-02", "A", 20),
    r("2026-10-01", "2026-10-03", "A", 60), // -> 03 = 30
    r("2026-10-02", "2026-10-04", "A", 90), // needs 03 first -> 04 = 40
  ];
  const s = resolveDailySpend(rows, "2026-10-01", "2026-10-04");
  assert.deepEqual(s.days.map((d) => [d.date, d.spend, d.source]), [
    ["2026-10-01", 10, "daily"], ["2026-10-02", 20, "daily"], ["2026-10-03", 30, "derived"], ["2026-10-04", 40, "derived"],
  ]);
});

test("days that can't be worked out stay unknown and are left out of the total", () => {
  const rows = [r("2026-10-20", "2026-10-20", "A", 50), r("2026-10-21", "2026-10-27", "A", 700)]; // 7 unknown days in that window
  const s = resolveDailySpend(rows, "2026-10-20", "2026-10-22");
  assert.deepEqual(s.days.map((d) => [d.date, d.spend, d.source]), [["2026-10-20", 50, "daily"], ["2026-10-21", null, null], ["2026-10-22", null, null]]);
  assert.equal(s.spend, 50);
  assert.equal(s.coveredDays, 1);
  assert.equal(s.totalDays, 3);
});

test("per-campaign: a campaign absent from a day's report spent 0 that day; names match ignoring case/spacing", () => {
  const rows = [
    r("2026-10-20", "2026-10-20", "Bulb  Kit", 40, 4),
    r("2026-10-20", "2026-10-20", "Strips", 60, 6),
    r("2026-10-21", "2026-10-21", "bulb kit", 25, 2),
  ];
  const s = resolveDailySpend(rows, "2026-10-20", "2026-10-21");
  assert.deepEqual(s.campaigns, [{ name: "Bulb Kit", spend: 65, clicks: 6 }, { name: "Strips", spend: 60, clicks: 6 }]);
  assert.equal(s.spend, 125);
});

test("the same window loaded twice keeps only its latest load", () => {
  const rows = [r("2026-10-20", "2026-10-20", "A", 100, 0, "2026-10-21T08:00:00Z"), r("2026-10-20", "2026-10-20", "A", 120, 0, "2026-10-21T09:00:00Z")];
  assert.equal(resolveDailySpend(rows, "2026-10-20", "2026-10-20").spend, 120);
});

test("derived per-campaign values never go negative from export rounding", () => {
  const rows = [r("2026-10-01", "2026-10-01", "A", 10.004), r("2026-10-01", "2026-10-02", "A", 10)];
  const s = resolveDailySpend(rows, "2026-10-02", "2026-10-02");
  assert.equal(s.days[0].spend, 0);
  assert.equal(s.days[0].source, "derived");
});
