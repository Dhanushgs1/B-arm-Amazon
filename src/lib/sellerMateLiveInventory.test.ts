import test from "node:test";
import assert from "node:assert/strict";
import { buildLiveInventory, fetchLiveInventory, type SmByLocationItem, type SmCatalogItem, type SmMergedItem } from "./sellerMateLiveInventory.ts";

const cat = (asin: string, sku: string, channel: string, quantity: number | null = null): SmCatalogItem => ({ asin, sku, itemName: `P ${asin}`, price: 100, fulfillmentChannel: channel, quantity, status: [], marketplaceId: "" });
const merged = (asin: string, fbm: number, fba: number): SmMergedItem => ({ asin, sku: "", itemName: `P ${asin}`, price: 499, mainImageUrl: null, fbm: { quantity: fbm }, fba: { endingWarehouseBalance: fba } });
const loc = (asin: string, sku: string, locs: [string, number][]): SmByLocationItem => ({
  asin, sku, fba: { endingWarehouseBalance: locs.reduce((a, [, n]) => a + n, 0), asOfDate: "2026-10-04T00:00:00", byLocation: locs.map(([location, n]) => ({ location, endingWarehouseBalance: n, fnsku: "X00" + sku, sku, asOfDate: "2026-10-04T00:00:00" })) },
});

test("Sensory Brush shape: warehouse-wise totals, channels, and unprovided fields stay null (never 0)", () => {
  const r = buildLiveInventory(
    [cat("B0DDTTPKJ3", "B-SENBR", "DEFAULT", 0), cat("B0DDTTPKJ3", "B-SENBR-1", "AMAZON_IN"), cat("B0DDTTPKJ3", "B-SENBR-2", "AMAZON_IN")],
    [merged("B0DDTTPKJ3", 0, 1746)],
    [loc("B0DDTTPKJ3", "B-SENBR-1", [["LKO1", 218], ["DEL4", 215], ["BLR7", 1313]])],
    "2026-10-06T10:00:00Z",
  );
  const p = r.products[0];
  assert.equal(p.fbaWarehouseBalance, 1746);
  assert.equal(p.warehouseTotal, 1746);
  assert.equal(p.fbmQuantity, 0);
  assert.equal(p.warehouseCount, 3);
  assert.equal(p.ledgerDate, "2026-10-04");
  assert.deepEqual([p.available, p.reserved, p.inbound, p.unfulfillable], [null, null, null, null]);
  const s1 = p.skus.find((s) => s.sku === "B-SENBR-1")!;
  assert.equal(s1.channel, "FBA");
  assert.equal(s1.fbaWarehouseBalance, 1746);
  assert.equal(s1.listingQuantity, null); // catalog gave null → stays null
  assert.equal(s1.fnsku, "X00B-SENBR-1");
  const s0 = p.skus.find((s) => s.sku === "B-SENBR")!;
  assert.equal(s0.channel, "MFN");
  assert.equal(s0.fbaWarehouseBalance, null); // no FBA rows → unknown, not 0
  assert.equal(s0.listingQuantity, 0); // SellerMate said 0 → 0
  assert.equal(r.warehouses.find((w) => w.location === "BLR7")!.units, 1313);
});

test("duplicate rows from SellerMate paging are removed, nothing double-counted", () => {
  const r = buildLiveInventory([cat("A", "a-1", "AMAZON_IN")], [merged("A", 0, 5), merged("A", 0, 5)], [loc("A", "a-1", [["X", 5]]), loc("A", "a-1", [["X", 5]])], "t");
  assert.equal(r.products.length, 1);
  assert.equal(r.products[0].fbaWarehouseBalance, 5);
  assert.equal(r.products[0].warehouseTotal, 5);
  assert.equal(r.counts.duplicateRowsRemoved, 2);
});

test("no product disappears: catalog-only and warehouse-only ASINs are kept", () => {
  const r = buildLiveInventory([cat("CATONLY", "c-1", "DEFAULT", 7)], [merged("M", 2, 0)], [loc("FBAONLY", "f-1", [["Y", 3]])], "t");
  assert.deepEqual(r.products.map((p) => p.asin).sort(), ["CATONLY", "FBAONLY", "M"]);
  const c = r.products.find((p) => p.asin === "CATONLY")!;
  assert.equal(c.fbmQuantity, null); // not in SellerMate's inventory list → unknown
  assert.equal(c.stockStatus, "Unknown");
  assert.equal(r.products.find((p) => p.asin === "FBAONLY")!.fbaWarehouseBalance, 3);
});

test("fetchLiveInventory requests every ASIN in batches even when offset paging misbehaves", async () => {
  const asins = Array.from({ length: 120 }, (_, i) => `A${i}`);
  const calls: string[] = [];
  const caller = async (tool: string, args: Record<string, unknown>) => {
    calls.push(tool + ":" + (args.view ?? "") + ":" + ((args.asins as string[] | undefined)?.length ?? "page"));
    if (tool === "list_product_catalog") return args.offset === 0 ? { total: 120, products: asins.map((a) => cat(a, a + "-1", "DEFAULT", 1)) } : { total: 120, products: [] };
    if (args.asins) return { items: (args.asins as string[]).map((a) => (args.view === "merged" ? merged(a, 1, 0) : null)).filter(Boolean) };
    return { total: 0, items: [] };
  };
  const r = await fetchLiveInventory(caller, { workspace_id: "w", amazon_account_id: "a" }, 50);
  assert.equal(r.products.length, 120);
  assert.equal(r.requested.missingFromInventoryList, 0);
  assert.equal(calls.filter((c) => c.startsWith("get_inventory:merged:")).length, 3); // 50 + 50 + 20
});

test("a SKU listed under two ASINs stays linked to both", () => {
  const r = buildLiveInventory([cat("A1", "SAME", "DEFAULT", 0), cat("A2", "SAME", "DEFAULT", 0)], [merged("A1", 0, 0), merged("A2", 0, 0)], [], "t");
  assert.deepEqual(r.products.map((p) => [p.asin, p.skus.map((s) => s.sku)]).sort(), [["A1", ["SAME"]], ["A2", ["SAME"]]]);
  assert.equal(r.counts.duplicateRowsRemoved, 0);
});
