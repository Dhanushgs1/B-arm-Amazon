"use client";

import { useMemo } from "react";
import { useDashboard } from "@/lib/DashboardContext";
import { DataTable } from "@/components/DataTable";
import { DemoDataBanner } from "@/components/marketplace/DemoDataBanner";
import { generateMarketplaceInventory, MARKETPLACE_META, type MarketplaceId } from "@/lib/marketplace";
import { cn } from "@/lib/utils";

const cur = (val: number) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val || 0))}`;

const STATUS_STYLE: Record<string, string> = {
  "In Stock": "text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30",
  "Low Stock": "text-amber-600 bg-amber-50 dark:bg-amber-950/30",
  "Out of Stock": "text-red-600 bg-red-50 dark:bg-red-950/30",
};

export function MarketplaceInventory({ marketplace }: { marketplace: Exclude<MarketplaceId, "amazon"> }) {
  const { startDate, endDate } = useDashboard();
  const meta = MARKETPLACE_META[marketplace];

  const inventory = useMemo(() => {
    if (!startDate || !endDate) return [];
    return generateMarketplaceInventory(marketplace);
  }, [marketplace, startDate, endDate]);

  const lowStockCount = inventory.filter((i) => i.status !== "In Stock").length;

  return (
    <div className="space-y-6 pb-12">
      <DemoDataBanner marketplace={marketplace} />

      <div className="flex items-center justify-between flex-wrap gap-3 border-b border-slate-200/50 dark:border-slate-800/50 pb-4">
        <div className="space-y-1">
          <h1 className="text-3xl font-black tracking-tight text-slate-900 dark:text-white">{meta.label} Inventory</h1>
          <p className="text-slate-500 dark:text-slate-400 text-xs">{inventory.length} SKUs tracked</p>
        </div>
        {lowStockCount > 0 && (
          <span className="text-[10px] font-extrabold bg-amber-500/10 text-amber-600 px-3 py-1.5 rounded-full">
            {lowStockCount} SKUs need restocking
          </span>
        )}
      </div>

      <DataTable
        data={inventory}
        exportName={`${marketplace}_inventory`}
        defaultSort="inStock"
        columns={[
          { key: "name", label: "Product", sortable: true },
          { key: "sku", label: "SKU", sortable: true },
          { key: "inStock", label: "In Stock", sortable: true, summable: true },
          { key: "reserved", label: "Reserved", sortable: true, summable: true },
          { key: "price", label: "Price", sortable: true, render: (v) => cur(v) },
          {
            key: "status",
            label: "Status",
            sortable: true,
            render: (v) => (
              <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded-full", STATUS_STYLE[v] || "")}>{v}</span>
            ),
          },
        ]}
      />
    </div>
  );
}
