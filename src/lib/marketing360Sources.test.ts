import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceRows, weekTagDate, type SourceDates } from "./marketing360Sources.ts";

// the stored dates as checked on 2026-11-18
const d: SourceDates = {
  rating: "2026-11-16", fc: "2026-11-14", forecast: "2026-11-16", positions: "2026-11-11", delivery: "2026-11-17",
  amazonAds: "2026-10-29", amazonDaily: "2026-11-16", google: "2026-11-16", meta: "2026-11-16",
  compPrices: "2026-10-28T12:30:00+00:00", compRatingsWeek: "WK2026-43", fbaReport: "2026-10-31T04:33:35+00:00",
  priceListing: "2026-10-31T04:33:11+00:00", botPrice: "2026-11-16T05:26:57+00:00",
};
const by = (g: string) => sourceRows(d, "2026-11-18").find((r) => r.group === g)!;

test("week tag → Monday of that ISO week", () => {
  assert.equal(weekTagDate("WK2026-43"), "2026-10-19");
  assert.equal(weekTagDate("WK2026-01"), "2025-12-29");
  assert.equal(weekTagDate("nonsense"), null);
  assert.equal(weekTagDate(null), null);
});

test("current vs old against today", () => {
  assert.equal(by("Rating & reviews — ours").status, "current");      // weekly, 2 days
  assert.equal(by("Listing position").status, "current");             // weekly, 7 days
  assert.equal(by("Delivery date").status, "current");                // 1 day
  assert.equal(by("Amazon ads").status, "old");                       // 20 days
  assert.equal(by("Amazon ads").ageDays, 20);
  assert.equal(by("Price — competitor").status, "old");
  assert.equal(by("Rating & reviews — competitor").status, "old");
  assert.equal(by("FBA stock — Available, Inbound").upTo, "2026-10-31");
  assert.equal(by("FBA stock — Available, Inbound").status, "old");
});

test("notes explain the mismatches the user asked about", () => {
  assert.match(by("Amazon ads").note!, /2026-11-16/);                 // a newer daily upload exists
  assert.match(by("FBA stock — FCs, sales, to send").note!, /2026-11-14/); // FC ledger date inside the 16 Nov file
});

test("missing source and typed fields", () => {
  const rows = sourceRows({ ...d, positions: null }, "2026-11-18");
  assert.equal(rows.find((r) => r.group === "Listing position")!.status, "missing");
  assert.equal(rows.find((r) => r.group === "Retargeting")!.status, "typed");
  assert.equal(rows.find((r) => r.group === "Ads suggestion")!.status, "rule");
});
