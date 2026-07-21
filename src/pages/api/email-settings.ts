// GET/POST { keySlot: "A" | "B", ... } — per-account settings, stored in Supabase
// (see src/lib/emailSettingsStore.ts for why: the previous single shared JSON
// file didn't persist on Vercel and could leak one account's settings into
// another's automated emails).

import type { NextApiRequest, NextApiResponse } from "next";
import { readEmailSettings, writeEmailSettings } from "@/lib/emailSettingsStore";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    const keySlot = (req.query.keySlot as string) || "B";
    const settings = await readEmailSettings(keySlot);
    return res.status(200).json(settings);
  }

  if (req.method === "POST") {
    const keySlot = req.body?.keySlot || "B";
    try {
      const settings = await writeEmailSettings(keySlot, req.body || {});
      return res.status(200).json({ success: true, settings });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || "Failed to save settings" });
    }
  }

  res.status(405).json({ error: "Method not allowed" });
}
