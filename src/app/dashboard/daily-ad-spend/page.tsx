"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useDashboard } from "@/lib/DashboardContext";
import { Sparkles, Loader2, RefreshCw, PauseCircle, TrendingUp, TrendingDown, Minus, Search, ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";
import { AiSuggestionModal } from "@/components/AiSuggestionModal";
import {
  fetchAmazonProducts,
  fetchFlipkartProducts,
  fetchMeeshoProducts,
  groupProductsByName,
  spendTax,
  computeCpc,
  computeAcos,
  type Platform,
} from "@/lib/adSpendReportExport";

interface Row {
  platform: Platform;
  sku: string;
  name: string;
  price: number;
  spendTax: number;
  orders: number;
  cpc: number;
  acos: number;
  sales: number; // orders x price — rough revenue estimate, shown next to spend
}

type Action = "Scale Up" | "Maintain" | "Reduce Bid" | "Pause Campaign";
interface Recommendation { action: Action; reason: string }

const ACTION_STYLE: Record<Action, { icon: typeof TrendingUp; className: string }> = {
  "Scale Up": { icon: TrendingUp, className: "text-green-700 bg-green-50 border-green-200 dark:text-green-400 dark:bg-green-950/40 dark:border-green-800" },
  "Maintain": { icon: Minus, className: "text-blue-600 bg-blue-50 border-blue-200 dark:text-blue-400 dark:bg-blue-950/40 dark:border-blue-800" },
  "Reduce Bid": { icon: TrendingDown, className: "text-orange-600 bg-orange-50 border-orange-200 dark:text-orange-400 dark:bg-orange-950/40 dark:border-orange-800" },
  "Pause Campaign": { icon: PauseCircle, className: "text-red-600 bg-red-50 border-red-200 dark:text-red-400 dark:bg-red-950/40 dark:border-red-800" },
};

const PLATFORM_DOT: Record<Platform, string> = {
  Amazon: "bg-orange-500",
  Flipkart: "bg-blue-500",
  Meesho: "bg-purple-500",
};

const PLATFORM_TABS: ("All" | Platform)[] = ["All", "Amazon", "Flipkart", "Meesho"];

type SortKey = "platform" | "name" | "price" | "spendTax" | "sales" | "orders" | "cpc" | "acos";
const SORT_COLUMNS: { key: SortKey; label: string; align: "left" | "right" }[] = [
  { key: "platform", label: "Platform", align: "left" },
  { key: "name", label: "Product", align: "left" },
  { key: "price", label: "Price", align: "right" },
  { key: "spendTax", label: "Spend(with tax)", align: "right" },
  { key: "sales", label: "Sales", align: "right" },
  { key: "orders", label: "Orders", align: "right" },
  { key: "cpc", label: "CPC", align: "right" },
  { key: "acos", label: "ACOS", align: "right" },
];

export default function DailyAdSpendPage() {
  const { account, startDate, endDate } = useDashboard();
  const rangeStart = startDate || endDate;
  const rangeEnd = endDate;
  const rangeLabel = rangeStart && rangeEnd ? (rangeStart === rangeEnd ? rangeEnd : `${rangeStart} to ${rangeEnd}`) : "pick a date above";

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [recs, setRecs] = useState<Map<string, Recommendation>>(new Map());
  const [pendingSkus, setPendingSkus] = useState<Set<string>>(new Set());
  const [bulkGenerating, setBulkGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [platformFilter, setPlatformFilter] = useState<"All" | Platform>("All");
  const [search, setSearch] = useState("");
  const [activeProduct, setActiveProduct] = useState<Row | null>(null);
  // Defaults to highest spend first — same ordering loadRange already sorts
  // rows into — until the person clicks a column header to sort by that
  // instead. Clicking the same column again flips direction.
  const [sortKey, setSortKey] = useState<SortKey>("spendTax");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir(key === "platform" || key === "name" ? "asc" : "desc"); }
  };

  // Generates recommendations for whatever rows are passed in — one call for
  // a single row (fired when that row is clicked, so it comes back in a
  // couple seconds instead of waiting on the whole day's product list), or
  // for the full list via the "Generate All" button.
  const generateFor = useCallback(async (forRows: Row[]) => {
    if (!forRows.length) return;
    const skus = forRows.map((r) => r.sku);
    setPendingSkus((prev) => new Set([...prev, ...skus]));
    setGenError(null);
    try {
      const payload = forRows.map((r) => ({
        sku: r.sku, platform: r.platform, name: r.name, price: r.price,
        spendTax: r.spendTax, orders: r.orders, cpc: r.cpc, acos: r.acos, sales: r.sales,
      }));
      const res = await fetch("/api/daily-ad-spend-insights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ products: payload }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Failed to generate recommendations");
      setRecs((prev) => {
        const next = new Map(prev);
        (j.recommendations || []).forEach((r: { sku: string; action: Action; reason: string }) => {
          if (r?.sku && r?.action) next.set(r.sku, { action: r.action, reason: r.reason || "" });
        });
        return next;
      });
    } catch (err) {
      setGenError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingSkus((prev) => {
        const next = new Set(prev);
        skus.forEach((s) => next.delete(s));
        return next;
      });
    }
  }, []);

  // requestedRange lets an in-flight load from a since-changed date range
  // bail out instead of overwriting rows/recs for the range the user is now
  // looking at.
  const loadRange = useCallback(async () => {
    if (!rangeStart || !rangeEnd) return;
    const requested = `${rangeStart}|${rangeEnd}`;
    setLoading(true);
    setLoadError(null);
    setGenError(null);
    setRecs(new Map());
    setPendingSkus(new Set());
    try {
      const range = { start: rangeStart, end: rangeEnd };
      const [amz, fk, ms] = await Promise.all([
        fetchAmazonProducts(range, rangeEnd),
        fetchFlipkartProducts(range, rangeEnd),
        fetchMeeshoProducts(range, rangeEnd),
      ]);
      if (`${rangeStart}|${rangeEnd}` !== requested) return; // range changed again while this was in flight
      const platforms: { platform: Platform; products: typeof amz.products }[] = [
        { platform: "Amazon", products: amz.products },
        { platform: "Flipkart", products: fk.products },
        { platform: "Meesho", products: ms.products },
      ];
      const merged: Row[] = [];
      platforms.forEach(({ platform, products }) => {
        const grouped = groupProductsByName([...products.values()]).filter((p) => spendTax(p.range) > 0);
        grouped.forEach((p) => {
          merged.push({
            platform,
            sku: p.sku,
            name: p.name,
            price: p.price,
            spendTax: Math.round(spendTax(p.range) * 100) / 100,
            orders: p.range.units,
            cpc: Math.round(computeCpc(p.range) * 100) / 100,
            acos: Math.round(computeAcos(p.range, p.price) * 10000) / 100,
            sales: Math.round(p.range.units * p.price * 100) / 100,
          });
        });
      });
      merged.sort((a, b) => b.spendTax - a.spendTax);
      setRows(merged);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [rangeStart, rangeEnd]);

  useEffect(() => { loadRange(); }, [loadRange]);

  const handleGenerateAll = () => {
    setBulkGenerating(true);
    generateFor(rows).finally(() => setBulkGenerating(false));
  };

  const openProduct = (r: Row) => {
    setActiveProduct(r);
    if (!recs.has(r.sku) && !pendingSkus.has(r.sku)) void generateFor([r]);
  };

  const counts = useMemo(() => {
    const c: Record<"All" | Platform, number> = { All: rows.length, Amazon: 0, Flipkart: 0, Meesho: 0 };
    rows.forEach((r) => { c[r.platform]++; });
    return c;
  }, [rows]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = rows.filter((r) => (platformFilter === "All" || r.platform === platformFilter) && (!q || r.name.toLowerCase().includes(q)));
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      if (typeof av === "string" || typeof bv === "string") return String(av).localeCompare(String(bv)) * dir;
      return ((av as number) - (bv as number)) * dir;
    });
  }, [rows, platformFilter, search, sortKey, sortDir]);

  const activeRec = activeProduct ? recs.get(activeProduct.sku) : null;
  const activePending = activeProduct ? pendingSkus.has(activeProduct.sku) : false;

  return (
    <div className="space-y-6 pb-10">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight mb-0.5 flex items-center gap-2">
            <Sparkles className="text-primary" size={22} /> Daily Ad Spend
          </h1>
          <p className="text-muted-foreground text-sm">
            {account?.name} · Amazon + Flipkart + Meesho — {rangeLabel}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadRange}
            disabled={loading || !rangeEnd}
            className="px-3 py-2 bg-white dark:bg-white/10 border border-border hover:border-primary/50 text-foreground text-xs font-bold rounded-lg transition-colors flex items-center gap-2 shadow-sm disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw size={14} />} Refresh
          </button>
          <button
            onClick={handleGenerateAll}
            disabled={bulkGenerating || loading || !rows.length}
            title="Generate AI recommendations for every product at once — clicking a single product also generates just that one, much faster"
            className="px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-bold rounded-lg transition-colors flex items-center gap-2 shadow-md disabled:opacity-50"
          >
            {bulkGenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles size={14} />}
            {bulkGenerating ? "Thinking…" : "Generate All"}
          </button>
        </div>
      </div>

      {loadError && (
        <div className="glass rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-4 text-sm text-red-700 dark:text-red-400">
          {loadError}
        </div>
      )}
      {genError && (
        <div className="glass rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-4 text-sm text-red-700 dark:text-red-400">
          {genError}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        {PLATFORM_TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setPlatformFilter(tab)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${
              platformFilter === tab
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-white dark:bg-white/10 border-border text-foreground hover:border-primary/50"
            }`}
          >
            {tab} <span className="opacity-70">({counts[tab]})</span>
          </button>
        ))}
        <div className="relative ml-auto w-full max-w-[240px]">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search product…"
            className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-border bg-white dark:bg-white/10 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>

      <div className="glass rounded-2xl border border-border shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left">
                {SORT_COLUMNS.map((col) => {
                  const active = sortKey === col.key;
                  const SortIcon = active ? (sortDir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
                  return (
                    <th key={col.key} className={`px-4 py-3 font-black uppercase tracking-wider text-muted-foreground ${col.align === "right" ? "text-right" : "text-left"}`}>
                      <button
                        onClick={() => toggleSort(col.key)}
                        className={`inline-flex items-center gap-1 hover:text-foreground transition-colors ${active ? "text-foreground" : ""} ${col.align === "right" ? "flex-row-reverse" : ""}`}
                      >
                        {col.label} <SortIcon size={11} className={active ? "opacity-100" : "opacity-40"} />
                      </button>
                    </th>
                  );
                })}
                <th className="px-4 py-3 font-black uppercase tracking-wider text-muted-foreground">AI Recommendation</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={9} className="px-4 py-10 text-center text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading {rangeLabel}'s ad spend…
                </td></tr>
              ) : filteredRows.length === 0 ? (
                <tr><td colSpan={9} className="px-4 py-10 text-center text-muted-foreground">
                  {rows.length === 0
                    ? `No ad spend uploaded for ${rangeLabel} yet.`
                    : `No products match your filters.`}
                </td></tr>
              ) : (
                filteredRows.map((r) => {
                  const rec = recs.get(r.sku);
                  const pending = pendingSkus.has(r.sku);
                  const style = rec ? ACTION_STYLE[rec.action] : null;
                  const Icon = style?.icon;
                  return (
                    <tr key={`${r.platform}-${r.sku}`} className="border-b border-border last:border-0 hover:bg-muted/20">
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1.5 font-bold">
                          <span className={`w-1.5 h-1.5 rounded-full ${PLATFORM_DOT[r.platform]}`} /> {r.platform}
                        </span>
                      </td>
                      <td className="px-4 py-3 max-w-[280px]">
                        <button
                          onClick={() => openProduct(r)}
                          className="truncate font-semibold text-left hover:text-primary hover:underline transition-colors max-w-full block"
                          title={`View AI recommendation for ${r.name}`}
                        >
                          {r.name}
                        </button>
                      </td>
                      <td className="px-4 py-3 text-right">₹{(r.price ?? 0).toLocaleString("en-IN")}</td>
                      <td className="px-4 py-3 text-right font-semibold">₹{(r.spendTax ?? 0).toLocaleString("en-IN")}</td>
                      <td className={`px-4 py-3 text-right font-semibold ${(r.sales ?? 0) < (r.spendTax ?? 0) ? "text-red-600 dark:text-red-400" : "text-green-700 dark:text-green-400"}`}>₹{(r.sales ?? 0).toLocaleString("en-IN")}</td>
                      <td className="px-4 py-3 text-right">{r.orders ?? 0}</td>
                      <td className="px-4 py-3 text-right">₹{(r.cpc ?? 0).toLocaleString("en-IN")}</td>
                      <td className="px-4 py-3 text-right">{r.acos ?? 0}%</td>
                      <td className="px-4 py-3">
                        {rec && style && Icon ? (
                          <button
                            onClick={() => openProduct(r)}
                            className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[11px] font-bold ${style.className}`}
                          >
                            <Icon size={12} /> {rec.action}
                          </button>
                        ) : pending ? (
                          <span className="text-muted-foreground inline-flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> Thinking…</span>
                        ) : (
                          <button
                            onClick={() => openProduct(r)}
                            className="text-primary hover:underline font-semibold inline-flex items-center gap-1"
                          >
                            <Sparkles size={11} /> Get suggestion
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {recs.size > 0 && (
        <p className="text-[11px] text-muted-foreground">
          Click a product name, or "Get suggestion", for the AI's recommendation and reasoning. Suggestions only — not auto-applied to any campaign.
        </p>
      )}

      <AiSuggestionModal
        isOpen={!!activeProduct}
        onClose={() => setActiveProduct(null)}
        title={activeProduct?.name || ""}
        suggestions={
          activeProduct
            ? activeRec
              ? [
                  `${activeProduct.platform} · Spend ₹${(activeProduct.spendTax ?? 0).toLocaleString("en-IN")} vs Sales ₹${(activeProduct.sales ?? 0).toLocaleString("en-IN")} · Orders ${activeProduct.orders ?? 0} · ACOS ${activeProduct.acos ?? 0}%`,
                  `Recommendation: ${activeRec.action}`,
                  activeRec.reason || "No further reasoning returned.",
                ]
              : [
                  `${activeProduct.platform} · Spend ₹${(activeProduct.spendTax ?? 0).toLocaleString("en-IN")} vs Sales ₹${(activeProduct.sales ?? 0).toLocaleString("en-IN")} · Orders ${activeProduct.orders ?? 0} · ACOS ${activeProduct.acos ?? 0}%`,
                  activePending
                    ? "Generating this product's AI recommendation — a few seconds…"
                    : genError
                      ? `AI recommendation failed to generate: ${genError}. Close and click the product again to retry.`
                      : "Generating this product's AI recommendation — a few seconds…",
                ]
            : []
        }
      />
    </div>
  );
}
