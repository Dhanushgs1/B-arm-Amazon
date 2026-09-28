// Shared-secret gate for this project's Edge Functions. They are deployed with verify_jwt = false
// (supabase/config.toml) because their callers — the Vercel API routes and the pg_cron job — use
// no Supabase user JWT. Without this check any caller on the internet could invoke them: the
// send-ad-spend-email function would mail the Ad Spend workbook to any address it was given.
//
// Callers send "x-m360-internal: <INTERNAL_API_SECRET>" (the Vercel app's env var; set the same
// value as a Supabase function secret). Fails closed when the secret isn't configured.

export const INTERNAL_AUTH_HEADER = "x-m360-internal";

export type EdgeAuthResult = { ok: true } | { ok: false; status: number; error: string };

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

// Constant-time over fixed-length digests, so neither content nor length leaks.
export async function checkInternalAuth(provided: string | null, secret: string | undefined): Promise<EdgeAuthResult> {
  if (!secret) return { ok: false, status: 503, error: "INTERNAL_API_SECRET is not configured" };
  if (!provided) return { ok: false, status: 401, error: "Unauthorized" };
  const [a, b] = await Promise.all([sha256(provided), sha256(secret)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0 ? { ok: true } : { ok: false, status: 401, error: "Unauthorized" };
}

export async function rejectUnlessInternal(req: Request): Promise<Response | null> {
  const r = await checkInternalAuth(req.headers.get(INTERNAL_AUTH_HEADER), Deno.env.get("INTERNAL_API_SECRET"));
  if (r.ok) return null;
  return new Response(JSON.stringify({ error: r.error }), { status: r.status, headers: { "Content-Type": "application/json" } });
}
