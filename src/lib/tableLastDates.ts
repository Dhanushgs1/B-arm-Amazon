// The last day of data on file for each table named in dataSources.ts, for the "where is this from"
// box. Each lookup reuses the reader the Upload page already uses for that table where one exists,
// so the box and the Upload page's "data on file" captions cannot disagree. A lookup is only run for
// the tables of the box that is open. A table with no date of its own (listings) has no entry.
//
// This is the last day the DATA reaches (latest order / report / invoice date), not the day the file
// was uploaded.

import { supabasePublic } from "@/lib/supabasePublic";
import { fetchAllMisReportDataInfo, fetchMisFkOrdersInfo, fetchMisFkReturnsInfo } from "@/lib/misAdapters";
import { fetchMeeshoOrdersDataInfo } from "@/lib/meeshoBarmOrd";
import { fetchShopifyOrdersDataInfo } from "@/lib/shopifyOrders";
import { fetchGoogleAdSpendDataInfo } from "@/lib/googleOrdersUpload";
import { fetchSocialMediaReportDataInfo } from "@/lib/socialMediaReportUpload";
import { fetchBarmOnlineOrdersDataInfo } from "@/lib/barmOnlineOrders";
import { misCoverage } from "@/lib/misInvoiceData";
import type { MisMarketplace } from "@/lib/misInvoiceRules";
import type { SourceChannel } from "@/lib/dataSources";

type Info = { maxDate: string | null; error?: string };

/** maxDate of an info result; a failed read throws, so the box shows nothing rather than a wrong date. */
const maxOf = (info: Info | undefined): string | null => {
  if (!info) return null;
  if (info.error) throw new Error(info.error);
  return info.maxDate;
};

/** Newest report_date in a table whose rows carry one (the daily uploads and the ads reports). */
const newestReportDate = (table: string) => async (): Promise<string | null> => {
  const { data, error } = await supabasePublic.from(table).select("report_date").not("report_date", "is", null).order("report_date", { ascending: false }).limit(1);
  if (error) throw new Error(`${table}: ${error.message}`);
  return (data?.[0] as { report_date?: string } | undefined)?.report_date?.slice(0, 10) ?? null;
};

const erpEnd = (m: MisMarketplace) => async () => (await misCoverage(m))?.end ?? null;

const LOOKUPS: Record<string, () => Promise<string | null>> = {
  "mis_datas_mv:amazon": erpEnd("Amazon"),
  "mis_datas_mv:flipkart": erpEnd("Flipkart"),
  "mis_datas_mv:meesho": erpEnd("Meesho"),
  amazon_orders: async () => maxOf((await fetchAllMisReportDataInfo()).am_orders),
  amazon_returns: async () => maxOf((await fetchAllMisReportDataInfo()).am_returns),
  amazon_fba_returns: async () => maxOf((await fetchAllMisReportDataInfo()).fba_returns),
  amazon_seller_flex_return: async () => maxOf((await fetchAllMisReportDataInfo()).sf_return),
  fk_orders: async () => maxOf(await fetchMisFkOrdersInfo()),
  fk_returns: async () => maxOf(await fetchMisFkReturnsInfo()),
  meesho_barm_ord: async () => maxOf(await fetchMeeshoOrdersDataInfo()),
  barm_shopify_orders_v2: async () => maxOf(await fetchShopifyOrdersDataInfo()),
  barm_daily_google_ad_spend: async () => maxOf(await fetchGoogleAdSpendDataInfo()),
  barm_daily_social_media: async () => maxOf(await fetchSocialMediaReportDataInfo()),
  barm_online_orders: async () => maxOf(await fetchBarmOnlineOrdersDataInfo()),
  ...Object.fromEntries([
    "barm_daily_am_orders", "barm_daily_fk_orders", "barm_daily_ms_barm_orders",
    "barm_daily_fk_ads", "barm_daily_ms_barm_ads", "barm_flipkart_campaign_performance",
    "barm_amazon_sp_advertised_product", "barm_amazon_sb_campaign", "barm_amazon_sd_campaign",
  ].map((t) => [t, newestReportDate(t)])),
};

/** The lookup key for a table in a part of the box; null when the table has no last-date lookup. */
export function lastDateKey(table: string, channel?: SourceChannel): string | null {
  const key = table === "mis_datas_mv" ? `${table}:${channel ?? ""}` : table;
  return key in LOOKUPS ? key : null;
}

/** Last day of data on file for a lookup key (yyyy-mm-dd), or null when the table is empty. */
export function fetchTableLastDate(key: string): Promise<string | null> {
  return LOOKUPS[key]();
}
