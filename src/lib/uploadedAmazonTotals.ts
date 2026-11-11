import { supabasePublic } from "@/lib/supabasePublic";
import {
  summarizeUploadedAmazon,
  type UploadedAdRow,
  type UploadedAmazonTotals,
  type UploadedOrderRow,
  type UploadedSbRow,
  type UploadedSdRow,
} from "@/lib/uploadedAmazonRules";

export type { UploadedAmazonTotals } from "@/lib/uploadedAmazonRules";

// Amazon Overview figures read straight from the uploaded Supabase tables (not from SellerMate's
// live API), so the cards match what was uploaded and can say how far the data goes. The rules
// themselves (what counts as a sale, where ad spend and ad sales come from) are in
// uploadedAmazonRules.ts.
// PostgREST returns at most 1000 rows per request, so every table is read in pages.

const PAGE = 1000;

async function fetchAllRows<T>(
  table: string,
  columns: string,
  dateColumn: string,
  start: string,
  end: string,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    let rows: T[] | null = null;
    let lastError = "";
    // A transient failure (this project sees brief statement-timeout blips) gets two more tries.
    // If it still fails the whole read throws: a total built from some of the pages would be wrong
    // without looking wrong.
    for (let attempt = 0; attempt < 3 && rows === null; attempt++) {
      const { data, error } = await supabasePublic
        .from(table)
        .select(columns)
        .gte(dateColumn, start)
        .lte(dateColumn, end)
        // Paging is only stable with a unique sort. Without it Postgres may return rows in a
        // different order on each request, so pages past the first can repeat some rows and skip
        // others, and the totals come out wrong.
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (!error) rows = (data ?? []) as unknown as T[];
      else {
        lastError = error.message;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    if (rows === null) throw new Error(`${table}: ${lastError}`);
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function latestDate(table: string, column: string): Promise<string | null> {
  const { data, error } = await supabasePublic.from(table).select(column).order(column, { ascending: false }).limit(1);
  if (error) throw new Error(`${table}: ${error.message}`);
  const row = data?.[0] as unknown as Record<string, string> | undefined;
  return row?.[column] ?? null;
}

async function fetchUploadedRows(start: string, end: string) {
  const [orderRows, adRows, sbRows, sdRows] = await Promise.all([
    fetchAllRows<UploadedOrderRow>("barm_amazon_am_orders", "amazon_order_id,order_status,quantity,item_price", "purchase_date", start, end),
    fetchAllRows<UploadedAdRow>("barm_daily_am_ads", "spend,sales_7d", "report_date", start, end),
    fetchAllRows<UploadedSbRow>("barm_amazon_sb_campaign", "sales", "report_date", start, end),
    fetchAllRows<UploadedSdRow>("barm_amazon_sd_campaign", "sales_14d", "report_date", start, end),
  ]);
  return { orderRows, adRows, sbRows, sdRows };
}

export async function fetchUploadedAmazonTotals(start: string, end: string): Promise<UploadedAmazonTotals> {
  const [{ orderRows, adRows, sbRows, sdRows }, ordersThrough, adsThrough] = await Promise.all([
    fetchUploadedRows(start, end),
    latestDate("barm_amazon_am_orders", "purchase_date"),
    latestDate("barm_daily_am_ads", "report_date"),
  ]);
  return { ...summarizeUploadedAmazon(orderRows, adRows, sbRows, sdRows), ordersThrough, adsThrough };
}
