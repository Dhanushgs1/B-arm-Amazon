import test from "node:test";
import assert from "node:assert/strict";
import {
  eligibleFc, findNewDataGaps, findNewFailures, ledgerSnapshot, skuCoverage, snapshotAgeDays, ELIGIBLE_FCS, FBA_ALERT_FCS, type LedgerSnapshot,
} from "./fbaWarehouseAlerts.ts";
import type { LiveProduct, LiveSku } from "./sellerMateLiveInventory.ts";

const DAY = "2026-10-07";
const sku = (code: string, whs: [string, number | null, string?][]): LiveSku => ({
  sku: code, channel: "FBA", listingQuantity: null, fnsku: null, fbaWarehouseBalance: null, ledgerDate: null,
  warehouses: whs.map(([location, units, asOfDate]) => ({ location, units, fnsku: null, asOfDate: asOfDate ?? DAY })),
  catalogStatus: null, inCatalog: true, catalogAsin: null,
});
const product = (asin: string, skus: LiveSku[]): LiveProduct => ({
  asin, title: `Product ${asin}`, imageUrl: null, price: null, fbmQuantity: null, fbaWarehouseBalance: null, warehouseTotal: null,
  ledgerDate: null, warehouseCount: 0, skus, stockStatus: "In stock", available: null, reserved: null, inbound: null, unfulfillable: null, notes: [],
});
const code = (i: number) => FBA_ALERT_FCS[i].code;
// eligible FCs from..from+n-1, each with `units`
const fcs = (n: number, units: number, from = 0): [string, number][] => FBA_ALERT_FCS.slice(from, from + n).map((f) => [f.code, units]);
// a snapshot in which SellerMate reported every eligible FC
const FULL: LedgerSnapshot = { date: DAY, fcs: ELIGIBLE_FCS };
const snapOf = (n: number): LedgerSnapshot => ({ date: DAY, fcs: new Set(FBA_ALERT_FCS.slice(0, n).map((f) => f.code)) });
const one = (whs: [string, number | null, string?][], snap: LedgerSnapshot = FULL) => skuCoverage([product("A1", [sku("S1", whs)])], 20, 8, ELIGIBLE_FCS, snap)[0];

test("eligible FCs are exactly the 24 'Yes' codes in the sheet; No / In progress / unlisted are excluded", () => {
  assert.equal(FBA_ALERT_FCS.length, 24);
  assert.equal(new Set(FBA_ALERT_FCS.map((f) => f.code)).size, 24);
  assert.equal(eligibleFc(" blr7 "), "BLR7");
  for (const no of ["DEL2", "DEX3", "PNQ2", "BOM4", "BLR5", "SBLU", "CCX4", "SMAK"]) assert.equal(eligibleFc(no), null, no);
  for (const wip of ["COX1", "RJX1"]) assert.equal(eligibleFc(wip), null, wip);
  assert.equal(eligibleFc("VSNC"), null);
});

// --- the three cases the client's rule is judged on ---
test("7 warehouses with stock → alert (fewFcs), however much they hold", () => {
  const c = one(fcs(7, 500));
  assert.equal(c.stocked.length, 7);
  assert.equal(c.ok, false);
  assert.equal(c.reason, "fewFcs");
});

test("8 warehouses with stock, one at 15 units → alert (lowUnits) naming that warehouse", () => {
  const c = one([...fcs(7, 50), [code(7), 15]]);
  assert.equal(c.stocked.length, 8);
  assert.equal(c.ok, false);
  assert.equal(c.reason, "lowUnits");
  assert.deepEqual(c.low, [{ fc: code(7), units: 15 }]);
});

test("8 warehouses with stock, all above 20 → no alert", () => {
  const c = one(fcs(8, 21));
  assert.equal(c.ok, true);
  assert.equal(c.reason, null);
  assert.equal(c.zeroFcs.length, 16);
});

test("exactly 20 units in a stocked warehouse is low", () => {
  assert.equal(one([...fcs(9, 80), [code(9), 20]]).reason, "lowUnits");
});

test("the old rule is gone: 16 warehouses at 0 do not alert when 8 hold more than 20", () => {
  const c = one(fcs(8, 30)); // 16 confirmed zeros
  assert.equal(c.zeroFcs.length, 16);
  assert.equal(c.ok, true);
});

test("one low warehouse alerts even with many healthy ones; every affected warehouse is listed lowest first", () => {
  const c = one([...fcs(20, 100), [code(20), 9], [code(21), 2]]);
  assert.equal(c.reason, "lowUnits");
  assert.deepEqual(c.low, [{ fc: code(21), units: 2 }, { fc: code(20), units: 9 }]);
});

test("0 units is not 'has stock'; non-eligible warehouses never count", () => {
  const c = one([...fcs(7, 50), [code(7), 0], ["BLR5", 900], ["DEL2", 900], ["COX1", 900], ["VSNC", 900]]);
  assert.equal(c.stocked.length, 7);
  assert.equal(c.reason, "fewFcs");
});

test("rows for the same warehouse are summed before comparing with 20", () => {
  const c = one([...fcs(7, 50), [code(7), 12], [code(7), 15]]);
  assert.equal(c.stocked.length, 8);
  assert.equal(c.ok, true);
});

// --- data validation ---
test("a missing row is zero only when the snapshot covers that warehouse; otherwise unknown and excluded", () => {
  const confirmed = one(fcs(8, 50));
  assert.equal(confirmed.zeroFcs.length, 16);
  assert.deepEqual(confirmed.unknownFcs, []);
  const partial = one(fcs(8, 50), snapOf(20)); // FCs 20..23 not reported by SellerMate
  assert.equal(partial.zeroFcs.length, 12);
  assert.equal(partial.unknownFcs.length, 4);
  assert.equal(partial.dataIssue, "undetermined"); // passing on known data, but an unknown FC could hold 1..20
  assert.equal(partial.ok, false);
  assert.equal(partial.reason, null);
});

test("unknown warehouses that cannot change the verdict leave a decided alert (partialData)", () => {
  const known = one([...fcs(10, 50), [code(10), 4]], snapOf(20)); // a known low FC: alert whatever the unknowns hold
  assert.equal(known.reason, "lowUnits");
  assert.equal(known.dataIssue, "partialData");
  const few = one(fcs(3, 50), snapOf(20)); // 3 stocked + 4 unknown < 8: alert whatever the unknowns hold
  assert.equal(few.reason, "fewFcs");
  assert.equal(few.dataIssue, "partialData");
});

test("unknown warehouses that could lift a SKU to 8 make it undetermined, not an alert", () => {
  const c = one(fcs(5, 50), snapOf(20)); // 5 stocked + 4 unknown ≥ 8
  assert.equal(c.reason, null);
  assert.equal(c.dataIssue, "undetermined");
});

test("stale rows and rows with unknown units are unknown, never zero", () => {
  const c = one([...fcs(20, 50), [code(20), 0, "2026-09-30"], [code(21), null]]);
  assert.deepEqual(c.unknownFcs, [code(20), code(21)].sort());
  assert.ok(!c.zeroFcs.includes(code(20)) && !c.zeroFcs.includes(code(21)));
});

test("a SKU with no current ledger row is noData and not evaluated; MFN with no rows is out of scope", () => {
  const rows = skuCoverage([product("A1", [
    sku("S1", [["LKO1", null]]),
    sku("S2", []),
    sku("S3", [["LKO1", 40, "2026-09-01"]]),
    { ...sku("S4", []), channel: "MFN" },
  ])], 20, 8, ELIGIBLE_FCS, FULL);
  assert.deepEqual(rows.map((r) => [r.sku, r.dataIssue, r.reason]), [["S1", "noData", null], ["S2", "noData", null], ["S3", "noData", null]]);
});

test("ledgerSnapshot takes the latest date and the warehouses with known rows on it; age is in days", () => {
  const snap = ledgerSnapshot([product("A1", [sku("S1", [["BLR7", 5], ["MAA4", null], ["HYD3", 9, "2026-10-01"]])])]);
  assert.equal(snap.date, DAY);
  assert.deepEqual([...snap.fcs], ["BLR7"]);
  assert.equal(snapshotAgeDays(snap, "2026-10-09"), 2);
  assert.equal(snapshotAgeDays({ date: null, fcs: new Set() }, "2026-10-09"), null);
});

test("a SKU listed under two ASINs is merged, so the stock-less copy is not a false noData", () => {
  const rows = skuCoverage([product("A1", [sku("S1", [])]), product("A2", [sku("S1", fcs(8, 50))])], 20, 8, ELIGIBLE_FCS, FULL);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ok, true);
  assert.equal(rows[0].asin, "A2");
});

// --- transitions ---
test("first run: every failing SKU is new; later runs mail only new failures, re-armed after recovery", () => {
  const cov = skuCoverage([product("A1", [
    sku("S1", fcs(3, 50)), // fewFcs
    sku("S2", [...fcs(8, 50), [code(8), 5]]), // lowUnits
    sku("S3", fcs(8, 50)), // passing
  ])], 20, 8, ELIGIBLE_FCS, FULL);
  const first = findNewFailures(cov, new Map());
  assert.deepEqual(first.failing.map((d) => d.sku), ["S1", "S2"]); // fewFcs first
  // next day, same stock: state says S1/S2 were mailed → nothing new
  const second = findNewFailures(cov, new Map([["S1", true], ["S2", true]]));
  assert.deepEqual(second.failing, []);
  assert.equal(second.stillFailing, 2);
  // S3 had failed before and recovered (severity 0) → failing again is new
  const again = findNewFailures(skuCoverage([product("A1", [sku("S3", fcs(4, 50))])], 20, 8, ELIGIBLE_FCS, FULL), new Map([["S3", false]]));
  assert.deepEqual(again.failing.map((d) => d.sku), ["S3"]);
  // a mailed SKU that now passes is reported as recovered (re-armed)
  const rec = findNewFailures(cov, new Map([["S3", true]]));
  assert.deepEqual(rec.recovered.map((d) => d.sku), ["S3"]);
});

test("data-gap SKUs neither fail nor recover the stock alert; gaps have their own transitions", () => {
  const cov = skuCoverage([product("A1", [sku("S1", []), sku("S2", []), sku("S3", fcs(8, 50))])], 20, 8, ELIGIBLE_FCS, FULL);
  const stock = findNewFailures(cov, new Map([["S1", true]]));
  assert.deepEqual(stock.failing, []);
  assert.deepEqual(stock.recovered, []); // S1 has no data: its failing state is kept, not re-armed
  const gaps = findNewDataGaps(cov, new Map([["S2", true], ["S3", true]]));
  assert.deepEqual(gaps.newGaps.map((g) => g.sku), ["S1"]);
  assert.equal(gaps.stillMissing, 1);
  assert.deepEqual(gaps.resolved.map((g) => g.sku), ["S3"]);
});

test("stock outside the eligible FCs (VSNC) is reported as elsewhere, not counted by the rule", () => {
  const c = one([["VSNC", 277], ["DEL2", 3], ["VSNC", 0]]);
  assert.equal(c.stocked.length, 0);
  assert.equal(c.reason, "fewFcs");
  assert.deepEqual(c.elsewhere, [{ fc: "VSNC", units: 277 }, { fc: "DEL2", units: 3 }]);
  assert.deepEqual(one(fcs(8, 50)).elsewhere, []);
  // a stale VSNC row (older snapshot) is not shown
  assert.deepEqual(one([["VSNC", 40, "2026-10-01"], [code(0), 30]]).elsewhere, []);
});
