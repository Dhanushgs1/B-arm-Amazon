import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { forecastDate, importVerifiedForecast, isSettled, runLogVerdict, sizeVerdict, SETTLE_MS, type FbaDeps, type FbaFile } from "./marketing360FbaImport.ts";
import { enabledSources, folderQuery } from "./marketing360DriveRules.ts";

const NOW = Date.parse("2026-11-26T06:00:00Z");
const passRow = (date: string, file = `FBA Forecasting ${date}.xlsx`, rows = 4) =>
  ({ "Timestamp (IST)": `${date} 11:35 IST`, Date: date, "Forecast file": `${file} (built 10:05 IST)`, Validation: `PASS (raw, cleaned, tracker, forecast); xlsx opens, ${rows} data rows`, Status: "PASS", "Failure reason": "" });

function workbook(opts: { skus?: string[]; fcDates?: string[] } = {}): Buffer {
  const skus = opts.skus ?? ["A1", "B2"];
  const wb = XLSX.utils.book_new();
  const head = ["SKUID", "Product Name", "Zone", "Total orders in last 30 days", "75 days forecast (region)", "Current stock present region", "Booked", "Intransit", "To be send", "Stock runs out", "35 days forecast", "35D shortfall", "35D alert"];
  const rows = skus.flatMap((s) => ["South", "North"].map((z) => [s, `Product ${s}`, z, 3, 10, 5, 0, 0, 2, 20, 6, 0, "OK"]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head, ...rows]), "FBA analysis");
  const fcDates = opts.fcDates ?? ["2026-11-24"];
  const stock = fcDates.flatMap((d, i) => [{ Date: d, "Fulfillment Center": `MAA${i + 4}`, MSKU: "A1", Disposition: "SELLABLE", ASIN: "B0X", ZONE: "South", "Ending Warehouse Balance": 7 }]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(stock), "FBA_stock");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

function deps(over: Partial<FbaDeps> & { files?: FbaFile[]; log?: Record<string, unknown>[]; book?: Buffer } = {}) {
  const calls = { replace: [] as unknown[][], marked: [] as string[] };
  const d: FbaDeps = {
    now: () => NOW,
    listOutput: async () => over.files ?? [{ id: "f26", name: "FBA Forecasting 2026-11-26.xlsx", modifiedTime: "2026-11-26T04:35:00Z" }],
    download: async () => over.book ?? workbook(),
    runLogRows: async () => over.log ?? [passRow("2026-11-25"), passRow("2026-11-26")],
    previousCounts: async () => ({ zones: 4, skus: 2, fc: 0 }),
    replace: async (date, zones, fc) => { calls.replace.push([date, zones, fc]); return { zones: zones.length, fc: fc.length, fc_dates: [...new Set(fc.map((r) => r.report_date))] }; },
    imported: {},
    markImported: (f) => { calls.marked.push(f.id); },
    ...over,
  };
  return { d, calls };
}

test("only the exact daily file name carries a forecast date", () => {
  assert.equal(forecastDate("FBA Forecasting 2026-11-25.xlsx"), "2026-11-25");
  assert.equal(forecastDate("2026-11-24 1102 - FBA Forecasting 2026-11-24.xlsx"), null);
  assert.equal(forecastDate("FBA Forecasting 2026-11-25 (1).xlsx"), null);
  assert.equal(forecastDate("FBA Forecasting Run Log"), null);
});

test("a file changed in the last 15 minutes is not settled", () => {
  assert.equal(isSettled({ modifiedTime: new Date(NOW - SETTLE_MS + 1000).toISOString() }, NOW), false);
  assert.equal(isSettled({ modifiedTime: new Date(NOW - SETTLE_MS).toISOString() }, NOW), true);
  assert.equal(isSettled({ modifiedTime: "not a date" }, NOW), false);
});

test("run log: the LATEST row for the date must be PASS and name the file", () => {
  const f = "FBA Forecasting 2026-11-26.xlsx";
  assert.equal(runLogVerdict([], "2026-11-26", f).ok, false);
  assert.match(runLogVerdict([passRow("2026-11-25")], "2026-11-26", f).reason, /no row for 2026-11-26/);
  const fail = { ...passRow("2026-11-26"), Status: "FAIL", "Failure reason": "stale raw file" };
  assert.match(runLogVerdict([fail], "2026-11-26", f).reason, /FAIL \(stale raw file\)/);
  assert.equal(runLogVerdict([fail, passRow("2026-11-26")], "2026-11-26", f).ok, true, "a later PASS re-run supersedes an earlier FAIL");
  assert.equal(runLogVerdict([passRow("2026-11-26"), fail], "2026-11-26", f).ok, false, "a later FAIL holds the import");
  assert.match(runLogVerdict([passRow("2026-11-26", "FBA Forecasting 2026-11-25.xlsx")], "2026-11-26", f).reason, /names/);
  assert.match(runLogVerdict([passRow("2026-11-26", f, 4270)], "2026-11-26", f, 4000).reason, /4270 data rows, the file has 4000/);
  assert.equal(runLogVerdict([passRow("2026-11-26", f, 4270)], "2026-11-26", f, 4270).ok, true);
});

test("run log dates may come as real dates or sheet serials", () => {
  const f = "FBA Forecasting 2026-11-26.xlsx";
  assert.equal(runLogVerdict([{ ...passRow("2026-11-26"), Date: new Date("2026-11-26T00:00:00Z") }], "2026-11-26", f).ok, true);
  assert.equal(runLogVerdict([{ ...passRow("2026-11-26"), Date: 46352 }], "2026-11-26", f).ok, true);
});

test("size: refuse an empty or much smaller file than last time", () => {
  assert.equal(sizeVerdict({ zones: 4270, skus: 305, fc: 1558 }, { zones: 4270, skus: 305, fc: 0 }).ok, true);
  assert.equal(sizeVerdict({ zones: 4270, skus: 305, fc: 1558 }, null).ok, true);
  assert.match(sizeVerdict({ zones: 3000, skus: 305, fc: 1558 }, { zones: 4270, skus: 305, fc: 0 }).reason, /only 3000 zone rows/);
  assert.match(sizeVerdict({ zones: 4270, skus: 200, fc: 1558 }, { zones: 4270, skus: 305, fc: 0 }).reason, /only 200 SKUs/);
  assert.match(sizeVerdict({ zones: 4270, skus: 305, fc: 0 }, null).reason, /no FBA_stock rows/);
  assert.match(sizeVerdict({ zones: 0, skus: 0, fc: 5 }, null).reason, /no FBA analysis rows/);
});

test("only the FBA forecast runs unless other sources are named", () => {
  assert.deepEqual(enabledSources(undefined).map((s) => s.key), ["forecast"]);
  assert.deepEqual(enabledSources("").map((s) => s.key), ["forecast"]);
  assert.deepEqual(enabledSources("forecast, rating, bogus").map((s) => s.key), ["rating", "forecast"]);
  assert.equal(folderQuery("1nXx'jG or 1=1"), "'1nXxjGor11' in parents and trashed = false and mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'");
});

test("flow: a verified, settled file replaces its day once", async () => {
  const { d, calls } = deps();
  const r = await importVerifiedForecast(d);
  assert.equal(r.status, "imported", r.reason);
  assert.equal(r.forecastDate, "2026-11-26");
  assert.deepEqual(r.fcDates, ["2026-11-24"], "FC balance date comes from inside the file, not the file name");
  assert.equal(calls.replace.length, 1);
  assert.equal(calls.replace[0][0], "2026-11-26");
  assert.equal((calls.replace[0][1] as object[]).length, 4);
  assert.ok(!("report_date" in (calls.replace[0][1] as object[])[0]), "zone rows are sent without a date; the function stamps it");
  assert.deepEqual(calls.marked, ["f26"]);
});

test("flow: the same Drive version is never imported twice", async () => {
  const { d, calls } = deps({ imported: { f26: "2026-11-26T04:35:00Z" } });
  assert.equal((await importVerifiedForecast(d)).status, "unchanged");
  assert.equal(calls.replace.length, 0);
});

test("flow: a newer Drive version of the same file is imported again (replace, no duplicates)", async () => {
  const { d, calls } = deps({ imported: { f26: "2026-11-26T04:00:00Z" } });
  assert.equal((await importVerifiedForecast(d)).status, "imported");
  assert.equal(calls.replace.length, 1);
});

test("flow: held and nothing written when a check fails", async () => {
  const cases: [string, Partial<FbaDeps> & { files?: FbaFile[]; log?: Record<string, unknown>[]; book?: Buffer }, string, RegExp][] = [
    ["still being written", { files: [{ id: "f26", name: "FBA Forecasting 2026-11-26.xlsx", modifiedTime: new Date(NOW - 60_000).toISOString() }] }, "waiting", /less than 15 min/],
    ["no PASS in the run log", { log: [passRow("2026-11-25")] }, "held", /no row for 2026-11-26/],
    ["run log FAIL", { log: [{ ...passRow("2026-11-26"), Status: "FAIL" }] }, "held", /FAIL/],
    ["row count differs from the run log", { log: [passRow("2026-11-26", undefined, 999)] }, "held", /999 data rows/],
    ["much smaller than last time", { previousCounts: async () => ({ zones: 40, skus: 20, fc: 0 }) }, "held", /only 4 zone rows/],
    ["two FC balance dates", { book: workbook({ fcDates: ["2026-11-23", "2026-11-24"] }) }, "held", /2 balance dates/],
    ["FC date after the forecast", { book: workbook({ fcDates: ["2026-11-27"] }) }, "held", /after the forecast date/],
    ["not a forecast workbook", { book: (() => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["x"]]), "Sheet1"); return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer; })() }, "held", /not an FBA forecast workbook/],
    ["download error", { download: async () => { throw new Error("Drive download failed (500)"); } }, "failed", /500/],
  ];
  for (const [label, over, status, reason] of cases) {
    const { d, calls } = deps(over);
    const r = await importVerifiedForecast(d);
    assert.equal(r.status, status, `${label}: ${r.reason}`);
    assert.match(r.reason, reason, label);
    assert.equal(calls.replace.length, 0, `${label}: nothing written`);
    assert.equal(calls.marked.length, 0, `${label}: not recorded, so it is retried next run`);
  }
});

test("flow: dry run checks everything but writes and records nothing", async () => {
  const { d, calls } = deps();
  const r = await importVerifiedForecast(d, { dry: true });
  assert.equal(r.status, "would-import", r.reason);
  assert.deepEqual(r.counts, { zones: 4, skus: 2, fc: 1 });
  assert.equal(calls.replace.length + calls.marked.length, 0);
});

test("flow: only the newest dated file in the folder is considered; copies are ignored", async () => {
  const { d, calls } = deps({ files: [
    { id: "copy", name: "2026-11-27 1102 - FBA Forecasting 2026-11-27.xlsx", modifiedTime: "2026-11-26T05:00:00Z" },
    { id: "f25", name: "FBA Forecasting 2026-11-25.xlsx", modifiedTime: "2026-11-26T05:00:00Z" },
    { id: "f26", name: "FBA Forecasting 2026-11-26.xlsx", modifiedTime: "2026-11-26T04:35:00Z" },
  ] });
  const r = await importVerifiedForecast(d);
  assert.equal(r.file, "FBA Forecasting 2026-11-26.xlsx");
  assert.equal(calls.replace[0][0], "2026-11-26");
});
