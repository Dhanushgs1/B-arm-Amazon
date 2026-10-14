import test from "node:test";
import assert from "node:assert/strict";
import { toPerDay, amazonRows, flipkartRows, meeshoAvgPrice, meeshoRows } from "./highAcosChannels.ts";

const DATES = ["2026-10-10", "2026-10-11"];

test("sums rows per campaign per day and keeps empty days", () => {
  const pd = toPerDay(amazonRows([
    { report_date: "2026-10-11", campaign_name: "A", spend: 100, sales_7d: 500, orders_7d: 2 },
    { report_date: "2026-10-11", campaign_name: "A", spend: 50, sales_7d: 0, orders_7d: 0 },
    { report_date: "2026-10-11", campaign_name: "B", spend: 0, sales_7d: 0, orders_7d: 0 },
  ]), DATES);
  assert.equal(pd.length, 2);
  assert.deepEqual(pd[0].rows, []);
  assert.deepEqual(pd[1].rows, [{ campaignId: "A", campaignName: "A", spend: 150, sales: 500, orders: 2 }]);
});

test("Flipkart uses ad_spend and revenue, keyed by campaign id", () => {
  const [r] = flipkartRows([{ report_date: "2026-10-11", campaign_id: "C1", campaign_name: "Brush", ad_spend: "80", revenue: "400", units_sold: 3 }]);
  assert.deepEqual(r, { date: "2026-10-11", id: "C1", name: "Brush", spend: 80, sales: 400, orders: 3 });
});

test("Meesho sales = orders × average selling price; unknown price gives no sales", () => {
  const price = meeshoAvgPrice([
    { sku: "B-CT-Y", discounted_price: 170 }, { sku: "B-CT-Y", discounted_price: 190 }, { sku: "B-CT-Y", discounted_price: 0 },
  ]);
  assert.equal(price.get("B-CT-Y"), 180);
  const rows = meeshoRows([
    { report_date: "2026-10-11", sku: "B-CT-Y", product_name: "Chewy tube (Yellow)", spend: 36, orders_by_ad: 2 },
    { report_date: "2026-10-11", sku: "NEW", product_name: "New", spend: 10, orders_by_ad: 1 },
  ], price);
  assert.equal(rows[0].name, "Chewy tube (Yellow) (B-CT-Y)");
  assert.equal(rows[0].sales, 360);
  assert.equal(rows[1].sales, 0);
});
