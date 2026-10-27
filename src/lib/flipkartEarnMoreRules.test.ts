import test from "node:test";
import assert from "node:assert/strict";
import {
  EARN_MORE_MISSING_LABEL,
  PRICE_MISSING_LABEL,
  NA_LABEL,
  acosPopulation,
  priceCellValue,
  ratioOrNA,
  tacosPopulation,
  earnMoreDaysWithoutRecords,
  earnMoreIsPartial,
  ratioFormula,
  realisedAspBySku,
  resolvePrice,
  earnMoreCoverage,
  earnMoreRowsInWindow,
  finalSaleAmountBySku,
} from "./flipkartEarnMoreRules.ts";

const START = "2026-09-23";
const END = "2026-10-22";

test("an empty Earn More table reports no records and no coverage dates", () => {
  const c = earnMoreCoverage([], START, END);
  assert.deepEqual(c, { rowCount: 0, hasRecords: false, dataFrom: null, dataThrough: null });
  assert.equal(EARN_MORE_MISSING_LABEL, "Earn More data missing");
});

test("records that all fall outside the window leave it empty", () => {
  const rows = [{ order_date: "2026-09-22", sku_id: "A", final_sale_amount: 100 }];
  assert.equal(earnMoreCoverage(rows, START, END).hasRecords, false);
});

test("the window includes both boundary dates and excludes the days either side", () => {
  const rows = [
    { order_date: "2026-09-22", sku_id: "A", final_sale_amount: 1 },
    { order_date: "2026-09-23", sku_id: "A", final_sale_amount: 2 },
    { order_date: "2026-10-22", sku_id: "A", final_sale_amount: 4 },
    { order_date: "2026-10-23", sku_id: "A", final_sale_amount: 8 },
  ];
  const inWindow = earnMoreRowsInWindow(rows, START, END);
  assert.deepEqual(inWindow.map((r) => r.final_sale_amount), [2, 4]);
  assert.deepEqual(earnMoreCoverage(rows, START, END), {
    rowCount: 2,
    hasRecords: true,
    dataFrom: "2026-09-23",
    dataThrough: "2026-10-22",
  });
});

test("order_date timestamps compare on their calendar day", () => {
  const rows = [{ order_date: "2026-10-22T18:30:00", sku_id: "A", final_sale_amount: 5 }];
  assert.equal(earnMoreCoverage(rows, START, END).rowCount, 1);
});

test("valid records sum per SKU and in total, without estimates", () => {
  const rows = [
    { order_date: "2026-09-25", sku_id: "A", final_sale_amount: 1000 },
    { order_date: "2026-10-01", sku_id: "A", final_sale_amount: "500.5" },
    { order_date: "2026-10-03", sku_id: "B", final_sale_amount: 250 },
    { order_date: "2026-10-03", sku_id: "C", final_sale_amount: null },
    { order_date: "2026-08-01", sku_id: "B", final_sale_amount: 9999 },
  ];
  const inWindow = earnMoreRowsInWindow(rows, START, END);
  const bySku = finalSaleAmountBySku(inWindow);
  assert.equal(bySku.get("A"), 1500.5);
  assert.equal(bySku.get("B"), 250);
  assert.equal(bySku.get("C"), 0);
  assert.equal(bySku.has("Z"), false);
  const total = [...bySku.values()].reduce((s, v) => s + v, 0);
  assert.equal(total, 1750.5);
});

test("rows without a SKU are ignored in the per-SKU totals", () => {
  const bySku = finalSaleAmountBySku([{ sku_id: "", final_sale_amount: 40 }, { sku_id: null, final_sale_amount: 60 }]);
  assert.equal(bySku.size, 0);
});

test("the 7-day block is the last 7 days of the same 30-day rows", () => {
  const rows = [
    { order_date: "2026-10-15", sku_id: "A", final_sale_amount: 100 },
    { order_date: "2026-10-16", sku_id: "A", final_sale_amount: 10 },
    { order_date: "2026-10-22", sku_id: "A", final_sale_amount: 1 },
  ];
  const seven = earnMoreRowsInWindow(rows, "2026-10-16", "2026-10-22");
  assert.equal(finalSaleAmountBySku(seven).get("A"), 11);
});

test("the realised ASP is final sale amount over final sale units, per SKU", () => {
  const rows = [
    { sku_id: "A", final_sale_amount: 1000, final_sale_units: 4 },
    { sku_id: "A", final_sale_amount: 500, final_sale_units: 1 },
    { sku_id: "B", final_sale_amount: 300, final_sale_units: 3 },
  ];
  const asp = realisedAspBySku(rows);
  assert.equal(asp.get("A"), 300);
  assert.equal(asp.get("B"), 100);
});

test("the realised ASP falls back to GMV and gross units when the final-sale columns are empty", () => {
  const asp = realisedAspBySku([{ sku_id: "A", final_sale_amount: null, gmv: 800, final_sale_units: 0, gross_units: 8 }]);
  assert.equal(asp.get("A"), 100);
});

test("a SKU with no units in the window has no realised ASP — no estimate", () => {
  const asp = realisedAspBySku([{ sku_id: "A", final_sale_amount: 0, final_sale_units: 0, gross_units: 0 }]);
  assert.equal(asp.has("A"), false);
});

test("the listed price wins over the realised ASP", () => {
  assert.equal(resolvePrice(2608, 100), 2608);
});

test("with no listing, the realised ASP is the price", () => {
  assert.equal(resolvePrice(0, 412.5), 412.5);
});

test("with no listing and no Earn More sales, the price is unknown (0), never a verified zero", () => {
  assert.equal(resolvePrice(0, undefined), 0);
  assert.equal(resolvePrice(0, 0), 0);
  assert.equal(PRICE_MISSING_LABEL, "Price missing");
});

test("a SKU whose Earn More rows fall outside the window gets no realised ASP", () => {
  const rows = [{ order_date: "2026-08-01", sku_id: "A", final_sale_amount: 900, final_sale_units: 3 }];
  const inWindow = earnMoreRowsInWindow(rows, START, END);
  assert.equal(resolvePrice(0, realisedAspBySku(inWindow).get("A")), 0);
});

test("coverage that reaches both ends of the window is not partial", () => {
  const rows = [
    { order_date: START, sku_id: "A", final_sale_amount: 1 },
    { order_date: END, sku_id: "A", final_sale_amount: 1 },
  ];
  assert.equal(earnMoreIsPartial(earnMoreCoverage(rows, START, END), START, END), false);
});

test("records that stop before the window ends are partial, with their dates", () => {
  const rows = [
    { order_date: START, sku_id: "A", final_sale_amount: 1 },
    { order_date: "2026-10-10", sku_id: "A", final_sale_amount: 1 },
  ];
  const c = earnMoreCoverage(rows, START, END);
  assert.equal(earnMoreIsPartial(c, START, END), true);
  assert.equal(c.dataFrom, START);
  assert.equal(c.dataThrough, "2026-10-10");
});

test("records that start after the window begins are partial", () => {
  const rows = [{ order_date: "2026-10-01", sku_id: "A", final_sale_amount: 1 }, { order_date: END, sku_id: "A", final_sale_amount: 1 }];
  assert.equal(earnMoreIsPartial(earnMoreCoverage(rows, START, END), START, END), true);
});

test("an empty window is missing, not partial", () => {
  assert.equal(earnMoreIsPartial(earnMoreCoverage([], START, END), START, END), false);
});

test("the ACOS formula returns the price-missing label for a text price", () => {
  assert.equal(
    ratioFormula("D2", "C2", "Price missing"),
    'IF(ISNUMBER(C2),IF(C2>0,D2/C2,"Price missing"),"Price missing")'
  );
});

test("the ACOS formula divides for a numeric positive price and never reaches a zero divisor", () => {
  const f = ratioFormula("D2", "C2", "Price missing");
  // The division only sits in the branch reached when C2 is a number greater than 0.
  assert.ok(f.indexOf("D2/C2") > f.indexOf("C2>0"));
  assert.ok(f.indexOf("C2>0") > f.indexOf("ISNUMBER(C2)"));
});

test("the real-time ACOS formula uses the same guard on its own numerator", () => {
  assert.equal(
    ratioFormula("G2", "C2", "Price missing"),
    'IF(ISNUMBER(C2),IF(C2>0,G2/C2,"Price missing"),"Price missing")'
  );
});

test("the formula never returns a numeric 0 for a missing price", () => {
  // The old form was IF(price=0,0,...). A 0 result for a missing price is what this guards against.
  assert.equal(ratioFormula("D2", "C2", "Price missing").includes(",0,"), false);
});

test("a day missing inside the coverage window is reported as a gap, and the endpoints still count", () => {
  const rows = [
    { order_date: "2026-10-01", sku_id: "A", final_sale_amount: 10 },
    { order_date: "2026-10-03", sku_id: "A", final_sale_amount: 20 },
  ];
  assert.deepEqual(earnMoreDaysWithoutRecords(rows, "2026-10-01", "2026-10-03"), ["2026-10-02"]);
  const c = earnMoreCoverage(rows, "2026-10-01", "2026-10-03");
  assert.equal(c.dataFrom, "2026-10-01");
  assert.equal(c.dataThrough, "2026-10-03");
  // Both ends are covered, so this is not partial — the internal gap is a separate limitation.
  assert.equal(earnMoreIsPartial(c, "2026-10-01", "2026-10-03"), false);
});

test("an internal gap is not counted as missing data: its total is the sum of the records present", () => {
  const rows = [
    { order_date: "2026-10-01", sku_id: "A", final_sale_amount: 10 },
    { order_date: "2026-10-03", sku_id: "A", final_sale_amount: 20 },
  ];
  assert.equal(finalSaleAmountBySku(earnMoreRowsInWindow(rows, "2026-10-01", "2026-10-03")).get("A"), 30);
});

test("no internal gaps are reported when records are continuous, and none when the window is empty", () => {
  const rows = [
    { order_date: "2026-10-01", sku_id: "A", final_sale_amount: 1 },
    { order_date: "2026-10-02", sku_id: "A", final_sale_amount: 1 },
  ];
  assert.deepEqual(earnMoreDaysWithoutRecords(rows, "2026-10-01", "2026-10-02"), []);
  assert.deepEqual(earnMoreDaysWithoutRecords([], "2026-10-01", "2026-10-02"), []);
});

test("ACOS uses only priced pairs: unpriced spend and SKU count are excluded and reported", () => {
  const pop = acosPopulation([
    { sku: "A", price: 1000, adUnits: 2, spendTax: 118 },
    { sku: "B", price: 500, adUnits: 0, spendTax: 33.04 },
    { sku: "C", price: 0, adUnits: 0, spendTax: 62.54 },
    { sku: "C", price: 0, adUnits: 0, spendTax: 10 },
  ]);
  assert.equal(pop.numerator, 151.04);
  assert.equal(pop.denominator, 2000);
  assert.equal(pop.value, 151.04 / 2000);
  assert.ok(Math.abs(pop.excludedSpend - 72.54) < 1e-9);
  assert.equal(pop.excludedSkuCount, 1);
});

test("ACOS with no priced pairs at all is N/A, not a division by 1", () => {
  const pop = acosPopulation([{ sku: "C", price: 0, adUnits: 0, spendTax: 62.54 }]);
  assert.equal(pop.value, NA_LABEL);
  assert.equal(pop.excludedSkuCount, 1);
});

test("ACOS with priced pairs but zero ad units is N/A", () => {
  assert.equal(acosPopulation([{ sku: "B", price: 500, adUnits: 0, spendTax: 33 }]).value, NA_LABEL);
});

test("TACOS keeps all spend and all sales, and discloses unpriced SKUs that have net sales", () => {
  const pop = tacosPopulation(213.58, [
    { sku: "A", price: 1000, netUnits: 2 },
    { sku: "B", price: 500, netUnits: 0 },
    { sku: "D", price: 0, netUnits: 3 },
    { sku: "E", price: 0, netUnits: 0 },
  ]);
  assert.equal(pop.numerator, 213.58);
  assert.equal(pop.denominator, 2000);
  assert.equal(pop.unpricedSkuWithSalesCount, 1);
  assert.equal(pop.value, 213.58 / 2000);
});

test("TACOS with no sales at all is N/A, not spend divided by 1", () => {
  const pop = tacosPopulation(100, [{ sku: "C", price: 0, netUnits: 0 }]);
  assert.equal(pop.value, NA_LABEL);
  assert.equal(pop.unpricedSkuWithSalesCount, 0);
});

test("ratioOrNA returns the ratio for a positive denominator and N/A otherwise", () => {
  assert.equal(ratioOrNA(1, 4), 0.25);
  assert.equal(ratioOrNA(1, 0), NA_LABEL);
  assert.equal(ratioOrNA(1, -5), NA_LABEL);
});

test("the Analysis price cell: numeric positive, zero, blank and text prices", () => {
  assert.equal(priceCellValue(2608.4), 2608);
  assert.equal(priceCellValue(0), "Price missing");
  assert.equal(priceCellValue(undefined), "Price missing");
  assert.equal(priceCellValue(null), "Price missing");
  assert.equal(priceCellValue(""), "Price missing");
  assert.equal(priceCellValue("Price missing"), "Price missing");
  assert.equal(priceCellValue(Number.NaN), "Price missing");
  assert.equal(priceCellValue(-5), "Price missing");
});

test("a missing day in the middle of the window is detected, with several gaps listed", () => {
  const rows = [
    { order_date: "2026-10-01", sku_id: "A", final_sale_amount: 1 },
    { order_date: "2026-10-04", sku_id: "A", final_sale_amount: 1 },
    { order_date: "2026-10-07", sku_id: "A", final_sale_amount: 1 },
  ];
  assert.deepEqual(earnMoreDaysWithoutRecords(rows, "2026-10-01", "2026-10-07"), [
    "2026-10-02", "2026-10-03", "2026-10-05", "2026-10-06",
  ]);
});

test("partial coverage is reported with the record dates when records stop early", () => {
  const rows = [
    { order_date: "2026-10-01", sku_id: "A", final_sale_amount: 1 },
    { order_date: "2026-10-03", sku_id: "A", final_sale_amount: 1 },
  ];
  const c = earnMoreCoverage(rows, "2026-10-01", "2026-10-22");
  assert.equal(earnMoreIsPartial(c, "2026-10-01", "2026-10-22"), true);
  assert.equal(c.dataThrough, "2026-10-03");
});
