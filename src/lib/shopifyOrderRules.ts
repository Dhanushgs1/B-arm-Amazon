// Shopify order rules for the dashboard (dependency-free so they can be unit tested): turning
// barm_shopify_orders_summary rows into orders, and the period totals.
//   - One entry per order_gid: a row repeated in the input (e.g. a re-sent webhook read twice) can
//     never count twice; test orders never reach here (the function leaves them out).
//   - Sales / Net Orders / AOV leave cancelled orders out; the order itself stays in the list.

export interface ShopifyOrderItem {
  title: string | null;
  variant_title: string | null;
  sku: string | null;
  quantity: number;
  refunded_quantity: number | null;
  price: number | null;
  line_total: number | null;
}

export interface ShopifyOrder {
  order_gid: string;
  order_name: string;
  order_number: number;
  order_date: string;
  order_created_at: string;
  financial_status: string | null;
  fulfillment_status: string | null;
  is_cancelled: boolean;
  cancel_reason: string | null;
  source_name: string | null;
  tags: string | null;
  currency: string | null;
  total: number;
  subtotal: number;
  tax: number;
  shipping: number;
  discounts: number;
  item_quantity: number;
  items: ShopifyOrderItem[];
  /** Where the visit that placed the order came from (barm_shopify_orders_summary.ad_channel):
   *  google_ads, meta_ads, google_organic, direct, other — or null when unknown. */
  ad_channel: string | null;
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** barm_shopify_orders_summary rows -> orders, one per order_gid (last row wins), oldest first. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapShopifyRpcRows(data: any[] | null | undefined): ShopifyOrder[] {
  const byGid = new Map<string, ShopifyOrder>();
  (data ?? []).forEach((r) => {
    if (!r.order_gid || !r.order_date) return;
    byGid.set(r.order_gid, {
      order_gid: r.order_gid,
      order_name: r.order_name ?? `#${r.order_number}`,
      order_number: num(r.order_number),
      order_date: String(r.order_date).slice(0, 10),
      order_created_at: r.order_created_at,
      financial_status: r.financial_status,
      fulfillment_status: r.fulfillment_status,
      is_cancelled: !!r.is_cancelled,
      cancel_reason: r.cancel_reason,
      source_name: r.source_name,
      tags: r.tags,
      currency: r.currency,
      total: num(r.order_total_price),
      subtotal: num(r.order_subtotal_price),
      tax: num(r.order_total_tax),
      shipping: num(r.order_total_shipping),
      discounts: num(r.order_total_discounts),
      item_quantity: num(r.item_quantity),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      items: (Array.isArray(r.items) ? r.items : []).map((i: any) => ({
        title: i.title ?? null,
        variant_title: i.variant_title ?? null,
        sku: i.sku ?? null,
        quantity: num(i.quantity),
        refunded_quantity: i.refunded_quantity == null ? null : num(i.refunded_quantity),
        price: i.price == null ? null : num(i.price),
        line_total: i.line_total == null ? null : num(i.line_total),
      })),
      ad_channel: r.ad_channel ?? null,
    });
  });
  return [...byGid.values()].sort((a, b) => a.order_created_at.localeCompare(b.order_created_at));
}

export interface ShopifyPeriodTotals {
  orders: number;
  cancelled: number;
  netOrders: number;
  sales: number;
  aov: number;
  units: number;
}

export function shopifyTotals(orders: ShopifyOrder[]): ShopifyPeriodTotals {
  const live = orders.filter((o) => !o.is_cancelled);
  const sales = live.reduce((t, o) => t + o.total, 0);
  return {
    orders: orders.length,
    cancelled: orders.length - live.length,
    netOrders: live.length,
    sales,
    aov: live.length ? sales / live.length : 0,
    units: live.reduce((t, o) => t + o.item_quantity, 0),
  };
}

// ---- Breakdowns for the Shopify tab. All of them leave cancelled orders out, like Sales. ----

export interface ShopifyProductRow {
  title: string;
  skus: string[];
  units: number;
  orders: number;
  /** Item value: the line totals (price × quantity − line discount), without shipping or tax, so the
   *  rows add up to less than order Sales. */
  itemSales: number;
  share: number;
}

/** Sales per product, by product name (two different products can share a placeholder SKU such as
 *  "B-DUMMY", so the SKU can't be the key). Units = quantity − refunded quantity. Highest first. */
export function shopifyProductSales(orders: ShopifyOrder[]): ShopifyProductRow[] {
  const rows = new Map<string, { title: string; skus: Set<string>; units: number; orders: Set<string>; itemSales: number }>();
  orders.filter((o) => !o.is_cancelled).forEach((o) =>
    o.items.forEach((i) => {
      const title = (i.title ?? "").trim() || i.sku || "Untitled product";
      const name = i.variant_title ? `${title} · ${i.variant_title}` : title;
      const r = rows.get(name) ?? { title: name, skus: new Set<string>(), units: 0, orders: new Set<string>(), itemSales: 0 };
      if (i.sku) r.skus.add(i.sku);
      r.units += Math.max(0, i.quantity - (i.refunded_quantity ?? 0));
      r.orders.add(o.order_gid);
      r.itemSales += i.line_total ?? (i.price ?? 0) * i.quantity;
      rows.set(name, r);
    }),
  );
  const total = [...rows.values()].reduce((t, r) => t + r.itemSales, 0);
  return [...rows.values()]
    .map((r) => ({ title: r.title, skus: [...r.skus].sort(), units: r.units, orders: r.orders.size, itemSales: r.itemSales, share: total ? r.itemSales / total : 0 }))
    .sort((a, b) => b.itemSales - a.itemSales || a.title.localeCompare(b.title));
}

export interface ShopifyDayRow {
  date: string;
  orders: number;
  netOrders: number;
  sales: number;
}

/** One row per calendar day from start to end (inclusive, IST order dates), zero-filled. */
export function shopifyDailySeries(orders: ShopifyOrder[], start: string, end: string): ShopifyDayRow[] {
  const days: ShopifyDayRow[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  for (; d <= last && days.length < 3700; d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    const t = shopifyTotals(orders.filter((o) => o.order_date === date));
    days.push({ date, orders: t.orders, netOrders: t.netOrders, sales: t.sales });
  }
  return days;
}

export interface ShopifySplitRow {
  key: string;
  label: string;
  orders: number;
  sales: number;
  share: number;
}

function splitBy(orders: ShopifyOrder[], keyOf: (o: ShopifyOrder) => string, labelOf: (k: string) => string, order: string[]): ShopifySplitRow[] {
  const live = orders.filter((o) => !o.is_cancelled);
  const total = live.reduce((t, o) => t + o.total, 0);
  const m = new Map<string, { orders: number; sales: number }>();
  live.forEach((o) => {
    const k = keyOf(o);
    const r = m.get(k) ?? { orders: 0, sales: 0 };
    r.orders += 1;
    r.sales += o.total;
    m.set(k, r);
  });
  const rank = (k: string) => (order.includes(k) ? order.indexOf(k) : order.length);
  return [...m.entries()]
    .map(([key, r]) => ({ key, label: labelOf(key), orders: r.orders, sales: r.sales, share: total ? r.sales / total : 0 }))
    .sort((a, b) => rank(a.key) - rank(b.key) || b.sales - a.sales);
}

const titleCase = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** Net orders by Shopify payment status. "Pending" is mostly cash on delivery not yet collected. */
export function shopifyPaymentSplit(orders: ShopifyOrder[]): ShopifySplitRow[] {
  return splitBy(orders, (o) => o.financial_status || "unknown", (k) => (k === "pending" ? "Pending (COD / unpaid)" : titleCase(k)),
    ["paid", "pending", "authorized", "partially_paid", "partially_refunded", "refunded", "voided", "unknown"]);
}

/** Net orders by fulfilment status (Shopify sends none for an unfulfilled order). */
export function shopifyFulfilmentSplit(orders: ShopifyOrder[]): ShopifySplitRow[] {
  return splitBy(orders, (o) => o.fulfillment_status || "unfulfilled", titleCase, ["fulfilled", "partial", "unfulfilled", "restocked"]);
}

export const SHOPIFY_SOURCE_LABELS: Record<string, string> = {
  google_ads: "Google Ads",
  meta_ads: "Meta Ads",
  google_organic: "Google (organic)",
  direct: "Direct",
  other: "Other",
  unknown: "Unknown",
};

/** Net orders by where the visit came from (ad_channel, from the order's landing / referring URL). */
export function shopifySourceSplit(orders: ShopifyOrder[]): ShopifySplitRow[] {
  return splitBy(orders, (o) => o.ad_channel || "unknown", (k) => SHOPIFY_SOURCE_LABELS[k] ?? titleCase(k),
    ["google_ads", "meta_ads", "google_organic", "direct", "other", "unknown"]);
}

