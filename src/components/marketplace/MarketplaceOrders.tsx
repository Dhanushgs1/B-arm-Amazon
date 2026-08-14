"use client";

import { useMemo } from "react";
import { useDashboard } from "@/lib/DashboardContext";
import { DataTable } from "@/components/DataTable";
import { DemoDataBanner } from "@/components/marketplace/DemoDataBanner";
import { generateMarketplaceOverview, generateMarketplaceOrders, MARKETPLACE_META, type MarketplaceId } from "@/lib/marketplace";
import { cn } from "@/lib/utils";

const cur = (val: number) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val || 0))}`;

const STATUS_STYLE: Record<string, string> = {
  Delivered: "text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30",
  Shipped: "text-blue-600 bg-blue-50 dark:bg-blue-950/30",
  RTO: "text-red-600 bg-red-50 dark:bg-red-950/30",
  Cancelled: "text-slate-500 bg-slate-100 dark:bg-slate-800",
  Pending: "text-amber-600 bg-amber-50 dark:bg-amber-950/30",
};

export function MarketplaceOrders({ marketplace }: { marketplace: Exclude<MarketplaceId, "amazon"> }) {
  const { startDate, endDate } = useDashboard();
  const meta = MARKETPLACE_META[marketplace];

  const orders = useMemo(() => {
    if (!startDate || !endDate) return [];
    const overview = generateMarketplaceOverview(marketplace, startDate, endDate);
    return generateMarketplaceOrders(marketplace, startDate, endDate, overview);
  }, [marketplace, startDate, endDate]);

  return (
    <div className="space-y-6 pb-12">
      <DemoDataBanner marketplace={marketplace} />

      <div className="space-y-1 border-b border-slate-200/50 dark:border-slate-800/50 pb-4">
        <h1 className="text-3xl font-black tracking-tight text-slate-900 dark:text-white">{meta.label} Orders</h1>
        <p className="text-slate-500 dark:text-slate-400 text-xs">{orders.length} orders · {startDate} – {endDate}</p>
      </div>

      <DataTable
        data={orders}
        exportName={`${marketplace}_orders`}
        defaultSort="date"
        columns={[
          { key: "orderId", label: "Order ID", sortable: true },
          { key: "date", label: "Date", sortable: true },
          { key: "product", label: "Product", sortable: true },
          { key: "qty", label: "Qty", sortable: true, summable: true },
          { key: "amount", label: "Amount", sortable: true, summable: true, render: (v) => cur(v) },
          { key: "state", label: "State", sortable: true },
          {
            key: "status",
            label: "Status",
            sortable: true,
            render: (v) => (
              <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded-full", STATUS_STYLE[v] || "")}>{v}</span>
            ),
          },
        ]}
        disablePagination={false}
        pageSize={50}
      />
    </div>
  );
}
