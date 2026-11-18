import test from "node:test";
import assert from "node:assert/strict";
import { latestByPincode, deliveryTone, fcTable, adState, campaignKeywords } from "./marketing360Rules.ts";
import { pincodeState, pos, toIsoDate, dateFromName } from "./marketing360Import.ts";

const chk = (pincode: string, week: string, scraped_date: string, days: number | null, status = "Confirmed Estimate") =>
  ({ week, platform: "Amazon", pincode, tier: null, location: null, delivery_text: null, days, scraped_date, status });

test("latest delivery check per pincode wins, with its state", () => {
  const out = latestByPincode([chk("110001", "2026-W46", "2026-11-03", 4), chk("110001", "2026-W48", "2026-11-16", 2), chk("600001", "2026-W45", "2026-10-27", 5)]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((o) => [o.state, o.days]), [["Delhi", 2], ["Tamil Nadu", 5]]);
});

test("an override beats the PIN prefix", () => {
  assert.equal(latestByPincode([chk("403001", "W", "2026-11-01", 1)], { "403001": "Goa (override)" })[0].state, "Goa (override)");
});

test("pincode prefixes map nested states correctly", () => {
  assert.equal(pincodeState("403001"), "Goa");
  assert.equal(pincodeState("400001"), "Maharashtra");
  assert.equal(pincodeState("737101"), "Sikkim");
  assert.equal(pincodeState("834001"), "Jharkhand");
  assert.equal(pincodeState("800001"), "Bihar");
  assert.equal(pincodeState("248001"), "Uttarakhand");
  assert.equal(pincodeState("244001"), "Uttar Pradesh");
  assert.equal(pincodeState("799001"), "Tripura");
});

test("delivery tone never treats unavailable as fast", () => {
  assert.equal(deliveryTone({ status: "Currently Unavailable", days: 1 }), "none");
  assert.equal(deliveryTone({ status: "Confirmed Estimate", days: 2 }), "fast");
  assert.equal(deliveryTone({ status: "Confirmed", days: 7 }), "slow");
});

test("FC table: Yes FCs with zero stock, in-progress FCs, and stocked FCs not in the sheet", () => {
  const rows = fcTable([{ code: "DEL4", region: "Gurgaon" }, { code: "BLR7", region: "Bangalore" }], [{ fc: "BLR7", quantity: 5 }, { fc: "BLR7", quantity: 3 }, { fc: "XYZ1", quantity: 2 }]);
  assert.deepEqual(rows.map((r) => [r.fc, r.onboarded, r.stock]), [["DEL4", "Yes", 0], ["BLR7", "Yes", 8], ["COX1", "In progress", 0], ["RJX1", "In progress", 0], ["XYZ1", "No", 2]]);
});

test("ad state keeps missing data apart from off", () => {
  assert.equal(adState(null), "No data");
  assert.equal(adState(0), "Off");
  assert.equal(adState(12.5), "On");
});

test("campaign keywords: profile list first, else first meaningful word", () => {
  assert.deepEqual(campaignKeywords("postpartum, p0stpartum", "x"), ["postpartum", "p0stpartum"]);
  assert.deepEqual(campaignKeywords(null, "Postpartum Recovery Essentials care kit (10 pcs kit)"), ["postpartum"]);
  assert.deepEqual(campaignKeywords("", "B-Arm Kit"), []);
});

test("positions and dates", () => {
  assert.equal(pos("NOT FOUND"), null);
  assert.equal(pos(13), 13);
  assert.equal(toIsoDate("11-Oct-2026"), "2026-10-11");
  assert.equal(toIsoDate(46340), "2026-11-14");
  assert.equal(dateFromName("AM FK Rating and Review - 16 Nov 2026_Ratings & Reviews (final).xlsx"), "2026-11-16");
  assert.equal(dateFromName("FBA Forecasting 2026-11-16.xlsx"), "2026-11-16");
});
