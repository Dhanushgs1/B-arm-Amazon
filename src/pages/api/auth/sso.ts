// One-click sign-in from b-arm.org (the ERP): GET /api/auth/sso?t=<ticket>.
// The ERP hands allow-listed people (public.sso_allowed) a one-time ticket (60 s, single use).
// It is redeemed here once with the ERP's "sso" edge function — the same Supabase project as this
// app — and a valid ticket starts the normal dashboard session (the same HttpOnly cookie as the
// password login) on the Barm account slot. Fails closed: no ticket / bad ticket = no session.

import type { NextApiRequest, NextApiResponse } from "next";
import { clientIp, createSessionToken, sessionCookie } from "@/lib/apiAuth";
import { rateLimit } from "@/lib/rateLimit";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/supabaseLazy";

const page = (body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in</title></head>` +
  `<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#070B17;color:#cbd5e1;font-family:system-ui,sans-serif">${body}</body></html>`;

function fail(res: NextApiResponse, status: number, message: string) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(status).send(page(
    `<div style="max-width:420px;padding:24px;text-align:center"><p style="font-size:15px;font-weight:700">${message}</p>` +
    `<p><a style="color:#818cf8" href="/">Go to the sign-in page</a></p></div>`));
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const limit = rateLimit(`sso:${clientIp(req.headers)}`, 20, 15 * 60_000);
  if (!limit.ok) return fail(res, 429, "Too many attempts. Try again later.");

  const ticket = typeof req.query.t === "string" ? req.query.t : "";
  if (!ticket || !SUPABASE_URL || !SUPABASE_ANON_KEY) return fail(res, 400, "This sign-in link is not valid.");

  let email = "";
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/sso`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      body: JSON.stringify({ action: "redeem", target: "mna", ticket }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && typeof j.email === "string") email = j.email;
  } catch {
    return fail(res, 502, "Could not reach B-ARM to check the sign-in. Please try again.");
  }
  if (!email) return fail(res, 401, "This sign-in link has expired. Go back to B-ARM and open Marketing &amp; Analysis again.");

  const token = createSessionToken();
  if (!token) return fail(res, 503, "Dashboard login is not configured on the server.");

  res.setHeader("Set-Cookie", sessionCookie(token));
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const who = JSON.stringify(email).replace(/</g, "\\u003c");
  return res.status(200).send(page(
    `<p style="font-size:12px;font-weight:800;letter-spacing:.2em;text-transform:uppercase">Signing in…</p>` +
    `<script>try{localStorage.setItem("ppcUser","Barm");localStorage.setItem("ppcKeySlot","B");localStorage.setItem("barmSsoEmail",${who});}catch(e){}location.replace("/dashboard/executive");</script>`));
}
