// Generic "stage in batches, then commit once" orchestration, kept free of
// any Supabase import so it can be unit-tested with node:test. The caller
// supplies the three I/O steps (see commitFbaSales30d in fbaForecastUpload.ts
// and scripts/fba_daily_sales_batched_upload.sql):
//   - stageBatch: write one batch to a staging area (must be idempotent per
//     batch index), returning how many rows it actually staged
//   - commit: verify the staged totals and atomically replace production,
//     returning the final production row count
//   - isSessionCommitted: after a commit error, report whether the commit
//     actually went through server-side (its response can be lost in
//     transit, e.g. "Failed to fetch") — true when the session's staged rows
//     are gone, since only a successful commit removes them
//   - discard: best-effort cleanup of the staging area after a failure
// Batches run strictly one after another — never concurrently — and the
// first failure stops the upload before commit, so production is untouched.

export interface BatchedUploadProgress {
  phase: "staging" | "committing";
  batchesDone: number;
  totalBatches: number;
  rowsDone: number;
  totalRows: number;
}

export interface BatchedUploadDeps<Row> {
  batchSize: number;
  stageBatch: (batchIndex: number, rows: Row[]) => Promise<number>;
  commit: (expectedRows: number, expectedBatches: number) => Promise<number>;
  isSessionCommitted: () => Promise<boolean>;
  discard: () => Promise<void>;
  onProgress?: (p: BatchedUploadProgress) => void;
}

export function chunkRows<Row>(rows: Row[], size: number): Row[][] {
  const out: Row[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

const fmt = (n: number) => n.toLocaleString("en-US");
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function discardSafe(discard: () => Promise<void>): Promise<void> {
  try {
    await discard();
  } catch (err) {
    console.error("Failed to discard staged upload rows", err);
  }
}

// `finalRowCount` is null (with `commitResponseLost`) when the commit's
// response was lost but the commit is known to have gone through — the
// caller must then verify the production row count itself.
export type BatchedUploadResult = { finalRowCount: number } | { finalRowCount: null; commitResponseLost: true };

export async function runBatchedUpload<Row>(rows: Row[], deps: BatchedUploadDeps<Row>): Promise<BatchedUploadResult> {
  const batches = chunkRows(rows, deps.batchSize);
  const totalRows = rows.length;
  const totalBatches = batches.length;
  let rowsDone = 0;

  deps.onProgress?.({ phase: "staging", batchesDone: 0, totalBatches, rowsDone, totalRows });

  for (let i = 0; i < totalBatches; i++) {
    const batch = batches[i];
    const label = `Batch ${i + 1} of ${totalBatches} (rows ${fmt(rowsDone + 1)}–${fmt(rowsDone + batch.length)})`;
    let staged: number;
    try {
      staged = await deps.stageBatch(i, batch);
    } catch (err) {
      await discardSafe(deps.discard);
      throw new Error(`${label} failed: ${errMsg(err)}. Nothing was changed in the existing data.`);
    }
    if (staged !== batch.length) {
      await discardSafe(deps.discard);
      throw new Error(`${label} failed: staged ${fmt(staged)} of ${fmt(batch.length)} rows. Nothing was changed in the existing data.`);
    }
    rowsDone += batch.length;
    deps.onProgress?.({ phase: "staging", batchesDone: i + 1, totalBatches, rowsDone, totalRows });
  }

  deps.onProgress?.({ phase: "committing", batchesDone: totalBatches, totalBatches, rowsDone, totalRows });

  let finalRowCount: number;
  try {
    finalRowCount = await deps.commit(totalRows, totalBatches);
  } catch (err) {
    // Never retry the commit — just find out whether it already happened.
    let committed: boolean;
    try {
      committed = await deps.isSessionCommitted();
    } catch (checkErr) {
      await discardSafe(deps.discard);
      throw new Error(
        `Final commit response was lost (${errMsg(err)}) and whether it went through could not be confirmed (${errMsg(checkErr)}). ` +
          `Check the "On file" row count before re-uploading.`
      );
    }
    if (committed) return { finalRowCount: null, commitResponseLost: true };
    await discardSafe(deps.discard);
    throw new Error(`Final commit failed: ${errMsg(err)}. The existing data was left unchanged.`);
  }
  if (finalRowCount !== totalRows) {
    throw new Error(`Commit verification failed: table has ${fmt(finalRowCount)} rows, expected ${fmt(totalRows)}.`);
  }
  return { finalRowCount };
}
