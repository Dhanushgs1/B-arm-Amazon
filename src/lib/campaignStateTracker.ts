// Detects campaigns that were ENABLED on the previous run and are no longer
// ENABLED now (paused, or moved to any other state), and logs the transition
// to Supabase. No email — this is a history log for later reporting, not an
// alert (see AI_ACTION_PLAN / live-alerts.ts for the alerting path).
//
// barm_campaign_state holds the latest known state per (key_slot, campaign_id) —
// overwritten every run, so each run diffs against "what we saw last time".
// barm_campaign_pause_log is the append-only history of transitions.
//
// barm_campaign_daily_snapshot is a third, separate table: one row per
// (key_slot, campaign_id, snapshot_date) for every campaign actually returned
// by list_campaigns that day. Unlike barm_campaign_state it is never overwritten,
// so it is the real day-by-day history — campaignPersistence.ts reads it to find
// campaigns absent from the latest pull and re-inject them into the dashboard as
// Paused instead of letting them silently vanish from Active/Paused counts.

import { supabasePublic } from "@/lib/amazonReportUpload";

const SELLERMATE_BASE_URL = "https://api.sellermate.ai/public/v1/tools";
const STATE_TABLE = "barm_campaign_state";
const LOG_TABLE = "barm_campaign_pause_log";
const SNAPSHOT_TABLE = "barm_campaign_daily_snapshot";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callTool(tool: string, args: Record<string, any>, apiKey: string) {
  const r = await fetch(`${SELLERMATE_BASE_URL}/${tool}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`${tool}: ${await r.text()}`);
  return r.json();
}

interface Ctx {
  apiKey: string;
  amazon_account_id: string;
  workspace_id: string;
  slot: string;
}

export interface CampaignPauseEvent {
  campaignId: string;
  campaignName: string;
  previousState: string;
  newState: string;
}

export async function checkCampaignStateChanges(ctx: Ctx): Promise<{
  checked: number;
  transitions: CampaignPauseEvent[];
}> {
  const res = await callTool(
    "list_campaigns",
    { amazon_account_id: ctx.amazon_account_id, workspace_id: ctx.workspace_id, page_size: 2000 },
    ctx.apiKey
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const campaigns: any[] = res.campaigns || [];

  const { data: prevRows, error: readErr } = await supabasePublic
    .from(STATE_TABLE)
    .select("campaign_id, state")
    .eq("key_slot", ctx.slot);
  if (readErr) throw new Error(`campaign state read failed: ${readErr.message}`);

  const prevStateById = new Map<string, string>();
  (prevRows || []).forEach((r) => prevStateById.set(r.campaign_id, r.state));

  const transitions: CampaignPauseEvent[] = [];
  const now = new Date().toISOString();
  const snapshotRows = campaigns
    .filter((c) => c.campaignId)
    .map((c) => {
      const campaignId = String(c.campaignId);
      const campaignName = c.name || c.campaignName || campaignId;
      const newState = (c.state || "").toUpperCase();
      const previousState = prevStateById.get(campaignId);

      if (previousState === "ENABLED" && newState !== "ENABLED" && newState) {
        transitions.push({ campaignId, campaignName, previousState, newState });
      }

      return {
        key_slot: ctx.slot,
        campaign_id: campaignId,
        campaign_name: campaignName,
        state: newState || previousState || "UNKNOWN",
        checked_at: now,
      };
    });

  if (transitions.length > 0) {
    const logRows = transitions.map((t) => ({
      key_slot: ctx.slot,
      campaign_id: t.campaignId,
      campaign_name: t.campaignName,
      previous_state: t.previousState,
      new_state: t.newState,
      detected_at: now,
    }));
    const { error: logErr } = await supabasePublic.from(LOG_TABLE).insert(logRows);
    if (logErr) throw new Error(`campaign pause log write failed: ${logErr.message}`);
  }

  if (snapshotRows.length > 0) {
    const { error: upErr } = await supabasePublic
      .from(STATE_TABLE)
      .upsert(snapshotRows, { onConflict: "key_slot,campaign_id" });
    if (upErr) throw new Error(`campaign state snapshot write failed: ${upErr.message}`);
  }

  // Daily history — one immutable row per campaign per calendar day, keyed off the
  // same list_campaigns call above so this never costs an extra API request. UTC date
  // to match the rest of the codebase's server-side "day" convention (see daily-digest.ts);
  // the 03:30 UTC cron slot means this never straddles the IST business day either.
  const today = new Date().toISOString().slice(0, 10);
  const dailySnapshotRows = campaigns
    .filter((c) => c.campaignId)
    .map((c) => {
      const campaignId = String(c.campaignId);
      const campaignName = c.name || c.campaignName || campaignId;
      const rawState = (c.state || "").toUpperCase();
      return {
        key_slot: ctx.slot,
        campaign_id: campaignId,
        campaign_name: campaignName,
        snapshot_date: today,
        raw_state: rawState || null,
        status: rawState === "ENABLED" ? "ACTIVE" : "PAUSED",
      };
    });

  if (dailySnapshotRows.length > 0) {
    const { error: snapErr } = await supabasePublic
      .from(SNAPSHOT_TABLE)
      .upsert(dailySnapshotRows, { onConflict: "key_slot,campaign_id,snapshot_date" });
    if (snapErr) throw new Error(`campaign daily snapshot write failed: ${snapErr.message}`);
  }

  return { checked: campaigns.length, transitions };
}
