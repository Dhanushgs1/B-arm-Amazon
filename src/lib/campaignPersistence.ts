// Read-side helper for campaign history persistence (see campaignStateTracker.ts for the
// write side). A campaign missing from today's live list_campaigns pull is not necessarily
// paused in Amazon — it may just be a transient gap in the API response — but the old
// behaviour of trusting the live pull alone made such campaigns vanish from the dashboard
// entirely, silently changing the Active/Paused counts. get_missing_campaign_history reports
// every campaign whose last known snapshot predates the account's most recent daily pull;
// injectMissingCampaignsAsPaused adds those back into the visible list as Paused so nothing
// is ever dropped, without touching the real-time state of campaigns the live pull did return.

import { supabasePublic } from "@/lib/amazonReportUpload";

export interface MissingCampaignHistory {
  campaign_id: string;
  campaign_name: string | null;
  last_seen_date: string;
}

export async function fetchMissingCampaignHistory(keySlot: string): Promise<MissingCampaignHistory[]> {
  const { data, error } = await supabasePublic.rpc("get_missing_campaign_history", { p_key_slot: keySlot });
  if (error) throw new Error(`missing-campaign history fetch failed: ${error.message}`);
  return data || [];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function injectMissingCampaignsAsPaused<T extends { campaignId?: any; campaignName?: string; name?: string }>(
  liveCampaigns: T[],
  missingHistory: MissingCampaignHistory[]
): T[] {
  const liveIds = new Set(liveCampaigns.map((c) => String(c.campaignId)));
  const ghosts = missingHistory
    .filter((m) => !liveIds.has(m.campaign_id))
    .map((m) => ({
      campaignId: m.campaign_id,
      campaignName: m.campaign_name || m.campaign_id,
      name: m.campaign_name || m.campaign_id,
      state: "PAUSED",
    })) as unknown as T[];
  return [...liveCampaigns, ...ghosts];
}
