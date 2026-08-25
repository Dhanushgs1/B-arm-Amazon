// Runs right after a weekly ads report upload: aggregates the just-uploaded
// rows by campaign (and, where the report has it, by ad group + SKU), finds
// anything over the account's ACOS threshold (same setting the Settings page
// and adAlerts.ts already use), asks Gemini for specific fix suggestions, and
// emails both through the existing /api/send-email "campaign" (High ACOS
// Campaign Alert) template — same Gmail transport the rest of the app's
// alerts use, just triggered from the upload page instead of a cron.
//
// Deliberately sourced only from the CSVs the seller already uploaded to
// Supabase (barm_amazon_*), not the live SellerMate API — this alert reflects
// exactly the data the seller chose to upload, nothing fetched live.
//
// Ad-group and SKU breakdown is only possible for sp_advertised_product:
// Amazon's own SB/SD "Campaign report" exports have no ad-group or SKU
// column (see mapCampaignCommon in amazonReportUpload.ts), so those stay
// campaign-level — a limitation of Amazon's export, not this code. Keyword
// and search-term names are never invented here for the same reason: neither
// is in any of the report types this page accepts, so a per-keyword bid
// suggestion would have to be fabricated. Suggestions instead point at the
// specific ad group/SKU driving the spend and describe what to look for in
// that ad group's keyword/search-term report.

import type { UploadReportType } from "./amazonReportUpload";

// Only these three report types carry a per-campaign ACOS figure.
export const ACOS_ALERT_TYPES: UploadReportType[] = ["sp_advertised_product", "sb_campaign", "sd_campaign"];

const SALES_FIELD: Partial<Record<UploadReportType, string>> = {
  sp_advertised_product: "sales_7d",
  sb_campaign: "sales",
  sd_campaign: "sales_14d",
};

const ORDERS_FIELD: Partial<Record<UploadReportType, string>> = {
  sp_advertised_product: "orders_7d",
  sb_campaign: "orders",
  sd_campaign: "orders_14d",
};

// Below this, a campaign's spend is too small for its ACOS to mean anything
// (a single ₹20 click with no sale would otherwise read as "infinite ACOS").
const MIN_SPEND = 100;
// Ad groups under a flagged campaign that spent less than this aren't worth
// naming individually in the email/prompt — keeps the breakdown to the
// handful of ad groups actually driving the campaign's spend.
const MIN_AD_GROUP_SPEND = 50;

interface Bucket {
  spend: number;
  sales: number;
  clicks: number;
  impressions: number;
  orders: number;
}

function newBucket(): Bucket {
  return { spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0 };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addRow(bucket: Bucket, r: any, salesField: string, ordersField?: string) {
  bucket.spend += Number(r.spend) || 0;
  bucket.sales += Number(r[salesField]) || 0;
  bucket.clicks += Number(r.clicks) || 0;
  bucket.impressions += Number(r.impressions) || 0;
  if (ordersField) bucket.orders += Number(r[ordersField]) || 0;
}

function metrics(b: Bucket) {
  const spend = Math.round(b.spend);
  const sales = Math.round(b.sales);
  return {
    spend,
    sales,
    // Spend with zero matching sales is effectively unbounded ACOS — capped
    // at 999 so the email shows a big honest number instead of "Infinity%".
    acos: sales > 0 ? Math.round((spend / sales) * 100) : spend > 0 ? 999 : 0,
    roas: spend > 0 ? Math.round((sales / spend) * 100) / 100 : 0,
    clicks: b.clicks,
    orders: b.orders,
    ctr: b.impressions > 0 ? Math.round((b.clicks / b.impressions) * 1000) / 10 : 0,
    cpc: b.clicks > 0 ? Math.round((b.spend / b.clicks) * 100) / 100 : 0,
  };
}

export interface AdGroupBreakdown {
  adGroupName: string;
  spend: number;
  sales: number;
  acos: number;
  roas: number;
  clicks: number;
  orders: number;
  ctr: number;
  cpc: number;
  topSkus: string[];
}

export interface HighAcosCampaign {
  name: string;
  spend: number;
  sales: number;
  acos: number;
  roas: number;
  clicks: number;
  orders: number;
  ctr: number;
  cpc: number;
  // Only present for sp_advertised_product — see file header.
  adGroups?: AdGroupBreakdown[];
  // This campaign's own AI (or rule-based fallback) suggestion — filled in
  // after aggregation by generatePerCampaignSuggestions().
  suggestion?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function aggregateCampaigns(type: UploadReportType, rows: any[]): HighAcosCampaign[] {
  const salesField = SALES_FIELD[type];
  if (!salesField) return [];
  const ordersField = ORDERS_FIELD[type];

  const campaignBuckets = new Map<string, Bucket>();
  // Nested only for sp_advertised_product: campaign -> ad group -> bucket, and
  // campaign -> ad group -> sku -> spend (for naming the top SKUs).
  const adGroupBuckets = new Map<string, Map<string, Bucket>>();
  const skuSpendByAdGroup = new Map<string, Map<string, Map<string, number>>>();

  for (const r of rows) {
    const campaignName = r.campaign_name;
    if (!campaignName) continue;

    const cBucket = campaignBuckets.get(campaignName) || newBucket();
    addRow(cBucket, r, salesField, ordersField);
    campaignBuckets.set(campaignName, cBucket);

    if (type === "sp_advertised_product" && r.ad_group_name) {
      const adGroupName = r.ad_group_name as string;
      const perCampaign = adGroupBuckets.get(campaignName) || new Map<string, Bucket>();
      const agBucket = perCampaign.get(adGroupName) || newBucket();
      addRow(agBucket, r, salesField, ordersField);
      perCampaign.set(adGroupName, agBucket);
      adGroupBuckets.set(campaignName, perCampaign);

      if (r.advertised_sku) {
        const perCampaignSkus = skuSpendByAdGroup.get(campaignName) || new Map<string, Map<string, number>>();
        const perAdGroupSkus = perCampaignSkus.get(adGroupName) || new Map<string, number>();
        perAdGroupSkus.set(r.advertised_sku, (perAdGroupSkus.get(r.advertised_sku) || 0) + (Number(r.spend) || 0));
        perCampaignSkus.set(adGroupName, perAdGroupSkus);
        skuSpendByAdGroup.set(campaignName, perCampaignSkus);
      }
    }
  }

  return [...campaignBuckets.entries()].map(([name, bucket]) => {
    const m = metrics(bucket);
    const perAdGroup = adGroupBuckets.get(name);
    let adGroups: AdGroupBreakdown[] | undefined;
    if (perAdGroup) {
      const skuMap = skuSpendByAdGroup.get(name);
      adGroups = [...perAdGroup.entries()]
        .map(([adGroupName, agBucket]) => {
          const am = metrics(agBucket);
          const skus = skuMap?.get(adGroupName);
          const topSkus = skus
            ? [...skus.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([sku]) => sku)
            : [];
          return { adGroupName, ...am, topSkus };
        })
        .filter((ag) => ag.spend >= MIN_AD_GROUP_SPEND)
        .sort((a, b) => b.spend - a.spend)
        .slice(0, 6);
    }
    return { name, ...m, adGroups };
  });
}

function campaignPromptLines(campaigns: HighAcosCampaign[], currency: string): string {
  return campaigns
    .map((c) => {
      const head = `- Campaign "${c.name}": spend ${currency}${c.spend}, sales ${currency}${c.sales}, ACOS ${c.acos}%, ROAS ${c.roas}x, ${c.orders} orders, CTR ${c.ctr}%, CPC ${currency}${c.cpc}`;
      if (!c.adGroups || c.adGroups.length === 0) {
        return `${head}\n  (no ad-group breakdown available for this report type — Amazon's SB/SD Campaign report doesn't include ad groups)`;
      }
      const agLines = c.adGroups
        .map(
          (ag) =>
            `    - Ad group "${ag.adGroupName}" (top SKUs: ${ag.topSkus.join(", ") || "n/a"}): spend ${currency}${ag.spend}, sales ${currency}${ag.sales}, ACOS ${ag.acos}%, ${ag.orders} orders, CTR ${ag.ctr}%, CPC ${currency}${ag.cpc}`
        )
        .join("\n");
      return `${head}\n  Ad groups within this campaign:\n${agLines}`;
    })
    .join("\n");
}

// One rule-based bid-cut suggestion for a single campaign — the fallback used
// both when Gemini fails outright and, per-campaign, when Gemini's JSON
// response is missing or unmatched for that specific campaign.
function fallbackSuggestion(c: HighAcosCampaign, currency: string): string {
  if (c.adGroups && c.adGroups.length > 0) {
    const worst = c.adGroups[0];
    const cut = worst.acos >= 90 ? 50 : worst.acos >= 60 ? 35 : 20;
    const pauseNote = worst.sales === 0 ? ` Pause it outright — zero sales on ${currency}${worst.spend} spend.` : "";
    return (
      `Cut bids ${cut}% on ad group "${worst.adGroupName}" (top SKU: ${worst.topSkus[0] || "n/a"}, ACOS ${worst.acos}%, ${currency}${worst.spend} spend).${pauseNote} ` +
      `Open that ad group's search-term report first to add negative exact-match keywords for zero-conversion terms.`
    );
  }
  const cut = c.acos >= 90 ? 40 : c.acos >= 60 ? 25 : 15;
  return `No ad-group breakdown in this report type (SB/SD export) — cut this campaign's bids/daily budget ${cut}% given its ${c.acos}% ACOS.`;
}

// Strips a ```json ... ``` fence if Gemini wrapped its answer in one.
function extractJsonBlock(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  return fenced ? fenced[1] : text;
}

// One suggestion PER campaign (not one shared paragraph) so the email reader
// can act on each campaign independently — asks Gemini for strict JSON keyed
// by the exact campaign name, then falls back per-campaign (not just
// globally) when Gemini is down or skips/renames a campaign in its answer.
async function generatePerCampaignSuggestions(
  campaigns: HighAcosCampaign[],
  threshold: number,
  currency: string
): Promise<Map<string, string>> {
  const list = campaignPromptLines(campaigns, currency);
  const prompt =
    `You are an Amazon Ads PPC analyst. This week's uploaded report data found ${campaigns.length} campaign(s) exceeding the ${threshold}% ACOS threshold, broken down by ad group and top SKU where the report has that data:\n\n${list}\n\n` +
    `Return ONLY a JSON object, no markdown fences, no text outside the JSON, of this exact shape:\n` +
    `{"campaigns":[{"name":"<exact campaign name as given above>","suggestion":"<1-2 sentences, specific bid change % or pause on a named ad group when ad groups are listed, or a budget/bid cut % for the whole campaign when no ad groups are listed; end with which named ad group to open the search-term report for first — never invent a keyword or search-term name>"}]}\n` +
    `Include every one of the ${campaigns.length} campaigns listed above, using their exact name string.`;

  const fallbackMap = new Map(campaigns.map((c) => [c.name, fallbackSuggestion(c, currency)]));

  try {
    const r = await fetch("/api/gemini-insights", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if (r.ok) {
      const j = await r.json();
      if (j.text) {
        const parsed = JSON.parse(extractJsonBlock(j.text as string));
        const entries: Array<{ name?: string; suggestion?: string }> = parsed?.campaigns || [];
        const byName = new Map(entries.filter((e) => e.name && e.suggestion).map((e) => [e.name as string, e.suggestion as string]));
        // Merge onto the fallback map so any campaign Gemini skipped or
        // renamed still gets a concrete, data-backed suggestion.
        for (const c of campaigns) {
          const hit = byName.get(c.name);
          if (hit) fallbackMap.set(c.name, hit);
        }
      }
    }
  } catch {
    // JSON.parse or fetch failure — fallbackMap (all rule-based) stands as-is.
  }

  return fallbackMap;
}

export interface AcosAlertResult {
  checked: boolean;
  highAcosCount: number;
  emailed: boolean;
  to?: string;
  error?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function maybeAlertHighAcos(type: UploadReportType, rows: any[], keySlot: string): Promise<AcosAlertResult> {
  if (!ACOS_ALERT_TYPES.includes(type)) return { checked: false, highAcosCount: 0, emailed: false };

  try {
    const settingsRes = await fetch(`/api/email-settings?keySlot=${encodeURIComponent(keySlot)}`);
    const settings = settingsRes.ok ? await settingsRes.json() : {};
    const notifEmail: string | undefined = settings.notifEmail || undefined;
    const ccEmail: string | undefined = settings.ccEmail || undefined;
    const acosThreshold: number = Number(settings.acosThreshold) || 40;
    const currency: string = settings.currency || "INR";

    const campaigns = aggregateCampaigns(type, rows)
      .filter((c) => c.spend >= MIN_SPEND && c.acos >= acosThreshold)
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 10);

    if (campaigns.length === 0) return { checked: true, highAcosCount: 0, emailed: false };
    if (!notifEmail) {
      return { checked: true, highAcosCount: campaigns.length, emailed: false, error: "No alert email set in Settings" };
    }

    const suggestionByName = await generatePerCampaignSuggestions(campaigns, acosThreshold, currency);
    for (const c of campaigns) c.suggestion = suggestionByName.get(c.name);

    const emailRes = await fetch("/api/send-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "campaign",
        to: notifEmail,
        cc: ccEmail,
        data: { campaigns, acosThreshold },
      }),
    });
    const emailJson = await emailRes.json().catch(() => ({}));
    return {
      checked: true,
      highAcosCount: campaigns.length,
      emailed: !!emailRes.ok,
      to: notifEmail,
      error: emailRes.ok ? undefined : emailJson.error || "Email failed",
    };
  } catch (err) {
    console.error("[uploadAcosAlert] failed:", err);
    return { checked: true, highAcosCount: 0, emailed: false, error: err instanceof Error ? err.message : "Alert check failed" };
  }
}
