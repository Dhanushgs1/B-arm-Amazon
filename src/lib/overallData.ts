// Readers for the Overall page's ads data. Same tables and row mapping as the High ACOS email
// (highAcosChannels.ts) and the Google & Meta page — uploaded reports only, never SellerMate.
//   Amazon   barm_amazon_sp_advertised_product   per day / campaign / SKU
//   Flipkart barm_daily_fk_ads                   per day / campaign
//   Meesho   barm_daily_ms_barm_ads              per day / SKU (sales estimated from its average price)
//   Google   barm_daily_google_ad_spend          report windows → resolveDailySpend
//   Meta     barm_daily_social_media             report windows → resolveDailySpend
import { fetchAllRows } from "@/lib/amazonReportShared";
import { amazonRows, flipkartRows, meeshoRows, meeshoAvgPrice, type ChannelAdRow } from "@/lib/highAcosChannels";
import type { AdSpendRow } from "@/lib/adSpendDailyRules";

const addDays = (iso: string, k: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + k);
  return d.toISOString().slice(0, 10);
};

export type MarketplaceAdKey = "amazon" | "flipkart" | "meesho";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const between = (start: string, end: string) => (q: any) => q.gte("report_date", start).lte("report_date", end);

export async function loadMarketplaceAds(key: MarketplaceAdKey, start: string, end: string): Promise<ChannelAdRow[]> {
  if (key === "amazon") return amazonRows(await fetchAllRows("barm_amazon_sp_advertised_product", between(start, end)));
  if (key === "flipkart") return flipkartRows(await fetchAllRows("barm_daily_fk_ads", between(start, end)));
  // Meesho prices: the last ~6 weeks of its own orders, as in the High ACOS email
  const [ads, orders] = await Promise.all([
    fetchAllRows("barm_daily_ms_barm_ads", between(start, end)),
    fetchAllRows("barm_daily_ms_barm_orders", between(addDays(end, -42), end)),
  ]);
  return meeshoRows(ads, meeshoAvgPrice(orders));
}

const WINDOW_TABLE = { google: "barm_daily_google_ad_spend", meta: "barm_daily_social_media" } as const;

/** Report windows touching start..end, plus a week either side so missing days can be worked out. */
export async function loadSpendWindows(source: keyof typeof WINDOW_TABLE, start: string, end: string): Promise<AdSpendRow[]> {
  return (await fetchAllRows(WINDOW_TABLE[source], (q) => q.lte("report_start", addDays(end, 6)).gte("report_end", addDays(start, -6)))) as AdSpendRow[];
}

