"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell,
} from "recharts";
import { useDashboard } from "@/lib/DashboardContext";
import { mcp, fetchUnifiedDailyTrend, type UnifiedTrendPoint } from "@/lib/api";
import { generateMarketplaceOverview, MARKETPLACE_META, computeGrowthPct, type MarketplaceId } from "@/lib/marketplace";
import { Loader2, Trophy, TrendingUp, TrendingDown, ArrowRight, FlaskConical } from "lucide-react";
import { cn } from "@/lib/utils";

const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));
const curWith = (sym: string) => (val: number) => `${sym}${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val || 0))}`;

interface Row {
  id: MarketplaceId;
  label: string;
  color: string;
  totalSales: number;
  units: number;
  returnRatePct: number;
  growthPct: number;
  isDemo: boolean;
}

export default function ComparePage() {
  const router = useRouter();
  const { keySlot, startDate, endDate, account, contextLoading } = useDashboard();

  const baseArgs = {
    amazon_account_id: account?.id,
    workspace_id: account?.workspace_id,
    start_date: startDate,
    end_date: endDate,
  };
  const currencySymbol = account?.currency === "USD" ? "$" : "₹";
  const cur = curWith(currencySymbol);

  const { data: retailData, isLoading: retailLoading } = useQuery({
    queryKey: ["compare_retail", keySlot, account?.id, startDate, endDate],
    queryFn: () => mcp("get_retail_product_performance", { ...baseArgs, page_size: 200 }, keySlot),
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

  const rows: Row[] = useMemo(() => {
    if (!startDate || !endDate) return [];

    const rs = retailData?.summary || {};
    const amazonUnits = rs.totalUnitsOrdered || 0;
    const amazonSales = rs.totalSales || 0;
    const amazonReturns = (returnsData || []).length;
    const amazonReturnRate = amazonUnits > 0 ? (amazonReturns / amazonUnits) * 100 : 0;
    const amazonGrowth = computeGrowthPct((dailyTrend || []).map((d) => d.overallSales || 0));

    const flipkart = generateMarketplaceOverview("flipkart", startDate, endDate);
    const meesho = generateMarketplaceOverview("meesho", startDate, endDate);

    return [
      { id: "amazon", label: "Amazon", color: MARKETPLACE_META.amazon.color, totalSales: amazonSales, units: amazonUnits, returnRatePct: amazonReturnRate, growthPct: amazonGrowth, isDemo: false },
      { id: "flipkart", label: "Flipkart", color: MARKETPLACE_META.flipkart.color, totalSales: flipkart.totalSales, units: flipkart.totalUnits, returnRatePct: flipkart.returnRatePct, growthPct: flipkart.growthPct, isDemo: true },
      { id: "meesho", label: "Meesho", color: MARKETPLACE_META.meesho.color, totalSales: meesho.totalSales, units: meesho.totalUnits, returnRatePct: meesho.returnRatePct, growthPct: meesho.growthPct, isDemo: true },
    ];
  }, [retailData, dailyTrend, returnsData, startDate, endDate]);

  // Composite score: sales (weight 0.5) + growth (0.3) + low return rate (0.2),
  // each metric min-max normalized across the 3 marketplaces so a single
  // outlier doesn't dominate — same weighting logic for every marketplace.
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
    const growth = rows.map((r) => r.growthPct);
    const returns = rows.map((r) => r.returnRatePct);

    return rows
      .map((r) => ({
        ...r,
        score:
          norm(sales, r.totalSales) * 0.5 +
          norm(growth, r.growthPct) * 0.3 +
          norm(returns, r.returnRatePct, true) * 0.2,
      }))
      .sort((a, b) => b.score - a.score);
  }, [rows]);

  const best = scored[0];
  const totalSalesAll = rows.reduce((sum, r) => sum + r.totalSales, 0);
  const isLoading = contextLoading || retailLoading || trendLoading;

  if (isLoading || rows.length === 0) {
    return (
      <div className="flex h-[60vh] items-center justify-center flex-col gap-4 text-muted-foreground">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <p className="font-semibold text-sm">Comparing marketplaces...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-12">
      {/* Demo data disclosure — Flipkart & Meesho aren't connected yet */}
      <div className="flex items-center gap-3 rounded-2xl border border-amber-300/40 bg-amber-500/5 px-5 py-3.5">
        <FlaskConical className="w-4 h-4 text-amber-500 flex-shrink-0" />
        <p className="text-xs font-semibold text-amber-700 dark:text-amber-400">
          Amazon figures below are live from SellerMate. Flipkart &amp; Meesho are demo data until you connect their Seller/Supplier API keys in{" "}
          <button onClick={() => router.push("/dashboard/settings")} className="underline font-bold hover:text-amber-800">Settings</button>.
        </p>
      </div>

      <div className="space-y-1 border-b border-slate-200/50 dark:border-slate-800/50 pb-4">
        <h1 className="text-3xl font-black tracking-tight text-slate-900 dark:text-white">Marketplace Comparison</h1>
        <p className="text-slate-500 dark:text-slate-400 text-xs">{startDate} – {endDate} · Amazon vs Flipkart vs Meesho</p>
      </div>

      {/* Best-performing marketplace banner */}
      {best && (
        <div
          className="relative overflow-hidden rounded-2xl border p-5 flex items-center gap-4 flex-wrap shadow-sm"
          style={{ borderColor: `${best.color}40`, background: `linear-gradient(120deg, ${best.color}14, transparent)` }}
        >
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center flex-shrink-0 shadow-md" style={{ background: best.color }}>
            <Trophy className="w-6 h-6 text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Best Performing Marketplace</p>
            <p className="text-xl font-black text-slate-900 dark:text-white">
              {best.label} {best.isDemo && <span className="text-xs font-bold text-amber-500 align-middle">(demo data)</span>}
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400 font-semibold mt-0.5">
              Ranked on total sales, growth trend and return rate for {startDate} – {endDate}.
            </p>
          </div>
          <button
            onClick={() => router.push(best.id === "amazon" ? "/dashboard" : `/dashboard/${best.id}`)}
            className="flex items-center gap-1.5 text-white px-4 py-2 rounded-xl text-xs font-bold transition-all shadow-sm hover:opacity-90 flex-shrink-0"
            style={{ background: best.color }}
          >
            Open {best.label} <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Side-by-side KPI cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {rows.map((r) => {
          const share = totalSalesAll ? (r.totalSales / totalSalesAll) * 100 : 0;
          return (
            <div key={r.id} className="glass rounded-2xl border p-5 shadow-sm space-y-3" style={{ borderColor: `${r.color}30` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white font-black text-[11px]" style={{ background: r.color }}>
                    {MARKETPLACE_META[r.id].shortLabel}
                  </div>
                  <h3 className="font-black text-sm text-slate-800 dark:text-slate-200">{r.label}</h3>
                </div>
                {r.isDemo ? (
                  <span className="text-[9px] font-black text-amber-500 bg-amber-500/10 px-2 py-0.5 rounded-full">DEMO</span>
                ) : (
                  <span className="text-[9px] font-black text-emerald-500 bg-emerald-500/10 px-2 py-0.5 rounded-full">LIVE</span>
                )}
              </div>

              <div>
                <p className="text-2xl font-black text-slate-900 dark:text-white">{r.id === "amazon" ? cur(r.totalSales) : `₹${num(r.totalSales)}`}</p>
                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Total Sales · {share.toFixed(0)}% of combined</p>
              </div>

              <div className="grid grid-cols-3 gap-2 pt-1">
                <div className="bg-muted/40 rounded-xl p-2 text-center">
                  <p className="text-[8px] font-bold text-muted-foreground uppercase tracking-wider">Units</p>
                  <p className="text-xs font-black text-slate-800 dark:text-white">{num(r.units)}</p>
                </div>
                <div className="bg-muted/40 rounded-xl p-2 text-center">
                  <p className="text-[8px] font-bold text-muted-foreground uppercase tracking-wider">Returns</p>
                  <p className="text-xs font-black text-slate-800 dark:text-white">{r.returnRatePct.toFixed(1)}%</p>
                </div>
                <div className="bg-muted/40 rounded-xl p-2 text-center">
                  <p className="text-[8px] font-bold text-muted-foreground uppercase tracking-wider">Growth</p>
                  <p className={cn("text-xs font-black flex items-center justify-center gap-0.5", r.growthPct >= 0 ? "text-emerald-600" : "text-red-500")}>
                    {r.growthPct >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                    {Math.abs(r.growthPct).toFixed(1)}%
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Comparison chart */}
      <div className="glass rounded-2xl border border-border p-6 shadow-sm">
        <h3 className="text-base font-extrabold mb-4 tracking-tight">Total Sales by Marketplace</h3>
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
        {account?.currency && account.currency !== "INR" && (
          <p className="text-[10px] text-slate-400 font-semibold mt-3">
            Note: Amazon is shown in {account.currency}, while Flipkart &amp; Meesho are India-only marketplaces reported in INR — treat the bar heights as directional, not a currency-matched comparison.
          </p>
        )}
      </div>
    </div>
  );
}
