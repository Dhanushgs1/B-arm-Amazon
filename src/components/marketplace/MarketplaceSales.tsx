"use client";

import { useMemo } from "react";
import { useDashboard } from "@/lib/DashboardContext";
import { KPICard } from "@/components/KPICard";
import { TrendChart } from "@/components/TrendChart";
import { DataTable } from "@/components/DataTable";
import { DemoDataBanner } from "@/components/marketplace/DemoDataBanner";
import { MarketplaceLoading } from "@/components/marketplace/MarketplaceLoading";
import { generateMarketplaceOverview, MARKETPLACE_META, type MarketplaceId } from "@/lib/marketplace";

const cur = (val: number) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val || 0))}`;
const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));

export function MarketplaceSales({ marketplace }: { marketplace: Exclude<MarketplaceId, "amazon"> }) {
  const { startDate, endDate } = useDashboard();
  const meta = MARKETPLACE_META[marketplace];

  const overview = useMemo(
    () => (startDate && endDate ? generateMarketplaceOverview(marketplace, startDate, endDate) : null),
    [marketplace, startDate, endDate]
  );

  if (!overview) return <MarketplaceLoading />;

  const bestDay = [...overview.trend].sort((a, b) => b.sales - a.sales)[0];

  return (
    <div className="space-y-6 pb-12">
      <DemoDataBanner marketplace={marketplace} />

      <div className="space-y-1 border-b border-slate-200/50 dark:border-slate-800/50 pb-4">
        <h1 className="text-3xl font-black tracking-tight text-slate-900 dark:text-white">{meta.label} Sales Performance</h1>
        <p className="text-slate-500 dark:text-slate-400 text-xs">{startDate} – {endDate}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard title="Total Sales" value={cur(overview.totalSales)} subtitle="Selected date range" trend={overview.growthPct} delay={0.02} accent="green" />
        <KPICard title="Orders" value={num(overview.totalOrders)} subtitle="Orders placed" delay={0.04} accent="blue" />
        <KPICard title="Best Day" value={bestDay ? cur(bestDay.sales) : "—"} subtitle={bestDay?.date || ""} delay={0.06} accent="purple" />
        <KPICard title="Avg Order Value" value={cur(overview.avgOrderValue)} subtitle="Per order" delay={0.08} accent="cyan" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <TrendChart title="Sales Trend" data={overview.trend} dataKey="sales" color={meta.color} type="area" height={300} valuePrefix="₹" />
        <TrendChart title="Orders Trend" data={overview.trend} dataKey="orders" color="#8B5CF6" type="line" height={300} />
      </div>

      <div>
        <h2 className="text-sm font-black text-slate-800 dark:text-slate-200 mb-3">Product Sales Breakdown</h2>
        <DataTable
          data={overview.topProducts}
          exportName={`${marketplace}_product_sales`}
          defaultSort="sales"
          columns={[
            { key: "name", label: "Product", sortable: true },
            { key: "sku", label: "SKU", sortable: true },
            { key: "units", label: "Units Sold", sortable: true, summable: true },
            { key: "sales", label: "Sales", sortable: true, summable: true, render: (v) => cur(v) },
            { key: "rating", label: "Rating", sortable: true, render: (v) => `${v} ★` },
          ]}
        />
      </div>
    </div>
  );
}
