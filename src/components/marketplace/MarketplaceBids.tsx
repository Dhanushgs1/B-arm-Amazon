"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { 
  MARKETPLACE_META, 
  generateMarketplaceBids, 
  type MarketplaceId, 
  type MarketplaceBidTarget 
} from "@/lib/marketplace";
import { PageHero } from "@/components/PageHero";
import { KPICard } from "@/components/KPICard";
import { DataTable } from "@/components/DataTable";
import { Sliders, ArrowUpRight, ArrowDownRight, Check, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

const cur = (val: number) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val || 0))}`;

interface MarketplaceBidsProps {
  marketplace: Exclude<MarketplaceId, "amazon">;
}

export function MarketplaceBids({ marketplace }: MarketplaceBidsProps) {
  const meta = MARKETPLACE_META[marketplace];
  const [bids, setBids] = useState<MarketplaceBidTarget[]>(() => generateMarketplaceBids(marketplace));
  const [toast, setToast] = useState<string | null>(null);

  const applyBidChange = (id: string, newBid: number) => {
    setBids((prev) =>
      prev.map((b) => (b.id === id ? { ...b, currentBid: newBid, recommendation: "Optimal" } : b))
    );
    setToast(`Updated bid for target to ₹${newBid}`);
    setTimeout(() => setToast(null), 3000);
  };

  const columns = [
    {
      key: "target",
      label: "Target Keyword / Product",
      sortable: true,
      render: (val: string, row: MarketplaceBidTarget) => (
        <div>
          <span className="font-extrabold text-slate-900 dark:text-white text-xs block">{val}</span>
          <span className="text-[10px] text-slate-500 dark:text-slate-400 font-mono">{row.campaignName} ({row.matchType})</span>
        </div>
      ),
    },
    {
      key: "currentBid",
      label: "Current Bid",
      sortable: true,
      render: (val: number) => `₹${val.toFixed(2)}`,
    },
    {
      key: "suggestedBid",
      label: "Suggested Bid",
      sortable: true,
      render: (val: number, row: MarketplaceBidTarget) => (
        <span className={cn(
          "font-bold text-xs",
          row.recommendation === "Increase" ? "text-emerald-400" : row.recommendation === "Reduce" ? "text-amber-400" : "text-slate-600 dark:text-slate-300"
        )}>
          {val > 0 ? `₹${val.toFixed(2)}` : "Pause"}
        </span>
      ),
    },
    {
      key: "recommendation",
      label: "Recommendation",
      sortable: true,
      render: (val: string) => (
        <span className={cn(
          "px-2 py-0.5 rounded text-[10px] font-extrabold uppercase border",
          val === "Increase" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
          : val === "Reduce" ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
          : val === "Pause" ? "bg-red-500/10 text-red-400 border-red-500/20"
          : "bg-slate-200 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-300 dark:border-slate-700"
        )}>
          {val}
        </span>
      ),
    },
    {
      key: "spend",
      label: "Spend",
      sortable: true,
      render: (val: number) => cur(val),
    },
    {
      key: "sales",
      label: "Sales",
      sortable: true,
      render: (val: number) => cur(val),
    },
    {
      key: "roas",
      label: "ROAS",
      sortable: true,
      render: (val: number) => `${val.toFixed(2)}x`,
    },
    {
      key: "actions",
      label: "Action",
      render: (_: any, row: MarketplaceBidTarget) => (
        row.recommendation !== "Optimal" ? (
          <button
            onClick={() => applyBidChange(row.id, row.suggestedBid)}
            className="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-bold shadow transition-all cursor-pointer"
          >
            Apply Bid
          </button>
        ) : (
          <span className="text-[10px] text-slate-500 font-bold flex items-center gap-1">
            <Check className="w-3.5 h-3.5 text-emerald-400" /> Optimal
          </span>
        )
      ),
    },
  ];

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }} className="space-y-6 pb-12">
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 bg-white dark:bg-slate-900 text-slate-900 dark:text-white px-4 py-3 rounded-xl border border-indigo-500/30 text-xs font-bold shadow-2xl">
          {toast}
        </div>
      )}

      <PageHero
        title={`${meta.label} Bid Adjustment Engine`}
        subtitle={`Optimize target bids to hit your target ROAS and eliminate overbidding on ${meta.label}.`}
      />

      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1, duration: 0.5 }} className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <KPICard title="Total Bid Targets" value={bids.length.toString()} subtext="active keyword & product targets" icon={Sliders} />
        <KPICard title="Bids to Increase" value={bids.filter(b => b.recommendation === "Increase").length.toString()} subtext="high ROAS targets" icon={ArrowUpRight} />
        <KPICard title="Bids to Reduce" value={bids.filter(b => b.recommendation === "Reduce").length.toString()} subtext="high ACOS bleeder targets" icon={ArrowDownRight} />
      </motion.div>

      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2, duration: 0.5 }} className="bg-popover/80 border border-border rounded-xl p-4">
        <DataTable data={bids} columns={columns as any} defaultSortKey="spend" defaultSortDir="desc" />
      </motion.div>
    </motion.div>
  );
}
