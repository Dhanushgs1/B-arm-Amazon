import { supabasePublic } from "@/lib/amazonReportUpload";

// Amazon Overview totals read straight from the uploaded Supabase tables (not from SellerMate's
// live API), so the cards match what was uploaded and can say how far the data goes.
//   - Sales and units: barm_amazon_am_orders, non-cancelled lines. Non-standard "S02-" order ids
//     are excluded: they carry zero price and quantities in the hundreds (confirmed 1–25 Oct).
//   - Ad spend: barm_daily_am_ads.
//   - Ad sales: barm_daily_am_ads sales_7d + barm_amazon_sb_campaign sales + barm_amazon_sd_campaign
//     sales_14d (matches the Seller Central-side figure within about 0.3% for 1–29 Oct).
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
    const { data, error } = await supabasePublic
      .from(table)
      .select(columns)
      .gte(dateColumn, start)
      .lte(dateColumn, end)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as unknown as T[];
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

export interface UploadedAmazonTotals {
  totalSales: number;
  totalUnits: number;
  totalAdSpend: number;
  totalAdSales: number;
  organicSales: number;
  /** Last day with uploaded order lines. */
  ordersThrough: string | null;
  /** Last day with uploaded ad rows (daily ads). */
  adsThrough: string | null;
}

const STANDARD_ORDER_ID = /^\d{3}-/;

export async function fetchUploadedAmazonTotals(start: string, end: string): Promise<UploadedAmazonTotals> {
  const [orderRows, adRows, sbRows, sdRows, ordersThrough, adsThrough] = await Promise.all([
    fetchAllRows<{ amazon_order_id: string; order_status: string; quantity: number; item_price: number | string }>(
      "barm_amazon_am_orders",
      "amazon_order_id,order_status,quantity,item_price",
      "purchase_date",
      start,
      end,
    ),
    fetchAllRows<{ spend: number | string; sales_7d: number | string }>("barm_daily_am_ads", "spend,sales_7d", "report_date", start, end),
    fetchAllRows<{ sales: number | string }>("barm_amazon_sb_campaign", "sales", "report_date", start, end),
    fetchAllRows<{ sales_14d: number | string }>("barm_amazon_sd_campaign", "sales_14d", "report_date", start, end),
    latestDate("barm_amazon_am_orders", "purchase_date"),
    latestDate("barm_daily_am_ads", "report_date"),
  ]);

  let totalSales = 0;
  let totalUnits = 0;
  for (const r of orderRows) {
    if (/^cancel/i.test(r.order_status ?? "")) continue;
    if (!STANDARD_ORDER_ID.test(r.amazon_order_id ?? "")) continue;
    totalSales += Number(r.item_price) || 0;
    totalUnits += Number(r.quantity) || 0;
  }

  const totalAdSpend = adRows.reduce((sum, r) => sum + (Number(r.spend) || 0), 0);
  const totalAdSales =
    adRows.reduce((sum, r) => sum + (Number(r.sales_7d) || 0), 0) +
    sbRows.reduce((sum, r) => sum + (Number(r.sales) || 0), 0) +
    sdRows.reduce((sum, r) => sum + (Number(r.sales_14d) || 0), 0);

  return {
    totalSales,
    totalUnits,
    totalAdSpend,
    totalAdSales,
    organicSales: Math.max(0, totalSales - totalAdSales),
    ordersThrough,
    adsThrough,
  };
}
