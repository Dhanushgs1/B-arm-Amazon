import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyStatus,
  parseMonthSheetName,
  detectMonthSheets,
  parseMonthSheetGrid,
  dedupeByIdentityKey,
  fbfIdentityKey,
  cleanDailySalesRow,
  cleanStockSnapshotRow,
  isWithinTrailingWindow,
  selectStockSnapshotDate,
  parseUsSlashDate,
  parseManualPlanGrid,
} from "./fbaForecastRules.ts";

// ── classifyStatus ───────────────────────────────────────────────────────

test("classifyStatus maps the three routed statuses, case/whitespace-insensitively", () => {
  assert.equal(classifyStatus("Booked"), "booked");
  assert.equal(classifyStatus(" picked up "), "picked_up");
  assert.equal(classifyStatus("ACTIVE"), "active");
  assert.equal(classifyStatus("  BOOKED  "), "booked");
  assert.equal(classifyStatus("Picked Up"), "picked_up");
});

test("classifyStatus excludes anything else", () => {
  assert.equal(classifyStatus("cancelled before 24hrs of pickup"), null);
  assert.equal(classifyStatus("Didn't send to FBA"), null);
  assert.equal(classifyStatus(""), null);
  assert.equal(classifyStatus("pickedup"), null); // no space is not a match
});

// ── parseMonthSheetName / detectMonthSheets ─────────────────────────────

test("parseMonthSheetName reads a 2-digit-year sheet name, both long and short month spellings", () => {
  assert.deepEqual(parseMonthSheetName("FBA SEPT26"), { year: 2026, month: 9 });
  assert.deepEqual(parseMonthSheetName("FBA JUL26"), { year: 2026, month: 7 });
  assert.deepEqual(parseMonthSheetName("FBA JUNE26"), { year: 2026, month: 6 });
  assert.deepEqual(parseMonthSheetName("FBA JULY26"), { year: 2026, month: 7 });
  assert.deepEqual(parseMonthSheetName("FBA APRIL26"), { year: 2026, month: 4 });
  assert.deepEqual(parseMonthSheetName("fba may26"), { year: 2026, month: 5 });
});

test("parseMonthSheetName returns null for a sheet name with no year suffix or unrecognized month", () => {
  assert.equal(parseMonthSheetName("FBA JULY"), null);
  assert.equal(parseMonthSheetName("FBA SKU IDs"), null);
  assert.equal(parseMonthSheetName("Pivot Table 1"), null);
  assert.equal(parseMonthSheetName("FBA ZZZ26"), null);
});

test("detectMonthSheets picks the current month plus the previous 2, ignoring non-month sheets", () => {
  const sheetNames = ["FBA SKU IDs", "FBA MAY26", "FBA JUN26", "FBA JUL26", "FBA AUG26", "FBA SEPT26", "Pivot Table 1"];
  const asOf = new Date("2026-09-22T00:00:00Z");
  const result = detectMonthSheets(sheetNames, asOf);
  assert.deepEqual(result.map((r) => r.sourceMonth), ["2026-09", "2026-08", "2026-07"]);
});

test("detectMonthSheets excludes sheets dated after asOf", () => {
  const sheetNames = ["FBA AUG26", "FBA SEPT26", "FBA OCT26"];
  const asOf = new Date("2026-09-22T00:00:00Z");
  const result = detectMonthSheets(sheetNames, asOf);
  assert.deepEqual(result.map((r) => r.sourceMonth), ["2026-09", "2026-08"]);
});

test("detectMonthSheets returns fewer than 3 when history is short, rather than erroring", () => {
  const sheetNames = ["FBA SEPT26"];
  const result = detectMonthSheets(sheetNames, new Date("2026-09-22T00:00:00Z"));
  assert.deepEqual(result.map((r) => r.sourceMonth), ["2026-09"]);
});

test("detectMonthSheets shifts the selected 3 months as the report date (asOf) moves — the whole point of threading the dashboard's selected date through", () => {
  const sheetNames = ["FBA JUN26", "FBA JUL26", "FBA AUG26", "FBA SEPT26"];
  const sep22 = detectMonthSheets(sheetNames, new Date("2026-09-22T00:00:00Z"));
  assert.deepEqual(sep22.map((r) => r.sourceMonth), ["2026-09", "2026-08", "2026-07"]);

  const aug15 = detectMonthSheets(sheetNames, new Date("2026-08-15T00:00:00Z"));
  assert.deepEqual(aug15.map((r) => r.sourceMonth), ["2026-08", "2026-07", "2026-06"]);
});

// ── parseMonthSheetGrid ──────────────────────────────────────────────────

test("parseMonthSheetGrid locates columns by header name and takes only the first STATUS column", () => {
  const grid = [
    ["Product", "SKU ID", "Initial booked quantity", "Final shipped quantity", "FC", "Booked date", "Pickup Date", "ATS/NON-ATS", "MRP", "FNSKU IDS", "BOX", "ASIN", "STATUS", "COMMENTS", "STATUS", "FBA Tracking Number"],
    ["Widget", "SKU-1", 10, 8, "BLR", "01/09/2026", "", "ATS", 199, "X1", "B1", "A1", "Booked", "", "FBA STA (01/09/2026 06:16)-LKO1", "TRK1"],
  ];
  const rows = parseMonthSheetGrid(grid);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sku, "SKU-1");
  assert.equal(rows[0].quantity, 8);
  assert.equal(rows[0].fc, "BLR");
  assert.equal(rows[0].statusRaw, "Booked"); // not the tracking-blob second STATUS column
  assert.equal(rows[0].bookedDate, "2026-09-01"); // DD/MM/YYYY -> ISO
  assert.equal(rows[0].pickupDate, ""); // blank cell stays blank, not "Invalid Date"
});

test("parseMonthSheetGrid reads the active date from the second STATUS column", () => {
  const grid = [
    ["Product", "SKU ID", "Initial booked quantity", "Final shipped quantity", "FC", "Booked date", "Pickup Date", "MRP", "FNSKU IDS", "BOX", "ASIN", "STATUS", "COMMENTS", "STATUS", "FBA Tracking Number"],
    ["Mucus removal device", "B-MRD-WT-2", 5, 5, "HYD3", "08.08.2026", "29.08.2026", 2999, "X1", "", "A1", "active", "", "08.09.2026", ""],
    ["Widget", "SKU-9", 5, 5, "HYD3", "08.08.2026", "29.08.2026", 2999, "X1", "", "A1", "active", "", 46291, ""], // Excel serial = 2026-09-26
    ["Widget", "SKU-8", 5, 5, "HYD3", "08.08.2026", "", 2999, "X1", "", "A1", "Booked", "", "FBA STA (01/09/2026 06:16)-LKO1", ""],
  ];
  const rows = parseMonthSheetGrid(grid);
  assert.equal(rows[0].statusRaw, "active");
  assert.equal(rows[0].activeDate, "2026-09-08");
  assert.equal(rows[1].activeDate, "2026-09-26");
  assert.equal(rows[2].activeDate, ""); // non-date text never becomes a date
  // A sheet with only one STATUS column has no active date.
  const single = parseMonthSheetGrid([
    ["Product", "SKU ID", "Final shipped quantity", "FC", "Booked date", "Pickup Date", "STATUS"],
    ["Widget", "SKU-1", 1, "BLR", "", "", "active"],
  ]);
  assert.equal(single[0].activeDate, "");
});

test("parseMonthSheetGrid throws when a required column is missing", () => {
  const grid = [["Product", "SKU ID"], ["Widget", "SKU-1"]];
  assert.throws(() => parseMonthSheetGrid(grid));
});

test("parseMonthSheetGrid handles the ATS/NON-ATS column-shift case (columns after it still resolve by name)", () => {
  const withAts = [
    ["Product", "SKU ID", "Final shipped quantity", "ATS/NON-ATS", "FC", "Booked date", "Pickup Date", "STATUS", "STATUS"],
    ["Widget", "SKU-2", 5, "NON-ATS", "HYD3", "", "02/09/2026", "Picked Up", "blob"],
  ];
  const withoutAts = [
    ["Product", "SKU ID", "Final shipped quantity", "FC", "Booked date", "Pickup Date", "STATUS", "STATUS"],
    ["Widget", "SKU-3", 6, "HYD3", "", "02/09/2026", "Picked Up", "blob"],
  ];
  const a = parseMonthSheetGrid(withAts)[0];
  const b = parseMonthSheetGrid(withoutAts)[0];
  assert.equal(a.fc, "HYD3");
  assert.equal(a.statusRaw, "Picked Up");
  assert.equal(b.fc, "HYD3");
  assert.equal(b.statusRaw, "Picked Up");
});

test("parseMonthSheetGrid returns an empty array for an empty grid", () => {
  assert.deepEqual(parseMonthSheetGrid([]), []);
});

// Real bug, confirmed against the actual "FBA & FBF Details-Updated" file:
// its Booked date/Pickup Date columns use dot-separated "DD.MM.YYYY" (e.g.
// "05.08.2026"), which the slash/dash-only regex didn't match at all — it
// silently returned "" for every single row. Since these dates feed
// fbfIdentityKey, that collapsed the date component of the key to a
// constant empty value for the whole file, causing 28 genuinely distinct
// Active shipments (different real booked/pickup dates, same sku+fc+qty)
// and 1 Intransit shipment to be wrongly deduped away as "duplicates".
test("parseMonthSheetGrid parses dot-separated DD.MM.YYYY dates (the real workbook's actual format)", () => {
  const grid = [
    ["Product", "SKU ID", "Final shipped quantity", "FC", "Booked date", "Pickup Date", "STATUS"],
    ["Widget", "SKU-4", 3, "JPX2", "05.08.2026", "07.08.2026", "Active"],
  ];
  const row = parseMonthSheetGrid(grid)[0];
  assert.equal(row.bookedDate, "2026-08-05");
  assert.equal(row.pickupDate, "2026-08-07");
});

test("dedupeByIdentityKey does not collapse two real shipments sharing sku+fc+quantity but with different dot-formatted dates", () => {
  const augRow = parseMonthSheetGrid([
    ["Product", "SKU ID", "Final shipped quantity", "FC", "Booked date", "Pickup Date", "STATUS"],
    ["Widget", "B-MENO-STRIPS-PK4-1", 3, "JPX2", "05.08.2026", "07.08.2026", "Active"],
  ])[0];
  const julRow = parseMonthSheetGrid([
    ["Product", "SKU ID", "Final shipped quantity", "FC", "Booked date", "Pickup Date", "STATUS"],
    ["Widget", "B-MENO-STRIPS-PK4-1", 3, "JPX2", "10.07.2026", "14.07.2026", "Active"],
  ])[0];
  const out = dedupeByIdentityKey([augRow, julRow], fbfIdentityKey);
  assert.equal(out.length, 2); // two distinct shipments, not one
});

// ── dedupeByIdentityKey / fbfIdentityKey ─────────────────────────────────

test("dedupeByIdentityKey collapses only rows whose full key matches, keeping the first", () => {
  const rows = [
    { sku: "A", fc: "BLR", quantity: 5, bookedDate: "2026-09-01", pickupDate: "" },
    { sku: "A", fc: "BLR", quantity: 5, bookedDate: "2026-09-01", pickupDate: "" }, // re-listed in next month's sheet
    { sku: "A", fc: "BLR", quantity: 5, bookedDate: "2026-09-05", pickupDate: "" }, // different booked_date -> distinct
  ];
  const out = dedupeByIdentityKey(rows, fbfIdentityKey);
  assert.equal(out.length, 2);
});

test("dedupeByIdentityKey leaves rows with distinct sku/fc/quantity alone", () => {
  const rows = [
    { sku: "A", fc: "BLR", quantity: 5, bookedDate: "", pickupDate: "" },
    { sku: "B", fc: "BLR", quantity: 5, bookedDate: "", pickupDate: "" },
    { sku: "A", fc: "HYD3", quantity: 5, bookedDate: "", pickupDate: "" },
    { sku: "A", fc: "BLR", quantity: 6, bookedDate: "", pickupDate: "" },
  ];
  const out = dedupeByIdentityKey(rows, fbfIdentityKey);
  assert.equal(out.length, 4);
});

test("dedupeByIdentityKey's accepted limitation: two distinct shipments with identical sku+fc+quantity and both dates blank do collapse", () => {
  const rows = [
    { sku: "A", fc: "BLR", quantity: 5, bookedDate: "", pickupDate: "" },
    { sku: "A", fc: "BLR", quantity: 5, bookedDate: "", pickupDate: "" },
  ];
  const out = dedupeByIdentityKey(rows, fbfIdentityKey);
  assert.equal(out.length, 1); // documented tradeoff, not a bug
});

test("dedupeByIdentityKey is case/whitespace-normalized for sku and fc", () => {
  const rows = [
    { sku: " a ", fc: "blr", quantity: 5, bookedDate: "", pickupDate: "" },
    { sku: "A", fc: "BLR", quantity: 5, bookedDate: "", pickupDate: "" },
  ];
  const out = dedupeByIdentityKey(rows, fbfIdentityKey);
  assert.equal(out.length, 1);
});

// ── isWithinTrailingWindow ────────────────────────────────────────────────

test("isWithinTrailingWindow includes the report date itself and the day exactly (days-1) before it", () => {
  assert.equal(isWithinTrailingWindow("2026-09-22", "2026-09-22", 30), true);
  assert.equal(isWithinTrailingWindow("2026-08-24", "2026-09-22", 30), true); // 29 days before -> in window
});

test("isWithinTrailingWindow excludes a date one day before the window starts, and any date after reportDate", () => {
  assert.equal(isWithinTrailingWindow("2026-08-23", "2026-09-22", 30), false); // 30 days before -> just outside
  assert.equal(isWithinTrailingWindow("2026-09-23", "2026-09-22", 30), false); // after reportDate
});

test("isWithinTrailingWindow returns false for blank input", () => {
  assert.equal(isWithinTrailingWindow("", "2026-09-22", 30), false);
  assert.equal(isWithinTrailingWindow("2026-09-10", "", 30), false);
});

// ── cleanDailySalesRow ───────────────────────────────────────────────────

test("cleanDailySalesRow keeps a normal row within the trailing 30-day window", () => {
  const result = cleanDailySalesRow(
    { amazonOrderId: "112-1234567-1234567", purchaseDate: "2026-09-10", orderStatus: "Shipped", fulfillmentChannel: "Amazon" },
    "2026-09-22"
  );
  assert.deepEqual(result, { keep: true });
});

test("cleanDailySalesRow drops an amazon-order-id starting with S", () => {
  const result = cleanDailySalesRow(
    { amazonOrderId: "S02-1234567-1234567", purchaseDate: "2026-09-10", orderStatus: "Shipped", fulfillmentChannel: "Amazon" },
    "2026-09-22"
  );
  assert.equal(result.keep, false);
  assert.equal(result.reason, "s_prefix_order");
});

test("cleanDailySalesRow drops a row dated exactly the report date (not the server's real today)", () => {
  const result = cleanDailySalesRow(
    { amazonOrderId: "112-1234567-1234567", purchaseDate: "2026-09-22", orderStatus: "Shipped", fulfillmentChannel: "Amazon" },
    "2026-09-22"
  );
  assert.equal(result.keep, false);
  assert.equal(result.reason, "today_order");

  // Same rule anchored on a DIFFERENT selected report date — proves this
  // isn't hardcoded to the server's real "today".
  const otherDate = cleanDailySalesRow(
    { amazonOrderId: "112-1234567-1234567", purchaseDate: "2026-08-15", orderStatus: "Shipped", fulfillmentChannel: "Amazon" },
    "2026-08-15"
  );
  assert.equal(otherDate.keep, false);
  assert.equal(otherDate.reason, "today_order");
});

test("cleanDailySalesRow drops a row outside the trailing 30-day window ending at reportDate", () => {
  const result = cleanDailySalesRow(
    { amazonOrderId: "112-1234567-1234567", purchaseDate: "2026-07-01", orderStatus: "Shipped", fulfillmentChannel: "Amazon" },
    "2026-09-22"
  );
  assert.equal(result.keep, false);
  assert.equal(result.reason, "outside_window");
});

test("cleanDailySalesRow drops order-status === 'Cancelled' case-sensitively", () => {
  const cancelled = cleanDailySalesRow(
    { amazonOrderId: "112-1234567-1234567", purchaseDate: "2026-09-10", orderStatus: "Cancelled", fulfillmentChannel: "Amazon" },
    "2026-09-22"
  );
  assert.equal(cancelled.keep, false);
  assert.equal(cancelled.reason, "cancelled");

  // Different case is NOT matched, per the literal case-sensitive rule.
  const differentCase = cleanDailySalesRow(
    { amazonOrderId: "112-1234567-1234567", purchaseDate: "2026-09-10", orderStatus: "CANCELLED", fulfillmentChannel: "Amazon" },
    "2026-09-22"
  );
  assert.equal(differentCase.keep, true);
});

test("cleanDailySalesRow drops fulfillment-channel === 'Merchant'", () => {
  const result = cleanDailySalesRow(
    { amazonOrderId: "112-1234567-1234567", purchaseDate: "2026-09-10", orderStatus: "Shipped", fulfillmentChannel: "Merchant" },
    "2026-09-22"
  );
  assert.equal(result.keep, false);
  assert.equal(result.reason, "merchant");
});

// ── cleanStockSnapshotRow / selectStockSnapshotDate ─────────────────────

test("cleanStockSnapshotRow keeps the anchor-date, non-VSNC, SELLABLE row", () => {
  const result = cleanStockSnapshotRow({ reportDate: "2026-09-22", fulfillmentCenter: "BLR", disposition: "SELLABLE" }, "2026-09-22");
  assert.deepEqual(result, { keep: true });
});

test("cleanStockSnapshotRow drops a row not on the anchor date", () => {
  const result = cleanStockSnapshotRow({ reportDate: "2026-09-20", fulfillmentCenter: "BLR", disposition: "SELLABLE" }, "2026-09-22");
  assert.equal(result.keep, false);
  assert.equal(result.reason, "older_stock_date");
});

test("cleanStockSnapshotRow drops Fulfillment Center === 'VSNC'", () => {
  const result = cleanStockSnapshotRow({ reportDate: "2026-09-22", fulfillmentCenter: "VSNC", disposition: "SELLABLE" }, "2026-09-22");
  assert.equal(result.keep, false);
  assert.equal(result.reason, "vsnc");
});

test("cleanStockSnapshotRow drops any Disposition other than SELLABLE", () => {
  const result = cleanStockSnapshotRow({ reportDate: "2026-09-22", fulfillmentCenter: "BLR", disposition: "UNSELLABLE" }, "2026-09-22");
  assert.equal(result.keep, false);
  assert.equal(result.reason, "non_sellable");
});

test("cleanStockSnapshotRow checks the anchor date before VSNC/disposition", () => {
  // An older-date row that would ALSO fail VSNC/disposition should still be
  // tagged with the date reason, since the date check runs first.
  const result = cleanStockSnapshotRow({ reportDate: "2026-09-20", fulfillmentCenter: "VSNC", disposition: "UNSELLABLE" }, "2026-09-22");
  assert.equal(result.reason, "older_stock_date");
});

test("selectStockSnapshotDate picks the latest date that is <= reportDate, not blindly the max date in the file", () => {
  const dates = ["2026-09-18", "2026-09-20", "2026-09-25"]; // 09-25 is AFTER the report date
  assert.equal(selectStockSnapshotDate(dates, "2026-09-22"), "2026-09-20");
});

test("selectStockSnapshotDate returns the exact match when the file's max date equals reportDate", () => {
  const dates = ["2026-09-18", "2026-09-20", "2026-09-22"];
  assert.equal(selectStockSnapshotDate(dates, "2026-09-22"), "2026-09-22");
});

test("selectStockSnapshotDate returns '' when every date in the file is after reportDate", () => {
  assert.equal(selectStockSnapshotDate(["2026-09-25", "2026-09-26"], "2026-09-22"), "");
});

// ── parseUsSlashDate ──────────────────────────────────────────────────────

test("parseUsSlashDate reads MM/DD/YYYY (the FBA stock report's own format) into ISO", () => {
  // Regression case: the exact value from the real 172544020718.csv export
  // ("09/20/2026"), which a naive `new Date("09/20/2026")` or a DD/MM/YYYY
  // reading would corrupt — this must read as 2026-09-20, not 2005-xx-xx
  // or any other value.
  assert.equal(parseUsSlashDate("09/20/2026"), "2026-09-20");
  // Adjacent real date from the same file, to rule out an off-by-one in
  // the month/day slicing.
  assert.equal(parseUsSlashDate("09/19/2026"), "2026-09-19");
  assert.equal(parseUsSlashDate("1/5/2026"), "2026-01-05");
});

test("parseUsSlashDate passes through an already-ISO date and returns '' for blank/unparseable input", () => {
  assert.equal(parseUsSlashDate("2026-09-20"), "2026-09-20");
  assert.equal(parseUsSlashDate(""), "");
  assert.equal(parseUsSlashDate("not a date"), "");
});

// ── Full stock-snapshot pipeline, using the real FBA stock CSV's exact
// header row and a representative slice of its actual rows (same shape as
// 172544020718.csv: UTF-8 BOM handled upstream by the caller, MM/DD/YYYY
// dates, a VSNC fulfillment center, a non-SELLABLE disposition, and two
// distinct dates where only the later one should be selected). ────────────

test("stock snapshot pipeline: real CSV shape end to end for reportDate=2026-09-22 selects 2026-09-20 and applies all 3 filters correctly", () => {
  // Mirrors real rows from 172544020718.csv (Date, FNSKU, Fulfillment
  // Center, ASIN, MSKU, Disposition, Ending Warehouse Balance).
  const rawRows = [
    { Date: "09/19/2026", "Fulfillment Center": "GAX1", Disposition: "SELLABLE", MSKU: "B-CH-PS-B-2" }, // older date -> excluded
    { Date: "09/20/2026", "Fulfillment Center": "GAX1", Disposition: "SELLABLE", MSKU: "B-CH-PS-B-2" }, // kept
    { Date: "09/20/2026", "Fulfillment Center": "VSNC", Disposition: "SELLABLE", MSKU: "B-CH-PS-B-2" }, // VSNC -> excluded
    { Date: "09/20/2026", "Fulfillment Center": "HYD3", Disposition: "UNSELLABLE", MSKU: "B-CH-PS-B-2" }, // non-SELLABLE -> excluded
  ];
  const dates = rawRows.map((r) => parseUsSlashDate(r["Date"])).filter(Boolean);
  const anchor = selectStockSnapshotDate(dates, "2026-09-22");
  assert.equal(anchor, "2026-09-20");

  const results = rawRows.map((r) =>
    cleanStockSnapshotRow(
      { reportDate: parseUsSlashDate(r["Date"]), fulfillmentCenter: r["Fulfillment Center"], disposition: r["Disposition"] },
      anchor
    )
  );
  assert.deepEqual(
    results.map((r) => r.keep),
    [false, true, false, false]
  );
  assert.equal(results[0].reason, "older_stock_date");
  assert.equal(results[2].reason, "vsnc");
  assert.equal(results[3].reason, "non_sellable");
});

// ── parseManualPlanGrid ──────────────────────────────────────────────────

test("parseManualPlanGrid reads skuid, zone and column X from the manual FBA analysis sheet, in row order", () => {
  const grid = [
    ["S.No", "skuid", "product name", "zone", "id + zone", "Total orders", "Stock needed REGION WISE", " Stock present per SKU ID for FBA - booked - inransit ", "to be send (region wise)"],
    ["", "B-SENBR-1", "Sensory Brush", "Karnataka_zone", "", 108, 264, 1500, 264],
    ["", " B-SENBR-1 ", "Sensory Brush", "WestBengal_zone", "", 114, 354, "1500", 224],
    ["", "B-FOAM-1", "Foam", "Karnataka_zone", "", 0, 5, "-", 0], // text X -> blank
    ["", "B-FOAM-1", "Foam", "Assam_zone", "", 0, 5, "", 0],
    ["", "B-BP-MON-5", "", "", "", "", "", "", ""], // no zone typed -> skipped
    ["", "", "", "", "", "", "", "", ""],
  ];
  const { rows, skippedNoZone } = parseManualPlanGrid(grid);
  assert.deepEqual(rows, [
    { sku: "B-SENBR-1", zone: "Karnataka_zone", stock_to_send: 1500, row_order: 0 },
    { sku: "B-SENBR-1", zone: "WestBengal_zone", stock_to_send: 1500, row_order: 1 },
    { sku: "B-FOAM-1", zone: "Karnataka_zone", stock_to_send: null, row_order: 2 },
    { sku: "B-FOAM-1", zone: "Assam_zone", stock_to_send: null, row_order: 3 },
  ]);
  assert.equal(skippedNoZone, 1);
});

test("parseManualPlanGrid throws when the sheet isn't the manual FBA analysis layout", () => {
  assert.throws(() => parseManualPlanGrid([["SKU", "Zone"], ["A", "Z"]]), /skuid|zone|Stock present/);
});
