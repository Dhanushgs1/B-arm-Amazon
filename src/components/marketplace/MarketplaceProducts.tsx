"use client";

import { useState, useMemo } from "react";
import { motion } from "framer-motion";
import { 
  MARKETPLACE_META, 
  generateMarketplaceOverview, 
  type MarketplaceId 
} from "@/lib/marketplace";
import { PageHero } from "@/components/PageHero";
import { KPICard } from "@/components/KPICard";
import { DataTable } from "@/components/DataTable";
import { Package, Star, TrendingUp, Box } from "lucide-react";

const cur = (val: number) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val || 0))}`;
const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));

interface MarketplaceProductsProps {
  marketplace: Exclude<MarketplaceId, "amazon">;
}

export function MarketplaceProducts({ marketplace }: MarketplaceProductsProps) {
  const meta = MARKETPLACE_META[marketplace];
  const overview = useMemo(() => generateMarketplaceOverview(marketplace, "2026-07-01", "2026-07-21"), [marketplace]);

  const columns = [
    {
      key: "name",
      label: "Product Name",
      sortable: true,
      render: (val: string, row: any) => (
        <div>
          <span className="font-extrabold text-slate-900 dark:text-white text-xs block">{val}</span>
          <span className="text-[10px] text-slate-500 dark:text-slate-400 font-mono">SKU: {row.sku}</span>
        </div>
      ),
    },
    {
      key: "sales",
      label: "Total Sales",
      sortable: true,
      render: (val: number) => <span className="font-extrabold text-emerald-400">{cur(val)}</span>,
    },
    {
      key: "units",
      label: "Units Sold",
      sortable: true,
      render: (val: number) => num(val),
    },
    {
      key: "stock",
      label: "Stock Level",
      sortable: true,
      render: (val: number) => (
        <span className={val < 30 ? "text-amber-400 font-bold" : "text-slate-600 dark:text-slate-300"}>
          {val} units
        </span>
      ),
    },
    {
      key: "rating",
      label: "Customer Rating",
      sortable: true,
      render: (val: number) => (
        <span className="flex items-center gap-1 text-xs font-bold text-amber-500 dark:text-amber-300">
          <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" /> {val}
        </span>
      ),
    },
  ];

  return (
    <motion.div 
      initial={{ opacity: 0 }} 
      animate={{ opacity: 1 }} 
      transition={{ duration: 0.4 }}
      className="space-y-6 pb-12"
    >
      <PageHero
        title={`${meta.label} Product Catalog Performance`}
        subtitle={`Track product sales, stock correlation, and top-selling SKUs across ${meta.label}.`}
      />

      <motion.div 
        initial={{ opacity: 0, y: 20 }} 
        animate={{ opacity: 1, y: 0 }} 
        transition={{ delay: 0.1, duration: 0.5 }}
        className="grid grid-cols-1 sm:grid-cols-3 gap-4"
      >
        <KPICard title="Catalog Products" value={overview.topProducts.length.toString()} subtext="active SKUs" icon={Package} />
        <KPICard title="Total Sales" value={cur(overview.totalSales)} subtext="catalog revenue" icon={TrendingUp} />
        <KPICard title="Avg Product Rating" value={`${overview.rating.toFixed(1)} ★`} subtext="seller score" icon={Star} />
      </motion.div>

      <motion.div 
        initial={{ opacity: 0, y: 20 }} 
        animate={{ opacity: 1, y: 0 }} 
        transition={{ delay: 0.2, duration: 0.5 }}
        className="bg-popover/80 border border-border rounded-xl p-4"
      >
        <DataTable data={overview.topProducts} columns={columns as any} defaultSortKey="sales" defaultSortDir="desc" />
      </motion.div>
    </motion.div>
  );
}
