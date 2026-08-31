"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell,
} from "recharts";
import { motion } from "framer-motion";
import { ScoreRing } from "@/components/ScoreRing";
import { QueryErrorState } from "@/components/QueryErrorState";
import { useDashboard } from "@/lib/DashboardContext";
import { mcp, mcpAllPages, fetchUnifiedDailyTrend, type UnifiedTrendPoint } from "@/lib/api";
import { generateMarketplaceOverview, generateMarketplaceRules, MARKETPLACE_META, computeGrowthPct, type MarketplaceId } from "@/lib/marketplace";
import { fetchFlipkartOverview } from "@/lib/flipkartData";
import { Loader2, Trophy, TrendingUp, TrendingDown, ArrowRight, FlaskConical, ShieldCheck, Wand2, ShoppingBag, DollarSign, Package, CheckCircle2, Sliders, Sparkles, Brain, Zap, Bot, GitCompare } from "lucide-react";
import { cn } from "@/lib/utils";
import Link from "next/link";

const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));
const curWith = (sym: string) => (val: number) => `${sym}${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val || 0))}`;

interface Row {
  id: MarketplaceId;
  label: string;
  color: string;
  totalSales: number;
  units: number;
  orders: number;
  returnRatePct: number;
  growthPct: number | null;
  isDemo: boolean;
  adSpend: number;
  adSales: number;
  acos: number;
  roas: number;
  tacos: number;
}

export default function ComparePage() {
  const router = useRouter();
  const { keySlot, loggedInUser, startDate, endDate, account, contextLoading } = useDashboard();

  const baseArgs = {
    amazon_account_id: account?.id,
    workspace_id: account?.workspace_id,
    start_date: startDate,
    end_date: endDate,
  };
  const currencySymbol = account?.currency === "USD" ? "$" : "₹";
  const cur = curWith(currencySymbol);

  // Every page of retail rows, not just the first 200 — and the Amazon-side totals below are
  // SUMMED from each row's own totalSales/adSales/adSpend, never trusted from this endpoint's
  // `summary` object, which was found to disagree badly with the true total for at least one
  // account/date-range (same bug fixed in the main Overview dashboard).
  const { data: retailRows, isLoading: retailLoading, isError: retailError, refetch: refetchRetail } = useQuery({
    queryKey: ["compare_retail", keySlot, account?.id, startDate, endDate],
    queryFn: () => mcpAllPages("get_retail_product_performance", baseArgs, keySlot),
    enabled: !!account,
  });

  const { data: dailyTrend, isLoading: trendLoading } = useQuery<UnifiedTrendPoint[]>({
    queryKey: ["compare_trend", keySlot, account?.id, startDate, endDate],
    queryFn: () => fetchUnifiedDailyTrend(baseArgs, keySlot),
    enabled: !!account,
  });

  const { data: returnsData } = useQuery({
    queryKey: ["compare_returns", keySlot, account?.id, startDate, endDate],
    queryFn: async () => {
      const all: Record<string, unknown>[] = [];
      for (let page = 0; page < 10; page++) {
        const res = await mcp("get_fba_customer_returns", { ...baseArgs, page, page_size: 500 }, keySlot);
        const rows = res.order_returns || [];
        all.push(...rows);
        if (!res.pagination?.hasMore || rows.length === 0) break;
      }
      return all;
    },
    enabled: !!account,
  });

  const { data: flipkartReal, isLoading: flipkartLoading } = useQuery({
    queryKey: ["flipkart-overview", loggedInUser, startDate, endDate],
    queryFn: () => fetchFlipkartOverview(loggedInUser, startDate, endDate),
    enabled: !!startDate && !!endDate,
  });

  const rows: Row[] = useMemo(() => {
    if (!startDate || !endDate) return [];

    let amazonSales = 0, amazonAdSales = 0, amazonAdSpend = 0, amazonUnits = 0;
    for (const r of retailRows || []) {
      amazonSales += r.totalSales || 0;
      amazonAdSales += r.adSales || 0;
      amazonAdSpend += r.adSpend || 0;
      amazonUnits += r.unitsOrdered || 0;
    }
    const amazonOrders = Math.round(amazonUnits / 1.3);
    const amazonReturns = (returnsData || []).length;
    const amazonReturnRate = amazonUnits > 0 ? (amazonReturns / amazonUnits) * 100 : 0;
    const amazonGrowth = computeGrowthPct((dailyTrend || []).map((d) => d.overallSales || 0));

    const amazonAcos = amazonAdSales > 0 ? (amazonAdSpend / amazonAdSales) * 100 : 0;
    const amazonRoas = amazonAdSpend > 0 ? amazonAdSales / amazonAdSpend : 0;
    const amazonTacos = amazonSales > 0 ? (amazonAdSpend / amazonSales) * 100 : 0;

    const flipkartDemo = generateMarketplaceOverview("flipkart", startDate, endDate);
    const hasRealFlipkart = flipkartReal && (flipkartReal.grossSales > 0 || flipkartReal.adSpend > 0);

    const flipkartSales = hasRealFlipkart ? flipkartReal.grossSales : flipkartDemo.totalSales;
    const flipkartUnits = hasRealFlipkart ? flipkartReal.units : flipkartDemo.totalUnits;
    const flipkartOrders = hasRealFlipkart ? flipkartReal.adOrders || Math.round(flipkartReal.units / 1.3) : flipkartDemo.totalOrders;
    const flipkartReturns = hasRealFlipkart ? flipkartReal.returnUnits : 0;
    const flipkartReturnRate = hasRealFlipkart ? (flipkartReal.units > 0 ? (flipkartReal.returnUnits / flipkartReal.units) * 100 : 0) : flipkartDemo.returnRatePct;
    const flipkartGrowth = hasRealFlipkart ? flipkartReal.growthPct : flipkartDemo.growthPct;

    const flipkartAdSpend = hasRealFlipkart ? flipkartReal.adSpend : (flipkartSales * 0.1);
    const flipkartAdSales = hasRealFlipkart ? flipkartReal.adSales : (flipkartSales * 0.28);
    const flipkartAcos = hasRealFlipkart ? flipkartReal.acos : 35.7;
    const flipkartRoas = hasRealFlipkart ? flipkartReal.roas : 2.8;
    const flipkartTacos = hasRealFlipkart ? flipkartReal.tacos : 10.0;

    return [
      {
        id: "amazon",
        label: "Amazon",
        color: MARKETPLACE_META.amazon.color,
        totalSales: amazonSales,
        units: amazonUnits,
        orders: amazonOrders,
        returnRatePct: amazonReturnRate,
        growthPct: amazonGrowth,
        isDemo: false,
        adSpend: amazonAdSpend,
        adSales: amazonAdSales,
        acos: amazonAcos,
        roas: amazonRoas,
        tacos: amazonTacos
      },
      {
        id: "flipkart",
        label: "Flipkart",
        color: MARKETPLACE_META.flipkart.color,
        totalSales: flipkartSales,
        units: flipkartUnits,
        orders: flipkartOrders,
        returnRatePct: flipkartReturnRate,
        growthPct: flipkartGrowth,
        isDemo: !hasRealFlipkart,
        adSpend: flipkartAdSpend,
        adSales: flipkartAdSales,
        acos: flipkartAcos,
        roas: flipkartRoas,
        tacos: flipkartTacos
      },
    ];
  }, [retailRows, dailyTrend, returnsData, flipkartReal, startDate, endDate]);


  const scored = useMemo(() => {
    if (rows.length === 0) return [];
    const norm = (vals: number[], v: number, invert = false) => {
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      if (max === min) return 0.5;
      const n = (v - min) / (max - min);
      return invert ? 1 - n : n;
    };
    const sales = rows.map((r) => r.totalSales);
    // Missing-data rows (null) score as neutral (0) for this component only —
    // the health score still needs a number to rank against; the growth
    // figure shown to the user stays "no data", never a fabricated 0%.
    const growth = rows.map((r) => r.growthPct ?? 0);
    const returns = rows.map((r) => r.returnRatePct);

    return rows
      .map((r) => ({
        ...r,
        score:
          norm(sales, r.totalSales) * 0.5 +
          norm(growth, r.growthPct ?? 0) * 0.3 +
          norm(returns, r.returnRatePct, true) * 0.2,
      }))
      .sort((a, b) => b.score - a.score);
  }, [rows]);

  const best = scored[0];
  const totalSalesCombined = useMemo(() => rows.reduce((sum, r) => sum + r.totalSales, 0), [rows]);
  const totalOrdersCombined = useMemo(() => rows.reduce((sum, r) => sum + r.orders, 0), [rows]);
  const totalUnitsCombined = useMemo(() => rows.reduce((sum, r) => sum + r.units, 0), [rows]);

  const fkRules = useMemo(() => generateMarketplaceRules("flipkart"), []);
  const totalActiveRules = fkRules.filter(r => r.enabled).length + 8; // 8 Amazon active rules

  const isLoading = contextLoading || retailLoading || trendLoading || flipkartLoading;

  // Generate AI suggestions based on live data — must run before the loading
  // guard below so this hook is called on every render (Rules of Hooks: the
  // guard's early return can't skip a hook that a later render still calls).
  const aiInsights = useMemo(() => {
    if (!rows || rows.length < 2) return [];
    const [amz, fk] = rows;
    const insights: string[] = [];
    if (amz.roas > 0 && fk.roas > 0) {
      const better = amz.roas > fk.roas ? "Amazon" : "Flipkart";
      const ratio = Math.max(amz.roas, fk.roas) / Math.min(amz.roas, fk.roas);
      insights.push(`${better} delivers ${ratio.toFixed(1)}x better ROAS — consider reallocating ad budget toward ${better}.`);
    }
    if (amz.acos > 0 && fk.acos > 0) {
      const lower = amz.acos < fk.acos ? "Amazon" : "Flipkart";
      insights.push(`${lower} has lower ACOS (${Math.min(amz.acos, fk.acos).toFixed(1)}%) — efficiency is better there; scale it up.`);
    }
    const totalSpend = amz.adSpend + fk.adSpend;
    if (totalSpend > 0) {
      insights.push(`Combined ad spend is ₹${num(totalSpend)}. Use the AI Assistant to get a full optimization breakdown.`);
    }
    if (amz.returnRatePct > 5 || fk.returnRatePct > 5) {
      const high = amz.returnRatePct > fk.returnRatePct ? "Amazon" : "Flipkart";
      insights.push(`${high} return rate is elevated. Review product listings and packaging quality.`);
    }
    return insights.slice(0, 3);
  }, [rows]);

  if (isLoading || rows.length === 0) {
    return (
      <div className="flex h-[60vh] items-center justify-center flex-col gap-4 text-muted-foreground">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <p className="font-semibold text-sm">Combining marketplace metrics...</p>
      </div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }} className="space-y-6 pb-12">
      {retailError && (
        <QueryErrorState
          compact
          message="Amazon retail performance data couldn't load — retry, or the sales/ACOS numbers below may be incomplete rather than genuinely zero."
          onRetry={() => refetchRetail()}
        />
      )}

      {/* Premium Header */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-indigo-900 via-purple-900 to-slate-900 p-6 border border-indigo-500/30 shadow-xl">
        <div className="absolute inset-0 bg-gradient-to-r from-indigo-600/10 via-transparent to-purple-600/10" />
        <div className="absolute -top-12 -right-12 w-48 h-48 rounded-full bg-indigo-500/10 blur-3xl" />
        <div className="absolute -bottom-8 -left-8 w-36 h-36 rounded-full bg-purple-500/10 blur-3xl" />
        <div className="relative flex items-start justify-between flex-wrap gap-4">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-xl bg-white/10 flex items-center justify-center">
                <GitCompare className="w-4 h-4 text-indigo-300" />
              </div>
              <span className="text-indigo-300 text-[10px] font-black uppercase tracking-widest">Combined Overview</span>
            </div>
            <h1 className="text-2xl font-black tracking-tight text-white">Marketplace Intelligence Dashboard</h1>
            <p className="text-indigo-300/80 text-xs mt-1 font-semibold">{startDate} – {endDate} · Amazon + Flipkart Aggregated</p>
          </div>
          <Link
            href="/dashboard/ai"
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/10 hover:bg-white/20 border border-white/20 text-white text-xs font-black transition-all shadow-md hover:scale-105 flex-shrink-0"
          >
            <Brain className="w-3.5 h-3.5 text-indigo-300" />
            Ask AI Assistant
            <ArrowRight className="w-3 h-3" />
          </Link>
        </div>

        {/* AI Insight Strip */}
        {aiInsights.length > 0 && (
          <div className="relative mt-4 space-y-2">
            <p className="text-[10px] font-extrabold uppercase tracking-widest text-indigo-400 flex items-center gap-1.5">
              <Sparkles className="w-3 h-3" /> AI-Powered Insights
            </p>
            {aiInsights.map((insight, i) => (
              <div key={i} className="flex items-start gap-2.5 bg-white/5 rounded-xl px-3 py-2.5 border border-white/10">
                <Zap className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 mt-0.5" />
                <p className="text-white/80 text-[12px] font-medium leading-relaxed">{insight}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Combined Top KPI Strip */}
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1, duration: 0.5 }}>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="p-5 rounded-2xl bg-gradient-to-br from-indigo-900/90 via-purple-900/80 to-slate-950 text-white border border-indigo-500/30 shadow-lg">
            <div className="flex items-center justify-between text-indigo-300 mb-2">
              <span className="text-[10px] font-extrabold uppercase tracking-wider text-indigo-200">Total Combined Sales</span>
              <DollarSign className="w-4 h-4" />
            </div>
            <p className="text-3xl font-black text-white">₹{num(totalSalesCombined)}</p>
            <p className="text-[10px] font-bold text-emerald-400 mt-1">Across 2 Marketplaces</p>
          </div>

          <div className="p-5 rounded-2xl bg-card border border-border shadow-sm">
            <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 mb-2">
              <span className="text-[10px] font-extrabold uppercase tracking-wider">Total Combined Orders</span>
              <ShoppingBag className="w-4 h-4 text-blue-500" />
            </div>
            <p className="text-2xl font-black text-slate-900 dark:text-white">{num(totalOrdersCombined)}</p>
            <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">Orders fulfilled across channels</p>
          </div>

          <div className="p-5 rounded-2xl bg-card border border-border shadow-sm">
            <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 mb-2">
              <span className="text-[10px] font-extrabold uppercase tracking-wider">Total Units Sold</span>
              <Package className="w-4 h-4 text-purple-500" />
            </div>
            <p className="text-2xl font-black text-slate-900 dark:text-white">{num(totalUnitsCombined)}</p>
            <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">Product items shipped</p>
          </div>

          <div className="p-5 rounded-2xl bg-card border border-border shadow-sm">
            <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 mb-2">
              <span className="text-[10px] font-extrabold uppercase tracking-wider">Active Automation Rules</span>
              <ShieldCheck className="w-4 h-4 text-emerald-500" />
            </div>
            <p className="text-2xl font-black text-emerald-600 dark:text-emerald-400">{totalActiveRules} Rules Active</p>
            <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">Amazon + Flipkart Guardrails</p>
          </div>
        </div>
      </motion.div>

      {/* Best-performing marketplace banner */}
      {best && (
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15, duration: 0.5 }}>
          <div
            className="relative overflow-hidden rounded-2xl border p-5 flex items-center gap-4 flex-wrap shadow-sm"
            style={{ borderColor: `${best.color}40`, background: `linear-gradient(120deg, ${best.color}14, transparent)` }}
          >
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center flex-shrink-0 shadow-md text-white" style={{ background: best.color }}>
              <Trophy className="w-6 h-6 text-white" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400">Highest Revenue Channel</p>
              <p className="text-xl font-black text-slate-900 dark:text-white">
                {best.label} {best.isDemo && <span className="text-xs font-bold text-amber-500 align-middle">(demo mode)</span>}
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400 font-semibold mt-0.5">
                Ranked on total sales, growth trend and return rate for {startDate} – {endDate}.
              </p>
            </div>
            <button
              onClick={() => router.push(best.id === "amazon" ? "/dashboard" : `/dashboard/${best.id}`)}
              className="flex items-center gap-1.5 text-white px-4 py-2 rounded-xl text-xs font-bold transition-all shadow-sm hover:opacity-90 flex-shrink-0 cursor-pointer"
              style={{ background: best.color }}
            >
              Open {best.label} <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </motion.div>
      )}

      {/* Side-by-side KPI cards */}
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2, duration: 0.5 }}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {rows.map((r) => {
            const share = totalSalesCombined ? (r.totalSales / totalSalesCombined) * 100 : 0;
            return (
              <div key={r.id} className="glass card-glow rounded-2xl border p-5 shadow-sm space-y-3 bg-card" style={{ borderColor: `${r.color}30` }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white font-black text-[11px]" style={{ background: r.color }}>
                      {MARKETPLACE_META[r.id].shortLabel}
                    </div>
                    <h3 className="font-black text-sm text-slate-900 dark:text-slate-100">{r.label}</h3>
                  </div>
                  {r.isDemo ? (
                    <span className="text-[9px] font-black text-amber-500 bg-amber-500/10 px-2 py-0.5 rounded-full border border-amber-500/20">DEMO</span>
                  ) : (
                    <span className="text-[9px] font-black text-emerald-500 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">LIVE</span>
                  )}
                </div>

                <div>
                  <p className="text-2xl font-black text-slate-900 dark:text-white">₹{num(r.totalSales)}</p>
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 font-bold uppercase tracking-wider">Channel Share: {share.toFixed(1)}%</p>
                  <div className="w-full bg-slate-200 dark:bg-slate-800 rounded-full h-1.5 mt-1">
                    <div className="h-1.5 rounded-full transition-all duration-700" style={{ width: `${share}%`, background: r.color }} />
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 pt-1">
                  <div className="bg-slate-100 dark:bg-slate-900/60 rounded-xl p-2 text-center">
                    <p className="text-[8px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Orders</p>
                    <p className="text-xs font-black text-slate-900 dark:text-white">{num(r.orders)}</p>
                  </div>
                  <div className="bg-slate-100 dark:bg-slate-900/60 rounded-xl p-2 text-center">
                    <p className="text-[8px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Returns</p>
                    <p className="text-xs font-black text-slate-900 dark:text-white">{r.returnRatePct.toFixed(1)}%</p>
                  </div>
                  <div className="bg-slate-100 dark:bg-slate-900/60 rounded-xl p-2 text-center">
                    <p className="text-[8px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Growth</p>
                    {r.growthPct == null ? (
                      <p className="text-xs font-black text-slate-400">— no data</p>
                    ) : (
                      <p className={cn("text-xs font-black flex items-center justify-center gap-0.5", r.growthPct >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-500")}>
                        {r.growthPct >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                        {Math.abs(r.growthPct).toFixed(1)}%
                      </p>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </motion.div>

      {/* Comparison chart */}
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3, duration: 0.5 }}>
        <div className="glass rounded-2xl border border-border p-6 shadow-sm bg-card">
          <h3 className="text-base font-extrabold mb-4 tracking-tight text-slate-900 dark:text-white">Total Sales Contribution by Marketplace</h3>
          <div style={{ width: "100%", height: 300 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" opacity={0.4} />
                <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: "var(--muted-foreground)", fontWeight: 700 }} />
                <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} tickFormatter={(v) => (v >= 100000 ? `${(v / 1000).toFixed(0)}k` : v)} />
                <Tooltip
                  cursor={{ fill: "rgba(108,99,255,0.06)" }}
                  contentStyle={{ backgroundColor: "var(--card)", borderRadius: "14px", border: "1px solid var(--border)", fontSize: "12px", fontWeight: "bold" }}
                  formatter={(value) => [`₹${num(Number(value) || 0)}`, "Total Sales"]}
                />
                <Bar dataKey="totalSales" radius={[8, 8, 0, 0]} maxBarSize={90}>
                  {rows.map((r) => (
                    <Cell key={r.id} fill={r.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </motion.div>

      {/* Advertising & PPC Efficiency Comparison */}
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35, duration: 0.5 }}>
        <div className="glass rounded-2xl border border-border p-6 shadow-sm bg-card">
          <h3 className="text-base font-extrabold mb-4 tracking-tight text-slate-900 dark:text-white">Advertising &amp; PPC Efficiency Comparison</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {rows.map((r) => (
              <div key={r.id + "_ads"} className="space-y-4 p-5 rounded-2xl border border-slate-200/60 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 transition-all hover:shadow-md">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-xl flex items-center justify-center text-white font-black text-[10px]" style={{ background: r.color }}>
                    {MARKETPLACE_META[r.id].shortLabel}
                  </div>
                  <span className="font-extrabold text-sm text-slate-800 dark:text-slate-200">{r.label} Ads Performance</span>
                </div>
                
                <div className="grid grid-cols-2 gap-4 pt-2">
                  <div>
                    <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Ad Spend</p>
                    <p className="text-lg font-black text-slate-900 dark:text-white">₹{num(r.adSpend)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Ad Sales</p>
                    <p className="text-lg font-black text-slate-900 dark:text-white">₹{num(r.adSales)}</p>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 pt-3 border-t border-slate-200/50 dark:border-slate-800/50">
                  <div className="text-center p-2.5 bg-card border border-border rounded-xl">
                    <p className="text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">ROAS</p>
                    <p className="text-sm font-black text-indigo-600 dark:text-indigo-400">{r.roas.toFixed(2)}x</p>
                  </div>
                  <div className="text-center p-2.5 bg-card border border-border rounded-xl">
                    <p className="text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">ACOS</p>
                    <p className="text-sm font-black text-pink-500">{r.acos.toFixed(1)}%</p>
                  </div>
                  <div className="text-center p-2.5 bg-card border border-border rounded-xl">
                    <p className="text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">TACOS</p>
                    <p className="text-sm font-black text-orange-500">{r.tacos.toFixed(1)}%</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </motion.div>

      {/* Marketplace Health Scores */}
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4, duration: 0.5 }}>
        <div className="glass rounded-2xl border border-border p-6 shadow-sm bg-card">
          <h3 className="text-base font-extrabold mb-4 tracking-tight text-slate-900 dark:text-white">Marketplace Health Scores</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {scored.map((r) => (
              <div key={r.id} className="flex items-center gap-4 p-4 rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800">
                <ScoreRing value={Math.round((r.score || 0) * 100)} label={r.label} color={r.color} />
                <div>
                  <p className="font-black text-sm text-slate-900 dark:text-white">{r.label}</p>
                  <p className="text-[10px] text-slate-500 dark:text-slate-400">Health Score: {Math.round((r.score || 0) * 100)}%</p>
                  <p className="text-[10px] font-bold mt-0.5" style={{ color: r.color }}>
                    Growth: {r.growthPct == null ? "no data" : `${r.growthPct >= 0 ? "+" : ""}${r.growthPct.toFixed(1)}%`}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
