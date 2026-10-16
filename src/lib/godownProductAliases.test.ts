import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeGodownProducts, mergeGodownDaily, checkStockMapping, currentGodownName, keptGodownName, isGodownDuplicate, duplicateOriginal,
} from "./godownProductAliases.ts";

const p = (product: string, currentStock: number) => ({ product, currentStock, inboundShipped: 0, unfulfillable: 0, warehouse: currentStock, qcGodown: 0, packingGodown: 0, skuRows: 1, discontinued: false });
const stockOf = (rows: ReturnType<typeof p>[]) => mergeGodownProducts(rows).map((r) => [r.product, r.currentStock]);
const d = (date: string, product: string, stockOut: number) => ({ date, product, stockOut });
const dailyOf = (rows: ReturnType<typeof d>[]) => mergeGodownDaily(rows).map((r) => [r.date, r.product, r.stockOut]);

test("stock: a copy with no original row keeps its stock under the original (14.10.2026 file)", () => {
  assert.deepEqual(stockOf([p("Teething Tube Combo (Green Red Yellow)", 189), p("IR Thermometer GP-100", 4)]), [
    ["Teething tube combo (Green,red,yellow)", 189], ["IR THERMOMETER- GP 100", 4],
  ]);
});

test("stock: copy and original both present — counted once, whichever comes first", () => {
  assert.deepEqual(stockOf([p("IR Thermometer GP-100", 4), p("IR THERMOMETER- GP 100", 4)]), [["IR THERMOMETER- GP 100", 4]]);
  assert.deepEqual(stockOf([p("IR THERMOMETER- GP 100", 4), p("IR Thermometer GP-100", 4)]), [["IR THERMOMETER- GP 100", 4]]);
  // a renamed original also counts as the original being there
  assert.deepEqual(stockOf([p("Teething Tube Combo (Green Red Yellow)", 189), p("Teething tube combo (Green red yellow)", 189)]), [
    ["Teething tube combo (Green,red,yellow)", 189],
  ]);
});

test("stock: renamed products are summed under the kept name", () => {
  assert.deepEqual(stockOf([p("Wearable Lactation Massager-Grey", 68), p("Wearable lactation massager (Grey)", 2), p("Chewy tube (Red)-Bump", 5)]), [
    ["Wearable Lactation Massager-Grey", 70], ["Chewy Tube Red (Bump Type)", 5],
  ]);
});

test("names: spacing differences match; case differences match unless names with that casing mean different things", () => {
  assert.equal(currentGodownName("  Wearable   lactation massager (Grey) "), "Wearable Lactation Massager-Grey");
  assert.equal(currentGodownName("WEARABLE LACTATION MASSAGER (GREY)"), "Wearable Lactation Massager-Grey");
  assert.ok(isGodownDuplicate(" ir thermometer  gp-100 "));
  assert.equal(keptGodownName("IR THERMOMETER GP-100"), "IR THERMOMETER- GP 100");
  assert.equal(currentGodownName("Flat   Teether "), "Flat Teether");
  // "Teething tube combo (Green red yellow)" is a rename, "Teething Tube Combo (Green Red Yellow)" a copy:
  // exact spellings keep their own meaning, other casings of that name are not guessed.
  assert.equal(duplicateOriginal("Teething Tube Combo (Green Red Yellow)"), "Teething tube combo (Green,red,yellow)");
  assert.equal(isGodownDuplicate("Teething tube combo (Green red yellow)"), false);
  assert.equal(currentGodownName("Teething tube combo (Green red yellow)"), "Teething tube combo (Green,red,yellow)");
  assert.equal(isGodownDuplicate("TEETHING TUBE COMBO (GREEN RED YELLOW)"), false);
  assert.equal(currentGodownName("TEETHING TUBE COMBO (GREEN RED YELLOW)"), "TEETHING TUBE COMBO (GREEN RED YELLOW)");
  assert.deepEqual(stockOf([p("IR  thermometer gp-100", 4), p("ir thermometer- gp 100", 4)]), [["ir thermometer- gp 100", 4]]);
});

test("daily: a copy's day counts when the original has no row that day, and is dropped when it does", () => {
  assert.deepEqual(dailyOf([
    d("2026-10-13", "Teething tube combo (Green,red,yellow)", 1), d("2026-10-13", "Teething Tube Combo (Green Red Yellow)", 1),
    d("2026-10-14", "Teething Tube Combo (Green Red Yellow)", 2),
    d("2026-10-14", "IR Thermometer GP-100", 0),
    d("2026-08-20", "Teething tube combo (Green red yellow)", 3),
  ]), [
    ["2026-10-13", "Teething tube combo (Green,red,yellow)", 1],
    ["2026-10-14", "Teething tube combo (Green,red,yellow)", 2],
    ["2026-10-14", "IR THERMOMETER- GP 100", 0],
    ["2026-08-20", "Teething tube combo (Green,red,yellow)", 3],
  ]);
});

test("mapping check: flags spelling-only mismatches and copies with other stock, not products left off on purpose", () => {
  const raw = [
    { product: "IR THERMOMETER- GP 100", currentStock: 4 }, { product: "IR Thermometer GP-100", currentStock: 5 },
    { product: "Chewy tube Blue spiral", currentStock: 12 },
    { product: "Teething Tube Combo (Green Red Yellow)", currentStock: 189 },
    { product: "Blades", currentStock: 30 },
  ];
  const shown = [{ product: "IR THERMOMETER- GP 100" }, { product: "Chewy tube (Blue) - Spiral model" }, { product: "Teething tube combo (Green,red,yellow)" }];
  assert.deepEqual(checkStockMapping(raw, shown).map((i) => [i.product, i.kind, i.stock]), [["IR Thermometer GP-100", "copy_differs", 5]]);
  const shown2 = [{ product: "Chewy tube blue spiral" }];
  assert.deepEqual(checkStockMapping([{ product: "Chewy Tube - Blue Spiral", currentStock: 12 }], shown2).map((i) => [i.product, i.kind]), [["Chewy Tube - Blue Spiral", "unmatched"]]);
  // copy with the same stock as its original, and a copy whose original is missing: nothing to report
  assert.deepEqual(checkStockMapping([{ product: "IR THERMOMETER- GP 100", currentStock: 4 }, { product: "IR Thermometer GP-100", currentStock: 4 }], shown), []);
  assert.deepEqual(checkStockMapping([{ product: "Teething Tube Combo (Green Red Yellow)", currentStock: 189 }], shown), []);
});
