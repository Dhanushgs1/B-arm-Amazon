// Proves buildAdSpendReportWorkbook is read-only unless a caller explicitly asks for history to be
// saved: a preview/audit build once overwrote production barm_ad_spend_history rows just by being
// generated. fetch is stubbed with a fake Supabase that serves one Sponsored Products row and records
// every request, so this runs offline and can never touch a real database.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/testing/asserts.ts";

Deno.env.set("SUPABASE_URL", "http://fake-supabase.test");
Deno.env.set("SUPABASE_ANON_KEY", "fake-anon-key");
Deno.env.set("GEMINI_API_KEY", "fake-gemini-key");

type Call = { method: string; url: string };
const calls: Call[] = [];

const SP_ROW = {
  id: 1, report_date: "2026-09-17", campaign_name: "Test campaign", ad_group_name: "Test group",
  advertised_sku: "TEST-SKU-1", advertised_asin: "B000TEST01", impressions: 100, clicks: 10,
  spend: 250, sales_7d: 1000, orders_7d: 2, units_7d: 2, advertised_sku_units_7d: 2,
};

const realFetch = globalThis.fetch;
globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
  calls.push({ method, url });
  const json = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "content-range": "0-0/*" } }));
  if (method !== "GET" && method !== "HEAD") return json([], 201);
  const u = new URL(url);
  const table = u.pathname.split("/").pop();
  const firstPage = !u.searchParams.get("offset") || u.searchParams.get("offset") === "0";
  return json(table === "barm_amazon_sp_advertised_product" && firstPage ? [SP_ROW] : []);
};

const { buildAdSpendReportWorkbook } = await import("./adSpendReportExport.ts");

const writes = () => calls.filter((c) => c.method !== "GET" && c.method !== "HEAD");
const geminiCalls = () => calls.filter((c) => c.url.includes("generativelanguage.googleapis.com"));

Deno.test("preview build (no persistHistory) sends zero writes and zero Gemini calls", async () => {
  calls.length = 0;
  const res = await buildAdSpendReportWorkbook({ endDate: "2026-09-17", aiSuggestions: false });
  assert(calls.length > 0, "the fake Supabase should have been read from");
  assertEquals(writes(), []);
  assertEquals(geminiCalls(), []);
  assertEquals(res.historyRowsSaved, 0);
});

Deno.test("persistHistory: true writes exactly two upserts, into barm_ad_spend_history and barm_ad_spend_history_30d only", async () => {
  calls.length = 0;
  const res = await buildAdSpendReportWorkbook({ endDate: "2026-09-17", aiSuggestions: false, persistHistory: true });
  const w = writes();
  assertEquals(w.length, 2);
  w.forEach((c) => assertEquals(c.method, "POST"));
  const tables = w.map((c) => new URL(c.url).pathname.split("/").pop()).sort();
  assertEquals(tables, ["barm_ad_spend_history", "barm_ad_spend_history_30d"]);
  assert(res.historyRowsSaved >= 1);
});

Deno.test("persistHistory30dOnly: true writes exactly one upsert, into barm_ad_spend_history_30d only", async () => {
  calls.length = 0;
  const res = await buildAdSpendReportWorkbook({ endDate: "2026-09-17", aiSuggestions: false, persistHistory30dOnly: true });
  const w = writes();
  assertEquals(w.length, 1);
  assertEquals(w[0].method, "POST");
  assertEquals(new URL(w[0].url).pathname.split("/").pop(), "barm_ad_spend_history_30d");
  assertEquals(res.historyRowsSaved, 0);
});

Deno.test("the fake fetch is restored after the suite", () => {
  globalThis.fetch = realFetch;
  assert(globalThis.fetch === realFetch);
});
