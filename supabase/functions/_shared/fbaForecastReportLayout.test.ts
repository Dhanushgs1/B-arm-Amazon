import { assertEquals } from "https://deno.land/std@0.224.0/testing/asserts.ts";
import XLSX from "npm:xlsx-js-style@1.2.0";
import { buildFbaForecastLayout, SHEET } from "./fbaForecastReportLayout.ts";
import { writeXlsxWithViews } from "./xlsxWriter.ts";
import { computeFbaAnalysis } from "./fbaForecastCalc.ts";

function sampleInput() {
  const rows = computeFbaAnalysis(
    [{ sku: "B", zone: "Delhi_zone", quantity: 3 }, { sku: "A", zone: "Delhi_zone", quantity: 9 }, { sku: "A", zone: "Karnataka_zone", quantity: 1 }],
    [{ sku: "A", zone: "Karnataka_zone", quantity: 50 }],
    [
      { sku: "A", zone: "Delhi_zone", quantity: 4, category: "active" },
      { sku: "B", zone: "Delhi_zone", quantity: 2, category: "booked" },
    ],
    (sku) => `Product ${sku}`,
  );
  return {
    reportDate: "2026-09-22",
    rows,
    sales: [{ purchase_date: "2026-09-20", fulfillment_channel: "Amazon", product_name: "p", sku: "A", quantity: 9, ship_state: "DELHI", zone: "Delhi_zone" }],
    stock: [{ report_date: "2026-09-20", fnsku: "X", fulfillment_center: "BLR7", asin: "Y", msku: "A", disposition: "SELLABLE", ending_warehouse_balance: 50, zone: "Karnataka_zone" }],
    booked: [{ product: "p", sku: "B", quantity: 2, fc: "DEL5", status_raw: "Booked", zone: "Delhi_zone", booked_date: null, pickup_date: null, source_month: "2026-09" }],
    intransit: [],
    active: [
      { product: "p", sku: "A", quantity: 4, fc: "DEL5", status_raw: "active", zone: "Delhi_zone", booked_date: null, pickup_date: null, source_month: "2026-09", active_date: "2026-09-22" },
      { product: "p", sku: "A", quantity: 7, fc: "BLR7", status_raw: "active", zone: "Karnataka_zone", booked_date: null, pickup_date: null, source_month: "2026-09", active_date: "2026-09-20" },
      // Outside the 3-day window, or no date: never in the date columns or recently_act.
      { product: "p", sku: "A", quantity: 9, fc: "DEL5", status_raw: "active", zone: "Delhi_zone", booked_date: null, pickup_date: null, source_month: "2026-09", active_date: "2026-09-19" },
      { product: "p", sku: "B", quantity: 2, fc: "DEL5", status_raw: "active", zone: "Delhi_zone", booked_date: null, pickup_date: null, source_month: "2026-08", active_date: null },
    ],
  };
}

Deno.test("active date columns are the 3 days ending on the report date, and recently_act holds only those rows", () => {
  const wb = buildFbaForecastLayout(sampleInput());
  const ws = wb.Sheets[SHEET.analysis];
  const headers = (XLSX.utils.sheet_to_json(ws, { header: 1 })[0] as string[]);
  assertEquals(headers.slice(-3), ["20.09.2026", "21.09.2026", "22.09.2026"]); // a day with no activations still gets its column
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws);
  // A Karnataka / A Delhi / B Delhi
  assertEquals(rows.map((r) => [r["20.09.2026"], r["21.09.2026"], r["22.09.2026"]]), [[7, 0, 0], [0, 0, 4], [0, 0, 0]]);
  const recent = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[SHEET.active]);
  assertEquals(recent.map((r) => `${r["SKU"]}:${r["Quantity"]}:${r["active date"]}`), ["A:7:20.09.2026", "A:4:22.09.2026"]);
});

// deno-lint-ignore no-explicit-any
type Styled = { v?: unknown; s?: any };
function cellAt(ws: XLSX.WorkSheet, header: string, dataRow: number): Styled {
  const range = XLSX.utils.decode_range(ws["!ref"]!);
  for (let c = 0; c <= range.e.c; c++) {
    if ((ws[XLSX.utils.encode_cell({ r: 0, c })] as Styled | undefined)?.v === header) {
      return (ws[XLSX.utils.encode_cell({ r: dataRow, c })] as Styled) || {};
    }
  }
  throw new Error(`no header "${header}"`);
}
const fillOf = (c: Styled) => c.s?.fill?.fgColor?.rgb ?? null;
const fontColorOf = (c: Styled) => c.s?.font?.color?.rgb ?? null;

Deno.test("sheets follow the manual FBA_forecast sheet's order, keeping only the sheets that carry data", () => {
  const wb = buildFbaForecastLayout(sampleInput());
  assertEquals(wb.SheetNames, [SHEET.analysis, SHEET.toBeSent, SHEET.skuNames, SHEET.sales, SHEET.stock, SHEET.intransit, SHEET.active, SHEET.booked]);
  assertEquals(wb.SheetNames, ["FBA analysis", "To be sent", "SKU,name", "30_days_sales", "FBA_stock", "intransit", "recently_act", "booked"]);
});

Deno.test("FBA analysis groups rows by SKU (top seller first) with zones in the manual sheet's order", () => {
  const wb = buildFbaForecastLayout(sampleInput());
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[SHEET.analysis]);
  assertEquals(rows.map((r) => `${r["skuid"]}:${r["zone"]}`), ["A:Karnataka_zone", "A:Delhi_zone", "B:Delhi_zone"]);
  assertEquals(rows.map((r) => r["S.No"]), [1, 2, 3]);
  assertEquals(rows[1]["id + zone"], "ADelhi_zone");
  // One active date -> a single date column carrying the same quantity.
  assertEquals(rows[1]["22.09.2026"], 4);
});

Deno.test("FBA analysis uses the manual sheet's colours", () => {
  const ws = buildFbaForecastLayout(sampleInput()).Sheets[SHEET.analysis];
  // Header: Bookman Old Style bold, yellow on the two stock headers.
  const skuHeader = ws["B1"] as Styled;
  assertEquals(skuHeader.s.font.name, "Bookman Old Style");
  assertEquals(skuHeader.s.font.bold, true);
  assertEquals(fillOf(cellAt(ws, "Current Stock PRESENT REGION WISE", 0)), "FFFF00");
  assertEquals(fillOf(cellAt(ws, "Booked + Intransit to FBA", 0)), "FFFF00");
  assertEquals(fillOf(cellAt(ws, "skuid", 0)), null);

  // SKU blocks alternate light blue / white (A's 2 rows blue, B's row white).
  assertEquals(fillOf(cellAt(ws, "skuid", 1)), "BDD7EE");
  assertEquals(fillOf(cellAt(ws, "skuid", 2)), "BDD7EE");
  assertEquals(fillOf(cellAt(ws, "skuid", 3)), null);

  // Current stock > 0: pink fill, dark-red font (A Karnataka has 50).
  assertEquals(fillOf(cellAt(ws, "Current Stock PRESENT REGION WISE", 1)), "FFC7CE");
  assertEquals(fontColorOf(cellAt(ws, "Current Stock PRESENT REGION WISE", 1)), "9C0006");
  assertEquals(fillOf(cellAt(ws, "Current Stock PRESENT REGION WISE", 2)), "BDD7EE"); // 0 keeps the band

  // BOOKED / INTRANSIT > 0: green (B Delhi booked 2).
  assertEquals(fillOf(cellAt(ws, "BOOKED", 3)), "C6EFCE");
  assertEquals(fontColorOf(cellAt(ws, "BOOKED", 3)), "006100");
  assertEquals(fillOf(cellAt(ws, "INTRANSIT", 3)), null);

  // STOCK RUNS OUT IN < 31 days: red. A Karnataka = 1500 days stays on its band.
  assertEquals(cellAt(ws, "STOCK RUNS OUT IN", 1).v, 1500);
  assertEquals(fillOf(cellAt(ws, "STOCK RUNS OUT IN", 1)), "BDD7EE");
  assertEquals(cellAt(ws, "STOCK RUNS OUT IN", 3).v, 20);
  assertEquals(fillOf(cellAt(ws, "STOCK RUNS OUT IN", 3)), "FFC7CE");

  // Active date column > 0: yellow.
  assertEquals(fillOf(cellAt(ws, "22.09.2026", 2)), "FFEB9C");
  assertEquals(fontColorOf(cellAt(ws, "22.09.2026", 2)), "9C5700");

  // SKU-level totals are bold, like the manual sheet.
  assertEquals(cellAt(ws, "Total Order per SKUID (last month)", 1).s.font.bold, true);
});

Deno.test("To be sent lists only rows with a quantity to send, banded grey per SKU", () => {
  const ws = buildFbaForecastLayout(sampleInput()).Sheets[SHEET.toBeSent];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws);
  assertEquals(rows.map((r) => `${r["SKUID"]}:${r["ZONE"]}:${r["QUANTITY TO BE SENT"]}`), ["A:Delhi_zone:36", "B:Delhi_zone:10"]);
  assertEquals(fillOf(cellAt(ws, "SKUID", 1)), "D9D9D9");
  assertEquals(fillOf(cellAt(ws, "SKUID", 2)), null);
});

Deno.test("writeXlsxWithViews keeps every sheet and injects frozen panes", () => {
  const wb = buildFbaForecastLayout(sampleInput());
  const bytes = writeXlsxWithViews(wb);
  const back = XLSX.read(bytes, { type: "buffer" });
  assertEquals(back.SheetNames, wb.SheetNames);
  // deno-lint-ignore no-explicit-any
  const zip = (XLSX as any).CFB.read(bytes, { type: "buffer" });
  const idx = (zip.FullPaths as string[]).findIndex((p) => p.endsWith("xl/worksheets/sheet1.xml"));
  const xml = new TextDecoder().decode(zip.FileIndex[idx].content);
  assertEquals(/<pane xSplit="5" ySplit="1" topLeftCell="F2"[^>]*state="frozen"\/>/.test(xml), true);
});

Deno.test("with a manual plan: rows follow the plan's order and column X is shown like the manual", () => {
  const input = sampleInput();
  input.rows = computeFbaAnalysis(
    [{ sku: "B", zone: "Delhi_zone", quantity: 3 }, { sku: "A", zone: "Delhi_zone", quantity: 9 }],
    [],
    [],
    (sku) => `Product ${sku}`,
    [
      { sku: "B", zone: "Delhi_zone", stockToSend: 100, order: 0 },
      { sku: "B", zone: "Assam_zone", stockToSend: 100, order: 1 },
      { sku: "A", zone: "Delhi_zone", stockToSend: null, order: 2 },
    ],
  );
  const ws = buildFbaForecastLayout(input).Sheets[SHEET.analysis];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });
  // Plan order, not "top seller first".
  assertEquals(rows.map((r) => `${r["skuid"]}:${r["zone"]}`), ["B:Delhi_zone", "B:Assam_zone", "A:Delhi_zone"]);
  const X = "Stock present per SKU ID for FBA - booked";
  assertEquals(rows.map((r) => r[X]), [100, 100, ""]);
  assertEquals(fillOf(cellAt(ws, X, 0)), "FFFF00");
  // B: U = 12 (Delhi) + 5 (Assam) = 17 -> Delhi 12/17*100 capped at 12, Assam 5; A: X blank -> 0.
  assertEquals(rows.map((r) => r["to be sent (region wise)"]), [12, 5, 0]);
  assertEquals(rows.map((r) => r["stock to be ordered per SKUID"]), [17 - 100, 17 - 100, 36]);
});
