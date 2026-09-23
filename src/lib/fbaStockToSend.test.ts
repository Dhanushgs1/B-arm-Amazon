import test from "node:test";
import assert from "node:assert/strict";
import { parseStockToSendInput, changedStockToSend, stockToSendStaleness, staleSkuSummary, staleXMessage, lastUpdatedLabel, reviewNote, X_STALE_DAYS } from "./fbaStockToSend.ts";

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

test("staleSkuSummary counts every SKU older than X_STALE_DAYS, not just the latest save", () => {
  const now = "2026-09-23T12:00:00Z";
  const migrated = { updatedAt: "2026-09-09T18:30:00+00:00", source: "manual_migration" };
  const rows = [
    { updatedAt: "2026-09-23T06:00:00+00:00", source: "panel" }, // fresh save: must not hide the rest
    migrated,
    { ...migrated },
    { updatedAt: "2026-09-14T06:00:00+00:00", source: "panel" },
    { updatedAt: "2026-09-16T12:00:00Z", source: "panel" }, // exactly 7 days: not stale
  ];
  assert.deepEqual(staleSkuSummary(rows, now), {
    total: 5, staleCount: 3, neverSavedCount: 0,
    oldestAt: "2026-09-09T18:30:00+00:00", oldestSource: "manual_migration",
  });
});

test("staleSkuSummary counts blank-X SKUs too, and SKUs with no saved row as never saved", () => {
  const now = "2026-09-23T12:00:00Z";
  const rows = [
    { updatedAt: "2026-09-10T00:00:00Z", source: "panel", stockToSend: null }, // blank X, old: counts
    { updatedAt: null, source: null, stockToSend: null }, // never saved: counts
    { updatedAt: "2026-09-22T00:00:00Z", source: "panel", stockToSend: null }, // blank X, fresh
  ];
  assert.deepEqual(staleSkuSummary(rows, now), {
    total: 3, staleCount: 2, neverSavedCount: 1,
    oldestAt: "2026-09-10T00:00:00Z", oldestSource: "panel",
  });
});

test("staleXMessage names the stale SKU count and the oldest date", () => {
  const now = "2026-09-23T12:00:00Z";
  const migrated = { updatedAt: "2026-09-09T18:30:00+00:00", source: "manual_migration" };
  const rows = [{ updatedAt: "2026-09-23T06:00:00+00:00", source: "panel" }, ...Array(293).fill(migrated)];
  assert.equal(
    staleXMessage(staleSkuSummary(rows, now)),
    "293 of 294 SKUs have X values (stock ready to send) not updated in more than 7 days (oldest: 10 Sep 2026, migrated from manual)."
  );
  assert.equal(
    staleXMessage(staleSkuSummary([{ updatedAt: "2026-09-10T00:00:00Z", source: "panel" }, { updatedAt: null, source: null }], now)),
    "2 of 2 SKUs have X values (stock ready to send) not updated in more than 7 days (oldest: 10 Sep 2026; 1 never saved)."
  );
  assert.equal(
    staleXMessage(staleSkuSummary([{ updatedAt: null, source: null }], now)),
    "1 of 1 SKUs have X values (stock ready to send) not updated in more than 7 days (1 never saved)."
  );
});

test("staleXMessage is null when every SKU is fresh, and 'never saved' when there are no rows", () => {
  const now = "2026-09-23T12:00:00Z";
  assert.equal(staleXMessage(staleSkuSummary([{ updatedAt: "2026-09-20T00:00:00Z", source: "panel" }], now)), null);
  assert.equal(
    staleXMessage(staleSkuSummary([], now)),
    "X values (stock ready to send) have never been saved — every SKU will send 0."
  );
});
