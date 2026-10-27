import test from "node:test";
import assert from "node:assert/strict";
import { isSpCardRow, isCampaignCardRow, dailyAmAdsReportRows, allocateCampaignSpend, SKU_LESS_SOURCE } from "./amazonAdSourceRules.ts";

test("campaign spend is spread by weight; no weights means equal shares (₹300 over 3 SKUs = ₹100 each)", () => {
  const map = [
    { campaign_name: "Brand A", sku: "S1" }, { campaign_name: "Brand A", sku: "S2", weight: 0 }, { campaign_name: "Brand A", sku: "S3", weight: "" },
    { campaign_name: "Brand B", sku: "S1", weight: 2 }, { campaign_name: "Brand B", sku: "S4", weight: 1 },
  ];
  const { allocations, unmapped } = allocateCampaignSpend(
    [
      { report_date: "2026-10-22", campaign_name: "Brand A", spend: 300 },
      { report_date: "2026-10-22", campaign_name: "Brand B", spend: 90 },
      { report_date: "2026-10-22", campaign_name: "Display C", spend: 12.34 },
      { report_date: "2026-10-22", campaign_name: "Brand A", spend: 0 },
    ],
    map,
  );
  assert.deepEqual(allocations.filter((a) => a.campaign_name === "Brand A").map((a) => [a.sku, a.spend]), [["S1", 100], ["S2", 100], ["S3", 100]]);
  assert.deepEqual(allocations.filter((a) => a.campaign_name === "Brand B").map((a) => [a.sku, a.spend]), [["S1", 60], ["S4", 30]]);
  assert.deepEqual(unmapped, [{ report_date: "2026-10-22", campaign_name: "Display C", spend: 12.34 }]);
  // nothing lost: allocated + unmapped = every positive row's spend
  const allocated = allocations.reduce((s, a) => s + a.spend, 0);
  assert.equal(Math.round((allocated + unmapped[0].spend) * 100), Math.round((300 + 90 + 12.34) * 100));
});

test("SP card rows carry Amazon's own Date column; combined-upload rows carry Start Date", () => {
  assert.equal(isSpCardRow({ raw: { Date: "Oct 11, 2026", Spend: "₹7.65" } }), true);
  assert.equal(isSpCardRow({ raw: { "Start Date": 46288, "End Date": 46288 } }), false);
  assert.equal(isSpCardRow({ raw: { "Start Date": 46320, "Ad Type": "SD" } }), false);
  // a card upload that merged several lines on one key stores them as an array
  assert.equal(isSpCardRow({ raw: [{ Date: "Oct 11, 2026" }, { Date: "Oct 11, 2026" }] }), true);
  assert.equal(isSpCardRow({ raw: null }), false);
  assert.equal(isSpCardRow({}), false);
});

test("SB/SD card rows exclude only the SKU-less rows the combined upload saved", () => {
  assert.equal(isCampaignCardRow({ raw: { Date: "Oct 23, 2026", Spend: "₹100" } }), true);
  assert.equal(isCampaignCardRow({ raw: { source: SKU_LESS_SOURCE, ad_type: "SB", rows: 2 } }), false);
  // rows of unknown origin (no source tag) stay card rows, so no card spend is ever dropped
  assert.equal(isCampaignCardRow({ raw: { Campaign: "x" } }), true);
  assert.equal(isCampaignCardRow({}), true);
});

const daily = [
  // Sponsored Products line
  { report_date: "2026-10-22", campaign_name: "KT", ad_group_name: "AG", sku: "A004-4", asin: "B0", spend: 100, sales_7d: 500, orders_7d: 2, units_7d: 3, impressions: 900, clicks: 9, raw: { "Ad Type": "SP" } },
  // seller's per-SKU split of a Brand campaign: named first row, then blank campaign rows
  { report_date: "2026-10-22", campaign_name: "Brand X", ad_group_name: "", sku: "S1", spend: 60, raw: { "Ad Type": "SB" } },
  { report_date: "2026-10-22", campaign_name: "", ad_group_name: "", sku: "S2", spend: 40, raw: { "Ad Type": "SB" } },
  // unsplit Brand campaign with no SKU — two lines, one campaign-day
  { report_date: "2026-10-22", campaign_name: "Brand Y", ad_group_name: "", sku: "", spend: 30, raw: { "Ad Type": "SB" } },
  { report_date: "2026-10-22", campaign_name: "Brand Y", ad_group_name: "", sku: null, spend: 20, raw: { "Ad Type": "SB" } },
  // unsplit Display campaign with no SKU
  { report_date: "2026-10-22", campaign_name: "Display Z", sku: "", spend: 12.5, raw: { "Ad Type": "SD" } },
  // unsplit Brand campaign the SB card already has for that day — the card stays the source
  { report_date: "2026-10-22", campaign_name: "Brand Card", sku: "", spend: 70, raw: { "Ad Type": "SB" } },
  // spend with neither SKU nor campaign — never attributable, so not turned into a campaign row
  { report_date: "2026-10-22", campaign_name: "", sku: "", spend: 5, raw: {} },
];

test("daily copy → SP rows: every line with an Advertised SKU, in the SP table's field names", () => {
  const { spRows } = dailyAmAdsReportRows(daily, [], []);
  assert.deepEqual(spRows.map((r) => r.advertised_sku), ["A004-4", "S1", "S2"]);
  const sp = spRows[0];
  assert.equal(sp.campaign_name, "KT");
  assert.equal(sp.ad_group_name, "AG");
  assert.equal(sp.advertised_asin, "B0");
  assert.equal(sp.spend, 100);
  assert.equal(sp.sales_7d, 500);
  assert.equal(sp.orders_7d, 2);
  assert.equal(sp.units_7d, 3);
  assert.deepEqual(sp.raw, { "Ad Type": "SP" });
  assert.equal(spRows.reduce((s, r) => s + r.spend, 0), 200);
});

test("daily copy → SB/SD rows: SKU-less campaign-days added, card rows kept and preferred", () => {
  const cardSb = [
    { report_date: "2026-10-22", campaign_name: "Brand Card", spend: 71, raw: { Date: "Oct 22, 2026" } },
    // an older SKU-less copy the combined upload saved in the card table: ignored, rebuilt from the daily copy
    { report_date: "2026-10-22", campaign_name: "Brand Y", spend: 50, raw: { source: SKU_LESS_SOURCE } },
  ];
  const cardSd = [{ report_date: "2026-10-21", campaign_name: "Display Q", spend: 9, raw: { Date: "Oct 21, 2026" } }];
  const { sbRows, sdRows } = dailyAmAdsReportRows(daily, cardSb, cardSd);
  assert.deepEqual(sbRows.map((r) => [r.campaign_name, r.spend]), [["Brand Card", 71], ["Brand Y", 50]]);
  assert.equal(sbRows[1].raw.source, SKU_LESS_SOURCE);
  assert.equal(sbRows[1].raw.rows, 2);
  assert.deepEqual(sdRows.map((r) => [r.campaign_name, r.spend]), [["Display Q", 9], ["Display Z", 12.5]]);
  // totals: card 71 (not the daily 70) + Brand Y 50 + SD 9 + 12.5; the unattributable 5 is never a campaign row
  const total = [...sbRows, ...sdRows].reduce((s, r) => s + r.spend, 0);
  assert.equal(total, 142.5);
});

test("a campaign-day on either card table blocks the SKU-less row, whatever its ad type", () => {
  const { sbRows, sdRows } = dailyAmAdsReportRows(
    [{ report_date: "2026-10-22", campaign_name: "Moved", sku: "", spend: 10, raw: { "Ad Type": "SB" } }],
    [],
    [{ report_date: "2026-10-22", campaign_name: "Moved", spend: 11, raw: { Date: "Oct 22, 2026" } }],
  );
  assert.deepEqual(sbRows, []);
  assert.deepEqual(sdRows.map((r) => r.spend), [11]);
});
