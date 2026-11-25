import test from "node:test";
import assert from "node:assert/strict";
import { mergeMetaRows } from "./socialMediaRules.ts";

const row = (sheet: string, campaign: string, spend: number, start: string | null = "2026-10-06", end: string | null = "2026-10-06") =>
  ({ sheet, report_start: start, report_end: end, campaign_name: campaign, spend });

test("same campaign twice in one sheet adds up (100 + 50 = 150), ignoring case and spaces", () => {
  const out = mergeMetaRows([row("day", "Sensory Brush Leads", 100), row("day", "  sensory  brush leads ", 50.5)]);
  assert.deepEqual(out.map((r) => [r.campaign_name, r.spend]), [["Sensory Brush Leads", 150.5]]);
});

test("the same campaign copied into another sheet for the same window is not doubled", () => {
  const out = mergeMetaRows([row("day", "Camp A", 100), row("copy", "camp a", 100)]);
  assert.deepEqual(out.map((r) => [r.campaign_name, r.spend]), [["Camp A", 100]]);
});

test("different windows and different campaigns stay separate; blank name / dates are dropped", () => {
  const out = mergeMetaRows([
    row("day", "Camp A", 100),
    row("week", "Camp A", 700, "2026-09-30", "2026-10-06"),
    row("day", "Camp B", 40),
    row("day", "", 840),
    row("day", "Camp C", 10, null, null),
  ]);
  assert.deepEqual(out.map((r) => [r.campaign_name, r.report_start, r.spend]), [
    ["Camp A", "2026-10-06", 100],
    ["Camp B", "2026-10-06", 40],
    ["Camp A", "2026-09-30", 700],
  ]);
});

test("clicks add up across a campaign's lines; null when the file has no clicks", () => {
  const base = { sheet: "S", report_start: "2026-11-18", report_end: "2026-11-18" };
  const out = mergeMetaRows([
    { ...base, campaign_name: "Kit", spend: 100, clicks: 10 },
    { ...base, campaign_name: "kit ", spend: 50, clicks: 5 },
    { ...base, campaign_name: "Other", spend: 20, clicks: null },
  ]);
  assert.deepEqual(out.map((r) => [r.campaign_name, r.spend, r.clicks]), [["Kit", 150, 15], ["Other", 20, null]]);
});

// ── Ad-level export (25 Nov 2026) ──────────────────────────────────────────
import { metaRowName, metaCampaignPart, metaRowsToReplace, META_AD_SEPARATOR } from "./socialMediaRules.ts";

test("ad rows are named '<campaign> :: <ad>' and split back to the campaign", () => {
  assert.equal(META_AD_SEPARATOR, " :: ");
  assert.equal(metaRowName(" Postpartum kit  -11/11/2026 ", " Reel  1 "), "Postpartum kit -11/11/2026 :: Reel 1");
  assert.equal(metaRowName("insemination kit", ""), "insemination kit");
  assert.equal(metaCampaignPart("Postpartum kit -11/11/2026 :: Reel 1"), "Postpartum kit -11/11/2026");
  assert.equal(metaCampaignPart("insemination kit"), "insemination kit");
});

test("two lines of one ad add up spend, purchase value and purchases; a missing value stays null", () => {
  const ad = (spend: number, metaValue: number | null, metaPurchases: number | null) =>
    ({ ...row("day", "Camp A :: Ad 1", spend), metaValue, metaPurchases });
  const [one] = mergeMetaRows([ad(100, 999, 1), ad(50, 1998, 2)]);
  assert.deepEqual([one.spend, one.metaValue, one.metaPurchases], [150, 2997, 3]);
  const [none] = mergeMetaRows([ad(10, null, null), ad(5, null, null)]);
  assert.deepEqual([none.metaValue, none.metaPurchases], [null, null]);
});

test("an ad-level upload replaces the saved campaign total of the same window (no double spend)", () => {
  const saved = [
    { id: 1, report_start: "2026-11-24", report_end: "2026-11-24", campaign_name: "Camp A" },
    { id: 2, report_start: "2026-11-18", report_end: "2026-11-24", campaign_name: "Camp A" }, // other window: kept
    { id: 3, report_start: "2026-11-24", report_end: "2026-11-24", campaign_name: "Camp B" }, // not in upload: kept
    { id: 4, report_start: "2026-11-24", report_end: "2026-11-24", campaign_name: "camp a :: Old ad" }, // ad gone: replaced
    { id: 5, report_start: "2026-11-24", report_end: "2026-11-24", campaign_name: "Camp A :: Ad 1" }, // re-uploaded: kept (upsert)
  ];
  const incoming = [
    { report_start: "2026-11-24", report_end: "2026-11-24", campaign_name: "Camp A :: Ad 1" },
    { report_start: "2026-11-24", report_end: "2026-11-24", campaign_name: "Camp A :: Ad 2" },
  ];
  assert.deepEqual(metaRowsToReplace(saved, incoming), [1, 4]);
});

test("a campaign-level upload replaces that window's saved ad rows of the campaign", () => {
  const saved = [
    { id: 1, report_start: "2026-11-24", report_end: "2026-11-24", campaign_name: "Camp A :: Ad 1" },
    { id: 2, report_start: "2026-11-24", report_end: "2026-11-24", campaign_name: "Camp A" },
  ];
  assert.deepEqual(metaRowsToReplace(saved, [{ report_start: "2026-11-24", report_end: "2026-11-24", campaign_name: "camp a" }]), [1]);
});
