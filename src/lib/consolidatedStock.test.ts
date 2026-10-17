import test from "node:test";
import assert from "node:assert/strict";
import { parseGodownSheet, parseNotRestockedStock, buildConsolidated, componentNeeds, mondayOf, istToday, weeklyInputs, runningOut, salesDropped, noSales, blockDate, parseRestockRows, restockSources, mergeRestockRows, dateFromFileName, withExtraProducts, onlyRestockProducts } from "./consolidatedStock.ts";

// Shape of the godown "FC Stock sheet": A Products, D master product, named stock columns, then
// "Stock as on" blocks of Opening | Stock IN | Stock Out | Closing.
const HEAD = ["Products", null, null, null, "SKU", "FBA", "Inbound shipped", "unfulfillable", "Final Stock in Warehouse", "QC Godown stock sheet", "Packing godown stock sheet",
  "Stock as on 26.08.2026", null, null, null, "Stock as on 25.08.2026", null, null, null, "Stock as on 24.08.2026", null, null, null];
const SUB = [null, "Product", null, "Qty"];
const row = (listing: string, master: string, stock: [number, number, number, number, number], outs: [number, number, number]) =>
  [listing, "A", "1", master, "", "", ...stock, 0, 0, outs[0], 0, 0, 0, outs[1], 0, 0, 0, outs[2], 0];

test("blockDate reads the godown's date headers", () => {
  assert.equal(blockDate("Stock as on 26.08.2026"), "2026-08-26");
  assert.equal(blockDate("Stock as on 1.9.2026"), "2026-09-01");
  assert.equal(blockDate("Comments"), null);
});

test("current stock and daily shipped are summed over a product's listing rows", () => {
  const p = parseGodownSheet([HEAD, SUB,
    ["BARE, STRIPS", null, null, 0],
    row("Gluco Bare", "Gluco Bare", [0, 0, 880, 0, 42], [31, 30, 27]),
    row("Glucometer Bare-FBA", "Gluco Bare", [5, 1, 0, 0, 0], [1, 0, 0]),
  ], [["Product Name"], ["Old thing"]]);
  assert.equal(p.snapshotDate, "2026-08-26");
  assert.equal(p.products.length, 1);
  assert.equal(p.products[0].currentStock, 928);
  assert.equal(p.products[0].skuRows, 2);
  const d26 = p.daily.find((d) => d.date === "2026-08-26")!;
  assert.equal(d26.stockOut, 32);
});

test("reads the client's 05.10.2026 template (master product in column B)", () => {
  const head = [" ", "Master Data", null, ...HEAD.slice(5)];
  const r = (listing: string, master: string, stock: [number, number, number, number, number], outs: [number, number, number]) =>
    [listing, master, "SCGSB", ...row(listing, master, stock, outs).slice(5)];
  const p = parseGodownSheet([head, [null, "Master Data"],
    ["BARE, STRIPS", null, null],
    r("Gluco Spark Bare", "Gluco Bare", [0, 0, 1435, 0, 17], [32, 28, 38]),
    r("Glucometer Bare-FBA", "Gluco Bare", [0, 0, 0, 0, 0], [0, 0, 0]),
  ]);
  assert.equal(p.products.length, 1);
  assert.equal(p.products[0].currentStock, 1452);
  assert.equal(p.daily.find((d) => d.date === "2026-08-26")!.stockOut, 32);
});

test("rejects a workbook that is not the FC Stock sheet", () => {
  assert.throws(() => parseGodownSheet([["Something else"]]), /FC Stock sheet/);
});

test("consolidated maths follows the client's formulas", () => {
  const products = [{ product: "Gluco Bare", currentStock: 922, inboundShipped: 0, unfulfillable: 0, warehouse: 880, qcGodown: 0, packingGodown: 42, skuRows: 1, discontinued: false }];
  const outs = [16, 40, 22, 45, 29, 30, 22, 27, 30, 31];
  const daily = outs.map((o, i) => ({ date: `2026-08-${String(17 + i).padStart(2, "0")}`, product: "Gluco Bare", stockOut: o }));
  const { dates, rows } = buildConsolidated(products, daily, [{ product: "gluco bare", orderPlaced: 0, stockIntransit: 0, purchaseQty: 4744.86 }]);
  assert.equal(dates[0], "2026-08-17");
  const r = rows[0];
  assert.equal(r.avgPerDay, 29.2);
  assert.equal(Math.round(r.need180), 5256);
  assert.equal(Math.round(r.qtyToRestock), 4334);
  assert.equal(r.finalQtyToRestock, 4744.86);
  assert.equal(Math.round(r.daysOfStock!), 32);
});

test("final qty never goes below 0 when stock already covers 180 days", () => {
  const products = [{ product: "X", currentStock: 27, inboundShipped: 0, unfulfillable: 0, warehouse: 27, qcGodown: 0, packingGodown: 0, skuRows: 1, discontinued: false }];
  const daily = [{ date: "2026-08-18", product: "X", stockOut: 1 }];
  const r = buildConsolidated(products, daily).rows[0];
  assert.equal(Math.round(r.qtyToRestock), -9);
  assert.equal(r.finalQtyToRestock, 0);
});

test("lists: running out (<30 days), sales dropped (D3>D2>D1), no sales (stock, not discontinued)", () => {
  const mk = (product: string, currentStock: number, outs: number[], discontinued = false) =>
    ({ product, currentStock, outs, discontinued });
  const items = [mk("Fast", 20, [2, 2, 2, 2, 2, 2, 2, 2, 2, 2]), mk("Slow", 300, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]), mk("Drop", 50, [0, 0, 0, 0, 0, 0, 0, 3, 2, 1]),
    mk("Flat3", 50, [0, 0, 0, 0, 0, 0, 0, 2, 2, 1]), mk("Idle", 40, Array(10).fill(0)), mk("Gone", 40, Array(10).fill(0), true), mk("Empty", 0, Array(10).fill(0))];
  const products = items.map((i) => ({ product: i.product, currentStock: i.currentStock, inboundShipped: 0, unfulfillable: 0, warehouse: i.currentStock, qcGodown: 0, packingGodown: 0, skuRows: 1, discontinued: i.discontinued }));
  const daily = items.flatMap((i) => i.outs.map((o, k) => ({ date: `2026-08-${String(17 + k).padStart(2, "0")}`, product: i.product, stockOut: o })));
  const { rows } = buildConsolidated(products, daily);
  assert.deepEqual(runningOut(rows).map((r) => r.product), ["Fast"]);
  assert.deepEqual(salesDropped(rows).map((r) => r.product), ["Drop"]);
  assert.deepEqual(noSales(rows).map((r) => r.product), ["Idle"]);
});

test("combo: Σ stored required qty less max(stock) per component, blanks as 0 (the tool's Components Sheet)", () => {
  const needs = componentNeeds([
    { component: "Blades", required: 1365, stock: 834 },
    { component: "Blades", required: 20, stock: null },
    { component: "Lancing device", required: 748, stock: null },
    { component: "Breast Shell", required: 5, stock: 50 },
  ]);
  assert.deepEqual(needs.map((n) => [n.component, n.required, n.stock, n.finalQty]), [["Blades", 1385, 834, 551], ["Lancing device", 748, 0, 748], ["Breast Shell", 5, 50, 0]]);
  const products = [{ product: "Blades", currentStock: 834, inboundShipped: 0, unfulfillable: 0, warehouse: 834, qcGodown: 0, packingGodown: 0, skuRows: 1, discontinued: false }];
  const { rows: out } = buildConsolidated(products, [{ date: "2026-10-11", product: "Blades", stockOut: 0 }], [], 10, needs);
  assert.equal(out[0].comboQty, 0); // combo column shows 0 for all products (user, 2026-10-15)
});

test("excluded products (user, 2026-10-15) stay on the sheet but are left off No sales", () => {
  const p = (product: string, currentStock: number) => ({ product, currentStock, inboundShipped: 0, unfulfillable: 0, warehouse: 0, qcGodown: 0, packingGodown: 0, skuRows: 1, discontinued: false });
  const products = withExtraProducts([p("Lancing device", 335), p("Silicone Tip", 58), p("Blades", 10)], ["Neck traction pillow (Blue)", "Bulb Syringe IUI applicator -8cm(Pack of 5)"]);
  const { rows } = buildConsolidated(products, [{ date: "2026-10-12", product: "Other", stockOut: 1 }]);
  assert.deepEqual(rows.map((r) => r.product), ["Lancing device", "Silicone Tip", "Blades", "Neck traction pillow (Blue)", "Bulb Syringe IUI applicator -8cm(Pack of 5)"]);
  assert.deepEqual(noSales(rows).map((r) => r.product), ["Blades"]);
});

test("peak sales: best single day over all days given, latest date on a tie", () => {
  const products = [{ product: "Brush", currentStock: 50, inboundShipped: 0, unfulfillable: 0, warehouse: 50, qcGodown: 0, packingGodown: 0, skuRows: 1, discontinued: false }];
  const outs = [9, 3, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const daily = outs.map((o, i) => ({ date: `2026-09-${String(1 + i).padStart(2, "0")}`, product: "Brush", stockOut: o }));
  const { rows } = buildConsolidated(products, daily);
  assert.deepEqual([rows[0].peakQty, rows[0].peakDate], [9, "2026-09-03"]); // outside the last 10 days
  assert.ok(rows[0].days.every((v) => !v));
  const none = buildConsolidated(products, daily.map((d) => ({ ...d, stockOut: 0 }))).rows[0];
  assert.deepEqual([none.peakQty, none.peakDate], [null, null]);
});

test("week boundaries: Monday of the picked date (Mon–Sun weeks, across months and years)", () => {
  assert.equal(mondayOf("2026-10-12"), "2026-10-12"); // Monday itself
  assert.equal(mondayOf("2026-10-13"), "2026-10-12"); // Tuesday
  assert.equal(mondayOf("2026-10-18"), "2026-10-12"); // Sunday stays in the same week
  assert.equal(mondayOf("2026-10-19"), "2026-10-19"); // next Monday starts the next week
  assert.equal(mondayOf("2026-11-01"), "2026-10-26"); // across a month
  assert.equal(mondayOf("2027-01-01"), "2026-12-28"); // across a year
});

test("istToday: the IST business date, not UTC", () => {
  assert.equal(istToday(new Date("2026-10-18T18:29:00Z")), "2026-10-18"); // Sun 23:59 IST
  assert.equal(istToday(new Date("2026-10-18T18:30:00Z")), "2026-10-19"); // Mon 00:00 IST
});

test("weekly snapshot -> restock inputs and combo needs (blank stock = 0, numbers from text)", () => {
  const { inputs, combos } = weeklyInputs(
    [{ product: "Insemination kit (Pack of 5)", stock_intransit: "0", order_placed: "0", suggested_rfq: "2675" },
     { product: "Ovulation thermometer", stock_intransit: null, order_placed: 1728, suggested_rfq: 0 }],
    [{ component: "Blades", required_qty: "3325", component_stock: "834" }, { component: "Lancing device", required_qty: 748, component_stock: null }],
  );
  assert.deepEqual(inputs, [
    { product: "Insemination kit (Pack of 5)", stockIntransit: 0, orderPlaced: 0, purchaseQty: 2675 },
    { product: "Ovulation thermometer", stockIntransit: null, orderPlaced: 1728, purchaseQty: 0 },
  ]);
  assert.deepEqual(combos.map((c) => [c.component, c.finalQty]), [["Blades", 2491], ["Lancing device", 748]]);
});

test("missing snapshot: no restock/combo values at all (never mixed with current numbers)", () => {
  const products = [{ product: "Insemination kit (Pack of 5)", currentStock: 61, inboundShipped: 0, unfulfillable: 0, warehouse: 61, qcGodown: 0, packingGodown: 0, skuRows: 1, discontinued: false }];
  const daily = Array.from({ length: 10 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, "0")}`, product: "Insemination kit (Pack of 5)", stockOut: 40 }));
  const [r] = buildConsolidated(products, daily, [], 10, []).rows;
  assert.deepEqual([r.stockIntransit, r.orderPlaced, r.purchaseQty, r.comboQty], [null, null, null, 0]); // combo is 0 for all (user, 2026-10-15)
  assert.equal(r.finalQtyToRestock, 40 * 180 - 61); // the 180-day need only
});

test("reads each date block by its own sub-headers: 4-column and older 3-column layouts, cut-off block skipped", () => {
  // 20.07.2026: Opening | Stock IN | Stock Out | Closing — 18.07.2026 and 17.07.2026: Stock IN | Stock Out | Total Stock Count
  // 16.07.2026: cut off after Stock IN (the sheet's last column)
  const head = [" ", "Master Data", null, "Inbound shipped", "unfulfillable", "Final Stock in Warehouse", "QC Godown stock sheet", "Packing godown stock sheet",
    "Stock as on 20.07.2026", null, null, null, "Stock as on 18.07.2026", null, null, "Stock as on 17.07.2026", null, null, "Stock as on 16.07.2026"];
  const sub = [null, "Master Data", null, null, null, null, null, null,
    "Opening Stock", "Stock IN", "Stock Out", "Closing Stock", "Stock IN", "Stock Out", "Total Stock Count", "Stock IN", "Stock Out", "Total Stock Count", "Stock IN"];
  const r = ["Listing A", "Prod A", "SKU-A", 0, 0, 90, 0, 0, 100, 0, 10, 90, 5, 15, 100, 0, 7, 110, 962];
  const p = parseGodownSheet([head, sub, r], [], 100);
  const by = new Map(p.daily.map((d) => [d.date, d]));
  assert.deepEqual([...by.keys()].sort(), ["2026-07-17", "2026-07-18", "2026-07-20"]);
  assert.deepEqual(by.get("2026-07-20"), { date: "2026-07-20", product: "Prod A", opening: 100, stockIn: 0, stockOut: 10, closing: 90 });
  // 3-column: Stock Out is the middle column, never the stock count; opening derived = closing − in + out
  assert.deepEqual(by.get("2026-07-18"), { date: "2026-07-18", product: "Prod A", opening: 110, stockIn: 5, stockOut: 15, closing: 100 });
  assert.deepEqual(by.get("2026-07-17"), { date: "2026-07-17", product: "Prod A", opening: 117, stockIn: 0, stockOut: 7, closing: 110 });
  assert.ok(p.warnings.some((w) => /Skipped "Stock as on 16\.07\.2026"/.test(w)));
  // the daily upload's 31-day window is unchanged by the old blocks
  assert.deepEqual(parseGodownSheet([head, sub, r], [], 1).daily.map((d) => d.date), ["2026-07-20"]);
});

// Restock inputs upload (user, 2026-10-14): the tool's Stock Purchase Sheet / Components Sheet exports.
const SPS_HEAD = ["Marketplace", "Product", "SKU ID", "Total net orders in last 30 days", "180 days order forecast", "Current Stock", "Stock intransit", "Order placed", "Suggested RFQ"];
const CMP_HEAD = ["Component", "Product Entity", "Quantities required", "RFQ", "Required Component Quantity", "Current Stock", "Final Components required quantity"];

test("restock upload: Stock Purchase Sheet -> one row per product (values repeat on every SKU row)", () => {
  const r = parseRestockRows([
    SPS_HEAD,
    ["Amazon", "Blades ", "", 0, 0, 2, 10, 5, "273"],
    ["Amazon", "Blades", "B-BLADE", 0, 0, 2, 10, 5, "273"],
    ["Flipkart", "Pregnancy kit\r\n", "P-1", 0, 0, 0, "", null, "0"],
    [null, null, null],
  ]);
  assert.equal(r.kind, "purchase");
  assert.deepEqual(r.rfq, [
    { product: "Blades", stock_intransit: 10, order_placed: 5, suggested_rfq: 273 },
    { product: "Pregnancy kit", stock_intransit: null, order_placed: null, suggested_rfq: 0 },
  ]);
  assert.deepEqual(weeklyInputs(r.rfq, []).inputs[0], { product: "Blades", stockIntransit: 10, orderPlaced: 5, purchaseQty: 273 });
});

test("restock upload: Components Sheet -> rows as in the tool (feeds the same combo maths)", () => {
  const r = parseRestockRows([
    CMP_HEAD,
    ["Blades", "Suture Practice Kit - combo 3", "5", "273", "1365", 834, 531],
    ["Blades", "Suture Kit", "1", "10", "10", "", 0],
    ["", "nothing", "", "", "", "", ""],
  ]);
  assert.equal(r.kind, "components");
  assert.deepEqual(r.components.map((c) => [c.component, c.product, c.required_qty, c.component_stock]), [
    ["Blades", "Suture Practice Kit - combo 3", 1365, 834], ["Blades", "Suture Kit", 10, null],
  ]);
  assert.deepEqual(weeklyInputs([], r.components).combos, [{ component: "Blades", required: 1375, stock: 834, finalQty: 541 }]);
});

test("restock upload: header row found below a title row; other files are refused", () => {
  assert.equal(parseRestockRows([["Stock purchase"], SPS_HEAD, ["Amazon", "X", "", 0, 0, 0, 1, 2, 3]]).rfq.length, 1);
  assert.throws(() => parseRestockRows([["Products", "SKU", "FBA"], ["a", "b", 1]]), /Stock Purchase Sheet|Components Sheet|Current stock sheet/);
  assert.throws(() => parseRestockRows([SPS_HEAD]), /no product rows/i);
});

test("source priority (user, 2026-10-14): in transit / order placed = latest Current stock sheet, else the Monday snapshot; purchase qty and combo = Monday snapshot only", () => {
  // 13 Oct with the 9 Oct upload and the 12 Oct week's snapshot
  assert.deepEqual(restockSources({ date: "2026-10-09" }, true), { transit: "current", purchase: "snapshot", components: "snapshot" });
  // an older upload still wins over a newer snapshot for in transit / order placed
  assert.deepEqual(restockSources({ date: "2026-09-01" }, true), { transit: "current", purchase: "snapshot", components: "snapshot" });
  // no upload on or before the date: the snapshot fills everything
  assert.deepEqual(restockSources(null, true), { transit: "snapshot", purchase: "snapshot", components: "snapshot" });
  // snapshot missing / failed: purchase qty and combo have no source (0 + warning); the upload still gives transit
  assert.deepEqual(restockSources({ date: "2026-10-09" }, false), { transit: "current", purchase: "none", components: "none" });
  assert.deepEqual(restockSources(null, false), { transit: "none", purchase: "none", components: "none" });
});

test("in transit / order placed from the Current stock sheet, Suggested RFQ from the snapshot, per product", () => {
  const current = [{ product: "Nascool", stock_intransit: 108, order_placed: 400, suggested_rfq: null }, { product: "Only in file", stock_intransit: 5, order_placed: null, suggested_rfq: null }];
  const snap = [{ product: "nascool ", stock_intransit: 0, order_placed: 0, suggested_rfq: 120 }, { product: "Only in snapshot", stock_intransit: 9, order_placed: 9, suggested_rfq: 33 }];
  assert.deepEqual(mergeRestockRows(current, snap), [
    { product: "Nascool", stock_intransit: 108, order_placed: 400, suggested_rfq: 120 },
    { product: "Only in file", stock_intransit: 5, order_placed: null, suggested_rfq: null },
    // not in the uploaded file: no in transit / order placed from the snapshot, only its Suggested RFQ
    { product: "Only in snapshot", stock_intransit: null, order_placed: null, suggested_rfq: 33 },
  ]);
  // no upload: the snapshot rows as they are
  assert.deepEqual(mergeRestockRows(null, snap), snap);
});
// The client's "Current stock sheet-DD-MM-YYYY.xlsx" (user, 2026-10-14): names + in transit + order placed.
const CUR_HEAD = ["Product name", "Inbound shipped", "unfulfillable", "Final Stock in Warehouse", "QC Godown stock sheet", "Packing godown stock sheet", "Stock intransit", "Order placed"];

test("restock upload: Current stock sheet -> in transit and order placed per product (no purchase qty)", () => {
  const r = parseRestockRows([
    CUR_HEAD,
    ["Nascool nasal power suction irrigation system", 0, 0, 8, 0, 47, 108, 400],
    ["Neck traction pillow (Blue) ", 0, 0, 3, 0, 0, null, ""],
    [null, null, null, null, null, null, null, null],
  ]);
  assert.equal(r.kind, "current");
  assert.deepEqual(r.rfq, [
    { product: "Nascool nasal power suction irrigation system", stock_intransit: 108, order_placed: 400, suggested_rfq: null, current_stock: 55 },
    { product: "Neck traction pillow (Blue)", stock_intransit: null, order_placed: null, suggested_rfq: null, current_stock: 3 },
  ]);
});

test("file date comes from the file name (DD-MM-YYYY or DD.MM.YYYY), else null", () => {
  assert.equal(dateFromFileName("Current stock sheet-09-10-2026.xlsx"), "2026-10-09");
  assert.equal(dateFromFileName("Current stock sheet 9.10.2026.xlsx"), "2026-10-09");
  assert.equal(dateFromFileName("Stock Purchase Sheet.xlsx"), null);
  assert.equal(dateFromFileName("x-31-02-2026.xlsx"), null);
});

test("names only in the restock file become rows (0 stock, 0 sales), godown names are not duplicated", () => {
  const p = (product: string, currentStock: number) => ({ product, currentStock, inboundShipped: 0, unfulfillable: 0, warehouse: 0, qcGodown: 0, packingGodown: 0, skuRows: 1, discontinued: false });
  const out = withExtraProducts([p("Blades", 10)], ["blades ", "Neck traction pillow (Blue)"]);
  assert.deepEqual(out.map((x) => [x.product, x.currentStock, x.skuRows]), [["Blades", 10, 1], ["Neck traction pillow (Blue)", 0, 0]]);
});

test("no sales leaves out products with current stock below 5 (user, 2026-10-14)", () => {
  const p = (product: string, currentStock: number) => ({ product, currentStock, inboundShipped: 0, unfulfillable: 0, warehouse: 0, qcGodown: 0, packingGodown: 0, skuRows: 1, discontinued: false });
  const { rows } = buildConsolidated([p("Four", 4), p("Five", 5), p("Lots", 618)], [{ date: "2026-10-12", product: "Other", stockOut: 1 }]);
  assert.deepEqual(noSales(rows).map((r) => r.product), ["Lots", "Five"]);
});

test("with a restock input file, only its products are listed (user, 2026-10-15)", () => {
  const p = (product: string, currentStock: number) => ({ product, currentStock, inboundShipped: 0, unfulfillable: 0, warehouse: 0, qcGodown: 0, packingGodown: 0, skuRows: 1, discontinued: false });
  const out = onlyRestockProducts([p("Blades", 10), p("Godown only", 5)], ["blades ", "Neck traction pillow (Blue)"]);
  assert.deepEqual(out.map((x) => [x.product, x.currentStock]), [["Blades", 10], ["Neck traction pillow (Blue)", 0]]);
});

// "Not restocked Products" tab as in the 14.10.2026 godown file (header rows, two listings of one master
// product, #N/A in the QC / Packing columns, a section row without a master name).
test("Not restocked Products tab: stock per master product, #N/A as 0, missing columns skipped with a warning", async () => {
  const head = ["Products", null, null, null, "SKU ", "FC \nCentre", "FBA", "In transit to FBA/Not Shipped/In transit to Office", "Inbound", "unfulfillable", "cancelled", "Reserved", "Yesterday stock",
    null, null, null, "COUNT CHECK", null, null, null, null, "Final Stock in Warehouse", "QC Godown stock sheet", "Packing godown stock sheet"];
  const sub = [null, null, "MASTER NAME", "MASTER SKU"];
  const row = (listing: string, master: string | null, inbound: unknown, unf: unknown, wh: unknown) => {
    const r: unknown[] = Array(24).fill(null);
    r[0] = listing; r[2] = master; r[8] = inbound; r[9] = unf; r[21] = wh; r[22] = "#N/A"; r[23] = "#N/A";
    return r;
  };
  const { products, warnings } = parseNotRestockedStock([head, sub,
    row("Nail Fungal Cleaning  Device-old model", "Nail cleaning device", null, null, 2),
    row("Nail Fungal Cleaning Device- FBA-old model", " Nail  cleaning device ", 0, 0, 0),
    row("Wearable massager listing", "Wearable lactation massager (Grey)", 1, 1, 3),
    row("RMT heading", null, null, null, 9),
  ] as never);
  assert.deepEqual(warnings, []);
  assert.deepEqual(products.map((p) => [p.product, p.currentStock, p.skuRows]), [["Nail cleaning device", 2, 2], ["Wearable lactation massager (Grey)", 5, 1]]);
  assert.deepEqual(parseNotRestockedStock([]).products, []);
  assert.match(parseNotRestockedStock([["Products"], [null, null, "MASTER NAME"]] as never).warnings[0], /not found/);
  // On the sheet it adds to the FC Stock sheet's stock for the same product (merge sums by name).
  const { mergeGodownProducts } = await import("./godownProductAliases.ts");
  const fc = { product: "Wearable Lactation Massager-Grey", currentStock: 68, inboundShipped: 0, unfulfillable: 0, warehouse: 68, qcGodown: 0, packingGodown: 0, skuRows: 2, discontinued: false };
  assert.deepEqual(mergeGodownProducts([fc, ...products]).map((p) => [p.product, p.currentStock]), [["Wearable Lactation Massager-Grey", 73], ["Nail cleaning device", 2]]);
});
