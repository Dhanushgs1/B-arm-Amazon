"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";
import { MARKETPLACE_META, generateMarketplaceBids, type MarketplaceId } from "@/lib/marketplace";
import { PageHero } from "@/components/PageHero";
import { KPICard } from "@/components/KPICard";
import { DataTable } from "@/components/DataTable";
import { Search, Ban, TrendingUp, DollarSign } from "lucide-react";

const cur = (val: number) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val || 0))}`;
const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));

export function MarketplaceSearchTerms({ marketplace }: { marketplace: Exclude<MarketplaceId, "amazon"> }) {
  const meta = MARKETPLACE_META[marketplace];
  const bids = useMemo(() => generateMarketplaceBids(marketplace), [marketplace]);

  const searchTerms = useMemo(() => {
    return bids.flatMap((b) => [
      {
        id: `${b.id}-ST1`,
        searchTerm: `${b.target} online buy`,
        campaignName: b.campaignName,
        clicks: 34,
        orders: 5,
        spend: Math.round(b.spend * 0.7),
        sales: b.sales,
        acos: b.acos,
        isWasted: false,
      },
      {
        id: `${b.id}-ST2`,
        searchTerm: `cheap free ${b.target}`,
        campaignName: b.campaignName,
        clicks: 18,
        orders: 0,
        spend: Math.round(b.spend * 0.3),
        sales: 0,
        acos: 0,
        isWasted: true,
      },
    ]);
  }, [bids]);

  const wastedSpend = searchTerms.filter(s => s.isWasted).reduce((a, s) => a + s.spend, 0);

  const columns = [
    {
      key: "searchTerm",
      label: "Customer Search Term",
      sortable: true,
      render: (val: string, row: any) => (
        <div>
          <span className="font-extrabold text-slate-900 dark:text-white text-xs block">{val}</span>
          <span className="text-[10px] text-slate-500 dark:text-slate-400 font-mono">{row.campaignName}</span>
        </div>
      ),
    },
    {
      key: "clicks",
      label: "Clicks",
      sortable: true,
      render: (val: number) => num(val),
    },
    {
      key: "orders",
      label: "Orders",
      sortable: true,
      render: (val: number) => num(val),
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
      key: "isWasted",
      label: "Status",
      render: (val: boolean) => (
        val ? (
          <span className="px-2 py-0.5 rounded text-[10px] font-extrabold bg-red-500/10 text-red-400 border border-red-500/20">
            Wasted Search Term
          </span>
        ) : (
          <span className="px-2 py-0.5 rounded text-[10px] font-extrabold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            Converting Term
          </span>
        )
      ),
    },
  ];

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }} className="space-y-6 pb-12">
      <PageHero
        title={`${meta.label} Search Term Query Analytics`}
        subtitle={`Discover high-converting buyer queries and catch zero-conversion search terms on ${meta.label}.`}
      />

      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1, duration: 0.5 }} className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <KPICard title="Total Search Terms" value={searchTerms.length.toString()} subtext="customer queries logged" icon={Search} />
        <KPICard title="Wasted Spend Detected" value={cur(wastedSpend)} subtext="zero order queries" icon={Ban} />
        <KPICard title="Converting Search Terms" value={searchTerms.filter(s => !s.isWasted).length.toString()} subtext="high intent terms" icon={TrendingUp} />
      </motion.div>

      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2, duration: 0.5 }} className="bg-popover/80 border border-border rounded-xl p-4">
        <DataTable data={searchTerms} columns={columns as any} defaultSortKey="spend" defaultSortDir="desc" />
      </motion.div>
    </motion.div>
  );
}
