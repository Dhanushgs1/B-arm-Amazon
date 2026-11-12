// Which loads the Overall page pre-load warms (pure, unit tested). See overallPreload.ts.

import { previousRange } from "../dateRanges.ts";

export const PRELOAD_PRESET_DAYS = [30, 7] as const;

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** First day of a "Last N Days" window ending on `end` — the same rule as DashboardContext's re-anchoring. */
export function presetStart(end: string, days: number): string {
  const d = new Date(`${end}T00:00:00`);
  d.setDate(d.getDate() - (days - 1));
  return iso(d);
}

/** The loader calls the Overall page makes for each preset window ending on `lastDate`
 *  (OverallDashboard.tsx and AllMarketplacesSummary.tsx: four sales summaries for the window,
 *  marketplace ads and Google/Meta spend from the start of the previous window), plus the
 *  Shopify order list. Must match those components, or the pre-load warms keys nobody reads. */
export function overallPreloadRequests(lastDate: string, presets: readonly number[] = PRELOAD_PRESET_DAYS): [string, string[]][] {
  const out: [string, string[]][] = [];
  for (const days of presets) {
    const start = presetStart(lastDate, days);
    const prevStart = previousRange(start, lastDate).start;
    for (const n of ["fetchAmazonSummary", "fetchFlipkartAllSummary", "fetchMeeshoSummary", "fetchShopifyAllSummary"]) out.push([n, [start, lastDate]]);
    for (const k of ["amazon", "flipkart", "meesho"]) out.push(["loadMarketplaceAds", [k, prevStart, lastDate]]);
    for (const k of ["google", "meta"]) out.push(["loadSpendWindows", [k, prevStart, lastDate]]);
  }
  out.push(["fetchShopifyOrders", []]);
  return out;
}
