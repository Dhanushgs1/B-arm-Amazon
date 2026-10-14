// High ACOS email across channels (user, 2026-10-12): Amazon, Flipkart and Meesho (B-ARM), read only
// from the uploaded ads reports — never SellerMate. All three come from the one "Last 7 days" combined
// workbook (combinedAdSpendUpload.ts):
//   Amazon   barm_amazon_sp_advertised_product  spend, sales_7d, orders_7d   per campaign
//   Flipkart barm_daily_fk_ads                  ad_spend, revenue, units_sold per campaign
//   Meesho   barm_daily_ms_barm_ads             spend, orders_by_ad          per SKU — no revenue column,
//            so sales ≈ orders × that SKU's average Meesho selling price (barm_daily_ms_barm_orders).
// Pure helpers only; src/pages/api/high-acos-report.ts does the reads.

import type { DayCampaignRow } from "./highAcosTrend.ts";

export type AcosChannelKey = "amazon" | "flipkart" | "meesho";

export const ACOS_CHANNELS: { key: AcosChannelKey; label: string; color: string; minSpend: number }[] = [
  { key: "amazon", label: "Amazon", color: "#c2410c", minSpend: 200 },
  { key: "flipkart", label: "Flipkart", color: "#1d4ed8", minSpend: 200 },
  // Meesho spends ~₹100 a day in total, so ₹200 over 7 days would hide every campaign.
  { key: "meesho", label: "Meesho (B-ARM)", color: "#be185d", minSpend: 50 },
];

/** One uploaded ads row reduced to what the trend needs. */
export interface ChannelAdRow {
  date: string;
  id: string;
  name: string;
  spend: number;
  sales: number;
  orders: number;
}

const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Sum rows into buildAcosTrend's per-day input (one entry per date, even when empty). */
export function toPerDay(rows: ChannelAdRow[], dates: string[]): { date: string; rows: DayCampaignRow[] }[] {
  return dates.map((date) => {
    const m = new Map<string, DayCampaignRow & { spend: number; sales: number; orders: number }>();
    for (const r of rows) {
      if (r.date !== date) continue;
      const c = m.get(r.id) ?? { campaignId: r.id, campaignName: r.name, spend: 0, sales: 0, orders: 0 };
      c.spend += r.spend;
      c.sales += r.sales;
      c.orders += r.orders;
      m.set(r.id, c);
    }
    return { date, rows: [...m.values()].filter((r) => r.spend > 0 || r.sales > 0) };
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = Record<string, any>;

export function amazonRows(raw: Raw[]): ChannelAdRow[] {
  return raw.filter((r) => r.campaign_name).map((r) => ({
    date: String(r.report_date), id: String(r.campaign_name), name: String(r.campaign_name),
    spend: n(r.spend), sales: n(r.sales_7d), orders: n(r.orders_7d),
  }));
}

export function flipkartRows(raw: Raw[]): ChannelAdRow[] {
  return raw.filter((r) => r.campaign_name || r.campaign_id).map((r) => ({
    date: String(r.report_date), id: String(r.campaign_id || r.campaign_name), name: String(r.campaign_name || r.campaign_id),
    spend: n(r.ad_spend), sales: n(r.revenue), orders: n(r.units_sold),
  }));
}

/** Average selling price per SKU from Meesho orders (discounted_price, the price the buyer paid). */
export function meeshoAvgPrice(orders: Raw[]): Map<string, number> {
  const acc = new Map<string, [number, number]>();
  for (const o of orders) {
    const p = n(o.discounted_price);
    if (!o.sku || p <= 0) continue;
    const a = acc.get(o.sku) ?? [0, 0];
    a[0] += p;
    a[1]++;
    acc.set(o.sku, a);
  }
  return new Map([...acc].map(([k, [sum, cnt]]) => [k, sum / cnt]));
}

/** Meesho campaign names are ids ("47727 - 5/22/2026"), so rows are per product: "Name (SKU)". */
export function meeshoRows(raw: Raw[], price: Map<string, number>): ChannelAdRow[] {
  return raw.filter((r) => r.sku).map((r) => ({
    date: String(r.report_date), id: String(r.sku), name: `${r.product_name || r.sku} (${r.sku})`,
    spend: n(r.spend), sales: n(r.orders_by_ad) * (price.get(r.sku) ?? 0), orders: n(r.orders_by_ad),
  }));
}
