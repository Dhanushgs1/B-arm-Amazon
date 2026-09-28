import test from "node:test";
import assert from "node:assert/strict";
import { amazonPurchaseIstDate, dedupeByIdentity, planReplaceByKey, replaceKeyValues, chunk } from "./amazonOrderUploadRules.ts";

// ── IST business date of Amazon's UTC purchase-date ──────────────────────

test("amazonPurchaseIstDate: 00:00 IST is 18:30 UTC the previous day", () => {
  assert.equal(amazonPurchaseIstDate("2026-09-15T18:30:00+00:00"), "2026-09-16");
  assert.equal(amazonPurchaseIstDate("2026-09-15T18:30:42+00:00"), "2026-09-16"); // real row from 16 Sep
});

test("amazonPurchaseIstDate: 05:29 IST still belongs to the IST day, not the UTC one", () => {
  assert.equal(amazonPurchaseIstDate("2026-09-15T23:59:59+00:00"), "2026-09-16");
});

test("amazonPurchaseIstDate: 05:30 IST is 00:00 UTC the same day", () => {
  assert.equal(amazonPurchaseIstDate("2026-09-16T00:00:00+00:00"), "2026-09-16");
});

test("amazonPurchaseIstDate: 23:59 IST is 18:29 UTC the same day", () => {
  assert.equal(amazonPurchaseIstDate("2026-09-16T18:29:59+00:00"), "2026-09-16");
});

test("amazonPurchaseIstDate: month, year and leap-day boundaries", () => {
  assert.equal(amazonPurchaseIstDate("2026-08-31T18:29:59Z"), "2026-08-31");
  assert.equal(amazonPurchaseIstDate("2026-08-31T18:30:00Z"), "2026-09-01");
  assert.equal(amazonPurchaseIstDate("2026-12-31T18:30:00.000Z"), "2027-01-01");
  assert.equal(amazonPurchaseIstDate("2028-02-28T18:30:00Z"), "2028-02-29");
  assert.equal(amazonPurchaseIstDate("2028-02-29T18:30:00Z"), "2028-03-01");
});

test("amazonPurchaseIstDate: honours an explicit non-UTC offset", () => {
  assert.equal(amazonPurchaseIstDate("2026-09-16T00:10:00+05:30"), "2026-09-16");
  assert.equal(amazonPurchaseIstDate("2026-09-16 00:10:00+0530"), "2026-09-16");
});

test("amazonPurchaseIstDate: returns null (caller falls back) when there is no time/offset", () => {
  assert.equal(amazonPurchaseIstDate("2026-09-16"), null);
  assert.equal(amazonPurchaseIstDate("2026-09-16T10:00:00"), null); // no offset — ambiguous zone
  assert.equal(amazonPurchaseIstDate(46282), null); // Excel serial
  assert.equal(amazonPurchaseIstDate(""), null);
  assert.equal(amazonPurchaseIstDate(null), null);
  assert.equal(amazonPurchaseIstDate("not a date"), null);
});

// ── in-file dedup and replace plan ────────────────────────────────────────

test("dedupeByIdentity keeps the last copy of a repeated order-item-id and every unkeyed row", () => {
  const rows = [
    { id: "A", status: "Pending" },
    { id: "B", status: "Shipped" },
    { id: "A", status: "Shipped" },
    { id: "", status: "x" },
    { id: "", status: "y" },
  ];
  const out = dedupeByIdentity(rows, (r) => r.id);
  assert.equal(out.length, 4);
  assert.deepEqual(out.find((r) => r.id === "A"), { id: "A", status: "Shipped" });
});

test("replaceKeyValues returns distinct non-blank keys", () => {
  assert.deepEqual(replaceKeyValues([{ o: "1" }, { o: "1" }, { o: " " }, { o: "2" }, {}], "o").sort(), ["1", "2"]);
});

test("chunk splits evenly with a short tail", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

// ── upload simulation: previous-day rows survive and re-uploads are idempotent ──

type Row = Record<string, unknown> & { order_id: string; oiid: string; report_date: string };

function applyPlan(table: Row[], rows: Row[]): Row[] {
  const plan = planReplaceByKey(rows, "order_id", (r) => String(r.oiid));
  const del = new Set(plan.deleteKeys);
  return [...table.filter((r) => !del.has(r.order_id)), ...(plan.insertRows as Row[])];
}

// The old strategy, kept here only to prove the new one fixes what it broke.
function applyOldRangeReplace(table: Row[], rows: Row[]): Row[] {
  const dates = rows.map((r) => r.report_date).sort();
  return [...table.filter((r) => r.report_date < dates[0] || r.report_date > dates[dates.length - 1]), ...rows];
}

const row = (order_id: string, utc: string): Row => ({ order_id, oiid: `${order_id}-1`, report_date: amazonPurchaseIstDate(utc)!, utc });
const oldRow = (order_id: string, utc: string): Row => ({ order_id, oiid: `${order_id}-1`, report_date: utc.slice(0, 10), utc });

// Upload 1 covers IST 15 Sep; upload 2 covers IST 16 Sep, whose first order (00:05 IST) is 15 Sep UTC.
const upload1 = (mk: typeof row) => [mk("O1", "2026-09-14T18:35:00Z"), mk("O2", "2026-09-15T06:00:00Z"), mk("O3", "2026-09-15T12:00:00Z")];
const upload2 = (mk: typeof row) => [mk("O4", "2026-09-15T18:35:00Z"), mk("O5", "2026-09-16T06:00:00Z")];

test("old UTC-date range replace wipes the previous upload's day (the reported bug)", () => {
  const table = applyOldRangeReplace(applyOldRangeReplace([], upload1(oldRow)), upload2(oldRow));
  // O2/O3 (15 Sep, well inside the first upload) are gone.
  assert.deepEqual(table.map((r) => r.order_id).sort(), ["O1", "O4", "O5"]);
});

test("order-level replace keeps every earlier order and stores IST days", () => {
  const table = applyPlan(applyPlan([], upload1(row)), upload2(row));
  assert.deepEqual(table.map((r) => r.order_id).sort(), ["O1", "O2", "O3", "O4", "O5"]);
  const byDay = (d: string) => table.filter((r) => r.report_date === d).map((r) => r.order_id).sort();
  assert.deepEqual(byDay("2026-09-15"), ["O1", "O2", "O3"]);
  assert.deepEqual(byDay("2026-09-16"), ["O4", "O5"]);
});

test("re-uploading the same file is idempotent and never duplicates an order line", () => {
  const once = applyPlan(applyPlan([], upload1(row)), upload2(row));
  const twice = applyPlan(applyPlan(once, upload1(row)), upload2(row));
  assert.equal(twice.length, once.length);
  assert.equal(new Set(twice.map((r) => r.oiid)).size, twice.length);
});

test("a re-uploaded order replaces its old status instead of adding a second row", () => {
  const first = applyPlan([], [{ ...row("O9", "2026-09-16T06:00:00Z"), status: "Pending" }]);
  const second = applyPlan(first, [{ ...row("O9", "2026-09-16T06:00:00Z"), status: "Shipped" }]);
  assert.equal(second.length, 1);
  assert.equal(second[0].status, "Shipped");
});
