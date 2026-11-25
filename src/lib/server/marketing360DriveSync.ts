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

import { createSign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";
import { DRIVE_SOURCES, driveQuery, downloadPath, importName, needsImport, pickFiles, type DriveFile } from "../marketing360DriveRules.ts";
import { importWorkbook } from "../marketing360Store.ts";

export const DRIVE_SYNC_EVERY_MS = 60 * 60_000;
const FIRST_RUN_DELAY_MS = 2 * 60_000;
const STATE_FILE = join(process.cwd(), ".data", "mkt360-drive-sync.json");

type ServiceAccount = { client_email: string; private_key: string; token_uri?: string };
export type SyncFileResult = { source: string; file: string; modifiedTime: string; status: "imported" | "unchanged" | "failed"; summary?: string; error?: string };
export type SyncResult = { at: string; files: SyncFileResult[]; error?: string };

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

/** One pass over every source. `dry` parses but writes nothing (and does not record the files). */
export async function syncDriveOnce(opts: { dry?: boolean; force?: boolean } = {}): Promise<SyncResult> {
  if (running) return running;
  running = (async () => {
    const result: SyncResult = { at: new Date().toISOString(), files: [] };
    try {
      const sa = serviceAccount();
      if (!sa) throw new Error("No Google service account configured (GOOGLE_SERVICE_ACCOUNT_JSON / GOOGLE_SERVICE_ACCOUNT_FILE)");
      const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
      const key = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (!url || !key) throw new Error("Supabase URL / anon key not configured");
      const db = createClient(url, key, { auth: { persistSession: false } });
      const token = await accessToken(sa);
      const state = readState();
      for (const source of DRIVE_SOURCES) {
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
  console.log("[mkt360-drive] Drive auto-import on — first run in 2 min, then hourly");
  setTimeout(() => { void syncDriveOnce(); setInterval(() => void syncDriveOnce(), DRIVE_SYNC_EVERY_MS).unref?.(); }, FIRST_RUN_DELAY_MS).unref?.();
}
