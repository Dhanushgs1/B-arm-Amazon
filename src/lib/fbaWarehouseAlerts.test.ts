import test from "node:test";
import assert from "node:assert/strict";
import { cityStock, fcCity, findNewDrops } from "./fbaWarehouseAlerts.ts";
import type { LiveProduct, LiveSku } from "./sellerMateLiveInventory.ts";

const sku = (code: string, whs: [string, number | null][]): LiveSku => ({
  sku: code, channel: "FBA", listingQuantity: null, fnsku: null, fbaWarehouseBalance: null, ledgerDate: null,
  warehouses: whs.map(([location, units]) => ({ location, units, fnsku: null, asOfDate: "2026-10-07" })),
  catalogStatus: null, inCatalog: true, catalogAsin: null,
});
const product = (asin: string, skus: LiveSku[]): LiveProduct => ({
  asin, title: `Product ${asin}`, imageUrl: null, price: null, fbmQuantity: null, fbaWarehouseBalance: null, warehouseTotal: null,
  ledgerDate: null, warehouseCount: 0, skus, stockStatus: "In stock", available: null, reserved: null, inbound: null, unfulfillable: null, notes: [],
});

test("FC codes map to the eight cities; other FCs are ignored", () => {
  assert.equal(fcCity("BLR7"), "Bangalore");
  assert.equal(fcCity("DEL5"), "Delhi");
  assert.equal(fcCity("DED4"), "Delhi");
  assert.equal(fcCity("CCX2"), "West Bengal");
  assert.equal(fcCity("CJB1"), "Coimbatore");
  assert.equal(fcCity("PNQ3"), null); // Pune is not Mumbai
  assert.equal(fcCity("GAX1"), null);
});

test("stock is summed per SKU across a city's FCs", () => {
  const rows = cityStock([product("A1", [sku("S1", [["BLR7", 12], ["BLR8", 15], ["MAA4", 3], ["GAX1", 1]])])]);
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.units]));
  assert.deepEqual(byKey, { "Bangalore|S1": 27, "Chennai|S1": 3 });
});

test("a city whose rows all have unknown units is skipped, not read as 0", () => {
  assert.deepEqual(cityStock([product("A1", [sku("S1", [["LKO1", null]])])]), []);
});

test("only new drops are reported; still-low pairs stay quiet until they recover", () => {
  const rows = cityStock([product("A1", [
    sku("S1", [["BLR7", 5]]), // new drop
    sku("S2", [["BLR7", 8]]), // still low, mailed before
    sku("S3", [["BLR7", 40]]), // recovered
    sku("S4", [["BLR7", 19]]), // was recovered, dropped again
  ])]);
  const prior = new Map([["Bangalore|S2", true], ["Bangalore|S3", true], ["Bangalore|S4", false], ["Chennai|S9", true]]);
  const r = findNewDrops(rows, prior, 20);
  assert.deepEqual(r.drops.map((d) => d.sku), ["S1", "S4"]);
  assert.deepEqual(r.recovered.map((d) => d.sku), ["S3"]);
  assert.equal(r.stillLow, 1);
});

test("exactly the threshold is not low", () => {
  const r = findNewDrops(cityStock([product("A1", [sku("S1", [["HYD3", 20]])])]), new Map(), 20);
  assert.equal(r.drops.length, 0);
});
