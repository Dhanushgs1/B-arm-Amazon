import test from "node:test";
import assert from "node:assert/strict";
import {
  spCampaignDays, isSplitCoveredCampaignRow, isCourierRtoReturnType, dedupeSellerFlexReturns,
  collectSkuLessSpend, unmappedCampaignSpend, campaignsMissingOnDay, type AmAdsSpendRow,
} from "./amazonSpendRules.ts";

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

// ── SKU-less "AM ads" spend (the 15 Oct 2026 Brand-ad loss) ──────────────────

const amRow = (o: Partial<AmAdsSpendRow>): AmAdsSpendRow => ({ report_date: "2026-10-15", campaign_name: "", ad_type: "SP", advertised_sku: "", spend: 0, ...o });

// The three unsplit Brand-ad rows of 15 Oct 2026 from "Last 7 days - 16-10-2026.xlsx", next to an ordinary SP row.
const oct15 = [
  amRow({ campaign_name: "Insemination kit-Brand ads- 7/3/2026 09:29:33.167", ad_type: "SB", spend: 912.68 }),
  amRow({ campaign_name: "IR Therapy Lamp - Brand AD", ad_type: "SB", spend: 302.02 }),
  amRow({ campaign_name: "Chewy Tube - Brand ad", ad_type: "SB", spend: 271.62 }),
  amRow({ campaign_name: "Chewy SP", ad_type: "SP", advertised_sku: "B-CT-G-8", spend: 50 }),
];

test("SKU-less: 15 Oct's three unsplit Brand-ad rows are all kept — ₹1,486.32, nothing dropped", () => {
  const { campaignDays, unattributable } = collectSkuLessSpend(oct15);
  assert.equal(campaignDays.length, 3);
  assert.ok(campaignDays.every((c) => c.ad_type === "SB" && c.report_date === "2026-10-15"));
  assert.equal(Math.round(campaignDays.reduce((s, c) => s + c.spend, 0) * 100) / 100, 1486.32);
  assert.deepEqual(unattributable, []);
});

test("SKU-less: rows that carry a SKU (SP rows, the seller's split rows) are left to the SP table", () => {
  const split = [
    amRow({ campaign_name: "Chewy Tube - Brand ad", ad_type: "", advertised_sku: "B-CT-G-8", spend: 20.72 }),
    amRow({ campaign_name: "", ad_type: "", advertised_sku: "B-CT-G-9", spend: 20.72 }),
  ];
  assert.deepEqual(collectSkuLessSpend(split), { campaignDays: [], unattributable: [] });
});

test("SKU-less: ₹0 rows (a paused campaign's day) are not saved or flagged", () => {
  const out = collectSkuLessSpend([amRow({ campaign_name: "Mesh Nebulizer 135 - Brand Ad", ad_type: "SB", spend: 0 })]);
  assert.deepEqual(out, { campaignDays: [], unattributable: [] });
});

test("SKU-less: several rows of one campaign-day sum into one; SD stays Display, a blank type goes to Brands", () => {
  const { campaignDays } = collectSkuLessSpend([
    amRow({ campaign_name: "Brand A", ad_type: "SB", spend: 10 }),
    amRow({ campaign_name: "Brand A", ad_type: "SB", spend: 5.5 }),
    amRow({ campaign_name: "Brand A", ad_type: "SB", spend: 1, report_date: "2026-10-14" }),
    amRow({ campaign_name: "Display B", ad_type: " sd ", spend: 3 }),
    amRow({ campaign_name: "Untyped C", ad_type: "", spend: 2 }),
  ]);
  assert.deepEqual(campaignDays.map((c) => [c.report_date, c.campaign_name, c.ad_type, c.spend, c.rows]), [
    ["2026-10-14", "Brand A", "SB", 1, 1],
    ["2026-10-15", "Brand A", "SB", 15.5, 2],
    ["2026-10-15", "Display B", "SD", 3, 1],
    ["2026-10-15", "Untyped C", "SB", 2, 1],
  ]);
});

test("SKU-less: spend with neither a SKU nor a campaign is reported per day, never silently dropped", () => {
  const { campaignDays, unattributable } = collectSkuLessSpend([amRow({ spend: 40 }), amRow({ spend: 2 }), amRow({ spend: 7, report_date: "2026-10-14" })]);
  assert.deepEqual(campaignDays, []);
  assert.deepEqual(unattributable, [
    { report_date: "2026-10-14", spend: 7, rows: 1 },
    { report_date: "2026-10-15", spend: 42, rows: 2 },
  ]);
});

test("SKU-less rows saved as SB rows are still skipped once the seller's split for that day is uploaded", () => {
  const saved = collectSkuLessSpend(oct15).campaignDays;
  const laterSplit = spCampaignDays([{ campaign_name: "Chewy Tube - Brand ad", report_date: "2026-10-15" }]);
  const counted = saved.filter((r) => !isSplitCoveredCampaignRow(r, laterSplit));
  assert.deepEqual(counted.map((r) => r.campaign_name).sort(), ["IR Therapy Lamp - Brand AD", "Insemination kit-Brand ads- 7/3/2026 09:29:33.167"]);
});

test("unmappedCampaignSpend: lists each unmapped campaign with its days, biggest first; mapped ones and ₹0 rows excluded", () => {
  const rows = [
    { campaign_name: "IR Therapy Lamp - Brand AD", report_date: "2026-10-15", spend: 302.02 },
    { campaign_name: "Chewy Tube - Brand ad", report_date: "2026-10-15", spend: 271.62 },
    { campaign_name: "Chewy Tube - Brand ad", report_date: "2026-10-14", spend: 100 },
    { campaign_name: "Mapped", report_date: "2026-10-15", spend: 999 },
    { campaign_name: "Paused", report_date: "2026-10-15", spend: 0 },
  ];
  assert.deepEqual(unmappedCampaignSpend(rows, (c) => c === "Mapped"), [
    { campaign_name: "Chewy Tube - Brand ad", spend: 371.62, dates: ["2026-10-14", "2026-10-15"] },
    { campaign_name: "IR Therapy Lamp - Brand AD", spend: 302.02, dates: ["2026-10-15"] },
  ]);
});

test("campaignsMissingOnDay: Brand campaigns split on 09–14 Oct with no 15 Oct row are flagged (the original gap)", () => {
  const sp = [
    { campaign_name: "Chewy Tube - Brand ad", ad_group_name: "", report_date: "2026-10-14", spend: 52.34 },
    { campaign_name: "", ad_group_name: "", report_date: "2026-10-14", spend: 34.89 },
    { campaign_name: "IR Therapy Lamp - Brand AD", ad_group_name: "", report_date: "2026-10-13", spend: 149.44 },
    // An ordinary SP campaign that stopped is not a Brand/Display campaign — never flagged.
    { campaign_name: "SP Exact", ad_group_name: "AG1", report_date: "2026-10-14", spend: 80 },
  ];
  assert.deepEqual(campaignsMissingOnDay([], sp, "2026-10-15"), [
    { campaign_name: "Chewy Tube - Brand ad", lastSpendDate: "2026-10-14", lastSpend: 52.34 },
    { campaign_name: "IR Therapy Lamp - Brand AD", lastSpendDate: "2026-10-13", lastSpend: 149.44 },
  ]);
});

test("campaignsMissingOnDay: any row on the day — even ₹0, or the SKU-less SB row the upload now saves — clears it", () => {
  const sp = [{ campaign_name: "Chewy Tube - Brand ad", ad_group_name: "", report_date: "2026-10-14", spend: 52.34 }];
  assert.deepEqual(campaignsMissingOnDay([{ campaign_name: "Chewy Tube - Brand ad", report_date: "2026-10-15", spend: 271.62 }], sp, "2026-10-15"), []);
  assert.deepEqual(campaignsMissingOnDay([], [...sp, { campaign_name: "Chewy Tube - Brand ad", ad_group_name: "", report_date: "2026-10-15", spend: 0 }], "2026-10-15"), []);
});

test("campaignsMissingOnDay: a campaign that only ever showed ₹0 (paused all window) is not flagged", () => {
  assert.deepEqual(campaignsMissingOnDay([{ campaign_name: "Mesh Nebulizer 135 - Brand Ad", report_date: "2026-10-10", spend: 0 }], [], "2026-10-15"), []);
});

test("campaignsMissingOnDay: a campaign that spent, then ran ₹0 rows, then dropped out had stopped — not flagged", () => {
  // "B-Arm_SP_B0DDTTPKJ3_Sensory Brush_SD" in the 09–15 Oct 2026 data: ₹102.97 on 10 Oct, ₹0 on 12–14 Oct, no 15 Oct row.
  const sp = [
    { campaign_name: "Sensory Brush_SD", ad_group_name: "", report_date: "2026-10-10", spend: 102.97 },
    { campaign_name: "Sensory Brush_SD", ad_group_name: "", report_date: "2026-10-12", spend: 0 },
    { campaign_name: "Sensory Brush_SD", ad_group_name: "", report_date: "2026-10-14", spend: 0 },
  ];
  assert.deepEqual(campaignsMissingOnDay([], sp, "2026-10-15"), []);
});

test("SKU-less: an Ad Type spelled out as 'Sponsored Display' is Display, not Brands (so it can't double an SD report row)", () => {
  const { campaignDays } = collectSkuLessSpend([amRow({ campaign_name: "Display X", ad_type: "Sponsored Display", spend: 9 })]);
  assert.equal(campaignDays[0].ad_type, "SD");
});

test("unmappedCampaignSpend: the mapping is looked up with the stored (untrimmed) name, like the report's spend loop", () => {
  const rows = [{ campaign_name: "Brand A ", report_date: "2026-10-15", spend: 10 }];
  // Mapped under its exact stored name -> mapped, so it is not listed (the spend loop spreads it).
  assert.deepEqual(unmappedCampaignSpend(rows, (c) => c === "Brand A "), []);
  // Only a trimmed key exists -> the spend loop can't find it either, so it IS listed (and counted as unmapped).
  assert.deepEqual(unmappedCampaignSpend(rows, (c) => c === "Brand A"), [{ campaign_name: "Brand A", spend: 10, dates: ["2026-10-15"] }]);
});
