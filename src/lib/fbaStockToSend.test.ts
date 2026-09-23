import test from "node:test";
import assert from "node:assert/strict";
import { parseStockToSendInput, changedStockToSend, stockToSendStaleness, lastUpdatedLabel, reviewNote, X_STALE_DAYS } from "./fbaStockToSend.ts";

test("parseStockToSendInput: blank is null (0 to send), whole non-negative numbers are kept", () => {
  assert.deepEqual(parseStockToSendInput(""), { ok: true, value: null });
  assert.deepEqual(parseStockToSendInput("   "), { ok: true, value: null });
  assert.deepEqual(parseStockToSendInput("0"), { ok: true, value: 0 });
  assert.deepEqual(parseStockToSendInput(" 1500 "), { ok: true, value: 1500 });
  assert.deepEqual(parseStockToSendInput("1,500"), { ok: true, value: 1500 });
});

test("parseStockToSendInput rejects text, negatives and fractions", () => {
  for (const bad of ["-", "abc", "-5", "12.5", "1e3"]) {
    assert.equal(parseStockToSendInput(bad).ok, false, bad);
  }
});

test("changedStockToSend returns only SKUs whose value actually changed", () => {
  const saved = new Map<string, number | null>([["A", 100], ["B", null], ["C", 35]]);
  const edits = new Map<string, number | null>([["A", 100], ["B", 20], ["C", null]]);
  assert.deepEqual(changedStockToSend(saved, edits), [
    { sku: "B", stock_to_send: 20 },
    { sku: "C", stock_to_send: null },
  ]);
  assert.deepEqual(changedStockToSend(saved, new Map()), []);
});

test("stockToSendStaleness warns once the last save is older than X_STALE_DAYS", () => {
  const now = "2026-09-23T12:00:00Z";
  assert.equal(X_STALE_DAYS, 7);
  assert.deepEqual(stockToSendStaleness("2026-09-20T12:00:00Z", now), { stale: false, ageDays: 3 });
  assert.deepEqual(stockToSendStaleness("2026-09-16T12:00:00Z", now), { stale: false, ageDays: 7 });
  assert.deepEqual(stockToSendStaleness("2026-09-15T11:00:00Z", now), { stale: true, ageDays: 8 });
  assert.deepEqual(stockToSendStaleness(null, now), { stale: true, ageDays: null }); // never saved
});

test("lastUpdatedLabel marks migrated values instead of looking like a panel edit", () => {
  assert.equal(lastUpdatedLabel("2026-09-09T18:30:00+00:00", "manual_migration"), "10 Sep 2026 (migrated from manual)");
  assert.equal(lastUpdatedLabel("2026-09-23T06:00:00+00:00", "panel"), "23 Sep 2026");
  assert.equal(lastUpdatedLabel(null, null), "never");
});

test("reviewNote is shown only while the migrated value is untouched", () => {
  const note = "Original manual had 100 for Karnataka_zone ...";
  assert.equal(reviewNote({ note, source: "manual_migration" }), note);
  assert.equal(reviewNote({ note, source: "panel" }), null);
  assert.equal(reviewNote({ note: null, source: "manual_migration" }), null);
});
