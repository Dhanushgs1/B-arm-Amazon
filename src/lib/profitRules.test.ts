import test from "node:test";
import assert from "node:assert/strict";
import { adSpendByMonth, breakEvenAcos, productAction, profitByMonth, type ActionInput, type ErpProfit } from "./profitRules.ts";

const erp: ErpProfit = {
  months: [{ month: "2026-09-01", marketplace: "Amazon", units: 100, salesWithTax: 118000, revenue: 100000, cost: 32000, margin: 68000, linesWithoutCost: 2 }],
  skus: [
    { month: "2026-08-01", marketplace: "Amazon", sku: "A", name: "A", units: 10, salesWithTax: 11800, revenue: 10000, cost: 4000, margin: 6000, noCost: false },
    { month: "2026-09-01", marketplace: "Amazon", sku: "A", name: "A", units: 10, salesWithTax: 11800, revenue: 10000, cost: 4000, margin: 6000, noCost: false },
    { month: "2026-09-01", marketplace: "Flipkart", sku: "B", name: "B", units: 5, salesWithTax: 5000, revenue: 4500, cost: 0, margin: 4500, noCost: true },
  ],
};

test("profit after ads per month; unknown ad spend stays unknown", () => {
  const [m] = profitByMonth(erp, new Map([["2026-09-01|Amazon", 8000]]));
  assert.equal(m.marginPct, 68);
  assert.equal(m.profitAfterAds, 60000);
  assert.equal(profitByMonth(erp, new Map())[0].profitAfterAds, null);
});

test("break-even ACOS = margin ÷ sales incl. tax; none without a cost price", () => {
  const be = breakEvenAcos(erp);
  assert.equal(Math.round(be.get("amazon|A")! * 10) / 10, 50.8); // 12,000 ÷ 23,600
  assert.equal(be.get("flipkart|B"), null);
});

const base: ActionInput = { units: 40, revenue: 40000, growthPct: 5, returnRatePct: 3, stock: 200, daysOfCover: 90, adSpend: 2000, adSales: 20000, breakEvenAcos: 50 };

test("actions in order of urgency", () => {
  assert.equal(productAction({ ...base, stock: 0 }).action, "Restock");
  assert.equal(productAction({ ...base, daysOfCover: 10 }).action, "Restock");
  assert.equal(productAction({ ...base, adSpend: 12000, adSales: 20000 }).action, "Cut ads"); // ACOS 60% > 50%
  assert.equal(productAction({ ...base, adSpend: 800, adSales: 0 }).action, "Cut ads");
  assert.equal(productAction({ ...base, returnRatePct: 20 }).action, "Check quality");
  assert.notEqual(productAction({ ...base, returnRatePct: 20, units: 5 }).action, "Check quality"); // too few units to judge
  assert.equal(productAction(base).action, "Raise ads"); // ACOS 10% < 25%
  assert.equal(productAction({ ...base, growthPct: -12 }).action, null); // falling sales: not more ads
  assert.equal(productAction({ ...base, breakEvenAcos: null }).action, null); // no cost price: no ad call
  assert.match(productAction({ ...base, adSpend: 12000 }).reason, /ACOS 60\.0% is above its break-even 50\.0%/);
});

test("ad spend per report month and marketplace", () => {
  const m = adSpendByMonth(["2026-08-31", "2026-09-01", "2026-09-02"], [{ id: "amazon", spend: [100, 200, null] }, { id: "google", spend: [5, 5, 5] }]);
  assert.equal(m.get("2026-08-01|Amazon"), 100);
  assert.equal(m.get("2026-09-01|Amazon"), 200);
  assert.equal(m.size, 2);
});
