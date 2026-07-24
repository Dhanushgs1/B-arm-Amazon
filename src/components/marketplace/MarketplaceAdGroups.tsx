"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";
import { MARKETPLACE_META, generateMarketplaceCampaigns, type MarketplaceId } from "@/lib/marketplace";
import { PageHero } from "@/components/PageHero";
import { KPICard } from "@/components/KPICard";
import { DataTable } from "@/components/DataTable";
import { LayoutGrid, DollarSign, TrendingUp, Megaphone } from "lucide-react";

const cur = (val: number) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val || 0))}`;
const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));

export function MarketplaceAdGroups({ marketplace }: { marketplace: Exclude<MarketplaceId, "amazon"> }) {
  const meta = MARKETPLACE_META[marketplace];
  const campaigns = useMemo(() => generateMarketplaceCampaigns(marketplace), [marketplace]);

  const adGroups = useMemo(() => {
    return campaigns.flatMap((c, i) => [
      {
        id: `${c.id}-AG1`,
        name: `${c.name} - Exact Target Group`,
        campaignName: c.name,
        status: c.status,
        spend: Math.round(c.spend * 0.65),
        sales: Math.round(c.sales * 0.7),
        orders: Math.round(c.orders * 0.7),
        clicks: Math.round(c.clicks * 0.6),
        acos: c.acos,
        roas: c.roas,
      },
      {
        id: `${c.id}-AG2`,
        name: `${c.name} - Broad Discovery Group`,
        campaignName: c.name,
        status: c.status,
        spend: Math.round(c.spend * 0.35),
        sales: Math.round(c.sales * 0.3),
        orders: Math.round(c.orders * 0.3),
        clicks: Math.round(c.clicks * 0.4),
        acos: Math.round(c.acos * 1.15 * 10) / 10,
        roas: Math.round((c.roas * 0.85) * 10) / 10,
      },
    ]);
  }, [campaigns]);

  const columns = [
    {
      key: "name",
      label: "Ad Group Name",
      sortable: true,
      render: (val: string, row: any) => (
        <div>
          <span className="font-extrabold text-slate-900 dark:text-white text-xs block">{val}</span>
          <span className="text-[10px] text-slate-500 dark:text-slate-400 font-mono">{row.campaignName}</span>
        </div>
      ),
    },
    {
      key: "status",
      label: "Status",
      sortable: true,
      render: (val: string) => (
        <span className={val === "ENABLED" ? "text-emerald-400 font-bold text-xs" : "text-amber-400 font-bold text-xs"}>
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
        title={`${meta.label} Ad Groups`}
        subtitle={`Organize and track performance at the ad group level across ${meta.label} ad campaigns.`}
      />

      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1, duration: 0.5 }} className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <KPICard title="Total Ad Groups" value={adGroups.length.toString()} subtext="active ad groups" icon={LayoutGrid} />
        <KPICard title="Total Spend" value={cur(adGroups.reduce((a, g) => a + g.spend, 0))} subtext="ad group spend" icon={DollarSign} />
        <KPICard title="Total Sales" value={cur(adGroups.reduce((a, g) => a + g.sales, 0))} subtext="ad group revenue" icon={TrendingUp} />
      </motion.div>

      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2, duration: 0.5 }} className="bg-popover/80 border border-border rounded-xl p-4">
        <DataTable data={adGroups} columns={columns as any} defaultSortKey="spend" defaultSortDir="desc" />
      </motion.div>
    </motion.div>
  );
}
