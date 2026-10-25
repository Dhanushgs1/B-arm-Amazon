// Real Flipkart data layer — mirrors the table-resolution and aggregation
// logic in src/components/flipkart/App.jsx (the legacy "Flipkart Hub" mini-app)
// but exposed as plain fetch + aggregation functions so the Amazon-style
// marketplace pages can read genuine Supabase data instead of the deterministic
// demo data in src/lib/marketplace.ts.

import { fetchAllRows } from "@/lib/amazonReportShared";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

// Base name -> real Supabase table name, for the "Lkn" account. The "Barm"
// account instead gets a straight `barm_${baseName}` prefix (see
// getFlipkartTableName below) — same split as App.jsx's getTableName().
const LKN_TABLE_MAP: Record<string, string> = {
  flipkart_campaign_performance: "flipkart_campaign_performance_dash_360",
  flipkart_overall_sales: "flipkart_overall_sales_dash_360",
  flipkart_price_history: "flipkart_price_history_dashboard",
  flipkart_keyword_planner: "flipkart_keyword_planner_dashboard",
  flipkart_pnl_orders: "flipkart_pnl_orders_dashboard",
  flipkart_pnl_sku: "flipkart_pnl_sku_dashboard",
  flipkart_listings: "flipkart_listings_dashboard",
};

export function getFlipkartTableName(baseName: string, loggedInUser: string): string {
  if (loggedInUser === "Barm") return `barm_${baseName}`;
  return LKN_TABLE_MAP[baseName] || baseName;
}

async function fetchTableForRange(
  tableName: string,
  dateColumn: string,
  from: string,
  to: string
): Promise<any[]> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
  let results: any[] = [];
  let offset = 0;
  const limit = 1000;
  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/${tableName}?select=*&${dateColumn}=gte.${from}&${dateColumn}=lte.${to}&limit=${limit}&offset=${offset}`;
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) break;
      const data = await res.json();
      results = results.concat(data);
      if (data.length < limit) break;
      offset += limit;
    } catch {
      break;
    }
  }
  return results;
}

// Fetch an entire table (no date filter) — used for snapshot tables like
// listings, whose rows carry a single current stock/price state.
async function fetchTableAll(tableName: string, select = "*"): Promise<any[]> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
  let results: any[] = [];
  let offset = 0;
  const limit = 1000;
  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/${tableName}?select=${select}&limit=${limit}&offset=${offset}`;
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) break;
      const data = await res.json();
      results = results.concat(data);
      if (data.length < limit) break;
      offset += limit;
    } catch {
      break;
    }
  }
  return results;
}

// Min/max of a date column, so a page can tell the user which window actually
// has data (e.g. P&L order-level rows only cover the uploaded periods).
async function fetchDateBounds(tableName: string, dateColumn: string): Promise<{ min: string | null; max: string | null }> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return { min: null, max: null };
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
  try {
    const maxRes = await fetch(`${SUPABASE_URL}/rest/v1/${tableName}?select=${dateColumn}&order=${dateColumn}.desc&limit=1`, { headers });
    const minRes = await fetch(`${SUPABASE_URL}/rest/v1/${tableName}?select=${dateColumn}&order=${dateColumn}.asc&limit=1`, { headers });
    const maxData = maxRes.ok ? await maxRes.json() : [];
    const minData = minRes.ok ? await minRes.json() : [];
    return { min: minData[0]?.[dateColumn] ?? null, max: maxData[0]?.[dateColumn] ?? null };
  } catch {
    return { min: null, max: null };
  }
}

function getPreviousPeriod(fromStr: string, toStr: string) {
  const from = new Date(fromStr);
  const to = new Date(toStr);
  const diffDays = Math.ceil(Math.abs(to.getTime() - from.getTime()) / 86400000) + 1;
  const prevTo = new Date(from);
  prevTo.setDate(from.getDate() - 1);
  const prevFrom = new Date(from);
  prevFrom.setDate(from.getDate() - diffDays);
  const fmt = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };
  return { from: fmt(prevFrom), to: fmt(prevTo) };
}

// Ad-side aggregation — mirrors App.jsx's getAggregatedSummary()
function aggregateAdRows(rows: any[]) {
  let spend = 0, sales = 0, orders = 0, impressions = 0, clicks = 0;
  rows.forEach((row) => {
    spend += Number(row.ad_spend || 0);
    sales += Number(row.total_revenue_rs || 0);
    orders += Number(row.direct_units || 0) + Number(row.indirect_units || 0);
    impressions += Number(row.impressions || 0);
    clicks += Number(row.clicks || 0);
  });
  const roas = spend > 0 ? sales / spend : 0;
  const acos = sales > 0 ? (spend / sales) * 100 : 0;
  const cpc = clicks > 0 ? spend / clicks : 0;
  const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
  return { spend, sales, roas, acos, orders, impressions, clicks, cpc, ctr };
}

// Overall-sales aggregation — mirrors App.jsx's calcOverall()
function aggregateOverallRows(rows: any[]) {
  return rows.reduce(
    (acc, row) => {
      const sales = Number(row.final_sale_amount) || Number(row.gmv) || 0;
      const units = Number(row.final_sale_units) || Number(row.gross_units) || 0;
      acc.sales += sales;
      acc.units += units;
      acc.cancels += Number(row.cancellation_units) || 0;
      acc.returns += Number(row.return_units) || 0;
      return acc;
    },
    { sales: 0, units: 0, cancels: 0, returns: 0 }
  );
}

export interface FlipkartTopProduct {
  name: string;
  sku: string;
  units: number;
  sales: number;
}

export interface FlipkartTopCampaign {
  name: string;
  spend: number;
  sales: number;
  roas: number;
}

export interface FlipkartOverview {
  grossSales: number;
  netSales: number;
  units: number;
  cancelUnits: number;
  cancelAmount: number;
  returnUnits: number;
  returnAmount: number;
  adSpend: number;
  adSales: number;
  organicSales: number;
  roas: number;
  acos: number;
  tacos: number;
  ctr: number;
  cpc: number;
  cvr: number;
  adOrders: number;
  clicks: number;
  impressions: number;
  growthPct: number | null; // gross sales vs previous period, same length; null when neither period has overall_sales data to compare
  trend: { date: string; rawDate: string; overallSales: number; sales: number; spend: number; roas: number; acos: number }[];
  topProducts: FlipkartTopProduct[];
  topCampaigns: FlipkartTopCampaign[];
  // True once at least one barm_flipkart_overall_sales row exists for this period — lets the UI
  // distinguish "genuinely zero retail sales" from "no Earn More report uploaded yet" (order_report
  // alone never populates this table, since Flipkart's order export carries no monetary columns).
  hasOverallSalesData: boolean;
}

function dayLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", { month: "short", day: "numeric" });
}

export async function fetchFlipkartOverview(
  loggedInUser: string,
  startDate: string,
  endDate: string
): Promise<FlipkartOverview> {
  const cpTable = getFlipkartTableName("flipkart_campaign_performance", loggedInUser);
  const osTable = getFlipkartTableName("flipkart_overall_sales", loggedInUser);
  const prevPeriod = getPreviousPeriod(startDate, endDate);

  const [cpCurrent, cpPrev, osCurrent, osPrev] = await Promise.all([
    fetchTableForRange(cpTable, "report_date", startDate, endDate),
    fetchTableForRange(cpTable, "report_date", prevPeriod.from, prevPeriod.to),
    fetchTableForRange(osTable, "order_date", startDate, endDate),
    fetchTableForRange(osTable, "order_date", prevPeriod.from, prevPeriod.to),
  ]);

  const ad = aggregateAdRows(cpCurrent);
  const ov = aggregateOverallRows(osCurrent);
  const ovPrev = aggregateOverallRows(osPrev);

  const avgPrice = ov.units > 0 ? ov.sales / ov.units : 0;
  const grossSales = ov.sales;
  const netSales = ov.sales - (ov.cancels + ov.returns) * avgPrice;
  const organicSales = Math.max(0, grossSales - ad.sales);
  const tacos = grossSales > 0 ? (ad.spend / grossSales) * 100 : 0;
  const cvr = ad.clicks > 0 ? (ad.orders / ad.clicks) * 100 : 0;
  // Gross sales vs the SAME metric last period — was previously (and wrongly)
  // comparing this period's retail sales against last period's AD sales,
  // which is mathematically unrelated and always read ~-100% whenever
  // overall_sales had no rows. null (not 0 or a fabricated %) when neither
  // period has overall_sales data, so the UI can say "no data" instead of
  // showing a number that looks measured but isn't.
  const hasOverallSalesData = osCurrent.length > 0 || osPrev.length > 0;
  const growthPct = ovPrev.sales > 0 ? ((grossSales - ovPrev.sales) / ovPrev.sales) * 100 : hasOverallSalesData ? 0 : null;

  // Daily trend: merge campaign_performance (ad sales/spend) with overall_sales (gross) by date
  const dailyMap: Record<string, { overallSales: number; sales: number; spend: number }> = {};
  osCurrent.forEach((row: any) => {
    const d = row.order_date;
    if (!d) return;
    if (!dailyMap[d]) dailyMap[d] = { overallSales: 0, sales: 0, spend: 0 };
    dailyMap[d].overallSales += Number(row.final_sale_amount) || Number(row.gmv) || 0;
  });
  cpCurrent.forEach((row: any) => {
    const d = row.report_date;
    if (!d) return;
    if (!dailyMap[d]) dailyMap[d] = { overallSales: 0, sales: 0, spend: 0 };
    dailyMap[d].sales += Number(row.total_revenue_rs || 0);
    dailyMap[d].spend += Number(row.ad_spend || 0);
  });
  const trend = Object.entries(dailyMap)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([rawDate, v]) => ({
      rawDate,
      date: dayLabel(rawDate),
      overallSales: Math.round(v.overallSales),
      sales: Math.round(v.sales),
      spend: Math.round(v.spend),
      roas: v.spend > 0 ? Math.round((v.sales / v.spend) * 100) / 100 : 0,
      acos: v.sales > 0 ? Math.round((v.spend / v.sales) * 1000) / 10 : 0,
    }));

  // Top products from overall_sales, grouped by product
  const productMap: Record<string, FlipkartTopProduct> = {};
  osCurrent.forEach((row: any) => {
    const name = row.product_title || row.product_name || row.sku_id || "Product";
    const key = row.sku_id || name;
    if (!productMap[key]) productMap[key] = { name, sku: row.sku_id || "", units: 0, sales: 0 };
    productMap[key].units += Number(row.final_sale_units) || Number(row.gross_units) || 0;
    productMap[key].sales += Number(row.final_sale_amount) || Number(row.gmv) || 0;
  });
  const topProducts = Object.values(productMap)
    .sort((a, b) => b.sales - a.sales)
    .slice(0, 5);

  // Top campaigns from campaign_performance, grouped by campaign
  const campaignMap: Record<string, FlipkartTopCampaign> = {};
  cpCurrent.forEach((row: any) => {
    const name = row.campaign_name;
    if (!name) return;
    if (!campaignMap[name]) campaignMap[name] = { name, spend: 0, sales: 0, roas: 0 };
    campaignMap[name].spend += Number(row.ad_spend || 0);
    campaignMap[name].sales += Number(row.total_revenue_rs || 0);
  });
  const topCampaigns = Object.values(campaignMap)
    .map((c) => ({ ...c, roas: c.spend > 0 ? c.sales / c.spend : 0 }))
    .sort((a, b) => b.sales - a.sales)
    .slice(0, 5);

  return {
    grossSales,
    netSales,
    units: ov.units,
    cancelUnits: ov.cancels,
    cancelAmount: ov.cancels * avgPrice,
    returnUnits: ov.returns,
    returnAmount: ov.returns * avgPrice,
    adSpend: ad.spend,
    adSales: ad.sales,
    organicSales,
    roas: ad.roas,
    acos: ad.acos,
    tacos,
    ctr: ad.ctr,
    cpc: ad.cpc,
    cvr,
    adOrders: ad.orders,
    clicks: ad.clicks,
    impressions: ad.impressions,
    growthPct,
    trend,
    topProducts,
    topCampaigns,
    hasOverallSalesData,
  };
}

// ---------------------------------------------------------------------------
// SALES page — daily sales/units trend + full per-product breakdown
// ---------------------------------------------------------------------------

export interface FlipkartSalesData {
  totalSales: number;
  totalUnits: number;
  avgOrderValue: number;
  growthPct: number;
  bestDay: { date: string; sales: number } | null;
  trend: { rawDate: string; date: string; sales: number; units: number }[];
  products: { name: string; sku: string; units: number; sales: number }[];
}

export async function fetchFlipkartSales(
  loggedInUser: string,
  startDate: string,
  endDate: string
): Promise<FlipkartSalesData> {
  const osTable = getFlipkartTableName("flipkart_overall_sales", loggedInUser);
  const prevPeriod = getPreviousPeriod(startDate, endDate);

  const [osCurrent, osPrev] = await Promise.all([
    fetchTableForRange(osTable, "order_date", startDate, endDate),
    fetchTableForRange(osTable, "order_date", prevPeriod.from, prevPeriod.to),
  ]);

  const ov = aggregateOverallRows(osCurrent);
  const ovPrev = aggregateOverallRows(osPrev);
  const growthPct = ovPrev.sales > 0 ? ((ov.sales - ovPrev.sales) / ovPrev.sales) * 100 : 0;

  const dailyMap: Record<string, { sales: number; units: number }> = {};
  osCurrent.forEach((row: any) => {
    const d = row.order_date;
    if (!d) return;
    if (!dailyMap[d]) dailyMap[d] = { sales: 0, units: 0 };
    dailyMap[d].sales += Number(row.final_sale_amount) || Number(row.gmv) || 0;
    dailyMap[d].units += Number(row.final_sale_units) || Number(row.gross_units) || 0;
  });
  const trend = Object.entries(dailyMap)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([rawDate, v]) => ({ rawDate, date: dayLabel(rawDate), sales: Math.round(v.sales), units: Math.round(v.units) }));

  const bestDay = trend.length ? [...trend].sort((a, b) => b.sales - a.sales)[0] : null;

  const productMap: Record<string, { name: string; sku: string; units: number; sales: number }> = {};
  osCurrent.forEach((row: any) => {
    const name = row.product_title || row.product_name || row.sku_id || "Product";
    const key = row.sku_id || name;
    if (!productMap[key]) productMap[key] = { name, sku: row.sku_id || "", units: 0, sales: 0 };
    productMap[key].units += Number(row.final_sale_units) || Number(row.gross_units) || 0;
    productMap[key].sales += Number(row.final_sale_amount) || Number(row.gmv) || 0;
  });
  const products = Object.values(productMap).sort((a, b) => b.sales - a.sales);

  return {
    totalSales: ov.sales,
    totalUnits: ov.units,
    avgOrderValue: ov.units > 0 ? ov.sales / ov.units : 0,
    growthPct,
    bestDay: bestDay ? { date: bestDay.date, sales: bestDay.sales } : null,
    trend,
    products,
  };
}

// ---------------------------------------------------------------------------
// PRODUCTS page — per-SKU sales joined with the current listings snapshot
// (stock, price, status).
// ---------------------------------------------------------------------------

export interface FlipkartProductRow {
  name: string;
  sku: string;
  units: number;
  sales: number;
  stock: number;
  status: string;
  price: number;
  mrp: number;
}

export interface FlipkartProductsData {
  rows: FlipkartProductRow[];
  totalSales: number;
  catalogCount: number;
  soldCount: number;
}

export async function fetchFlipkartProducts(
  loggedInUser: string,
  startDate: string,
  endDate: string
): Promise<FlipkartProductsData> {
  const osTable = getFlipkartTableName("flipkart_overall_sales", loggedInUser);
  const listingsTable = getFlipkartTableName("flipkart_listings", loggedInUser);

  const [osCurrent, listings] = await Promise.all([
    fetchTableForRange(osTable, "order_date", startDate, endDate),
    fetchTableAll(listingsTable, "seller_sku_id,product_title,selling_price,mrp,stock_count,listing_status"),
  ]);

  // Index listings by seller_sku_id for stock/price join.
  const listingBySku: Record<string, any> = {};
  listings.forEach((l: any) => {
    if (l.seller_sku_id) listingBySku[String(l.seller_sku_id).toLowerCase()] = l;
  });

  const productMap: Record<string, FlipkartProductRow> = {};
  osCurrent.forEach((row: any) => {
    const sku = row.sku_id || row.seller_sku_id || "";
    const name = row.product_title || row.product_name || sku || "Product";
    const key = sku || name;
    if (!productMap[key]) {
      const listing = listingBySku[String(sku).toLowerCase()];
      productMap[key] = {
        name,
        sku,
        units: 0,
        sales: 0,
        stock: listing ? Number(listing.stock_count) || 0 : 0,
        status: listing?.listing_status || "—",
        price: listing ? Number(listing.selling_price) || 0 : 0,
        mrp: listing ? Number(listing.mrp) || 0 : 0,
      };
    }
    productMap[key].units += Number(row.final_sale_units) || Number(row.gross_units) || 0;
    productMap[key].sales += Number(row.final_sale_amount) || Number(row.gmv) || 0;
  });

  const rows = Object.values(productMap).sort((a, b) => b.sales - a.sales);
  return {
    rows,
    totalSales: rows.reduce((s, r) => s + r.sales, 0),
    catalogCount: listings.length,
    soldCount: rows.length,
  };
}

// ---------------------------------------------------------------------------
// CAMPAIGNS page — per-campaign ad performance aggregated over the range.
// campaign_performance has no status column, so status is derived from whether
// the campaign spent anything in the window (ACTIVE) or not (IDLE).
// ---------------------------------------------------------------------------

export interface FlipkartCampaignRow {
  id: string;
  name: string;
  type: string;
  status: "ACTIVE" | "IDLE";
  spend: number;
  sales: number;
  orders: number;
  clicks: number;
  impressions: number;
  acos: number;
  roas: number;
  ctr: number;
}

export interface FlipkartCampaignsData {
  rows: FlipkartCampaignRow[];
  totalSpend: number;
  totalSales: number;
  totalOrders: number;
  overallRoas: number;
}

function inferCampaignType(name: string): string {
  const n = (name || "").toLowerCase();
  if (n.startsWith("pla")) return "PLA";
  if (n.startsWith("pca")) return "PCA";
  if (n.includes("sksy") || n.includes("roi")) return "Smart ROI";
  if (n.includes("brand")) return "Brand Ads";
  return "Sponsored";
}

export async function fetchFlipkartCampaigns(
  loggedInUser: string,
  startDate: string,
  endDate: string
): Promise<FlipkartCampaignsData> {
  // B-ARM: the daily ads upload (barm_flipkart_fsn_report, one row per day / campaign / ad group / SKU).
  // barm_flipkart_campaign_performance stopped on 10 Sep 2026, so the page showed no campaigns.
  const rows_raw = loggedInUser === "Barm"
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? (await fetchAllRows("barm_flipkart_fsn_report", (q) => q.gte("report_date", startDate).lte("report_date", endDate))).map((r: any) => ({
        campaign_name: r.campaign_name || r.campaign_id,
        ad_spend: r.ad_spend,
        total_revenue_rs: r.total_revenue,
        total_orders: (Number(r.direct_units_sold) || 0) + (Number(r.indirect_units_sold) || 0),
        clicks: r.clicks,
        impressions: r.views,
      }))
    : await fetchTableForRange(getFlipkartTableName("flipkart_campaign_performance", loggedInUser), "report_date", startDate, endDate);

  const map: Record<string, FlipkartCampaignRow> = {};
  rows_raw.forEach((row: any) => {
    const name = row.campaign_name;
    if (!name) return;
    if (!map[name]) {
      map[name] = {
        id: name,
        name,
        type: row.campaign_type || inferCampaignType(name),
        status: "IDLE",
        spend: 0,
        sales: 0,
        orders: 0,
        clicks: 0,
        impressions: 0,
        acos: 0,
        roas: 0,
        ctr: 0,
      };
    }
    map[name].spend += Number(row.ad_spend || 0);
    map[name].sales += Number(row.total_revenue_rs || 0);
    map[name].orders += Number(row.total_orders || 0);
    map[name].clicks += Number(row.clicks || 0);
    map[name].impressions += Number(row.impressions || 0);
  });

  const rows = Object.values(map).map((c) => {
    c.roas = c.spend > 0 ? c.sales / c.spend : 0;
    c.acos = c.sales > 0 ? (c.spend / c.sales) * 100 : 0;
    c.ctr = c.impressions > 0 ? (c.clicks / c.impressions) * 100 : 0;
    c.status = c.spend > 0 ? "ACTIVE" : "IDLE";
    return c;
  }).sort((a, b) => b.spend - a.spend);

  const totalSpend = rows.reduce((s, r) => s + r.spend, 0);
  const totalSales = rows.reduce((s, r) => s + r.sales, 0);
  const totalOrders = rows.reduce((s, r) => s + r.orders, 0);

  return {
    rows,
    totalSpend,
    totalSales,
    totalOrders,
    overallRoas: totalSpend > 0 ? totalSales / totalSpend : 0,
  };
}

// ---------------------------------------------------------------------------
// ORDERS page — genuine order-level rows from pnl_orders. This table is only
// populated for periods where an Orders P&L file was uploaded, so a page may
// legitimately find zero rows in a recent window; availableRange lets the UI
// point the user at the window that does have data.
// ---------------------------------------------------------------------------

export interface FlipkartOrderRow {
  orderId: string;
  date: string;
  product: string;
  qty: number;
  amount: number;
  status: string;
  fulfillment: string;
  zone: string;
}

export interface FlipkartOrdersData {
  rows: FlipkartOrderRow[];
  availableRange: { min: string | null; max: string | null };
}

export async function fetchFlipkartOrders(
  loggedInUser: string,
  startDate: string,
  endDate: string
): Promise<FlipkartOrdersData> {
  const ordersTable = getFlipkartTableName("flipkart_pnl_orders", loggedInUser);

  const [raw, availableRange] = await Promise.all([
    fetchTableForRange(ordersTable, "order_date", startDate, endDate),
    fetchDateBounds(ordersTable, "order_date"),
  ]);

  const rows: FlipkartOrderRow[] = raw
    .map((r: any) => ({
      orderId: String(r.order_item_id || ""),
      date: r.order_date || "",
      product: r.sku_name || "—",
      qty: Number(r.net_units) || Number(r.gross_units) || 0,
      amount: Number(r.accounted_net_sales) || 0,
      status: r.order_status || "—",
      fulfillment: r.fulfillment_type || "—",
      zone: r.shipping_zone || "—",
    }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  return { rows, availableRange };
}
