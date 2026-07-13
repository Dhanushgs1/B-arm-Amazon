"use client";

import { useQuery } from "@tanstack/react-query";
import { useDashboard } from "@/lib/DashboardContext";
import { mcp } from "@/lib/api";
import { DataTable } from "@/components/DataTable";
import { KPICard } from "@/components/KPICard";
import { Loader2, Package, TrendingUp, AlertTriangle, Eye, HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";

const cur = (val: number, currency?: string) => {
  const sym = currency === "INR" ? "₹" : "$";
  if (!val) return `${sym}0`;
  return sym + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val));
};
const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));
const pct = (val: number) => `${(val || 0).toFixed(2)}%`;

export default function ProductsPage() {
  const { keySlot, startDate, endDate, account, contextLoading, setSelectedAsin } = useDashboard();

  const { data, isLoading } = useQuery({
    queryKey: ["products_tab", keySlot, account?.id, startDate, endDate],
    queryFn: async () => {
      const res = await mcp("get_advertised_product_performance", {
        amazon_account_id: account?.id,
        workspace_id: account?.workspace_id,
        start_date: startDate,
        end_date: endDate,
        page_size: 2000,
      }, keySlot);
      return res.data || res.products || [];
    },
    enabled: !!account,
  });

  const currency = account?.currency;

  const products = data || [];
  
  // Calculate Product KPIs
  const totalProducts = products.length;
  
  // Sort products to find hero & bleeders
  const sortedBySales = [...products].sort((a: any, b: any) => (b.sales || 0) - (a.sales || 0));
  const heroProduct = sortedBySales[0];
  
  const highAcosCount = products.filter((p: any) => p.acos > 50).length;
  const wastedClicksCount = products.reduce((acc: number, p: any) => p.orders === 0 ? acc + (p.clicks || 0) : acc, 0);

  // Lists for insights
  const bleedingProducts = products.filter((p: any) => p.acos > 50 && p.spend > 100)
    .sort((a: any, b: any) => b.acos - a.acos);
  const clickNoOrderProducts = products.filter((p: any) => p.orders === 0 && p.clicks > 15)
    .sort((a: any, b: any) => b.clicks - a.clicks);
  const topROIProducts = products.filter((p: any) => p.roas > 4.5 && p.orders > 5)
    .sort((a: any, b: any) => b.sales - a.sales);

  const columns = [
    {
      key: "adAsin",
      label: "ASIN",
      sortable: true,
      render: (val: string, row: any) => (
        <button
          onClick={() => setSelectedAsin(val || row.asin)}
          className="font-mono font-bold text-primary hover:underline text-xs text-left focus:outline-none"
        >
          {val || row.asin || "—"}
        </button>
      ),
    },
    {
      key: "adProductName",
      label: "Product Name",
      sortable: true,
      render: (val: string, row: any) => (
        <button
          onClick={() => setSelectedAsin(row.adAsin || row.asin)}
          className="font-semibold text-foreground hover:text-primary text-left text-sm block max-w-[280px] truncate focus:outline-none"
          title={val}
        >
          {val || "—"}
        </button>
      ),
    },
    {
      key: "spend",
      label: "Spend",
      sortable: true,
      render: (val: number) => <span className="font-medium text-foreground">{cur(val, currency)}</span>,
    },
    {
      key: "sales",
      label: "Sales",
      sortable: true,
      render: (val: number) => <span className="text-green-600 dark:text-green-400 font-bold">{cur(val, currency)}</span>,
    },
    {
      key: "acos",
      label: "ACOS",
      sortable: true,
      render: (val: number) => (
        <span className={cn("px-2 py-0.5 rounded-full text-xs font-bold", val && val < 20 ? "bg-green-500/10 text-green-700 dark:text-green-400" : val && val > 40 ? "bg-red-500/10 text-red-700 dark:text-red-400" : "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400")}>
          {val ? pct(val) : "—"}
        </span>
      ),
    },
    {
      key: "roas",
      label: "ROAS",
      sortable: true,
      render: (val: number) => <span className="font-semibold">{val ? val.toFixed(2) : "—"}</span>,
    },
    {
      key: "impressions",
      label: "Impressions",
      sortable: true,
      render: (val: number) => num(val),
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
      key: "ctr",
      label: "CTR",
      sortable: true,
      render: (val: number) => val ? pct(val) : "—",
    },
    {
      key: "cpc",
      label: "CPC",
      sortable: true,
      render: (val: number) => cur(val, currency),
    },
  ];

  return (
    <div className="space-y-6 pb-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight mb-0.5">Advertised Products</h1>
        <p className="text-muted-foreground text-sm">
          {account?.name} · {startDate} → {endDate}
        </p>
      </div>

      {contextLoading || isLoading ? (
        <div className="flex h-[400px] items-center justify-center text-muted-foreground flex-col gap-4 glass rounded-2xl border border-border">
          <Loader2 className="w-7 h-7 animate-spin text-primary" />
          <p className="font-semibold text-sm">{contextLoading ? "Connecting..." : "Loading Products..."}</p>
        </div>
      ) : (
        <>
          {/* KPI Dashboard */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <KPICard title="Advertised Catalog" value={num(totalProducts)} subtitle="Unique ASINs receiving clicks" delay={0.05} />
            <KPICard title="Top Seller Sales" value={heroProduct ? cur(heroProduct.sales, currency) : "$0"} subtitle={heroProduct ? `ASIN: ${heroProduct.adAsin || heroProduct.asin}` : "No sales"} delay={0.1} />
            <KPICard title="Bleeding ASINs" value={num(highAcosCount)} subtitle="ACOS > 50% (losing margin)" delay={0.15} />
            <KPICard title="Wasted Clicks" value={num(wastedClicksCount)} subtitle="Clicks with zero orders" inverseTrend delay={0.2} />
          </div>

          {/* Actionable Alerts & Recommendations */}
          {(bleedingProducts.length > 0 || clickNoOrderProducts.length > 0 || topROIProducts.length > 0) && (
            <div className="glass rounded-2xl border border-border p-5 shadow-sm space-y-3">
              <h3 className="font-bold text-sm flex items-center gap-2">
                <Package className="w-4 h-4 text-primary" /> Product Listing & Advertising Insights
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {bleedingProducts.slice(0, 2).map((p: any) => (
                  <div key={p.adAsin || p.asin} className="p-3 rounded-xl border border-red-200 dark:border-red-900 bg-red-50/50 dark:bg-red-950/20 text-xs">
                    <p className="font-bold text-red-800 dark:text-red-400 flex items-center gap-1">⚠️ High-ACOS Product Bleeding</p>
                    <p className="font-semibold mt-1 truncate" title={p.adProductName}>{p.adProductName}</p>
                    <p className="text-muted-foreground mt-0.5 font-bold">ASIN: {p.adAsin || p.asin} · ACOS: {pct(p.acos)}</p>
                    <p className="font-bold text-red-700 dark:text-red-500 mt-1.5">Action: Trim bid on targeting matching this ASIN; optimize listing conversion.</p>
                  </div>
                ))}
                {clickNoOrderProducts.slice(0, 2).map((p: any) => (
                  <div key={p.adAsin || p.asin} className="p-3 rounded-xl border border-yellow-200 dark:border-yellow-900 bg-yellow-50/50 dark:bg-yellow-950/20 text-xs">
                    <p className="font-bold text-yellow-800 dark:text-yellow-400 flex items-center gap-1">❌ Traffic but No Conversion</p>
                    <p className="font-semibold mt-1 truncate" title={p.adProductName}>{p.adProductName}</p>
                    <p className="text-muted-foreground mt-0.5 font-bold">ASIN: {p.adAsin || p.asin} · Clicks: {p.clicks} · Orders: 0</p>
                    <p className="font-bold text-yellow-700 dark:text-yellow-500 mt-1.5">Action: Verify price competitiveness, page content, or check if out of stock.</p>
                  </div>
                ))}
                {topROIProducts.slice(0, 2).map((p: any) => (
                  <div key={p.adAsin || p.asin} className="p-3 rounded-xl border border-green-200 dark:border-green-900 bg-green-50/50 dark:bg-green-950/20 text-xs">
                    <p className="font-bold text-green-800 dark:text-green-400 flex items-center gap-1">🚀 High-Converting Hero Product</p>
                    <p className="font-semibold mt-1 truncate" title={p.adProductName}>{p.adProductName}</p>
                    <p className="text-muted-foreground mt-0.5 font-bold">ROAS: {p.roas.toFixed(2)}x · Sales: {cur(p.sales, currency)}</p>
                    <p className="font-bold text-green-700 dark:text-green-500 mt-1.5">Action: Feed more budget to this ASIN; launch sponsored brands campaigns.</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <DataTable data={products} columns={columns} defaultSort="spend" />
        </>
      )}
    </div>
  );
}
