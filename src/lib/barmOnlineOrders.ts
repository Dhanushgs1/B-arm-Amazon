import { fetchAllRows } from "@/lib/amazonReportShared";
import { resolveProductName } from "@/lib/categoryMap";
import { sharedFetch } from "@/lib/sharedFetch";

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

export const BARM_ONLINE_ORDERS_TABLE = "barm_online_orders";

export interface BarmOnlineOrderLine {
  order_number: string;
  order_date: string;
  sku: string;
  name: string;
  quantity: number;
}

export interface BarmOnlineOrder {
  order_number: string;
  order_date: string;
  total: number;
  lines: BarmOnlineOrderLine[];
}

function parseOrderDate(v: unknown): string | null {
  const m = String(v ?? "").trim().match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return Number(mm) >= 1 && Number(mm) <= 12 ? `${yyyy}-${mm}-${dd}` : null;
}
const num = (v: unknown) => {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/** Every Received BARM website order, one entry per Order Number with its lines. */
export function fetchBarmOnlineOrders(): Promise<BarmOnlineOrder[]> {
  return sharedFetch(BARM_ONLINE_ORDERS_TABLE, loadBarmOnlineOrders);
}

async function loadBarmOnlineOrders(): Promise<BarmOnlineOrder[]> {
  const raw = await fetchAllRows(BARM_ONLINE_ORDERS_TABLE, (q) => q);
  // Same (order, SKU) loaded twice -> keep the latest load.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const latest = new Map<string, any>();
  raw.forEach((r) => {
    const key = `${String(r["Order Number"] ?? "").trim()}|${String(r["SKU"] ?? "").trim()}`;
    const prev = latest.get(key);
    if (!prev || String(r["created at"] ?? "") > String(prev["created at"] ?? "")) latest.set(key, r);
  });

  const orders = new Map<string, BarmOnlineOrder>();
  latest.forEach((r) => {
    const orderNumber = String(r["Order Number"] ?? "").trim();
    const date = parseOrderDate(r["Order Date"]);
    if (!orderNumber || !date) return;
    if (String(r["Order Status"] ?? "").trim().toLowerCase() !== "received") return;
    // The import shifted some columns: a cancellation can show up as "cancelled" in
    // "Order Total Tax Amount" while Order Status still says Received (orders 29221, 28706, 28722).
    if (String(r["Order Total Tax Amount"] ?? "").trim().toLowerCase() === "cancelled") return;
    // Same shift puts the delivery status in "COD Fee"; a returned order isn't a sale (order 29186).
    if (String(r["COD Fee"] ?? "").trim().toLowerCase() === "returned") return;
    const sku = String(r["SKU"] ?? "").trim();
    const itemName = String(r["Item Name"] ?? "").trim();
    let o = orders.get(orderNumber);
    if (!o) {
      o = { order_number: orderNumber, order_date: date, total: num(r["Order Total Amount"]), lines: [] };
      orders.set(orderNumber, o);
    }
    o.lines.push({
      order_number: orderNumber,
      order_date: date,
      sku,
      name: resolveProductName(itemName, sku) || itemName || sku || "(no product name)",
      quantity: num(r["Quantity"]) || 1,
    });
  });
  return [...orders.values()];
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
