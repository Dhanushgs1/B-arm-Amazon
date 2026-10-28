import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// historicalReturnsRules imports through the "@/" alias, so load it the same way the other report tests do.
const SRC_POSIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..").replace(/\\/g, "/");
const jiti = createJiti(import.meta.url, { alias: { "@/": `${SRC_POSIX}/` } });
const { sellerReturnsBySku } = await jiti.import(`${SRC_POSIX}/lib/historicalReturnsRules.ts`) as typeof import("./historicalReturnsRules.ts");
const { dedupeSellerFlexReturns } = await jiti.import(`${SRC_POSIX}/lib/amazonSpendRules.ts`) as typeof import("./amazonSpendRules.ts");
const { computeGrandTotals } = await jiti.import(`${SRC_POSIX}/lib/historicalTotalsRules.ts`) as typeof import("./historicalTotalsRules.ts");

const NONE = new Map<string, number>();
type Line = { orderId: string; sku: string; qty: number; orderedQty?: number };
const am = (sku: string, qty: number, orderId = `A-${sku}-${qty}`): Line => ({ orderId, sku, qty });
const fba = (sku: string, qty: number, orderId = `F-${sku}-${qty}`): Line => ({ orderId, sku, qty });
const sf = (sku: string, qty: number, orderId = `S-${sku}-${qty}`): Line => ({ orderId, sku, qty });

test("AM-present SKU counts AM returns only, ignoring its FBA and SellerFlex returns", () => {
  // B-INSEM-KIT-style case: AM 23 units, FBA 14 and SellerFlex 9 on the same SKU. Only the AM 23 counts.
  const r = sellerReturnsBySku({
    am: [am("X", 10, "a1"), am("X", 13, "a2")],
    fba: [fba("X", 14, "f1")],
    sf: [sf("X", 9, "s1")],
    orderedByLine: NONE,
  });
  assert.equal(r.bySku.get("X"), 23);
  assert.ok(r.amSkus.has("X"));
  assert.ok(!r.fallbackSkus.has("X"));
});

test("AM-absent SKU counts FBA plus SellerFlex returns", () => {
  const r = sellerReturnsBySku({
    am: [],
    fba: [fba("Y", 4, "f1"), fba("Y", 2, "f2")],
    sf: [sf("Y", 3, "s1")],
    orderedByLine: NONE,
  });
  assert.equal(r.bySku.get("Y"), 9);
  assert.ok(r.fallbackSkus.has("Y"));
  assert.ok(!r.amSkus.has("Y"));
});

test("the AM rule is decided per SKU: one SKU's AM does not suppress another SKU's FBA/SellerFlex", () => {
  const r = sellerReturnsBySku({
    am: [am("A", 2)],
    fba: [fba("A", 5), fba("B", 3)],
    sf: [sf("B", 1)],
    orderedByLine: NONE,
  });
  assert.equal(r.bySku.get("A"), 2, "A has AM, so its FBA 5 is ignored");
  assert.equal(r.bySku.get("B"), 4, "B has no AM, so FBA 3 + SellerFlex 1 count");
});

test("SellerFlex duplicates on (order, shipment, mSKU) count once", () => {
  const raw = [
    { customer_order_id: "O1", shipment_id: "SH1", msku: "Z", pickup_date: "2026-10-01", units: 1, id: 1 },
    { customer_order_id: "O1", shipment_id: "SH1", msku: "Z", pickup_date: "2026-10-01", units: 1, id: 2 },
    { customer_order_id: "O1", shipment_id: "SH2", msku: "Z", pickup_date: "2026-10-01", units: 1, id: 3 },
  ];
  const deduped = dedupeSellerFlexReturns(raw).map((r) => ({ orderId: r.customer_order_id, sku: r.msku, qty: r.units }));
  const r = sellerReturnsBySku({ am: [], fba: [], sf: deduped, orderedByLine: NONE });
  assert.equal(deduped.length, 2, "the repeated (O1, SH1, Z) row is dropped, the other shipment kept");
  assert.equal(r.bySku.get("Z"), 2);
});

test("a SellerFlex line on an AM-present SKU is not counted", () => {
  const r = sellerReturnsBySku({ am: [am("C", 1)], fba: [], sf: [sf("C", 5)], orderedByLine: NONE });
  assert.equal(r.bySku.get("C"), 1);
});

test("the ordered-quantity cap still applies to the counted lines", () => {
  // Order O9 for SKU D had 1 unit ordered; AM reports 3 returned on it. Counts 1, and the cap is reported.
  const ordered = new Map([["O9|D", 1]]);
  const r = sellerReturnsBySku({ am: [am("D", 3, "O9")], fba: [], sf: [], orderedByLine: ordered });
  assert.equal(r.bySku.get("D"), 1);
  assert.equal(r.capped.length, 1);
});

test("Final is Orders minus Returns, subtracted once, with SellerFlex inside Returns only", () => {
  // SKU E: 10 orders, AM 2 (SellerFlex 5 is ignored because AM exists). SKU F: 4 orders, no AM, FBA 1 + SellerFlex 1.
  const r = sellerReturnsBySku({
    am: [am("E", 2)],
    fba: [fba("F", 1)],
    sf: [sf("E", 5), sf("F", 1)],
    orderedByLine: NONE,
  });
  const totals = computeGrandTotals(
    [{ sku: "E", price: 100, spendTax: 0, advUnits: 0 }, { sku: "F", price: 100, spendTax: 0, advUnits: 0 }],
    [
      { sku: "E", price: 100, totalUnits: 0, orderUnits: 10, returns: r.bySku.get("E") || 0 },
      { sku: "F", price: 100, totalUnits: 0, orderUnits: 4, returns: r.bySku.get("F") || 0 },
    ],
  );
  assert.equal(totals.returns, 4, "E 2 (AM) + F 2 (FBA 1 + SellerFlex 1)");
  assert.equal(totals.final, 14 - 4, "Final = Orders − Returns once");
});
