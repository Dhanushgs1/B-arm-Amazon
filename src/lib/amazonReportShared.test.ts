import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// amazonReportShared imports the upload module, which reads Supabase through "@/lib/supabaseLazy". Alias that to the
// in-memory fake so fetchAllRows and the chunked fetch run for real against a table store.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_POSIX = path.resolve(HERE, "..").replace(/\\/g, "/");
const FAKE_POSIX = path.resolve(HERE, "testing", "fakeSupabaseLazy.ts").replace(/\\/g, "/");
const jiti = createJiti(import.meta.url, { alias: { "@/lib/supabaseLazy": FAKE_POSIX, "@/": `${SRC_POSIX}/` } });

type Row = Record<string, unknown>;
interface SharedModule {
  dateChunks: (start: string, end: string, chunkDays: number) => { start: string; end: string }[];
  fetchAllRows: (table: string, apply: (q: unknown) => unknown, orderBy?: string | string[]) => Promise<Row[]>;
  fetchAllRowsByDateChunks: (table: string, dateCol: string, start: string, end: string, extra?: (q: unknown) => unknown, chunkDays?: number) => Promise<Row[]>;
}
interface FakeModule {
  resetFakeDb: () => void;
  tables: Map<string, Row[]>;
  calls: { op: string; table: string; filters: { col: string; op: string; val: unknown }[] }[];
}

const shared = (await jiti.import(`${SRC_POSIX}/lib/amazonReportShared.ts`)) as SharedModule;
const fake = (await jiti.import(FAKE_POSIX)) as FakeModule;
const TABLE = "barm_amazon_sp_advertised_product";

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** A seeded table: `perDay` rows on each day from `start` to `end`, unique ids, some days with no rows. */
function seed(start: string, end: string, perDay: number, skipDays: string[] = []): void {
  fake.resetFakeDb();
  const rows: Row[] = [];
  let id = 1;
  for (let d = start; d <= end; d = addDays(d, 1)) {
    if (skipDays.includes(d)) continue;
    for (let k = 0; k < perDay; k++) {
      rows.push({ id: id++, report_date: d, campaign_name: `C${k % 5}`, ad_group_name: `AG${k % 3}`, advertised_sku: `S${k}`, spend: 10 + k, units_7d: k % 7 });
    }
  }
  fake.tables.set(TABLE, rows);
}

const ids = (rows: Row[]) => rows.map((r) => r.id as number);
const spend = (rows: Row[]) => rows.reduce((s, r) => s + Number(r.spend), 0);

beforeEach(() => fake.resetFakeDb());

// ── dateChunks: boundaries and coverage ────────────────────────────────────

test("dateChunks covers the range exactly once, in order, with no gaps or overlaps", () => {
  const c = shared.dateChunks("2026-09-23", "2026-10-22", 7);
  assert.equal(c[0].start, "2026-09-23");
  assert.equal(c[c.length - 1].end, "2026-10-22");
  for (let i = 0; i < c.length; i++) {
    if (i > 0) assert.equal(c[i].start, addDays(c[i - 1].end, 1), "next window starts the day after the previous one ends");
    assert.ok(c[i].start <= c[i].end);
  }
  const days = c.reduce((s, w) => s + (new Date(`${w.end}T00:00:00Z`).getTime() - new Date(`${w.start}T00:00:00Z`).getTime()) / 86400000 + 1, 0);
  assert.equal(days, 30, "30 days in 23 Sep–22 Oct");
});

test("dateChunks windows are at most chunkDays long", () => {
  for (const w of shared.dateChunks("2026-09-23", "2026-10-22", 7)) {
    const len = (new Date(`${w.end}T00:00:00Z`).getTime() - new Date(`${w.start}T00:00:00Z`).getTime()) / 86400000 + 1;
    assert.ok(len <= 7);
  }
});

test("a single-day range is one window", () => {
  assert.deepEqual(shared.dateChunks("2026-10-11", "2026-10-11", 7), [{ start: "2026-10-11", end: "2026-10-11" }]);
});

test("a range shorter than one chunk is one window", () => {
  assert.deepEqual(shared.dateChunks("2026-10-01", "2026-10-03", 7), [{ start: "2026-10-01", end: "2026-10-03" }]);
});

test("end before start gives no windows", () => {
  assert.deepEqual(shared.dateChunks("2026-10-22", "2026-10-01", 7), []);
});

test("windows split exactly on the chunk size at month end", () => {
  assert.deepEqual(shared.dateChunks("2026-10-29", "2026-11-05", 7), [{ start: "2026-10-29", end: "2026-11-04" }, { start: "2026-11-05", end: "2026-11-05" }]);
});

// ── fetchAllRowsByDateChunks: same rows as one fetch ─────────────────────────

test("chunked fetch returns exactly the rows of one unchunked fetch over the same range", async () => {
  seed("2026-09-20", "2026-10-25", 40);
  const single = await shared.fetchAllRows(TABLE, (q) => (q as { gte: (c: string, v: string) => { lte: (c: string, v: string) => unknown } }).gte("report_date", "2026-09-23").lte("report_date", "2026-10-22"));
  const chunked = await shared.fetchAllRowsByDateChunks(TABLE, "report_date", "2026-09-23", "2026-10-22");
  assert.equal(chunked.length, single.length);
  assert.deepEqual([...ids(chunked)].sort((a, b) => a - b), [...ids(single)].sort((a, b) => a - b));
  assert.equal(spend(chunked), spend(single));
});

test("chunked fetch returns no row twice, and no row outside the range", async () => {
  seed("2026-09-20", "2026-10-25", 3);
  const rows = await shared.fetchAllRowsByDateChunks(TABLE, "report_date", "2026-09-23", "2026-10-22");
  assert.equal(new Set(ids(rows)).size, rows.length, "no duplicate ids");
  assert.ok(rows.every((r) => String(r.report_date) >= "2026-09-23" && String(r.report_date) <= "2026-10-22"), "every row inside the range");
  const expectedDays = 30;
  assert.equal(new Set(rows.map((r) => r.report_date)).size, expectedDays);
});

test("boundary days are included on both ends of the range", async () => {
  seed("2026-09-20", "2026-10-25", 2);
  const rows = await shared.fetchAllRowsByDateChunks(TABLE, "report_date", "2026-09-23", "2026-10-22");
  assert.ok(rows.some((r) => r.report_date === "2026-09-23"), "first day present");
  assert.ok(rows.some((r) => r.report_date === "2026-10-22"), "last day present");
  assert.ok(!rows.some((r) => r.report_date === "2026-09-22" || r.report_date === "2026-10-23"), "neighbours excluded");
});

test("a day with no rows inside a chunk does not drop the chunk's other days", async () => {
  seed("2026-09-20", "2026-10-25", 2, ["2026-09-27", "2026-10-03"]);
  const rows = await shared.fetchAllRowsByDateChunks(TABLE, "report_date", "2026-09-23", "2026-10-22");
  const days = new Set(rows.map((r) => r.report_date));
  assert.equal(days.size, 28, "30 days minus the two empty days");
  assert.ok(!days.has("2026-09-27") && days.has("2026-09-28"));
});

test("paging crosses the 1,000-row page boundary without losing or repeating rows", async () => {
  // 30 days × 60 rows = 1,800 rows inside the range, so the chunked fetch needs more than one page per chunk.
  seed("2026-09-23", "2026-10-22", 60);
  const rows = await shared.fetchAllRowsByDateChunks(TABLE, "report_date", "2026-09-23", "2026-10-22");
  assert.equal(rows.length, 1800);
  assert.equal(new Set(ids(rows)).size, 1800);
});

test("extra filters are applied to every chunk", async () => {
  seed("2026-09-23", "2026-10-22", 4);
  const rows = await shared.fetchAllRowsByDateChunks(TABLE, "report_date", "2026-09-23", "2026-10-22", (q) => (q as { eq: (c: string, v: string) => unknown }).eq("campaign_name", "C1"));
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.campaign_name === "C1"));
});

// ── Request shape: every chunk is bounded by the date column ─────────────────

test("every chunked request carries report_date bounds of at most one chunk", async () => {
  seed("2026-09-23", "2026-10-22", 2);
  fake.calls.length = 0;
  await shared.fetchAllRowsByDateChunks(TABLE, "report_date", "2026-09-23", "2026-10-22", undefined, 7);
  const selects = fake.calls.filter((c) => c.table === TABLE);
  assert.ok(selects.length >= 5, "one or more requests per week");
  for (const c of selects) {
    const lo = c.filters.find((f) => f.col === "report_date" && f.op === "gte");
    const hi = c.filters.find((f) => f.col === "report_date" && f.op === "lte");
    assert.ok(lo && hi, "bounded on both ends by report_date");
    const len = (new Date(`${String(hi.val)}T00:00:00Z`).getTime() - new Date(`${String(lo.val)}T00:00:00Z`).getTime()) / 86400000 + 1;
    assert.ok(len <= 7, "window no longer than one chunk");
  }
});

// ── Timeout behaviour: the unbounded read is what must never be issued ───────

test("the chunked path never issues an unbounded read of the table", async () => {
  seed("2026-09-23", "2026-10-22", 1);
  fake.calls.length = 0;
  await shared.fetchAllRowsByDateChunks(TABLE, "report_date", "2026-09-23", "2026-10-22");
  assert.ok(fake.calls.filter((c) => c.table === TABLE).every((c) => c.filters.some((f) => f.col === "report_date")));
});
