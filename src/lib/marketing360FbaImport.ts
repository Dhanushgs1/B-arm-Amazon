// Product Marketing 360 — verified FBA forecast auto-import (user, 2026-11-25). A daily
// "FBA Forecasting YYYY-MM-DD.xlsx" from the FBA pipeline's Output folder is imported only when ALL of:
//   1. its name is exactly that shape (copies such as "2026-11-24 1102 - FBA Forecasting …" are skipped);
//   2. Drive has not changed it for SETTLE_MS (never a file that is still being written);
//   3. the pipeline's "FBA Forecasting Run Log" → "Forecast Run Log" tab has, as its LATEST row for that
//      date, Status PASS naming that file (and, when the row states "N data rows", the file has N);
//   4. its size is close to the previous imported day (zone rows and SKUs ≥ MIN_RATIO of it, FC rows > 0).
// Then the day is replaced in ONE database transaction (mkt_replace_fba_forecast): no half-imported day,
// no duplicates on a re-import, other dates (history) untouched. Anything that fails a check is held
// and retried next run; nothing is written.
//
// No Drive / Supabase calls here — they are passed in (deps), so the whole flow is unit tested.

import * as XLSX from "xlsx";
import { detectKind, parseForecast, type FcStockRow, type ForecastZoneRow } from "./marketing360Import.ts";

export const SETTLE_MS = 15 * 60_000;
export const MIN_RATIO = 0.9;
export const RUN_LOG_TAB = "Forecast Run Log";
const NAME = /^FBA Forecasting (\d{4}-\d{2}-\d{2})(\.xlsx)?$/i;

export type FbaFile = { id: string; name: string; modifiedTime: string };
export type Verdict = { ok: boolean; reason: string };
export type Counts = { zones: number; skus: number; fc: number };

/** Forecast date from the exact file name, else null. */
export function forecastDate(name: string): string | null {
  return NAME.exec(name.trim())?.[1] ?? null;
}

/** True once Drive's copy has been unchanged for `settleMs`. */
export function isSettled(f: Pick<FbaFile, "modifiedTime">, nowMs: number, settleMs = SETTLE_MS): boolean {
  const t = Date.parse(f.modifiedTime);
  return Number.isFinite(t) && nowMs - t >= settleMs;
}

const isoOf = (v: unknown): string | null => {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  // a sheet date serial: days since 1899-12-30
  if (typeof v === "number" && Number.isFinite(v)) return new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86_400_000).toISOString().slice(0, 10);
  return /^\s*(\d{4}-\d{2}-\d{2})/.exec(String(v ?? ""))?.[1] ?? null;
};
const cell = (row: Record<string, unknown>, name: string): string => {
  const k = Object.keys(row).find((h) => h.trim().toLowerCase() === name.toLowerCase());
  return k === undefined ? "" : String(row[k] ?? "").trim();
};

/** The run log's rows for `date`, in sheet order; the LAST one decides (a later re-run supersedes). */
export function runLogVerdict(rows: Record<string, unknown>[], date: string, fileName: string, dataRows?: number): Verdict {
  const forDate = rows.filter((r) => isoOf(r[Object.keys(r).find((h) => h.trim().toLowerCase() === "date") ?? ""]) === date);
  if (!forDate.length) return { ok: false, reason: `Forecast Run Log has no row for ${date} yet` };
  const last = forDate[forDate.length - 1];
  // "PASS" or "PASS (with warnings)" (the pipeline's own wording); FAIL / blank / anything else holds
  const status = cell(last, "Status").toUpperCase();
  if (!/^PASS\b/.test(status)) return { ok: false, reason: `Forecast Run Log's latest row for ${date} is ${status || "blank"}${cell(last, "Failure reason") ? ` (${cell(last, "Failure reason")})` : ""}` };
  const base = fileName.replace(/\.xlsx$/i, "");
  if (!cell(last, "Forecast file").includes(base)) return { ok: false, reason: `Forecast Run Log's PASS row for ${date} names "${cell(last, "Forecast file") || "no file"}", not ${base}` };
  const stated = /(\d[\d,]*) data rows/i.exec(cell(last, "Validation"));
  if (stated && dataRows !== undefined && Number(stated[1].replace(/,/g, "")) !== dataRows) {
    return { ok: false, reason: `Forecast Run Log says ${stated[1]} data rows, the file has ${dataRows}` };
  }
  return { ok: true, reason: `Forecast Run Log ${cell(last, "Status")} for ${date}` };
}

/** Refuse a file much smaller than the last imported day (a truncated or partial build). */
export function sizeVerdict(cur: Counts, prev: Counts | null, minRatio = MIN_RATIO): Verdict {
  if (!cur.zones || !cur.skus) return { ok: false, reason: "no FBA analysis rows in the file" };
  if (!cur.fc) return { ok: false, reason: "no FBA_stock rows in the file" };
  if (prev && cur.zones < prev.zones * minRatio) return { ok: false, reason: `only ${cur.zones} zone rows vs ${prev.zones} last time` };
  if (prev && cur.skus < prev.skus * minRatio) return { ok: false, reason: `only ${cur.skus} SKUs vs ${prev.skus} last time` };
  return { ok: true, reason: `${cur.zones} zone rows, ${cur.skus} SKUs, ${cur.fc} FC rows` };
}

export type FbaDeps = {
  now: () => number;
  /** Files in the Output folder (already narrowed by the Drive query). */
  listOutput: () => Promise<FbaFile[]>;
  download: (f: FbaFile) => Promise<Buffer>;
  /** Rows of the run log's "Forecast Run Log" tab. */
  runLogRows: () => Promise<Record<string, unknown>[]>;
  /** Counts of the newest imported day before `date`, or null. */
  previousCounts: (date: string) => Promise<Counts | null>;
  replace: (date: string, zones: Omit<ForecastZoneRow, "report_date">[], fc: FcStockRow[]) => Promise<{ zones: number; fc: number; fc_dates: string[] }>;
  /** file id → modifiedTime already imported. */
  imported: Record<string, string>;
  markImported: (f: FbaFile) => void;
};

export type FbaResult = {
  file: string; modifiedTime: string;
  status: "imported" | "would-import" | "unchanged" | "waiting" | "held" | "failed" | "none";
  reason: string; forecastDate?: string; fcDates?: string[]; counts?: Counts;
};

export async function importVerifiedForecast(deps: FbaDeps, opts: { dry?: boolean } = {}): Promise<FbaResult> {
  const files = (await deps.listOutput()).filter((f) => forecastDate(f.name)).sort((a, b) => forecastDate(b.name)!.localeCompare(forecastDate(a.name)!) || b.modifiedTime.localeCompare(a.modifiedTime));
  const f = files[0];
  if (!f) return { file: "—", modifiedTime: "", status: "none", reason: "no \"FBA Forecasting YYYY-MM-DD.xlsx\" in the Output folder" };
  const date = forecastDate(f.name)!;
  const base = { file: f.name, modifiedTime: f.modifiedTime, forecastDate: date };
  if (deps.imported[f.id] && deps.imported[f.id] >= f.modifiedTime) return { ...base, status: "unchanged", reason: "already imported (same Drive version)" };
  if (!isSettled(f, deps.now())) return { ...base, status: "waiting", reason: `changed less than ${SETTLE_MS / 60_000} min ago — checked again next run` };
  try {
    const logRows = await deps.runLogRows();
    const log = runLogVerdict(logRows, date, f.name);
    if (!log.ok) return { ...base, status: "held", reason: log.reason };
    const wb = XLSX.read(await deps.download(f), { type: "buffer" });
    if (detectKind(wb) !== "forecast") return { ...base, status: "held", reason: "not an FBA forecast workbook (FBA analysis / FBA_stock tabs missing)" };
    const { zones, fcStock } = parseForecast(wb, date);
    const counts: Counts = { zones: zones.length, skus: new Set(zones.map((z) => z.sku)).size, fc: fcStock.length };
    const rowsCheck = runLogVerdict(logRows, date, f.name, zones.length);
    if (!rowsCheck.ok) return { ...base, counts, status: "held", reason: rowsCheck.reason };
    const size = sizeVerdict(counts, await deps.previousCounts(date));
    if (!size.ok) return { ...base, counts, status: "held", reason: size.reason };
    const fcDates = [...new Set(fcStock.map((r) => r.report_date))].sort();
    // one FC balance date per file: the parser sums an FC/MSKU's rows, so mixed dates would blend days
    if (fcDates.length !== 1) return { ...base, counts, fcDates, status: "held", reason: `FBA_stock has ${fcDates.length} balance dates (${fcDates.join(", ")}) — expected one` };
    if (fcDates[0] > date) return { ...base, counts, fcDates, status: "held", reason: `FC balance date ${fcDates[0]} is after the forecast date ${date}` };
    if (opts.dry) return { ...base, counts, fcDates, status: "would-import", reason: `${log.reason}; ${size.reason}` };
    const res = await deps.replace(date, zones.map(({ report_date: _d, ...z }) => z), fcStock);
    deps.markImported(f);
    return { ...base, counts, fcDates: res.fc_dates, status: "imported", reason: `${res.zones} zone rows for ${date}, ${res.fc} FC rows for ${res.fc_dates.join(", ")}` };
  } catch (e) {
    return { ...base, status: "failed", reason: e instanceof Error ? e.message : String(e) };
  }
}
