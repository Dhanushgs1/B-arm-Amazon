"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Database, Pencil, Trash2, CheckCircle2, XCircle } from "lucide-react";
import { DataTable } from "@/components/DataTable";
import { PageHero } from "@/components/PageHero";
import { QueryErrorState } from "@/components/QueryErrorState";
import {
  fetchProductMarketingCatalog,
  deleteProductMarketingRow,
  type ProductMarketingCatalogRow,
} from "@/lib/productMarketingUpload";
import { CATEGORY_COLORS } from "@/lib/categoryMap";
import { cn } from "@/lib/utils";
import { MasterProductEditModal } from "./MasterProductEditModal";

// Not in CATEGORY_COLORS (which is Amazon-category-scoped) — brand colors for the platform tabs,
// falling back to indigo for any platform value the sheet carries that isn't one of these two.
const PLATFORM_COLORS: Record<string, string> = {
  Amazon: "#FF9900",
  Flipkart: "#2874F0",
};

export default function MasterPage() {
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [selectedPlatform, setSelectedPlatform] = useState("All");
  const [editingRow, setEditingRow] = useState<ProductMarketingCatalogRow | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [actionStatus, setActionStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["product_marketing_catalog"],
    queryFn: fetchProductMarketingCatalog,
  });

  const rows = data || [];

  const handleDelete = async (row: ProductMarketingCatalogRow) => {
    if (!window.confirm(`Delete "${row.name || row.sku}" (${row.platform}) from the master catalog? This can't be undone.`)) {
      return;
    }
    setDeletingId(row.id);
    setActionStatus(null);
    try {
      await deleteProductMarketingRow(row.id);
      setActionStatus({ type: "success", message: `Deleted "${row.name || row.sku}".` });
      await refetch();
    } catch (e) {
      setActionStatus({ type: "error", message: e instanceof Error ? e.message : "Delete failed" });
    } finally {
      setDeletingId(null);
    }
  };

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
    {
      key: "id",
      label: "Actions",
      exportValue: () => "",
      render: (_val: number, row: ProductMarketingCatalogRow) => (
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setEditingRow(row)}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-indigo-600 hover:bg-indigo-500/10 transition-colors cursor-pointer"
            title="Edit"
          >
            <Pencil size={14} />
          </button>
          <button
            onClick={() => handleDelete(row)}
            disabled={deletingId === row.id}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-red-600 hover:bg-red-500/10 transition-colors disabled:opacity-40 cursor-pointer"
            title="Delete"
          >
            {deletingId === row.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-8 pb-12">
      {isError && (
        <QueryErrorState compact message="Master SKU catalog couldn't load — retry." onRetry={() => refetch()} />
      )}

      {actionStatus && (
        <div
          className={cn(
            "flex items-center gap-1.5 text-xs font-semibold rounded-xl px-4 py-2.5 border",
            actionStatus.type === "success"
              ? "text-green-600 dark:text-green-400 bg-green-500/10 border-green-500/20"
              : "text-red-600 dark:text-red-400 bg-red-500/10 border-red-500/20"
          )}
        >
          {actionStatus.type === "success" ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
          {actionStatus.message}
        </div>
      )}

      <PageHero
        title="Master Product Catalog"
        subtitle="Every SKU ID, product name and category on record in master_product_marketing, across platforms."
        badge="master_product_marketing"
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
          <p className="font-semibold text-sm">No rows in master_product_marketing yet.</p>
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

          <DataTable data={filteredRows} columns={columns} defaultSort="sku" exportName="master-product-marketing" />
        </>
      )}

      {editingRow && (
        <MasterProductEditModal
          row={editingRow}
          onClose={() => setEditingRow(null)}
          onSaved={async () => {
            setEditingRow(null);
            setActionStatus({ type: "success", message: `Updated "${editingRow.name || editingRow.sku}".` });
            await refetch();
          }}
        />
      )}
    </div>
  );
}
