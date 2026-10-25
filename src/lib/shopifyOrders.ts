import { supabasePublic } from "@/lib/amazonReportUpload";
import { sharedFetch } from "@/lib/sharedFetch";
import { previousRange, type ChannelSummary, type PeriodSummary } from "@/lib/channelSummary";
import { mapShopifyRpcRows, shopifyTotals, type ShopifyOrder, type ShopifyPeriodTotals } from "@/lib/shopifyOrderRules";

// Shopify (b-arm-gynecology) website orders for the Shopify tab. Orders arrive by signed Shopify
// webhooks (Edge Function shopify-orders-webhook) into barm_shopify_orders_v2, one row per line
// item. The anon key cannot read that table, so the dashboard reads the SECURITY DEFINER function
// barm_shopify_orders_summary (supabase/proposed/shopify_single_table/06_dashboard_orders_rpc.sql):
// one row per REAL order (Shopify test orders excluded), no customer details.
// Rules, agreed with the seller on 24 Oct 2026:
//   - Order date = the order's creation day in India time.
//   - Orders = every real order in the range; Net Orders = Orders − cancelled orders.
//   - Sales = order total (incl. tax and shipping) of the orders that are not cancelled.
//   - AOV = Sales ÷ Net Orders.
// v2 is unique on (order, line item), so a re-sent or orders/updated webhook updates the order in
// place instead of adding it twice; the function groups by order, and the list here is keyed by
// order_gid as well.

export const SHOPIFY_ORDERS_RPC = "barm_shopify_orders_summary";

export type { ShopifyOrder, ShopifyOrderItem, ShopifyPeriodTotals } from "@/lib/shopifyOrderRules";
export { shopifyTotals } from "@/lib/shopifyOrderRules";

async function loadShopifyOrders(): Promise<ShopifyOrder[]> {
  // GET: the function is read-only (STABLE), so no write request is ever sent.
  const { data, error } = await supabasePublic.rpc(SHOPIFY_ORDERS_RPC, {}, { get: true });
  if (error) throw new Error(`${SHOPIFY_ORDERS_RPC}: ${error.message}`);
  return mapShopifyRpcRows(data);
}

/** Every real Shopify order, oldest first. Shared for 60 s so the Overview's parts read it once;
 *  a new webhook order shows up on the next load after that. */
export function fetchShopifyOrders(): Promise<ShopifyOrder[]> {
  return sharedFetch(SHOPIFY_ORDERS_RPC, loadShopifyOrders);
}

export async function fetchShopifyOrdersInRange(start: string, end: string): Promise<ShopifyOrder[]> {
  return (await fetchShopifyOrders()).filter((o) => o.order_date >= start && o.order_date <= end);
}

export async function fetchShopifyOrdersDataInfo(): Promise<{ orderCount: number; minDate: string | null; maxDate: string | null; error?: string }> {
  try {
    const dates = (await fetchShopifyOrders()).map((o) => o.order_date).sort();
    return { orderCount: dates.length, minDate: dates[0] ?? null, maxDate: dates[dates.length - 1] ?? null };
  } catch (e) {
    return { orderCount: 0, minDate: null, maxDate: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface ShopifySummary {
  current: ShopifyPeriodTotals;
  previous: ShopifyPeriodTotals;
  currentRange: { start: string; end: string };
  previousRange: { start: string; end: string };
  dataThrough: string | null;
  orders: ShopifyOrder[];
}

/** Shopify for the Overall tab, in the same shape as every other marketplace row there: Gross Sales
 *  = order total of non-cancelled orders (the Shopify tab's Sales); Orders = units / distinct orders
 *  of those orders. Cancelled orders aren't sales, and Shopify returns aren't tracked yet, so
 *  Net Orders = units. Ad spend is not attributed to Shopify here (null = "No ads"), as for B-ARM. */
export async function fetchShopifyAllSummary(start: string, end: string): Promise<ChannelSummary> {
  const s = await fetchShopifySummary(start, end);
  const toPeriod = (t: ShopifyPeriodTotals): PeriodSummary => ({
    sales: t.sales,
    units: t.units,
    orders: t.netOrders,
    allReturns: 0,
    customerReturns: 0,
    netOrders: t.units,
    adSpendTax: null,
    cancelledOrders: t.cancelled,
  });
  return {
    current: toPeriod(s.current),
    previous: toPeriod(s.previous),
    currentRange: s.currentRange,
    previousRange: s.previousRange,
    dataThrough: s.dataThrough,
    salesLabel: "Gross Sales",
    returnsTracked: false,
    note: "Shopify: order total of non-cancelled orders (incl. tax and shipping); test orders never count.",
  };
}

/** The selected dates vs the same-length period before, plus the selected range's orders. */
export async function fetchShopifySummary(start: string, end: string): Promise<ShopifySummary> {
  const all = await fetchShopifyOrders();
  const prev = previousRange(start, end);
  const inRange = (s: string, e: string) => all.filter((o) => o.order_date >= s && o.order_date <= e);
  const current = inRange(start, end);
  return {
    current: shopifyTotals(current),
    previous: shopifyTotals(inRange(prev.start, prev.end)),
    currentRange: { start, end },
    previousRange: prev,
    dataThrough: all.length ? all[all.length - 1].order_date : null,
    orders: current,
  };
}
