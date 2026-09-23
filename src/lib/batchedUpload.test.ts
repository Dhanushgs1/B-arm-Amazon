import test from "node:test";
import assert from "node:assert/strict";
import { chunkRows, runBatchedUpload, type BatchedUploadProgress } from "./batchedUpload.ts";

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));

test("chunkRows splits into max-size batches, preserving order", () => {
  const batches = chunkRows(rows(5673), 1000);
  assert.equal(batches.length, 6);
  assert.deepEqual(batches.map((b) => b.length), [1000, 1000, 1000, 1000, 1000, 673]);
  assert.deepEqual(batches.flat(), rows(5673));
  assert.deepEqual(chunkRows([], 1000), []);
});

test("stages every batch sequentially, then commits once with the expected totals", async () => {
  const calls: string[] = [];
  let inFlight = 0;
  const progress: BatchedUploadProgress[] = [];
  const result = await runBatchedUpload(rows(2500), {
    batchSize: 1000,
    isSessionCommitted: async () => false,
    stageBatch: async (index, batch) => {
      inFlight++;
      assert.equal(inFlight, 1, "batches must not overlap");
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      calls.push(`stage ${index} ${batch.length}`);
      return batch.length;
    },
    commit: async (expectedRows, expectedBatches) => {
      calls.push(`commit ${expectedRows} ${expectedBatches}`);
      return expectedRows;
    },
    discard: async () => { calls.push("discard"); },
    onProgress: (p) => progress.push(p),
  });
  assert.deepEqual(calls, ["stage 0 1000", "stage 1 1000", "stage 2 500", "commit 2500 3"]);
  assert.equal(result.finalRowCount, 2500);
  assert.deepEqual(
    progress.map((p) => [p.phase, p.batchesDone, p.totalBatches, p.rowsDone, p.totalRows]),
    [
      ["staging", 0, 3, 0, 2500],
      ["staging", 1, 3, 1000, 2500],
      ["staging", 2, 3, 2000, 2500],
      ["staging", 3, 3, 2500, 2500],
      ["committing", 3, 3, 2500, 2500],
    ]
  );
});

test("a failing batch stops the upload, names the batch, discards staging, never commits", async () => {
  const calls: string[] = [];
  await assert.rejects(
    runBatchedUpload(rows(3500), {
      batchSize: 1000,
      isSessionCommitted: async () => false,
      stageBatch: async (index, batch) => {
        if (index === 1) throw new Error("Failed to fetch");
        calls.push(`stage ${index}`);
        return batch.length;
      },
      commit: async () => { calls.push("commit"); return 0; },
      discard: async () => { calls.push("discard"); },
    }),
    /Batch 2 of 4 \(rows 1,001–2,000\) failed: Failed to fetch/
  );
  assert.deepEqual(calls, ["stage 0", "discard"]);
});

test("a batch that stages fewer rows than sent is treated as a failure", async () => {
  await assert.rejects(
    runBatchedUpload(rows(1500), {
      batchSize: 1000,
      isSessionCommitted: async () => false,
      stageBatch: async (_i, batch) => batch.length - 1,
      commit: async () => 0,
      discard: async () => {},
    }),
    /Batch 1 of 2 .*staged 999 of 1,000 rows/
  );
});

test("commit failure with staging rows still present discards staging and reports it; final count mismatch is rejected", async () => {
  const calls: string[] = [];
  await assert.rejects(
    runBatchedUpload(rows(10), {
      batchSize: 1000,
      stageBatch: async (_i, b) => b.length,
      commit: async () => { calls.push("commit"); throw new Error("Staged data incomplete"); },
      isSessionCommitted: async () => { calls.push("check"); return false; },
      discard: async () => { calls.push("discard"); },
    }),
    /Final commit failed: Staged data incomplete/
  );
  assert.deepEqual(calls, ["commit", "check", "discard"], "commit must not be retried");

  await assert.rejects(
    runBatchedUpload(rows(10), {
      batchSize: 1000,
      isSessionCommitted: async () => false,
      stageBatch: async (_i, b) => b.length,
      commit: async () => 9,
      discard: async () => {},
    }),
    /has 9 rows, expected 10/
  );
});

test("commit response lost but staging rows gone: treated as committed, no discard, no retry", async () => {
  const calls: string[] = [];
  const result = await runBatchedUpload(rows(2500), {
    batchSize: 1000,
    stageBatch: async (_i, b) => b.length,
    commit: async () => { calls.push("commit"); throw new Error("Failed to fetch"); },
    isSessionCommitted: async () => { calls.push("check"); return true; },
    discard: async () => { calls.push("discard"); },
  });
  assert.deepEqual(calls, ["commit", "check"]);
  // Row count is unknown here — the caller must verify production itself.
  assert.deepEqual(result, { finalRowCount: null, commitResponseLost: true });
});

test("commit response lost and the status check also fails: reports unknown outcome, never 'unchanged'", async () => {
  const calls: string[] = [];
  await assert.rejects(
    runBatchedUpload(rows(10), {
      batchSize: 1000,
      stageBatch: async (_i, b) => b.length,
      commit: async () => { calls.push("commit"); throw new Error("Failed to fetch"); },
      isSessionCommitted: async () => { calls.push("check"); throw new Error("Failed to fetch"); },
      discard: async () => { calls.push("discard"); },
    }),
    (err: Error) => /could not be confirmed/.test(err.message) && !/left unchanged/.test(err.message)
  );
  assert.deepEqual(calls, ["commit", "check", "discard"]);
});

test("a discard failure never masks the original batch error", async () => {
  await assert.rejects(
    runBatchedUpload(rows(10), {
      batchSize: 1000,
      isSessionCommitted: async () => false,
      stageBatch: async () => { throw new Error("boom"); },
      commit: async () => 0,
      discard: async () => { throw new Error("discard also failed"); },
    }),
    /Batch 1 of 1 .*failed: boom/
  );
});
