// Meesho tab breakdowns (dependency-free so they can be unit tested). Same rules as the Meesho
// summary strip / weekly report (meeshoSkuPeriodData.ts), so the totals here equal its Orders and
// Gross Sales for the same dates:
//   - Units  = quantity of every order row except status CANCEL…, by Order Date.
//   - Gross  = quantity × Supplier Listed Price; a row without a price uses the SKU's latest listed
//              price across all rows.
//   - Orders = distinct sub-orders, the trailing "_<n>" line suffix removed.
// Returns are not deducted here (they are dated by Return Created Date, not Order Date).

export interface MeeshoBreakdownRow {
  order_status: string;
  sub_order_no: string;
  order_date: string | null;
  customer_state: string;
  product_name: string;
  sku: string;
  quantity: number | null;
  supplier_listed_price: number | null;
}

const isCancelled = (r: MeeshoBreakdownRow) => r.order_status.toUpperCase().startsWith("CANCEL");
const orderId = (r: MeeshoBreakdownRow) => r.sub_order_no.replace(/_\d+$/, "");

/** Latest listed price per SKU (by order date), the weekly report's fallback for rows without a price. */
export function meeshoLatestPriceBySku(rows: MeeshoBreakdownRow[]): Map<string, number> {
  const latest = new Map<string, { date: string; price: number }>();
  rows.forEach((r) => {
    if (!r.sku) return;
    const price = Number(r.supplier_listed_price) || 0;
    const date = r.order_date || "";
    const prev = latest.get(r.sku);
    if (price > 0 && (!prev || date > prev.date)) latest.set(r.sku, { date, price });
  });
  return new Map([...latest].map(([sku, v]) => [sku, v.price]));
}

export interface MeeshoDayRow { date: string; units: number; gross: number }
export interface MeeshoProductRow { sku: string; name: string; units: number; orders: number; gross: number; share: number }
export interface MeeshoSplitRow { key: string; label: string; units: number; gross: number; share: number; counted: boolean }

export interface MeeshoBreakdowns {
  totals: { units: number; gross: number; orders: number; cancelledUnits: number };
  daily: MeeshoDayRow[];
  products: MeeshoProductRow[];
  statuses: MeeshoSplitRow[];
  states: MeeshoSplitRow[];
}

const titleCase = (s: string) => s.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** Breakdowns for start..end (inclusive). `allRows` is every loaded row (needed for the price fallback). */
export function meeshoBreakdowns(allRows: MeeshoBreakdownRow[], start: string, end: string): MeeshoBreakdowns {
  const price = meeshoLatestPriceBySku(allRows);
  const inRange = allRows.filter((r) => r.sku && r.order_date && r.order_date >= start && r.order_date <= end);
  const valueOf = (r: MeeshoBreakdownRow) => (Number(r.quantity) || 0) * (Number(r.supplier_listed_price) || price.get(r.sku) || 0);
  const live = inRange.filter((r) => !isCancelled(r));

  const totals = {
    units: live.reduce((t, r) => t + (Number(r.quantity) || 0), 0),
    gross: live.reduce((t, r) => t + valueOf(r), 0),
    orders: new Set(live.map(orderId)).size,
    cancelledUnits: inRange.filter(isCancelled).reduce((t, r) => t + (Number(r.quantity) || 0), 0),
  };

  const daily: MeeshoDayRow[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  for (; d <= last && daily.length < 3700; d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    const day = live.filter((r) => r.order_date === date);
    daily.push({ date, units: day.reduce((t, r) => t + (Number(r.quantity) || 0), 0), gross: day.reduce((t, r) => t + valueOf(r), 0) });
  }

  const bySku = new Map<string, { name: string; units: number; orders: Set<string>; gross: number }>();
  live.forEach((r) => {
    const p = bySku.get(r.sku) ?? { name: r.product_name || r.sku, units: 0, orders: new Set<string>(), gross: 0 };
    p.units += Number(r.quantity) || 0;
    p.orders.add(orderId(r));
    p.gross += valueOf(r);
    bySku.set(r.sku, p);
  });
  const products = [...bySku.entries()]
    .map(([sku, p]) => ({ sku, name: p.name, units: p.units, orders: p.orders.size, gross: p.gross, share: totals.gross ? p.gross / totals.gross : 0 }))
    .sort((a, b) => b.gross - a.gross || a.sku.localeCompare(b.sku));

  // Every status, cancelled included (shown, but marked as not counted in sales).
  const allUnits = inRange.reduce((t, r) => t + (Number(r.quantity) || 0), 0);
  const byStatus = new Map<string, { units: number; gross: number; counted: boolean }>();
  inRange.forEach((r) => {
    const key = (r.order_status || "Unknown").trim().toUpperCase();
    const s = byStatus.get(key) ?? { units: 0, gross: 0, counted: !isCancelled(r) };
    s.units += Number(r.quantity) || 0;
    if (!isCancelled(r)) s.gross += valueOf(r);
    byStatus.set(key, s);
  });
  const statuses = [...byStatus.entries()]
    .map(([key, s]) => ({ key, label: titleCase(key), units: s.units, gross: s.gross, share: allUnits ? s.units / allUnits : 0, counted: s.counted }))
    .sort((a, b) => Number(b.counted) - Number(a.counted) || b.units - a.units);

  const byState = new Map<string, { units: number; gross: number }>();
  live.forEach((r) => {
    const key = (r.customer_state || "Unknown").trim().toUpperCase();
    const s = byState.get(key) ?? { units: 0, gross: 0 };
    s.units += Number(r.quantity) || 0;
    s.gross += valueOf(r);
    byState.set(key, s);
  });
  const states = [...byState.entries()]
    .map(([key, s]) => ({ key, label: titleCase(key), units: s.units, gross: s.gross, share: totals.gross ? s.gross / totals.gross : 0, counted: true }))
    .sort((a, b) => b.gross - a.gross || a.label.localeCompare(b.label));

  return { totals, daily, products, statuses, states };
}
