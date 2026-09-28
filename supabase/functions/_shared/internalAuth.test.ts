// Offline tests for the Edge Functions' shared-secret gate and template escaping.
//   deno test supabase/functions/_shared/internalAuth.test.ts --allow-env
import { assertEquals } from "https://deno.land/std@0.224.0/testing/asserts.ts";
import { checkInternalAuth, INTERNAL_AUTH_HEADER, rejectUnlessInternal } from "./internalAuth.ts";
import { escapeDeep, escapeHtml } from "./htmlEscape.ts";

Deno.test("missing INTERNAL_API_SECRET fails closed (503)", async () => {
  assertEquals(await checkInternalAuth("anything", undefined), { ok: false, status: 503, error: "INTERNAL_API_SECRET is not configured" });
});

Deno.test("missing header -> 401", async () => {
  assertEquals((await checkInternalAuth(null, "edge-test")).ok, false);
  assertEquals(await checkInternalAuth(null, "edge-test"), { ok: false, status: 401, error: "Unauthorized" });
});

Deno.test("wrong secret -> 401 (including prefix / longer values)", async () => {
  for (const bad of ["edge-tesX", "edge-tes", "edge-test2", ""]) {
    assertEquals((await checkInternalAuth(bad, "edge-test")).ok, false, bad);
  }
});

Deno.test("correct secret -> accepted", async () => {
  assertEquals(await checkInternalAuth("edge-test", "edge-test"), { ok: true });
});

Deno.test("rejectUnlessInternal reads the header and the function secret", async () => {
  Deno.env.set("INTERNAL_API_SECRET", "edge-test");
  const mk = (h: Record<string, string>) => new Request("http://edge/fn", { method: "POST", headers: h });
  assertEquals((await rejectUnlessInternal(mk({})))?.status, 401);
  assertEquals((await rejectUnlessInternal(mk({ [INTERNAL_AUTH_HEADER]: "nope" })))?.status, 401);
  assertEquals(await rejectUnlessInternal(mk({ [INTERNAL_AUTH_HEADER]: "edge-test" })), null);
  Deno.env.delete("INTERNAL_API_SECRET");
  assertEquals((await rejectUnlessInternal(mk({ [INTERNAL_AUTH_HEADER]: "edge-test" })))?.status, 503);
});

Deno.test("escapeDeep escapes nested strings and leaves numbers", () => {
  const out = escapeDeep({ n: 3, rows: [{ name: `<img src=x onerror="alert(1)">` }] });
  assertEquals(out, { n: 3, rows: [{ name: "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;" }] });
  assertEquals(escapeHtml("a & b"), "a &amp; b");
});
