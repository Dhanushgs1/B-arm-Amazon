// fetchAllRows (Edge copy) must survive a transient statement timeout on a page instead of failing
// the whole daily report job. fetch is stubbed, so this never reaches a real database.
import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/testing/asserts.ts";

Deno.env.set("SUPABASE_URL", "http://fake-supabase.test");
Deno.env.set("SUPABASE_ANON_KEY", "fake-anon-key");

let failuresLeft = 0;
let requests = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (): Promise<Response> => {
  requests++;
  if (failuresLeft > 0) {
    failuresLeft--;
    return Promise.resolve(new Response(JSON.stringify({ code: "57014", message: "canceling statement due to statement timeout" }), { status: 500, headers: { "content-type": "application/json" } }));
  }
  return Promise.resolve(new Response(JSON.stringify([{ id: 1 }, { id: 2 }]), { status: 200, headers: { "content-type": "application/json", "content-range": "0-1/*" } }));
};

const { fetchAllRows } = await import("./amazonReportShared.ts");

Deno.test("a page that times out twice is retried and the rows still arrive", async () => {
  failuresLeft = 2; requests = 0;
  const rows = await fetchAllRows("some_table", (q) => q);
  assertEquals(rows.length, 2);
  assertEquals(requests, 3);
});

Deno.test("three consecutive failures still surface as an error (no silent empty result)", async () => {
  failuresLeft = 3; requests = 0;
  await assertRejects(() => fetchAllRows("some_table", (q) => q), Error, "statement timeout");
  assertEquals(requests, 3);
});

Deno.test("restore fetch", () => { globalThis.fetch = realFetch; });
