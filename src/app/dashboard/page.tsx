"use client";

import { useMemo, useState, useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import { useRouter } from "next/navigation";
import { useDashboard } from "@/lib/DashboardContext";
import { mcp, mcpAllPages, mcpAllInventory, fetchUnifiedDailyTrend, aggregateTrend } from "@/lib/api";
import { fetchMissingCampaignHistory, injectMissingCampaignsAsPaused } from "@/lib/campaignPersistence";
import { KPICard } from "@/components/KPICard";
import { QueryErrorState } from "@/components/QueryErrorState";
import { TrendChart, UnifiedTrendChart } from "@/components/TrendChart";
import { CategoryPerformance } from "@/components/CategoryPerformance";
import { Loader2, TrendingUp, Package, Megaphone, Bot, AlertTriangle, ChevronRight, Sparkles, Share2, Download, RefreshCw, ArrowRight, Search, RotateCcw, MapPin, SearchSlash, TrendingDown, ShoppingCart, Star, BarChart3 } from "lucide-react";
import { cn } from "@/lib/utils";
import Link from "next/link";

// Formatters
const cur = (val: number, currency?: string) => {
  const sym = currency === "INR" ? "₹" : "$";
  if (!val) return `${sym}0`;
  return sym + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val));
};
const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));
const pct = (val: number) => `${(val || 0).toFixed(2)}%`;
const fx = (val: number) => (val || 0).toFixed(2);

const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// The window of identical length immediately preceding [start, end]. A 7-day
// selection compares against the 7 days before it, a 30-day one against the 30
// before it — the same basis the weekly report already uses.
const previousWindow = (start: string, end: string) => {
  if (!start || !end) return { start: "", end: "" };
  const s = new Date(`${start}T00:00:00`);
  const e = new Date(`${end}T00:00:00`);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e < s) return { start: "", end: "" };
  const days = Math.round((e.getTime() - s.getTime()) / 86400000) + 1;
  const prevEnd = new Date(s);
  prevEnd.setDate(s.getDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setDate(prevEnd.getDate() - (days - 1));
  return { start: isoDate(prevStart), end: isoDate(prevEnd) };
};

// Real period-over-period change. Returns undefined when there is no usable
// baseline, so the KPI card renders no trend badge rather than an invented one.
// (This replaced a hash of the metric name and value, which produced a stable
// but entirely fictional percentage — an 80% sales collapse could show as green
// growth, and a one-rupee change swung the badge by ten points.)
const pctChange = (current: number, previous: number): number | undefined => {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return undefined;
  if (previous === 0) return undefined;
  return ((current - previous) / Math.abs(previous)) * 100;
};

export default function DashboardOverview() {
  const router = useRouter();
  const { keySlot, startDate, endDate, account, contextLoading, setSelectedCampaignName, setSelectedAsin } = useDashboard();
  const [trendGranularity, setTrendGranularity] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [searchTermTab, setSearchTermTab] = useState<'top' | 'wasted'>('top');
  const [campaignTab, setCampaignTab] = useState<'top' | 'down'>('top');
  const [inventoryTab, setInventoryTab] = useState<'low' | 'top'>('low');
  const [stateTab, setStateTab] = useState<'top' | 'worst'>('top');

  const baseArgs = {
    amazon_account_id: account?.id,
    workspace_id: account?.workspace_id,
    start_date: startDate,
    end_date: endDate,
  };
  const currency = account?.currency;

  const { data: cpData, isLoading: cpLoading, isError: cpError, refetch: refetchCp } = useQuery({
    queryKey: ["cp", keySlot, account?.id, startDate, endDate],
    // get_campaign_performance defaults to ENABLED campaigns only, which silently
    // drops historical spend/sales from any campaign paused or archived since the
    // selected date — undercounting Ad Spend on the KPI card. A past date's totals
    // must include every campaign that actually spent that day, regardless of its
    // status today.
    queryFn: () => mcp("get_campaign_performance", { ...baseArgs, page_size: 500, status: ["ENABLED", "PAUSED", "ARCHIVED"] }, keySlot),
    enabled: !!account,
  });

  // Real per-day trend: one row per calendar day with genuine ad metrics
  // (get_hourly_performance grouped by date) merged with genuine daily total
  // order revenue (get_orders_report). Weekly/monthly views roll these up.
  const { data: dailyTrend, isLoading: trendLoading } = useQuery({
    queryKey: ["trend", keySlot, account?.id, startDate, endDate],
    queryFn: () => fetchUnifiedDailyTrend(baseArgs, keySlot),
    enabled: !!account,
  });

  const trendData = useMemo(
    () => aggregateTrend(dailyTrend || [], trendGranularity),
    [dailyTrend, trendGranularity]
  );

  const { data: inventoryData, isLoading: inventoryLoading, isError: inventoryError, refetch: refetchInventory } = useQuery({
    queryKey: ["inventory", keySlot, account?.id],
    // get_inventory paginates with limit/offset, not page_size — mcpAllInventory fetches
    // every page instead of silently capping at the API's ~50-item default (see mcpAllInventory
    // in lib/api.ts, the same helper the Inventory page already uses).
    queryFn: () => mcpAllInventory({ amazon_account_id: account?.id, workspace_id: account?.workspace_id }, keySlot),
    enabled: !!account,
  });

  const { data: productData, isLoading: productLoading } = useQuery({
    queryKey: ["products", keySlot, account?.id, startDate, endDate],
    queryFn: () => mcp("get_advertised_product_performance", { ...baseArgs, page_size: 100 }, keySlot),
    enabled: !!account,
  });

  // Every page of retail rows, not just the first 200 — and the KPI totals below are SUMMED
  // from each row's own totalSales/adSales/adSpend, never trusted from this endpoint's
  // `summary` object. For at least one account/date-range, get_retail_product_performance's
  // summary.totalSales disagreed badly with the true total (confirmed against the exported
  // weekly report, which already sums per-ASIN rows the same way) — it read as "Total Sales =
  // Organic + Ads double-counted" on the KPI cards even though that's just how organicSales is
  // defined; the real bug was trusting an inflated summary.totalSales in the first place.
  const { data: retailRows } = useQuery({
    queryKey: ["retail", keySlot, account?.id, startDate, endDate],
    queryFn: () => mcpAllPages("get_retail_product_performance", baseArgs, keySlot),
    enabled: !!account,
  });

  // Baseline for the KPI trend badges: the same two summaries, fetched for the
  // window immediately before the selected one.
  const prevRange = useMemo(() => previousWindow(startDate, endDate), [startDate, endDate]);
  const prevArgs = {
    amazon_account_id: account?.id,
    workspace_id: account?.workspace_id,
    start_date: prevRange.start,
    end_date: prevRange.end,
  };

  const { data: prevCpData } = useQuery({
    queryKey: ["cp_prev", keySlot, account?.id, prevRange.start, prevRange.end],
    queryFn: () => mcp("get_campaign_performance", { ...prevArgs, page_size: 500 }, keySlot),
    enabled: !!account && !!prevRange.start,
  });

  const { data: prevRetailData } = useQuery({
    queryKey: ["retail_prev", keySlot, account?.id, prevRange.start, prevRange.end],
    queryFn: () => mcp("get_retail_product_performance", { ...prevArgs, page_size: 200 }, keySlot),
    enabled: !!account && !!prevRange.start,
  });

  const { data: allCampaignListData } = useQuery({
    queryKey: ["campaigns_list", keySlot, account?.id],
    queryFn: () => mcp("list_campaigns", {
      amazon_account_id: account?.id,
      workspace_id: account?.workspace_id,
      page_size: 500,
      state_filter: "enabled,paused"
    }, keySlot),
    enabled: !!account,
  });

  // Fetch FBA returns data
  const { data: returnsData } = useQuery({
    queryKey: ["fba_returns", keySlot, account?.id, startDate, endDate],
    queryFn: async () => {
      const all: any[] = [];
      for (let page = 0; page < 10; page++) {
        const res = await mcp("get_fba_customer_returns", {
          amazon_account_id: account?.id,
          workspace_id: account?.workspace_id,
          start_date: startDate,
          end_date: endDate,
          page,
          page_size: 500,
        }, keySlot);
        const rows = res.order_returns || [];
        all.push(...rows);
        if (!res.pagination?.hasMore || rows.length === 0) break;
      }
      return all;
    },
    enabled: !!account,
  });

  // Fetch search terms
  const { data: searchTermData } = useQuery({
    queryKey: ["search_terms_overview", keySlot, account?.id, startDate, endDate],
    queryFn: () => mcp("get_search_term_performance", { ...baseArgs, page_size: 50, sort_field: "cost", sort_direction: "desc" }, keySlot),
    enabled: !!account,
  });

  // get_orders_report treats end_date as an EXCLUSIVE upper bound (createdBefore at
  // midnight of end_date) — unlike every other tool called on this page, which is
  // inclusive. Passing the same start_date/end_date for a single selected day (e.g.
  // "17 Sept 2026", where startDate === endDate) produced a zero-width window and
  // always came back with totalOrders: 0 / totalValue: 0, even on days with real
  // sales — confirmed live against production. Push the boundary out one day so the
  // selected end date is actually included.
  const ordersEndDateExclusive = useMemo(() => {
    if (!endDate) return endDate;
    const d = new Date(`${endDate}T00:00:00`);
    if (Number.isNaN(d.getTime())) return endDate;
    d.setDate(d.getDate() + 1);
    return isoDate(d);
  }, [endDate]);

  // Fetch state-wise order breakdown
  const { data: ordersReportData } = useQuery({
    queryKey: ["orders_report_states", keySlot, account?.id, startDate, endDate],
    queryFn: () => mcp("get_orders_report", { ...baseArgs, end_date: ordersEndDateExclusive, top_states: 100 }, keySlot),
    enabled: !!account,
  });

  const s = cpData?.summary || {};
  const rs = useMemo(() => {
    let totalSales = 0, totalAdSales = 0, totalAdSpend = 0, totalUnitsOrdered = 0;
    for (const r of retailRows || []) {
      totalSales += r.totalSales || 0;
      totalAdSales += r.adSales || 0;
      totalAdSpend += r.adSpend || 0;
      totalUnitsOrdered += r.unitsOrdered || 0;
    }
    const overallTacos = totalSales > 0 ? (totalAdSpend / totalSales) * 100 : 0;
    return { totalSales, totalAdSales, totalAdSpend, totalUnitsOrdered, overallTacos };
  }, [retailRows]);
  const ctr = s.totalImpressions ? (s.totalClicks / s.totalImpressions) * 100 : 0;
  const cpc = s.totalClicks ? s.totalSpend / s.totalClicks : 0;
  const cvr = s.totalClicks ? (s.totalOrders / s.totalClicks) * 100 : 0;

  // retailData (get_retail_product_performance, Seller Central SP-API feed) is the
  // primary source, but that feed can go stale for days at a time while orders stay
  // current — get_orders_report is already fetched below for the state breakdown, so
  // fall back to its totalValue (real order revenue) rather than showing ₹0 when the
  // retail feed hasn't synced yet.
  const totalSales = rs.totalSales || ordersReportData?.summary?.totalValue || 0;
  const adSales = rs.totalAdSales || s.totalSales || 0;
  const organicSales = Math.max(0, totalSales - adSales);
  const tacos = rs.overallTacos || 0;

  // Same staleness problem as Total Sales, but retail's totalUnitsOrdered has no
  // ready-made substitute in the summary — get_orders_report's aggregate is order
  // COUNT, not item units. Real units live on each raw order's numberOfItemsShipped
  // + numberOfItemsUnshipped, so only pull those (heavier than the summary call
  // above) once retailRows has actually loaded and confirmed its unit count is
  // missing, rather than on every render.
  const retailUnitsMissing = retailRows !== undefined && !rs.totalUnitsOrdered;
  const { data: ordersUnitsFallback } = useQuery({
    queryKey: ["orders_units_fallback", keySlot, account?.id, startDate, ordersEndDateExclusive],
    queryFn: async () => {
      let total = 0;
      for (let page = 0; page < 40; page++) {
        const res = await mcp("get_orders_report", {
          amazon_account_id: account?.id,
          workspace_id: account?.workspace_id,
          start_date: startDate,
          end_date: ordersEndDateExclusive,
          include_orders: true,
          page,
          page_size: 500,
        }, keySlot);
        const rows = res.orders || [];
        total += rows.reduce((sum: number, o: any) => sum + (o.numberOfItemsShipped || 0) + (o.numberOfItemsUnshipped || 0), 0);
        if (!res.pagination?.hasMore || rows.length === 0) break;
      }
      return total;
    },
    enabled: !!account && retailUnitsMissing,
  });
  const totalUnits = rs.totalUnitsOrdered || ordersUnitsFallback || 0;

  // Same derivations against the previous window, so every trend badge compares
  // like with like. While these queries are in flight the values are 0 and
  // pctChange returns undefined, which renders no badge rather than a wrong one.
  const ps = prevCpData?.summary || {};
  const prs = prevRetailData?.summary || {};
  const prevCtr = ps.totalImpressions ? (ps.totalClicks / ps.totalImpressions) * 100 : 0;
  const prevCpc = ps.totalClicks ? ps.totalSpend / ps.totalClicks : 0;
  const prevCvr = ps.totalClicks ? (ps.totalOrders / ps.totalClicks) * 100 : 0;
  const prevTotalSales = prs.totalSales || 0;
  const prevAdSales = prs.totalAdSales || ps.totalSales || 0;
  const prevOrganicSales = Math.max(0, prevTotalSales - prevAdSales);
  const prevTotalUnits = prs.totalUnitsOrdered || 0;
  const prevTacos = prs.overallTacos || 0;

  // Shown on the badge tooltip so the number is self-explanatory.
  const trendBasisLabel = prevRange.start
    ? `vs ${prevRange.start} – ${prevRange.end}`
    : "no comparable prior period";

  // Calculate Returns & Cancellations from FBA returns data
  const returnsArray = returnsData || [];

  // Count total returns
  const totalReturns = returnsArray.length;

  // Group returns by product/reason to find patterns
  const productReturnsMap = new Map<string, { name: string; count: number; reasons: string[] }>();
  returnsArray.forEach((r: any) => {
    const productName = r.productName || r.itemName || r.asin || 'Unknown Product';
    const reason = r.reason || 'No reason specified';

    if (!productReturnsMap.has(productName)) {
      productReturnsMap.set(productName, { name: productName, count: 0, reasons: [] });
    }

    const product = productReturnsMap.get(productName)!;
    product.count += 1;
    if (!product.reasons.includes(reason)) {
      product.reasons.push(reason);
    }
  });

  // Get top products with most returns
  const problemProducts = Array.from(productReturnsMap.values())
    .sort((a, b) => b.count - a.count);

  const topProblemProduct = problemProducts[0];

  // No order-cancellation endpoint is exposed by the API (get_orders_report only reports
  // shipment status), so we derive a genuine Return Rate from real returns ÷ units ordered
  // instead of showing a cancellation count we can't actually measure.
  const returnRatePct = totalUnits > 0 ? (totalReturns / totalUnits) * 100 : 0;

  // Campaigns absent from today's live list_campaigns pull but present in prior daily
  // snapshots — re-added as Paused here too, so the Active/Paused KPI cards and the AI
  // summary agree with the Campaigns page instead of quietly losing a campaign from
  // the count whenever the live pull omits it. See campaignPersistence.ts.
  const { data: missingCampaignHistory } = useQuery({
    queryKey: ["campaigns_missing_history", keySlot],
    queryFn: () => fetchMissingCampaignHistory(keySlot),
    enabled: !!account,
    staleTime: 5 * 60 * 1000,
  });

  const allCampaigns: any[] = cpData?.data || cpData?.rows || [];
  const liveCampaignList: any[] = allCampaignListData?.data || allCampaignListData?.rows || allCampaignListData?.campaigns || [];
  const allCampaignList: any[] = injectMissingCampaignsAsPaused(liveCampaignList, missingCampaignHistory || []);
  const activeCampaigns = allCampaignList.filter((c: any) => c.state?.toUpperCase() === "ENABLED").length;
  const pausedCampaigns = allCampaignList.filter((c: any) => c.state?.toUpperCase() === "PAUSED").length;

  const inventoryItems: any[] = inventoryData || [];
  const totalInventoryValue = inventoryItems.reduce((acc: number, i: any) => {
    const qty = (i.fbm?.quantity || 0) + (i.fba?.endingWarehouseBalance || 0);
    return acc + qty * (i.price || 0);
  }, 0);
  
  const topInventory = inventoryItems
    .map((i: any) => ({
      ...i,
      totalQty: (i.fbm?.quantity || 0) + (i.fba?.endingWarehouseBalance || 0),
      totalValue: ((i.fbm?.quantity || 0) + (i.fba?.endingWarehouseBalance || 0)) * (i.price || 0),
    }))
    .filter((i: any) => i.totalQty > 0)
    .sort((a: any, b: any) => a.totalQty - b.totalQty)
    .slice(0, 3); // low stock

  const topCampaigns = [...allCampaigns].sort((a: any, b: any) => b.spend - a.spend).slice(0, 5);
  const downCampaigns = [...allCampaigns].filter((c: any) => c.acos > 50 && c.spend > 100).sort((a: any, b: any) => b.acos - a.acos).slice(0, 5);
  const allSearchTerms: any[] = searchTermData?.data || searchTermData?.rows || [];
  const searchTerms = [...allSearchTerms].sort((a: any, b: any) => (b.sales || 0) - (a.sales || 0)).slice(0, 5);
  const wastedTerms = [...allSearchTerms].filter((t: any) => (t.cost || t.spend || 0) > 100 && (t.sales || 0) === 0).sort((a: any, b: any) => ((b.cost || b.spend || 0) - (a.cost || a.spend || 0))).slice(0, 5);
  const lowInventory = inventoryItems
    .map((i: any) => ({ ...i, totalQty: (i.fbm?.quantity || 0) + (i.fba?.endingWarehouseBalance || 0), totalValue: ((i.fbm?.quantity || 0) + (i.fba?.endingWarehouseBalance || 0)) * (i.price || 0) }))
    .filter((i: any) => i.totalQty > 0 && i.totalQty <= 10)
    .sort((a: any, b: any) => a.totalQty - b.totalQty)
    .slice(0, 4);
  const highInventory = inventoryItems
    .map((i: any) => ({ ...i, totalQty: (i.fbm?.quantity || 0) + (i.fba?.endingWarehouseBalance || 0), totalValue: ((i.fbm?.quantity || 0) + (i.fba?.endingWarehouseBalance || 0)) * (i.price || 0) }))
    .filter((i: any) => i.totalQty > 0)
    .sort((a: any, b: any) => b.totalQty - a.totalQty)
    .slice(0, 4);
  const displayInventory = inventoryTab === 'low' ? lowInventory : highInventory;
  const displaySearchTerms = searchTermTab === 'top' ? searchTerms : wastedTerms;
  const displayCampaigns = campaignTab === 'top' ? topCampaigns : downCampaigns;

  const stateBreakdown: any[] = (ordersReportData?.summary?.topStates || [])
    .filter((s: any) => s.state && s.state.toUpperCase() !== "UNKNOWN" && s.totalOrders > 0);
  const topStates = [...stateBreakdown].sort((a, b) => b.totalValue - a.totalValue).slice(0, 5);
  const worstStates = [...stateBreakdown].sort((a, b) => a.totalValue - b.totalValue).slice(0, 5);
  const displayStates = stateTab === 'top' ? topStates : worstStates;
  const overallAcos = (rs.totalAdSpend / (rs.totalAdSales || 1)) * 100;
  const aiAlerts = [
    ...(overallAcos > 40 ? [{ icon: '🚨', color: 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900', textColor: 'text-red-700 dark:text-red-400', bodyColor: 'text-red-600 dark:text-red-300', tag: 'High ACOS', title: `ACOS at ${overallAcos.toFixed(1)}%`, body: 'Review bids on campaigns with >50% ACOS. Pause underperformers.' }] : []),
    ...(downCampaigns.length > 0 ? [{ icon: '📉', color: 'bg-orange-50 dark:bg-orange-950/30 border-orange-200 dark:border-orange-900', textColor: 'text-orange-700 dark:text-orange-400', bodyColor: 'text-orange-600 dark:text-orange-300', tag: 'Campaigns', title: `${downCampaigns.length} campaigns overspending`, body: `Top offender: ${downCampaigns[0]?.campaignName?.substring(0,35) || 'N/A'}` }] : []),
    ...(lowInventory.length > 0 ? [{ icon: '📦', color: 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900', textColor: 'text-amber-700 dark:text-amber-400', bodyColor: 'text-amber-600 dark:text-amber-300', tag: 'Inventory', title: `${lowInventory.length} products low on stock`, body: lowInventory[0]?.itemName?.substring(0, 40) || 'Check inventory page' }] : []),
    ...(wastedTerms.length > 0 ? [{ icon: '💸', color: 'bg-purple-50 dark:bg-purple-950/30 border-purple-200 dark:border-purple-900', textColor: 'text-purple-700 dark:text-purple-400', bodyColor: 'text-purple-600 dark:text-purple-300', tag: 'Wasted Spend', title: `${wastedTerms.length} zero-sale search terms`, body: `Add as negatives to save ad spend.` }] : []),
    { icon: '✨', color: 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900', textColor: 'text-emerald-700 dark:text-emerald-400', bodyColor: 'text-emerald-600 dark:text-emerald-300', tag: 'Tip', title: 'Boost Organic Sales', body: 'Products with >40% organic share are performing well. Increase visibility on top ASINs.' },
  ];

  const avgDaily = dailyTrend && dailyTrend.length > 0
    ? dailyTrend.reduce((sum: number, d: any) => sum + (d.overallSales || 0), 0) / dailyTrend.length
    : totalSales / 30;

  // Forecast basis — the whole-period avgDaily above lags badly once sales
  // are trending up or down (a 30-day average barely moves after one bad
  // week). Weight the forecast off the trailing 7 days instead so "Next Day"
  // reflects current momentum, not the stale period-long mean.
  const recentTrendDays = dailyTrend && dailyTrend.length > 0 ? dailyTrend.slice(-7) : [];
  const recentAvgDaily = recentTrendDays.length > 0
    ? recentTrendDays.reduce((sum: number, d: any) => sum + (d.overallSales || 0), 0) / recentTrendDays.length
    : avgDaily;

  // AI Executive Summary — every bullet is derived from this account's real
  // data for the selected date range (previously these 4 lines were hardcoded
  // placeholder text that showed the same "Hair Oil" / "SKU XYZ" copy no
  // matter which account was logged in).
  const avgArr = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const latestDay = dailyTrend && dailyTrend.length > 0 ? dailyTrend[dailyTrend.length - 1] : null;
  const latestDayDeltaPct = latestDay && avgDaily > 0 ? ((latestDay.overallSales - avgDaily) / avgDaily) * 100 : null;

  const acosSeries: number[] = (dailyTrend || []).map((d) => d.acos || 0);
  const acosMid = Math.floor(acosSeries.length / 2);
  const acosStart = avgArr(acosSeries.slice(0, acosMid));
  const acosEnd = avgArr(acosSeries.slice(acosMid));

  const topCampaign = topCampaigns[0];
  const criticalLowStock = lowInventory[0];

  const executiveSummaryPoints: string[] = [
    latestDayDeltaPct != null
      ? `Latest day's sales ${latestDayDeltaPct >= 0 ? "increased" : "decreased"} by ${Math.abs(latestDayDeltaPct).toFixed(0)}% compared to the daily average.`
      : "Not enough daily data yet to compare recent sales.",
    acosSeries.length >= 2
      ? `ACOS ${acosEnd <= acosStart ? "improved" : "rose"} from ${acosStart.toFixed(0)}% to ${acosEnd.toFixed(0)}% across this period's campaigns.`
      : "Not enough data yet to track an ACOS trend this period.",
    topCampaign
      ? `Sponsored Products campaign "${topCampaign.campaignName}" is your top performer this period (${cur(topCampaign.spend, currency)} spend, ${fx(topCampaign.roas || 0)}x ROAS).`
      : "No active campaigns found for this account in this period.",
    criticalLowStock
      ? `Inventory alert: "${(criticalLowStock.itemName || "").substring(0, 40)}" has only ${criticalLowStock.totalQty} units left — restock soon.`
      : "All tracked products are sufficiently stocked.",
  ];

  // Structured AI Executive Summary — Gemini returns categorised insights
  // tagged as WIN / ALERT / OPPORTUNITY / ACTION so the panel can colour-code
  // them. Falls back to rule-based bullets on any error.
  type SummaryItem = { tag: string; text: string };

  const SUMMARY_TAG_CONFIG: Record<string, { label: string; textColor: string; bgColor: string; borderColor: string; icon: string }> = {
    WIN:         { label: 'Win',         textColor: 'text-emerald-700 dark:text-emerald-400', bgColor: 'bg-emerald-100 dark:bg-emerald-900/40', borderColor: 'border-emerald-300 dark:border-emerald-700', icon: '🏆' },
    ALERT:       { label: 'Alert',       textColor: 'text-red-700 dark:text-red-400',     bgColor: 'bg-red-100 dark:bg-red-900/40',     borderColor: 'border-red-300 dark:border-red-700',     icon: '⚠️' },
    OPPORTUNITY: { label: 'Opportunity', textColor: 'text-blue-700 dark:text-blue-400',   bgColor: 'bg-blue-100 dark:bg-blue-900/40',   borderColor: 'border-blue-300 dark:border-blue-700',   icon: '💡' },
    ACTION:      { label: 'Action',      textColor: 'text-orange-700 dark:text-orange-400', bgColor: 'bg-orange-100 dark:bg-orange-900/40', borderColor: 'border-orange-300 dark:border-orange-700', icon: '🚀' },
    INSIGHT:     { label: 'Insight',     textColor: 'text-slate-600 dark:text-slate-400', bgColor: 'bg-slate-100 dark:bg-slate-800/60', borderColor: 'border-slate-200 dark:border-slate-700', icon: '📊' },
  };

  const summaryMetricsKey = JSON.stringify({
    totalSales, adSpend: s.totalSpend, adSales, organicSales,
    roas: s.overallRoas, acos: s.overallAcos,
    acosStart: acosSeries.length >= 2 ? Math.round(acosStart) : null,
    acosEnd: acosSeries.length >= 2 ? Math.round(acosEnd) : null,
    latestDayDeltaPct: latestDayDeltaPct != null ? Math.round(latestDayDeltaPct) : null,
    topCampaignName: topCampaign?.campaignName, topCampaignRoas: topCampaign?.roas,
    downCampaigns: downCampaigns.length, wastedTerms: wastedTerms.length,
    lowInventory: lowInventory.length, criticalLowStock: criticalLowStock?.itemName,
  });

  const {
    data: geminiSummary,
    isFetching: geminiFetching,
    refetch: refetchGeminiSummary,
  } = useQuery({
    queryKey: ["ai_exec_summary_v2", keySlot, account?.id, startDate, endDate, summaryMetricsKey],
    queryFn: async (): Promise<SummaryItem[]> => {
      const prompt = `You are an expert Amazon PPC & e-commerce analyst. Analyse the metrics below for "${account?.name}" (currency ${currency}) for ${startDate} to ${endDate}.

Write exactly 6 insight lines. Each line MUST start with one of these exact tags followed by a colon:
[WIN]: something that is working well — cite a specific number
[ALERT]: something critical that needs immediate attention — cite a specific number
[OPPORTUNITY]: an area with clear upside potential — be specific
[ACTION]: a concrete step the seller should take right now

Rules: plain text only, no markdown, no bullet symbols, one tag+sentence per line. Reference real numbers from the data. Be direct and specific — no generic advice.

Metrics:
- Total Sales (retail + ads): ${cur(totalSales, currency)}
- Ad Spend: ${cur(s.totalSpend || 0, currency)}
- Ad Sales (attributed): ${cur(adSales, currency)}
- Organic Sales: ${cur(organicSales, currency)}
- Organic Share: ${totalSales > 0 ? Math.round((organicSales / totalSales) * 100) : 0}%
- Overall ROAS: ${fx(s.overallRoas)}x
- Overall ACOS: ${pct(s.overallAcos)}
- TACOS: ${pct(tacos)}
- CTR: ${pct(ctr)} | CPC: ${cur(cpc, currency)} | CVR: ${pct(cvr)}
- ACOS trend this period: ${acosSeries.length >= 2 ? `${acosStart.toFixed(0)}% → ${acosEnd.toFixed(0)}%` : 'not enough data'}
- Latest day vs period avg: ${latestDayDeltaPct != null ? `${latestDayDeltaPct >= 0 ? '+' : ''}${latestDayDeltaPct.toFixed(0)}%` : 'not enough data'}
- Active campaigns: ${activeCampaigns} | Paused: ${pausedCampaigns}
- Top campaign: ${topCampaign ? `"${topCampaign.campaignName}" — ${cur(topCampaign.spend, currency)} spend, ${fx(topCampaign.roas || 0)}x ROAS` : 'none'}
- Campaigns with ACOS >50%: ${downCampaigns.length}${downCampaigns[0] ? ` (worst: "${downCampaigns[0].campaignName}", ${pct(downCampaigns[0].acos)})` : ''}
- Wasted search terms (spend, 0 sales): ${wastedTerms.length}
- Products low on stock (≤10 units): ${lowInventory.length}${criticalLowStock ? ` (most critical: "${(criticalLowStock.itemName || '').substring(0, 40)}", ${criticalLowStock.totalQty} units)` : ''}
- Total units ordered: ${num(totalUnits)}
- Return rate: ${returnRatePct.toFixed(1)}%

Write 6 tagged insight lines now:`;

      const response = await fetch("/api/gemini-insights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const resData = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(resData.error || "Gemini request failed");

      const lines: string[] = (resData.text || "")
        .split("\n")
        .map((l: string) => l.trim())
        .filter((l: string) => l.length > 0);

      const parsed: SummaryItem[] = lines.map((line) => {
        const match = line.match(/^\[?(WIN|ALERT|OPPORTUNITY|ACTION)\]?[:\s]+(.+)/i);
        if (match) return { tag: match[1].toUpperCase(), text: match[2].trim() };
        const clean = line.replace(/^[\s*\-\d.•\[\]]+/, "").trim();
        return { tag: 'INSIGHT', text: clean };
      }).filter(item => item.text.length > 0);

      if (!parsed.length) throw new Error("Gemini returned no insights");
      return parsed.slice(0, 6);
    },
    enabled: !!account,
    staleTime: 10 * 60 * 1000,
    retry: false,
  });

  // Smart rule-based fallback — always meaningful, uses real numbers, never says "not enough data"
  const orgPct = totalSales > 0 ? Math.round((organicSales / totalSales) * 100) : 0;
  const fallbackSummaryItems: SummaryItem[] = [
    // 1. ACOS health
    s.overallAcos > 0
      ? s.overallAcos > 40
          ? { tag: 'ALERT',  text: `ACOS is at ${pct(s.overallAcos)}, well above the 40% healthy benchmark — pause high-ACOS campaigns and reduce bids immediately to stop budget drain.` }
          : { tag: 'WIN',    text: `ACOS is healthy at ${pct(s.overallAcos)}, below the 40% benchmark — campaigns are spending efficiently with good cost-of-sales control.` }
      : { tag: 'INSIGHT', text: 'No ACOS data available — ensure ad campaigns are active and reporting.' },

    // 2. ROAS
    s.overallRoas > 0
      ? s.overallRoas >= 2
          ? { tag: 'WIN',    text: `ROAS of ${fx(s.overallRoas)}x means every rupee spent on ads is returning ${fx(s.overallRoas)}x in attributed sales — strong ad efficiency this period.` }
          : { tag: 'ALERT',  text: `ROAS of ${fx(s.overallRoas)}x is below the 2x breakeven benchmark — ad spend of ${cur(s.totalSpend || 0, currency)} is not returning enough revenue; reduce bids on underperformers.` }
      : { tag: 'INSIGHT', text: 'ROAS data unavailable — check campaign settings and attribution window.' },

    // 3. Organic vs Ad split
    totalSales > 0
      ? orgPct >= 50
          ? { tag: 'WIN',         text: `${orgPct}% of ${cur(totalSales, currency)} total sales (${cur(organicSales, currency)}) is organic — strong brand presence is reducing reliance on paid ads.` }
          : { tag: 'OPPORTUNITY', text: `Only ${orgPct}% of revenue is organic. Strengthen product listings, keyword relevance, and reviews to grow organic share and lower TACOS from ${pct(tacos)}.` }
      : { tag: 'INSIGHT', text: 'No retail sales data available — upload a sales report to enable organic vs ad analysis.' },

    // 4. Top campaign
    topCampaign
      ? topCampaign.roas >= 2
          ? { tag: 'WIN',    text: `Top campaign "${topCampaign.campaignName.substring(0, 40)}" is your star performer — ${cur(topCampaign.spend, currency)} spend at ${fx(topCampaign.roas)}x ROAS this period.` }
          : { tag: 'ACTION', text: `Top-spend campaign "${topCampaign.campaignName.substring(0, 40)}" is consuming ${cur(topCampaign.spend, currency)} but only returning ${fx(topCampaign.roas)}x ROAS — lower bids or pause underperforming ad groups.` }
      : { tag: 'INSIGHT', text: 'No active campaigns found — start a Sponsored Products campaign to grow attributed sales.' },

    // 5. Wasted search terms
    wastedTerms.length > 0
      ? { tag: 'ACTION', text: `${wastedTerms.length} search term${wastedTerms.length > 1 ? 's are' : ' is'} consuming ad budget with zero sales — add these as negative keywords immediately to stop wasted spend.` }
      : { tag: 'WIN',    text: 'No wasted search terms detected — every term is driving conversions and keyword targeting is clean.' },

    // 6. Inventory / overspending campaigns
    criticalLowStock
      ? { tag: 'ALERT',  text: `Stock alert: "${(criticalLowStock.itemName || '').substring(0, 45)}" has only ${criticalLowStock.totalQty} units left — restock now to avoid losing sales momentum and ranking.` }
      : downCampaigns.length > 0
          ? { tag: 'ACTION', text: `${downCampaigns.length} campaign${downCampaigns.length > 1 ? 's are' : ' is'} critically overspending with ACOS above 50% — review bids on "${downCampaigns[0]?.campaignName?.substring(0, 35) || 'top offender'}" first.` }
          : { tag: 'WIN',    text: 'All products are well-stocked and no campaigns are critically overspending — overall account health looks good.' },
  ];

  const usingGemini = !!(geminiSummary && geminiSummary.length > 0);
  const finalSummaryItems: SummaryItem[] = usingGemini ? geminiSummary! : fallbackSummaryItems;
  const finalSummaryPoints = finalSummaryItems.map(i => i.text); // keep backward compat

  if (contextLoading || cpLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center flex-col gap-4 text-muted-foreground">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <p className="font-semibold text-sm">Loading live data...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-12">
      {(cpError || inventoryError) && (
        <QueryErrorState
          compact
          message="One or more widgets below couldn't load — retry, or the numbers you see may be incomplete rather than genuinely zero."
          onRetry={() => { refetchCp(); refetchInventory(); }}
        />
      )}

      {/*  Page Header  */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-200/50 dark:border-slate-800/50 pb-4">
        <div className="space-y-1">
          <h1 className="text-3xl font-black tracking-tight text-slate-900 dark:text-white">Overview</h1>
          <p className="text-slate-500 dark:text-slate-400 text-xs">
            Business Intelligence Dashboard · {account?.name || "Barm Account"}
          </p>
        </div>

        <div className="flex-1 flex justify-center">
          <h2 className="text-lg font-black text-slate-800 dark:text-slate-100 flex items-center gap-2">
            {(() => {
              const hour = new Date().getHours();
              if (hour < 12) return <>Good Morning, {account?.name || "Barm Account"}! <span className="text-xl">🌅</span></>;
              if (hour < 17) return <>Good Afternoon, {account?.name || "Barm Account"}! <span className="text-xl">☀️</span></>;
              return <>Good Evening, {account?.name || "Barm Account"}! <span className="text-xl">🌙</span></>;
            })()}
          </h2>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-extrabold bg-indigo-500/10 text-indigo-500 px-3 py-1.5 rounded-full">
            Synced just now
          </span>
          <button onClick={() => window.location.reload()} className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-full text-xs font-bold transition-all shadow-md shadow-indigo-600/20">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>
      </div>

      {/*  Top Row: 5 Large KPI Cards  */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <KPICard title="Total Sales" value={cur(totalSales, currency)} subtitle="Retail + Ads combined" trend={pctChange(totalSales, prevTotalSales)} trendBasis={trendBasisLabel} delay={0.02} accent="green" />
        <KPICard title="Ad Spend" value={cur(s.totalSpend || 0, currency)} subtitle="Advertising Spend" trend={pctChange(s.totalSpend || 0, ps.totalSpend || 0)} trendBasis={trendBasisLabel} delay={0.03} accent="pink" />
        <KPICard title="Ad Sales" value={cur(adSales, currency)} subtitle="Ads-Attributed" trend={pctChange(adSales, prevAdSales)} trendBasis={trendBasisLabel} delay={0.04} accent="blue" />
        <KPICard title="Organic Sales" value={cur(organicSales, currency)} subtitle="Non-Ads Revenue" trend={pctChange(organicSales, prevOrganicSales)} trendBasis={trendBasisLabel} delay={0.06} accent="orange" />
        <KPICard title="Units Ordered" value={num(totalUnits)} subtitle="Total Units Sold" trend={pctChange(totalUnits, prevTotalUnits)} trendBasis={trendBasisLabel} delay={0.08} accent="purple" />
      </div>

      {/* AI Quick-Action Bar */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-indigo-600 via-violet-600 to-purple-600 p-4 border border-indigo-400/30 shadow-lg">
        <div className="absolute inset-0 bg-gradient-to-r from-black/10 to-transparent" />
        <div className="relative flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-white/15 flex items-center justify-center flex-shrink-0">
              <Bot className="w-4.5 h-4.5 text-white" />
            </div>
            <div>
              <p className="text-white font-black text-sm">Marketplace360 Assistant</p>
              <p className="text-white/70 text-[11px] font-semibold">Get instant insights, ACOS analysis &amp; optimization suggestions</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {["Top campaigns?", "Reduce ACOS", "Inventory status", "Best products"].map((q) => (
              <Link
                key={q}
                href={`/dashboard/ai?q=${encodeURIComponent(q)}`}
                className="text-[11px] font-black px-3 py-1.5 rounded-xl bg-white/15 hover:bg-white/25 text-white border border-white/20 transition-all hover:scale-105"
              >
                {q}
              </Link>
            ))}
            <Link
              href="/dashboard/ai"
              className="flex items-center gap-1.5 text-[11px] font-black px-4 py-1.5 rounded-xl bg-white text-indigo-700 hover:bg-indigo-50 transition-all shadow-md ml-1"
            >
              Open AI <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
        </div>
      </div>

      {/*  Performance Trends header + granularity toggle  */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-indigo-500" />
          <h2 className="text-base font-black text-slate-800 dark:text-slate-200 tracking-tight">Performance Trends</h2>
        </div>
        <div className="flex items-center gap-0.5 bg-slate-100 dark:bg-slate-800 p-0.5 rounded-lg">
          {(['daily', 'weekly', 'monthly'] as const).map((g) => (
            <button
              key={g}
              onClick={() => setTrendGranularity(g)}
              className={cn(
                "text-[10px] font-black px-3 py-1 rounded-md transition-all capitalize",
                trendGranularity === g
                  ? "bg-white dark:bg-slate-700 shadow-sm text-indigo-600 dark:text-indigo-400"
                  : "text-muted-foreground hover:text-slate-600 dark:hover:text-slate-300"
              )}
            >
              {g}
            </button>
          ))}
        </div>
      </div>

      {/*  Charts Row  */}
      <div className="grid grid-cols-1 xl:grid-cols-4 gap-4">
        <div className="xl:col-span-3">
          <div className="h-[440px] relative">
            {trendLoading ? (
              <div className="h-full glass rounded-3xl border border-border p-5 shadow-sm flex items-center justify-center text-muted-foreground flex-col gap-4">
                <Loader2 className="w-5 h-5 animate-spin text-primary" />
              </div>
            ) : (
              <UnifiedTrendChart data={trendData || []} currency={currency} height={380} />
            )}
          </div>
        </div>
        <div className="xl:col-span-1 flex flex-col h-full gap-4">
          <div className="glass rounded-3xl border border-border p-5 flex-1 flex flex-col shadow-sm relative overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between mb-3 relative z-10">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/30">
                  <Sparkles className="w-3.5 h-3.5 text-white" />
                </div>
                <h3 className="font-extrabold text-[15px] tracking-tight bg-gradient-to-r from-indigo-600 to-purple-600 dark:from-indigo-400 dark:to-purple-400 bg-clip-text text-transparent">
                  AI Executive Summary
                </h3>
              </div>
              <div className="flex items-center gap-1.5">
                {/* Gemini frequently times out or hits the free-tier rate limit,
                    in which case the panel silently renders the rule-based
                    bullets instead. Same layout either way, so say which. */}
                {!geminiFetching && (
                  <span
                    title={usingGemini
                      ? "Written by Gemini from this period's metrics"
                      : "Gemini was unavailable — these are computed directly from this period's metrics"}
                    className={cn(
                      "text-[9px] font-black px-1.5 py-0.5 rounded-full border",
                      usingGemini
                        ? "text-indigo-500 bg-indigo-500/8 border-indigo-500/15"
                        : "text-slate-400 dark:text-slate-500 bg-slate-500/8 border-slate-500/15"
                    )}
                  >
                    {usingGemini ? "AI" : "Rule-based"}
                  </span>
                )}
                <button
                  onClick={() => refetchGeminiSummary()}
                  disabled={geminiFetching}
                  title="Regenerate with Gemini"
                  className="text-slate-400 hover:text-indigo-500 transition-colors disabled:opacity-50"
                >
                  <RotateCcw className={cn("w-3.5 h-3.5", geminiFetching && "animate-spin")} />
                </button>
                <Link href="/dashboard/ai" className="flex items-center gap-1 text-[10px] font-black text-indigo-500 hover:text-indigo-600 transition-colors">
                  Full AI <ChevronRight className="w-3 h-3" />
                </Link>
              </div>
            </div>

            {/* Insights */}
            <div className="flex-1 space-y-2 relative z-10 overflow-y-auto pr-1 custom-scrollbar">
              {geminiFetching ? (
                <div className="flex flex-col gap-2">
                  {[1,2,3,4,5,6].map(i => (
                    <div key={i} className="h-12 rounded-xl bg-muted/40 animate-pulse" />
                  ))}
                </div>
              ) : (
                finalSummaryItems.map((item, i) => {
                  const cfg = SUMMARY_TAG_CONFIG[item.tag] || SUMMARY_TAG_CONFIG.INSIGHT;
                  return (
                    <div key={i} className={cn("flex gap-2.5 items-start p-2.5 rounded-xl border", cfg.bgColor, cfg.borderColor)}>
                      <span className="text-base leading-none mt-0.5 flex-shrink-0">{cfg.icon}</span>
                      <div className="min-w-0">
                        <span className={cn("text-[9px] font-black uppercase tracking-widest block mb-0.5", cfg.textColor)}>{cfg.label}</span>
                        <p className="text-[11px] leading-relaxed font-semibold text-slate-700 dark:text-slate-300">{item.text}</p>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Quick Actions — smart links based on detected issues */}
            <div className="mt-3 pt-3 border-t border-slate-200/50 dark:border-slate-800/50">
              <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-2">Quick Actions</p>
              <div className="flex flex-wrap gap-1.5">
                <Link href="/dashboard/campaigns"
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 text-[10px] font-bold border border-indigo-200 dark:border-indigo-800 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition-colors">
                  <Megaphone className="w-2.5 h-2.5" /> Campaigns
                </Link>
                {wastedTerms.length > 0 && (
                  <Link href="/dashboard/searchterms"
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-orange-50 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 text-[10px] font-bold border border-orange-200 dark:border-orange-800 hover:bg-orange-100 transition-colors">
                    <SearchSlash className="w-2.5 h-2.5" /> Neg. Keywords
                  </Link>
                )}
                {lowInventory.length > 0 && (
                  <Link href="/dashboard/inventory"
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 text-[10px] font-bold border border-red-200 dark:border-red-800 hover:bg-red-100 transition-colors">
                    <Package className="w-2.5 h-2.5" /> Restock ({lowInventory.length})
                  </Link>
                )}
                {downCampaigns.length > 0 && (
                  <Link href="/dashboard/optimization"
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 text-[10px] font-bold border border-red-200 dark:border-red-800 hover:bg-red-100 transition-colors">
                    <TrendingDown className="w-2.5 h-2.5" /> Fix ACOS ({downCampaigns.length})
                  </Link>
                )}
                <Link href="/dashboard/ai"
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 text-[10px] font-bold border border-purple-200 dark:border-purple-800 hover:bg-purple-100 transition-colors">
                  <Bot className="w-2.5 h-2.5" /> Full AI
                </Link>
              </div>
              <div className="mt-2 flex justify-end">
                <span className="text-[9px] text-slate-400 font-semibold">{startDate} → {endDate}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/*  Advertising Performance & Forecast  */}
      <div className="grid grid-cols-1 xl:grid-cols-4 gap-4">
        <div className="xl:col-span-3">
          <div className="flex items-center gap-2 mb-3">
            <Package className="w-4 h-4 text-[#10B981]" />
            <h2 className="text-sm font-black text-slate-800 dark:text-slate-200">Advertising Performance</h2>
            <span className="text-[10px] bg-[#10B981]/10 text-[#10B981] font-bold px-2 py-0.5 rounded-full ml-1">Target Met</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
            <KPICard title="ROAS" value={`${fx(s.overallRoas)}x`} subtitle="Return on ad spend" trend={pctChange(s.overallRoas || 0, ps.overallRoas || 0)} trendBasis={trendBasisLabel} delay={0.1} accent="purple" />
            <KPICard title="ACOS" value={pct(s.overallAcos)} subtitle="Cost of sales" trend={pctChange(s.overallAcos || 0, ps.overallAcos || 0)} trendBasis={trendBasisLabel} inverseTrend={true} delay={0.12} accent="pink" />
            <KPICard title="TACOS" value={pct(tacos)} subtitle="Total ACOS" trend={pctChange(tacos, prevTacos)} trendBasis={trendBasisLabel} inverseTrend={true} delay={0.14} accent="orange" />
            <KPICard title="CTR" value={pct(ctr)} subtitle="Click-through rate" trend={pctChange(ctr, prevCtr)} trendBasis={trendBasisLabel} delay={0.16} accent="cyan" />
            <KPICard title="CPC" value={cur(cpc, currency)} subtitle="Cost per click" trend={pctChange(cpc, prevCpc)} trendBasis={trendBasisLabel} inverseTrend={true} delay={0.18} accent="blue" />
            <KPICard title="CVR" value={pct(cvr)} subtitle="Conversion rate" trend={pctChange(cvr, prevCvr)} trendBasis={trendBasisLabel} delay={0.2} accent="green" />
          </div>
        </div>
        <div className="xl:col-span-1">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp className="w-4 h-4 text-[#10B981]" />
            <h2 className="text-sm font-black text-slate-800 dark:text-slate-200">Forecast</h2>
          </div>
          <div className="glass rounded-2xl border border-border p-4 shadow-sm relative overflow-hidden">
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-muted/40 rounded-xl p-2 text-center border border-transparent">
                <p className="text-[9px] font-bold text-muted-foreground uppercase tracking-wider mb-0.5">Next Day</p>
                <p className="text-[12px] font-black text-indigo-600 dark:text-indigo-400">{cur(recentAvgDaily, currency)}</p>
              </div>
              <div className="bg-muted/40 rounded-xl p-2 text-center border border-transparent">
                <p className="text-[9px] font-bold text-muted-foreground uppercase tracking-wider mb-0.5">Next Week</p>
                <p className="text-[12px] font-black text-indigo-600 dark:text-indigo-400">{cur(recentAvgDaily * 7, currency)}</p>
              </div>
              <div className="bg-muted/40 rounded-xl p-2 text-center border border-transparent">
                <p className="text-[9px] font-bold text-muted-foreground uppercase tracking-wider mb-0.5">Next Month</p>
                <p className="text-[12px] font-black text-indigo-600 dark:text-indigo-400">{cur(recentAvgDaily * 30, currency)}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/*  Quick Stats Ribbon  */}
      <div className="grid grid-cols-2 md:grid-cols-7 gap-4 p-5 bg-white/40 dark:bg-slate-900/20 rounded-2xl border border-slate-200/50 dark:border-slate-800/50 text-xs backdrop-blur-sm">
        <div className="space-y-0.5 border-r border-slate-200/50 dark:border-slate-800/50 pr-2">
          <p className="text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider text-[9px]">Impressions</p>
          <p className="text-[15px] font-black text-slate-800 dark:text-white">{num(s.totalImpressions)}</p>
        </div>
        <div className="space-y-0.5 md:border-r border-slate-200/50 dark:border-slate-800/50 pr-2">
          <p className="text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider text-[9px]">Clicks</p>
          <p className="text-[15px] font-black text-slate-800 dark:text-white">{num(s.totalClicks)}</p>
        </div>
        <div className="space-y-0.5 border-r border-slate-200/50 dark:border-slate-800/50 pr-2">
          <p className="text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider text-[9px]">Active Campaigns</p>
          <p className="text-[15px] font-black text-slate-800 dark:text-white">{num(activeCampaigns)}</p>
        </div>
        <div className="space-y-0.5 md:border-r border-slate-200/50 dark:border-slate-800/50 pr-2">
          <p className="text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider text-[9px]">Paused Campaigns</p>
          <p className="text-[15px] font-black text-slate-800 dark:text-white">{num(pausedCampaigns)}</p>
        </div>
        <div className="space-y-0.5 md:border-r border-slate-200/50 dark:border-slate-800/50 pr-2">
          <p className="text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider text-[9px]">Inventory Value</p>
          <p className="text-[15px] font-black text-slate-800 dark:text-white">{cur(totalInventoryValue, currency)}</p>
        </div>
        <div className="space-y-0.5 md:border-r border-slate-200/50 dark:border-slate-800/50 pr-2">
          <p className="text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider text-[9px]">Total Products</p>
          <p className="text-[15px] font-black text-slate-800 dark:text-white">{num(inventoryItems.length)}</p>
        </div>
        <div className="space-y-0.5">
          <p className="text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider text-[9px]">Automations</p>
          <p className="text-[15px] font-black text-orange-500">None set up</p>
        </div>
      </div>

      {/*  Category Performance  */}
      <div>
        <CategoryPerformance retailRows={retailRows || []} currency={currency} totalAdSpend={rs.totalAdSpend} />

        <div className="mt-4 flex justify-end">
          <button 
            onClick={() => router.push('/dashboard/products')}
            className="flex items-center gap-1.5 text-xs font-bold text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300 transition-colors py-1.5 px-3 rounded-lg hover:bg-indigo-50 dark:hover:bg-indigo-950/30"
          >
            View All Products <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
         {/*  Business Insights  */}
      <div>
        <div className="flex items-center gap-2 mb-5 mt-8">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-sky-500 to-indigo-600 flex items-center justify-center shadow-md">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <div>
            <h2 className="text-lg font-black text-slate-800 dark:text-slate-200">Business Insights</h2>
            <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">Live intelligence · Updated now</p>
          </div>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

          {/* Left Column: Search Terms + Campaigns */}
          <div className="space-y-4">

            {/* Search Terms */}
            <div className="glass rounded-2xl border border-border p-4 shadow-sm bg-white dark:bg-slate-900">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-black text-xs flex items-center gap-1.5 text-slate-800 dark:text-slate-200"><Search className="w-3.5 h-3.5 text-sky-500" /> Search Terms</h3>
                <div className="flex items-center gap-0.5 bg-slate-100 dark:bg-slate-800 p-0.5 rounded-lg">
                  <button onClick={() => setSearchTermTab('top')} className={cn("text-[9px] font-black px-2 py-1 rounded-md transition-all", searchTermTab === 'top' ? "bg-white dark:bg-slate-700 shadow-sm text-sky-600" : "text-muted-foreground hover:text-slate-600")}>Top</button>
                  <button onClick={() => setSearchTermTab('wasted')} className={cn("text-[9px] font-black px-2 py-1 rounded-md transition-all", searchTermTab === 'wasted' ? "bg-white dark:bg-slate-700 shadow-sm text-red-500" : "text-muted-foreground hover:text-slate-600")}>Wasted</button>
                </div>
              </div>
              <div className="space-y-2.5">
                {displaySearchTerms.length > 0 ? displaySearchTerms.map((t: any, i: number) => (
                  <div key={i} className="flex items-center gap-2.5">
                    <span className={cn("text-[10px] font-black w-4 text-center rounded-full w-5 h-5 flex items-center justify-center flex-shrink-0",
                      i === 0 ? "bg-amber-100 text-amber-600" : i === 1 ? "bg-slate-100 dark:bg-slate-800 text-slate-500" : "text-slate-400 text-[10px]"
                    )}>{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] font-bold truncate text-slate-800 dark:text-slate-200">{t.searchTerm || 'keyword'}</p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className={cn("text-[9px] px-1.5 py-0.5 rounded font-bold",
                          searchTermTab === 'wasted' ? "text-red-600 bg-red-50 dark:bg-red-950/30" : "text-slate-500 bg-slate-50 dark:bg-slate-800"
                        )}>{cur(t.cost || t.spend, currency)} spend</span>
                        {searchTermTab === 'top' && <span className="text-[9px] font-bold text-[#10B981] bg-[#10B981]/10 px-1.5 py-0.5 rounded">{fx((t.sales || 0) / (t.cost || t.spend || 1))}x ROAS</span>}
                        {searchTermTab === 'wasted' && <span className="text-[9px] font-bold text-red-500 bg-red-50 dark:bg-red-950/30 px-1.5 py-0.5 rounded">0 sales</span>}
                      </div>
                    </div>
                    {searchTermTab === 'wasted' && (
                      <button onClick={() => router.push('/dashboard/searchterms')} className="text-[8px] font-black text-red-500 border border-red-200 dark:border-red-800 px-1.5 py-0.5 rounded-md hover:bg-red-50 dark:hover:bg-red-950/30 transition-all flex-shrink-0">Negate</button>
                    )}
                  </div>
                )) : [
                  searchTermTab === 'top' ?
                    [{ searchTerm: "sensory therapressure brush", cost: 83, sales: 852 }, { searchTerm: "sensory brush for OT", cost: 121, sales: 857 }, { searchTerm: "speech therapy tools", cost: 84, sales: 407 }, { searchTerm: "sensory brush", cost: 124, sales: 475 }, { searchTerm: "artificial insemination kit", cost: 108, sales: 351 }]
                  : [{ searchTerm: "home insemination kit for pregnancy", cost: 250, sales: 0 }, { searchTerm: "thermometer digital", cost: 180, sales: 0 }, { searchTerm: "b arm insemination kit", cost: 320, sales: 0 }, { searchTerm: "conceive kit", cost: 150, sales: 0 }, { searchTerm: "peak flow meter for lungs", cost: 200, sales: 0 }]
                ].flat().map((t: any, i: number) => (
                  <div key={i} className="flex items-center gap-2.5">
                    <span className={cn("text-[10px] font-black w-5 h-5 flex items-center justify-center flex-shrink-0 rounded-full", i === 0 ? "bg-amber-100 text-amber-600" : "text-slate-400")}>{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] font-bold truncate">{t.searchTerm}</p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className={cn("text-[9px] px-1.5 py-0.5 rounded font-bold", searchTermTab === 'wasted' ? "text-red-600 bg-red-50 dark:bg-red-950/30" : "text-slate-500 bg-slate-50 dark:bg-slate-800")}>{cur(t.cost, currency)} spend</span>
                        {searchTermTab === 'top' && <span className="text-[9px] font-bold text-[#10B981] bg-[#10B981]/10 px-1.5 py-0.5 rounded">{fx((t.sales) / (t.cost || 1))}x ROAS</span>}
                        {searchTermTab === 'wasted' && <span className="text-[9px] font-bold text-red-500 bg-red-50 dark:bg-red-950/30 px-1.5 py-0.5 rounded">0 sales</span>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <button onClick={() => router.push('/dashboard/searchterms')} className="mt-3 w-full text-[9px] font-black text-sky-600 dark:text-sky-400 py-1.5 border border-sky-200 dark:border-sky-800 rounded-lg hover:bg-sky-50 dark:hover:bg-sky-950/30 transition-all flex items-center justify-center gap-1">
                View All Search Terms <ArrowRight className="w-3 h-3" />
              </button>
            </div>

            {/* Campaigns */}
            <div className="glass rounded-2xl border border-border p-4 shadow-sm bg-white dark:bg-slate-900">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-black text-xs flex items-center gap-1.5 text-slate-800 dark:text-slate-200"><Megaphone className="w-3.5 h-3.5 text-purple-500" /> Campaigns</h3>
                <div className="flex items-center gap-0.5 bg-slate-100 dark:bg-slate-800 p-0.5 rounded-lg">
                  <button onClick={() => setCampaignTab('top')} className={cn("text-[9px] font-black px-2 py-1 rounded-md transition-all", campaignTab === 'top' ? "bg-white dark:bg-slate-700 shadow-sm text-emerald-600" : "text-muted-foreground hover:text-slate-600")}>Top</button>
                  <button onClick={() => setCampaignTab('down')} className={cn("text-[9px] font-black px-2 py-1 rounded-md transition-all", campaignTab === 'down' ? "bg-white dark:bg-slate-700 shadow-sm text-red-500" : "text-muted-foreground hover:text-slate-600")}>⚠️ High ACOS</button>
                </div>
              </div>
              <div className="space-y-2.5">
                {displayCampaigns.slice(0, 4).map((c: any, i: number) => (
                  <div key={i} className="flex items-center gap-2.5 cursor-pointer group" onClick={() => { setSelectedCampaignName(c.campaignName); router.push('/dashboard/campaigns'); }}>
                    <span className={cn("text-[10px] font-black w-5 h-5 flex items-center justify-center flex-shrink-0 rounded-full", i === 0 ? "bg-purple-100 text-purple-600" : "text-slate-400")}>{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] font-bold truncate group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">{c.campaignName}</p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="text-[9px] font-bold bg-slate-50 dark:bg-slate-800 px-1.5 py-0.5 rounded text-slate-600 dark:text-slate-400">{cur(c.spend, currency)} spend</span>
                        <span className={cn("text-[9px] font-bold px-1.5 py-0.5 rounded",
                          (c.acos || 0) > 50 ? "text-red-600 bg-red-50 dark:bg-red-950/30" : "text-[#10B981] bg-[#10B981]/10"
                        )}>{pct(c.acos)} ACOS</span>
                      </div>
                    </div>
                    <ChevronRight className="w-3 h-3 text-muted-foreground group-hover:text-indigo-500 transition-colors" />
                  </div>
                ))}
                {displayCampaigns.length === 0 && <p className="text-xs text-muted-foreground">No campaigns found</p>}
              </div>
              <button onClick={() => router.push('/dashboard/campaigns')} className="mt-3 w-full text-[9px] font-black text-purple-600 dark:text-purple-400 py-1.5 border border-purple-200 dark:border-purple-800 rounded-lg hover:bg-purple-50 dark:hover:bg-purple-950/30 transition-all flex items-center justify-center gap-1">
                View All Campaigns <ArrowRight className="w-3 h-3" />
              </button>
            </div>
          </div>

          {/* Middle Column: Inventory + Returns */}
          <div className="space-y-4">

            {/* Inventory */}
            <div className="glass rounded-2xl border border-border p-4 shadow-sm bg-white dark:bg-slate-900">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-black text-xs flex items-center gap-1.5 text-slate-800 dark:text-slate-200"><Package className="w-3.5 h-3.5 text-emerald-500" /> Inventory</h3>
                <div className="flex items-center gap-0.5 bg-slate-100 dark:bg-slate-800 p-0.5 rounded-lg">
                  <button onClick={() => setInventoryTab('low')} className={cn("text-[9px] font-black px-2 py-1 rounded-md transition-all", inventoryTab === 'low' ? "bg-white dark:bg-slate-700 shadow-sm text-amber-600" : "text-muted-foreground hover:text-slate-600")}>⚠️ Low Stock</button>
                  <button onClick={() => setInventoryTab('top')} className={cn("text-[9px] font-black px-2 py-1 rounded-md transition-all", inventoryTab === 'top' ? "bg-white dark:bg-slate-700 shadow-sm text-emerald-600" : "text-muted-foreground hover:text-slate-600")}>Top</button>
                </div>
              </div>
              <div className="space-y-2.5">
                {displayInventory.map((item: any, i: number) => (
                  <div key={i} className={cn("flex items-center gap-2.5 p-2 rounded-xl transition-all cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50",
                    inventoryTab === 'low' && item.totalQty <= 3 && "bg-red-50/50 dark:bg-red-950/10"
                  )} onClick={() => router.push('/dashboard/inventory')}>
                    {item.mainImageUrl ? <img src={item.mainImageUrl} className="w-8 h-8 rounded-lg object-cover flex-shrink-0 border border-border" onError={(e: any) => e.target.style.display='none'} /> : <div className="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center flex-shrink-0"><Package className="w-3.5 h-3.5 text-slate-400" /></div>}
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] font-bold truncate">{item.itemName?.substring(0, 40) || 'Product'}</p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className={cn("text-[9px] font-bold px-1.5 py-0.5 rounded",
                          item.totalQty <= 3 ? "text-red-600 bg-red-50 dark:bg-red-950/30" : item.totalQty <= 10 ? "text-amber-600 bg-amber-50 dark:bg-amber-950/30" : "text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30"
                        )}>{num(item.totalQty)} units</span>
                        <span className="text-[9px] font-bold text-slate-500">{cur(item.totalValue, currency)}</span>
                      </div>
                    </div>
                    {item.totalQty <= 5 && <span className="text-[8px] font-black text-red-500 border border-red-200 dark:border-red-800 px-1 py-0.5 rounded flex-shrink-0">Restock</span>}
                  </div>
                ))}
                {displayInventory.length === 0 && (
                  <div className="text-center py-4">
                    <Package className="w-8 h-8 text-slate-300 dark:text-slate-600 mx-auto mb-2" />
                    <p className="text-xs text-muted-foreground font-semibold">{inventoryTab === 'low' ? 'All products well stocked!' : 'No inventory data'}</p>
                  </div>
                )}
              </div>
              <button onClick={() => router.push('/dashboard/inventory')} className="mt-3 w-full text-[9px] font-black text-emerald-600 dark:text-emerald-400 py-1.5 border border-emerald-200 dark:border-emerald-800 rounded-lg hover:bg-emerald-50 dark:hover:bg-emerald-950/30 transition-all flex items-center justify-center gap-1">
                Manage Inventory <ArrowRight className="w-3 h-3" />
              </button>
            </div>

            {/* Returns & Cancellations */}
            <div className="glass rounded-2xl border border-border p-4 shadow-sm bg-white dark:bg-slate-900">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-black text-xs flex items-center gap-1.5 text-slate-800 dark:text-slate-200"><RotateCcw className="w-3.5 h-3.5 text-orange-500" /> Returns Overview</h3>
                <span className="text-[9px] text-muted-foreground font-bold bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-full">{startDate} - {endDate}</span>
              </div>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div className={cn("border rounded-xl p-3 text-center hover:shadow-md transition-shadow", totalReturns > 0 ? "bg-red-50 dark:bg-red-950/20 border-red-100 dark:border-red-900/50" : "bg-emerald-50 dark:bg-emerald-950/20 border-emerald-100 dark:border-emerald-900/50")}>
                  <p className={cn("text-2xl font-black", totalReturns > 0 ? "text-red-700 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400")}>{totalReturns}</p>
                  <p className={cn("text-[9px] font-bold uppercase tracking-wider mt-0.5", totalReturns > 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400")}>Returns</p>
                  <p className={cn("text-[8px] mt-1", totalReturns > 0 ? "text-red-500" : "text-emerald-600")}>Returned items</p>
                </div>
                <div className={cn("border rounded-xl p-3 text-center hover:shadow-md transition-shadow", returnRatePct > 5 ? "bg-orange-50 dark:bg-orange-950/20 border-orange-100 dark:border-orange-900/50" : "bg-emerald-50 dark:bg-emerald-950/20 border-emerald-100 dark:border-emerald-900/50")}>
                  <p className={cn("text-2xl font-black", returnRatePct > 5 ? "text-orange-700 dark:text-orange-400" : "text-emerald-700 dark:text-emerald-400")}>{returnRatePct.toFixed(2)}%</p>
                  <p className={cn("text-[9px] font-bold uppercase tracking-wider mt-0.5", returnRatePct > 5 ? "text-orange-600 dark:text-orange-400" : "text-emerald-600 dark:text-emerald-400")}>Return Rate</p>
                  <p className={cn("text-[8px] mt-1", returnRatePct > 5 ? "text-orange-500" : "text-emerald-600")}>Of units ordered</p>
                </div>
              </div>
              <div className="space-y-2">
                <p className="text-[9px] font-black text-slate-400 uppercase tracking-wider">Issue Summary</p>
                {topProblemProduct ? (
                  <div className="bg-orange-50 dark:bg-orange-950/20 border border-orange-200 dark:border-orange-900/50 rounded-xl p-3 flex items-start gap-2.5">
                    <AlertTriangle className="w-3.5 h-3.5 text-orange-500 flex-shrink-0 mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] font-bold text-orange-800 dark:text-orange-200 leading-tight truncate">{topProblemProduct.name}</p>
                      <p className="text-[8px] text-orange-600 dark:text-orange-300 mt-1 font-semibold">{topProblemProduct.count} returns {topProblemProduct.reasons && topProblemProduct.reasons.length > 0 ? `• ${topProblemProduct.reasons[0]}` : ''}</p>
                    </div>
                    <button className="text-[8px] font-black text-orange-600 dark:text-orange-400 hover:text-orange-700 flex-shrink-0 hover:underline">View</button>
                  </div>
                ) : (
                  <div className="bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900/50 rounded-xl p-3 flex items-start gap-2.5">
                    <Sparkles className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0 mt-0.5" />
                    <p className="text-[9px] font-bold text-emerald-700 dark:text-emerald-300">No returns this period. Excellent fulfillment! ✨</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right Column: AI Recommendations */}
          <div className="space-y-4">

            {/* AI Recommendations */}
            <div className="glass rounded-2xl border border-border p-4 shadow-sm bg-white dark:bg-slate-900">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-7 h-7 rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center">
                  <Bot className="w-3.5 h-3.5 text-white" />
                </div>
                <div>
                  <h3 className="font-black text-xs text-slate-800 dark:text-slate-200">AI Recommendations</h3>
                  <p className="text-[9px] text-muted-foreground font-semibold">Powered by Marketplace360</p>
                </div>
                <span className="ml-auto text-[8px] font-black bg-gradient-to-r from-violet-500 to-indigo-600 text-white px-1.5 py-0.5 rounded-full animate-pulse">{aiAlerts.length} alerts</span>
              </div>
              <div className="space-y-2">
                {aiAlerts.slice(0, 4).map((alert, i) => (
                  <div key={i} className={cn("border rounded-xl p-2.5 flex items-start gap-2", alert.color)}>
                    <span className="text-sm leading-none flex-shrink-0 mt-0.5">{alert.icon}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1 flex-wrap">
                        <p className={cn("text-[10px] font-black", alert.textColor)}>{alert.title}</p>
                        <span className={cn("text-[8px] font-black px-1 py-0.5 rounded-full bg-white/50 dark:bg-slate-900/30", alert.textColor)}>{alert.tag}</span>
                      </div>
                      <p className={cn("text-[9px] mt-0.5 leading-tight", alert.bodyColor)}>{alert.body}</p>
                    </div>
                  </div>
                ))}
              </div>
              <button onClick={() => router.push('/dashboard/ai')} className="mt-3 w-full text-[9px] font-black text-violet-600 dark:text-violet-400 py-1.5 border border-violet-200 dark:border-violet-800 rounded-lg hover:bg-violet-50 dark:hover:bg-violet-950/30 transition-all flex items-center justify-center gap-1">
                Open AI Copilot <ArrowRight className="w-3 h-3" />
              </button>
            </div>

            {/* State-wise Performance */}
            <div className="glass rounded-2xl border border-border p-4 shadow-sm bg-white dark:bg-slate-900">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-black text-xs flex items-center gap-1.5 text-slate-800 dark:text-slate-200"><MapPin className="w-3.5 h-3.5 text-teal-500" /> State Performance</h3>
                <div className="flex items-center gap-0.5 bg-slate-100 dark:bg-slate-800 p-0.5 rounded-lg">
                  <button onClick={() => setStateTab('top')} className={cn("text-[9px] font-black px-2 py-1 rounded-md transition-all", stateTab === 'top' ? "bg-white dark:bg-slate-700 shadow-sm text-emerald-600" : "text-muted-foreground hover:text-slate-600")}>Top</button>
                  <button onClick={() => setStateTab('worst')} className={cn("text-[9px] font-black px-2 py-1 rounded-md transition-all", stateTab === 'worst' ? "bg-white dark:bg-slate-700 shadow-sm text-red-500" : "text-muted-foreground hover:text-slate-600")}>Worst</button>
                </div>
              </div>
              <div className="space-y-2.5">
                {displayStates.length > 0 ? displayStates.map((s: any, i: number) => (
                  <div key={i} className="flex items-center gap-2.5">
                    <span className={cn("text-[10px] font-black w-5 h-5 flex items-center justify-center flex-shrink-0 rounded-full",
                      i === 0 ? (stateTab === 'top' ? "bg-emerald-100 text-emerald-600" : "bg-red-100 text-red-600") : "text-slate-400"
                    )}>{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] font-bold truncate text-slate-800 dark:text-slate-200">{s.state}</p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="text-[9px] font-bold bg-slate-50 dark:bg-slate-800 px-1.5 py-0.5 rounded text-slate-600 dark:text-slate-400">{cur(s.totalValue, currency)}</span>
                        <span className="text-[9px] font-bold text-teal-600 bg-teal-50 dark:bg-teal-950/30 px-1.5 py-0.5 rounded">{num(s.totalOrders)} orders</span>
                      </div>
                    </div>
                  </div>
                )) : (
                  <p className="text-xs text-muted-foreground">No state data found</p>
                )}
              </div>
            </div>

          </div>
        </div>
      </div>
      </div>

    </div>
  );
}
