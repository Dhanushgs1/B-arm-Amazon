import { test } from "node:test";
import assert from "node:assert/strict";
import { daysBetween, retryOnTimeout } from "./statementTimeoutRetry.ts";

const TIMEOUT = { error: { message: "canceling statement due to statement timeout" } };
const noSleep = { sleep: async () => {} };

test("retries a statement timeout and succeeds once the database answers", async () => {
  let calls = 0;
  const r = await retryOnTimeout(async () => (++calls < 3 ? TIMEOUT : { error: null }), noSleep);
  assert.equal(r.error, null);
  assert.equal(calls, 3);
});

test("gives up after the allowed attempts and reports the timeout", async () => {
  let calls = 0;
  const r = await retryOnTimeout(async () => { calls++; return TIMEOUT; }, { ...noSleep, attempts: 4 });
  assert.match(r.error!.message, /statement timeout/);
  assert.equal(calls, 4);
});

test("does not retry any other error", async () => {
  let calls = 0;
  const r = await retryOnTimeout(async () => { calls++; return { error: { message: "duplicate key value" } }; }, noSleep);
  assert.equal(r.error!.message, "duplicate key value");
  assert.equal(calls, 1);
});

test("daysBetween lists every day, across a month end", () => {
  assert.deepEqual(daysBetween("2026-10-30", "2026-11-02"), ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
  assert.deepEqual(daysBetween("2026-11-05", "2026-11-05"), ["2026-11-05"]);
  assert.equal(daysBetween("2026-11-05T00:00:00Z", "2026-11-06"), null);
});
