import test from "node:test";
import assert from "node:assert/strict";
import { emailSendingPaused } from "./emailPause.ts";

test("paused only when EMAIL_SENDING_PAUSED is a true-ish value", () => {
  for (const v of ["true", "TRUE", "1", "yes", "on", " true "]) assert.equal(emailSendingPaused({ EMAIL_SENDING_PAUSED: v }), true, v);
  for (const v of [undefined, "", "false", "0", "no", "off"]) assert.equal(emailSendingPaused({ EMAIL_SENDING_PAUSED: v }), false, String(v));
});

test("EMAIL_SENDING_PAUSED_UNTIL pauses until that IST date begins", () => {
  const env = { EMAIL_SENDING_PAUSED_UNTIL: "2026-10-12" };
  assert.equal(emailSendingPaused(env, new Date("2026-10-11T08:00:00Z")), true); // 13:30 IST on the 11th
  assert.equal(emailSendingPaused(env, new Date("2026-10-11T18:29:00Z")), true); // 23:59 IST on the 11th
  assert.equal(emailSendingPaused(env, new Date("2026-10-11T18:31:00Z")), false); // 00:01 IST on the 12th
  assert.equal(emailSendingPaused(env, new Date("2026-10-12T03:30:00Z")), false); // 9:00 IST on the 12th
  assert.equal(emailSendingPaused({ EMAIL_SENDING_PAUSED_UNTIL: "garbage" }), false);
  assert.equal(emailSendingPaused({ EMAIL_SENDING_PAUSED: "true", EMAIL_SENDING_PAUSED_UNTIL: "2020-01-01" }), true);
});
