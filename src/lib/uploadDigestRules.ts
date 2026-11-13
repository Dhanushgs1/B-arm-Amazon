// Daily digest built from the uploaded data (user, 2026-11-13): one mail a day with yesterday's
// Amazon, Flipkart, Meesho, Shopify, Google Ads and Meta Ads numbers, sent once that day's three
// uploads are in — the "Last 7 days" workbook, the Google Ads files and the Meta ads file. Never
// SellerMate. The numbers are the Overall page's (/dashboard/compare) for a single day: same
// loaders, same rules (overallRules.ts). Pure helpers only; src/pages/api/upload-digest.ts does the I/O.

import type { ChannelSummary } from "./channelSummary";
import type { ChannelAdRow } from "./highAcosChannels";
import type { ResolvedSpend } from "./adSpendDailyRules";
import type { SourceDetail } from "./shopifySourceRules";
import {
  CAMPAIGN_MIN_SPEND, GST_MULTIPLIER, campaignHighlights, campaignStatsFromRows, campaignStatsFromSpend,
  growthPct, platformInsights, type CampaignStat, type Insight, type PlatformSnapshot,
} from "./overallRules.ts";

export type MarketKey = "amazon" | "flipkart" | "meesho";
export type PaidKey = "google" | "meta";

/** A marketplace's numbers may trail the digest day (Flipkart's reports arrive 2–3 days late). Older
 *  than this and the channel is shown as having no recent data instead of a stale day. */
export const DIGEST_MAX_LAG_DAYS = 7;
/** Uploads write a day's rows over a few minutes; server-side callers wait this long after the last write. */
export const DIGEST_SETTLE_MINUTES = 10;

export const addDays = (iso: string, k: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + k);
  return d.toISOString().slice(0, 10);
};

/** Yesterday in IST — the day the morning's uploads describe. */
export function digestDay(now = new Date()): string {
  return addDays(new Date(now.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10), -1);
}

/** The day to show for a marketplace. The digest day itself once its ads are in — if its orders are
 *  not uploaded yet (Flipkart's order report trails by a day) they show as 0 (user, 2026-11-13: "today
 *  0 means mark 0"). Otherwise the newest day that has both order rows and ads rows, or null when
 *  that is older than DIGEST_MAX_LAG_DAYS. */
export function channelDay(day: string, lastOrdersDay: string | null, lastAdsDay: string | null): string | null {
  if (lastAdsDay && lastAdsDay >= day) return day;
  if (!lastOrdersDay || !lastAdsDay) return null;
  const d = [lastOrdersDay, lastAdsDay, day].sort()[0];
  return d >= addDays(day, -DIGEST_MAX_LAG_DAYS) ? d : null;
}

/** Which of the three daily uploads has not brought the digest day's data yet. */
export function digestWaitingFor(landed: { workbook: boolean; google: boolean; meta: boolean }): string[] {
  return [
    !landed.workbook && "the Last 7 days workbook",
    !landed.google && "Google Ads",
    !landed.meta && "Meta ads",
  ].filter((x): x is string => !!x);
}

export interface DigestInput {
  day: string;
  /** ordersIn: the channel's order rows reach `day`; false = they are not uploaded yet and show as 0. */
  markets: { key: MarketKey; label: string; day: string | null; ordersIn?: boolean; summary: ChannelSummary | null; ads: ChannelAdRow[] }[];
  shopify: ChannelSummary;
  paid: { key: PaidKey; label: string; now: ResolvedSpend; before: ResolvedSpend; detail: SourceDetail; prevDetail: SourceDetail }[];
}

export interface DigestRow {
  key: string;
  label: string;
  /** The day these numbers are for; differs from the digest day when the channel's data trails. */
  day: string | null;
  late: boolean;
  /** Null = not a sales channel of its own (Google / Meta sales are Shopify orders, counted there). */
  sales: number | null;
  salesGrowth: number | null;
  orders: number | null;
  /** Ad spend as the ad console shows it (no GST). Null = no ads of its own (Shopify). */
  adSpend: number | null;
  adSales: number | null;
  roas: number | null;
  acos: number | null;
}

export interface DigestCampaigns {
  key: string;
  label: string;
  day: string;
  /** Google / Meta reports have no sales per campaign: biggest spenders only. */
  spendOnly: boolean;
  best: CampaignStat[];
  losing: CampaignStat[];
  top: CampaignStat[];
}

export interface DigestData {
  day: string;
  rows: DigestRow[];
  total: {
    sales: number; salesGrowth: number | null; orders: number;
    adSpend: number; adSpendGst: number; adSales: number; roas: number | null; tacos: number | null;
  };
  good: Insight[];
  watch: Insight[];
  campaigns: DigestCampaigns[];
  /** Channels left out of the totals because their newest data is not the digest day's. */
  lateNotes: string[];
}

const ratio = (a: number | null, b: number | null) => (a !== null && b !== null && b > 0 ? a / b : null);
const pctOf = (a: number | null, b: number | null) => { const r = ratio(a, b); return r === null ? null : r * 100; };

/** The whole digest from loaded data. Totals follow the Overall page: sales = Amazon + Flipkart +
 *  Meesho + Shopify (Google / Meta sales are already inside Shopify), ad spend = the five ad
 *  platforms, TACOS on spend incl. GST. A channel whose data trails the digest day keeps its own
 *  row (with its date) but stays out of the totals, which are for the digest day alone. */
export function buildDigest(input: DigestInput): DigestData {
  const { day } = input;
  const rows: DigestRow[] = [];
  const snaps: PlatformSnapshot[] = [];
  const campaigns: DigestCampaigns[] = [];
  const lateNotes: string[] = [];
  const dot = (iso: string) => iso.split("-").reverse().join(".");

  for (const m of input.markets) {
    if (!m.day || !m.summary) {
      // No data at all for this channel: marked 0 and the mail still goes out (user, 2026-11-13).
      rows.push({ key: m.key, label: m.label, day, late: false, sales: 0, salesGrowth: null, orders: 0, adSpend: 0, adSales: 0, roas: null, acos: null });
      lateNotes.push(`${m.label}: data for ${dot(day)} is not available — marked as 0.`);
      continue;
    }
    const prevDay = addDays(m.day, -1);
    const sum = (d: string) => m.ads.filter((r) => r.date === d).reduce((t, r) => ({ spend: t.spend + r.spend, sales: t.sales + r.sales }), { spend: 0, sales: 0 });
    const a = sum(m.day), b = sum(prevDay);
    const snap: PlatformSnapshot = {
      key: m.key, label: m.label,
      sales: m.summary.current.sales ?? 0, salesPrev: m.summary.previous.sales ?? 0, orders: m.summary.current.orders,
      adSpend: a.spend, adSpendPrev: b.spend, adSales: a.sales, rangeEnd: m.day,
    };
    snaps.push(snap);
    const late = m.day !== day;
    // Orders not uploaded yet: marked 0, with a line saying so (user, 2026-11-13: "0 means mark 0, data not available").
    if (m.ordersIn === false) lateNotes.push(`${m.label}: orders data for ${dot(m.day)} is not available — marked as 0.`);
    if (late) lateNotes.push(`${m.label}: latest data is ${dot(m.day)}, so its row shows that day and it is left out of the totals.`);
    rows.push({
      key: m.key, label: m.label, day: m.day, late,
      sales: snap.sales, salesGrowth: growthPct(snap.sales, snap.salesPrev), orders: snap.orders,
      adSpend: a.spend, adSales: a.sales, roas: ratio(a.sales, a.spend), acos: pctOf(a.spend, a.sales),
    });
    const stats = campaignStatsFromRows(m.ads, m.day, m.day, CAMPAIGN_MIN_SPEND[m.key]);
    const { best, losing } = campaignHighlights(stats);
    campaigns.push({ key: m.key, label: m.label, day: m.day, spendOnly: false, best, losing, top: [] });
  }

  const shop = input.shopify;
  const paidSpend = input.paid.reduce((t, p) => t + p.now.spend, 0);
  // Shopify's ads are Google + Meta, which have their own rows and notes — so no ad figures here, or
  // every ad note would be said twice.
  snaps.push({
    key: "shopify", label: "Shopify", sales: shop.current.sales ?? 0, salesPrev: shop.previous.sales ?? 0, orders: shop.current.orders,
    adSpend: null, adSpendPrev: null, adSales: null, rangeEnd: day,
  });
  rows.push({
    key: "shopify", label: "Shopify (website)", day, late: false,
    sales: shop.current.sales ?? 0, salesGrowth: growthPct(shop.current.sales ?? 0, shop.previous.sales ?? 0), orders: shop.current.orders,
    adSpend: null, adSales: null, roas: null, acos: null,
  });
  for (const p of input.paid) {
    snaps.push({
      key: p.key, label: p.label, attributed: true,
      sales: p.detail.sales, salesPrev: p.prevDetail.sales, orders: p.detail.netOrders,
      adSpend: p.now.spend, adSpendPrev: p.before.spend, adSales: p.detail.coveredSales, rangeEnd: day,
    });
    rows.push({
      key: p.key, label: p.label, day, late: false,
      sales: null, salesGrowth: null, orders: p.detail.netOrders,
      adSpend: p.now.spend, adSales: p.detail.coveredSales,
      roas: ratio(p.detail.coveredSales, p.now.spend), acos: pctOf(p.now.spend, p.detail.coveredSales),
    });
    campaigns.push({ key: p.key, label: p.label, day, spendOnly: true, best: [], losing: [], top: campaignStatsFromSpend(p.now.campaigns).slice(0, 5) });
  }

  // Totals: the digest day only.
  const onDay = rows.filter((r) => !r.late);
  const salesRows = onDay.filter((r) => r.sales !== null);
  const sales = salesRows.reduce((t, r) => t + (r.sales ?? 0), 0);
  const salesPrev = snaps.filter((s) => !s.attributed && salesRows.some((r) => r.key === s.key)).reduce((t, s) => t + (s.salesPrev ?? 0), 0);
  const adRows = onDay.filter((r) => r.adSpend !== null);
  const adSpend = adRows.reduce((t, r) => t + (r.adSpend ?? 0), 0);
  const adSales = adRows.reduce((t, r) => t + (r.adSales ?? 0), 0);
  // TACOS needs spend and sales from the same channels: a marketplace's own, Shopify's = Google + Meta.
  const tacosSales = salesRows.reduce((t, r) => t + (r.sales ?? 0), 0);
  const tacosSpend = salesRows.reduce((t, r) => t + (r.key === "shopify" ? paidSpend : r.adSpend ?? 0), 0);

  const insights = snaps.flatMap((s) => platformInsights(s));

  return {
    day, rows,
    total: {
      sales, salesGrowth: growthPct(sales, salesPrev), orders: salesRows.reduce((t, r) => t + (r.orders ?? 0), 0),
      adSpend, adSpendGst: adSpend * GST_MULTIPLIER, adSales, roas: ratio(adSales, adSpend),
      tacos: tacosSales > 0 ? ((tacosSpend * GST_MULTIPLIER) / tacosSales) * 100 : null,
    },
    good: insights.filter((i) => i.tone === "good"),
    watch: insights.filter((i) => i.tone === "watch"),
    campaigns: campaigns.filter((c) => c.best.length || c.losing.length || c.top.length),
    lateNotes,
  };
}
