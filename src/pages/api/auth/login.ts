// Dashboard sign-in: POST { username, password } -> sets the HttpOnly session cookie that the browser-facing
// API routes require (see src/lib/apiAuth.ts). One shared DASHBOARD_PASSWORD, no per-user accounts.
// Fails closed: with DASHBOARD_PASSWORD or INTERNAL_API_SECRET unset, nobody can sign in.

import type { NextApiRequest, NextApiResponse } from "next";
import { checkDashboardPassword, clientIp, createSessionToken, isDashboardLoginConfigured, sessionCookie } from "@/lib/apiAuth";
import { rateLimit } from "@/lib/rateLimit";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!isDashboardLoginConfigured()) {
    return res.status(503).json({ error: "Dashboard login is not configured on the server." });
  }

  // Slows password guessing: 10 attempts per 15 minutes per IP (per warm instance).
  const limit = rateLimit(`login:${clientIp(req.headers)}`, 10, 15 * 60_000);
  if (!limit.ok) {
    res.setHeader("Retry-After", String(limit.retryAfterSec));
    return res.status(429).json({ error: "Too many attempts. Try again later." });
  }

  // The username only selects the account slot in the UI (Barm -> B, Lkn -> A); it is not a
  // separate credential. Unknown usernames are rejected like a wrong password.
  const username = req.body?.username;
  if (!(username === "Barm" || username === "Lkn") || !checkDashboardPassword(req.body?.password)) {
    return res.status(401).json({ error: "Incorrect password" });
  }

  const token = createSessionToken();
  if (!token) return res.status(503).json({ error: "Dashboard login is not configured on the server." });
  res.setHeader("Set-Cookie", sessionCookie(token));
  return res.status(200).json({ success: true });
}
