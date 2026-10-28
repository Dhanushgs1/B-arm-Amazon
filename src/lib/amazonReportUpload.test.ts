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
}
interface FakeModule {
  resetFakeDb: () => void;
  rowsOf: (table: string) => Row[];
  calls: { op: string; table: string }[];
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
