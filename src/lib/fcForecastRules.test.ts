import test from "node:test";
import assert from "node:assert/strict";
import { yesterdayIst, blocks, minStock, staleChannels, fcFileName } from "./fcForecastRules.ts";

test("yesterdayIst uses the India calendar day", () => {
  assert.equal(yesterdayIst(new Date("2026-11-19T20:00:00Z")), "2026-11-19"); // 01:30 IST on 20 Nov
  assert.equal(yesterdayIst(new Date("2026-11-19T17:00:00Z")), "2026-11-18"); // 22:30 IST on 19 Nov
});

test("blocks are three rolling 30-day windows ending as_of", () => {
  assert.deepEqual(blocks("2026-11-19"), {
    b1: ["2026-10-21", "2026-11-19"],
    b2: ["2026-09-21", "2026-10-20"],
    b3: ["2026-08-22", "2026-09-20"],
  });
});

test("minStock = max(round(units x 1.5), 5), rounding half up", () => {
  assert.equal(minStock(0), 5);
  assert.equal(minStock(3), 5);
  assert.equal(minStock(5), 8);
  assert.equal(minStock(9), 14);
  assert.equal(minStock(100), 150);
});

test("staleChannels lists channels whose newest data is before as_of", () => {
  assert.deepEqual(
    staleChannels([
      { channel: "sellerflex", source: "barm_sellerflex_shipments", max_day: "2026-11-17" },
      { channel: "meesho", source: "barm_daily_ms_barm_orders", max_day: "2026-11-19" },
    ], "2026-11-19"),
    ["sellerflex"]
  );
});

test("staleChannels takes the newest of a channel's two sources, and flags a channel with no data", () => {
  assert.deepEqual(
    staleChannels([
      { channel: "amazon", source: "amazon_orders", max_day: "2026-11-12" },
      { channel: "amazon", source: "barm_daily_am_orders", max_day: "2026-11-19" },
      { channel: "website", source: "barm_shopify_orders_summary", max_day: null },
    ], "2026-11-19"),
    ["website"]
  );
});

test("fcFileName follows the client's naming", () => {
  assert.equal(fcFileName("2026-11-19"), "FC forecast sheet on 19-11-2026.xlsx");
});

test("fcWorkbook writes the client's FORECAST SHEET columns plus DETAIL and UNMAPPED SKUS", async () => {
  const XLSX = await import("xlsx");
  const { fcWorkbook } = await import("./fcForecastExport.ts");
  const row = { product: "MRD white", block1: 9, block2: 4, block3: 2, peak: 9, last30: 9, max_units: 9, min_stock: 14,
    ch_amazon: 5, ch_flipkart: 4, ch_meesho: 0, ch_website: 0, ch_sellerflex: 0,
    b1_from: "2026-10-21", b1_to: "2026-11-19", b2_from: "2026-09-21", b2_to: "2026-10-20", b3_from: "2026-08-22", b3_to: "2026-09-20" };
  const wb = fcWorkbook([row], [{ sku: "X-1", channel: "meesho", units_90d: 3, sample_title: "t" }], "2026-11-19");
  assert.deepEqual(wb.SheetNames, ["FORECAST SHEET", "DETAIL", "UNMAPPED SKUS"]);
  const fc = XLSX.utils.sheet_to_json(wb.Sheets["FORECAST SHEET"], { header: 1 });
  assert.deepEqual(fc[0], ["PRODUCT NAME", "peak data in 3 months", "last 30 days", "max", "Minimum stock needed"]);
  assert.deepEqual(fc[1], ["MRD white", 9, 9, 9, 14]);
  const um = XLSX.utils.sheet_to_json(wb.Sheets["UNMAPPED SKUS"], { header: 1 });
  assert.deepEqual(um[1], ["X-1", "Meesho", 3, "t"]);
});

test("unmappedKpi shows a dash, not 0, when the unmapped list failed to load", async () => {
  const { unmappedKpi } = await import("./fcForecastRules.ts");
  assert.deepEqual(unmappedKpi(undefined, true), { value: "–", ok: false });
  assert.deepEqual(unmappedKpi([], false), { value: "0", ok: true });
  assert.deepEqual(unmappedKpi([{ sku: "a", channel: "meesho", units_90d: 2, sample_title: null }], false), { value: "1", ok: false });
});

test("sourceCheckNotice warns when the data-up-to check itself failed", async () => {
  const { sourceCheckNotice } = await import("./fcForecastRules.ts");
  assert.match(sourceCheckNotice(true, []) ?? "", /couldn't check/i);
  assert.match(sourceCheckNotice(false, ["sellerflex"]) ?? "", /Seller Flex/);
  assert.equal(sourceCheckNotice(false, []), null);
});
