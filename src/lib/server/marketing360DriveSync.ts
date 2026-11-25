// Product Marketing 360 — daily auto-import of the marketing team's Drive files (user, 2026-11-25:
// "weekly and daily data should keep updating as it comes"). Every hour it lists the Drive files in
// DRIVE_SOURCES (marketing360DriveRules.ts), and imports each one Drive says changed since the last
// import, with the same parsers and writes as scripts/marketing360-load.ts (marketing360Store.ts).
//
// Drive access: a Google service account (no Google library — a signed JWT is exchanged for a token).
// Set ONE of these on the host, then share the Drive folders/files with the account's e-mail (Viewer):
//   GOOGLE_SERVICE_ACCOUNT_JSON  the key file's JSON, on one line
//   GOOGLE_SERVICE_ACCOUNT_FILE  path to the key file
// Without either, nothing runs. MKT360_DRIVE_SYNC=off turns it off; it never runs under `next dev`
// unless MKT360_DRIVE_SYNC=on. It never sends e-mail, so it runs even where DISABLE_SCHEDULER is set
// (mna.b-arm.org) — like the Overall page pre-load.
//
// What was imported (file id → Drive modifiedTime) is kept in .data/mkt360-drive-sync.json, so a
// restart does not re-import unchanged files; deleting that file only means one extra import.
//
// Which sources run: MKT360_DRIVE_SOURCES (default "forecast" only — user, 2026-11-25). The FBA
// forecast is read ONLY from the pipeline's Output folder and imported ONLY when verified against the
// pipeline's run log (marketing360FbaImport.ts); both are named by id:
//   MKT360_FBA_OUTPUT_FOLDER_ID  the Output folder holding "FBA Forecasting YYYY-MM-DD.xlsx"
//   MKT360_FBA_RUN_LOG_ID        the "FBA Forecasting Run Log" Google Sheet
// MKT360_DRIVE_SYNC=dry runs the hourly loop in dry-run mode (checks and reports, writes nothing).

import { createSign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as XLSX from "xlsx";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { driveQuery, downloadPath, enabledSources, folderQuery, importName, needsImport, pickFiles, SHEET_MIME, type DriveFile } from "../marketing360DriveRules.ts";
import { importWorkbook } from "../marketing360Store.ts";
import { importVerifiedForecast, RUN_LOG_TAB, type Counts, type FbaResult } from "../marketing360FbaImport.ts";

export const DRIVE_SYNC_EVERY_MS = 60 * 60_000;
const FIRST_RUN_DELAY_MS = 2 * 60_000;
const STATE_FILE = join(process.cwd(), ".data", "mkt360-drive-sync.json");

type ServiceAccount = { client_email: string; private_key: string; token_uri?: string };
export type SyncFileResult = { source: string; file: string; modifiedTime: string; status: "imported" | "unchanged" | "failed" | FbaResult["status"]; summary?: string; error?: string; fba?: FbaResult };
export type SyncResult = { at: string; dry: boolean; files: SyncFileResult[]; error?: string };

let lastResult: SyncResult | null = null;
let running: Promise<SyncResult> | null = null;
export const lastDriveSync = () => lastResult;

export function serviceAccount(): ServiceAccount | null {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim()
    || (process.env.GOOGLE_SERVICE_ACCOUNT_FILE ? readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_FILE.trim(), "utf8") : "");
  if (!raw) return null;
  const sa = JSON.parse(raw) as ServiceAccount;
  if (!sa.client_email || !sa.private_key) throw new Error("Service account key has no client_email / private_key");
  return { ...sa, private_key: sa.private_key.replace(/\\n/g, "\n") };
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

/** Signed JWT for Google's token endpoint (RS256), read-only Drive scope. */
export function signedAssertion(sa: ServiceAccount, nowSec = Math.floor(Date.now() / 1000)): string {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: sa.token_uri ?? "https://oauth2.googleapis.com/token", iat: nowSec, exp: nowSec + 3600,
  }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${claims}`);
  return `${head}.${claims}.${b64url(signer.sign(sa.private_key))}`;
}

async function accessToken(sa: ServiceAccount): Promise<string> {
  const r = await fetch(sa.token_uri ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signedAssertion(sa) }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Google sign-in failed (${r.status}): ${j.error_description ?? j.error ?? "no token"}`);
  return j.access_token;
}

async function listFiles(token: string, q: string): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  let pageToken = "";
  do {
    const p = new URLSearchParams({ q, fields: "nextPageToken,files(id,name,mimeType,modifiedTime)", pageSize: "100", orderBy: "modifiedTime desc", supportsAllDrives: "true", includeItemsFromAllDrives: "true", ...(pageToken ? { pageToken } : {}) });
    const r = await fetch(`https://www.googleapis.com/drive/v3/files?${p}`, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Drive list failed (${r.status}): ${j.error?.message ?? "unknown"}`);
    out.push(...(j.files ?? []));
    pageToken = j.nextPageToken ?? "";
  } while (pageToken && out.length < 500);
  return out;
}

async function download(token: string, f: DriveFile): Promise<Buffer> {
  const r = await fetch(`https://www.googleapis.com${downloadPath(f)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Drive download of "${f.name}" failed (${r.status}): ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return Buffer.from(await r.arrayBuffer());
}

function readState(): Record<string, string> {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
function writeState(s: Record<string, string>) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 1));
}

/** The verified FBA forecast import, wired to Drive (Output folder + run log, by id) and Supabase. */
async function syncForecast(token: string, db: SupabaseClient, state: Record<string, string>, opts: { dry?: boolean; force?: boolean }): Promise<FbaResult> {
  const folder = process.env.MKT360_FBA_OUTPUT_FOLDER_ID?.trim();
  const runLog = process.env.MKT360_FBA_RUN_LOG_ID?.trim();
  if (!folder || !runLog) return { file: "—", modifiedTime: "", status: "failed", reason: "MKT360_FBA_OUTPUT_FOLDER_ID / MKT360_FBA_RUN_LOG_ID not set" };
  let logRows: Record<string, unknown>[] | null = null;
  return importVerifiedForecast({
    now: () => Date.now(),
    listOutput: () => listFiles(token, folderQuery(folder)),
    download: (f) => download(token, { ...f, mimeType: "" }),
    runLogRows: async () => {
      if (logRows) return logRows;
      const wb = XLSX.read(await download(token, { id: runLog, name: "FBA Forecasting Run Log", mimeType: SHEET_MIME, modifiedTime: "" }), { type: "buffer", cellDates: true });
      const ws = wb.Sheets[RUN_LOG_TAB];
      if (!ws) throw new Error(`run log has no "${RUN_LOG_TAB}" tab`);
      return (logRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" }));
    },
    previousCounts: async (date) => {
      const prev = await db.from("mkt_fba_forecast_zone").select("report_date").lt("report_date", date).order("report_date", { ascending: false }).limit(1);
      if (prev.error) throw new Error(`previous forecast date: ${prev.error.message}`);
      const d = (prev.data?.[0] as { report_date?: string } | undefined)?.report_date;
      if (!d) return null;
      const skus = new Set<string>();
      let zones = 0;
      for (let from = 0; ; from += 1000) {
        const page = await db.from("mkt_fba_forecast_zone").select("sku").eq("report_date", d).order("sku").order("zone").range(from, from + 999);
        if (page.error) throw new Error(`previous forecast rows: ${page.error.message}`);
        for (const r of page.data ?? []) skus.add((r as { sku: string }).sku);
        zones += page.data?.length ?? 0;
        if ((page.data?.length ?? 0) < 1000) break;
      }
      return { zones, skus: skus.size, fc: 0 } satisfies Counts;
    },
    replace: async (date, zones, fc) => {
      const { data, error } = await db.rpc("mkt_replace_fba_forecast", { p_report_date: date, p_zones: zones, p_fc: fc });
      if (error) throw new Error(`mkt_replace_fba_forecast: ${error.message}`);
      return data as { zones: number; fc: number; fc_dates: string[] };
    },
    imported: opts.force ? {} : state,
    markImported: (f) => { state[f.id] = f.modifiedTime; writeState(state); },
  }, { dry: opts.dry });
}

/** One pass over every source. `dry` parses but writes nothing (and does not record the files). */
export async function syncDriveOnce(opts: { dry?: boolean; force?: boolean } = {}): Promise<SyncResult> {
  if (running) return running;
  running = (async () => {
    const result: SyncResult = { at: new Date().toISOString(), dry: !!opts.dry, files: [] };
    try {
      const sa = serviceAccount();
      if (!sa) throw new Error("No Google service account configured (GOOGLE_SERVICE_ACCOUNT_JSON / GOOGLE_SERVICE_ACCOUNT_FILE)");
      const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
      const key = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (!url || !key) throw new Error("Supabase URL / anon key not configured");
      const db = createClient(url, key, { auth: { persistSession: false } });
      const token = await accessToken(sa);
      const state = readState();
      for (const source of enabledSources(process.env.MKT360_DRIVE_SOURCES)) {
        if (source.key === "forecast") {
          const fba = await syncForecast(token, db, state, opts);
          result.files.push({ source: source.label, file: fba.file, modifiedTime: fba.modifiedTime, status: fba.status, summary: fba.reason, fba });
          continue;
        }
        let files: DriveFile[];
        try {
          files = pickFiles(source, await listFiles(token, driveQuery(source)));
        } catch (e) {
          result.files.push({ source: source.label, file: "—", modifiedTime: "", status: "failed", error: e instanceof Error ? e.message : String(e) });
          continue;
        }
        if (!files.length) result.files.push({ source: source.label, file: "— (no file shared with the service account)", modifiedTime: "", status: "failed", error: "not found" });
        for (const f of files) {
          if (!opts.force && !needsImport(f, state)) { result.files.push({ source: source.label, file: f.name, modifiedTime: f.modifiedTime, status: "unchanged" }); continue; }
          try {
            const wb = XLSX.read(await download(token, f), { type: "buffer" });
            const res = await importWorkbook(db, wb, importName(f), { dry: opts.dry });
            if (!opts.dry) { state[f.id] = f.modifiedTime; writeState(state); }
            result.files.push({ source: source.label, file: f.name, modifiedTime: f.modifiedTime, status: "imported", summary: res.summary });
          } catch (e) {
            result.files.push({ source: source.label, file: f.name, modifiedTime: f.modifiedTime, status: "failed", error: e instanceof Error ? e.message : String(e) });
          }
        }
      }
    } catch (e) {
      result.error = e instanceof Error ? e.message : String(e);
    }
    for (const f of result.files) if (f.status !== "unchanged") console.log(`[mkt360-drive] ${f.status}: ${f.source} · ${f.file}${f.summary ? ` — ${f.summary}` : ""}${f.error ? ` — ${f.error}` : ""}`);
    if (result.error) console.error(`[mkt360-drive] ${result.error}`);
    lastResult = result;
    return result;
  })();
  try { return await running; } finally { running = null; }
}

let started = false;
/** Hourly loop; started from src/instrumentation.ts. */
export function startDriveSync() {
  if (started) return;
  const mode = (process.env.MKT360_DRIVE_SYNC ?? "").trim().toLowerCase();
  if (mode === "off") return;
  if (process.env.NODE_ENV !== "production" && mode !== "on") return;
  let configured = false;
  try { configured = serviceAccount() !== null; } catch (e) { console.error("[mkt360-drive] bad service account key:", e instanceof Error ? e.message : e); }
  if (!configured) return;
  started = true;
  const dry = mode === "dry";
  const sources = enabledSources(process.env.MKT360_DRIVE_SOURCES).map((s) => s.key).join(", ");
  console.log(`[mkt360-drive] Drive auto-import on${dry ? " (DRY RUN — writes nothing)" : ""} for ${sources} — first run in 2 min, then hourly`);
  setTimeout(() => { void syncDriveOnce({ dry }); setInterval(() => void syncDriveOnce({ dry }), DRIVE_SYNC_EVERY_MS).unref?.(); }, FIRST_RUN_DELAY_MS).unref?.();
}
