// Offline regression tests for the API routes' auth gates. The real handlers are loaded (via jiti,
// for the "@/" alias) with every external dependency switched off: no SMTP, Supabase, SellerMate,
// Gemini or Edge URL env vars, and global fetch replaced by a stub that records and throws. A test
// that is "allowed" through a gate proves it by reaching a later, harmless failure (a 400 for a
// missing field, or a 500 for unconfigured SMTP/Supabase/Gemini) with zero network calls.
/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed req/res mocks for route handlers */
import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createJiti } from "jiti";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_POSIX = SRC.replace(/\\/g, "/");
const jiti = createJiti(import.meta.url, { alias: { "@/": `${SRC_POSIX}/` } });
// One path form for every import, so jiti keeps a single module instance per file.
const abs = (rel: string) => `${SRC_POSIX}/${rel}`;
const load = async (rel: string) => ((await jiti.import(abs(rel))) as { default: any });

for (const k of [
  "SMTP_FROM", "SMTP_PASS", "SUPABASE_URL", "SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_EDGE_URL", "GEMINI_API_KEY", "SELLERMATE_API_KEY", "SELLERMATE_API_KEY_A", "SELLERMATE_API_KEY_B",
  "SELLERMATE_API_KEY_BARM", "SELLERMATE_API_KEY_LKN", "VERCEL_URL", "APP_INTERNAL_ORIGIN", "VERCEL_AUTOMATION_BYPASS_SECRET",
]) delete process.env[k];

const INTERNAL = "test-internal-secret";
const PASSWORD = "test-dashboard-password";
const fetchCalls: string[] = [];
const realFetch = globalThis.fetch;
function blockNetwork() {
  globalThis.fetch = (async (url: unknown) => {
    fetchCalls.push(String(url));
    throw new Error("network disabled in tests");
  }) as typeof fetch;
}
blockNetwork();
after(() => { globalThis.fetch = realFetch; });

const { createSessionToken, INTERNAL_AUTH_HEADER, SESSION_COOKIE } = await import("./apiAuth.ts");
// Through jiti, so this is the same module instance the handlers use.
const { resetRateLimits } = (await jiti.import(abs("lib/rateLimit.ts"))) as { resetRateLimits: () => void };

beforeEach(() => {
  delete process.env.CRON_SECRET;
  process.env.INTERNAL_API_SECRET = INTERNAL;
  process.env.DASHBOARD_PASSWORD = PASSWORD;
  fetchCalls.length = 0;
  resetRateLimits();
});

type Res = { statusCode: number; body: any; headers: Record<string, string> };
function mockRes() {
  const r: any = { statusCode: 0, body: undefined, headers: {} };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  r.send = (b: unknown) => { r.body = b; return r; };
  r.end = () => r;
  r.setHeader = (k: string, v: string) => { r.headers[k.toLowerCase()] = v; };
  return r as Res & Record<string, any>;
}
async function call(rel: string, opts: { method?: string; headers?: Record<string, string>; body?: any; query?: any } = {}): Promise<Res> {
  const handler = (await load(rel)).default;
  const res = mockRes();
  await handler({ method: opts.method || "POST", headers: opts.headers || {}, body: opts.body ?? {}, query: opts.query || {} }, res);
  return res;
}
const signed = () => ({ [INTERNAL_AUTH_HEADER]: INTERNAL });
const forged = () => ({ [INTERNAL_AUTH_HEADER]: "forged" });
const session = () => ({ cookie: `${SESSION_COOKIE}=${createSessionToken()}` });

// ── Cron ─────────────────────────────────────────────────────────────────────────────────────
for (const route of ["pages/api/cron/scheduled-reports.ts", "pages/api/cron/campaign-monitor.ts"]) {
  test(`${route}: missing CRON_SECRET -> 503, runs nothing`, async () => {
    const r = await call(route, { method: "GET", headers: { authorization: "Bearer x" } });
    assert.equal(r.statusCode, 503);
    assert.deepEqual(fetchCalls, []);
  });
  test(`${route}: missing / wrong token -> 401`, async () => {
    process.env.CRON_SECRET = "cron-test";
    assert.equal((await call(route, { method: "GET" })).statusCode, 401);
    assert.equal((await call(route, { method: "GET", headers: { authorization: "Bearer wrong" } })).statusCode, 401);
    assert.deepEqual(fetchCalls, []);
  });
  test(`${route}: correct token -> runs (slots skip: no saved settings offline)`, async () => {
    process.env.CRON_SECRET = "cron-test";
    const r = await call(route, { method: "GET", headers: { authorization: "Bearer cron-test" } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.bySlot.B.skipped, true);
    assert.deepEqual(fetchCalls, []);
  });
}

// ── Internal-only routes ─────────────────────────────────────────────────────────────────────
for (const route of ["daily-digest", "live-alerts", "campaign-state-check", "stockout-alert", "ad-alerts"]) {
  const rel = `pages/api/${route}.ts`;
  test(`${route}: no signature / invalid signature / browser session -> 401`, async () => {
    assert.equal((await call(rel)).statusCode, 401);
    assert.equal((await call(rel, { headers: forged() })).statusCode, 401);
    assert.equal((await call(rel, { headers: session() })).statusCode, 401);
    assert.deepEqual(fetchCalls, []);
  });
  test(`${route}: valid signature passes the gate (stops at missing account ids)`, async () => {
    const r = await call(rel, { headers: signed(), body: {} });
    assert.equal(r.statusCode, 400);
    assert.deepEqual(fetchCalls, []);
  });
}

// ── send-email ───────────────────────────────────────────────────────────────────────────────
const SE = "pages/api/send-email.ts";
test("send-email: unauthenticated request -> 401 (even the test template)", async () => {
  assert.equal((await call(SE, { body: { type: "test", to: "a@example.com" } })).statusCode, 401);
  assert.equal((await call(SE, { body: { type: "custom", to: "a@example.com", data: { html: "<b>x</b>" } } })).statusCode, 401);
});
test("send-email: browser cannot send custom HTML, override subject or attach files", async () => {
  assert.equal((await call(SE, { headers: session(), body: { type: "custom", to: "a@example.com", data: { html: "<b>x</b>" } } })).statusCode, 403);
  assert.equal((await call(SE, { headers: session(), body: { type: "test", to: "a@example.com", subject: "Invoice" } })).statusCode, 403);
  assert.equal((await call(SE, { headers: session(), body: { type: "test", to: "a@example.com", attachments: [{ filename: "x" }] } })).statusCode, 403);
  assert.equal((await call(SE, { headers: session(), body: { type: "weeklyReport", to: "a@example.com" } })).statusCode, 403);
});
test("send-email: browser test email to a typed address passes the gate (stops at unconfigured SMTP)", async () => {
  const r = await call(SE, { headers: session(), body: { type: "test", to: "typed@example.com" } });
  assert.equal(r.statusCode, 500);
  assert.match(r.body.error, /SMTP credentials not configured/);
});
test("send-email: browser confirmation ignores body to/cc and uses saved recipients (none saved -> 400)", async () => {
  const r = await call(SE, { headers: session(), body: { type: "confirmation", to: "attacker@example.com", cc: "x@example.com", keySlot: "B" } });
  assert.equal(r.statusCode, 400);
  assert.match(r.body.error, /Recipient email/);
});
test("send-email: signed internal request may use custom (stops at unconfigured SMTP)", async () => {
  const r = await call(SE, { headers: signed(), body: { type: "custom", to: "a@example.com", subject: "s", data: { html: "<p>x</p>" } } });
  assert.equal(r.statusCode, 500);
  assert.match(r.body.error, /SMTP credentials not configured/);
  assert.deepEqual(fetchCalls, []);
});

// ── Template escaping ────────────────────────────────────────────────────────────────────────
const stripClock = (html: string) => html.replace(/>[^<]* IST<\/p>/, ">IST</p>");
test("templates: malicious accountName, alert label, campaign name and recipient are escaped", async () => {
  const { buildHtml } = (await load(SE)) as any;
  const { escapeEmailData, escapeHtml } = await import("./htmlEscape.ts");
  const bad = `<script>alert(1)</script><img src=x onerror="alert(2)"><a href="https://evil.example">x</a>`;
  const render = (type: string, data: any) => buildHtml(type, escapeEmailData(type, data, false), escapeHtml(bad));
  const outputs = [
    render("weeklyReport", { accountName: bad, compare: [], gainers: [], losers: [], bestSellers: [], platforms: [], departments: [] }),
    render("dailyDigest", { accountName: bad, dateLabel: bad, metrics: {}, deltas: {}, inventory: {}, stockoutItems: [], bleedingItems: [], wastedTerms: [], topCampaigns: [], topProducts: [], topTerms: [] }),
    render("liveAlerts", { accountName: bad, alerts: [] }),
    render("confirmation", { activeAlerts: [bad] }),
    render("campaign", { campaigns: [{ name: bad, acos: 50, sales: 1, spend: 1, roas: 1, orders: 0, suggestion: bad }] }),
    render("test", {}),
  ];
  for (const html of outputs) {
    assert.ok(!html.includes("<script>"), "raw <script> leaked");
    assert.ok(!html.includes("<img src=x"), "raw <img> leaked");
    assert.ok(!html.includes(`<a href="https://evil.example"`), "raw <a> leaked");
    assert.ok(html.includes("&lt;script&gt;"), "escaped text should still be visible");
  }
});
test("templates: plain-text data renders byte-identical with or without escaping", async () => {
  const { buildHtml } = (await load(SE)) as any;
  const { escapeEmailData } = await import("./htmlEscape.ts");
  const data = { accountName: "B-ARM", activeAlerts: ["ROAS / ACOS Alerts", "Daily Digest (10:00 AM IST)"], acosThreshold: 40, lowStockThreshold: 5,
    campaigns: [{ name: "SP - Knee Brace - Auto", acos: 55.2, sales: 1200, spend: 662, roas: 1.81, orders: 3 }] };
  for (const type of ["confirmation", "campaign"]) {
    assert.equal(stripClock(buildHtml(type, escapeEmailData(type, data, false), "x@example.com")), stripClock(buildHtml(type, data, "x@example.com")));
  }
});

// ── Login + email settings ───────────────────────────────────────────────────────────────────
const ES = "pages/api/email-settings.ts";
test("email-settings: unauthenticated GET and POST -> 401, nothing read or written", async () => {
  assert.equal((await call(ES, { method: "GET", query: { keySlot: "B" } })).statusCode, 401);
  assert.equal((await call(ES, { method: "POST", body: { keySlot: "B", notifEmail: "attacker@example.com" } })).statusCode, 401);
  assert.deepEqual(fetchCalls, []);
});
test("login: wrong password, unknown user, or unconfigured -> rejected", async () => {
  const LG = "pages/api/auth/login.ts";
  assert.equal((await call(LG, { body: { username: "Barm", password: "nope" } })).statusCode, 401);
  assert.equal((await call(LG, { body: { username: "admin", password: PASSWORD } })).statusCode, 401);
  delete process.env.DASHBOARD_PASSWORD;
  assert.equal((await call(LG, { body: { username: "Barm", password: PASSWORD } })).statusCode, 503);
});
test("login: repeated failures are rate limited", async () => {
  const LG = "pages/api/auth/login.ts";
  for (let i = 0; i < 10; i++) await call(LG, { body: { username: "Barm", password: "nope" } });
  assert.equal((await call(LG, { body: { username: "Barm", password: PASSWORD } })).statusCode, 429);
});
test("legitimate Settings flow: login cookie -> GET/POST email-settings pass the gate", async () => {
  const login = await call("pages/api/auth/login.ts", { body: { username: "Barm", password: PASSWORD } });
  assert.equal(login.statusCode, 200);
  const setCookie = login.headers["set-cookie"];
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  const cookie = setCookie.split(";")[0];
  const get = await call(ES, { method: "GET", headers: { cookie }, query: { keySlot: "B" } });
  assert.equal(get.statusCode, 200); // Supabase unconfigured offline -> empty settings, no network
  const post = await call(ES, { method: "POST", headers: { cookie }, body: { keySlot: "B", notifEmail: "me@example.com" } });
  assert.equal(post.statusCode, 500); // reached writeEmailSettings, which refuses without Supabase env
  assert.match(post.body.error, /not configured/);
  assert.deepEqual(fetchCalls, []);
});

// ── Browser-facing report/generate routes ────────────────────────────────────────────────────
for (const route of ["weekly-report", "send-historical-email", "send-ad-spend-email", "generate-ad-spend-report", "generate-fba-forecast-report"]) {
  test(`${route}: unauthenticated (including force:true / arbitrary to) -> 401`, async () => {
    const r = await call(`pages/api/${route}.ts`, { body: { endDate: "2026-09-01", reportDate: "2026-09-01", force: true, to: "attacker@example.com", amazon_account_id: "a", workspace_id: "w" } });
    assert.equal(r.statusCode, 401);
    assert.deepEqual(fetchCalls, []);
  });
}
for (const route of ["ad-spend-report-status", "fba-forecast-report-status"]) {
  test(`${route}: unauthenticated -> 401`, async () => {
    assert.equal((await call(`pages/api/${route}.ts`, { method: "GET", query: { endDate: "2026-09-01", reportDate: "2026-09-01" } })).statusCode, 401);
  });
}
test("weekly-report: signed-in browser cannot pick recipients (to ignored; saved recipients required)", async () => {
  const r = await call("pages/api/weekly-report.ts", { headers: session(), body: { amazon_account_id: "a", workspace_id: "w", recipients: "saved", to: "attacker@example.com" } });
  assert.equal(r.statusCode, 400);
  assert.match(r.body.error, /No alert email saved/);
  assert.deepEqual(fetchCalls, []);
});
test("generate-ad-spend-report: signed-in browser passes the gate (stops at unconfigured Supabase, no job created)", async () => {
  const r = await call("pages/api/generate-ad-spend-report.ts", { headers: session(), body: { endDate: "2026-09-01", force: true } });
  assert.equal(r.statusCode, 500);
  assert.deepEqual(fetchCalls, []);
});

// ── App Router routes ────────────────────────────────────────────────────────────────────────
async function post(rel: string, headers: Record<string, string> = {}, body: unknown = {}) {
  const mod = (await jiti.import(abs(rel))) as { POST: (r: Request) => Promise<Response> };
  return mod.POST(new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
}
test("gemini-insights / daily-ad-spend-insights: unauthenticated -> 401", async () => {
  assert.equal((await post("app/api/gemini-insights/route.ts", {}, { prompt: "hi" })).status, 401);
  assert.equal((await post("app/api/daily-ad-spend-insights/route.ts", {}, { products: [{}] })).status, 401);
  assert.deepEqual(fetchCalls, []);
});
test("gemini-insights: signed-in calls are rate limited (30 per window)", async () => {
  const h = session();
  for (let i = 0; i < 30; i++) {
    assert.equal((await post("app/api/gemini-insights/route.ts", h, { prompt: "hi" })).status, 500); // no GEMINI_API_KEY offline
  }
  assert.equal((await post("app/api/gemini-insights/route.ts", h, { prompt: "hi" })).status, 429);
  assert.deepEqual(fetchCalls, []);
});
test("Gemini API key never travels in a URL; the query-string route is gone", () => {
  for (const rel of ["app/api/gemini-insights/route.ts", "app/api/daily-ad-spend-insights/route.ts"]) {
    const src = readFileSync(path.join(SRC, rel), "utf8");
    assert.ok(!/[?&]key=/.test(src), `${rel} puts a key in a URL`);
    assert.ok(src.includes("x-goog-api-key"), `${rel} should send the key as a header`);
  }
  assert.equal(existsSync(path.join(SRC, "pages/api/recommendations.js")), false);
});
test("generate-historical-report: requires the internal signature (a browser session is not enough)", async () => {
  assert.equal((await post("app/api/generate-historical-report/route.ts")).status, 401);
  assert.equal((await post("app/api/generate-historical-report/route.ts", session())).status, 401);
});

// ── SellerMate proxy ─────────────────────────────────────────────────────────────────────────
test("tool.js: unauthenticated -> 401; signed-in passes the gate (stops at missing SellerMate key)", async () => {
  assert.equal((await call("pages/api/tool.js", { body: { tool: "get_orders_report", args: {} } })).statusCode, 401);
  const r = await call("pages/api/tool.js", { headers: session(), body: { tool: "get_orders_report", args: {} } });
  assert.equal(r.statusCode, 500);
  assert.deepEqual(fetchCalls, []);
});

// ── internalFetch destination safety ─────────────────────────────────────────────────────────
test("internalOrigin ignores Host; internalFetch refuses other origins and signs its own", async () => {
  const { internalFetch, internalOrigin } = (await jiti.import(abs("lib/internalFetch.ts"))) as any;
  assert.equal(internalOrigin(), "http://localhost:3000");
  process.env.VERCEL_URL = "app-abc.vercel.app";
  assert.equal(internalOrigin(), "https://app-abc.vercel.app");
  process.env.APP_INTERNAL_ORIGIN = "https://dash.example.com/some/path";
  assert.equal(internalOrigin(), "https://dash.example.com");
  await assert.rejects(internalFetch("https://attacker.example/api/send-email"), /refused/);
  assert.deepEqual(fetchCalls, []);
  let seen: Record<string, string> = {};
  globalThis.fetch = (async (_u: unknown, init: RequestInit) => { seen = init.headers as Record<string, string>; return new Response("{}"); }) as typeof fetch;
  await internalFetch("https://dash.example.com/api/send-email", { method: "POST" });
  assert.equal(seen[INTERNAL_AUTH_HEADER], INTERNAL);
  blockNetwork();
  delete process.env.VERCEL_URL;
  delete process.env.APP_INTERNAL_ORIGIN;
});
