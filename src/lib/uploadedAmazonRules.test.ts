import test from "node:test";
import assert from "node:assert/strict";
import {
  adCampaigns,
  adDailySeries,
  adTotals,
  isCountedOrderLine,
  pct,
  ratio,
  summarizeUploadedAmazon,
} from "./uploadedAmazonRules.ts";
import { itemsFromFbaReport, buildInventory } from "./inventoryStock.ts";

test("ratio / pct: a zero denominator is 'not defined' (null), never 0 and never a huge number", () => {
  assert.equal(ratio(500, 0), null);
  assert.equal(pct(500, 0), null); // ₹500 spend with no sales is not "ACOS 50,000%"
  assert.equal(pct(0, 0), null);
  assert.equal(pct(50, 200), 25);
  assert.equal(ratio(400, 100), 4);
});

test("order lines: cancelled and non-standard (S02-) ids do not count", () => {
  assert.equal(isCountedOrderLine({ amazon_order_id: "402-1-1", order_status: "Shipped", quantity: 1, item_price: 10 }), true);
  assert.equal(isCountedOrderLine({ amazon_order_id: "402-1-1", order_status: "Cancelled", quantity: 1, item_price: 10 }), false);
  assert.equal(isCountedOrderLine({ amazon_order_id: "S02-1-1", order_status: "Shipped", quantity: 300, item_price: 0 }), false);
  assert.equal(isCountedOrderLine({ amazon_order_id: null, order_status: null, quantity: 1, item_price: 10 }), false);
});

test("totals: sales and units from counted lines; ad sales = SP + SB + SD; organic never negative", () => {
  const t = summarizeUploadedAmazon(
    [
      { amazon_order_id: "402-1", order_status: "Shipped", quantity: 2, item_price: "300.50" },
      { amazon_order_id: "403-2", order_status: "Pending", quantity: 1, item_price: 99.5 },
      { amazon_order_id: "404-3", order_status: "Cancelled", quantity: 5, item_price: 1000 },
      { amazon_order_id: "S02-9", order_status: "Shipped", quantity: 400, item_price: 0 },
    ],
    [{ spend: "40", sales_7d: 100 }, { spend: 10, sales_7d: null }],
    [{ sales: 50 }],
    [{ sales_14d: "25" }],
  );
  assert.equal(t.totalSales, 400);
  assert.equal(t.totalUnits, 3);
  assert.equal(t.totalOrderItems, 2);
  assert.equal(t.totalAdSpend, 50);
  assert.equal(t.totalAdSales, 175);
  assert.equal(t.organicSales, 225);
  assert.equal(summarizeUploadedAmazon([], [{ spend: 1, sales_7d: 500 }], [], []).organicSales, 0);
});

test("ad totals: only rows inside the window count, and 'through' is the last day that has rows", () => {
  const rows = [
    { date: "2026-10-28", name: "A", spend: 10, sales: 100, orders: 2 },
    { date: "2026-10-29", name: "B", spend: 60, sales: 0, orders: 0 },
    { date: "2026-10-20", name: "A", spend: 999, sales: 999, orders: 9 },
  ];
  assert.deepEqual(adTotals(rows, "2026-10-25", "2026-11-10"), { spend: 70, sales: 100, orders: 2, through: "2026-10-29" });
  assert.deepEqual(adTotals(rows, "2026-11-01", "2026-11-10"), { spend: 0, sales: 0, orders: 0, through: null }); // nothing on file, not "zero spend"
});

test("ad daily series: one point per day; a day with nothing uploaded is a gap (null), not 0", () => {
  const s = adDailySeries(
    [
      { date: "2026-10-30", name: "A", spend: 20, sales: 80, orders: 1 },
      { date: "2026-10-30", name: "B", spend: 0, sales: 20, orders: 1 },
      { date: "2026-11-01", name: "A", spend: 5, sales: 0, orders: 0 },
    ],
    "2026-10-30", "2026-11-02",
  );
  assert.deepEqual(s.map((x) => x.rawDate), ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]); // crosses a month end
  assert.deepEqual(s[0], { rawDate: "2026-10-30", sales: 100, spend: 20, roas: 5, acos: 20 });
  assert.deepEqual(s[1], { rawDate: "2026-10-31", sales: null, spend: null, roas: null, acos: null });
  // spend with no ad sales: ACOS is undefined (not 0, not a huge number); ROAS is a real 0
  assert.deepEqual(s[2], { rawDate: "2026-11-01", sales: 0, spend: 5, roas: 0, acos: null });
  assert.equal(s[3].spend, null);
  assert.deepEqual(adDailySeries([], "2026-11-05", "2026-11-01"), []);
  assert.deepEqual(adDailySeries([], "", ""), []);
});

test("ad campaigns: grouped by name inside the window, largest spend first, ACOS null with no sales", () => {
  const c = adCampaigns([
    { date: "2026-11-01", name: "A", spend: 10, sales: 100, orders: 2 },
    { date: "2026-11-02", name: "B", spend: 60, sales: 0, orders: 0 },
    { date: "2026-11-02", name: "A", spend: 15, sales: 25, orders: 1 },
    { date: "2026-11-02", name: " ", spend: 1, sales: 0, orders: 0 },
    { date: "2026-10-01", name: "A", spend: 500, sales: 500, orders: 5 },
  ], "2026-11-01", "2026-11-10");
  assert.deepEqual(c.map((x) => x.name), ["B", "A", "(no campaign name)"]);
  assert.equal(c[0].acos, null);
  assert.equal(c[0].roas, 0);
  assert.deepEqual(c[1], { name: "A", spend: 25, sales: 125, orders: 3, acos: 20, roas: 5 });
});

test("inventory without SellerMate: items come from the uploaded FBA report and stock is its Available", () => {
  const report = [
    { sku: "S1", asin: "A1", product_name: "Widget", your_price: "250", afn_fulfillable_quantity: 12, afn_reserved_quantity: 1, afn_unsellable_quantity: 0, afn_inbound_working_quantity: 0, afn_inbound_shipped_quantity: 2, afn_inbound_receiving_quantity: 0, mfn_fulfillable_quantity: 3, snapshot_date: "2026-10-31" },
    { sku: "S1b", asin: "A1", product_name: "Widget", your_price: "250", afn_fulfillable_quantity: 8, afn_reserved_quantity: 0, afn_unsellable_quantity: 1, afn_inbound_working_quantity: 0, afn_inbound_shipped_quantity: 0, afn_inbound_receiving_quantity: 0, mfn_fulfillable_quantity: 0, snapshot_date: "2026-10-31" },
    { sku: "S2", asin: "A2", product_name: null, your_price: null, afn_fulfillable_quantity: 0, afn_reserved_quantity: 0, afn_unsellable_quantity: 0, afn_inbound_working_quantity: 0, afn_inbound_shipped_quantity: 0, afn_inbound_receiving_quantity: 0, mfn_fulfillable_quantity: null, snapshot_date: "2026-10-31" },
  ];
  const items = itemsFromFbaReport(report);
  assert.deepEqual(items.map((i) => i.asin), ["A1", "A2"]);
  assert.deepEqual({ name: items[0].itemName, price: items[0].price, fbm: items[0].fbm?.quantity }, { name: "Widget", price: 250, fbm: 3 });
  const inv = buildInventory(items, {}, report, []);
  assert.equal(inv.fbaSource, "amazon_report");
  assert.equal(inv.reportAsOf, "2026-10-31");
  const a1 = inv.rows.find((r) => r.asin === "A1")!;
  assert.deepEqual({ fba: a1.fbaAvailable, reserved: a1.fbaReserved, inbound: a1.fbaInbound, fbm: a1.fbmQty, total: a1.totalQty, value: a1.totalValue, ledger: a1.ledgerBalance, note: a1.fbaNote },
    { fba: 20, reserved: 1, inbound: 2, fbm: 3, total: 23, value: 5750, ledger: null, note: null });
  assert.equal(inv.rows.find((r) => r.asin === "A2")!.stockStatus, "Out of Stock");
  assert.equal(inv.rows.length, 2);
  assert.deepEqual(inv.notes, []);
});

test("ad spend change is only comparable when ad data covers both periods in full", async () => {
  const { adSpendCoversBoth } = await import("./adSpendCoverage.ts");
  // the 11 Nov 2026 case: uploads start 30 Sep, previous period starts 7 Sep -> not comparable (was +202%)
  assert.equal(adSpendCoversBoth({ first: "2026-09-30" }, { last: "2026-10-29" }, "2026-09-07", "2026-11-05"), false);
  assert.equal(adSpendCoversBoth({ first: "2026-10-01" }, { last: "2026-10-25" }, "2026-10-01", "2026-10-29"), false); // current period stops early
  assert.equal(adSpendCoversBoth({ first: "2026-10-01" }, { last: "2026-10-28" }, "2026-10-01", "2026-10-28"), true);
  assert.equal(adSpendCoversBoth({ first: null }, { last: "2026-10-28" }, "2026-10-01", "2026-10-28"), false);
});
