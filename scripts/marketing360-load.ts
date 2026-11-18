// Load the marketing team's Drive files into the Product Marketing 360 tables — same parsers and
// same writes as the page's "Import Drive files" panel (src/lib/marketing360Store.ts).
//
//   node scripts/marketing360-load.ts [--dry] <file.xlsx> [more files…]
//
// Kind is detected from the workbook; the rating / forecast date comes from the file name
// ("… 16 Nov 2026 …", "FBA Forecasting 2026-11-16.xlsx"). Reads NEXT_PUBLIC_SUPABASE_* from .env.local.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import * as XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";
import { detectKind } from "../src/lib/marketing360Import.ts";
import { importWorkbook } from "../src/lib/marketing360Store.ts";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const files = args.filter((a) => a !== "--dry");
if (!files.length) {
  console.error("usage: node scripts/marketing360-load.ts [--dry] <file.xlsx> …");
  process.exit(1);
}

const env: Record<string, string> = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

for (const file of files) {
  const wb = XLSX.read(readFileSync(file), { type: "buffer" });
  console.log(`${basename(file)}: ${detectKind(wb) ?? "unknown"}`);
  const res = await importWorkbook(db, wb, basename(file), { dry });
  console.log("  " + res.summary);
}
