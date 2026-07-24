"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";
import { MARKETPLACE_META, generateMarketplaceCampaigns, type MarketplaceId } from "@/lib/marketplace";
import { PageHero } from "@/components/PageHero";
import { KPICard } from "@/components/KPICard";
import { DataTable } from "@/components/DataTable";
import { Target, TrendingUp, DollarSign } from "lucide-react";

const cur = (val: number) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val || 0))}`;
const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));

export function MarketplacePlacements({ marketplace }: { marketplace: Exclude<MarketplaceId, "amazon"> }) {
  const meta = MARKETPLACE_META[marketplace];
  const campaigns = useMemo(() => generateMarketplaceCampaigns(marketplace), [marketplace]);

  const placements = useMemo(() => {
    const types = marketplace === "flipkart" 
      ? ["Top of Search (PLA)", "Product Page (PCA)", "Category Browse", "Homepage Banner"]
      : ["Search Top Placement", "Product Detail Page", "Feed Recommendations", "Category Spotlight"];

    return campaigns.flatMap((c) =>
      types.map((placementName, idx) => {
        const factor = idx === 0 ? 0.45 : idx === 1 ? 0.35 : 0.1;
        const spend = Math.round(c.spend * factor);
        const roas = idx === 0 ? c.roas * 1.2 : c.roas * 0.9;
        const sales = Math.round(spend * roas);
        const orders = Math.round(sales / 500);

        return {
          id: `${c.id}-PLC-${idx}`,
          placement: placementName,
          campaignName: c.name,
          spend,
          sales,
          orders,
          roas: Math.round(roas * 10) / 10,
          acos: sales ? Math.round((spend / sales) * 1000) / 10 : 0,
        };
      })
    );
  }, [campaigns, marketplace]);

  const columns = [
    {
      key: "placement",
      label: "Placement Location",
      sortable: true,
      render: (val: string, row: any) => (
        <div>
          <span className="font-extrabold text-slate-900 dark:text-white text-xs block">{val}</span>
          <span className="text-[10px] text-slate-500 dark:text-slate-400 font-mono">{row.campaignName}</span>
        </div>
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
    {
      key: "orders",
      label: "Orders",
      sortable: true,
      render: (val: number) => num(val),
    },
  ];

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }} className="space-y-6 pb-12">
      <PageHero
        title={`${meta.label} Placement Performance`}
        subtitle={`Analyze performance across Top of Search, Product Pages, and Browse placements on ${meta.label}.`}
      />

      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1, duration: 0.5 }} className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <KPICard title="Top of Search ROAS" value="4.2x" subtext="highest converting placement" icon={Target} />
        <KPICard title="Product Page Spend" value={cur(placements.reduce((a, p) => a + p.spend, 0) * 0.35)} subtext="detail page ads" icon={DollarSign} />
        <KPICard title="Total Placement Sales" value={cur(placements.reduce((a, p) => a + p.sales, 0))} subtext="placement revenue" icon={TrendingUp} />
      </motion.div>

      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2, duration: 0.5 }} className="bg-popover/80 border border-border rounded-xl p-4">
        <DataTable data={placements} columns={columns as any} defaultSortKey="spend" defaultSortDir="desc" />
      </motion.div>
    </motion.div>
  );
}
