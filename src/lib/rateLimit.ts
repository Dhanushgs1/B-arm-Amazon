// Fixed-window, in-memory rate limiter. Best-effort only: each serverless instance keeps its own
// counters, so the effective ceiling is `limit` per warm instance, not globally. It exists to cap
// runaway or scripted use of cost-bearing routes (Gemini) and login guessing, behind auth.

// Kept on globalThis so every copy of this module (dev hot reloads, bundler chunks) shares one store.
const store = globalThis as typeof globalThis & { __m360RateLimits?: Map<string, { windowStart: number; count: number }> };
const buckets = (store.__m360RateLimits ??= new Map());

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): { ok: boolean; retryAfterSec: number } {
  const b = buckets.get(key);
  if (!b || now - b.windowStart >= windowMs) {
    buckets.set(key, { windowStart: now, count: 1 });
    return { ok: true, retryAfterSec: 0 };
  }
  b.count++;
  if (b.count > limit) return { ok: false, retryAfterSec: Math.ceil((b.windowStart + windowMs - now) / 1000) };
  return { ok: true, retryAfterSec: 0 };
}

export function resetRateLimits() {
  buckets.clear();
}
