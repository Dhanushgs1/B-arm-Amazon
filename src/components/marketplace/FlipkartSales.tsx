"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useDashboard } from "@/lib/DashboardContext";
import { KPICard } from "@/components/KPICard";
import { TrendChart } from "@/components/TrendChart";
import { DataTable } from "@/components/DataTable";
import { fetchFlipkartSales } from "@/lib/flipkartData";

const cur = (val: number) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val || 0))}`;
const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));

export function FlipkartSales() {
  const { loggedInUser, startDate, endDate } = useDashboard();

  const { data, isLoading } = useQuery({
    queryKey: ["flipkart-sales", loggedInUser, startDate, endDate],
    queryFn: () => fetchFlipkartSales(loggedInUser, startDate, endDate),
    enabled: !!startDate && !!endDate,
  });

  if (isLoading || !data) {
    return (
      <div className="flex h-[60vh] items-center justify-center flex-col gap-4 text-muted-foreground">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <p className="font-semibold text-sm">Loading Flipkart sales...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-12">
      <div className="space-y-1 border-b border-slate-200/50 dark:border-slate-800/50 pb-4">
        <h1 className="text-3xl font-black tracking-tight text-slate-900 dark:text-white">Flipkart Sales Performance</h1>
        <p className="text-slate-500 dark:text-slate-400 text-xs">{startDate} – {endDate}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard title="Total Sales" value={cur(data.totalSales)} subtitle="Selected date range" trend={data.growthPct} delay={0.02} accent="green" />
        <KPICard title="Units Sold" value={num(data.totalUnits)} subtitle="Total units" delay={0.04} accent="blue" />
        <KPICard title="Best Day" value={data.bestDay ? cur(data.bestDay.sales) : "—"} subtitle={data.bestDay?.date || ""} delay={0.06} accent="purple" />
        <KPICard title="Avg Selling Price" value={cur(data.avgOrderValue)} subtitle="Per unit" delay={0.08} accent="cyan" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <TrendChart title="Sales Trend" data={data.trend} dataKey="sales" color="#2874F0" type="area" height={300} valuePrefix="₹" />
        <TrendChart title="Units Trend" data={data.trend} dataKey="units" color="#8B5CF6" type="line" height={300} />
      </div>

      <div>
        <h2 className="text-sm font-black text-slate-800 dark:text-slate-200 mb-3">Product Sales Breakdown</h2>
        <DataTable
          data={data.products}
          exportName="flipkart_product_sales"
          defaultSort="sales"
          columns={[
            { key: "name", label: "Product", sortable: true },
            { key: "sku", label: "SKU", sortable: true },
            { key: "units", label: "Units Sold", sortable: true, summable: true, render: (v) => num(v) },
            { key: "sales", label: "Sales", sortable: true, summable: true, render: (v) => cur(v) },
          ]}
        />
      </div>
    </div>
  );
}
