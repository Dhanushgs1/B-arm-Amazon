"use client";

import { DataTable } from "@/components/DataTable";
import { Star, TrendingDown, TrendingUp, Trophy, AlertOctagon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RRProduct, CategoryInsight } from "@/lib/ratingsReviewsData";

const cur = (val: number, currency = "INR") => {
  const sym = currency === "INR" ? "₹" : "$";
  return sym + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val || 0));
};
const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    Excellent: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-400 border-green-200 dark:border-green-900",
    Good: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-400 border-blue-200 dark:border-blue-900",
    Watch: "bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-400 border-yellow-200 dark:border-yellow-900",
    "Needs Attention": "bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-400 border-yellow-200 dark:border-yellow-900",
    Critical: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-400 border-red-200 dark:border-red-900",
  };
  const dot: Record<string, string> = { Excellent: "🟢", Good: "🟢", Watch: "🟡", "Needs Attention": "🟡", Critical: "🔴" };
  return (
    <span className={cn("px-2.5 py-0.5 rounded-full text-xs font-bold border whitespace-nowrap", map[status] || map.Watch)}>
      {dot[status] || "🟡"} {status}
    </span>
  );
}

function RatingCell({ value }: { value: number }) {
  const color = value >= 4.2 ? "text-emerald-500" : value >= 3.5 ? "text-amber-500" : "text-red-500";
  return (
    <span className={cn("font-bold flex items-center gap-1", color)}>
      <Star className="w-3.5 h-3.5 fill-current" /> {value.toFixed(1)}
    </span>
  );
}

function PctChangeCell({ value }: { value: number }) {
  const good = value >= 0;
  return (
    <span className={cn("font-bold flex items-center gap-1", good ? "text-emerald-500" : "text-red-500")}>
      {good ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
      {value > 0 ? "+" : ""}{value.toFixed(1)}%
    </span>
  );
}

export function LowRatedProductsTable({
  products,
  currency,
  onRowClick,
}: {
  products: RRProduct[];
  currency?: string;
  onRowClick: (p: RRProduct) => void;
}) {
  const columns = [
    {
      key: "name", label: "Product", sortable: true,
      render: (val: string, row: RRProduct) => (
        <div className="max-w-[240px]">
          <span className="font-semibold text-foreground text-sm block truncate" title={val}>{val}</span>
          <span className="text-[10px] text-muted-foreground font-mono">{row.sku} · {row.brand}</span>
        </div>
      ),
    },
    { key: "category", label: "Category", sortable: true },
    {
      key: "platform", label: "Platform", sortable: true,
      render: (val: string) => (
        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-muted border border-border">{val}</span>
      ),
    },
    { key: "avgRating", label: "Average Rating", sortable: true, render: (val: number) => <RatingCell value={val} /> },
    { key: "reviewCount", label: "Review Count", sortable: true, render: (val: number) => num(val) },
    { key: "sales", label: "Sales", sortable: true, summable: true, render: (val: number) => cur(val, currency) },
    { key: "salesChangePct", label: "Sales Change %", sortable: true, render: (val: number) => <PctChangeCell value={val} /> },
    { key: "returnRate", label: "Return Rate", sortable: true, render: (val: number) => <span className={cn("font-bold", val > 18 ? "text-red-500" : val > 10 ? "text-amber-500" : "text-emerald-500")}>{val.toFixed(1)}%</span> },
    { key: "healthStatus", label: "Status", sortable: true, render: (val: string) => <StatusPill status={val} /> },
  ];

  return (
    <DataTable
      data={products}
      columns={columns as any}
      exportName="low_rated_products"
      onRowClick={onRowClick as any}
      rowClassName={(row: any) => (row.avgRating < 3 ? "bg-red-50/40 dark:bg-red-950/10" : row.avgRating < 4 ? "bg-amber-50/30 dark:bg-amber-950/10" : "")}
    />
  );
}

export function SalesImpactTable({ products, currency }: { products: RRProduct[]; currency?: string }) {
  const impacted = [...products].filter((p) => p.salesChangePct < 0).sort((a, b) => a.salesChangePct - b.salesChangePct);

  const columns = [
    {
      key: "name", label: "Product", sortable: true,
      render: (val: string, row: RRProduct) => <span className="font-semibold text-sm" title={val}>{val}<span className="block text-[10px] text-muted-foreground font-normal">{row.category}</span></span>,
    },
    { key: "avgRating", label: "Rating", sortable: true, render: (val: number) => <RatingCell value={val} /> },
    { key: "salesChangePct", label: "Sales Change", sortable: true, render: (val: number) => <PctChangeCell value={val} /> },
    { key: "ordersChangePct", label: "Orders Change", sortable: true, render: (val: number) => <PctChangeCell value={val} /> },
    { key: "estimatedRevenueLost", label: "Est. Revenue Lost", sortable: true, summable: true, render: (val: number) => <span className="font-bold text-red-500">{cur(val, currency)}</span> },
    {
      key: "aiConfidence", label: "AI Confidence", sortable: true,
      render: (val: number) => (
        <div className="flex items-center gap-1.5">
          <div className="w-12 h-1.5 rounded-full bg-muted overflow-hidden"><div className="h-full bg-indigo-500" style={{ width: `${val}%` }} /></div>
          <span className="text-[10px] font-bold text-muted-foreground">{val}%</span>
        </div>
      ),
    },
    { key: "actionRequired", label: "Action Required", sortable: true, render: (val: string) => <span className="text-xs font-bold text-indigo-500">{val}</span> },
  ];

  return <DataTable data={impacted} columns={columns as any} exportName="sales_impact_analysis" />;
}

export function CategoryInsightsTable({ categories }: { categories: CategoryInsight[] }) {
  const best = categories[0];
  const worst = categories[categories.length - 1];

  const columns = [
    { key: "category", label: "Category", sortable: true },
    { key: "avgRating", label: "Average Rating", sortable: true, render: (val: number) => <RatingCell value={val} /> },
    { key: "productsBelow4", label: "Products Below 4★", sortable: true },
    { key: "negativeReviewPct", label: "Negative Review %", sortable: true, render: (val: number) => <span className={cn("font-bold", val > 25 ? "text-red-500" : "text-amber-500")}>{val.toFixed(1)}%</span> },
    { key: "returnPct", label: "Return %", sortable: true, render: (val: number) => `${val.toFixed(1)}%` },
    {
      key: "healthScore", label: "Health Score", sortable: true,
      render: (val: number) => (
        <span className={cn("font-bold", val >= 85 ? "text-emerald-500" : val >= 70 ? "text-blue-500" : val >= 50 ? "text-amber-500" : "text-red-500")}>{val}/100</span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {best && worst && categories.length > 1 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="flex items-center gap-3 p-3.5 rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50/50 dark:bg-emerald-950/20">
            <Trophy className="w-5 h-5 text-emerald-500 flex-shrink-0" />
            <div className="text-xs">
              <p className="font-bold text-emerald-700 dark:text-emerald-400">Best Category: {best.category}</p>
              <p className="text-muted-foreground">Health Score {best.healthScore}/100 · {best.avgRating.toFixed(1)}★ avg</p>
            </div>
          </div>
          <div className="flex items-center gap-3 p-3.5 rounded-xl border border-red-200 dark:border-red-900 bg-red-50/50 dark:bg-red-950/20">
            <AlertOctagon className="w-5 h-5 text-red-500 flex-shrink-0" />
            <div className="text-xs">
              <p className="font-bold text-red-700 dark:text-red-400">Worst Category: {worst.category}</p>
              <p className="text-muted-foreground">Health Score {worst.healthScore}/100 · {worst.avgRating.toFixed(1)}★ avg</p>
            </div>
          </div>
        </div>
      )}
      <DataTable data={categories} columns={columns as any} exportName="category_insights" disablePagination />
    </div>
  );
}
