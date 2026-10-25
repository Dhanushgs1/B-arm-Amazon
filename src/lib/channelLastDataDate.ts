import { supabasePublic } from "@/lib/amazonReportUpload";
import type { MarketplaceTab } from "@/lib/marketplace";
import { fetchMeeshoOrdersDataInfo } from "@/lib/meeshoBarmOrd";
import { fetchBarmOnlineOrdersDataInfo } from "@/lib/barmOnlineOrders";
import { fetchShopifyOrdersDataInfo } from "@/lib/shopifyOrders";
import { fetchAllMisReportDataInfo, fetchMisFkOrdersInfo, fetchMisFkReturnsInfo } from "@/lib/misAdapters";

// The last date that actually has data for a marketplace tab — the date-range picker's presets
// ("Last 14 Days" etc.) end here instead of today (the seller's instruction, 29 Sep 2026).
//   Meesho / BARM: that channel's own orders table.
//   Flipkart / Amazon: several sources that each stop on a different day, so the "major" date is
//   used — the latest date that most of the sources reach (see majorityDate).

/** Latest date that at least half of the sources reach: the sources' last dates, sorted newest
 *  first, taking the one at the halfway point. [28, 24, 20] -> 24; [24, 24, 20] -> 24. */
export function majorityDate(dates: (string | null | undefined)[]): string | null {
  const known = dates.filter((d): d is string => !!d).map((d) => d.slice(0, 10)).sort().reverse();
  if (!known.length) return null;
  return known[Math.ceil(known.length / 2) - 1];
}

async function maxDateOf(table: string, col: string): Promise<string | null> {
  const { data, error } = await supabasePublic.from(table).select(col).not(col, "is", null).order(col, { ascending: false }).limit(1);
  if (error) return null;
  const v = (data?.[0] as unknown as Record<string, unknown> | undefined)?.[col];
  return typeof v === "string" && v ? v.slice(0, 10) : null;
}

const settledMax = async (p: Promise<{ maxDate: string | null } | undefined>) => {
  try {
    return (await p)?.maxDate ?? null;
  } catch {
    return null;
  }
};

async function compute(tab: MarketplaceTab): Promise<string | null> {
  if (tab === "meesho") return settledMax(fetchMeeshoOrdersDataInfo());
  if (tab === "barm") return settledMax(fetchBarmOnlineOrdersDataInfo());
  if (tab === "shopify") return settledMax(fetchShopifyOrdersDataInfo());
  if (tab === "flipkart") {
    return majorityDate(
      await Promise.all([
        // Full read on purpose: fk_orders has no index on order_date, so an "ORDER BY order_date
        // DESC LIMIT 1" query hits the database's statement timeout.
        settledMax(fetchMisFkOrdersInfo()),
        settledMax(fetchMisFkReturnsInfo()),
        maxDateOf("barm_flipkart_fsn_report", "report_date"),
      ])
    );
  }
  if (tab === "amazon") {
    const [mis, spAds] = await Promise.all([
      fetchAllMisReportDataInfo().catch(() => ({} as Awaited<ReturnType<typeof fetchAllMisReportDataInfo>>)),
      maxDateOf("barm_amazon_sp_advertised_product", "report_date"),
    ]);
    return majorityDate([mis.am_orders?.maxDate, mis.am_returns?.maxDate, mis.fba_returns?.maxDate, mis.sf_return?.maxDate, spAds]);
  }
  if (tab === "compare") {
    // The Overall tab: the date most of the live marketplaces reach. The B-ARM Website tab is the
    // old WooCommerce history (ends 21 Sep 2026), so it would only drag this date back.
    const tabs: MarketplaceTab[] = ["amazon", "flipkart", "meesho", "shopify"];
    return majorityDate(await Promise.all(tabs.map((t) => fetchChannelLastDataDate(t))));
  }
  return null;
}

// Once per tab per page load — some of these read a whole table to find its last date.
const cache = new Map<MarketplaceTab, Promise<string | null>>();

export function fetchChannelLastDataDate(tab: MarketplaceTab): Promise<string | null> {
  let p = cache.get(tab);
  if (!p) {
    p = compute(tab).catch(() => null);
    cache.set(tab, p);
  }
  return p;
}
