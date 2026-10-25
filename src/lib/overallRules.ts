// Rules for the Overall page: quick date ranges, campaign verdicts and the "doing well / needs
// attention" list for every platform. Dependency-free so it can be unit tested.
//
// Thresholds reuse the ones the dashboard already shows:
//   - Campaign "best": ACOS at or under 13% (ACOS_LIMIT, the green ACOS badge).
//   - Campaign "losing": spent with no sales, or ACOS over 40% (ad-alerts / daily digest).
//   - Campaign minimum spend before it is judged: ACOS_CHANNELS (Amazon/Flipkart ₹200, Meesho ₹50).
//   - Platform ads: ROAS 4+ (ACOS ≤ 25%) is doing well; under 2 (ACOS > 50%, the worst search-term
//     bucket) needs attention. TACOS (ad spend incl. GST ÷ sales) over 15% needs attention.
//   - Sales moving 10% or more against the previous period of the same length is called out.
// Campaign spend is ad-console spend (no GST), the same as the ads reports; platform Ad Spend adds
// 18% GST like the rest of the dashboard.
import type { ChannelAdRow } from "./highAcosChannels.ts";

export const GST_MULTIPLIER = 1.18; // same as DEFAULT_GST_MULTIPLIER (masterProductSkuid.ts)
export const GOOD_ACOS = 13;
export const BAD_ACOS = 40;
export const GOOD_ROAS = 4;
export const BAD_ROAS = 2;
export const MAX_TACOS = 15;
export const SALES_MOVE = 10;

export type AdPlatform = "amazon" | "flipkart" | "meesho" | "google" | "meta";
export const CAMPAIGN_MIN_SPEND: Record<AdPlatform, number> = { amazon: 200, flipkart: 200, meesho: 50, google: 200, meta: 200 };

// ── campaigns ────────────────────────────────────────────────────────────────

export type CampaignVerdict = "best" | "losing" | "ok" | "small" | "spend-only";

export interface CampaignStat {
  id: string;
  name: string;
  spend: number;
  sales: number | null;   // null: the platform's report has no sales per campaign (Google, Meta)
  orders: number | null;
  clicks: number | null;
  roas: number | null;
  acos: number | null;    // %
  verdict: CampaignVerdict;
}

export function judgeCampaign(spend: number, sales: number | null, minSpend: number): CampaignVerdict {
  if (sales === null) return "spend-only";
  if (spend < minSpend) return "small";
  if (sales <= 0) return "losing";
  const acos = (spend / sales) * 100;
  if (acos <= GOOD_ACOS) return "best";
  if (acos > BAD_ACOS) return "losing";
  return "ok";
}

/** Uploaded marketplace ad rows (Amazon / Flipkart / Meesho) summed per campaign over start..end. */
export function campaignStatsFromRows(rows: ChannelAdRow[], start: string, end: string, minSpend: number): CampaignStat[] {
  const m = new Map<string, { id: string; name: string; spend: number; sales: number; orders: number }>();
  for (const r of rows) {
    if (r.date < start || r.date > end) continue;
    const c = m.get(r.id) ?? { id: r.id, name: r.name, spend: 0, sales: 0, orders: 0 };
    c.spend += r.spend;
    c.sales += r.sales;
    c.orders += r.orders;
    m.set(r.id, c);
  }
  return [...m.values()]
    .filter((c) => c.spend > 0 || c.sales > 0)
    .map((c) => ({
      ...c,
      clicks: null,
      roas: c.spend > 0 ? c.sales / c.spend : null,
      acos: c.sales > 0 ? (c.spend / c.sales) * 100 : null,
      verdict: judgeCampaign(c.spend, c.sales, minSpend),
    }))
    .sort((a, b) => b.spend - a.spend);
}

/** Google / Meta campaigns from resolveDailySpend: spend (and clicks) only. */
export function campaignStatsFromSpend(campaigns: { name: string; spend: number; clicks: number }[]): CampaignStat[] {
  return campaigns
    .filter((c) => c.spend > 0)
    .map((c) => ({
      id: c.name, name: c.name, spend: c.spend, sales: null, orders: null,
      clicks: c.clicks > 0 ? c.clicks : null, roas: null, acos: null, verdict: "spend-only" as const,
    }))
    .sort((a, b) => b.spend - a.spend);
}

/** Best campaigns (lowest ACOS first) and losing ones (most spend first). */
export function campaignHighlights(stats: CampaignStat[], k = 5): { best: CampaignStat[]; losing: CampaignStat[] } {
  return {
    best: stats.filter((c) => c.verdict === "best").sort((a, b) => (b.roas ?? 0) - (a.roas ?? 0)).slice(0, k),
    losing: stats.filter((c) => c.verdict === "losing").sort((a, b) => b.spend - a.spend).slice(0, k),
  };
}

// ── platforms ────────────────────────────────────────────────────────────────

export interface PlatformSnapshot {
  key: string;
  label: string;
  /** Marketplace: gross sales. Google/Meta: sales of the Shopify orders that came from that ad. */
  sales: number | null;      // null while loading / not available
  salesPrev: number | null;
  orders: number | null;
  /** Ad spend without GST (as the ad console shows it); null = no ad data for this platform. */
  adSpend: number | null;
  adSpendPrev: number | null;
  /** Sales the ads report credits to ads, compared with adSpend for ROAS. */
  adSales: number | null;
  /** Whether `sales` is the platform's own sales (TACOS makes sense) or ad-attributed sales. */
  attributed?: boolean;
  dataThrough?: string | null;
  rangeEnd: string;
}

export const growthPct = (now: number | null, before: number | null): number | null =>
  now === null || before === null || before <= 0 ? null : ((now - before) / before) * 100;

export function platformMetrics(p: PlatformSnapshot) {
  const roas = p.adSpend && p.adSpend > 0 && p.adSales !== null ? p.adSales / p.adSpend : null;
  const tacos = !p.attributed && p.adSpend !== null && p.sales && p.sales > 0 ? ((p.adSpend * GST_MULTIPLIER) / p.sales) * 100 : null;
  return { salesGrowth: growthPct(p.sales, p.salesPrev), spendGrowth: growthPct(p.adSpend, p.adSpendPrev), roas, tacos };
}

export interface Insight { platform: string; tone: "good" | "watch"; text: string }
export type PlatformStatus = "good" | "watch" | "steady";

const rupees = (v: number) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(v))}`;
const dot = (iso: string) => iso.split("-").reverse().join(".");
const one = (v: number) => (Math.round(v * 10) / 10).toFixed(1);

export function platformInsights(p: PlatformSnapshot): Insight[] {
  const out: Insight[] = [];
  const { salesGrowth: g, spendGrowth: sg, roas, tacos } = platformMetrics(p);
  const add = (tone: Insight["tone"], text: string) => out.push({ platform: p.label, tone, text });

  if (p.dataThrough && p.dataThrough < p.rangeEnd) add("watch", `Data only goes up to ${dot(p.dataThrough)} — upload the latest file; the last days read as zero.`);
  if (g !== null && g >= SALES_MOVE) add("good", `Sales up ${one(g)}% (${rupees(p.sales!)} vs ${rupees(p.salesPrev!)}).`);
  if (g !== null && g <= -SALES_MOVE) add("watch", `Sales down ${one(-g)}% (${rupees(p.sales!)} vs ${rupees(p.salesPrev!)}).`);
  if (p.adSpend !== null && p.adSpend > 0 && p.adSales === 0) add("watch", `Spent ${rupees(p.adSpend)} on ads with no sales credited to them.`);
  else if (roas !== null && roas >= GOOD_ROAS) add("good", `Ads bring ₹${one(roas)} of sales for every ₹1 spent (ROAS ${one(roas)}x).`);
  else if (roas !== null && roas < BAD_ROAS) add("watch", `Ads return only ${one(roas)}x what they cost — check the losing campaigns.`);
  if (tacos !== null && tacos > MAX_TACOS) add("watch", `Ad spend is ${one(tacos)}% of sales (TACOS above ${MAX_TACOS}%).`);
  if (sg !== null && sg >= 20 && g !== null && g < 0) add("watch", `Ad spend up ${one(sg)}% while sales fell ${one(-g)}%.`);
  return out;
}

export function platformStatus(insights: Insight[]): PlatformStatus {
  if (insights.some((i) => i.tone === "watch")) return "watch";
  if (insights.some((i) => i.tone === "good")) return "good";
  return "steady";
}
