import test from "node:test";
import assert from "node:assert/strict";
import { spCampaignDays, isSplitCoveredCampaignRow, isCourierRtoReturnType, dedupeSellerFlexReturns } from "./amazonSpendRules.ts";

const sp = [
  { campaign_name: "Chewy Tube - Brand ad", report_date: "2026-08-20" }, // first (named) split row
  { campaign_name: "", report_date: "2026-08-20" }, // further split rows carry no campaign
  { campaign_name: "Chewy Tube - SP exact", report_date: "2026-08-20" },
];
const days = spCampaignDays(sp);

test("an SB/SD campaign-day that the seller already split onto SKUs in the SP table is a duplicate", () => {
  assert.equal(isSplitCoveredCampaignRow({ campaign_name: "Chewy Tube - Brand ad", report_date: "2026-08-20" }, days), true);
  assert.equal(isSplitCoveredCampaignRow({ campaign_name: " Chewy Tube - Brand ad ", report_date: "2026-08-20T00:00:00" }, days), true);
});

test("an SB/SD campaign-day with no split rows is kept (never lose the only copy)", () => {
  assert.equal(isSplitCoveredCampaignRow({ campaign_name: "Chewy Tube - Brand ad", report_date: "2026-08-21" }, days), false);
  assert.equal(isSplitCoveredCampaignRow({ campaign_name: "Mesh nebulizer - Brand ads (new)", report_date: "2026-08-20" }, days), false);
});

test("blank campaign names never mark a campaign-day, and a blank SB/SD name never matches", () => {
  assert.equal(days.size, 2);
  assert.equal(isSplitCoveredCampaignRow({ campaign_name: "", report_date: "2026-08-20" }, days), false);
});

test("courier RTO return types: Undelivered, Rejected, Undelivered/Rejected (AM) and UNDELIVERED (SellerFlex)", () => {
  for (const t of ["Undelivered", "Rejected", "Undelivered/Rejected", "UNDELIVERED", " rejected "]) assert.equal(isCourierRtoReturnType(t), true, t);
});

test("genuine customer return types are not RTO", () => {
  for (const t of ["C-Returns", "Amazon CS", "CUSTOMER_RETURN", "", null, undefined]) assert.equal(isCourierRtoReturnType(t), false, String(t));
});

test("SellerFlex: the 4 re-upload copies of one return count once (order 404-5765768-9077953 / B-OT-DT12-3)", () => {
  const copy = { customer_order_id: "404-5765768-9077953", shipment_id: "TShip1", msku: "B-OT-DT12-3", pickup_date: "2026-09-07", units: 1 };
  const out = dedupeSellerFlexReturns([copy, { ...copy }, { ...copy }, { ...copy }]);
  assert.equal(out.length, 1);
  assert.equal(out.reduce((s, r) => s + r.units, 0), 1);
});

test("SellerFlex: an older In-transit copy beside the Returned-to-Seller copy is still one return", () => {
  const a = { customer_order_id: "O1", shipment_id: "S1", msku: "M", pickup_date: "2026-05-15", units: 1, return_status: "In-transit to Seller Flex node" };
  const b = { ...a, return_status: "Returned to Seller" };
  assert.equal(dedupeSellerFlexReturns([a, b]).length, 1);
});

test("SellerFlex: distinct shipments, orders or mSKUs are distinct returns", () => {
  const base = { customer_order_id: "O1", shipment_id: "S1", msku: "M", pickup_date: "2026-09-01", units: 1 };
  const out = dedupeSellerFlexReturns([base, { ...base, shipment_id: "S2" }, { ...base, customer_order_id: "O2" }, { ...base, msku: "M2" }]);
  assert.equal(out.length, 4);
});

test("SellerFlex: copies with no pickup date or no mSKU never count, and never block a dated copy", () => {
  const blank = { customer_order_id: "O1", shipment_id: "S1", msku: "M", pickup_date: "", units: 1 };
  const dated = { ...blank, pickup_date: "2026-07-26" };
  const out = dedupeSellerFlexReturns([blank, dated, { ...dated, msku: "" }]);
  assert.deepEqual(out, [dated]);
});
