import test from "node:test";
import assert from "node:assert/strict";
import * as XS from "xlsx-js-style";
import { buildConsolidated, weeklyInputs } from "./consolidatedStock.ts";
import { buildConsolidatedWorkbook, weeklyLabel, consolidatedWorkbookBytes, SEASONAL_HEAD } from "./consolidatedStockExport.ts";

const XLSX = ((XS as unknown as { default?: typeof XS }).default ?? XS) as typeof XS;
const products = [
  { product: "Insemination kit (Pack of 5)", currentStock: 61, inboundShipped: 0, unfulfillable: 0, warehouse: 61, qcGodown: 0, packingGodown: 0, skuRows: 1, discontinued: false },
  { product: "Blades", currentStock: 0, inboundShipped: 0, unfulfillable: 0, warehouse: 0, qcGodown: 0, packingGodown: 0, skuRows: 1, discontinued: false },
];
const daily = Array.from({ length: 12 }, (_, i) => [
  { date: `2026-10-${String(i + 1).padStart(2, "0")}`, product: "Insemination kit (Pack of 5)", stockOut: 30 + i },
  { date: `2026-10-${String(i + 1).padStart(2, "0")}`, product: "Blades", stockOut: 0 },
]).flat();
const snap = weeklyInputs(
  [{ product: "Insemination kit (Pack of 5)", stock_intransit: 0, order_placed: 0, suggested_rfq: 2675 }],
  [{ component: "Blades", required_qty: 3325, component_stock: 834 }],
);
const rowsOf = (wb: XS.WorkBook, name: string) => XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1 });

test("Excel export = page data: same days, stock, RFQ, combo, peak, and the snapshot week", () => {
  const { dates, rows } = buildConsolidated(products, daily, snap.inputs, 10, snap.combos);
  const weekly = { weekStart: "2026-10-12", status: "ok" as const, capturedAt: "2026-10-12T04:30:00Z", error: null };
  const wb = buildConsolidatedWorkbook({ snapshotDate: "2026-10-12", dates, rows, weekly });
  assert.deepEqual(wb.SheetNames, ["Summary", "Consolidated", "No Sales products", "Sales dropped products", "Products running out of stock", "Products not listed on platform", "About"]);
  const sheet = rowsOf(wb, "Consolidated");
  const head = sheet[0] as string[];
  assert.equal(head[1], "DAY 10 (03-10-2026)"); assert.equal(head[10], "DAY 1 (12-10-2026)");
  for (const r of rows) {
    const x = sheet.find((s) => s[0] === r.product)!;
    const col = (h: string) => x[head.indexOf(h)];
    assert.deepEqual(x.slice(1, 11), r.days.map((v) => v ?? 0));
    assert.equal(col("Current stock"), r.currentStock);
    assert.equal(col("Stock purchase sheet Qty to be restocked"), r.purchaseQty ?? 0);
    assert.equal(col("Final Qty to be restocked"), r.finalQtyToRestock);
    assert.equal(col("Stock to be purchased for Combo products"), r.comboQty ?? 0);
  }
  const ins = sheet.find((s) => s[0] === "Insemination kit (Pack of 5)")!;
  assert.equal(ins[head.indexOf("Stock purchase sheet Qty to be restocked")], 2675);
  assert.equal(sheet.find((s) => s[0] === "Blades")![head.indexOf("Stock to be purchased for Combo products")], 0); // 0 for all (user, 2026-10-15)
  const nosales = rowsOf(wb, "No Sales products");
  assert.deepEqual(nosales.slice(1).map((s) => s[0]), []); // Blades has 0 stock, so not "no sales with stock"
  const about = rowsOf(wb, "About");
  assert.match(String(about[1][1]), /^03-10-2026 to 12-10-2026 \(10 godown days\)$/);
  assert.equal(about[3][1], weeklyLabel(weekly));
  assert.match(String(about[3][1]), /^Stock Purchase \/ Components: Monday 12-10-2026 snapshot, captured 12 Oct 2026, 10:00 am IST$/i);
});

test("Excel export with a missing Monday snapshot: 0 in restock/combo columns and the warning", () => {
  const { dates, rows } = buildConsolidated(products, daily, [], 10, []);
  const weekly = { weekStart: "2026-10-19", status: "missing" as const, capturedAt: null, error: null };
  const wb = buildConsolidatedWorkbook({ snapshotDate: "2026-10-12", dates, rows, weekly });
  const sheet = rowsOf(wb, "Consolidated");
  const head = sheet[0] as string[];
  const ins = sheet.find((s) => s[0] === "Insemination kit (Pack of 5)")!;
  for (const h of ["Stock Intransit", "Order placed", "Stock purchase sheet Qty to be restocked", "Stock to be purchased for Combo products"])
    assert.equal(ins[head.indexOf(h)], 0, h); // missing shows 0, never blank / null (user, 2026-10-14)
  const about = rowsOf(wb, "About");
  assert.match(String(about[3][1]), /^WARNING: no Monday 19-10-2026 snapshot \(not captured\)/);
  assert.match(weeklyLabel({ weekStart: "2026-10-19", status: "failed", capturedAt: null, error: "timeout" }), /capture failed: timeout/);
});

test("Sales dropped sheet has no peak columns; Seasonal Analytics sheet carries peak + the seasonal columns", async () => {
  const { analyzeGodown } = await import("./godownAnalytics.ts");
  // Insemination kit: 3 > 2 > 1 over the last three days so it is on Sales dropped; 5 Oct has no upload.
  const d2 = daily.filter((d) => d.date !== "2026-10-05").map((d) => (d.product.startsWith("Insemination") && d.date >= "2026-10-10" ? { ...d, stockOut: 40 - Number(d.date.slice(8)) } : d));
  const { dates, rows } = buildConsolidated(products, d2, snap.inputs, 10, snap.combos);
  const a = analyzeGodown(rows, d2.map((d) => ({ ...d, closing: null })), "2026-10-12");
  const wb = buildConsolidatedWorkbook({ snapshotDate: "2026-10-12", dates, rows, seasonal: { coverage: a.coverage, products: a.products } });
  assert.deepEqual(wb.SheetNames, ["Summary", "Consolidated", "No Sales products", "Sales dropped products", "Products running out of stock", "Products not listed on platform", "Seasonal Analytics", "Unusual Stock Out days", "About"]);
  const dropped = rowsOf(wb, "Sales dropped products");
  assert.deepEqual(dropped[0], ["Product", "DAY 3 (10-10-2026)", "DAY 2 (11-10-2026)", "DAY 1 (12-10-2026)", "Current stock"]);
  assert.deepEqual(dropped[1], ["Insemination kit (Pack of 5)", 30, 29, 28, 61]);
  const sea = rowsOf(wb, "Seasonal Analytics");
  const head = sea[0] as string[];
  const ins = sea.find((r) => r[0] === "Insemination kit (Pack of 5)")!;
  const col = (h: string) => ins[head.indexOf(h)];
  assert.equal(col("Peak sales (units/day)"), 38);     // 9 Oct: 30 + 8
  assert.equal(col("Peak sales date"), "09-10-2026");
  assert.equal(col("Peak month"), "Oct 2026");
  assert.equal(col("Current stock"), 61);
  assert.match(String(col("Seasonality")), /^Not available — 11 godown days \(needs 365\)$/);
  assert.ok(String(col("Recommendation")).length > 0);
  // the note rows under the table state the gap
  assert.ok(sea.some((r) => /gaps, not zero/.test(String(r[0]))));
  // without seasonal data the workbook is unchanged
  assert.ok(!buildConsolidatedWorkbook({ snapshotDate: "2026-10-12", dates, rows }).SheetNames.includes("Seasonal Analytics"));
});

test("Summary first: every figure is a formula over a detail sheet and its value matches; filters, frozen panes, % format", async () => {
  const { analyzeGodown } = await import("./godownAnalytics.ts");
  const { dates, rows } = buildConsolidated(products, daily, snap.inputs, 10, snap.combos);
  const a = analyzeGodown(rows, daily.map((d) => ({ ...d, closing: null })), "2026-10-12");
  const wb = buildConsolidatedWorkbook({ snapshotDate: "2026-10-12", dates, rows, seasonal: { coverage: a.coverage, products: a.products } });
  const sum = wb.Sheets["Summary"];
  const lines = rowsOf(wb, "Summary").slice(2).filter((r) => typeof r[1] === "number");
  const byLabel = new Map(lines.map((r) => [String(r[0]).trim(), r[1]]));
  assert.equal(byLabel.get("Products on the sheet"), rows.length);
  assert.equal(byLabel.get("Total final qty to restock (units)"), rows.reduce((t, r) => t + r.finalQtyToRestock, 0));
  assert.equal(sum["B3"].f, "COUNTA(Consolidated!A:A)-1");
  const col = (i: number) => XLSX.utils.encode_col(i);
  const finalHead = (rowsOf(wb, "Consolidated")[0] as string[]).indexOf("Final Qty to be restocked");
  const formulas = Object.values(sum).map((c) => (c as { f?: string })?.f).filter(Boolean);
  assert.ok(formulas.includes(`SUM(Consolidated!${col(finalHead)}:${col(finalHead)})`));
  const statusCol = col(SEASONAL_HEAD.indexOf("Status"));
  assert.ok(formulas.includes(`COUNTIF('Seasonal Analytics'!${statusCol}:${statusCol},"GROWING")`));
  // filters on every table sheet, covering header + rows
  assert.equal(wb.Sheets["Consolidated"]["!autofilter"]?.ref, `A1:${col((rowsOf(wb, "Consolidated")[0] as string[]).length - 1)}${rows.length + 1}`);
  for (const n of ["No Sales products", "Sales dropped products", "Products running out of stock", "Products not listed on platform", "Seasonal Analytics", "Unusual Stock Out days"]) assert.ok(wb.Sheets[n]["!autofilter"], n);
  // growth % is a real percentage
  const g = wb.Sheets["Seasonal Analytics"][XLSX.utils.encode_cell({ r: 1, c: SEASONAL_HEAD.indexOf("Growth % — last 7 vs days 8–30 (est.)") })];
  assert.equal(g.z, "0%");
  // written file: frozen panes on the table sheets, formulas and values preserved
  const bytes = consolidatedWorkbookBytes(wb);
  const back = XLSX.read(bytes, { type: "array", cellFormula: true });
  assert.deepEqual(back.SheetNames, wb.SheetNames);
  assert.equal(back.Sheets["Consolidated"]["L2"].f, wb.Sheets["Consolidated"]["L2"].f);
  const zip = XLSX.CFB.read(bytes, { type: "array" });
  const xml = (i: number) => new TextDecoder().decode(zip.FileIndex[zip.FullPaths.findIndex((p: string) => p.endsWith(`/xl/worksheets/sheet${i}.xml`))].content as Uint8Array);
  assert.match(xml(2), /<pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"\/>/); // Consolidated
  assert.doesNotMatch(xml(1), /<pane /);                                                                          // Summary
});

test("label: in transit / order placed from the Current stock sheet, purchase qty and combo from the Monday snapshot", () => {
  const cur = { from: "current" as const, date: "2026-10-09", at: "2026-10-14T06:00:00Z" };
  const snap = { from: "snapshot" as const, date: "2026-10-12", at: "2026-10-12T04:30:00Z" };
  const none = { from: "none" as const, date: null, at: null };
  const base = { weekStart: "2026-10-12", capturedAt: "2026-10-12T04:30:00Z", error: null, status: "ok" as const };
  const snapText = "Monday 12-10-2026 snapshot, captured 12 Oct 2026, 10:00 am IST";
  const curText = "Current stock sheet of 09-10-2026 (uploaded 14 Oct 2026, 11:30 am IST)";
  assert.equal(weeklyLabel({ ...base, transit: snap, purchase: snap, components: snap }), `Stock Purchase / Components: ${snapText}`);
  assert.equal(weeklyLabel({ ...base, transit: cur, purchase: snap, components: snap }),
    `In transit / Order placed: ${curText} · Purchase sheet qty / Combo: ${snapText}`);
  const missing = { ...base, status: "missing" as const, capturedAt: null };
  assert.equal(weeklyLabel({ ...missing, transit: cur, purchase: none, components: none }),
    `WARNING: no Monday 12-10-2026 snapshot (not captured). Stock purchase sheet qty and Combo show 0; Final qty is the 180-day need only. In transit / Order placed: ${curText}`);
  assert.equal(weeklyLabel({ ...missing, transit: none, purchase: none, components: none }),
    "WARNING: no Monday 12-10-2026 snapshot (not captured) and no Current stock sheet upload. Stock Intransit, Order placed, Stock purchase sheet qty and Combo show 0; Final qty is the 180-day need only.");
});
