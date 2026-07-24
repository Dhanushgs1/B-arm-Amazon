"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";
import { MARKETPLACE_META, generateMarketplaceOverview, type MarketplaceId } from "@/lib/marketplace";
import { PageHero } from "@/components/PageHero";
import { KPICard } from "@/components/KPICard";
import { TrendingUp, PieChart, Award } from "lucide-react";

const cur = (val: number) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val || 0))}`;

export function MarketplaceMarketShare({ marketplace }: { marketplace: Exclude<MarketplaceId, "amazon"> }) {
  const meta = MARKETPLACE_META[marketplace];
  const overview = useMemo(() => generateMarketplaceOverview(marketplace, "2026-07-01", "2026-07-21"), [marketplace]);

  const categories = [
    { name: "Maternity & Conception Care", share: "34%", rank: "#2 in Category", sales: cur(overview.totalSales * 0.4) },
    { name: "Baby & Infant Wellness", share: "28%", rank: "#1 in Category", sales: cur(overview.totalSales * 0.3) },
    { name: "Sensory & Speech Therapy Tools", share: "22%", rank: "#3 in Category", sales: cur(overview.totalSales * 0.2) },
    { name: "Postpartum Recovery & Comfort", share: "16%", rank: "#4 in Category", sales: cur(overview.totalSales * 0.1) },
  ];

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }} className="space-y-6 pb-12">
      <PageHero
        title={`${meta.label} Category Market Share`}
        subtitle={`Track brand category penetration, BSR rank, and market share positioning on ${meta.label}.`}
      />

      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1, duration: 0.5 }} className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <KPICard title="Category Leadership Rank" value="#2 Overall" subtext="across top niche categories" icon={Award} />
        <KPICard title="Est. Category Share" value="28.4%" subtext="market penetration" icon={PieChart} />
        <KPICard title="Monthly Growth Velocity" value={`+${overview.growthPct.toFixed(1)}%`} subtext="sales momentum" icon={TrendingUp} />
      </motion.div>

      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2, duration: 0.5 }} className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {categories.map((cat, i) => (
          <div key={i} className="p-5 rounded-2xl bg-card border border-border shadow-sm space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="font-extrabold text-sm text-slate-900 dark:text-white">{cat.name}</h4>
              <span className="text-xs font-bold text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2.5 py-0.5 rounded-full">
                {cat.rank}
              </span>
            </div>
            <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 pt-2 border-t border-border">
              <span>Category Market Share: <strong className="text-slate-900 dark:text-white">{cat.share}</strong></span>
              <span>Category Sales: <strong className="text-emerald-600 dark:text-emerald-400">{cat.sales}</strong></span>
            </div>
          </div>
        ))}
      </motion.div>
    </motion.div>
  );
}
