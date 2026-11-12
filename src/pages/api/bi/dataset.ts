// GET /api/bi/dataset — the executive dashboard's data (see src/lib/bi/dataset.ts).
//
// Building it reads seven months of orders, ads and stock, so it is built once and shared by every
// signed-in viewer for 20 minutes. After that the old copy is still served instantly while a fresh
// one is built in the background. ?refresh=1 asks for a fresh build (rate limited).

import type { NextApiRequest, NextApiResponse } from "next";
import { checkSession, clientIp, guard } from "@/lib/apiAuth";
import { rateLimit } from "@/lib/rateLimit";
import { buildBiDataset } from "@/lib/bi/dataset";
import type { BiDataset } from "@/lib/bi/types";

const TTL_MS = 20 * 60_000;
const store = globalThis as typeof globalThis & { __m360Bi?: { at: number; data: BiDataset | null; building: Promise<BiDataset> | null } };
const cache = (store.__m360Bi ??= { at: 0, data: null, building: null });

function rebuild(): Promise<BiDataset> {
  if (!cache.building) {
    cache.building = buildBiDataset()
      .then((d) => {
        // A rebuild where a source failed must not replace a complete dataset: keep serving the
        // complete one and try again in two minutes instead of twenty.
        if (d.errors.length && cache.data && cache.data.errors.length === 0) {
          console.error("[bi] rebuild had failed sources, keeping the previous dataset:", d.errors);
          cache.at = Date.now() - TTL_MS + 2 * 60_000;
          return cache.data;
        }
        cache.data = d; cache.at = Date.now(); return d;
      })
      .finally(() => { cache.building = null; });
  }
  return cache.building;
}

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
    const stale = !cache.data || Date.now() - cache.at > TTL_MS;
    if (cache.data && !wantFresh) {
      if (stale) rebuild().catch((e) => console.error("[bi] background rebuild failed:", e));
      return res.status(200).json({ ...cache.data, cacheAgeSeconds: Math.round((Date.now() - cache.at) / 1000), refreshing: stale });
    }
    const data = await rebuild();
    return res.status(200).json({ ...data, cacheAgeSeconds: 0, refreshing: false });
  } catch (err) {
    console.error("[bi] dataset build failed:", err);
    return res.status(500).json({ error: "The business overview could not be built. Try again shortly." });
  }
}
