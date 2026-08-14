"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useDashboard } from "@/lib/DashboardContext";
import { KPICard } from "@/components/KPICard";
import { DataTable } from "@/components/DataTable";
import { fetchFlipkartProducts } from "@/lib/flipkartData";
import { cn } from "@/lib/utils";

const cur = (val: number) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val || 0))}`;
const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));

export function FlipkartProducts() {
  const { loggedInUser, startDate, endDate } = useDashboard();

  const { data, isLoading } = useQuery({
    queryKey: ["flipkart-products", loggedInUser, startDate, endDate],
    queryFn: () => fetchFlipkartProducts(loggedInUser, startDate, endDate),
    enabled: !!startDate && !!endDate,
  });

  if (isLoading || !data) {
    return (
      <div className="flex h-[60vh] items-center justify-center flex-col gap-4 text-muted-foreground">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <p className="font-semibold text-sm">Loading Flipkart products...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-12">
      <div className="space-y-1 border-b border-slate-200/50 dark:border-slate-800/50 pb-4">
        <h1 className="text-3xl font-black tracking-tight text-slate-900 dark:text-white">Flipkart Product Catalog</h1>
        <p className="text-slate-500 dark:text-slate-400 text-xs">Product sales & stock · {startDate} – {endDate}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <KPICard title="Catalog Products" value={num(data.catalogCount)} subtitle="Listings in store" delay={0.02} accent="blue" />
        <KPICard title="Products Sold" value={num(data.soldCount)} subtitle="With sales this period" delay={0.04} accent="purple" />
        <KPICard title="Total Sales" value={cur(data.totalSales)} subtitle="Catalog revenue" delay={0.06} accent="green" />
      </div>

      <DataTable
        data={data.rows}
        exportName="flipkart_products"
        defaultSort="sales"
        columns={[
          {
            key: "name",
            label: "Product",
            sortable: true,
            render: (v, row: any) => (
              <div>
                <span className="font-extrabold text-slate-900 dark:text-white text-xs block">{v}</span>
                <span className="text-[10px] text-slate-500 dark:text-slate-400 font-mono">SKU: {row.sku || "—"}</span>
              </div>
            ),
          },
          { key: "units", label: "Units Sold", sortable: true, summable: true, render: (v) => num(v) },
          { key: "sales", label: "Sales", sortable: true, summable: true, render: (v) => <span className="font-extrabold text-emerald-500">{cur(v)}</span> },
          { key: "price", label: "Selling Price", sortable: true, render: (v) => (v ? cur(v) : "—") },
          {
            key: "stock",
            label: "Stock",
            sortable: true,
            render: (v) => <span className={cn("font-bold", v === 0 ? "text-red-500" : v < 30 ? "text-amber-500" : "text-slate-600 dark:text-slate-300")}>{v === 0 ? "Out of stock" : `${num(v)} units`}</span>,
          },
          {
            key: "status",
            label: "Status",
            sortable: true,
            render: (v) => <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">{v}</span>,
          },
        ]}
      />
    </div>
  );
}
