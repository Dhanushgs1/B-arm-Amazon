import test from "node:test";
import assert from "node:assert/strict";
import { isGoogleAdSpendSheet, parseGoogleAdSpendSheet, parseGoogleReportWindow } from "./googleAdSpendRules.ts";

const HEADER = ["Network (with search partners)", "Campaign status", "Campaign", "Budget", "Budget name", "Budget type", "Currency code", "Status", "Status reasons", "Cost", "Conversions", "Conv. value", "Clicks"];
const line = (network: string, status: string, campaign: string, cost: number, clicks = 0) =>
  [network, status, campaign, 300, " --", "Daily", "INR", "Eligible", null, cost, 0, 0, clicks];

// Shape of the seller's real "oct 15 google ad spend" export, trimmed.
const sheet = (window = "October 15, 2026 - October 15, 2026") => [
  ["Campaign report"],
  [window],
  HEADER,
  line("Google Search", "Enabled", "bulb-insemination-search campaign", 0),
  line("Search partners", "Enabled", "bulb-insemination-search campaign", 0),
  line("Google Search", "Enabled", "bulb-insemination-shopping-oct 15", 87.95, 20),
  line("Search partners", "Enabled", "bulb-insemination-shopping-oct 15", 38.57, 20),
  line("YouTube", "Enabled", "bulb-insemination-shopping-oct 15", 0),
  [" --", "Total: Campaigns", " --", " --", " --", " --", "INR", " --", null, 126.52, 0, 0, 40],
  ["Google Search", "Total: Campaigns", " --", " --", " --", " --", "INR", " --", null, 87.95, 0, 0, 20],
  [null, "Total: Account", null, null, null, null, "INR", null, null, 126.52, 0, 0, 40],
  ["Search partners", "Total: Account", null, null, null, null, "INR", null, null, 38.57, 0, 0, 20],
  [null, "Total: Shopping", null, null, null, null, "INR", null, null, 126.52, 0, 0, 40],
];

test("reads the window, sums each campaign's network lines, skips every Total line", () => {
  const r = parseGoogleAdSpendSheet(sheet());
  assert.equal(r.report_start, "2026-10-15");
  assert.equal(r.report_end, "2026-10-15");
  assert.deepEqual(r.campaigns.map((c) => [c.campaign_name, c.spend, c.clicks]), [
    ["bulb-insemination-search campaign", 0, 0],
    ["bulb-insemination-shopping-oct 15", 126.52, 40],
  ]);
  assert.equal(r.campaigns[1].lines.length, 3);
  assert.equal(r.accountTotal, 126.52);
  assert.equal(r.campaignTotal, 126.52);
});

test("a 7-day export keeps its range window", () => {
  const r = parseGoogleAdSpendSheet(sheet("Oct 9, 2026 - Oct 15, 2026"));
  assert.equal(r.report_start, "2026-10-09");
  assert.equal(r.report_end, "2026-10-15");
});

test("window parsing", () => {
  assert.deepEqual(parseGoogleReportWindow("October 15, 2026 - October 15, 2026"), ["2026-10-15", "2026-10-15"]);
  assert.deepEqual(parseGoogleReportWindow("Sep 29, 2026 – Oct 5, 2026"), ["2026-09-29", "2026-10-05"]);
  assert.equal(parseGoogleReportWindow("Campaign report"), null);
  assert.equal(parseGoogleReportWindow("October 15, 2026 - October 9, 2026"), null);
});

test("detects a campaign report but not a B-Arm orders sheet", () => {
  assert.equal(isGoogleAdSpendSheet(sheet()), true);
  assert.equal(isGoogleAdSpendSheet([["B-Arm Orders:04"], ["S no", "Date", "Invoice", "Sku", "Qty", "Price"], [1, "15.10.2026", "INV1", "KIT", 1, 499]]), false);
});

test("a campaign report without its date line is refused, not saved undated", () => {
  assert.throws(() => parseGoogleAdSpendSheet([HEADER, line("Google Search", "Enabled", "x", 10)]), /reporting date line/);
});
