// Sends a visitor without a valid dashboard session back to the sign-in page (/) instead of
// rendering a dashboard whose every API call would 401. This is a UX layer only — each API route
// enforces its own auth (src/lib/apiAuth.ts), so nothing depends on this matcher being complete.
// Proxy runs on the Node.js runtime by default in this Next.js version, so node:crypto is fine.

import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/apiAuth";

export function proxy(request: NextRequest) {
  if (verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  return NextResponse.redirect(new URL("/", request.url));
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
