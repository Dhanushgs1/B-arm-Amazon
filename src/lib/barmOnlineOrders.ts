import { fetchAllRows } from "@/lib/amazonReportShared";
import { resolveProductName } from "@/lib/categoryMap";
import { sharedFetch } from "@/lib/sharedFetch";
import { buildBarmOnlineOrders, type BarmOnlineOrder } from "@/lib/barmOnlineOrderRules";

// BARM (website) orders now come from the Supabase table barm_online_orders
// (filled outside this app), replacing the old BARM Upload page and its
// barm_daily_google_orders table — by the seller's instruction of 29 Sep 2026.
// Rules, confirmed by the seller:
//   - Only "Order Status" = Received counts (Failed / Cancel Request are
//     skipped, as are the few rows whose columns were shifted by commas in a
//     customer note — they have no parseable Order Date). Rows whose shifted
//     "Order Total Tax Amount" column says "cancelled", or whose shifted
//     "COD Fee" column (delivery status) says "RETURNED", are skipped too.
//   - The table has no per-product price, only "Order Total Amount" per order
//     (repeated on every line of that order). Sales = Order Total Amount,
//     counted ONCE per Order Number. A single-product order's total is that
//     product's sale; a multi-product order's total is reported against the
//     order as a whole, never split across its products.
//   - Order Date is "DD-MM-YYYY HH:MM:SS"; only the calendar day is used.
// The rules themselves live in barmOnlineOrderRules.ts (unit tested).

export const BARM_ONLINE_ORDERS_TABLE = "barm_online_orders";

export type { BarmOnlineOrder, BarmOnlineOrderLine } from "@/lib/barmOnlineOrderRules";

/** Every Received BARM website order, one entry per Order Number with its lines. */
export function fetchBarmOnlineOrders(): Promise<BarmOnlineOrder[]> {
  return sharedFetch(BARM_ONLINE_ORDERS_TABLE, loadBarmOnlineOrders);
}

async function loadBarmOnlineOrders(): Promise<BarmOnlineOrder[]> {
  return buildBarmOnlineOrders(await fetchAllRows(BARM_ONLINE_ORDERS_TABLE, (q) => q), resolveProductName);
}

/** Orders on file, for the BARM Overview/Download "Data on file" captions. Never rejects. */
export async function fetchBarmOnlineOrdersDataInfo(): Promise<{ orderCount: number; minDate: string | null; maxDate: string | null; error?: string }> {
  try {
    const dates = (await fetchBarmOnlineOrders()).map((o) => o.order_date).sort();
    return { orderCount: dates.length, minDate: dates[0] ?? null, maxDate: dates[dates.length - 1] ?? null };
  } catch (e) {
    return { orderCount: 0, minDate: null, maxDate: null, error: e instanceof Error ? e.message : String(e) };
  }
}
