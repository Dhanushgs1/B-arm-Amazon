// Triggered every 30 minutes by an EXTERNAL scheduler (e.g. cron-job.org), not
// Vercel's native cron — Vercel Hobby rejects any cron schedule more frequent
// than once a day, and this needs to run every 30 min. Protected by CRON_SECRET
// since, unlike a Vercel-native cron, requests here don't come pre-authenticated;
// give the external scheduler an "Authorization: Bearer <CRON_SECRET>" header.
//
// Independent of scheduled-reports.ts's once-a-day run (still a real Vercel cron —
// that schedule is fine on Hobby).
//
// Pause detection is only ever as fresh as the last time checkCampaignStateChanges
// ran: a campaign paused and re-enabled between two runs never shows up in
// barm_campaign_pause_log, because the state read at the start of the next run
// already matches what was saved last time. Dropping the cadence from once a day
// to once every 30 minutes shrinks that blind window from ~24h to ~30min — it does
// not close it (a pause-and-resume inside the same 30-minute gap is still invisible).
//
// Passes notifEmail/ccEmail to campaign-state-check.ts, so a fresh pause it finds
// gets emailed within this 30-min cadence instead of waiting for the next morning's
// digest. Only pause detection gets this treatment — daily-digest/live-alerts stay
// on their once-a-day cadence in scheduled-reports.ts since their detectors compare
// whole-day windows and re-running them every 30 min would just re-scan identical
// numbers (see liveAlerts.ts's header comment on the underlying data lag).

import type { NextApiRequest, NextApiResponse } from "next";
import { readEmailSettings } from "@/lib/emailSettingsStore";
import { internalFetch, internalOrigin } from "@/lib/internalFetch";
import { checkCron, guard } from "@/lib/apiAuth";

const KEY_SLOTS = ["A", "B"] as const;

async function checkSlot(req: NextApiRequest, slot: string) {
  const s = await readEmailSettings(slot);
  if (!(s.amazonAccountId && s.workspaceId)) {
    return { skipped: true, reason: "Account context not saved — save Settings once for this slot." };
  }
  try {
    const r = await internalFetch(`${internalOrigin()}/api/campaign-state-check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slot, amazon_account_id: s.amazonAccountId, workspace_id: s.workspaceId,
        // The "Campaign Paused" email is off unless Settings turns it on (user, 2026-10-11: only the
        // daily emails go out). Without `to`, pauses are still detected and logged, just not mailed.
        ...(s.campaignPauseEmails ? { to: s.notifEmail, cc: s.ccEmail || undefined } : {}),
      }),
    });
    const j = await r.json().catch(() => ({}));
    console.log(`[Marketplace360 Cron] ${r.ok ? "✅" : "❌"} [${slot}] Campaign monitor (30min):`, JSON.stringify(j).slice(0, 300));
    // High ACOS: goes out once yesterday's Last 7 days upload has landed (high-acos-report.ts sends
    // at most once per date). The Upload page triggers it right after the upload; this is the backup
    // from 9:00 IST in case that call did not finish.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let highAcos: any;
    if (s.emailAlerts && s.highAcosDaily && s.notifEmail && new Date(Date.now() + 5.5 * 3_600_000).getUTCHours() >= 9) {
      try {
        const hr = await internalFetch(`${internalOrigin()}/api/high-acos-report`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slot, amazon_account_id: s.amazonAccountId, workspace_id: s.workspaceId, to: s.notifEmail, cc: s.ccEmail || undefined,
            currency: s.currency || "INR", threshold: Number(s.highAcosThreshold) || 14,
          }),
        });
        const hj = await hr.json().catch(() => ({}));
        highAcos = { ok: hr.ok, emailed: hj.emailed, skipped: hj.skipped, error: hj.error };
      } catch (err: any) {
        highAcos = { ok: false, error: err?.message || String(err) };
      }
    }
    return { ok: r.ok, result: j, highAcos };
  } catch (err: any) {
    console.error(`[Marketplace360 Cron] ❌ [${slot}] Campaign monitor (30min) failed:`, err);
    return { ok: false, error: err?.message || String(err) };
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Same guard as scheduled-reports.ts — fails closed (503) when CRON_SECRET is not configured.
  if (!guard(req, res, checkCron)) return;

  const now = new Date();
  const bySlot: Record<string, any> = {};
  for (const slot of KEY_SLOTS) {
    // Isolated per slot: one account's throw must never block the other's check.
    try {
      bySlot[slot] = await checkSlot(req, slot);
    } catch (err: any) {
      bySlot[slot] = { error: err?.message || String(err) };
    }
  }

  return res.status(200).json({ ranAt: now.toISOString(), bySlot });
}
