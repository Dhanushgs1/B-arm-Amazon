import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// The upload module reads Supabase through "@/lib/supabaseLazy". Alias that module to an in-memory fake so the
// real write path (mapping, dedupe, upsert, any delete) runs against a table store with the real unique keys.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_POSIX = path.resolve(HERE, "..").replace(/\\/g, "/");
const FAKE_POSIX = path.resolve(HERE, "testing", "fakeSupabaseLazy.ts").replace(/\\/g, "/");
const jiti = createJiti(import.meta.url, { alias: { "@/lib/supabaseLazy": FAKE_POSIX, "@/": `${SRC_POSIX}/` } });

type Row = Record<string, unknown>;
interface UploadModule {
  PRUNE_TO_UPLOAD_RANGE: Record<string, true>;
  ON_CONFLICT: Record<string, string>;
  uploadParsedRows: (type: string, rows: Record<string, string>[], fileName: string) => Promise<{ validRows: number; skippedRows: number }>;
  dayWriteOptions: { retryDelayMs: number; attempts: number };
}
type FakeCall = { op: string; table: string; filters: { col: string; op: string; val: unknown }[] };
interface FakeModule {
  resetFakeDb: () => void;
  rowsOf: (table: string) => Row[];
  calls: FakeCall[];
  faults: ((call: FakeCall & { payload?: Row[] }) => string | null)[];
}

const upload = (await jiti.import(`${SRC_POSIX}/lib/amazonReportUpload.ts`)) as UploadModule;
const fake = (await jiti.import(FAKE_POSIX)) as FakeModule;
const SP = "barm_amazon_sp_advertised_product";

// Parsed-row shape of an Amazon Sponsored Products "Advertised product" export (the keys the mapper reads).
interface SpLine { date: string; campaign: string; adGroup: string; sku: string; spend: number; units: number }
const line = (date: string, sku: string, units: number, spend = 100, campaign = "C1", adGroup = "AG1"): SpLine =>
  ({ date, campaign, adGroup, sku, spend, units });

function spRows(lines: SpLine[]): Record<string, string>[] {
  return lines.map((l) => ({
    "Date": l.date, "Portfolio name": "P", "Currency": "INR", "Campaign Name": l.campaign, "Ad Group Name": l.adGroup,
    "Country": "India", "Advertised SKU": l.sku, "Advertised ASIN": "B0TEST", "Impressions": "100", "Clicks": "10",
    "Click-Through Rate (CTR)": "0.1", "Cost Per Click (CPC)": "5", "Spend": String(l.spend), "7 Day Total Sales (₹)": "0",
    "Total Advertising Cost of Sales (ACOS)": "0", "Total Return on Advertising Spend (ROAS)": "0",
    "7 Day Total Orders (#)": "1", "7 Day Total Units (#)": String(l.units), "7 Day Conversion Rate": "0.1",
    "7 Day Advertised SKU Units (#)": String(l.units), "7 Day Other SKU Units (#)": "0",
  }));
}

const upSp = (lines: SpLine[], fileName = "Sponsored_Products_Advertised_product_report.xlsx") =>
  upload.uploadParsedRows("sp_advertised_product", spRows(lines), fileName);

async function seed(lines: SpLine[]): Promise<void> {
  await upSp(lines, "seed.xlsx");
}

const deletesOn = (table: string) => fake.calls.filter((c) => c.op === "delete" && c.table === table);
const snapshot = (table: string, from = "") =>
  JSON.stringify(fake.rowsOf(table).filter((r) => String(r.report_date) >= from).map((r) => [r.report_date, r.advertised_sku, r.units_7d, r.spend]).sort());

beforeEach(() => fake.resetFakeDb());

// Regression for the 28 Oct 2026 incident: a Sponsored Products upload covering 12–22 Oct pruned 10,910 rows of
// 23 Sep–11 Oct history. A partial historical upload must never delete any row.

test("Sponsored Products config never prunes rows outside the uploaded file", () => {
  assert.equal(upload.PRUNE_TO_UPLOAD_RANGE[SP], undefined);
});

test("Sponsored Products keys on the stable 4-field upsert key", () => {
  assert.equal(upload.ON_CONFLICT.sp_advertised_product, "report_date,campaign_name,ad_group_name,advertised_sku");
});

test("partial historical upload (23 Sep–11 Oct) keeps every 12–22 Oct row and issues no delete", async () => {
  await seed([line("2026-10-12", "A1", 3, 50), line("2026-10-20", "A1", 7, 75), line("2026-10-22", "B2", 9, 90, "C2", "AG2")]);
  const baseline = snapshot(SP, "2026-10-12");

  await upSp([line("2026-09-23", "A1", 4), line("2026-10-11", "A1", 6)]);

  assert.equal(deletesOn(SP).length, 0, "no delete may run for a Sponsored Products upload");
  assert.equal(snapshot(SP, "2026-10-12"), baseline, "the 12–22 Oct rows are unchanged");
  assert.equal(fake.rowsOf(SP).length, 5, "3 existing rows + 2 new historical rows");
});

test("overlapping keys update in place and new keys insert, without duplicating", async () => {
  await seed([line("2026-10-12", "A1", 3, 50), line("2026-10-20", "A1", 7, 75)]);

  // Same key as 12 Oct (updated units and spend), plus a new key on 11 Oct (inserted).
  const result = await upSp([line("2026-10-12", "A1", 11, 60), line("2026-10-11", "A1", 2, 20)]);

  assert.equal(result.validRows, 2);
  const rows = fake.rowsOf(SP);
  assert.equal(rows.length, 3, "2 existing + 1 new; the overlapping key is updated, not duplicated");
  const updated = rows.find((r) => r.report_date === "2026-10-12");
  assert.equal(updated?.units_7d, 11);
  assert.equal(updated?.spend, 60);
  assert.ok(rows.some((r) => r.report_date === "2026-10-11"), "new key inserted");
  assert.equal(deletesOn(SP).length, 0);
});

test("duplicate keys inside one file are merged before the write, so the table keeps one row per key", async () => {
  // Two lines share one key; the upload sums their summable fields rather than failing or inserting twice.
  await upSp([line("2026-10-12", "A1", 3, 50), line("2026-10-12", "A1", 4, 25)]);

  const rows = fake.rowsOf(SP);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].units_7d, 7);
  assert.equal(rows[0].spend, 75);
});

test("re-uploading the same partial file twice leaves the table unchanged", async () => {
  const lines = () => [line("2026-10-01", "A1", 5, 40), line("2026-10-02", "A1", 6, 45)];
  await upSp(lines());
  const once = snapshot(SP);
  await upSp(lines());
  assert.equal(snapshot(SP), once);
  assert.equal(fake.rowsOf(SP).length, 2);
});

test("a file with no valid rows writes nothing and deletes nothing", async () => {
  await seed([line("2026-10-12", "A1", 3, 50)]);
  const before = snapshot(SP);
  const blank = [{ "Date": "", "Campaign Name": "", "Ad Group Name": "", "Advertised SKU": "" }];
  const result = await upload.uploadParsedRows("sp_advertised_product", blank, "blank.xlsx");
  assert.equal(result.validRows, 0);
  assert.equal(snapshot(SP), before);
  assert.equal(deletesOn(SP).length, 0);
});

// Amazon Orders is intentionally unchanged in this pass: it still prunes outside the uploaded file's span.
// That is the same kind of loss, and it needs its own decision with evidence before it changes.
test("Amazon Orders prune is unchanged in this pass and is listed for a separate decision", () => {
  assert.equal(upload.PRUNE_TO_UPLOAD_RANGE.am_orders, true);
});

// ── Inventory ledger ──────────────────────────────────────────────────────────────────────────────
// A full ledger file (~100 days × ~1,300 rows) used to clear its whole date range in ONE delete, which hit
// the database's 3-second statement timeout; on 26 Nov 2026 even single-day deletes timed out. The upload
// now goes day by day, writes first, and removes only the rows the file no longer has.
const LEDGER = "barm_amazon_inventory_ledger";
interface LedgerLine { date: string; msku: string; end: number }
function ledgerRows(lines: LedgerLine[]): Record<string, string>[] {
  return lines.map((l) => ({
    "Date": l.date, "FNSKU": `X-${l.msku}`, "ASIN": "B0TEST", "MSKU": l.msku, "Title": "T", "Disposition": "SELLABLE",
    "Starting Warehouse Balance": "0", "Ending Warehouse Balance": String(l.end), "Customer Shipments": "0",
    "Customer Returns": "0", "Location": "BLR7",
  }));
}
const upLedger = (lines: LedgerLine[]) => upload.uploadParsedRows("inventory_ledger", ledgerRows(lines), "ledger.csv");
/** [date, msku, ending balance] per stored row, sorted — a duplicate would show as a repeated entry. */
const ledgerState = (keep: (r: Row) => boolean = () => true) =>
  JSON.stringify(fake.rowsOf(LEDGER).filter(keep).map((r) => [r.ledger_date, r.msku, r.ending_balance]).sort());
const expectRows = (rows: (string | number)[][]) => JSON.stringify([...rows].sort());
const onDay = (d: string) => (r: Row) => r.ledger_date === d;
const TIMEOUT = "canceling statement due to statement timeout";
const savesDay = (c: FakeCall & { payload?: Row[] }, d: string) =>
  c.op === "upsert" && c.table === LEDGER && (c.payload ?? []).some((r) => r.ledger_date === d);

// On file before: 29 Oct and 5 Nov (outside the next file), 1–3 Nov (inside it).
const OLD: LedgerLine[] = [
  { date: "10/29/2026", msku: "A", end: 90 },
  { date: "11/01/2026", msku: "A", end: 10 }, { date: "11/01/2026", msku: "B", end: 11 },
  { date: "11/02/2026", msku: "A", end: 20 }, { date: "11/02/2026", msku: "B", end: 21 },
  { date: "11/03/2026", msku: "A", end: 30 },
  { date: "11/05/2026", msku: "A", end: 50 },
];
// The new file covers 1–3 Nov: values changed, 2 Nov B no longer in Amazon's file, 3 Nov C new.
const NEW: LedgerLine[] = [
  { date: "11/01/2026", msku: "A", end: 15 }, { date: "11/01/2026", msku: "B", end: 16 },
  { date: "11/02/2026", msku: "A", end: 25 },
  { date: "11/03/2026", msku: "A", end: 35 }, { date: "11/03/2026", msku: "C", end: 36 },
];
const AFTER_NEW = [
  ["2026-10-29", "A", 90],
  ["2026-11-01", "A", 15], ["2026-11-01", "B", 16],
  ["2026-11-02", "A", 25],
  ["2026-11-03", "A", 35], ["2026-11-03", "C", 36],
  ["2026-11-05", "A", 50],
];
const outsideFile = (r: Row) => String(r.ledger_date) < "2026-11-01" || String(r.ledger_date) > "2026-11-03";
/** Full stored rows (ids included), so "unchanged" means the very same rows, not equal-looking copies. */
const exactRows = (keep: (r: Row) => boolean) => JSON.stringify(fake.rowsOf(LEDGER).filter(keep));

beforeEach(() => {
  upload.dayWriteOptions.retryDelayMs = 0;
});

test("ledger upload replaces the file's days and leaves every date outside the file unchanged (same ids, same values)", async () => {
  await upLedger(OLD);
  const outsideBefore = exactRows(outsideFile);
  await upLedger(NEW);
  assert.equal(ledgerState(), expectRows(AFTER_NEW));
  assert.equal(exactRows(outsideFile), outsideBefore);
});

test("ledger upload never deletes a date range, only the ids of rows the file no longer has", async () => {
  await upLedger(OLD);
  fake.calls.length = 0;
  await upLedger(NEW);
  const deletes = deletesOn(LEDGER);
  assert.equal(deletes.length, 1, "only 2 Nov B is gone from the file");
  assert.deepEqual(deletes[0].filters.map((f) => [f.col, f.op]), [["id", "in"]]);
});

test("ledger: uploading the same file again adds nothing and deletes nothing", async () => {
  await upLedger(OLD);
  await upLedger(NEW);
  const state = ledgerState();
  fake.calls.length = 0;
  await upLedger(NEW);
  assert.equal(ledgerState(), state);
  assert.equal(fake.rowsOf(LEDGER).length, AFTER_NEW.length);
  assert.equal(deletesOn(LEDGER).length, 0);
});

test("ledger: a day inside the file's range with no rows in the file is cleared, as before", async () => {
  await upLedger(OLD);
  await upLedger([{ date: "11/01/2026", msku: "A", end: 1 }, { date: "11/03/2026", msku: "A", end: 3 }]);
  assert.equal(ledgerState(onDay("2026-11-02")), "[]");
  assert.equal(ledgerState(onDay("2026-11-05")), expectRows([["2026-11-05", "A", 50]]));
});

test("ledger partial failure: a save that keeps timing out stops the upload and loses no existing row", async () => {
  await upLedger(OLD);
  const outsideBefore = exactRows(outsideFile);
  const nov2Before = exactRows(onDay("2026-11-02"));
  const nov3Before = exactRows(onDay("2026-11-03"));
  fake.faults.push((c) => (savesDay(c, "2026-11-02") ? TIMEOUT : null));
  await assert.rejects(upLedger(NEW), /Upload stopped on 2026-11-02: .*2026-11-01 to 2026-11-01 are fully saved.*Upload the same file again/);
  assert.equal(ledgerState(onDay("2026-11-01")), expectRows([["2026-11-01", "A", 15], ["2026-11-01", "B", 16]]), "1 Nov done");
  assert.equal(exactRows(onDay("2026-11-02")), nov2Before, "2 Nov kept its rows exactly");
  assert.equal(exactRows(onDay("2026-11-03")), nov3Before, "3 Nov not touched");
  assert.equal(exactRows(outsideFile), outsideBefore, "dates outside the file not touched");
});

test("ledger partial failure when the first day fails says no day was saved", async () => {
  await upLedger(OLD);
  fake.faults.push((c) => (savesDay(c, "2026-11-01") ? TIMEOUT : null));
  await assert.rejects(upLedger(NEW), /Upload stopped on 2026-11-01: .*no day was fully saved yet/);
});

test("ledger retry after a failed clean-up: nothing is lost, and uploading the same file again finishes with no duplicates", async () => {
  await upLedger(OLD);
  fake.faults.push((c) => (c.op === "delete" && c.table === LEDGER ? TIMEOUT : null));
  await assert.rejects(upLedger(NEW), /Upload stopped on 2026-11-02/);
  assert.equal(ledgerState(onDay("2026-11-02")), expectRows([["2026-11-02", "A", 25], ["2026-11-02", "B", 21]]), "new A saved, old B still there");
  fake.faults.length = 0;
  await upLedger(NEW);
  assert.equal(ledgerState(), expectRows(AFTER_NEW));
});

test("ledger retry after a failed save: uploading the same file again gives exactly the file's rows", async () => {
  await upLedger(OLD);
  fake.faults.push((c) => (savesDay(c, "2026-11-03") ? TIMEOUT : null));
  await assert.rejects(upLedger(NEW), /Upload stopped on 2026-11-03/);
  fake.faults.length = 0;
  await upLedger(NEW);
  assert.equal(ledgerState(), expectRows(AFTER_NEW));
});

test("ledger: a brief timeout is retried automatically and the upload succeeds", async () => {
  await upLedger(OLD);
  let failures = 2; // attempts are 3
  fake.faults.push((c) => (c.op !== "select" && c.table === LEDGER && failures-- > 0 ? TIMEOUT : null));
  await upLedger(NEW);
  assert.equal(ledgerState(), expectRows(AFTER_NEW));
});

test("ledger: a failed id read is retried too", async () => {
  await upLedger(OLD);
  let failures = 1;
  fake.faults.push((c) => (c.op === "select" && c.table === LEDGER && failures-- > 0 ? TIMEOUT : null));
  await upLedger(NEW);
  assert.equal(ledgerState(), expectRows(AFTER_NEW));
});

test("ledger: a save that went through but whose response was lost is retried without duplicates", async () => {
  await upLedger(OLD);
  let lost = 1;
  fake.faults.push((c) => (c.op === "upsert" && c.table === LEDGER && lost-- > 0 ? "LOST: Failed to fetch" : null));
  await upLedger(NEW);
  assert.equal(ledgerState(), expectRows(AFTER_NEW));
});

test("ledger writes stay small: at most 300 rows per save, each save within one day", async () => {
  const many: LedgerLine[] = [];
  for (let i = 0; i < 700; i++) many.push({ date: "11/01/2026", msku: `S${i}`, end: i });
  for (let i = 0; i < 10; i++) many.push({ date: "11/02/2026", msku: `S${i}`, end: i });
  const sizes: number[] = [];
  const days: number[] = [];
  fake.faults.push((c) => {
    if (c.op === "upsert" && c.table === LEDGER) {
      sizes.push(c.payload?.length ?? 0);
      days.push(new Set((c.payload ?? []).map((r) => r.ledger_date)).size);
    }
    return null;
  });
  await upLedger(many);
  assert.deepEqual(sizes, [300, 300, 100, 10]);
  assert.ok(days.every((n) => n === 1));
  assert.equal(fake.rowsOf(LEDGER).length, 710);
});
