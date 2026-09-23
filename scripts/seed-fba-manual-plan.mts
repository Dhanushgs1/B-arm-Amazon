// scripts/seed-fba-manual-plan.mts
// One-time loader for the FBA Forecast Report's reference data. Reads the
// seller's manual "FBA_forecast sheet(30 days).xlsx" — shared as a
// reference/template, not a recurring upload — and stores its FBA analysis
// sheet's SKU × zone list (in its own row order) and column X "Stock present
// per SKU ID for FBA - booked" in barm_fba_manual_plan, which the report
// function reads. Rows with no zone typed are skipped.
//
// Usage (from the ppc-dashboard folder, with NEXT_PUBLIC_SUPABASE_URL and
// NEXT_PUBLIC_SUPABASE_ANON_KEY set, e.g. from .env.local):
//   node scripts/seed-fba-manual-plan.mts "<path to FBA_forecast sheet(30 days).xlsx>"
import fs from "node:fs";
import XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";
import { parseManualPlanGrid } from "../src/lib/fbaForecastRules.ts";

const file = process.argv[2];
if (!file) throw new Error("Pass the path to the manual FBA_forecast sheet workbook.");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set.");

const wb = XLSX.read(fs.readFileSync(file), { type: "buffer", sheets: ["FBA analysis"] });
const ws = wb.Sheets["FBA analysis"];
if (!ws) throw new Error(`No "FBA analysis" sheet in ${file}.`);
const { rows, skippedNoZone } = parseManualPlanGrid(XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true }) as unknown[][]);
console.log(`Parsed ${rows.length} SKU × zone rows (${new Set(rows.map((r) => r.sku)).size} SKUs, ${rows.filter((r) => r.stock_to_send !== null).length} with an X value); skipped ${skippedNoZone} rows with no zone.`);

const supabase = createClient(url, key);
const { data, error } = await supabase.rpc("replace_barm_fba_manual_plan", { rows });
if (error) throw new Error(`replace_barm_fba_manual_plan failed: ${error.message}`);
const { count, error: countErr } = await supabase.from("barm_fba_manual_plan").select("*", { count: "exact", head: true });
if (countErr) throw new Error(`Row count check failed: ${countErr.message}`);
if (Number(data) !== rows.length || count !== rows.length) throw new Error(`Saved ${data} / table has ${count}, expected ${rows.length}.`);
console.log(`Saved and verified: barm_fba_manual_plan has ${count} rows.`);
