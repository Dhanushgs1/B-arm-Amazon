// Smoke check (2026-11-20): the FC Forecast RPCs answer with the anon key, as the page will call them.
// Usage: node scripts/fc-forecast-rpc-check.mjs <path to .env.local> [as_of YYYY-MM-DD]
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const [, , envPath, asOf = "2026-11-19"] = process.argv;
const env = Object.fromEntries(readFileSync(envPath, "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l))
  .map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]));
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
const f = await db.rpc("fc_forecast", { p_as_of: asOf });
const u = await db.rpc("fc_unmapped_skus", { p_as_of: asOf });
const s = await db.rpc("fc_source_dates");
for (const [n, r] of [["fc_forecast", f], ["fc_unmapped_skus", u], ["fc_source_dates", s]]) if (r.error) throw new Error(`${n}: ${r.error.message}`);
if (f.data.length < 186) throw new Error(`fc_forecast returned ${f.data.length} rows`);
if (f.data.some((r) => r.min_stock < 5)) throw new Error("min_stock below 5");
// SQL fc_norm_sku must strip exactly what normalizeSku() strips (same fixtures as sellerFlexShipments.test.ts).
const fixtures = [["\u200EB-VD-PLAS-TPE ", "b-vd-plas-tpe"], ["\tA019\r\n", "a019"], ["B-XYZ\u00A0", "b-xyz"], ["\uFEFF\u3000SC25\u2009", "sc25"], ["B-MID SPACE", "b-mid space"]];
for (const [i, want] of fixtures) {
  const { data, error } = await db.rpc("fc_norm_sku", { s: i });
  if (error || data !== want) throw new Error(`fc_norm_sku(${JSON.stringify(i)}) = ${JSON.stringify(data)} (${error?.message ?? ""}), want ${want}`);
}
console.log(`fc_forecast ${f.data.length} rows, unmapped ${u.data.length}, sources ${s.data.map((x) => `${x.source}=${x.max_day}`).join(" ")}`);
