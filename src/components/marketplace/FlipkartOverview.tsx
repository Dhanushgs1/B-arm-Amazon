"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Package, Megaphone, RotateCcw, ArrowRight, RefreshCw, TrendingUp } from "lucide-react";
import { useDashboard } from "@/lib/DashboardContext";
import { KPICard } from "@/components/KPICard";
import { TrendChart } from "@/components/TrendChart";
import { fetchFlipkartOverview } from "@/lib/flipkartData";
import { ChannelSummaryStrip } from "@/components/marketplace/ChannelSummaryStrip";
import { FlipkartBreakdowns } from "@/components/marketplace/FlipkartBreakdowns";
import { fetchFlipkartOrderSummary } from "@/lib/channelSummary";
import { cn } from "@/lib/utils";

const cur = (val: number) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val || 0))}`;
const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));
const pct = (val: number) => `${(val || 0).toFixed(2)}%`;
const fx = (val: number) => (val || 0).toFixed(2);

export function FlipkartOverview() {
  const router = useRouter();
  const { loggedInUser, startDate, endDate } = useDashboard();

  const { data: overview, isFetching } = useQuery({
    queryKey: ["flipkart-overview", loggedInUser, startDate, endDate],
    queryFn: () => fetchFlipkartOverview(loggedInUser, startDate, endDate),
    enabled: !!startDate && !!endDate,
  });

  const accountLabel = loggedInUser === "Barm" ? "Barm" : "Lkn";
  // The ads (FSN) / "Earn more" sections below come from separate uploads. With none on file for the
  // range they would only show ₹0 / 0.00% everywhere, so they are left out until that data exists;
  // the order-report sections (strip + breakdowns) always show, without waiting for this query.
  const hasAnyData = !!overview && (overview.grossSales > 0 || overview.adSpend > 0);
  // Ad data (FSN report) and retail sales (Earn More report) come from two
  // separate uploads — it's common to have one without the other yet, which
  // otherwise reads as "Gross/Net/Organic Sales are genuinely ₹0" instead of
  // "that report just isn't uploaded".
  const missingRetailSalesOnly = !!overview && overview.adSpend > 0 && !overview.hasOverallSalesData;

  return (
    <div className="space-y-6 pb-12">
      {/* Page Header — mirrors the Amazon overview page, no duplicate
          date/notification/theme chrome (TopNav already provides that). */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-200/50 dark:border-slate-800/50 pb-4">
        <div className="space-y-1">
          <h1 className="text-3xl font-black tracking-tight text-slate-900 dark:text-white">Flipkart Overview</h1>
          <p className="text-slate-500 dark:text-slate-400 text-xs">
            Business Intelligence Dashboard · {accountLabel} Flipkart Store
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-extrabold bg-indigo-500/10 text-indigo-500 px-3 py-1.5 rounded-full">
            {isFetching ? "Refreshing…" : "Synced"}
          </span>
          <button
            onClick={() => router.refresh()}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-full text-xs font-bold transition-all shadow-md shadow-indigo-600/20"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>
      </div>

      {missingRetailSalesOnly && (
        <div className="rounded-2xl border border-amber-300/40 bg-amber-50 dark:bg-amber-950/20 px-4 py-3 text-xs font-semibold text-amber-700 dark:text-amber-300 flex items-center justify-between gap-3 flex-wrap">
          <span>Ad data is in, but no "Earn more" report has been uploaded for this range yet — Gross Sales, Net Sales and Organic Sales below read ₹0 because that report is the only source with real settlement amounts (the order report alone carries no monetary columns).</span>
          <button
            onClick={() => router.push("/dashboard/flipkart/upload")}
            className="flex items-center gap-1.5 bg-amber-500/15 hover:bg-amber-500/25 text-amber-700 dark:text-amber-300 px-3 py-1.5 rounded-full text-[11px] font-bold transition-all flex-shrink-0"
          >
            Go to Upload <ArrowRight className="w-3 h-3" />
          </button>
        </div>
      )}

      <ChannelSummaryStrip channel="Flipkart" fetcher={fetchFlipkartOrderSummary} title="Sales, Orders & Returns" />

      <FlipkartBreakdowns />

      {overview && hasAnyData && (
      <>
      {/* Ads & settlement uploads (FSN / Earn more) — shown only when that data is on file */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <KPICard title="Gross Sales" value={cur(overview.grossSales)} subtitle={`${num(overview.units)} units sold`} trend={overview.growthPct ?? undefined} delay={0.02} accent="green" />
        <KPICard title="Net Sales" value={cur(overview.netSales)} subtitle="After cancels & returns" delay={0.03} accent="cyan" />
        <KPICard title="Ad Spend" value={cur(overview.adSpend)} subtitle="Advertising spend" delay={0.04} accent="pink" />
        <KPICard title="Ad Sales" value={cur(overview.adSales)} subtitle="Ads-attributed" delay={0.06} accent="blue" />
        <KPICard title="Organic Sales" value={cur(overview.organicSales)} subtitle="Non-ads revenue" delay={0.08} accent="orange" />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 xl:grid-cols-4 gap-4">
        <div className="xl:col-span-3">
          <TrendChart
            title="Overall Sales vs Ad Spend"
            data={overview.trend}
            dataKey="overallSales"
            color="#2874F0"
            type="area"
            height={340}
            valuePrefix="₹"
          />
        </div>
        <div className="xl:col-span-1">
          <div className="glass rounded-2xl border border-border p-5 h-full flex flex-col shadow-sm">
            <div className="flex items-center gap-2 mb-4">
              <TrendingUp className="w-4 h-4 text-[#2874F0]" />
              <h3 className="font-black text-sm text-slate-800 dark:text-slate-200">Ad Efficiency</h3>
            </div>
            <div className="space-y-3 flex-1">
              <div className="bg-muted/40 rounded-xl p-3">
                <p className="text-[9px] font-bold text-muted-foreground uppercase tracking-wider">ROAS</p>
                <p className="text-lg font-black text-slate-800 dark:text-white">{fx(overview.roas)}x</p>
              </div>
              <div className="bg-muted/40 rounded-xl p-3">
                <p className="text-[9px] font-bold text-muted-foreground uppercase tracking-wider">ACOS</p>
                <p className="text-lg font-black text-slate-800 dark:text-white">{pct(overview.acos)}</p>
              </div>
              <div className="bg-muted/40 rounded-xl p-3">
                <p className="text-[9px] font-bold text-muted-foreground uppercase tracking-wider">TACOS</p>
                <p className="text-lg font-black text-slate-800 dark:text-white">{pct(overview.tacos)}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Advertising Performance */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Package className="w-4 h-4 text-[#2874F0]" />
          <h2 className="text-sm font-black text-slate-800 dark:text-slate-200">Advertising Performance</h2>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
          <KPICard title="ROAS" value={`${fx(overview.roas)}x`} subtitle="Return on ad spend" delay={0.1} accent="purple" />
          <KPICard title="ACOS" value={pct(overview.acos)} subtitle="Cost of sales" inverseTrend delay={0.12} accent="pink" />
          <KPICard title="TACOS" value={pct(overview.tacos)} subtitle="Total ACOS" inverseTrend delay={0.14} accent="orange" />
          <KPICard title="CTR" value={pct(overview.ctr)} subtitle="Click-through rate" delay={0.16} accent="cyan" />
          <KPICard title="CPC" value={cur(overview.cpc)} subtitle="Cost per click" inverseTrend delay={0.18} accent="blue" />
          <KPICard title="CVR" value={pct(overview.cvr)} subtitle="Conversion rate" delay={0.2} accent="green" />
        </div>
      </div>

      {/* Quick Stats Ribbon */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-4 p-5 bg-white/40 dark:bg-slate-900/20 rounded-2xl border border-slate-200/50 dark:border-slate-800/50 text-xs backdrop-blur-sm">
        <div className="space-y-0.5 border-r border-slate-200/50 dark:border-slate-800/50 pr-2">
          <p className="text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider text-[9px]">Impressions</p>
          <p className="text-[15px] font-black text-slate-800 dark:text-white">{num(overview.impressions)}</p>
        </div>
        <div className="space-y-0.5 md:border-r border-slate-200/50 dark:border-slate-800/50 pr-2">
          <p className="text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider text-[9px]">Clicks</p>
          <p className="text-[15px] font-black text-slate-800 dark:text-white">{num(overview.clicks)}</p>
        </div>
        <div className="space-y-0.5 border-r border-slate-200/50 dark:border-slate-800/50 pr-2">
          <p className="text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider text-[9px]">Ad Orders</p>
          <p className="text-[15px] font-black text-slate-800 dark:text-white">{num(overview.adOrders)}</p>
        </div>
        <div className="space-y-0.5 md:border-r border-slate-200/50 dark:border-slate-800/50 pr-2">
          <p className="text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider text-[9px]">Cancellations</p>
          <p className="text-[15px] font-black text-red-500">{num(overview.cancelUnits)} <span className="text-[10px] text-slate-400">({cur(overview.cancelAmount)})</span></p>
        </div>
        <div className="space-y-0.5 border-r border-slate-200/50 dark:border-slate-800/50 pr-2">
          <p className="text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider text-[9px]">Returns</p>
          <p className="text-[15px] font-black text-orange-500">{num(overview.returnUnits)} <span className="text-[10px] text-slate-400">({cur(overview.returnAmount)})</span></p>
        </div>
        <div className="space-y-0.5">
          <p className="text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider text-[9px]">Net Sales</p>
          <p className="text-[15px] font-black text-emerald-600">{cur(overview.netSales)}</p>
        </div>
      </div>

      {/* Top Products + Top Campaigns */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="glass rounded-2xl border border-border p-4 shadow-sm bg-white dark:bg-slate-900">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-black text-xs flex items-center gap-1.5 text-slate-800 dark:text-slate-200">
              <Package className="w-3.5 h-3.5 text-[#2874F0]" /> Top Products
            </h3>
            <button onClick={() => router.push("/dashboard/flipkart/products")} className="text-[9px] font-black text-slate-400 hover:text-slate-600 uppercase tracking-wider cursor-pointer">
              View Products
            </button>
          </div>
          <div className="space-y-2.5">
            {overview.topProducts.length > 0 ? overview.topProducts.map((p, i) => (
              <div key={p.sku || p.name} className="flex items-center gap-2.5">
                <span className={cn("text-[10px] font-black w-5 h-5 flex items-center justify-center flex-shrink-0 rounded-full", i === 0 ? "bg-amber-100 text-amber-600" : "text-slate-400")}>{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-bold truncate text-slate-800 dark:text-slate-200">{p.name}</p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[9px] font-bold bg-slate-50 dark:bg-slate-800 px-1.5 py-0.5 rounded text-slate-600 dark:text-slate-400">{num(p.units)} units</span>
                    <span className="text-[9px] font-bold text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 px-1.5 py-0.5 rounded">{cur(p.sales)}</span>
                  </div>
                </div>
              </div>
            )) : <p className="text-xs text-muted-foreground">No product sales in selected period.</p>}
          </div>
        </div>

        <div className="glass rounded-2xl border border-border p-4 shadow-sm bg-white dark:bg-slate-900">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-black text-xs flex items-center gap-1.5 text-slate-800 dark:text-slate-200">
              <Megaphone className="w-3.5 h-3.5 text-[#2874F0]" /> Top Campaigns
            </h3>
            <button onClick={() => router.push("/dashboard/flipkart/campaigns")} className="text-[9px] font-black text-slate-400 hover:text-slate-600 uppercase tracking-wider cursor-pointer">
              View Campaigns
            </button>
          </div>
          <div className="space-y-2.5">
            {overview.topCampaigns.length > 0 ? overview.topCampaigns.map((c, i) => (
              <div key={c.name} className="flex items-center gap-2.5">
                <span className={cn("text-[10px] font-black w-5 h-5 flex items-center justify-center flex-shrink-0 rounded-full", i === 0 ? "bg-purple-100 text-purple-600" : "text-slate-400")}>{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-bold truncate text-slate-800 dark:text-slate-200">{c.name}</p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[9px] font-bold bg-slate-50 dark:bg-slate-800 px-1.5 py-0.5 rounded text-slate-600 dark:text-slate-400">{cur(c.spend)} spend</span>
                    <span className="text-[9px] font-bold text-[#10B981] bg-[#10B981]/10 px-1.5 py-0.5 rounded">{fx(c.roas)}x ROAS</span>
                  </div>
                </div>
              </div>
            )) : <p className="text-xs text-muted-foreground">No campaigns found.</p>}
          </div>
        </div>
      </div>

      {/* Returns overview */}
      <div className="glass rounded-2xl border border-border p-4 shadow-sm bg-white dark:bg-slate-900">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-black text-xs flex items-center gap-1.5 text-slate-800 dark:text-slate-200"><RotateCcw className="w-3.5 h-3.5 text-orange-500" /> Returns & Cancellations</h3>
          <span className="text-[9px] text-muted-foreground font-bold bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-full">{startDate} - {endDate}</span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className={cn("border rounded-xl p-3 text-center", overview.returnUnits > 0 ? "bg-red-50 dark:bg-red-950/20 border-red-100 dark:border-red-900/50" : "bg-emerald-50 dark:bg-emerald-950/20 border-emerald-100 dark:border-emerald-900/50")}>
            <p className={cn("text-2xl font-black", overview.returnUnits > 0 ? "text-red-700 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400")}>{overview.returnUnits}</p>
            <p className="text-[9px] font-bold uppercase tracking-wider mt-0.5">Returned Units</p>
          </div>
          <div className={cn("border rounded-xl p-3 text-center", overview.cancelUnits > 0 ? "bg-orange-50 dark:bg-orange-950/20 border-orange-100 dark:border-orange-900/50" : "bg-emerald-50 dark:bg-emerald-950/20 border-emerald-100 dark:border-emerald-900/50")}>
            <p className={cn("text-2xl font-black", overview.cancelUnits > 0 ? "text-orange-700 dark:text-orange-400" : "text-emerald-700 dark:text-emerald-400")}>{overview.cancelUnits}</p>
            <p className="text-[9px] font-bold uppercase tracking-wider mt-0.5">Cancelled Units</p>
          </div>
        </div>
      </div>
      </>
      )}

      <div className="flex justify-end">
        <button
          onClick={() => router.push("/dashboard/flipkart/reports")}
          className="flex items-center gap-1.5 text-xs font-bold text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300 transition-colors py-1.5 px-3 rounded-lg hover:bg-indigo-50 dark:hover:bg-indigo-950/30"
        >
          View Full Reports <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
