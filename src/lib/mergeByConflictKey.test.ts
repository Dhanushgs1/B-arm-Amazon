import test from "node:test";
import assert from "node:assert/strict";
import { mergeByConflictKey } from "./mergeByConflictKey.ts";

test("sums the given fields for rows sharing the same conflict key", () => {
  const rows = [
    { report_date: "2026-09-01", campaign_id: "C1", adgroup_id: "A1", sku_id: "S1", views: 10, clicks: 2, ad_spend: 5, conversion_rate: 0.1, roi: 2 },
    { report_date: "2026-09-01", campaign_id: "C1", adgroup_id: "A1", sku_id: "S1", views: 40, clicks: 8, ad_spend: 15, conversion_rate: 0.9, roi: 9 },
  ];

  const merged = mergeByConflictKey(rows, ["report_date", "campaign_id", "adgroup_id", "sku_id"], ["views", "clicks", "ad_spend"]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].views, 50);
  assert.equal(merged[0].clicks, 10);
  assert.equal(merged[0].ad_spend, 20);
});

test("keeps the first row's value for fields not listed in sumFields", () => {
  const rows = [
    { report_date: "2026-09-01", campaign_id: "C1", adgroup_id: "A1", sku_id: "S1", product_name: "", ad_spend: 5, conversion_rate: 0.1, roi: 2 },
    { report_date: "2026-09-01", campaign_id: "C1", adgroup_id: "A1", sku_id: "S1", product_name: "Real Name", ad_spend: 15, conversion_rate: 0.9, roi: 9 },
  ];

  const merged = mergeByConflictKey(rows, ["report_date", "campaign_id", "adgroup_id", "sku_id"], ["ad_spend"]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].product_name, "");
  assert.equal(merged[0].conversion_rate, 0.1);
  assert.equal(merged[0].roi, 2);
});

test("leaves rows with distinct conflict keys separate", () => {
  const rows = [
    { report_date: "2026-09-01", campaign_id: "C1", adgroup_id: "A1", sku_id: "S1", ad_spend: 5 },
    { report_date: "2026-09-01", campaign_id: "C1", adgroup_id: "A1", sku_id: "S2", ad_spend: 15 },
  ];

  const merged = mergeByConflictKey(rows, ["report_date", "campaign_id", "adgroup_id", "sku_id"], ["ad_spend"]);

  assert.equal(merged.length, 2);
});
