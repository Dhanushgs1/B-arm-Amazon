// Server-side request authentication for the API routes. Three independent mechanisms, each of
// which FAILS CLOSED — a missing env var means the route refuses to run, never that it opens up:
//
//  - Cron:      "Authorization: Bearer $CRON_SECRET". Vercel Cron sends this automatically once
//               CRON_SECRET is set on the project; the external 30-min scheduler for
//               /api/cron/campaign-monitor must be given the same header.
//  - Internal:  "x-m360-internal: $INTERNAL_API_SECRET", added by internalFetch() on every
//               server-to-server call (and sent to the Supabase Edge Functions). Proves a request
//               came from this app's own server code, not from a browser or the public internet.
//  - Session:   the dashboard login (DASHBOARD_PASSWORD) sets an HttpOnly signed cookie; browser-
//               facing routes require it. There is one shared password, not per-user accounts.
//
// Nothing in this file may be imported by client code — it reads server-only secrets.

import { createHash, createHmac, timingSafeEqual } from "crypto";

export type HeaderBag = Record<string, string | string[] | undefined>;
export type AuthResult = { ok: true } | { ok: false; status: number; error: string };

export const INTERNAL_AUTH_HEADER = "x-m360-internal";
export const SESSION_COOKIE = "m360_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

function header(h: HeaderBag, name: string): string | undefined {
  const v = h[name];
  return typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined;
}

// Hashing both sides first gives equal-length buffers, so timingSafeEqual never throws and the
// comparison leaks neither content nor length.
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

// ── Cron ──────────────────────────────────────────────────────────────────────────────────────
export function checkCron(h: HeaderBag): AuthResult {
  const secret = process.env.CRON_SECRET;
  if (!secret) return { ok: false, status: 503, error: "CRON_SECRET is not configured — refusing to run" };
  const auth = header(h, "authorization");
  if (!auth || !safeEqual(auth, `Bearer ${secret}`)) return { ok: false, status: 401, error: "Unauthorized" };
  return { ok: true };
}

// ── Internal (server-to-server) ─────────────────────────────────────────────────────────────
export function internalSecret(): string | null {
  return process.env.INTERNAL_API_SECRET || null;
}

export function isInternalRequest(h: HeaderBag): boolean {
  const secret = internalSecret();
  const got = header(h, INTERNAL_AUTH_HEADER);
  return !!secret && !!got && safeEqual(got, secret);
}

export function checkInternal(h: HeaderBag): AuthResult {
  if (!internalSecret()) return { ok: false, status: 503, error: "INTERNAL_API_SECRET is not configured — refusing to run" };
  if (!isInternalRequest(h)) return { ok: false, status: 401, error: "Unauthorized" };
  return { ok: true };
}

// Headers for this project's Supabase Edge Functions, which check the same INTERNAL_API_SECRET
// (supabase/functions/_shared/internalAuth.ts). Null when the secret isn't configured.
export function edgeFunctionHeaders(): Record<string, string> | null {
  const secret = internalSecret();
  return secret ? { "Content-Type": "application/json", [INTERNAL_AUTH_HEADER]: secret } : null;
}

// ── Dashboard session ───────────────────────────────────────────────────────────────────────
// The signing key mixes in the password, so changing DASHBOARD_PASSWORD logs everyone out.
function sessionKey(): Buffer | null {
  const password = process.env.DASHBOARD_PASSWORD;
  const secret = internalSecret();
  if (!password || !secret) return null;
  return createHmac("sha256", secret).update(`dashboard-session\0${password}`).digest();
}

function sign(key: Buffer, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function isDashboardLoginConfigured(): boolean {
  return sessionKey() !== null;
}

export function checkDashboardPassword(candidate: unknown): boolean {
  const password = process.env.DASHBOARD_PASSWORD;
  return !!password && typeof candidate === "string" && safeEqual(candidate, password);
}

export function createSessionToken(nowMs = Date.now()): string | null {
  const key = sessionKey();
  if (!key) return null;
  const payload = `v1.${Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS}`;
  return `${payload}.${sign(key, payload)}`;
}

export function verifySessionToken(token: string | undefined, nowMs = Date.now()): boolean {
  const key = sessionKey();
  if (!key || !token) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !/^\d+$/.test(parts[1])) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  if (!safeEqual(parts[2], sign(key, payload))) return false;
  return Number(parts[1]) * 1000 > nowMs;
}

export function readCookie(h: HeaderBag, name: string): string | undefined {
  const raw = header(h, "cookie");
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function hasValidSession(h: HeaderBag): boolean {
  return verifySessionToken(readCookie(h, SESSION_COOKIE));
}

export function checkSession(h: HeaderBag): AuthResult {
  if (!isDashboardLoginConfigured()) {
    return { ok: false, status: 503, error: "Dashboard login is not configured (DASHBOARD_PASSWORD / INTERNAL_API_SECRET)" };
  }
  if (!hasValidSession(h)) return { ok: false, status: 401, error: "Not signed in" };
  return { ok: true };
}

// Browser-facing routes that the server itself also calls (cron -> weekly-report, etc.).
export function checkSessionOrInternal(h: HeaderBag): AuthResult {
  return isInternalRequest(h) ? { ok: true } : checkSession(h);
}

export function sessionCookie(token: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure}`;
}

export function clearedSessionCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

// ── Route helpers ───────────────────────────────────────────────────────────────────────────
type PagesRes = { status: (code: number) => { json: (body: unknown) => unknown } };

// Pages API routes: `if (!guard(req, res, checkInternal)) return;`
export function guard(req: { headers: HeaderBag }, res: PagesRes, check: (h: HeaderBag) => AuthResult): boolean {
  const r = check(req.headers);
  if (!r.ok) res.status(r.status).json({ error: r.error });
  return r.ok;
}

// App Router route handlers: Headers -> HeaderBag (header names are already lower-case).
export function headersOf(request: Request): HeaderBag {
  return Object.fromEntries(request.headers.entries());
}

export function clientIp(h: HeaderBag): string {
  return (header(h, "x-forwarded-for") || "").split(",")[0].trim() || header(h, "x-real-ip") || "unknown";
}
