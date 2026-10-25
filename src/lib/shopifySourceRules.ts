// Details for one Shopify order source (google_ads, meta_ads, google_organic, direct, other) on the
// "Google & Meta" page. Dependency-free so it can be unit tested.
//   - Orders / Sales: that source's orders in the range; Sales = order total of non-cancelled orders
//     (same as the Shopify tab).
//   - Paid sources: spend comes from resolveDailySpend (adSpendDailyRules.ts). ROAS and cost per order
//     compare spend with sales/orders on the SAME days only — the days whose spend is known — so a day
//     without a spend report never makes ROAS look better or worse.
import type { ShopifyOrder } from "./shopifyOrderRules.ts";
import type { ResolvedSpend } from "./adSpendDailyRules.ts";

export const PAID_SOURCES = ["google_ads", "meta_ads"] as const;
export type PaidSource = (typeof PAID_SOURCES)[number];
export const isPaidSource = (s: string): s is PaidSource => (PAID_SOURCES as readonly string[]).includes(s);

export interface SourceDay { date: string; orders: number; sales: number; spend: number | null }

export interface SourceDetail {
  source: string;
  orders: ShopifyOrder[];          // all of the source's orders in the range, newest first (cancelled included)
  netOrders: number;
  sales: number;
  aov: number;
  /** Paid sources only (null otherwise). */
  spend: ResolvedSpend | null;
  coveredNetOrders: number;
  coveredSales: number;
  roas: number | null;             // coveredSales ÷ spend
  costPerOrder: number | null;     // spend ÷ coveredNetOrders
  cpc: number | null;              // spend ÷ clicks (Google)
  daily: SourceDay[];
}

export function shopifySourceDetail(all: ShopifyOrder[], source: string, spend: ResolvedSpend | null, start: string, end: string): SourceDetail {
  const mine = all.filter((o) => (o.ad_channel || "unknown") === source && o.order_date >= start && o.order_date <= end);
  const live = mine.filter((o) => !o.is_cancelled);
  const sales = live.reduce((t, o) => t + o.total, 0);

  const spendByDay = new Map((spend?.days ?? []).map((d) => [d.date, d]));
  const coveredDays = new Set((spend?.days ?? []).filter((d) => d.source).map((d) => d.date));
  const covered = live.filter((o) => coveredDays.has(o.order_date));
  const coveredSales = covered.reduce((t, o) => t + o.total, 0);

  const daily: SourceDay[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  for (; d <= last && daily.length < 3700; d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    const day = live.filter((o) => o.order_date === date);
    const s = spendByDay.get(date);
    daily.push({ date, orders: day.length, sales: day.reduce((t, o) => t + o.total, 0), spend: s && s.source ? s.spend : null });
  }

  const paid = !!spend;
  return {
    source,
    orders: [...mine].sort((a, b) => b.order_created_at.localeCompare(a.order_created_at)),
    netOrders: live.length,
    sales,
    aov: live.length ? sales / live.length : 0,
    spend,
    coveredNetOrders: covered.length,
    coveredSales,
    roas: paid && spend!.spend > 0 ? coveredSales / spend!.spend : null,
    costPerOrder: paid && covered.length ? spend!.spend / covered.length : null,
    cpc: paid && spend!.clicks > 0 ? spend!.spend / spend!.clicks : null,
    daily,
  };
}
