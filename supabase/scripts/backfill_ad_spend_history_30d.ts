// Backfill barm_ad_spend_history_30d (scripts/ad_spend_history_30d_table.sql) for past report dates.
// Writes ONLY that table — barm_ad_spend_history and every other table are left untouched
// (persistHistory30dOnly; see the readonly test in supabase/functions/_shared).
//
// Run from ppc-dashboard/ with Deno, reading SUPABASE_URL / SUPABASE_ANON_KEY from .env.local:
//   deno run --no-check --allow-env --allow-net --allow-read --env-file=.env.local \
//     supabase/scripts/backfill_ad_spend_history_30d.ts 2026-10-07 [2026-10-06 ...]
// With no dates, backfills every report_date already in barm_ad_spend_history.
import { buildAdSpendReportWorkbook } from "../functions/_shared/adSpendReportExport.ts";

const url = Deno.env.get("SUPABASE_URL");
const key = Deno.env.get("SUPABASE_ANON_KEY");
if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY not set (pass --env-file=.env.local)");

// --full: a real persisted generation (persistHistory) — also writes barm_ad_spend_history (Day/7D).
// Use only for dates that have no report saved yet; it is the same save "Generate & Download" does.
const full = Deno.args.includes("--full");
let dates = Deno.args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
if (!dates.length) {
  const res = await fetch(`${url}/rest/v1/barm_ad_spend_history?select=report_date&order=report_date.desc&limit=100000`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`Could not list report dates: ${res.status} ${await res.text()}`);
  dates = [...new Set(((await res.json()) as { report_date: string }[]).map((r) => r.report_date))];
}

for (const endDate of dates) {
  const t0 = Date.now();
  try {
    const res = await buildAdSpendReportWorkbook(
      full ? { endDate, aiSuggestions: false, persistHistory: true } : { endDate, aiSuggestions: false, persistHistory30dOnly: true }
    );
    const missing = res.incompleteDates.map((d) => `${d.platform}: ${d.missingDates.join(",")}`).join("; ");
    console.log(`${endDate}: done in ${((Date.now() - t0) / 1000).toFixed(1)}s${full ? `, history rows ${res.historyRowsSaved}` : ""}${missing ? ` (missing source days — ${missing})` : ""}`);
  } catch (err) {
    console.error(`${endDate}: FAILED — ${err instanceof Error ? err.message : err}`);
  }
}
