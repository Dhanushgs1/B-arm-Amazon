// Offline tests for the auth primitives, send policy, escaping and rate limiter. No network, no
// env files: every secret below is a throwaway test value set on process.env per test.
/* eslint-disable @typescript-eslint/no-explicit-any -- inspecting escaped nested test data */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  checkCron, checkInternal, checkSession, checkSessionOrInternal, createSessionToken, verifySessionToken,
  readCookie, safeEqual, INTERNAL_AUTH_HEADER, SESSION_COOKIE, SESSION_TTL_SECONDS, checkDashboardPassword,
} from "./apiAuth.ts";
import { decideSend } from "./emailSendPolicy.ts";
import { escapeEmailData, escapeHtml } from "./htmlEscape.ts";
import { rateLimit, resetRateLimits } from "./rateLimit.ts";

const INTERNAL = "test-internal-secret";
const PASSWORD = "test-dashboard-password";

beforeEach(() => {
  delete process.env.CRON_SECRET;
  process.env.INTERNAL_API_SECRET = INTERNAL;
  process.env.DASHBOARD_PASSWORD = PASSWORD;
  resetRateLimits();
});

const sessionHeaders = () => ({ cookie: `other=1; ${SESSION_COOKIE}=${createSessionToken()}` });

// ── Cron ──
test("cron: missing CRON_SECRET fails closed with 503, even with a header", () => {
  const r = checkCron({ authorization: "Bearer anything" });
  assert.deepEqual(r, { ok: false, status: 503, error: "CRON_SECRET is not configured — refusing to run" });
});
test("cron: missing Authorization header -> 401", () => {
  process.env.CRON_SECRET = "cron-test";
  assert.equal((checkCron({}) as { status: number }).status, 401);
});
test("cron: wrong secret -> 401", () => {
  process.env.CRON_SECRET = "cron-test";
  assert.equal((checkCron({ authorization: "Bearer cron-wrong" }) as { status: number }).status, 401);
  assert.equal((checkCron({ authorization: "cron-test" }) as { status: number }).status, 401);
});
test("cron: correct secret -> ok", () => {
  process.env.CRON_SECRET = "cron-test";
  assert.deepEqual(checkCron({ authorization: "Bearer cron-test" }), { ok: true });
});

// ── Internal ──
test("internal: no signature -> 401; invalid -> 401; valid -> ok", () => {
  assert.equal((checkInternal({}) as { status: number }).status, 401);
  assert.equal((checkInternal({ [INTERNAL_AUTH_HEADER]: "nope" }) as { status: number }).status, 401);
  assert.deepEqual(checkInternal({ [INTERNAL_AUTH_HEADER]: INTERNAL }), { ok: true });
});
test("internal: missing INTERNAL_API_SECRET fails closed (503) — no SMTP_PASS fallback", () => {
  delete process.env.INTERNAL_API_SECRET;
  process.env.SMTP_PASS = "smtp-test";
  assert.equal((checkInternal({ [INTERNAL_AUTH_HEADER]: "" }) as { status: number }).status, 503);
  delete process.env.SMTP_PASS;
});
test("safeEqual compares content, not just length", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
});

// ── Session ──
test("session: valid token accepted; tampered, expired or absent rejected", () => {
  const t = createSessionToken()!;
  assert.equal(verifySessionToken(t), true);
  assert.equal(verifySessionToken(t.slice(0, -2) + "xx"), false);
  const [v, exp, sig] = t.split(".");
  assert.equal(verifySessionToken(`${v}.${Number(exp) + 999}.${sig}`), false); // extended expiry
  assert.equal(verifySessionToken(t, Date.now() + (SESSION_TTL_SECONDS + 5) * 1000), false);
  assert.equal(verifySessionToken(undefined), false);
});
test("session: changing DASHBOARD_PASSWORD invalidates existing sessions", () => {
  const t = createSessionToken()!;
  process.env.DASHBOARD_PASSWORD = "rotated";
  assert.equal(verifySessionToken(t), false);
});
test("session: not configured -> 503, no cookie -> 401, cookie -> ok", () => {
  assert.equal((checkSession({}) as { status: number }).status, 401);
  assert.deepEqual(checkSession(sessionHeaders()), { ok: true });
  delete process.env.DASHBOARD_PASSWORD;
  assert.equal((checkSession(sessionHeaders()) as { status: number }).status, 503);
});
test("session-or-internal accepts either, nothing else", () => {
  assert.deepEqual(checkSessionOrInternal({ [INTERNAL_AUTH_HEADER]: INTERNAL }), { ok: true });
  assert.deepEqual(checkSessionOrInternal(sessionHeaders()), { ok: true });
  assert.equal(checkSessionOrInternal({ [INTERNAL_AUTH_HEADER]: "forged" }).ok, false);
});
test("dashboard password check", () => {
  assert.equal(checkDashboardPassword(PASSWORD), true);
  assert.equal(checkDashboardPassword("wrong"), false);
  assert.equal(checkDashboardPassword(undefined), false);
  delete process.env.DASHBOARD_PASSWORD;
  assert.equal(checkDashboardPassword(""), false);
});
test("readCookie finds the named cookie only", () => {
  assert.equal(readCookie({ cookie: "a=1; m360_session=xyz; b=2" }, SESSION_COOKIE), "xyz");
  assert.equal(readCookie({ cookie: "xm360_session=bad" }, SESSION_COOKIE), undefined);
});

// ── send-email policy ──
test("send policy: unauthenticated browser request -> 401 for every type", () => {
  for (const type of ["test", "custom", "campaign", "weeklyReport"]) {
    assert.equal((decideSend({}, { type }) as { status: number }).status, 401);
  }
});
test("send policy: signed-in browser cannot use custom, subject or attachments", () => {
  const h = sessionHeaders();
  assert.equal((decideSend(h, { type: "custom", data: { html: "<b>x</b>" } }) as { status: number }).status, 403);
  assert.equal((decideSend(h, { type: "weeklyReport" }) as { status: number }).status, 403);
  assert.equal((decideSend(h, { type: "test", subject: "Invoice" }) as { status: number }).status, 403);
  assert.equal((decideSend(h, { type: "test", attachments: [{}] }) as { status: number }).status, 403);
});
test("send policy: test email goes to the typed address; production types use saved recipients", () => {
  const h = sessionHeaders();
  assert.deepEqual(decideSend(h, { type: "test", to: "typed@example.com" }), { ok: true, internal: false, recipients: "body" });
  assert.deepEqual(decideSend(h, { type: "confirmation", to: "attacker@example.com" }), { ok: true, internal: false, recipients: "saved" });
  assert.deepEqual(decideSend(h, { type: "campaign" }), { ok: true, internal: false, recipients: "saved" });
});
test("send policy: signed internal request may use any template", () => {
  assert.deepEqual(decideSend({ [INTERNAL_AUTH_HEADER]: INTERNAL }, { type: "custom", subject: "s", attachments: [{}] }), { ok: true, internal: true, recipients: "body" });
});

// ── Escaping ──
test("escapeHtml neutralises markup and quotes", () => {
  assert.equal(escapeHtml(`<script>alert(1)</script>`), "&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.equal(escapeHtml(`<img src=x onerror="alert(1)">`), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  assert.equal(escapeHtml(`Bath & Body's`), "Bath &amp; Body&#39;s");
  assert.equal(escapeHtml(42), "42");
});
test("escapeEmailData escapes nested strings, keeps numbers, and honours raw fields only when allowed", () => {
  const data = { accountName: "<b>x</b>", n: 5, rows: [[{ text: "<a href='//evil'>y</a>", bold: true }]], emoji: "&#128680;", subtitle: "<span>ok</span>" };
  const out = escapeEmailData("adAlert", data, true) as any;
  assert.equal(out.accountName, "&lt;b&gt;x&lt;/b&gt;");
  assert.equal(out.n, 5);
  assert.equal(out.rows[0][0].text, "&lt;a href=&#39;//evil&#39;&gt;y&lt;/a&gt;");
  assert.equal(out.rows[0][0].bold, true);
  assert.equal(out.emoji, "&#128680;");
  assert.equal(out.subtitle, "<span>ok</span>");
  const unsigned = escapeEmailData("adAlert", data, false) as any;
  assert.equal(unsigned.subtitle, "&lt;span&gt;ok&lt;/span&gt;");
  assert.equal((escapeEmailData("custom", { html: "<p>x</p>" }, false) as any).html, "&lt;p&gt;x&lt;/p&gt;");
});

// ── Rate limit ──
test("rateLimit allows `limit` calls per window, then blocks until the window resets", () => {
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) assert.equal(rateLimit("k", 3, 1000, t0).ok, true);
  assert.equal(rateLimit("k", 3, 1000, t0 + 10).ok, false);
  assert.equal(rateLimit("k", 3, 1000, t0 + 1000).ok, true);
});
