// GET/POST { keySlot: "A" | "B", ... } — per-account settings, stored in Supabase
// (see src/lib/emailSettingsStore.ts for why: the previous single shared JSON
// file didn't persist on Vercel and could leak one account's settings into
// another's automated emails).

import type { NextApiRequest, NextApiResponse } from "next";
import { checkSessionOrInternal, guard } from "@/lib/apiAuth";
import { isConfigured, readEmailSettingsStrict, writeEmailSettings } from "@/lib/emailSettingsStore";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Browser-facing: requires the signed-in dashboard session (or a signed server call).
  if (!guard(req, res, checkSessionOrInternal)) return;
  if (req.method === "GET") {
    const keySlot = (req.query.keySlot as string) || "B";
    // Unconfigured (local/offline) keeps the old contract: empty settings. A configured store that
    // cannot be read is a 503, so the Settings form knows NOT to save over what it never saw.
    if (!isConfigured()) return res.status(200).json({});
    try {
      return res.status(200).json(await readEmailSettingsStrict(keySlot));
    } catch (err) {
      console.error("[email-settings] read failed:", err);
      return res.status(503).json({ error: "Saved settings could not be loaded. Try again shortly." });
    }
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
