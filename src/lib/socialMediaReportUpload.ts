import * as XLSX from "xlsx";
import { supabasePublic } from "@/lib/amazonReportUpload";
import { toDate } from "@/lib/meeshoReportUpload";
import { mergeMetaRows } from "@/lib/socialMediaRules";

// Social Media (Meta Ads Manager) ad-spend upload — same shape as
// meeshoReportUpload.ts: one card, parsed in the browser, written into a
// barm_daily_* raw table (see scripts/barm_daily_social_media_table.sql).
//
// Meta's "Raw Data Report" export (Ads Manager) always includes a leading
// row with a blank Campaign name that is the SUM of every real campaign row
// below it — that row is skipped entirely, never stored, since it carries no
// campaign identity to key on and would double the real total if kept.
//
// The export can be either a single reporting day (Reporting starts ===
// Reporting ends) or a multi-day range (e.g. "last 7 days") — both are
// accepted through this one card. Rows are keyed on
// (report_start, report_end, campaign_name), so a daily upload and a range
// upload for the same campaign never collide; see fetchSocialMediaAdSpend in
// adSpendReportExport.ts for how the report picks between them without
// double-counting.

export const SOCIAL_MEDIA_TABLE = "barm_daily_social_media";

type RawRow = Record<string, unknown>;

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}
function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = str(v).replace(/[^0-9.eE+-]/g, "");
  if (!s) return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function normalizeHeaderKey(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Header lookup tolerant of trailing spaces / case, same approach as
 *  meeshoReportUpload.ts's makePicker. */
function makePicker(row: RawRow) {
  const keys = Object.keys(row);
  const normalized = new Map<string, string>();
  keys.forEach((k) => normalized.set(normalizeHeaderKey(k), k));
  return (...candidates: string[]): unknown => {
    for (const cand of candidates) {
      const hit = normalized.get(normalizeHeaderKey(cand));
      if (hit !== undefined) return row[hit];
    }
    return "";
  };
}

async function readRows(file: File): Promise<{ row: RawRow; sheet: string }[]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  // Every sheet, not just the first: the seller's workbook often carries a single-day sheet and a
  // 7-day sheet side by side (e.g. "meta adspend sept 29" + "meta adspend sept 23-29"), and reading
  // only SheetNames[0] silently dropped the range total. A sheet with no Meta columns just yields
  // rows that mapRow can't date, which the filter in uploadSocialMediaReportFile drops.
  return wb.SheetNames.flatMap((name) =>
    XLSX.utils.sheet_to_json<RawRow>(wb.Sheets[name], { defval: "", raw: true }).map((row) => ({ row, sheet: name })));
}

interface MappedRow {
  sheet: string;
  report_start: string | null;
  report_end: string | null;
  campaign_name: string;
  spend: number;
  currency: string;
  raw: RawRow;
}

function mapRow({ row, sheet }: { row: RawRow; sheet: string }): MappedRow {
  const p = makePicker(row);
  return {
    sheet,
    report_start: toDate(p("Reporting starts")),
    report_end: toDate(p("Reporting ends")),
    campaign_name: str(p("Campaign name", "Campaign Name")),
    spend: num(p("Amount spent (INR)", "Amount spent")),
    currency: str(p("Currency")) || "INR",
    raw: row,
  };
}

async function upsertInChunks(rows: Record<string, unknown>[], chunkSize = 300): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const { error } = await supabasePublic.from(SOCIAL_MEDIA_TABLE).upsert(rows.slice(i, i + chunkSize), {
      onConflict: "report_start,report_end,campaign_name",
    });
    if (error) throw new Error(`Upsert into ${SOCIAL_MEDIA_TABLE} failed: ${error.message}`);
  }
}

export interface SocialMediaUploadResult {
  totalRows: number;
  savedRows: number;
  skippedRows: number;
  minDate: string | null;
  maxDate: string | null;
  /** One entry per reporting window saved (a single day, a 7-day range, ...), oldest end first —
   *  so the card can show that a two-sheet workbook saved both its day and its range. */
  windows: SocialMediaSavedWindow[];
}

export interface SocialMediaSavedWindow {
  start: string;
  end: string;
  days: number;
  spend: number;
  campaigns: number;
}

function savedWindows(rows: { report_start?: string | null; report_end?: string | null; spend?: number }[]): SocialMediaSavedWindow[] {
  const byWindow = new Map<string, SocialMediaSavedWindow>();
  for (const r of rows) {
    if (!r.report_start || !r.report_end) continue;
    const key = `${r.report_start}|${r.report_end}`;
    const w = byWindow.get(key) ?? {
      start: r.report_start,
      end: r.report_end,
      days: Math.round((Date.parse(r.report_end) - Date.parse(r.report_start)) / 86_400_000) + 1,
      spend: 0,
      campaigns: 0,
    };
    w.spend = Math.round((w.spend + (r.spend ?? 0)) * 100) / 100;
    w.campaigns += 1;
    byWindow.set(key, w);
  }
  return [...byWindow.values()].sort((a, b) => a.end.localeCompare(b.end) || b.days - a.days);
}

export async function uploadSocialMediaReportFile(file: File): Promise<SocialMediaUploadResult> {
  const rawRows = await readRows(file);
  const mapped = rawRows.map(mapRow);
  // The blank-campaign "Total" row (and any row missing a usable date) is
  // dropped here rather than stored — see the module comment above.
  // One row per window + campaign (Postgres rejects an upsert batch that touches the same row
  // twice): the same campaign twice in one sheet ADDS its spend; a copy in another sheet for the
  // same window is not doubled — see socialMediaRules.ts. `sheet` is not a table column.
  const valid = mergeMetaRows(mapped).map((r) => { const row: Partial<MappedRow> = { ...r }; delete row.sheet; return row; });

  if (!valid.length) {
    return { totalRows: rawRows.length, savedRows: 0, skippedRows: rawRows.length, minDate: null, maxDate: null, windows: [] };
  }

  await upsertInChunks(valid as unknown as Record<string, unknown>[]);

  const starts = valid.map((r) => r.report_start as string).sort();
  const ends = valid.map((r) => r.report_end as string).sort();
  return {
    totalRows: rawRows.length,
    savedRows: valid.length,
    skippedRows: rawRows.length - valid.length,
    minDate: starts[0] ?? null,
    maxDate: ends[ends.length - 1] ?? null,
    windows: savedWindows(valid),
  };
}

export interface SocialMediaReportDataInfo {
  rowCount: number;
  minDate: string | null;
  maxDate: string | null;
  error?: string;
}

export async function fetchSocialMediaReportDataInfo(): Promise<SocialMediaReportDataInfo> {
  const [minRes, maxRes, countRes] = await Promise.all([
    supabasePublic.from(SOCIAL_MEDIA_TABLE).select("report_start").order("report_start", { ascending: true }).limit(1),
    supabasePublic.from(SOCIAL_MEDIA_TABLE).select("report_end").order("report_end", { ascending: false }).limit(1),
    supabasePublic.from(SOCIAL_MEDIA_TABLE).select("id", { count: "exact", head: true }),
  ]);
  const failure = minRes.error || maxRes.error || countRes.error;
  if (failure) return { rowCount: 0, minDate: null, maxDate: null, error: failure.message };

  const minDate = (minRes.data?.[0] as unknown as { report_start: string } | undefined)?.report_start ?? null;
  const maxDate = (maxRes.data?.[0] as unknown as { report_end: string } | undefined)?.report_end ?? null;
  return {
    rowCount: countRes.count || 0,
    minDate: minDate ? minDate.slice(0, 10) : null,
    maxDate: maxDate ? maxDate.slice(0, 10) : null,
  };
}
