import test from "node:test";
import assert from "node:assert/strict";
import { latestByPincode, deliveryTone, fcTable, adState, campaignKeywords, profileEdit, zoneVerdict, STATE_ZONE, zoneLabel, ourProduct, adsSuggestion, ourSellingPrice } from "./marketing360Rules.ts";
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

const baseRow = { tam: null, primary: "Moms", secondary: null, retarget_yes: ["Whatsapp"], content: { "QR for pamphlet": true } };

test("sheet edit: TAM accepts ₹ and commas, rejects text, empty clears", () => {
  assert.deepEqual(profileEdit(baseRow, { kind: "number", field: "tam_value" }, "₹38,59,57,00,000"), { db: { tam_value: 38595700000 }, row: { tam: 38595700000 } });
  assert.ok("error" in profileEdit(baseRow, { kind: "number", field: "tam_value" }, "lots"));
  assert.deepEqual(profileEdit(baseRow, { kind: "number", field: "tam_value" }, " "), { db: { tam_value: null }, row: { tam: null } });
});

test("sheet edit: text trims, empty becomes null, only the edited column is written", () => {
  assert.deepEqual(profileEdit(baseRow, { kind: "text", field: "secondary_audience" }, "  Hospitals "), { db: { secondary_audience: "Hospitals" }, row: { secondary: "Hospitals" } });
  assert.deepEqual(profileEdit(baseRow, { kind: "text", field: "primary_audience" }, ""), { db: { primary_audience: null }, row: { primary: null } });
});

test("sheet edit: retargeting writes every option true/false in option order", () => {
  const r = profileEdit(baseRow, { kind: "multi", field: "retarget", options: ["Website Based", "Whatsapp", "Cross-selling"] }, ["Cross-selling", "Website Based"]);
  assert.deepEqual(r, { db: { retarget: { "Website Based": true, Whatsapp: false, "Cross-selling": true } }, row: { retarget_yes: ["Website Based", "Cross-selling"] } });
});

test("sheet edit: a content flag keeps the other flags", () => {
  assert.deepEqual(profileEdit(baseRow, { kind: "bool", field: "content", key: "How to use video" }, true),
    { db: { content: { "QR for pamphlet": true, "How to use video": true } }, row: { content: { "QR for pamphlet": true, "How to use video": true } } });
});

test("zone verdict: slow + 0 orders flags likely lost sales; a missing forecast row is not 0 orders", () => {
  const base = { zone: "Assam_zone", pincodes: 4, avg_days: 9, max_days: 10, slow: 3, unavailable: 0, orders_30d: 0, stock: 0 };
  assert.equal(zoneVerdict(base).code, "slow-no-orders");
  assert.equal(zoneVerdict({ ...base, orders_30d: null }).code, "slow-selling");
  assert.equal(zoneVerdict({ ...base, avg_days: 2, orders_30d: 0 }).code, "no-stock");
  assert.equal(zoneVerdict({ ...base, avg_days: 2, orders_30d: 0, stock: 12 }).code, "fast-no-orders");
  assert.equal(zoneVerdict({ ...base, avg_days: 2, orders_30d: 6, stock: 12 }).code, "ok");
  assert.equal(zoneVerdict({ ...base, pincodes: 0, avg_days: null }).code, "no-check");
});

test("zones: every state the pincode map knows has a forecast zone except none", () => {
  for (const pin of ["110001", "682001", "403001", "462001", "834001", "737101", "248001", "160017"]) {
    const s = pincodeState(pin)!;
    assert.ok(STATE_ZONE[s], `no zone for ${s} (${pin})`);
  }
  assert.equal(zoneLabel("Uttarpradesh_zone"), "Uttarpradesh");
  assert.equal(zoneLabel("WestBengal_zone"), "West Bengal");
});

test("sheet edit: the FBA low-weight note saves to its own column", () => {
  assert.deepEqual(profileEdit(baseRow, { kind: "text", field: "fba_weight_note" }, "SATF, SDEU (H&B)"), { db: { fba_weight_note: "SATF, SDEU (H&B)" }, row: { fba_weight: "SATF, SDEU (H&B)" } });
});

test("competitor row matches our product by ASIN or any SKU in the | list", () => {
  assert.equal(ourProduct({ our_asin: "B0DPG8KLQZ", our_sku: null }, "B0DPG8KLQZ", []), true);
  assert.equal(ourProduct({ our_asin: null, our_sku: "B-BULB-10.5-INSEM-PK5|B-BULB-10.5-INSEM-PK5-1" }, "B0FT3MK3WD", ["B-BULB-10.5-INSEM-PK5-1"]), true);
  assert.equal(ourProduct({ our_asin: null, our_sku: "A006|A006-2" }, "B0X", ["A006-2(AM)"]), true);
  assert.equal(ourProduct({ our_asin: null, our_sku: "A006|A006-2" }, "B0X", ["A0061"]), false);
  assert.equal(ourProduct({ our_asin: "B0OTHER", our_sku: null }, "B0X", ["A006"]), false);
});

test("ads suggestion: client FBA rule first, then rating, then price; reasons always given", () => {
  const ok = { fcKnown: true, fcStocked: 19, fcOnboarded: 24, fcLow: 0, star: 4.4, ourPrice: 2700, compPrice: 2500, adOn: false };
  assert.equal(adsSuggestion(ok).action, "Turn ON");
  assert.equal(adsSuggestion({ ...ok, adOn: true }).action, "Keep ON");
  assert.equal(adsSuggestion({ ...ok, fcStocked: 7, adOn: true }).action, "Turn OFF");
  assert.equal(adsSuggestion({ ...ok, fcStocked: 7 }).action, "Keep OFF");
  assert.match(adsSuggestion({ ...ok, fcStocked: 7 }).reasons[0], /7 of 24/);
  assert.equal(adsSuggestion({ ...ok, star: 3.2 }).action, "Keep OFF");
  assert.equal(adsSuggestion({ ...ok, compPrice: 500 }).action, "Review first");
  assert.equal(adsSuggestion({ ...ok, compPrice: 500, adOn: true }).action, "Keep ON");
  assert.equal(adsSuggestion({ ...ok, fcLow: 2 }).tone, "warning");
  assert.equal(adsSuggestion({ ...ok, fcKnown: false }).action, "Check data");
  assert.ok(adsSuggestion({ ...ok, star: null, compPrice: null }).reasons.some((r) => /No rating/.test(r)));
});

test("our price is the selling price, never the M.R.P. from the listing upload", () => {
  assert.deepEqual(ourSellingPrice("363.00", 363, 750), { price: 363, source: "rating bot (Amazon page)", mrp: 750 });
  assert.deepEqual(ourSellingPrice(null, "363", "750"), { price: 363, source: "FBA inventory report", mrp: 750 });
  assert.deepEqual(ourSellingPrice(0, null, 750), { price: null, source: null, mrp: 750 });
});
