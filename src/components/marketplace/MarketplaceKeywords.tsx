"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";
import { MARKETPLACE_META, generateMarketplaceBids, type MarketplaceId } from "@/lib/marketplace";
import { PageHero } from "@/components/PageHero";
import { KPICard } from "@/components/KPICard";
import { DataTable } from "@/components/DataTable";

const cur = (val: number) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val || 0))}`;

export function MarketplaceKeywords({ marketplace }: { marketplace: Exclude<MarketplaceId, "amazon"> }) {
  const meta = MARKETPLACE_META[marketplace];
  const bids = useMemo(() => generateMarketplaceBids(marketplace), [marketplace]);

  const columns = [
    {
      key: "target",
      label: "Keyword Text",
      sortable: true,
      render: (val: string, row: any) => (
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
      key: "spend",
      label: "Spend",
      sortable: true,
      render: (val: number) => cur(val),
    },
    {
      key: "sales",
      label: "Sales",
      sortable: true,
      render: (val: number) => <span className="font-extrabold text-emerald-400">{cur(val)}</span>,
    },
    {
      key: "roas",
      label: "ROAS",
      sortable: true,
      render: (val: number) => `${val.toFixed(2)}x`,
    },
    {
      key: "acos",
      label: "ACOS",
      sortable: true,
      render: (val: number) => `${val.toFixed(1)}%`,
    },
  ];

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }} className="space-y-6 pb-12">
      <PageHero
        title={`${meta.label} Keyword Performance`}
        subtitle={`Track keyword match types, bids, ACOS, and ROAS on ${meta.label}.`}
      />

      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1, duration: 0.5 }} className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <KPICard title="Total Keywords" value={bids.length.toString()} subtitle="targeted keywords" />
        <KPICard title="Total Spend" value={cur(bids.reduce((a, b) => a + b.spend, 0))} subtitle="keyword spend" />
        <KPICard title="Total Sales" value={cur(bids.reduce((a, b) => a + b.sales, 0))} subtitle="keyword sales" />
      </motion.div>

      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2, duration: 0.5 }} className="bg-popover/80 border border-border rounded-xl p-4">
        <DataTable data={bids} columns={columns as any} defaultSort="spend" />
      </motion.div>
    </motion.div>
  );
}
