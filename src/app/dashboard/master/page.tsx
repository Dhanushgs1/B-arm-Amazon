"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Database } from "lucide-react";
import { DataTable } from "@/components/DataTable";
import { PageHero } from "@/components/PageHero";
import { QueryErrorState } from "@/components/QueryErrorState";
import { fetchMasterSkuidCatalog } from "@/lib/masterProductSkuid";
import { CATEGORY_COLORS } from "@/lib/categoryMap";
import { cn } from "@/lib/utils";

// Not in CATEGORY_COLORS (which is Amazon-category-scoped) — brand colors for the platform tabs,
// falling back to indigo for any platform value the sheet carries that isn't one of these two.
const PLATFORM_COLORS: Record<string, string> = {
  Amazon: "#FF9900",
  Flipkart: "#2874F0",
};

export default function MasterPage() {
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [selectedPlatform, setSelectedPlatform] = useState("All");

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["master_product_skuid_catalog"],
    queryFn: fetchMasterSkuidCatalog,
  });

  const rows = data || [];

  // Tab lists driven by what's actually in the data, not a hardcoded set — this table's
  // Category/Platform values aren't curated the way the Amazon-ads Category filter is.
  const categories = useMemo(
    () => Array.from(new Set(rows.map((r) => r.category).filter(Boolean))).sort(),
    [rows]
  );
  const platforms = useMemo(
    () => Array.from(new Set(rows.map((r) => r.platform).filter(Boolean))).sort(),
    [rows]
  );

  const filteredRows = rows.filter(
    (r) =>
      (selectedCategory === "All" || r.category === selectedCategory) &&
      (selectedPlatform === "All" || r.platform === selectedPlatform)
  );

  const columns = [
    {
      key: "sku",
      label: "SKU ID",
      sortable: true,
      render: (val: string) => <span className="font-mono text-xs font-bold text-foreground">{val || "—"}</span>,
    },
    {
      key: "name",
      label: "Product Name",
      sortable: true,
      render: (val: string) => <span className="font-semibold text-foreground">{val || "—"}</span>,
    },
    {
      key: "category",
      label: "Category",
      sortable: true,
      render: (val: string) => (
        <span className="px-2 py-0.5 rounded-full text-xs font-extrabold bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
          {val || "—"}
        </span>
      ),
    },
    {
      key: "platform",
      label: "Platform",
      sortable: true,
      render: (val: string) => <span className="text-xs font-semibold text-muted-foreground">{val || "—"}</span>,
    },
  ];

  return (
    <div className="space-y-8 pb-12">
      {isError && (
        <QueryErrorState compact message="Master SKU catalog couldn't load — retry." onRetry={() => refetch()} />
      )}

      <PageHero
        title="Master Product Catalog"
        subtitle="Every SKU ID, product name and category on record in master_product_skuid, across platforms."
        badge="master_product_skuid"
        onRefresh={() => refetch()}
        chips={[{ label: "Rows", value: String(filteredRows.length) }]}
      />

      {isLoading ? (
        <div className="flex h-[400px] items-center justify-center text-muted-foreground flex-col gap-4 glass rounded-[22px] border border-border">
          <Loader2 className="w-7 h-7 animate-spin text-primary" />
          <p className="font-semibold text-sm">Loading Master Catalog...</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="flex h-[300px] items-center justify-center text-muted-foreground flex-col gap-3 glass rounded-[22px] border border-border text-center px-6">
          <Database className="w-7 h-7 text-muted-foreground" />
          <p className="font-semibold text-sm">No rows in master_product_skuid yet.</p>
        </div>
      ) : (
        <>
          {/* Platform filter tabs */}
          <div className="flex items-center gap-2 overflow-x-auto pb-1.5 scrollbar-none">
            {["All", ...platforms].map((p) => {
              const isActive = selectedPlatform === p;
              const color = PLATFORM_COLORS[p] || "#6c63ff";
              return (
                <button
                  key={p}
                  onClick={() => setSelectedPlatform(p)}
                  className={cn(
                    "px-4 py-2 rounded-xl text-xs font-black transition-all border whitespace-nowrap focus:outline-none cursor-pointer",
                    isActive
                      ? "bg-white dark:bg-slate-900 text-slate-800 dark:text-white shadow-sm"
                      : "bg-slate-100 dark:bg-slate-900/60 border-transparent text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-850"
                  )}
                  style={isActive ? { borderColor: color, color } : {}}
                >
                  {p === "All" ? "All Platforms" : p}
                </button>
              );
            })}
          </div>

          {/* Category filter tabs */}
          <div className="flex items-center gap-2 overflow-x-auto pb-1.5 scrollbar-none">
            {["All", ...categories].map((cat) => {
              const isActive = selectedCategory === cat;
              const color = CATEGORY_COLORS[cat] || CATEGORY_COLORS.Other;
              return (
                <button
                  key={cat}
                  onClick={() => setSelectedCategory(cat)}
                  className={cn(
                    "px-4 py-2 rounded-xl text-xs font-black transition-all border whitespace-nowrap focus:outline-none cursor-pointer",
                    isActive
                      ? "bg-white dark:bg-slate-900 text-slate-800 dark:text-white shadow-sm"
                      : "bg-slate-100 dark:bg-slate-900/60 border-transparent text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-850"
                  )}
                  style={isActive ? { borderColor: color, color } : {}}
                >
                  {cat === "All" ? "All Categories" : cat}
                </button>
              );
            })}
          </div>

          <DataTable data={filteredRows} columns={columns} defaultSort="sku" exportName="master-product-skuid" />
        </>
      )}
    </div>
  );
}
