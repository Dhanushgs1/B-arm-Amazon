import test from "node:test";
import assert from "node:assert/strict";
import { parseSellerFlexCsv, normalizeSku } from "./sellerFlexShipments.ts";

const HEADER =
  "Shipment Creation Date,Shipment ID,shipment Type,SKU,MSKU,ASIN,Custom ID,Title,Shipment Tracking ID,Customer Order ID,Units,Status,Order Value,ExSD,Assigned to picklist,Packed,Actual Shipout Date,Hazmat,Serial Number,Expiry,Gift Msg,Gift Wrap,Is Fast Track,Channel";
const row = (date: string, id: string, msku: string, status: string, units = "1", title = "Title") =>
  `${date},${id},Customer,EclaRKfbSZ,${msku},B0FLDV74P3,,"${title}",,405-8613415-4304341,${units},${status},554.00,19-Nov-2026 02:00 PM,,,,False,False,,False,False,False,FBA`;

test("parses the VSNC header and a quoted title with commas", () => {
  const csv = [HEADER, row("17-Nov-2026", "TVsy7bDps", "B-INSEM-KIT-PK5-3", "Confirmed", "1", "B-Arm Self Insemination Kit, Pack of 5"), row("16-Nov-2026", "T3RF9ND9s", "SC-LACTO-STR-PK25", "Manifested", "2")].join("\n");
  const { rows } = parseSellerFlexCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].sku, "B-INSEM-KIT-PK5-3");
  assert.equal(rows[0].units, 1);
  assert.equal(rows[0].status, "Confirmed");
  assert.equal(rows[0].shipment_creation_date, "2026-11-17");
  assert.equal(rows[0].shipment_id, "TVsy7bDps");
  assert.equal(rows[0].customer_order_id, "405-8613415-4304341");
  assert.equal(rows[0].asin, "B0FLDV74P3");
  assert.equal(rows[0].channel, "FBA");
  assert.equal(rows[0].raw["Title"], "B-Arm Self Insemination Kit, Pack of 5");
  assert.equal(rows[1].units, 2);
});

test("keeps the last row when a shipment_id+sku repeats in one file", () => {
  const csv = [HEADER, row("17-Nov-2026", "T1", "A019", "Confirmed"), row("17-Nov-2026", "T1", "A019", "Cancelled")].join("\n");
  const { rows } = parseSellerFlexCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "Cancelled");
});

test("skips rows without Shipment ID or a parseable date", () => {
  const csv = [HEADER, row("17-Nov-2026", "", "A019", "Confirmed"), row("not a date", "T2", "A019", "Confirmed"), row("01-Aug-2026", "T3", "A019", "Confirmed")].join("\n");
  const r = parseSellerFlexCsv(csv);
  assert.equal(r.rows.length, 1);
  assert.equal(r.skipped, 2);
});

test("minDate/maxDate span the file", () => {
  const csv = [HEADER, row("17-Nov-2026", "T1", "A", "Confirmed"), row("01-Aug-2026", "T2", "B", "Confirmed"), row("09-Sep-2026", "T3", "C", "Confirmed")].join("\n");
  const r = parseSellerFlexCsv(csv);
  assert.equal(r.minDate, "2026-08-01");
  assert.equal(r.maxDate, "2026-11-17");
});

test("normalizeSku strips U+200E, trims and lowercases", () => {
  assert.equal(normalizeSku("‎B-VD-PLAS-TPE "), "b-vd-plas-tpe");
  assert.equal(normalizeSku("﻿ A019​"), "a019");
});

// Shared with scripts/fc-forecast-rpc-check.mjs, which runs the same list through SQL fc_norm_sku().
export const SKU_NORM_FIXTURES: [string, string][] = [
  ["\u200EB-VD-PLAS-TPE ", "b-vd-plas-tpe"],
  ["\tA019\r\n", "a019"],
  ["B-XYZ\u00A0", "b-xyz"],
  ["\uFEFF\u3000SC25\u2009", "sc25"],
  ["B-MID SPACE", "b-mid space"],
];

test("normalizeSku strips tabs, CR/LF, NBSP and other edge whitespace like SQL fc_norm_sku", () => {
  for (const [input, want] of SKU_NORM_FIXTURES) assert.equal(normalizeSku(input), want, JSON.stringify(input));
});
