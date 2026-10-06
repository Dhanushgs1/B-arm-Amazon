import test from "node:test";
import assert from "node:assert/strict";
import { buildInventory, type FbaReportRow, type SellerMateInventoryItem } from "./inventoryStock.ts";

const rep = (sku: string, asin: string, available: number, extra: Partial<FbaReportRow> = {}): FbaReportRow => ({
  sku, asin, afn_fulfillable_quantity: available, afn_reserved_quantity: 0, afn_unsellable_quantity: 0,
  afn_inbound_working_quantity: 0, afn_inbound_shipped_quantity: 0, afn_inbound_receiving_quantity: 0,
  snapshot_date: "2026-10-06", created_at: "2026-10-06T04:05:54Z", ...extra,
});
const item = (asin: string, ledger: number, fbm = 0): SellerMateInventoryItem => ({ asin, itemName: asin, price: 100, fbm: { quantity: fbm }, fba: { endingWarehouseBalance: ledger } });

test("FBA stock is Amazon Available from the report, not the SellerMate ledger balance", () => {
  // the Sensory Brush case: ledger 1746 (2026-10-04), Amazon Available 1789 (2026-10-06)
  const r = buildInventory([item("B0DDTTPKJ3", 1746)], {}, [rep("B-SENBR-1", "B0DDTTPKJ3", 1789, { afn_reserved_quantity: 13, afn_unsellable_quantity: 1, afn_inbound_working_quantity: 130, afn_inbound_receiving_quantity: 50 })]);
  const row = r.rows[0];
  assert.equal(r.fbaSource, "amazon_report");
  assert.equal(row.fbaAvailable, 1789);
  assert.equal(row.ledgerBalance, 1746); // kept only as a reference column
  assert.equal(row.fbaReserved, 13);
  assert.equal(row.fbaUnfulfillable, 1);
  assert.equal(row.fbaInbound, 180);
  assert.equal(row.totalQty, 1789); // reserved/inbound/unfulfillable are never added in
  assert.equal(r.reportAsOf, "2026-10-06");
});

test("an ASIN with several FBA SKUs sums them; FBM is added to the sellable total", () => {
  const r = buildInventory([item("B0CV7HFZCC", 0, 4)], {}, [rep("NASCOOL-SUCSYS-4", "B0CV7HFZCC", 10), rep("NASCOOL-SUCSYS-6", "B0CV7HFZCC", 15)]);
  assert.equal(r.rows[0].fbaAvailable, 25);
  assert.equal(r.rows[0].totalQty, 29);
});

test("not in Amazon's report = unknown and flagged when the ledger has units, never silently 0", () => {
  const r = buildInventory([item("A", 10), item("B", 13), item("C", 0)], {}, [rep("a-1", "A", 9)]);
  const b = r.rows.find((x) => x.asin === "B")!;
  assert.equal(b.fbaAvailable, null);
  assert.match(b.fbaNote ?? "", /13 unit/);
  assert.equal(r.rows.find((x) => x.asin === "C")!.fbaNote, null);
});

test("report ASINs missing from SellerMate's list are still shown", () => {
  const r = buildInventory([item("A", 5)], {}, [rep("a-1", "A", 5), rep("z-1", "Z", 7)]);
  assert.equal(r.rows.find((x) => x.asin === "Z")!.fbaAvailable, 7);
});

test("another account does not borrow this report; falls back to labelled ledger", () => {
  const r = buildInventory([item("X", 3), item("Y", 4)], {}, [rep("a-1", "A", 9), rep("b-1", "B", 1)]);
  assert.equal(r.fbaSource, "sellermate_ledger");
  assert.equal(r.rows[0].fbaAvailable, 3);
  assert.ok(r.notes.some((n) => /NOT Amazon's "Available"/.test(n)));
});

test("a report older than the SellerMate ledger is called out", () => {
  const ledgerItem: SellerMateInventoryItem = { asin: "A", fba: { endingWarehouseBalance: 5, byLocation: [{ location: "BLR7", endingWarehouseBalance: 5, asOfDate: "2026-10-08T00:00:00" }] } };
  const r = buildInventory([item("A", 5)], {}, [rep("a-1", "A", 5)], [ledgerItem]);
  assert.equal(r.reportOlderThanLedger, true);
  assert.equal(r.ledgerAsOf, "2026-10-08");
});
