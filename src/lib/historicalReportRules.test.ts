import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { readFileSync } from "node:fs";
import {
  isOrdersCardRow, refreshOrderStatuses, ledgerBalancesBySku, snapshotLedgerBalances, carryForwardLedgerBalances, isEmptyUnmappedRow, capReturnsAtOrderedQuantity,
  orderStatusHistoryRows, historyRowAsOrderLine, unresolvedPendingOrderLines, ORDER_STATUS_HISTORY_KEY, UNRESOLVED_SOURCE_DATA,
  type OrderStatusHistoryRow,
} from "./historicalReportRules.ts";

const SRC_POSIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..").replace(/\\/g, "/");
const jiti = createJiti(import.meta.url, { alias: { "@/": `${SRC_POSIX}/` } });

const mis = (id: string, sku: string, status: string, lu: string | null, quantity = 1) => ({
  amazon_order_id: id, sku, order_status: status, item_status: status === "Pending" ? "Unshipped" : "Shipped", quantity,
  raw: lu === null ? {} : { "last-updated-date": lu },
});
const card = (id: string, sku: string, status: string, lu: string, extra: Record<string, unknown> = {}) => ({
  amazon_order_id: id, sku, order_status: status, item_status: status === "Cancelled" ? "Cancelled" : "Shipped",
  raw: { "last-updated-date": lu, ...extra },
});

test("a card row written by the daily combined upload (extra 'IST with Time' / 'Date ' columns) is not an Orders card row", () => {
  assert.equal(isOrdersCardRow({ raw: { "amazon-order-id": "x" } }), true);
  assert.equal(isOrdersCardRow({ raw: { "IST with Time": 46288.1 } }), false);
  assert.equal(isOrdersCardRow({ raw: { "Date ": 46288 } }), false);
});

test("a stale MIS Pending line takes the card's Cancelled status when Amazon's last-updated-date is newer (A016-2, 404-4935164-3119500)", () => {
  const { rows, refreshed } = refreshOrderStatuses(
    [mis("404-4935164-3119500", "A016-2", "Pending", "2026-10-03T04:28:04+00:00")],
    [card("404-4935164-3119500", "A016-2", "Cancelled", "2026-10-11T04:31:26+00:00")],
  );
  assert.equal(rows[0].order_status, "Cancelled");
  assert.equal(rows[0].item_status, "Cancelled");
  assert.equal(rows[0].quantity, 1);
  assert.deepEqual(refreshed.map((r) => [r.sku, r.from, r.to]), [["A016-2", "Pending", "Cancelled"]]);
});

test("a card row that is OLDER than the MIS row never overrides it (B-MENO-CASSETTE-PK3-1: MIS Cancelled is newer than card Pending)", () => {
  const { rows, refreshed } = refreshOrderStatuses(
    [mis("171-7575932-5401959", "B-MENO-CASSETTE-PK3-1", "Cancelled", "2026-10-23T03:33:17+00:00", 0)],
    [card("171-7575932-5401959", "B-MENO-CASSETTE-PK3-1", "Pending - Waiting for Pick Up", "2026-10-22T08:00:00+00:00")],
  );
  assert.equal(rows[0].order_status, "Cancelled");
  assert.equal(refreshed.length, 0);
});

test("rows from the daily combined upload are ignored even when newer", () => {
  const { rows, refreshed } = refreshOrderStatuses(
    [mis("402-3048521-3206756", "B-CT-G-8", "Pending", "2026-09-24T12:41:26+00:00")],
    [card("402-3048521-3206756", "B-CT-G-8", "Cancelled", "2026-09-25T13:42:49+00:00", { "IST with Time": 46289.7 })],
  );
  assert.equal(rows[0].order_status, "Pending");
  assert.equal(refreshed.length, 0);
});

test("no evidence, no change: a MIS row without a readable last-updated-date, or with no matching card line, keeps its status", () => {
  const { rows, refreshed } = refreshOrderStatuses(
    [mis("A", "S1", "Pending", null), mis("B", "S2", "Pending", "2026-10-01T00:00:00+00:00")],
    [card("A", "S1", "Cancelled", "2026-10-20T00:00:00+00:00"), card("C", "S2", "Cancelled", "2026-10-20T00:00:00+00:00")],
  );
  assert.deepEqual(rows.map((r) => r.order_status), ["Pending", "Pending"]);
  assert.equal(refreshed.length, 0);
});

test("with no Orders card rows at all (card fetch failed) every synced line is returned unchanged", () => {
  const input = [mis("404-4935164-3119500", "A016-2", "Pending", "2026-10-03T04:28:04+00:00")];
  const { rows, refreshed } = refreshOrderStatuses(input, []);
  assert.deepEqual(rows, input);
  assert.equal(refreshed.length, 0);
});

test("matching is by order AND SKU, the latest card row wins, and lines are never added or removed", () => {
  const { rows, refreshed } = refreshOrderStatuses(
    [mis("O1", "S1", "Pending", "2026-10-01T00:00:00+00:00", 2), mis("O1", "S2", "Pending", "2026-10-01T00:00:00+00:00")],
    [
      card("O1", "S1", "Shipped", "2026-10-05T00:00:00+00:00"),
      card("O1", "S1", "Cancelled", "2026-10-09T00:00:00+00:00"),
      card("O9", "S9", "Shipped", "2026-10-09T00:00:00+00:00"),
    ],
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.sku, r.order_status, r.quantity]), [["S1", "Cancelled", 2], ["S2", "Pending", 1]]);
  assert.equal(refreshed.length, 1);
});

test("Pending -> Shipped is applied but changes no count (only cancellations change Orders)", () => {
  const { rows, refreshed } = refreshOrderStatuses(
    [mis("405-6710242-2259544", "A003-9", "Pending", "2026-09-24T00:00:00+00:00")],
    [card("405-6710242-2259544", "A003-9", "Shipped", "2026-09-30T00:00:00+00:00")],
  );
  assert.equal(rows[0].order_status, "Shipped");
  assert.equal(refreshed.length, 1);
});

test("two return requests on one 2-unit order line count 2, not 3 (B-INSEM-KIT-PK5-3, 406-8999386-7559512)", () => {
  const { bySku, capped } = capReturnsAtOrderedQuantity([
    { orderId: "406-8999386-7559512", sku: "B-INSEM-KIT-PK5-3", qty: 2, orderedQty: 2 },
    { orderId: "406-8999386-7559512", sku: "B-INSEM-KIT-PK5-3", qty: 1, orderedQty: 2 },
    { orderId: "404-1775342-8252365", sku: "B-INSEM-KIT-PK5-3", qty: 1, orderedQty: 1 },
  ], new Map());
  assert.equal(bySku.get("B-INSEM-KIT-PK5-3"), 3);
  assert.deepEqual(capped, [{ orderId: "406-8999386-7559512", sku: "B-INSEM-KIT-PK5-3", returned: 3, ordered: 2 }]);
});

test("AM + FBA + SellerFlex are still added together; the cap only bites per order line", () => {
  const ordered = new Map([["O-FBA|S1", 1], ["O-SF|S1", 2]]);
  const { bySku, capped } = capReturnsAtOrderedQuantity([
    { orderId: "O-AM", sku: "S1", qty: 1, orderedQty: 1 },
    { orderId: "O-FBA", sku: "S1", qty: 1 },
    { orderId: "O-SF", sku: "S1", qty: 2 },
  ], ordered);
  assert.equal(bySku.get("S1"), 4);
  assert.equal(capped.length, 0);
});

test("an FBA/SellerFlex return over the ordered quantity from the orders data is capped", () => {
  const { bySku, capped } = capReturnsAtOrderedQuantity([
    { orderId: "O1", sku: "S1", qty: 1 },
    { orderId: "O1", sku: "S1", qty: 1 },
  ], new Map([["O1|S1", 1]]));
  assert.equal(bySku.get("S1"), 1);
  assert.equal(capped.length, 1);
});

test("no ordered quantity known (or no order id) means no cap — nothing is invented", () => {
  const { bySku, capped } = capReturnsAtOrderedQuantity([
    { orderId: "O-OLD", sku: "S1", qty: 3 },
    { orderId: "O-AM", sku: "S1", qty: 2, orderedQty: 0 },
    { orderId: "", sku: "S1", qty: 1 },
    { orderId: "", sku: "S1", qty: 1 },
  ], new Map());
  assert.equal(bySku.get("S1"), 7);
  assert.equal(capped.length, 0);
});

test("ledger balances are grouped by state AND by FC area in one pass; a zero balance is still registered", () => {
  const toState = (fc: string) => ({ BLR8: "KARNATAKA", HYD3: "TELANGANA", PAX1: "BIHAR" } as Record<string, string>)[fc];
  const toArea = (fc: string) => ({ BLR8: "BANGALORE", HYD3: "HYDERABAD", PAX1: "PATNA" } as Record<string, string>)[fc];
  const { bySku, states, areas } = ledgerBalancesBySku([
    { msku: "A001-5", location: "BLR8", ending_balance: 24 },
    { msku: "A001-5", location: "HYD3", ending_balance: 0 },
    { msku: "A001-5", location: "PAX1", ending_balance: 5 },
  ], toState, toArea);
  const s = bySku.get("A001-5")!;
  assert.equal(s.fbaTotal, 29);
  assert.deepEqual([...s.areaBalances], [["BANGALORE", 24], ["HYDERABAD", 0], ["PATNA", 5]]);
  assert.deepEqual([...s.stateBalances], [["KARNATAKA", 24], ["TELANGANA", 0], ["BIHAR", 5]]);
  assert.deepEqual([...areas].sort(), ["BANGALORE", "HYDERABAD", "PATNA"]);
  assert.deepEqual([...states].sort(), ["BIHAR", "KARNATAKA", "TELANGANA"]);
});

test("FC area map matches the seller's pivot labels, including PAX1 -> PATNA; the state map is unchanged", async () => {
  const { fcToAreaManual, fcToState } = await jiti.import<typeof import("./analysisReportExport.ts")>(`${SRC_POSIX}/lib/analysisReportExport.ts`);
  assert.equal(fcToAreaManual("PAX1"), "PATNA");
  assert.equal(fcToAreaManual("BLR8"), "BANGALORE");
  assert.equal(fcToAreaManual("HYD3"), "HYDERABAD");
  assert.equal(fcToAreaManual("JPX2"), "JAIPUR");
  assert.equal(fcToAreaManual("LKO1"), "LUCKNOW");
  assert.equal(fcToAreaManual("AMD2"), "AHMEDABAD");
  assert.equal(fcToAreaManual("DEL4"), "DELHI");
  assert.equal(fcToAreaManual("ZZZ9"), "UNKNOWN");
  assert.equal(fcToState("PAX1"), "BIHAR");
  assert.equal(fcToState("BLR8"), "KARNATAKA");
});

// ── Order-status history ────────────────────────────────────────────────────
const upload = (id: string, sku: string, status: string, lu: string | null, quantity = 1) => ({
  amazon_order_id: id, sku, order_status: status, item_status: status === "Cancelled" ? "Cancelled" : "Unshipped", quantity, purchase_date: "2026-10-03",
  raw: lu === null ? {} : { "last-updated-date": lu },
});
const historyKey = (r: OrderStatusHistoryRow) => ORDER_STATUS_HISTORY_KEY.split(",").map((k) => String(r[k as keyof OrderStatusHistoryRow])).join("|");

test("status precedence: the history status with the newest Amazon last-updated-date wins; an older one never overrides", () => {
  const history = [
    { amazon_order_id: "O1", sku: "S1", order_status: "Shipped", item_status: "Shipped", last_updated_at: "2026-10-05T00:00:00.000Z" },
    { amazon_order_id: "O1", sku: "S1", order_status: "Cancelled", item_status: "Cancelled", last_updated_at: "2026-10-11T04:31:26.000Z" },
    { amazon_order_id: "O2", sku: "S2", order_status: "Pending", item_status: "Unshipped", last_updated_at: "2026-09-01T00:00:00.000Z" },
  ].map(historyRowAsOrderLine);
  const { rows } = refreshOrderStatuses(
    [mis("O1", "S1", "Pending", "2026-10-03T04:28:04+00:00"), mis("O2", "S2", "Shipped", "2026-10-02T00:00:00+00:00")],
    history,
  );
  assert.deepEqual(rows.map((r) => r.order_status), ["Cancelled", "Shipped"]);
});

test("status precedence: an equal last-updated-date is not newer, so the synced status stands", () => {
  const { rows, refreshed } = refreshOrderStatuses(
    [mis("O1", "S1", "Pending", "2026-10-03T04:28:04+00:00")],
    [historyRowAsOrderLine({ amazon_order_id: "O1", sku: "S1", order_status: "Cancelled", last_updated_at: "2026-10-03T04:28:04.000Z" })],
  );
  assert.equal(rows[0].order_status, "Pending");
  assert.equal(refreshed.length, 0);
});

test("history preservation: after a later upload pruned the card rows, the stored history still refreshes the status", () => {
  const stored = orderStatusHistoryRows([upload("404-4935164-3119500", "A016-2", "Cancelled", "2026-10-11T04:31:26+00:00")], "orders_16Sep-15Oct.txt");
  // the Orders card rows for this range are gone — only the stored history is passed in
  const { rows, refreshed } = refreshOrderStatuses([mis("404-4935164-3119500", "A016-2", "Pending", "2026-10-03T04:28:04+00:00")], stored.map(historyRowAsOrderLine));
  assert.equal(rows[0].order_status, "Cancelled");
  assert.equal(rows[0].quantity, 1);
  assert.equal(rows.length, 1);
  assert.equal(refreshed.length, 1);
});

test("repeat uploads: the same file twice gives identical history keys, and duplicates within a file collapse", () => {
  const file = [
    upload("O1", "S1", "Pending", "2026-10-01T10:00:00+00:00"),
    upload("O1", "S1", "Pending", "2026-10-01T10:00:00+00:00"),
    upload("O2", "S2", "Shipped", "2026-10-02T10:00:00+00:00", 2),
  ];
  const first = orderStatusHistoryRows(file, "f.txt");
  const second = orderStatusHistoryRows(file, "f.txt");
  assert.equal(first.length, 2);
  assert.deepEqual(first.map(historyKey), second.map(historyKey));
  // a later file with a NEW status for O1 adds a row; the earlier status stays on record
  const later = orderStatusHistoryRows([upload("O1", "S1", "Cancelled", "2026-10-09T10:00:00+00:00")], "g.txt");
  assert.equal(new Set([...first, ...later].map(historyKey)).size, 3);
});

test("repeat uploads: rows without a status or a readable last-updated-date are not stored; quantities are kept as reported", () => {
  const rows = orderStatusHistoryRows([
    upload("O1", "S1", "Pending", null),
    upload("O2", "S2", "", "2026-10-01T00:00:00+00:00"),
    upload("O3", "S3", "Shipped", "not a date"),
    upload("O4", "S4", "Shipped", "2026-10-01T00:00:00+00:00", 3),
  ], null);
  assert.deepEqual(rows.map((r) => [r.amazon_order_id, r.quantity, r.last_updated_at]), [["O4", 3, "2026-10-01T00:00:00.000Z"]]);
});

test("the history upsert key matches the unique constraint in the migration file", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/20261027120000_barm_amazon_order_status_history.sql", import.meta.url), "utf8");
  const m = sql.match(/unique \(([^)]+)\)/);
  assert.ok(m);
  assert.equal(m![1].replace(/\s/g, ""), ORDER_STATUS_HISTORY_KEY);
});

test("UNRESOLVED_SOURCE_DATA: counted lines still Pending 7+ days before the end are flagged; nothing is changed", () => {
  const rows = [
    { ...mis("407-5482406-5557937", "A003-9", "Pending", "2026-10-15T00:00:00+00:00"), day: "2026-10-15" },
    { ...mis("R1", "A003-9", "Pending", "2026-10-20T00:00:00+00:00"), day: "2026-10-20" },
    { ...mis("C1", "A003-9", "Cancelled", "2026-10-02T00:00:00+00:00", 0), day: "2026-10-01" },
    { ...mis("S1", "A003-9", "Shipped", "2026-10-02T00:00:00+00:00"), day: "2026-10-01" },
    { ...mis("W1", "SC50-1", "Pending - Waiting for Pick Up", "2026-10-12T00:00:00+00:00"), day: "2026-10-11" },
  ];
  const before = JSON.stringify(rows);
  const flagged = unresolvedPendingOrderLines(rows, "2026-10-22", (r) => r.day, (r) => !/^cancel/i.test(r.order_status));
  assert.deepEqual(flagged.map((l) => [l.flag, l.amazon_order_id, l.quantity]), [[UNRESOLVED_SOURCE_DATA, "407-5482406-5557937", 1], [UNRESOLVED_SOURCE_DATA, "W1", 1]]);
  assert.equal(JSON.stringify(rows), before);
});

test("snapshotLedgerBalances reads only the chosen snapshot date (historical balance)", () => {
  const rows = [
    { ledger_date: "2026-10-20", msku: "A", location: "BLR7", fnsku: "X1", ending_balance: 9 },
    { ledger_date: "2026-10-21", msku: "A", location: "BLR7", fnsku: "X1", ending_balance: 4 },
    { ledger_date: "2026-10-21", msku: "B", location: "DEL2", fnsku: "X2", ending_balance: 6 },
  ];
  assert.deepEqual(
    snapshotLedgerBalances(rows, "2026-10-21").map((r) => [r.msku, r.location, r.ending_balance]),
    [["A", "BLR7", 4], ["B", "DEL2", 6]],
  );
  assert.deepEqual(snapshotLedgerBalances(rows, null), []);
});

test("snapshotLedgerBalances does not carry a location forward from an older snapshot (missing location is zero)", () => {
  const rows = [
    { ledger_date: "2026-10-05", msku: "A", location: "CCX2", fnsku: "X1", ending_balance: 7 },
    { ledger_date: "2026-10-21", msku: "A", location: "BLR7", fnsku: "X1", ending_balance: 2 },
  ];
  const out = snapshotLedgerBalances(rows, "2026-10-21");
  assert.deepEqual(out.map((r) => [r.location, r.ending_balance]), [["BLR7", 2]]);
  const bySku = ledgerBalancesBySku(out, (fc) => fc, (fc) => fc).bySku.get("A");
  assert.equal(bySku?.fbaTotal, 2);
  assert.equal(bySku?.areaBalances.has("CCX2"), false);
});

test("snapshotLedgerBalances sums distinct FNSKUs at one MSKU and location, and counts an identical line once", () => {
  const rows = [
    { ledger_date: "2026-10-21", msku: "A015", location: "AMD2", fnsku: "X0021Q1AHV", ending_balance: 8 },
    { ledger_date: "2026-10-21", msku: "A015", location: "AMD2", fnsku: "X0021OTHER", ending_balance: 3 },
    { ledger_date: "2026-10-21", msku: "A015", location: "AMD2", fnsku: "X0021Q1AHV", ending_balance: 8 },
  ];
  const out = snapshotLedgerBalances(rows, "2026-10-21");
  assert.equal(out.length, 1);
  assert.equal(out[0].ending_balance, 11);
});

test("snapshotLedgerBalances ignores rows with no MSKU", () => {
  const rows = [{ ledger_date: "2026-10-21", msku: "", location: "BLR7", fnsku: "X1", ending_balance: 5 }];
  assert.deepEqual(snapshotLedgerBalances(rows, "2026-10-21"), []);
});

test("isEmptyUnmappedRow drops only zero-spend unmapped buckets", () => {
  assert.equal(isEmptyUnmappedRow(true, 0, 0), true);
  assert.equal(isEmptyUnmappedRow(true, 0, 12.5), false);
  assert.equal(isEmptyUnmappedRow(true, 3, 0), false);
  assert.equal(isEmptyUnmappedRow(false, 0, 0), false);
});

test("a mapped campaign row with the ₹4.34 spend is never treated as an unmapped placeholder", () => {
  assert.equal(isEmptyUnmappedRow(false, 4.3424, 4.3424), false);
});

test("carryForwardLedgerBalances keeps a location's last reported balance from an older snapshot (original rule)", () => {
  const rows = [
    { ledger_date: "2026-10-05", msku: "A", location: "CCX2", fnsku: "X1", ending_balance: 0 },
    { ledger_date: "2026-10-21", msku: "A", location: "BLR7", fnsku: "X1", ending_balance: 2 },
  ];
  const out = carryForwardLedgerBalances(rows, "2026-10-21");
  assert.deepEqual(out.map((r) => [r.location, r.ending_balance]).sort(), [["BLR7", 2], ["CCX2", 0]]);
});

test("carryForwardLedgerBalances uses only asOf rows when nothing is dated on or before asOf", () => {
  const rows = [
    { ledger_date: "2026-10-25", msku: "A", location: "BLR7", fnsku: "X1", ending_balance: 3 },
    { ledger_date: "2026-10-26", msku: "A", location: "DEL2", fnsku: "X2", ending_balance: 9 },
  ];
  assert.deepEqual(carryForwardLedgerBalances(rows, "2026-10-25").map((r) => r.location), ["BLR7"]);
});

test("the two ledger modes differ only where a location is missing from the newest snapshot", () => {
  const rows = [
    { ledger_date: "2026-10-05", msku: "A", location: "CCX2", fnsku: "X1", ending_balance: 0 },
    { ledger_date: "2026-10-21", msku: "A", location: "BLR7", fnsku: "X1", ending_balance: 2 },
    { ledger_date: "2026-10-21", msku: "B", location: "BLR7", fnsku: "X3", ending_balance: 1 },
  ];
  const snap = snapshotLedgerBalances(rows, "2026-10-21").map((r) => `${r.msku}|${r.location}`).sort();
  const carry = carryForwardLedgerBalances(rows, "2026-10-21").map((r) => `${r.msku}|${r.location}`).sort();
  assert.deepEqual(snap, ["A|BLR7", "B|BLR7"]);
  assert.deepEqual(carry, ["A|BLR7", "A|CCX2", "B|BLR7"]);
});
