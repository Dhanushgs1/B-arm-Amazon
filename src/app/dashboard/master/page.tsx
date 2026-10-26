"use client";

import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as XLSX from "xlsx";
import {
  ArrowDown,
  ArrowUp,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Database,
  Download,
  LayoutList,
  Loader2,
  Package,
  Pencil,
  RefreshCw,
  Rows3,
  Search,
  Star,
  Trash2,
  XCircle,
} from "lucide-react";
import { DataTable } from "@/components/DataTable";
import { QueryErrorState } from "@/components/QueryErrorState";
import {
  fetchProductMarketingCatalog,
  deleteProductMarketingRow,
  type ProductMarketingCatalogRow,
} from "@/lib/productMarketingUpload";
import { fetchRatingMetrics } from "@/lib/productRatingMetrics";
import { CATEGORY_COLORS } from "@/lib/categoryMap";
import { cn } from "@/lib/utils";
import { MasterProductEditModal } from "./MasterProductEditModal";

// Not in CATEGORY_COLORS (which is Amazon-category-scoped) — brand colors for the platform tabs,
// falling back to indigo for any platform value the sheet carries that isn't one of these.
const PLATFORM_COLORS: Record<string, string> = {
  Amazon: "#FF9900",
  Flipkart: "#2874F0",
  Meesho: "#9F2089",
  Shopsy: "#0F9D58",
  Shopify: "#5E8E3E",
};
const platformColor = (p: string) => PLATFORM_COLORS[p] || "#6c63ff";

const PAGE_SIZE = 25;
const fmtInt = (n: number) => n.toLocaleString("en-IN");

type Row = ProductMarketingCatalogRow & { rating: number | null; reviews: number | null };

interface Product {
  key: string;
  name: string;
  category: string;
  rows: Row[];
  byPlatform: Record<string, Row[]>;
  coverage: number; // platforms this product is listed on
  skuCount: number; // distinct SKU IDs
  rating: number | null; // best-reviewed rated listing
  reviews: number; // summed per platform (best-reviewed row each), so variants aren't double-counted
}

type ProductSort = "name" | "coverage" | "skus" | "rating" | "reviews";

function Stat({ icon: Icon, label, value, sub }: { icon: React.ElementType; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <div className="mt-2 text-2xl font-bold tabular-nums text-foreground">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function RatingCell({ rating, reviews }: { rating: number | null; reviews: number | null }) {
  if (rating === null) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs tabular-nums">
      <Star className={cn("h-3 w-3 fill-current", rating >= 4 ? "text-amber-400" : "text-red-500")} />
      <span className={cn("font-bold", rating >= 4 ? "text-foreground" : "text-red-600 dark:text-red-400")}>{rating.toFixed(1)}</span>
      {reviews !== null && <span className="text-muted-foreground">({fmtInt(reviews)})</span>}
    </span>
  );
}

function Chip({ label, count, active, color, onClick }: { label: string; count: number; active: boolean; color: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-2 whitespace-nowrap rounded-xl border px-3.5 py-2 text-xs font-bold transition-all focus:outline-none",
        active
          ? "bg-white text-slate-800 shadow-sm dark:bg-slate-900 dark:text-white"
          : "border-transparent bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-slate-900/60 dark:text-slate-400 dark:hover:bg-slate-800"
      )}
      style={active ? { borderColor: color, color } : {}}
    >
      {label}
      <span className={cn("rounded-full px-1.5 py-px text-[10px] tabular-nums", !active && "bg-background/70")} style={active ? { background: `${color}1a` } : {}}>
        {fmtInt(count)}
      </span>
    </button>
  );
}

export default function MasterPage() {
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [selectedPlatform, setSelectedPlatform] = useState("All");
  const [view, setView] = useState<"product" | "sku">("product");
  const [query, setQuery] = useState("");
  const [missingOn, setMissingOn] = useState("");
  const [sort, setSort] = useState<{ key: ProductSort; dir: "asc" | "desc" }>({ key: "coverage", dir: "desc" });
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editingRow, setEditingRow] = useState<ProductMarketingCatalogRow | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [actionStatus, setActionStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["product_marketing_catalog"],
    queryFn: fetchProductMarketingCatalog,
  });
  // Same query (and cache) as the Ratings & Reviews tab — only used to put stars next to SKUs.
  const { data: ratingData } = useQuery({
    queryKey: ["product-rating-review-metrics"],
    queryFn: fetchRatingMetrics,
    staleTime: 5 * 60 * 1000,
  });

  // Latest rating per SKU. The rating sheet tags SKU IDs with their channel — "A005(AM)", "B-CT-R(FK)",
  // "B-CT-Y(Meesho)" — which this table doesn't, so the tag is stripped before matching on platform + SKU,
  // then platform + product name. Channels without rating data get none.
  const rows: Row[] = useMemo(() => {
    type V = { rating: number; reviews: number };
    const bySku = new Map<string, V>();
    const byName = new Map<string, V>();
    const keep = (m: Map<string, V>, k: string, v: V) => {
      const cur = m.get(k);
      if (!cur || v.reviews > cur.reviews) m.set(k, v);
    };
    for (const i of ratingData?.items ?? []) {
      if (i.rating === null) continue;
      const v = { rating: i.rating, reviews: i.reviews };
      const p = i.platform.toLowerCase();
      const sku = i.skuId.trim().replace(/\((am|fk|meesho|shopsy)\)$/i, "").trim().toLowerCase();
      if (sku) keep(bySku, `${p}|${sku}`, v);
      keep(byName, `${p}|${i.productName.trim().toLowerCase()}`, v);
    }
    return (data ?? []).map((r) => {
      const p = r.platform.toLowerCase();
      const sku = r.sku.toLowerCase();
      const hit = bySku.get(`${p}|${sku}`) ?? byName.get(`${p}|${r.name.toLowerCase()}`);
      return { ...r, rating: hit?.rating ?? null, reviews: hit?.reviews ?? null };
    });
  }, [data, ratingData]);

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

  // Chip lists come from the data, not a hardcoded set — this table's Category/Platform values
  // aren't curated the way the Amazon-ads Category filter is. Platforms by size, biggest first.
  const platformCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) if (r.platform) m.set(r.platform, (m.get(r.platform) ?? 0) + 1);
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  }, [rows]);
  const platforms = useMemo(() => platformCounts.map(([p]) => p), [platformCounts]);

  const platformRows = useMemo(() => rows.filter((r) => selectedPlatform === "All" || r.platform === selectedPlatform), [rows, selectedPlatform]);
  const categoryCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of platformRows) if (r.category) m.set(r.category, (m.get(r.category) ?? 0) + 1);
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [platformRows]);

  const filteredRows = platformRows.filter((r) => selectedCategory === "All" || r.category === selectedCategory);

  // Products are grouped by name across every platform (the platform chip narrows which products show,
  // never which platform columns), so a missing listing is visible as a gap in its row.
  const allProducts = useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const r of rows) {
      const k = (r.name || r.sku).trim().toLowerCase();
      const arr = map.get(k);
      if (arr) arr.push(r);
      else map.set(k, [r]);
    }
    const out: Product[] = [];
    for (const [key, rs] of map) {
      const byPlatform: Record<string, Row[]> = {};
      for (const r of rs) (byPlatform[r.platform] ??= []).push(r);
      const cats = new Map<string, number>();
      for (const r of rs) if (r.category) cats.set(r.category, (cats.get(r.category) ?? 0) + 1);
      let best: Row | null = null;
      let reviews = 0;
      for (const prs of Object.values(byPlatform)) {
        const top = prs.filter((r) => r.rating !== null).sort((a, b) => (b.reviews ?? 0) - (a.reviews ?? 0))[0];
        if (!top) continue;
        reviews += top.reviews ?? 0;
        if (!best || (top.reviews ?? 0) > (best.reviews ?? 0)) best = top;
      }
      out.push({
        key,
        name: rs[0].name || rs[0].sku,
        category: [...cats.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "",
        rows: rs,
        byPlatform,
        coverage: Object.keys(byPlatform).length,
        skuCount: new Set(rs.map((r) => r.sku)).size,
        rating: best?.rating ?? null,
        reviews,
      });
    }
    return out;
  }, [rows]);

  const stats = useMemo(() => {
    const ratedPlatforms = new Set((ratingData?.items ?? []).filter((i) => i.rating !== null).map((i) => i.platform));
    const onRated = rows.filter((r) => ratedPlatforms.has(r.platform));
    return {
      products: allProducts.length,
      skus: new Set(rows.map((r) => r.sku).filter(Boolean)).size,
      rows: rows.length,
      rated: onRated.filter((r) => r.rating !== null).length,
      onRated: onRated.length,
      below4: allProducts.filter((p) => p.rating !== null && p.rating < 4).length,
      coverage: platforms.map((p) => ({ platform: p, products: allProducts.filter((x) => x.byPlatform[p]).length })),
    };
  }, [rows, allProducts, platforms, ratingData]);

  const productRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = allProducts.filter(
      (p) =>
        (selectedPlatform === "All" || p.byPlatform[selectedPlatform]) &&
        (selectedCategory === "All" || p.rows.some((r) => r.category === selectedCategory)) &&
        (!missingOn || !p.byPlatform[missingOn]) &&
        (!q || p.name.toLowerCase().includes(q) || p.rows.some((r) => r.sku.toLowerCase().includes(q)))
    );
    const dir = sort.dir === "asc" ? 1 : -1;
    const val = (p: Product): number | string => {
      switch (sort.key) {
        case "coverage":
          return p.coverage;
        case "skus":
          return p.skuCount;
        case "rating":
          return p.rating ?? (sort.dir === "asc" ? 99 : -1);
        case "reviews":
          return p.reviews;
        default:
          return p.name.toLowerCase();
      }
    };
    return list.sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * dir || a.name.localeCompare(b.name);
    });
  }, [allProducts, selectedPlatform, selectedCategory, missingOn, query, sort]);

  const pageCount = Math.max(1, Math.ceil(productRows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = productRows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const toggleSort = (key: ProductSort) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "name" ? "asc" : "desc" }));
    setPage(0);
  };
  const toggleExpand = (key: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  const exportProducts = () => {
    const sheet = XLSX.utils.json_to_sheet(
      productRows.map((p) => ({
        Product: p.name,
        Category: p.category,
        "SKU IDs": p.skuCount,
        Platforms: p.coverage,
        ...Object.fromEntries(platforms.map((pl) => [pl, p.byPlatform[pl]?.length ?? 0])),
        Rating: p.rating ?? "",
        Reviews: p.rating === null ? "" : p.reviews,
      }))
    );
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Products");
    XLSX.writeFile(wb, "master-products.xlsx");
  };

  const actions = (row: ProductMarketingCatalogRow) => (
    <div className="flex items-center gap-1">
      <button
        onClick={() => setEditingRow(row)}
        className="cursor-pointer rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-indigo-500/10 hover:text-indigo-600"
        title="Edit"
      >
        <Pencil size={14} />
      </button>
      <button
        onClick={() => handleDelete(row)}
        disabled={deletingId === row.id}
        className="cursor-pointer rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-600 disabled:opacity-40"
        title="Delete"
      >
        {deletingId === row.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
      </button>
    </div>
  );

  const categoryPill = (val: string) => {
    const color = CATEGORY_COLORS[val] || CATEGORY_COLORS.Other;
    return val ? (
      <span className="whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold" style={{ background: `${color}1a`, color }}>
        {val}
      </span>
    ) : (
      <span className="text-xs text-muted-foreground">—</span>
    );
  };

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
    { key: "category", label: "Category", sortable: true, render: categoryPill },
    {
      key: "platform",
      label: "Platform",
      sortable: true,
      render: (val: string) => (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
          <span className="h-2 w-2 rounded-full" style={{ background: platformColor(val) }} />
          {val || "—"}
        </span>
      ),
    },
    {
      key: "rating",
      label: "Rating",
      sortable: true,
      render: (val: number | null, row: Row) => <RatingCell rating={val} reviews={row.reviews} />,
    },
    { key: "reviews", label: "Reviews", sortable: true, render: (val: number | null) => <span className="text-xs tabular-nums text-foreground">{val === null ? "—" : fmtInt(val)}</span> },
    {
      key: "id",
      label: "Actions",
      exportValue: () => "",
      render: (_val: number, row: Row) => actions(row),
    },
  ];

  const sortHead = (k: ProductSort, label: string, className?: string) => (
    <th className={cn("px-3 py-2.5 font-semibold", className)}>
      <button onClick={() => toggleSort(k)} className={cn("inline-flex items-center gap-1 hover:text-foreground", sort.key === k && "text-foreground")}>
        {label}
        {sort.key === k && (sort.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
      </button>
    </th>
  );

  return (
    <div className="space-y-6 pb-12">
      {isError && <QueryErrorState compact message="Master SKU catalog couldn't load — retry." onRetry={() => refetch()} />}

      {actionStatus && (
        <div
          className={cn(
            "flex items-center gap-1.5 rounded-xl border px-4 py-2.5 text-xs font-semibold",
            actionStatus.type === "success"
              ? "border-green-500/20 bg-green-500/10 text-green-600 dark:text-green-400"
              : "border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-400"
          )}
        >
          {actionStatus.type === "success" ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
          {actionStatus.message}
        </div>
      )}

      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Master Product Catalog</h1>
          <p className="mt-1 text-sm text-muted-foreground">Every product, SKU ID and category on record, across platforms — with latest ratings where tracked.</p>
        </div>
        <button
          onClick={() => refetch()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} /> Refresh
        </button>
      </div>

      {isLoading ? (
        <div className="glass flex h-[400px] flex-col items-center justify-center gap-4 rounded-[22px] border border-border text-muted-foreground">
          <Loader2 className="h-7 w-7 animate-spin text-primary" />
          <p className="text-sm font-semibold">Loading Master Catalog...</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="glass flex h-[300px] flex-col items-center justify-center gap-3 rounded-[22px] border border-border px-6 text-center text-muted-foreground">
          <Database className="h-7 w-7 text-muted-foreground" />
          <p className="text-sm font-semibold">No rows in master_product_marketing yet.</p>
        </div>
      ) : (
        <>
          {/* Summary */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-5">
            <div className="grid grid-cols-2 gap-3 lg:col-span-3">
              <Stat icon={Package} label="Products" value={fmtInt(stats.products)} sub={`${fmtInt(allProducts.filter((p) => p.coverage === 1).length)} on one platform only`} />
              <Stat icon={Boxes} label="SKU IDs" value={fmtInt(stats.skus)} sub={`${fmtInt(stats.rows)} platform listings`} />
              <Stat
                icon={Star}
                label="SKUs with a rating"
                value={`${fmtInt(stats.rated)} / ${fmtInt(stats.onRated)}`}
                sub={ratingData ? "on channels that carry ratings" : "loading ratings…"}
              />
              <Stat icon={XCircle} label="Products below 4★" value={fmtInt(stats.below4)} sub="best-reviewed listing under 4★" />
            </div>
            <div className="rounded-2xl border border-border bg-card p-4 shadow-sm lg:col-span-2">
              <div className="mb-3 flex items-baseline justify-between">
                <h3 className="text-sm font-bold text-foreground">Platform coverage</h3>
                <span className="text-[11px] text-muted-foreground">products listed · click to filter</span>
              </div>
              <div className="space-y-1">
                {stats.coverage.map((c) => {
                  const pct = stats.products ? (c.products / stats.products) * 100 : 0;
                  const active = selectedPlatform === c.platform;
                  return (
                    <button
                      key={c.platform}
                      onClick={() => {
                        setSelectedPlatform(active ? "All" : c.platform);
                        setPage(0);
                      }}
                      className={cn("grid w-full grid-cols-[96px_1fr_auto] items-center gap-3 rounded-lg px-2 py-1 text-left", active ? "bg-muted ring-1 ring-border" : "hover:bg-muted/60")}
                    >
                      <span className="truncate text-xs font-semibold text-foreground">{c.platform}</span>
                      <span className="h-2 overflow-hidden rounded-full bg-muted">
                        <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: platformColor(c.platform) }} />
                      </span>
                      <span className="min-w-[70px] text-right text-xs tabular-nums">
                        <b className="text-foreground">{fmtInt(c.products)}</b> <span className="text-muted-foreground">{Math.round(pct)}%</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Filters */}
          <div className="space-y-2">
            <div className="scrollbar-none -mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-1">
              {[["All", rows.length] as [string, number], ...platformCounts].map(([p, n]) => (
                <Chip
                  key={p}
                  label={p === "All" ? "All platforms" : p}
                  count={n}
                  active={selectedPlatform === p}
                  color={p === "All" ? "#6c63ff" : platformColor(p)}
                  onClick={() => {
                    setSelectedPlatform(p);
                    setPage(0);
                  }}
                />
              ))}
            </div>
            <div className="scrollbar-none -mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-1">
              {[["All", platformRows.length] as [string, number], ...categoryCounts].map(([cat, n]) => (
                <Chip
                  key={cat}
                  label={cat === "All" ? "All categories" : cat}
                  count={n}
                  active={selectedCategory === cat}
                  color={CATEGORY_COLORS[cat] || CATEGORY_COLORS.Other}
                  onClick={() => {
                    setSelectedCategory(cat);
                    setPage(0);
                  }}
                />
              ))}
            </div>
          </div>

          {/* View switch */}
          <div className="inline-flex rounded-xl border border-border bg-muted/50 p-1">
            {(
              [
                ["product", "By product", LayoutList],
                ["sku", "By SKU", Rows3],
              ] as const
            ).map(([k, label, Icon]) => (
              <button
                key={k}
                onClick={() => setView(k)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-xs font-semibold transition-colors",
                  view === k ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className="h-3.5 w-3.5" /> {label}
              </button>
            ))}
          </div>

          {view === "sku" ? (
            <DataTable data={filteredRows} columns={columns} defaultSort="sku" exportName="master-product-marketing" />
          ) : (
            <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
                <div>
                  <h3 className="text-sm font-bold text-foreground">Products</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {fmtInt(productRows.length)} of {fmtInt(allProducts.length)} · ✓ = listed (number of SKU IDs) · — = not on that platform
                  </p>
                </div>
                <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                  <select
                    value={missingOn}
                    onChange={(e) => {
                      setMissingOn(e.target.value);
                      setPage(0);
                    }}
                    className="rounded-lg border border-border bg-background px-2.5 py-2 text-xs font-medium text-foreground"
                  >
                    <option value="">Any coverage</option>
                    {platforms.map((p) => (
                      <option key={p} value={p}>
                        Not on {p}
                      </option>
                    ))}
                  </select>
                  <div className="relative min-w-0 flex-1 sm:w-56 sm:flex-none">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <input
                      value={query}
                      onChange={(e) => {
                        setQuery(e.target.value);
                        setPage(0);
                      }}
                      placeholder="Search product or SKU"
                      className="w-full rounded-lg border border-border bg-background py-2 pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                    />
                  </div>
                  <button
                    onClick={exportProducts}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Download className="h-3.5 w-3.5" /> Export
                  </button>
                </div>
              </div>

              {/* Phones: one card per product */}
              <ul className="divide-y divide-border md:hidden">
                {pageRows.map((p) => {
                  const open = expanded.has(p.key);
                  return (
                    <li key={p.key}>
                      <button onClick={() => toggleExpand(p.key)} className="w-full px-4 py-3 text-left active:bg-muted/60">
                        <span className="flex items-start justify-between gap-3">
                          <span className="min-w-0">
                            <span className="block text-sm font-semibold leading-snug text-foreground">{p.name}</span>
                            <span className="mt-1 flex flex-wrap items-center gap-1.5">
                              {categoryPill(p.category)}
                              <span className="text-[11px] text-muted-foreground">
                                {p.skuCount} SKU{p.skuCount === 1 ? "" : "s"} · {p.coverage}/{platforms.length} platforms
                              </span>
                            </span>
                          </span>
                          <RatingCell rating={p.rating} reviews={p.rating === null ? null : p.reviews} />
                        </span>
                        <span className="mt-2 flex flex-wrap gap-1">
                          {platforms.map((pl) => (
                            <span
                              key={pl}
                              className={cn("rounded-md px-1.5 py-0.5 text-[10px] font-semibold", p.byPlatform[pl] ? "text-white" : "bg-muted text-muted-foreground/60 line-through")}
                              style={p.byPlatform[pl] ? { background: platformColor(pl) } : {}}
                            >
                              {pl}
                            </span>
                          ))}
                        </span>
                      </button>
                      {open && (
                        <ul className="space-y-1 bg-muted/30 px-4 py-2">
                          {p.rows.map((r) => (
                            <li key={r.id} className="flex items-center gap-2 text-xs">
                              <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: platformColor(r.platform) }} />
                              <span className="min-w-0 flex-1 truncate font-mono text-foreground">{r.sku}</span>
                              <RatingCell rating={r.rating} reviews={null} />
                              {actions(r)}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>

              <div className="hidden overflow-x-auto md:block">
                <table className="w-full min-w-[900px] text-sm">
                  <thead className="bg-muted/40 text-left text-[11px] text-muted-foreground">
                    <tr>
                      {sortHead("name", "Product", "pl-4")}
                      {platforms.map((pl) => (
                        <th key={pl} className="px-2 py-2.5 text-center font-semibold">
                          <span className="inline-flex items-center gap-1">
                            <span className="h-1.5 w-1.5 rounded-full" style={{ background: platformColor(pl) }} />
                            {pl}
                          </span>
                        </th>
                      ))}
                      {sortHead("coverage", "Coverage", "text-right")}
                      {sortHead("rating", "Rating", "text-right")}
                      {sortHead("reviews", "Reviews", "text-right")}
                      <th className="w-10 pr-4" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {pageRows.map((p) => {
                      const open = expanded.has(p.key);
                      return (
                        <Fragment key={p.key}>
                          <tr className={cn("cursor-pointer hover:bg-muted/40", open && "bg-muted/30")} onClick={() => toggleExpand(p.key)}>
                            <td className="max-w-[340px] py-2.5 pl-4 pr-3">
                              <span className="block truncate font-semibold text-foreground" title={p.name}>
                                {p.name}
                              </span>
                              <span className="mt-0.5 flex items-center gap-1.5">
                                {categoryPill(p.category)}
                                <span className="text-[11px] text-muted-foreground">
                                  {p.skuCount} SKU ID{p.skuCount === 1 ? "" : "s"}
                                </span>
                              </span>
                            </td>
                            {platforms.map((pl) => {
                              const n = p.byPlatform[pl]?.length ?? 0;
                              return (
                                <td key={pl} className="px-2 py-2.5 text-center">
                                  {n ? (
                                    <span
                                      className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] font-bold"
                                      style={{ background: `${platformColor(pl)}1f`, color: platformColor(pl) }}
                                      title={`${n} SKU row${n === 1 ? "" : "s"} on ${pl}`}
                                    >
                                      <Check className="h-3 w-3" />
                                      {n > 1 && n}
                                    </span>
                                  ) : (
                                    <span className="text-muted-foreground/50">—</span>
                                  )}
                                </td>
                              );
                            })}
                            <td className="px-3 py-2.5 text-right">
                              <span className="inline-flex items-center gap-2">
                                <span className="h-1.5 w-12 overflow-hidden rounded-full bg-muted">
                                  <span className="block h-full rounded-full bg-indigo-500" style={{ width: `${(p.coverage / Math.max(1, platforms.length)) * 100}%` }} />
                                </span>
                                <span className="text-xs tabular-nums text-foreground">
                                  {p.coverage}/{platforms.length}
                                </span>
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-right">
                              <RatingCell rating={p.rating} reviews={null} />
                            </td>
                            <td className="px-3 py-2.5 text-right text-xs tabular-nums text-foreground">{p.rating === null ? "—" : fmtInt(p.reviews)}</td>
                            <td className="pr-4 text-muted-foreground">
                              <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
                            </td>
                          </tr>
                          {open && (
                            <tr className="bg-muted/20">
                              <td colSpan={platforms.length + 5} className="px-4 py-2">
                                <table className="w-full text-xs">
                                  <tbody className="divide-y divide-border/60">
                                    {[...p.rows]
                                      .sort((a, b) => a.platform.localeCompare(b.platform) || a.sku.localeCompare(b.sku))
                                      .map((r) => (
                                        <tr key={r.id}>
                                          <td className="w-[140px] py-1.5 pl-4">
                                            <span className="inline-flex items-center gap-1.5 font-semibold text-muted-foreground">
                                              <span className="h-2 w-2 rounded-full" style={{ background: platformColor(r.platform) }} />
                                              {r.platform}
                                            </span>
                                          </td>
                                          <td className="py-1.5 font-mono font-bold text-foreground">{r.sku}</td>
                                          <td className="max-w-[320px] truncate py-1.5 text-muted-foreground" title={r.name}>
                                            {r.name}
                                          </td>
                                          <td className="py-1.5 text-right">
                                            <RatingCell rating={r.rating} reviews={r.reviews} />
                                          </td>
                                          <td className="w-[80px] py-1.5 pl-3">{actions(r)}</td>
                                        </tr>
                                      ))}
                                  </tbody>
                                </table>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {pageRows.length === 0 && <p className="py-12 text-center text-sm text-muted-foreground">No products match these filters.</p>}

              {productRows.length > PAGE_SIZE && (
                <div className="flex items-center justify-between border-t border-border px-4 py-3 text-xs text-muted-foreground">
                  <span>
                    {fmtInt(safePage * PAGE_SIZE + 1)}–{fmtInt(Math.min(productRows.length, (safePage + 1) * PAGE_SIZE))} of {fmtInt(productRows.length)}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      disabled={safePage === 0}
                      onClick={() => setPage(safePage - 1)}
                      className="rounded-md border border-border p-1.5 hover:bg-muted disabled:opacity-40"
                      aria-label="Previous page"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </button>
                    <span className="px-2 tabular-nums">
                      {safePage + 1} / {pageCount}
                    </span>
                    <button
                      disabled={safePage >= pageCount - 1}
                      onClick={() => setPage(safePage + 1)}
                      className="rounded-md border border-border p-1.5 hover:bg-muted disabled:opacity-40"
                      aria-label="Next page"
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
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
