import { fetchAllRows } from "@/lib/amazonReportShared";
import type { PeriodWindow } from "@/lib/amazonSkuPeriodData";
import type { WeeklySkuPeriodData } from "@/lib/weeklySalesExport";
import { loadMeeshoSkuPeriodData } from "@/lib/meeshoSkuPeriodData";
import { loadBarmSkuPeriodData } from "@/lib/barmSkuPeriodData";
import { fetchMisFkOrders, fetchMisFkReturns } from "@/lib/misAdapters";
import { isFkSkeletonOrderRow } from "@/lib/flipkartOrderRules";
import { DEFAULT_GST_MULTIPLIER } from "@/lib/masterProductSkuid";

// Short "this period vs the previous period" summary for the Meesho, BARM and Flipkart Overview
// pages, for the date range selected at the top of the dashboard. Meesho and BARM reuse the same
// per-SKU loaders as their Weekly Sales Reports, so the Overview and the report can't disagree.

export interface PeriodSummary {
  sales: number | null; // null = this channel has no sales figure here
  units: number;
  orders: number; // distinct orders
  allReturns: number;
  customerReturns: number;
  netOrders: number; // units − all returns
  adSpendTax: number | null;
}

export interface ChannelSummary {
  current: PeriodSummary;
  previous: PeriodSummary;
  currentRange: { start: string; end: string };
  previousRange: { start: string; end: string };
  dataThrough: string | null;
  note?: string;
  /** Label for the Sales card (default "Sales"). */
  salesLabel?: string;
  /** False when the channel's data has no returns at all — the Returns card then says "Not tracked" instead of 0. */
  returnsTracked?: boolean;
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The window of the same length immediately before [start, end]. */
export function previousRange(start: string, end: string): { start: string; end: string } {
  const s = new Date(`${start}T00:00:00`);
  const e = new Date(`${end}T00:00:00`);
  const days = Math.round((e.getTime() - s.getTime()) / 86_400_000) + 1;
  const pe = new Date(s); pe.setDate(s.getDate() - 1);
  const ps = new Date(s); ps.setDate(s.getDate() - days);
  return { start: iso(ps), end: iso(pe) };
}

function periodsFor(start: string, end: string): PeriodWindow[] {
  const prev = previousRange(start, end);
  return [
    { label: "previous", start: prev.start, end: prev.end },
    { label: "current", start, end },
  ];
}

function summarize(data: WeeklySkuPeriodData, label: string): PeriodSummary {
  const t = data.periodTotals.find((p) => p.label === label)!;
  let orders = 0;
  data.visibleRows.forEach((p) => { orders += data.orderCountOf(p.sku, label); });
  return {
    sales: t.totalSales,
    units: t.orders,
    orders,
    allReturns: t.allReturns,
    customerReturns: t.customerReturns,
    netOrders: t.totalOrders,
    adSpendTax: null,
  };
}

export async function fetchMeeshoSummary(start: string, end: string): Promise<ChannelSummary> {
  const periods = periodsFor(start, end);
  const [data, adRows] = await Promise.all([
    loadMeeshoSkuPeriodData({ periods }),
    fetchAllRows("barm_daily_ms_barm_ads", (q) => q.gte("report_date", periods[0].start).lte("report_date", end)).catch(() => []),
  ]);
  const spendIn = (p: PeriodWindow) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adRows as any[]).filter((r) => r.report_date >= p.start && r.report_date <= p.end).reduce((t, r) => t + (Number(r.spend) || 0), 0) * DEFAULT_GST_MULTIPLIER;
  return {
    current: { ...summarize(data, "current"), adSpendTax: spendIn(periods[1]) },
    previous: { ...summarize(data, "previous"), adSpendTax: spendIn(periods[0]) },
    currentRange: { start, end },
    previousRange: periods[0],
    dataThrough: data.dataThrough,
    // Gross: returns are not deducted — the same figure as the Meesho Weekly Sales Report's Total Sales column.
    salesLabel: "Gross Sales",
    note: "Gross Sales = Quantity × Supplier Listed Price, before returns (same as the Meesho Weekly Sales Report's Total Sales). Returns include courier RTO; Customer Returns excludes it. Ad Spend includes 18% GST.",
  };
}

export async function fetchBarmSummary(start: string, end: string): Promise<ChannelSummary> {
  const periods = periodsFor(start, end);
  const data = await loadBarmSkuPeriodData({ periods });
  return {
    current: summarize(data, "current"),
    previous: summarize(data, "previous"),
    currentRange: { start, end },
    previousRange: periods[0],
    dataThrough: data.dataThrough,
    returnsTracked: false,
    note: "Sales = Order Total Amount once per order (includes shipping). Returns are not tracked — barm_online_orders has no returns data, so Net Orders = Orders.",
  };
}

// Flipkart: same rules as the Flipkart Weekly Sales Report — units, cancelled and skeleton lines
// excluded, returns from the Returns report by Return Requested Date, and Sales = the listing
// price (barm_flipkart_listings) × units, a COMPUTED figure (the order report carries no prices).
export async function fetchFlipkartOrderSummary(start: string, end: string): Promise<ChannelSummary> {
  const periods = periodsFor(start, end);
  const [orderRows, returnRows, listingRows] = await Promise.all([
    fetchMisFkOrders((q) => q.gte("order_date", periods[0].start).lte("order_date", end)),
    fetchMisFkReturns((q) => q.gte("return_requested_date", periods[0].start).lte("return_requested_date", end)).catch(() => []),
    fetchAllRows("barm_flipkart_listings", (q) => q).catch(() => []),
  ]);
  const priceBySku = new Map<string, number>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (listingRows as any[]).forEach((r) => {
    const sku = String(r.seller_sku_id || "").trim();
    const price = Number(r.selling_price) || 0;
    if (sku && price > 0 && !priceBySku.has(sku)) priceBySku.set(sku, price);
  });
  const sum = (p: PeriodWindow): PeriodSummary => {
    const inP = (d: string | null | undefined) => !!d && d.slice(0, 10) >= p.start && d.slice(0, 10) <= p.end;
    const ids = new Set<string>();
    let units = 0;
    let sales = 0;
    orderRows.forEach((r) => {
      if (!inP(r.order_date) || isFkSkeletonOrderRow(r)) return;
      if (String(r.order_item_status || "").toUpperCase().startsWith("CANCEL")) return;
      const qty = Number(r.quantity) || 0;
      units += qty;
      sales += qty * (priceBySku.get(String(r.sku || "").trim()) || 0);
      if (r.order_id) ids.add(r.order_id);
    });
    let allReturns = 0;
    let customerReturns = 0;
    returnRows.forEach((r) => {
      if (!inP(r.return_requested_date)) return;
      const q = Number(r.quantity) || 0;
      allReturns += q;
      if (String(r.return_type || "").toLowerCase() === "customer_return") customerReturns += q;
    });
    return { sales: priceBySku.size ? sales : null, units, orders: ids.size, allReturns, customerReturns, netOrders: units - allReturns, adSpendTax: null };
  };
  const dates = orderRows.map((r) => r.order_date).filter((d): d is string => !!d).sort();
  return {
    current: sum(periods[1]),
    previous: sum(periods[0]),
    currentRange: { start, end },
    previousRange: periods[0],
    dataThrough: dates.length ? dates[dates.length - 1].slice(0, 10) : null,
    note: "From the Flipkart order and returns reports. Sales = listing price × units (computed, like the Flipkart Weekly Sales Report — not settled revenue). Returns include courier returns; Customer Returns excludes them.",
  };
}
