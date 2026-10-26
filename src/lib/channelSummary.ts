import { fetchAllRows } from "@/lib/amazonReportShared";
import type { PeriodWindow } from "@/lib/amazonSkuPeriodData";
import type { WeeklySkuPeriodData } from "@/lib/weeklySalesExport";
import { loadMeeshoSkuPeriodData } from "@/lib/meeshoSkuPeriodData";
import { loadBarmSkuPeriodData } from "@/lib/barmSkuPeriodData";
import { fetchMisFkOrders, fetchMisFkReturns } from "@/lib/misAdapters";
import { isFkSkeletonOrderRow } from "@/lib/flipkartOrderRules";
import { DEFAULT_GST_MULTIPLIER } from "@/lib/masterProductSkuid";
import { supabasePublic } from "@/lib/amazonReportUpload";
import { spCampaignDays, isSplitCoveredCampaignRow } from "@/lib/amazonSpendRules";
import { dailyFallbackStart, dailyFkRowAsMis, dedupeOrderLines } from "@/lib/dailyOrderFallbackRules";

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
  /** Orders cancelled before shipping (every line cancelled); undefined = not tracked for this channel. */
  cancelledOrders?: number;
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

function summarize(data: WeeklySkuPeriodData & { cancelledOrdersByPeriod?: Map<string, Set<string>> }, label: string, basis: "total" | "gross" = "total"): PeriodSummary {
  const t = data.periodTotals.find((p) => p.label === label)!;
  // Distinct orders across all SKUs — an order holding two SKUs is one order, not two (same as the
  // weekly report's own order count).
  const orderIds = new Set<string>();
  let gross = 0;
  data.visibleRows.forEach((p) => {
    data.orderIdsBySkuPeriod.get(`${p.sku}|${label}`)?.forEach((id) => orderIds.add(id));
    gross += p.periods[label]?.grossSales || 0;
  });
  return {
    sales: basis === "gross" ? gross : t.totalSales,
    units: t.orders,
    orders: orderIds.size,
    allReturns: t.allReturns,
    customerReturns: t.customerReturns,
    netOrders: t.totalOrders,
    adSpendTax: null,
    // an order with any live line counts as an order, not a cancellation
    cancelledOrders: data.cancelledOrdersByPeriod
      ? [...(data.cancelledOrdersByPeriod.get(label) ?? [])].filter((id) => !orderIds.has(id)).length
      : undefined,
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
    // Gross, same as the weekly report's "Total Sales (Quantity × Supplier Listed Price)" column.
    current: { ...summarize(data, "current", "gross"), adSpendTax: spendIn(periods[1]) },
    previous: { ...summarize(data, "previous", "gross"), adSpendTax: spendIn(periods[0]) },
    currentRange: { start, end },
    previousRange: periods[0],
    dataThrough: data.dataThrough,
    // Gross: returns are not deducted — the same figure as the Meesho Weekly Sales Report's Total Sales column.
    salesLabel: "Gross Sales",
    note: "Gross Sales = Quantity × Supplier Listed Price, before returns (the Meesho Weekly Sales Report's 'Total Sales' column; its Net Sales column is after returns). Returns include courier RTO; Customer Returns excludes it. Ad Spend includes 18% GST.",
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
  const [misOrderRows, returnRows, listingRows, misMax] = await Promise.all([
    fetchMisFkOrders((q) => q.gte("order_date", periods[0].start).lte("order_date", end)),
    fetchMisFkReturns((q) => q.gte("return_requested_date", periods[0].start).lte("return_requested_date", end)).catch(() => []),
    fetchAllRows("barm_flipkart_listings", (q) => q).catch(() => []),
    supabasePublic.from("fk_orders").select("order_date").not("order_date", "is", null).order("order_date", { ascending: false }).limit(1),
  ]);
  // Days after the last fk_orders day come from the daily "Last 7 days" upload (see
  // dailyOrderFallbackRules.ts). If the MIS max can't be read, MIS alone is used, as before.
  let orderRows = misOrderRows;
  const fillFrom = misMax.error ? null : dailyFallbackStart((misMax.data?.[0] as { order_date?: string } | undefined)?.order_date ?? null, periods[0].start, end);
  if (fillFrom) {
    const daily = await fetchAllRows("barm_daily_fk_orders", (q) => q.gte("report_date", fillFrom).lte("report_date", end), ["report_date", "id"]).catch(() => []);
    const mapped = dedupeOrderLines(daily.map(dailyFkRowAsMis), (r) => r.order_item_status);
    orderRows = [...misOrderRows, ...(mapped as unknown as typeof misOrderRows)];
  }
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
    const cancelledIds = new Set<string>();
    let units = 0;
    let sales = 0;
    orderRows.forEach((r) => {
      if (!inP(r.order_date) || isFkSkeletonOrderRow(r)) return;
      if (String(r.order_item_status || "").toUpperCase().startsWith("CANCEL")) {
        if (r.order_id) cancelledIds.add(r.order_id);
        return;
      }
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
    const cancelledOrders = [...cancelledIds].filter((id) => !ids.has(id)).length;
    return { sales: priceBySku.size ? sales : null, units, orders: ids.size, allReturns, customerReturns, netOrders: units - allReturns, adSpendTax: null, cancelledOrders };
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

// ── "All" tab (/dashboard/compare) ──────────────────────────────────────────
// One row per marketplace on the SAME basis so they can be added up: Gross Sales = sales before
// returns (Amazon: order item prices; Flipkart: listing price × units; Meesho: Quantity × Supplier
// Listed Price; BARM: Order Total Amount once per order). Ad spend includes 18% GST.

async function spendTaxIn(table: string, col: string, start: string, end: string): Promise<number> {
  const rows = await fetchAllRows(table, (q) => q.gte("report_date", start).lte("report_date", end)).catch(() => []);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (rows as any[]).reduce((t, r) => t + (Number(r[col]) || 0), 0) * DEFAULT_GST_MULTIPLIER;
}

/** Amazon ad spend (with GST) the same way the Ad Spend Report counts it: every Sponsored Products
 *  row (which already carries the seller's per-SKU split of Brand/Display spend) plus each Sponsored
 *  Brands / Display campaign-day that has no such split, so nothing is counted twice. */
async function amazonSpendTaxIn(start: string, end: string): Promise<number> {
  const [sp, sb, sd] = await Promise.all(
    ["barm_amazon_sp_advertised_product", "barm_amazon_sb_campaign", "barm_amazon_sd_campaign"].map((t) =>
      fetchAllRows(t, (q) => q.gte("report_date", start).lte("report_date", end)).catch(() => [])
    )
  );
  const splitDays = spCampaignDays(sp);
  const sum = (rows: { spend?: unknown }[]) => rows.reduce((t, r) => t + (Number(r.spend) || 0), 0);
  return (sum(sp) + sum([...sb, ...sd].filter((r) => !isSplitCoveredCampaignRow(r, splitDays)))) * DEFAULT_GST_MULTIPLIER;
}

/** Amazon, from the same MIS tables and rules as the Amazon Weekly Sales Report — plus the daily
 *  upload for days the MIS orders table doesn't reach yet. */
export async function fetchAmazonSummary(start: string, end: string): Promise<ChannelSummary> {
  const periods = periodsFor(start, end);
  const { loadAmazonSkuPeriodData } = await import("@/lib/amazonSkuPeriodData");
  const [data, spendCur, spendPrev] = await Promise.all([
    loadAmazonSkuPeriodData({ periods, includeAds: false, includeStock: false, fillFromDailyUpload: true }),
    amazonSpendTaxIn(start, end),
    amazonSpendTaxIn(periods[0].start, periods[0].end),
  ]);
  const gross = (label: string) => data.visibleRows.reduce((t, p) => { const s = p.periods[label]; return t + (s ? s.price * s.orders : 0); }, 0);
  return {
    current: { ...summarize(data, "current"), sales: gross("current"), adSpendTax: spendCur },
    previous: { ...summarize(data, "previous"), sales: gross("previous"), adSpendTax: spendPrev },
    currentRange: { start, end },
    previousRange: periods[0],
    dataThrough: data.dataThrough,
    salesLabel: "Gross Sales",
    note: "Amazon: order item prices before returns; returns = AM + FBA + SellerFlex; ad spend = Sponsored Products + Brand/Display. Days the MIS orders table doesn't reach yet come from the daily \"Last 7 days\" upload.",
  };
}

export interface MarketplaceSummaryRow {
  id: "amazon" | "flipkart" | "meesho" | "barm";
  label: string;
  summary: ChannelSummary;
}

/** Flipkart for the All tab: the Overview's order summary plus FSN-report ad spend. */
export async function fetchFlipkartAllSummary(start: string, end: string): Promise<ChannelSummary> {
  const prev = previousRange(start, end);
  const [s, cur, before] = await Promise.all([
    fetchFlipkartOrderSummary(start, end),
    spendTaxIn("barm_flipkart_fsn_report", "ad_spend", start, end),
    spendTaxIn("barm_flipkart_fsn_report", "ad_spend", prev.start, prev.end),
  ]);
  return {
    ...s,
    current: { ...s.current, adSpendTax: cur },
    previous: { ...s.previous, adSpendTax: before },
    salesLabel: "Gross Sales",
    note: "Flipkart: listing price × units (computed); returns from the returns report; FSN ad spend. Days the MIS orders table doesn't reach yet come from the daily \"Last 7 days\" upload.",
  };
}
