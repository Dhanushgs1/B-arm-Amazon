// Detects campaigns that flipped from ENABLED to any other state since the last run,
// and logs the transition to Supabase (barm_campaign_pause_log). Called from two
// places with different intents:
//  - scheduled-reports.ts (once a day, unconditionally, no `to`) — history logging
//    only, so the dashboard can keep showing a campaign as Paused instead of losing
//    it. Deliberately silent regardless of email settings.
//  - cron/campaign-monitor.ts (every 30 min; passes `to`/`cc` only when Settings `campaignPauseEmails` is on) — the near-real-time
//    pause alert: if this call's own detection finds a fresh transition, it emails
//    immediately. A transition already caught by an earlier run (either cadence)
//    won't re-fire here, since checkCampaignStateChanges only reports state that
//    actually changed since the last recorded check.
//
// POST body: { slot?, amazon_account_id, workspace_id, to?, cc? }

import type { NextApiRequest, NextApiResponse } from "next";
import { resolveSellerMateKey } from "@/lib/adAlerts";
import { checkCampaignStateChanges } from "@/lib/campaignStateTracker";
import { internalFetch, internalOrigin } from "@/lib/internalFetch";
import { checkInternal, guard } from "@/lib/apiAuth";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  // Cron/server-only: callable solely via internalFetch (signed with INTERNAL_API_SECRET).
  if (!guard(req, res, checkInternal)) return;

  const { slot = "B", amazon_account_id, workspace_id, to, cc } = req.body || {};
  if (!amazon_account_id || !workspace_id) {
    return res.status(400).json({ error: "amazon_account_id and workspace_id are required" });
  }
  const apiKey = resolveSellerMateKey(slot === "B" ? "B" : "A");
  if (!apiKey) return res.status(500).json({ error: `Missing SellerMate API key for slot ${slot}` });

  try {
    const result = await checkCampaignStateChanges({ apiKey, amazon_account_id, workspace_id, slot });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let emailResult: any = null;
    if (result.transitions.length > 0 && to) {
      const r = await internalFetch(`${internalOrigin()}/api/send-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "campaignPause", to, cc, data: { transitions: result.transitions } }),
      });
      emailResult = await r.json().catch(() => ({}));
      if (!r.ok) emailResult = { error: emailResult?.error || "send-email failed" };
    }

    return res.status(200).json({
      ...result,
      emailed: !!(to && result.transitions.length > 0 && emailResult && !emailResult.error),
      emailResult,
    });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : "campaign-state-check failed" });
  }
}
