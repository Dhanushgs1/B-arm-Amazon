// Daily job: detect campaigns that flipped from ENABLED to any other state since the
// last run, and log the transition to Supabase (barm_campaign_pause_log). No email —
// this is a history log, not an alert. Triggered by /api/cron/scheduled-reports.
//
// POST body: { slot?, amazon_account_id, workspace_id }

import type { NextApiRequest, NextApiResponse } from "next";
import { resolveSellerMateKey } from "@/lib/adAlerts";
import { checkCampaignStateChanges } from "@/lib/campaignStateTracker";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { slot = "B", amazon_account_id, workspace_id } = req.body || {};
  if (!amazon_account_id || !workspace_id) {
    return res.status(400).json({ error: "amazon_account_id and workspace_id are required" });
  }
  const apiKey = resolveSellerMateKey(slot === "B" ? "B" : "A");
  if (!apiKey) return res.status(500).json({ error: `Missing SellerMate API key for slot ${slot}` });

  try {
    const result = await checkCampaignStateChanges({ apiKey, amazon_account_id, workspace_id, slot });
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : "campaign-state-check failed" });
  }
}
