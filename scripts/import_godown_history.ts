// One-off: load the godown workbook's older daily history into barm_godown_daily (user, 2026-10-13).
//
//   npx tsx scripts/import_godown_history.ts "<Combined godown stock sheet as on DD.MM.YYYY.xlsx>"            → dry run
//   npx tsx scripts/import_godown_history.ts "<file>" --apply                                                → insert
//
// Rules (user-approved):
//   * only DATES that have no row at all in barm_godown_daily are imported — a date already in the
//     table is never touched, even for products missing on it (those are mostly renamed products,
//     which would otherwise be counted twice; see src/lib/godownProductAliases.ts);
//   * insert-only: ON CONFLICT DO NOTHING, so an existing row is never overwritten;
//   * the file's blocks are read by their own sub-headers (parseGodownSheet): Opening | Stock IN |
//     Stock Out | Closing from 19.07.2026, Stock IN | Stock Out | Total Stock Count before that;
//     an incomplete block (20.11.2024, cut off at the last column) is skipped.
// After --apply it re-reads the table and checks every imported date has the expected row count.

import * as XLSX from "xlsx";
import { parseGodownSheet } from "../src/lib/consolidatedStock.ts";
import { supabasePublic } from "../src/lib/amazonReportUpload.ts";

const [file, flag] = process.argv.slice(2);
if (!file) throw new Error("usage: import_godown_history.ts <godown workbook> [--apply]");
const apply = flag === "--apply";

async function dbDates(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabasePublic.from("barm_godown_daily").select("stock_date").order("stock_date").order("product").range(from, from + 999);
    if (error) throw new Error(`barm_godown_daily: ${error.message}`);
    for (const r of data ?? []) counts.set(r.stock_date as string, (counts.get(r.stock_date as string) ?? 0) + 1);
    if (!data || data.length < 1000) return counts;
  }
}

(async () => {
  const wb = XLSX.readFile(file);
  const sheet = (re: RegExp) => { const n = wb.SheetNames.find((s) => re.test(s.trim())); return n ? XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[n], { header: 1, defval: null, raw: true }) : []; };
  const parsed = parseGodownSheet(sheet(/^fc stock sheet$/i), sheet(/^discontinued products$/i), 100_000);
  const before = await dbDates();
  const rows = parsed.daily.filter((d) => !before.has(d.date));
  const dates = [...new Set(rows.map((r) => r.date))].sort();
  const perDate = new Map<string, number>();
  for (const r of rows) perDate.set(r.date, (perDate.get(r.date) ?? 0) + 1);
  console.log({ mode: apply ? "APPLY" : "DRY RUN", fileDates: new Set(parsed.daily.map((d) => d.date)).size, dbDatesBefore: before.size, importDates: dates.length, importRows: rows.length, first: dates[0], last: dates.at(-1), warnings: parsed.warnings });
  if (!apply || !rows.length) return;

  const now = new Date().toISOString();
  for (let i = 0; i < rows.length; i += 1000) {
    const part = rows.slice(i, i + 1000).map((d) => ({ stock_date: d.date, product: d.product, opening: d.opening, stock_in: d.stockIn, stock_out: d.stockOut, closing: d.closing, uploaded_at: now }));
    const { error } = await supabasePublic.from("barm_godown_daily").upsert(part, { onConflict: "stock_date,product", ignoreDuplicates: true });
    if (error) throw new Error(`insert at row ${i}: ${error.message}`);
    if ((i / 1000) % 20 === 0) console.log(`  inserted ${Math.min(i + 1000, rows.length)} / ${rows.length}`);
  }
  const after = await dbDates();
  const wrong = dates.filter((d) => after.get(d) !== perDate.get(d));
  const touched = [...before].filter(([d, n]) => after.get(d) !== n);
  console.log({ dbDatesAfter: after.size, rowsAfter: [...after.values()].reduce((a, b) => a + b, 0), importedDatesWithWrongCount: wrong.length, existingDatesChanged: touched.length });
  if (wrong.length || touched.length) process.exitCode = 1;
})().catch((e) => { console.error("ERR", e); process.exit(1); });
