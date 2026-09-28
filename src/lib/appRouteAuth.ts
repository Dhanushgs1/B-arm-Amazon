// App Router counterpart of apiAuth.ts's guard(): returns a response to send when the request is
// not allowed, or null to proceed. `rate` adds a per-IP best-effort limit (see rateLimit.ts).

import { NextResponse } from "next/server";
import { clientIp, headersOf, type AuthResult, type HeaderBag } from "@/lib/apiAuth";
import { rateLimit } from "@/lib/rateLimit";

export function rejectUnlessAllowed(
  request: Request,
  check: (h: HeaderBag) => AuthResult,
  rate?: { bucket: string; limit: number; windowMs: number }
): NextResponse | null {
  const h = headersOf(request);
  const auth = check(h);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (rate) {
    const r = rateLimit(`${rate.bucket}:${clientIp(h)}`, rate.limit, rate.windowMs);
    if (!r.ok) {
      return NextResponse.json({ error: "Too many requests. Try again shortly." }, { status: 429, headers: { "Retry-After": String(r.retryAfterSec) } });
    }
  }
  return null;
}
