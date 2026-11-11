// Pure aggregation rules for the Amazon Overview built from the UPLOADED tables (no network, no
// SellerMate). Kept apart from the fetching in uploadedAmazonTotals.ts so the rules can be tested.
//
//   - Sales and units: barm_amazon_am_orders, non-cancelled lines. Non-standard "S02-" order ids
//     are excluded: they carry zero price and quantities in the hundreds (confirmed 1–25 Oct).
//   - Ad spend: barm_daily_am_ads.
//   - Ad sales: barm_daily_am_ads sales_7d + barm_amazon_sb_campaign sales + barm_amazon_sd_campaign
//     sales_14d (matches the Seller Central-side figure within about 0.3% for 1–29 Oct).

export interface UploadedOrderRow {
  amazon_order_id: string | null;
  order_status: string | null;
  quantity: number | string | null;
  item_price: number | string | null;
  purchase_date?: string | null;
}
export interface UploadedAdRow {
  report_date?: string | null;
  campaign_name?: string | null;
  spend: number | string | null;
  sales_7d: number | string | null;
  orders_7d?: number | string | null;
  clicks?: number | string | null;
  impressions?: number | string | null;
}
export interface UploadedSbRow { report_date?: string | null; sales: number | string | null }
export interface UploadedSdRow { report_date?: string | null; sales_14d: number | string | null }

export interface UploadedAmazonTotals {
  totalSales: number;
  totalUnits: number;
  /** Non-cancelled order lines (Seller Central's "Total order items"). */
  totalOrderItems: number;
  totalAdSpend: number;
  totalAdSales: number;
  organicSales: number;
  /** Last day with uploaded order lines. */
  ordersThrough: string | null;
  /** Last day with uploaded ad rows (daily ads). */
  adsThrough: string | null;
}

/** A ratio that is undefined when its denominator is zero: null, never 0 and never a huge number. */
export function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}
/** Percentage form of ratio(): ACOS = pct(spend, adSales), TACOS = pct(spend, totalSales). */
export function pct(numerator: number, denominator: number): number | null {
  const r = ratio(numerator, denominator);
  return r === null ? null : r * 100;
}

const STANDARD_ORDER_ID = /^\d{3}-/;
const n = (v: unknown) => Number(v) || 0;

/** True for an order line that counts towards sales and units. */
export function isCountedOrderLine(r: UploadedOrderRow): boolean {
  if (/^cancel/i.test(r.order_status ?? "")) return false;
  return STANDARD_ORDER_ID.test(r.amazon_order_id ?? "");
}

export function summarizeUploadedAmazon(
  orderRows: UploadedOrderRow[],
  adRows: UploadedAdRow[],
  sbRows: UploadedSbRow[],
  sdRows: UploadedSdRow[],
): Omit<UploadedAmazonTotals, "ordersThrough" | "adsThrough"> {
  let totalSales = 0;
  let totalUnits = 0;
  let totalOrderItems = 0;
  for (const r of orderRows) {
    if (!isCountedOrderLine(r)) continue;
    totalSales += n(r.item_price);
    totalUnits += n(r.quantity);
    totalOrderItems += 1;
  }
  const totalAdSpend = adRows.reduce((sum, r) => sum + n(r.spend), 0);
  const totalAdSales =
    adRows.reduce((sum, r) => sum + n(r.sales_7d), 0) +
    sbRows.reduce((sum, r) => sum + n(r.sales), 0) +
    sdRows.reduce((sum, r) => sum + n(r.sales_14d), 0);
  return { totalSales, totalUnits, totalOrderItems, totalAdSpend, totalAdSales, organicSales: Math.max(0, totalSales - totalAdSales) };
}

// ── Ad rows as the Overall page reads them (overallData.loadMarketplaceAds → ChannelAdRow) ──────────
// The Amazon Overview uses the same rows, so the two pages cannot disagree on Amazon ad figures.

export interface AdRowLike {
  date: string;
  name: string;
  spend: number;
  sales: number;
  orders: number;
}

const inRange = (r: AdRowLike, start: string, end: string) => r.date.slice(0, 10) >= start && r.date.slice(0, 10) <= end;

/** Spend and ad sales in [start, end], and the last day in that window that has ad rows at all. */
export function adTotals(rows: AdRowLike[], start: string, end: string): { spend: number; sales: number; orders: number; through: string | null } {
  let spend = 0, sales = 0, orders = 0;
  let through: string | null = null;
  for (const r of rows) {
    if (!inRange(r, start, end)) continue;
    spend += r.spend; sales += r.sales; orders += r.orders;
    const d = r.date.slice(0, 10);
    if (through === null || d > through) through = d;
  }
  return { spend, sales, orders, through };
}

export interface AdDailyPoint {
  rawDate: string;
  /** Ad sales / spend that day, or null when no ad rows are on file for that day (a gap, not 0). */
  sales: number | null;
  spend: number | null;
  roas: number | null;
  acos: number | null;
}

/** One point per day in [start, end]. A day with nothing uploaded is null, never 0. */
export function adDailySeries(rows: AdRowLike[], start: string, end: string): AdDailyPoint[] {
  const spendDays = new Map<string, number>();
  const salesDays = new Map<string, number>();
  for (const r of rows) {
    if (!inRange(r, start, end)) continue;
    const d = r.date.slice(0, 10);
    spendDays.set(d, (spendDays.get(d) || 0) + r.spend);
    salesDays.set(d, (salesDays.get(d) || 0) + r.sales);
  }
  const out: AdDailyPoint[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) return out;
  const [y, m, d0] = start.split("-").map(Number);
  // Calendar arithmetic in UTC: stepping a day must not depend on the viewer's timezone.
  for (let t = Date.UTC(y, m - 1, d0), i = 0; i < 400; t += 86_400_000, i++) {
    const iso = new Date(t).toISOString().slice(0, 10);
    if (iso > end) break;
    const has = spendDays.has(iso);
    const spend = has ? spendDays.get(iso) || 0 : null;
    const sales = has ? salesDays.get(iso) || 0 : null;
    out.push({
      rawDate: iso, sales, spend,
      roas: spend !== null && sales !== null ? ratio(sales, spend) : null,
      acos: spend !== null && sales !== null ? pct(spend, sales) : null,
    });
  }
  return out;
}

export interface AdCampaignRow {
  name: string;
  spend: number;
  sales: number;
  orders: number;
  /** null when the campaign has no attributed sales (spend with no sales is not "0% ACOS"). */
  acos: number | null;
  roas: number | null;
}

/** Campaigns in [start, end], largest spend first. */
export function adCampaigns(rows: AdRowLike[], start: string, end: string): AdCampaignRow[] {
  const by = new Map<string, AdCampaignRow>();
  for (const r of rows) {
    if (!inRange(r, start, end)) continue;
    const name = String(r.name || "").trim() || "(no campaign name)";
    const c = by.get(name) || { name, spend: 0, sales: 0, orders: 0, acos: null, roas: null };
    c.spend += r.spend; c.sales += r.sales; c.orders += r.orders;
    by.set(name, c);
  }
  return [...by.values()]
    .map((c) => ({ ...c, acos: pct(c.spend, c.sales), roas: ratio(c.sales, c.spend) }))
    .sort((x, y2) => y2.spend - x.spend);
}
