import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { runAtomicReplace, resetAtomicUploadProbe, type AtomicUploadDeps } from "./atomicUpload.ts";

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));
function deps(over: Partial<AtomicUploadDeps> = {}) {
  const log: string[] = [];
  const d: AtomicUploadDeps = {
    newSessionId: () => "s1",
    stage: async (_s, b, _t, r) => { log.push(`stage ${b}:${r.length}`); return null; },
    commit: async (_s, t, del, n, oc) => { log.push(`commit ${t} ${del.kind} ${n} ${oc}`); return { written: n, error: null }; },
    discard: async () => { log.push("discard"); },
    ...over,
  };
  return { d, log };
}
beforeEach(() => resetAtomicUploadProbe());

test("stages in 300-row batches, then commits once", async () => {
  const { d, log } = deps();
  assert.equal(await runAtomicReplace(d, "barm_flipkart_listings", rows(650), { kind: "all" }, "a,b"), true);
  assert.deepEqual(log, ["stage 0:300", "stage 1:300", "stage 2:50", "commit barm_flipkart_listings all 650 a,b"]);
});

test("a failed batch stops before commit, discards, and says nothing changed", async () => {
  const { d, log } = deps({ stage: async (_s, b) => (b === 1 ? { message: "timeout" } : null) });
  await assert.rejects(runAtomicReplace(d, "t", rows(700), { kind: "all" }), /timeout.*left unchanged/);
  assert.deepEqual(log, ["discard"]);
});

test("a failed commit discards and throws; a short write is an error", async () => {
  const a = deps({ commit: async () => ({ written: null, error: { message: "invalid input syntax" } }) });
  await assert.rejects(runAtomicReplace(a.d, "t", rows(2), { kind: "all" }), /invalid input syntax.*left unchanged/);
  assert.deepEqual(a.log, ["stage 0:2", "discard"]);
  const b = deps({ commit: async () => ({ written: 1, error: null }) });
  await assert.rejects(runAtomicReplace(b.d, "t", rows(2), { kind: "all" }), /1 of 2 rows/);
});

test("not installed -> false (caller uses the old path), remembered, never thrown", async () => {
  const a = deps({ stage: async () => ({ code: "PGRST205", message: "no table" }) });
  assert.equal(await runAtomicReplace(a.d, "t", rows(5), { kind: "all" }), false);
  const again = deps();
  assert.equal(await runAtomicReplace(again.d, "t", rows(5), { kind: "all" }), false);
  assert.deepEqual(again.log, []); // not probed a second time
  resetAtomicUploadProbe();
  const c = deps({ commit: async () => ({ written: null, error: { code: "PGRST202", message: "no function" } }) });
  assert.equal(await runAtomicReplace(c.d, "t", rows(5), { kind: "all" }), false);
  assert.deepEqual(c.log, ["stage 0:5", "discard"]);
});

test("an empty file never reaches the database", async () => {
  const { d, log } = deps();
  await assert.rejects(runAtomicReplace(d, "t", [], { kind: "all" }), /No valid rows/);
  assert.deepEqual(log, []);
});
