import test from "node:test";
import assert from "node:assert/strict";
import { DRIVE_SOURCES, pickFiles, needsImport, downloadPath, importName, driveQuery, SHEET_MIME, XLSX_MIME } from "./marketing360DriveRules.ts";

const src = (k: string) => DRIVE_SOURCES.find((s) => s.key === k)!;
const f = (name: string, modifiedTime: string, mimeType = SHEET_MIME, id = name) => ({ id, name, mimeType, modifiedTime });

test("rating: newest real weekly file, copies skipped", () => {
  const out = pickFiles(src("rating"), [
    f("AM FK Rating and Review - 16 Nov 2026", "2026-11-16T10:00:00Z"),
    f("AM FK Rating and Review - 23 Nov 2026 (compact reduced)", "2026-11-23T11:00:00Z"),
    f("AM FK Rating and Review - 23 Nov 2026", "2026-11-23T10:45:00Z"),
  ]);
  assert.deepEqual(out.map((x) => x.name), ["AM FK Rating and Review - 23 Nov 2026"]);
});

test("forecast: the locked daily file, not the dated copies", () => {
  const out = pickFiles(src("forecast"), [
    f("2026-11-24 1102 - FBA Forecasting 2026-11-24.xlsx", "2026-11-25T04:35:23Z", XLSX_MIME),
    f("FBA Forecasting 2026-11-25.xlsx", "2026-11-25T04:35:18Z", XLSX_MIME),
    f("FBA Forecasting Run Log", "2026-11-25T06:22:00Z"),
  ]);
  assert.deepEqual(out.map((x) => x.name), ["FBA Forecasting 2026-11-25.xlsx"]);
});

test("positions: every category tracker", () => {
  const out = pickFiles(src("positions"), [
    f("BARM_Gyno_Competitor_Position_Tracker", "2026-11-25T05:05:00Z"),
    f("BARM_OT_Pulmonology_General_Competitor_Position_Tracker", "2026-11-24T05:27:00Z"),
    f("BARM_Competitor_Position_Tracking_append_2026-11-23.csv", "2026-11-23T07:40:00Z"),
  ]);
  assert.equal(out.length, 2);
});

test("import only when Drive's copy changed", () => {
  const file = f("x", "2026-11-24T04:09:48Z");
  assert.equal(needsImport(file, {}), true);
  assert.equal(needsImport(file, { x: "2026-11-24T04:09:48Z" }), false);
  assert.equal(needsImport(file, { x: "2026-11-18T00:00:00Z" }), true);
});

test("sheets are exported, xlsx downloaded; the import name carries .xlsx", () => {
  assert.match(downloadPath(f("a", "t")), /\/export\?mimeType=/);
  assert.match(downloadPath(f("b.xlsx", "t", XLSX_MIME)), /alt=media/);
  assert.equal(importName(f("AM FK Rating and Review - 23 Nov 2026", "t")), "AM FK Rating and Review - 23 Nov 2026.xlsx");
  assert.match(driveQuery({ ...src("rating"), nameContains: "it's" }), /name contains 'it\\'s'/);
});
