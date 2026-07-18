// Ad-waste alert detectors — each pulls live SellerMate data and returns the
// rows worth alerting on. Shared by the /api/ad-alerts endpoint (manual) and
// the daily cron (automatic). Read-only; uses the SellerMate API key directly.

const SELLERMATE_BASE_URL = "https://api.sellermate.ai/public/v1/tools";

async function callTool(tool: string, args: Record<string, any>, apiKey: string) {
  const r = await fetch(`${SELLERMATE_BASE_URL}/${tool}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`${tool}: ${await r.text()}`);
  return r.json();
}

const toDateStr = (d: Date) => d.toISOString().slice(0, 10);

function windowDates(lookbackDays: number, now = new Date()) {
  const end = now;
  const start = new Date(now);
  start.setDate(start.getDate() - (lookbackDays - 1));
  return { start_date: toDateStr(start), end_date: toDateStr(end) };
}

export type BleedingCampaign = {
  campaignName: string; campaignId: string; spend: number; sales: number;
  acos: number | null; roas: number; orders: number;
};

// Campaigns burning budget: spend over minSpend AND (zero orders OR ACOS above threshold).
export async function findBleedingCampaigns(opts: {
  apiKey: string; amazon_account_id: string; workspace_id: string;
  acosThreshold?: number; minSpend?: number; lookbackDays?: number; now?: Date; limit?: number;
}): Promise<BleedingCampaign[]> {
  const acosThreshold = opts.acosThreshold ?? 40;
  const minSpend = opts.minSpend ?? 500;
  const dates = windowDates(opts.lookbackDays ?? 7, opts.now);
  const res = await callTool("get_campaign_performance", {
    amazon_account_id: opts.amazon_account_id, workspace_id: opts.workspace_id,
    ...dates, page_size: 500,
  }, opts.apiKey);
  const rows: any[] = res.data || [];
  return rows
    .filter((c) => c.spend >= minSpend && (c.orders === 0 || (c.acos != null && c.acos >= acosThreshold)))
    .map((c) => ({
      campaignName: c.campaignName, campaignId: c.campaignId, spend: c.spend, sales: c.sales,
      acos: c.acos, roas: c.roas, orders: c.orders,
    }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, opts.limit ?? 10);
}

export type WastedTerm = {
  searchTerm: string; spend: number; clicks: number; impressions: number;
};

// Search terms that spent money with zero orders — negative-keyword candidates.
export async function findWastedSearchTerms(opts: {
  apiKey: string; amazon_account_id: string; workspace_id: string;
  minSpend?: number; lookbackDays?: number; now?: Date; limit?: number;
}): Promise<{ terms: WastedTerm[]; totalWasted: number }> {
  const minSpend = opts.minSpend ?? 100;
  const dates = windowDates(opts.lookbackDays ?? 7, opts.now);
  const all: any[] = [];
  let page = 0;
  for (let i = 0; i < 5; i++) {
    const res = await callTool("get_search_term_performance", {
      amazon_account_id: opts.amazon_account_id, workspace_id: opts.workspace_id,
      ...dates, page, page_size: 200, sort_field: "cost", sort_direction: "desc",
    }, opts.apiKey);
    const rows: any[] = res.data || [];
    all.push(...rows);
    if (!res.pagination?.hasMore || rows.length === 0) break;
    page++;
  }
  const wasted = all
    .filter((t) => t.orders === 0 && t.spend >= minSpend)
    .sort((a, b) => b.spend - a.spend);
  const totalWasted = wasted.reduce((a, t) => a + t.spend, 0);
  return {
    terms: wasted.slice(0, opts.limit ?? 10).map((t) => ({
      searchTerm: t.searchTerm, spend: t.spend, clicks: t.clicks, impressions: t.impressions,
    })),
    totalWasted,
  };
}

export function resolveSellerMateKey(slot: string): string | undefined {
  if (slot === "B") return process.env.SELLERMATE_API_KEY_B;
  return process.env.SELLERMATE_API_KEY_A || process.env.SELLERMATE_API_KEY;
}
