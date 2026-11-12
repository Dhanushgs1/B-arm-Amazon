// GET /api/bi/dataset — the executive dashboard's data (see src/lib/bi/dataset.ts). The cache, the
// disk copy and the rebuild rules live in src/lib/server/biCache.ts (shared with the background
// pre-load). ?refresh=1 asks for a fresh build (rate limited).

import type { NextApiRequest, NextApiResponse } from "next";
import { checkSession, clientIp, guard } from "@/lib/apiAuth";
import { rateLimit } from "@/lib/rateLimit";
import { biCached, rebuildBi } from "@/lib/server/biCache";

export const config = { api: { responseLimit: "16mb" } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!guard(req, res, checkSession)) return;
  res.setHeader("Cache-Control", "private, no-store");
  try {
    const wantFresh = req.query.refresh === "1";
    if (wantFresh) {
      const r = rateLimit(`bi-refresh:${clientIp(req.headers)}`, 3, 10 * 60_000);
      if (!r.ok) return res.status(429).json({ error: "Refreshed recently — try again in a few minutes." });
    }
    const { data, ageMs, stale } = biCached();
    if (data && !wantFresh) {
      if (stale) rebuildBi().catch((e) => console.error("[bi] background rebuild failed:", e));
      return res.status(200).json({ ...data, cacheAgeSeconds: Math.round(ageMs / 1000), refreshing: stale });
    }
    const fresh = await rebuildBi();
    return res.status(200).json({ ...fresh, cacheAgeSeconds: 0, refreshing: false });
  } catch (err) {
    console.error("[bi] dataset build failed:", err);
    return res.status(500).json({ error: "The business overview could not be built. Try again shortly." });
  }
}
