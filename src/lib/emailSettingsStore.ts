// Per-account (keySlot) settings storage, backed by Supabase instead of a local
// .email-settings.json file. The old file-based approach broke two ways once
// deployed: (1) Vercel's serverless filesystem is read-only, so every save threw
// EROFS, and (2) a single shared file meant one account's saved settings could
// silently leak into another account's automated emails (the Barm/Lkn mixup).
// Keying by keySlot in a real table fixes both — writes actually persist, and
// each account only ever reads its own row.
//
// Uses a plain fetch against Supabase's PostgREST API rather than the
// @supabase/supabase-js client, matching the rest of this codebase's style of
// calling external HTTP APIs directly instead of pulling in an SDK.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

function headers() {
  return {
    apikey: SUPABASE_ANON_KEY || "",
    Authorization: `Bearer ${SUPABASE_ANON_KEY || ""}`,
    "Content-Type": "application/json",
  };
}

export function isConfigured() {
  return !!(SUPABASE_URL && SUPABASE_ANON_KEY);
}

// The cron path (scheduled-reports.ts) treats an empty {} return here as "this
// account was never configured" and silently skips that day's email — correct
// for a genuinely-empty row, but WRONG for a transient Supabase hiccup (seen in
// practice: brief "statement timeout" blips against this project's DB), which
// used to collapse into the exact same {} on the FIRST failed attempt and
// vanish a whole day's digest with nothing visible anywhere. Retrying gives a
// transient blip 2 more chances to clear before this falls back to {} — same
// return contract as before (every existing caller still gets a plain object,
// never a throw), just less likely to mistake "Supabase hiccupped for a
// second" for "never configured".
export async function readEmailSettings(keySlot: string): Promise<Record<string, any>> {
  if (!isConfigured()) return {};
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/email_settings?key_slot=eq.${encodeURIComponent(keySlot)}&select=settings`,
        { headers: headers() }
      );
      if (!r.ok) throw new Error(`Supabase read failed: ${r.status} ${await r.text().catch(() => "")}`);
      const rows = await r.json();
      return rows?.[0]?.settings || {};
    } catch (err) {
      if (attempt < 2) {
        await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
        continue;
      }
      console.error(`[emailSettingsStore] readEmailSettings(${keySlot}) failed after 3 attempts:`, err);
    }
  }
  return {};
}

export async function writeEmailSettings(keySlot: string, patch: Record<string, any>): Promise<Record<string, any>> {
  if (!isConfigured()) throw new Error("Supabase env vars (SUPABASE_URL, SUPABASE_ANON_KEY) are not configured");
  const current = await readEmailSettings(keySlot);
  const merged = { ...current, ...patch };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/email_settings`, {
    method: "POST",
    headers: { ...headers(), Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ key_slot: keySlot, settings: merged, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error(`Supabase upsert failed: ${r.status} ${await r.text()}`);
  return merged;
}

// Every keySlot that has a saved settings row — used by the cron jobs to loop
// over every configured account instead of assuming just one.
export async function listConfiguredSlots(): Promise<string[]> {
  if (!isConfigured()) return [];
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/email_settings?select=key_slot`, { headers: headers() });
    if (!r.ok) return [];
    const rows = await r.json();
    return rows.map((row: any) => row.key_slot).filter(Boolean);
  } catch {
    return [];
  }
}
