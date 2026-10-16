import test from "node:test";
import assert from "node:assert/strict";
import { isStaleProcessing, STALE_PROCESSING_MS } from "./adSpendJobRules.ts";

const now = Date.parse("2026-10-16T12:00:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();

test("a processing job untouched for over 10 minutes is dead (e.g. CPU-killed Edge Function)", () => {
  assert.equal(isStaleProcessing({ status: "processing", updated_at: ago(STALE_PROCESSING_MS + 1) }, now), true);
  assert.equal(isStaleProcessing({ status: "pending", updated_at: ago(70 * 60 * 1000) }, now), true);
});

test("a recently started run is still running", () => {
  assert.equal(isStaleProcessing({ status: "processing", updated_at: ago(60 * 1000) }, now), false);
});

test("completed / failed jobs and missing timestamps are never stale", () => {
  assert.equal(isStaleProcessing({ status: "completed", updated_at: ago(3 * 3600 * 1000) }, now), false);
  assert.equal(isStaleProcessing({ status: "failed", updated_at: ago(3 * 3600 * 1000) }, now), false);
  assert.equal(isStaleProcessing({ status: "processing", updated_at: null }, now), false);
});
