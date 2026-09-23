import test from "node:test";
import assert from "node:assert/strict";
import { STALE_PROCESSING_MS, isStaleProcessingJob, withStaleProcessingAsFailed } from "./fbaForecastJobRules.ts";

const NOW = Date.parse("2026-09-23T17:10:00Z");
const job = (status: string, startedAt: string | null, updatedAt: string | null = startedAt) => ({ id: 144, report_date: "2026-09-23", status, error_message: null, started_at: startedAt, updated_at: updatedAt });

test("the timeout is 5 minutes", () => {
  assert.equal(STALE_PROCESSING_MS, 5 * 60 * 1000);
});

test("a processing job older than 5 minutes is stale", () => {
  assert.equal(isStaleProcessingJob(job("processing", "2026-09-23T17:04:59Z"), NOW), true);
  assert.equal(isStaleProcessingJob(job("processing", "2026-09-23T16:34:07Z"), NOW), true); // tonight's 36-minute stuck run
});

test("a processing job within 5 minutes is still treated as running", () => {
  assert.equal(isStaleProcessingJob(job("processing", "2026-09-23T17:09:51Z"), NOW), false); // normal 9-second run
  assert.equal(isStaleProcessingJob(job("processing", "2026-09-23T17:05:00Z"), NOW), false); // exactly 5 minutes
});

test("only processing jobs can be stale", () => {
  for (const s of ["pending", "completed", "failed"]) assert.equal(isStaleProcessingJob(job(s, "2026-09-23T16:00:00Z"), NOW), false, s);
});

test("falls back to updated_at when started_at is missing, and never guesses without a timestamp", () => {
  assert.equal(isStaleProcessingJob(job("processing", null, "2026-09-23T16:50:00Z"), NOW), true);
  assert.equal(isStaleProcessingJob(job("processing", null, null), NOW), false);
});

test("withStaleProcessingAsFailed reports a stale job as failed so the page offers Retry", () => {
  const stale = withStaleProcessingAsFailed(job("processing", "2026-09-23T16:34:07Z"), NOW);
  assert.equal(stale?.status, "failed");
  assert.match(stale?.error_message ?? "", /did not finish within 5 minutes/);
  const running = job("processing", "2026-09-23T17:09:51Z");
  assert.equal(withStaleProcessingAsFailed(running, NOW), running);
  assert.equal(withStaleProcessingAsFailed(null, NOW), null);
});
