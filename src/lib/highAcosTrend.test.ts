import test from "node:test";
import assert from "node:assert/strict";
import { buildAcosTrend, lastIstDates, acosTrendCsv } from "./highAcosTrend.ts";

const DATES = ["2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10"];
// spend/sales per day for one campaign → perDay input
const series = (name: string, days: [number, number][], id = name) =>
  days.map(([spend, sales]) => ({ campaignId: id, campaignName: name, spend, sales, orders: sales > 0 ? 1 : 0 }));
const perDay = (...campaigns: ReturnType<typeof series>[]) =>
  DATES.map((date, i) => ({ date, rows: campaigns.map((c) => c[i]).filter((r) => r.spend > 0 || r.sales > 0) }));

test("keeps only campaigns whose 7-day ACOS is above the threshold", () => {
  const good = series("Good", DATES.map(() => [100, 1000])); // 10%
  const bad = series("Bad", DATES.map(() => [100, 500])); // 20%
  const edge = series("Edge", DATES.map(() => [140, 1000])); // exactly 14% — not above
  const rows = buildAcosTrend(perDay(good, bad, edge), 14, 200);
  assert.deepEqual(rows.map((r) => r.name), ["Bad"]);
  assert.equal(Math.round(rows[0].acos!), 20);
  assert.equal(rows[0].daysAbove, 7);
});

test("spend with no sales is flagged, per day and overall; no-spend days are null", () => {
  const c = series("Burner", [[0, 0], [100, 0], [100, 0], [100, 0], [0, 0], [100, 0], [100, 0]]);
  const [r] = buildAcosTrend(perDay(c), 14, 200);
  assert.equal(r.acos, null);
  assert.equal(r.days[0].acos, null);
  assert.equal(r.days[0].noSales, false);
  assert.equal(r.days[1].noSales, true);
  assert.equal(r.daysAbove, 5);
});

test("min spend drops tiny campaigns", () => {
  const tiny = series("Tiny", DATES.map(() => [20, 0])); // ₹140 total
  assert.equal(buildAcosTrend(perDay(tiny), 14, 200).length, 0);
});

test("trend compares the last 3 days with the 4 before", () => {
  const worse = series("Worse", [[100, 1000], [100, 1000], [100, 1000], [100, 1000], [100, 200], [100, 200], [100, 200]]);
  const better = series("Better", [[100, 200], [100, 200], [100, 200], [100, 200], [100, 1000], [100, 1000], [100, 1000]]);
  const flat = series("Flat", DATES.map(() => [100, 400]));
  const fresh = series("Fresh", [[0, 0], [0, 0], [0, 0], [0, 0], [300, 500], [300, 500], [300, 500]]);
  const byName = Object.fromEntries(buildAcosTrend(perDay(worse, better, flat, fresh), 14, 200).map((r) => [r.name, r.trend]));
  assert.deepEqual(byName, { Worse: "worse", Better: "better", Flat: "flat", Fresh: "new" });
});

test("sorted by spend, merged by campaign id across days", () => {
  const a = series("A", DATES.map(() => [100, 0]), "1");
  const b = series("B", DATES.map(() => [300, 0]), "2");
  assert.deepEqual(buildAcosTrend(perDay(a, b), 14, 200).map((r) => r.name), ["B", "A"]);
});

test("lastIstDates: 7 complete IST days ending yesterday", () => {
  // 2026-10-11 01:00 IST = 2026-10-10 19:30 UTC
  assert.deepEqual(lastIstDates(7, new Date("2026-10-10T19:30:00Z")), DATES);
});

test("csv has one column per day and every row", () => {
  const rows = buildAcosTrend(perDay(series("Bad, \"quoted\"", DATES.map(() => [100, 500]))), 14, 200);
  const lines = acosTrendCsv(rows, DATES).split("\r\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /ACOS % 2026-10-04/);
  assert.match(lines[1], /^"Bad, ""quoted""","20.0"/);
});
