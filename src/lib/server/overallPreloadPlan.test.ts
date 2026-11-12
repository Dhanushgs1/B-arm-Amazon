import test from "node:test";
import assert from "node:assert/strict";
import { overallPreloadRequests, presetStart } from "./overallPreloadPlan.ts";

test("presetStart counts the end day in the window, across a month boundary", () => {
  assert.equal(presetStart("2026-11-11", 30), "2026-10-13");
  assert.equal(presetStart("2026-11-11", 7), "2026-11-05");
  assert.equal(presetStart("2026-03-01", 1), "2026-03-01");
});

test("the 30-day window matches what the Overall page requested on 12 Nov 2026", () => {
  const r = overallPreloadRequests("2026-11-11", [30]).map(([n, a]) => `${n}|${a.join("|")}`);
  assert.deepEqual(r, [
    "fetchAmazonSummary|2026-10-13|2026-11-11",
    "fetchFlipkartAllSummary|2026-10-13|2026-11-11",
    "fetchMeeshoSummary|2026-10-13|2026-11-11",
    "fetchShopifyAllSummary|2026-10-13|2026-11-11",
    "loadMarketplaceAds|amazon|2026-09-13|2026-11-11",
    "loadMarketplaceAds|flipkart|2026-09-13|2026-11-11",
    "loadMarketplaceAds|meesho|2026-09-13|2026-11-11",
    "loadSpendWindows|google|2026-09-13|2026-11-11",
    "loadSpendWindows|meta|2026-09-13|2026-11-11",
    "fetchShopifyOrders|",
  ]);
});

test("default presets warm 30 and 7 days, Shopify orders once", () => {
  const r = overallPreloadRequests("2026-11-11");
  assert.equal(r.length, 19);
  assert.equal(r.filter(([n]) => n === "fetchShopifyOrders").length, 1);
  assert.ok(r.some(([n, a]) => n === "fetchAmazonSummary" && a[0] === "2026-11-05"));
  assert.ok(r.some(([n, a]) => n === "loadMarketplaceAds" && a[0] === "amazon" && a[1] === "2026-10-29"));
});
