import test from "node:test";
import assert from "node:assert/strict";
import { trackUpload, getJobs, latestJob, isAnyRunning, subscribe, dismissFinished, __resetForTests } from "./uploadTracker.ts";

const meta = { key: "amazon:combined", label: "Ad Spend Report", fileName: "Last 7 days.xlsx", href: "/dashboard/upload" };

test("a tracked upload is running, then done with its summary and full progress", async () => {
  __resetForTests();
  let notified = 0;
  subscribe(() => notified++);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const p = trackUpload(meta, async (progress) => {
    progress({ done: 1, total: 4, step: "AM ads" });
    await gate;
    return { rows: 120 };
  }, (r) => ({ status: "done", message: `${r.rows} rows saved` }));

  assert.equal(isAnyRunning(), true);
  assert.equal(latestJob("amazon:combined")?.status, "running");
  assert.deepEqual(latestJob("amazon:combined")?.progress, { done: 1, total: 4, step: "AM ads" });

  release();
  assert.deepEqual(await p, { rows: 120 });
  const j = latestJob("amazon:combined")!;
  assert.equal(j.status, "done");
  assert.equal(j.message, "120 rows saved");
  assert.equal(j.progress?.done, 4);
  assert.ok(j.finishedAt);
  assert.equal(isAnyRunning(), false);
  assert.ok(notified >= 3);
});

test("a failed upload is marked failed and the error still reaches the card", async () => {
  __resetForTests();
  await assert.rejects(trackUpload(meta, async () => { throw new Error("Missing column: Campaign Name"); }, () => ({ status: "done", message: "" })), /Missing column/);
  const j = latestJob("amazon:combined")!;
  assert.equal(j.status, "error");
  assert.equal(j.message, "Missing column: Campaign Name");
});

test("newest job first; dismissing finished keeps running ones", async () => {
  __resetForTests();
  await trackUpload({ ...meta, key: "a" }, async () => 1, () => ({ status: "warning", message: "2 rows skipped" }));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const p = trackUpload({ ...meta, key: "b" }, () => gate.then(() => 2), () => ({ status: "done", message: "ok" }));
  assert.deepEqual(getJobs().map((j) => j.key), ["b", "a"]);
  dismissFinished();
  assert.deepEqual(getJobs().map((j) => j.key), ["b"]);
  release();
  await p;
});
