"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { useDashboard } from "@/lib/DashboardContext";
import { KPICard } from "@/components/KPICard";
import { TrendChart } from "@/components/TrendChart";
import { DemoDataBanner } from "@/components/marketplace/DemoDataBanner";
import { MarketplaceLoading } from "@/components/marketplace/MarketplaceLoading";
import { generateMarketplaceOverview, MARKETPLACE_META, type MarketplaceId } from "@/lib/marketplace";
import { Package, MapPin, Star, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

const cur = (val: number) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val || 0))}`;
const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));

export function MarketplaceOverview({ marketplace }: { marketplace: Exclude<MarketplaceId, "amazon"> }) {
  const router = useRouter();
  const { startDate, endDate } = useDashboard();
  const meta = MARKETPLACE_META[marketplace];

  const overview = useMemo(
    () => (startDate && endDate ? generateMarketplaceOverview(marketplace, startDate, endDate) : null),
    [marketplace, startDate, endDate]
  );

  if (!overview) return <MarketplaceLoading />;

  const topProducts = overview.topProducts.slice(0, 5);
  const topStates = overview.states.slice(0, 5);

  return (
    <motion.div 
      initial={{ opacity: 0 }} 
      animate={{ opacity: 1 }} 
      transition={{ duration: 0.4 }}
      className="space-y-6 pb-12"
    >
      <DemoDataBanner marketplace={marketplace} />

      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-200/50 dark:border-slate-800/50 pb-4">
        <div className="flex items-center gap-3">
          <div
            className="w-11 h-11 rounded-2xl flex items-center justify-center text-white font-black text-sm shadow-md flex-shrink-0"
            style={{ background: `linear-gradient(135deg, ${meta.color}, ${meta.color}99)` }}
          >
            {meta.shortLabel}
          </div>
          <div className="space-y-0.5">
            <h1 className="text-3xl font-black tracking-tight text-slate-900 dark:text-white">{meta.label} Overview</h1>
            <p className="text-slate-500 dark:text-slate-400 text-xs">{startDate} – {endDate} · {meta.tagline}</p>
          </div>
        </div>
        <Link
          href="/dashboard/compare"
          className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-full text-xs font-bold transition-all shadow-md shadow-indigo-600/20 cursor-pointer"
        >
          Compare vs other marketplaces <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </div>

      <motion.div 
        initial={{ opacity: 0, y: 20 }} 
        animate={{ opacity: 1, y: 0 }} 
        transition={{ delay: 0.1, duration: 0.5 }}
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4"
      >
        <KPICard title="Total Sales" value={cur(overview.totalSales)} subtitle="Selected date range" trend={overview.growthPct} delay={0.02} accent="green" />
        <KPICard title="Orders" value={num(overview.totalOrders)} subtitle="Orders placed" trend={overview.growthPct * 0.6} delay={0.04} accent="blue" />
        <KPICard title="Units Sold" value={num(overview.totalUnits)} subtitle="Total units" trend={overview.growthPct * 0.5} delay={0.06} accent="purple" />
        <KPICard title="Avg Order Value" value={cur(overview.avgOrderValue)} subtitle="Per order" trend={overview.growthPct * 0.3} delay={0.08} accent="cyan" />
        <KPICard title="Return Rate" value={`${overview.returnRatePct.toFixed(1)}%`} subtitle="RTO + returns" trend={overview.returnRatePct} inverseTrend delay={0.1} accent="orange" />
      </motion.div>

      <motion.div 
        initial={{ opacity: 0, y: 20 }} 
        animate={{ opacity: 1, y: 0 }} 
        transition={{ delay: 0.2, duration: 0.5 }}
        className="grid grid-cols-1 xl:grid-cols-4 gap-4"
      >
        <div className="xl:col-span-3">
          <TrendChart
            title={`${meta.label} Sales Trend`}
            data={overview.trend}
            dataKey="sales"
            color={meta.color}
            type="area"
            height={340}
            valuePrefix="₹"
          />
        </div>
        <div className="xl:col-span-1">
          <div className="glass rounded-2xl border border-border p-5 h-full flex flex-col shadow-sm">
            <div className="flex items-center gap-2 mb-4">
              <Star className="w-4 h-4" style={{ color: meta.color }} />
              <h3 className="font-black text-sm text-slate-800 dark:text-slate-200">Seller Health</h3>
            </div>
            <div className="space-y-3 flex-1">
              <div className="bg-muted/40 rounded-xl p-3">
                <p className="text-[9px] font-bold text-muted-foreground uppercase tracking-wider">Seller Rating</p>
                <p className="text-lg font-black text-slate-800 dark:text-white">{overview.rating.toFixed(1)} / 5.0</p>
              </div>
              <div className="bg-muted/40 rounded-xl p-3">
                <p className="text-[9px] font-bold text-muted-foreground uppercase tracking-wider">Fulfilment</p>
                <p className="text-lg font-black text-slate-800 dark:text-white">Flipkart Assured</p>
              </div>
              <div className="bg-muted/40 rounded-xl p-3">
                <p className="text-[9px] font-bold text-muted-foreground uppercase tracking-wider">Connection</p>
                <p className="text-sm font-black text-amber-500">Not Connected</p>
              </div>
            </div>
          </div>
        </div>
      </motion.div>

      <motion.div 
        initial={{ opacity: 0, y: 20 }} 
        animate={{ opacity: 1, y: 0 }} 
        transition={{ delay: 0.3, duration: 0.5 }}
        className="grid grid-cols-1 lg:grid-cols-2 gap-5"
      >
        <div className="glass rounded-2xl border border-border p-4 shadow-sm bg-white dark:bg-slate-900">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-black text-xs flex items-center gap-1.5 text-slate-800 dark:text-slate-200">
              <Package className="w-3.5 h-3.5" style={{ color: meta.color }} /> Top Products
            </h3>
            <Link href={`/dashboard/${marketplace}/inventory`} className="text-[9px] font-black text-slate-400 hover:text-slate-600 uppercase tracking-wider cursor-pointer">
              View Inventory
            </Link>
          </div>
          <div className="space-y-2.5">
            {topProducts.map((p, i) => (
              <div key={p.sku} className="flex items-center gap-2.5">
                <span className={cn("text-[10px] font-black w-5 h-5 flex items-center justify-center flex-shrink-0 rounded-full", i === 0 ? "bg-amber-100 text-amber-600" : "text-slate-400")}>{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-bold truncate text-slate-800 dark:text-slate-200">{p.name}</p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[9px] font-bold bg-slate-50 dark:bg-slate-800 px-1.5 py-0.5 rounded text-slate-600 dark:text-slate-400">{num(p.units)} units</span>
                    <span className="text-[9px] font-bold text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 px-1.5 py-0.5 rounded">{cur(p.sales)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="glass rounded-2xl border border-border p-4 shadow-sm bg-white dark:bg-slate-900">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-black text-xs flex items-center gap-1.5 text-slate-800 dark:text-slate-200">
              <MapPin className="w-3.5 h-3.5" style={{ color: meta.color }} /> Top States
            </h3>
            <Link href={`/dashboard/${marketplace}/orders`} className="text-[9px] font-black text-slate-400 hover:text-slate-600 uppercase tracking-wider cursor-pointer">
              View Orders
            </Link>
          </div>
          <div className="space-y-2.5">
            {topStates.map((s, i) => (
              <div key={s.state} className="flex items-center gap-2.5">
                <span className={cn("text-[10px] font-black w-5 h-5 flex items-center justify-center flex-shrink-0 rounded-full", i === 0 ? "bg-emerald-100 text-emerald-600" : "text-slate-400")}>{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-bold truncate text-slate-800 dark:text-slate-200">{s.state}</p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[9px] font-bold bg-slate-50 dark:bg-slate-800 px-1.5 py-0.5 rounded text-slate-600 dark:text-slate-400">{cur(s.value)}</span>
                    <span className="text-[9px] font-bold text-teal-600 bg-teal-50 dark:bg-teal-950/30 px-1.5 py-0.5 rounded">{num(s.orders)} orders</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </motion.div>

      {/* Rules Engine Banner Card */}
      <motion.div 
        initial={{ opacity: 0, y: 20 }} 
        animate={{ opacity: 1, y: 0 }} 
        transition={{ delay: 0.4, duration: 0.5 }}
        className="glass rounded-2xl border border-indigo-500/20 p-5 shadow-sm bg-gradient-to-r from-indigo-100 via-indigo-50 to-white dark:from-indigo-950/20 dark:via-slate-900 dark:to-slate-950 flex flex-col md:flex-row items-center justify-between gap-4"
      >
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-black text-indigo-600 dark:text-indigo-400 uppercase tracking-wider">Automated Rules Engine</span>
            <span className="bg-emerald-500/20 text-emerald-400 text-[9px] font-bold px-2 py-0.5 rounded-full border border-emerald-500/30">Active</span>
          </div>
          <h3 className="text-base font-extrabold text-slate-900 dark:text-white">{meta.label} Automation Guardrails Enabled</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">Target ROAS auto-bidding, stock safety nets, and night-window dayparting active on your {meta.label} campaigns.</p>
        </div>
        <Link
          href={`/dashboard/${marketplace}/optimization`}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shadow-lg shadow-indigo-600/20 transition-all flex-shrink-0 cursor-pointer"
        >
          Manage Rules <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </motion.div>
    </motion.div>
  );
}
