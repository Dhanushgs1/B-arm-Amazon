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
