// GET /api/data/loader?name=<loader>&a=<arg>&a=<arg> — runs one of the dashboard's read-only data
// loaders on the server (see src/lib/viaServer.ts) and shares the result between viewers. The
// cache, the allowed loaders and the argument checks live in src/lib/server/loaderCache.ts.

import type { NextApiRequest, NextApiResponse } from "next";
import { checkSession, guard } from "@/lib/apiAuth";
import { getCached, UnknownLoaderError } from "@/lib/server/loaderCache";

export const config = { api: { responseLimit: "24mb" } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!guard(req, res, checkSession)) return;
  res.setHeader("Cache-Control", "private, no-store");
  const name = String(req.query.name ?? "");
  const args = ([] as string[]).concat((req.query.a as string | string[] | undefined) ?? []);
  try {
    const { data, ageSeconds } = await getCached(name, args);
    res.setHeader("X-Data-Age-Seconds", String(ageSeconds));
    return res.status(200).json({ data });
  } catch (err) {
    if (err instanceof UnknownLoaderError) return res.status(400).json({ error: "Unknown data request" });
    return res.status(502).json({ error: err instanceof Error ? err.message : "The data could not be loaded. Try again shortly." });
  }
}
