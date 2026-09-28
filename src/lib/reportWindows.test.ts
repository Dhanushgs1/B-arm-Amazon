import test from "node:test";
import assert from "node:assert/strict";
import { trailingWindow } from "./reportWindows.ts";

test("trailingWindow keeps the selected end date and counts it as day 1", () => {
  assert.deepEqual(trailingWindow("2026-09-17", 7), { start: "2026-09-11", end: "2026-09-17" });
  assert.deepEqual(trailingWindow("2026-09-17", 30), { start: "2026-08-19", end: "2026-09-17" });
  assert.deepEqual(trailingWindow("2026-09-17", 1), { start: "2026-09-17", end: "2026-09-17" });
});

test("trailingWindow crosses month, year and leap-day boundaries", () => {
  assert.deepEqual(trailingWindow("2026-09-03", 7), { start: "2026-08-28", end: "2026-09-03" });
  assert.deepEqual(trailingWindow("2026-08-31", 30), { start: "2026-08-02", end: "2026-08-31" });
  assert.deepEqual(trailingWindow("2027-01-02", 7), { start: "2026-12-27", end: "2027-01-02" });
  assert.deepEqual(trailingWindow("2028-03-01", 2), { start: "2028-02-29", end: "2028-03-01" });
});

test("trailingWindow is timezone-independent (pure date arithmetic)", () => {
  const prev = process.env.TZ;
  for (const tz of ["Asia/Kolkata", "UTC", "America/Los_Angeles", "Pacific/Kiritimati"]) {
    process.env.TZ = tz;
    assert.deepEqual(trailingWindow("2026-09-17", 7), { start: "2026-09-11", end: "2026-09-17" }, tz);
  }
  process.env.TZ = prev;
});

test("trailingWindow rejects a malformed date instead of producing NaN windows", () => {
  assert.throws(() => trailingWindow("17-09-2026", 7), /Invalid report end date/);
  assert.throws(() => trailingWindow("", 7), /Invalid report end date/);
  assert.throws(() => trailingWindow("2026-02-30", 7), /Invalid report end date/);
  assert.throws(() => trailingWindow("2026-09-17", 0), /Invalid window length/);
});
