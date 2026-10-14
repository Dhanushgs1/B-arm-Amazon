// Reads for Godown Stock Analytics (src/lib/godownAnalytics.ts). Read-only, and no new source:
//   * the Consolidated Stock Sheet exactly as its page loads it (fetchConsolidated: current stock,
//     10-day restock numbers, the week's Monday Stock Purchase / Components snapshot);
//   * barm_godown_daily, the godown's daily movement the sheet is built from, up to the sheet's
//     latest godown day.

import { supabasePublic } from "@/lib/amazonReportUpload";
import { fetchConsolidated, type ConsolidatedData } from "@/lib/consolidatedStockUpload";
import type { GodownDailyRow } from "@/lib/godownAnalytics";

const PAGE = 1000;

/** Every barm_godown_daily row on or before `to`, pages fetched in parallel (PostgREST caps a response at 1000 rows). */
export async function readDaily(to: string): Promise<GodownDailyRow[]> {
  const base = () => supabasePublic.from("barm_godown_daily").select("stock_date,product,stock_out,closing", { count: "exact" }).lte("stock_date", to);
  const first = await base().order("stock_date").order("product").range(0, PAGE - 1);
  if (first.error) throw new Error(`barm_godown_daily: ${first.error.message}`);
  const total = first.count ?? first.data?.length ?? 0;
  const pages = Math.ceil(total / PAGE);
  const rest: NonNullable<typeof first.data>[] = [];
  for (let i = 1; i < pages; i += 8) { // 8 pages at a time (~190 pages once the full history is imported)
    rest.push(...await Promise.all(Array.from({ length: Math.min(8, pages - i) }, async (_, j) => {
      const { data, error } = await base().order("stock_date").order("product").range((i + j) * PAGE, (i + j + 1) * PAGE - 1);
      if (error) throw new Error(`barm_godown_daily: ${error.message}`);
      return data ?? [];
    })));
  }
  return [first.data ?? [], ...rest].flat().map((r) => ({
    date: r.stock_date as string,
    product: r.product as string,
    stockOut: Number(r.stock_out) || 0,
    closing: r.closing === null || r.closing === undefined ? null : Number(r.closing),
  }));
}

export interface GodownAnalyticsData {
  consolidated: ConsolidatedData;
  history: GodownDailyRow[];
  asOf: string | null; // the sheet's latest godown day
}

export async function fetchGodownAnalytics(asOfPicked?: string): Promise<GodownAnalyticsData> {
  const consolidated = await fetchConsolidated(asOfPicked);
  const asOf = consolidated.dates.length ? consolidated.dates[consolidated.dates.length - 1] : null;
  return { consolidated, history: asOf ? await readDaily(asOf) : [], asOf };
}
