// Flipkart tab breakdowns (dependency-free so they can be unit tested). Same rules as the Flipkart
// "Sales, Orders & Returns" strip (fetchFlipkartOrderSummary in channelSummary.ts), so the totals here
// equal its Orders (units) and Gross Sales for the same dates:
//   - Skeleton rows (no order_item_id) never count.
//   - Units  = quantity of every row except status CANCEL…, by order date.
//   - Gross  = units × the SKU's selling price in barm_flipkart_listings (first listing row per SKU) —
//              a COMPUTED figure, the order report carries no prices; a SKU with no listing adds 0.
//   - Orders = distinct order_id.

export interface FlipkartBreakdownRow {
  order_item_id: string;
  order_id: string;
  order_date: string | null;
  order_item_status: string;
  sku: string;
  product_title: string;
  quantity: number | null;
  fulfilment_type: string;
}

export interface FlipkartListingRow {
  seller_sku_id?: unknown;
  selling_price?: unknown;
}

const isSkeleton = (r: FlipkartBreakdownRow) => !String(r.order_item_id ?? "").trim();
const isCancelled = (r: FlipkartBreakdownRow) => String(r.order_item_status || "").toUpperCase().startsWith("CANCEL");

/** SKU -> selling price, first listing row per SKU wins (same as the summary strip). */
export function flipkartPriceBySku(listings: FlipkartListingRow[]): Map<string, number> {
  const m = new Map<string, number>();
  listings.forEach((r) => {
    const sku = String(r.seller_sku_id || "").trim();
    const price = Number(r.selling_price) || 0;
    if (sku && price > 0 && !m.has(sku)) m.set(sku, price);
  });
  return m;
}

export interface FlipkartDayRow { date: string; units: number; gross: number }
export interface FlipkartProductRow { sku: string; title: string; units: number; orders: number; gross: number; share: number; priced: boolean }
export interface FlipkartSplitRow { key: string; label: string; units: number; gross: number; share: number; counted: boolean }

export interface FlipkartBreakdowns {
  totals: { units: number; gross: number; orders: number; cancelledUnits: number; unpricedUnits: number };
  daily: FlipkartDayRow[];
  products: FlipkartProductRow[];
  statuses: FlipkartSplitRow[];
  fulfilment: FlipkartSplitRow[];
}

const titleCase = (s: string) => s.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** Breakdowns for start..end (inclusive, by order date). */
export function flipkartBreakdowns(rows: FlipkartBreakdownRow[], listings: FlipkartListingRow[], start: string, end: string): FlipkartBreakdowns {
  const price = flipkartPriceBySku(listings);
  const inRange = rows.filter((r) => !isSkeleton(r) && r.order_date && r.order_date.slice(0, 10) >= start && r.order_date.slice(0, 10) <= end);
  const qty = (r: FlipkartBreakdownRow) => Number(r.quantity) || 0;
  const valueOf = (r: FlipkartBreakdownRow) => qty(r) * (price.get(String(r.sku || "").trim()) || 0);
  const live = inRange.filter((r) => !isCancelled(r));

  const totals = {
    units: live.reduce((t, r) => t + qty(r), 0),
    gross: live.reduce((t, r) => t + valueOf(r), 0),
    orders: new Set(live.map((r) => r.order_id).filter(Boolean)).size,
    cancelledUnits: inRange.filter(isCancelled).reduce((t, r) => t + qty(r), 0),
    unpricedUnits: live.filter((r) => !price.get(String(r.sku || "").trim())).reduce((t, r) => t + qty(r), 0),
  };

  const daily: FlipkartDayRow[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  for (; d <= last && daily.length < 3700; d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    const day = live.filter((r) => r.order_date!.slice(0, 10) === date);
    daily.push({ date, units: day.reduce((t, r) => t + qty(r), 0), gross: day.reduce((t, r) => t + valueOf(r), 0) });
  }

  const bySku = new Map<string, { title: string; units: number; orders: Set<string>; gross: number }>();
  live.forEach((r) => {
    const sku = String(r.sku || "").trim() || "(no SKU)";
    const p = bySku.get(sku) ?? { title: r.product_title || sku, units: 0, orders: new Set<string>(), gross: 0 };
    p.units += qty(r);
    if (r.order_id) p.orders.add(r.order_id);
    p.gross += valueOf(r);
    bySku.set(sku, p);
  });
  const products = [...bySku.entries()]
    .map(([sku, p]) => ({ sku, title: p.title, units: p.units, orders: p.orders.size, gross: p.gross, share: totals.gross ? p.gross / totals.gross : 0, priced: price.has(sku) }))
    .sort((a, b) => b.gross - a.gross || b.units - a.units || a.sku.localeCompare(b.sku));

  const allUnits = inRange.reduce((t, r) => t + qty(r), 0);
  const byStatus = new Map<string, { units: number; gross: number; counted: boolean }>();
  inRange.forEach((r) => {
    const key = (r.order_item_status || "UNKNOWN").trim().toUpperCase();
    const s = byStatus.get(key) ?? { units: 0, gross: 0, counted: !isCancelled(r) };
    s.units += qty(r);
    if (!isCancelled(r)) s.gross += valueOf(r);
    byStatus.set(key, s);
  });
  const statuses = [...byStatus.entries()]
    .map(([key, s]) => ({ key, label: titleCase(key), units: s.units, gross: s.gross, share: allUnits ? s.units / allUnits : 0, counted: s.counted }))
    .sort((a, b) => Number(b.counted) - Number(a.counted) || b.units - a.units);

  const byType = new Map<string, { units: number; gross: number }>();
  live.forEach((r) => {
    const key = (r.fulfilment_type || "UNKNOWN").trim().toUpperCase();
    const s = byType.get(key) ?? { units: 0, gross: 0 };
    s.units += qty(r);
    s.gross += valueOf(r);
    byType.set(key, s);
  });
  const fulfilment = [...byType.entries()]
    .map(([key, s]) => ({ key, label: key === "FBF" ? "Fulfilled by Flipkart (FBF)" : key === "NON_FBF" ? "Seller shipped (Non-FBF)" : titleCase(key), units: s.units, gross: s.gross, share: totals.units ? s.units / totals.units : 0, counted: true }))
    .sort((a, b) => b.units - a.units);

  return { totals, daily, products, statuses, fulfilment };
}
