"use client";

import { useState, useMemo } from "react";
import { motion } from "framer-motion";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, LabelList,
} from "recharts";
import { Layers, Star, Search, TrendingUp, TrendingDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RRProduct } from "@/lib/ratingsReviewsData";
import { channelLabel } from "@/lib/barmRatingReviewData";

const TOOLTIP_STYLE = {
  backgroundColor: "var(--card)",
  borderRadius: "12px",
  border: "1px solid var(--border)",
  boxShadow: "0 8px 24px -4px rgba(0,0,0,0.15)",
  fontSize: "11px",
  fontWeight: "700" as const,
  padding: "10px 14px",
};

const RATING_COLOR = (r: number) =>
  r >= 4.5 ? "#10B981"
  : r >= 4.0 ? "#34D399"
  : r >= 3.5 ? "#F59E0B"
  : r >= 3.0 ? "#F97316"
  : "#EF4444";

const HEALTH_COLOR = (h: number) =>
  h >= 80 ? "#10B981" : h >= 60 ? "#F59E0B" : "#EF4444";

type ViewMode = "rating" | "health" | "reviews" | "returns";

const VIEW_LABELS: Record<ViewMode, string> = {
  rating: "Avg Rating ★",
  health: "Health Score",
  reviews: "Review Count",
  returns: "Return Rate %",
};

interface CustomTooltipProps {
  active?: boolean;
  payload?: any[];
}

function CustomTooltip({ active, payload }: CustomTooltipProps) {
  if (!active || !payload?.length) return null;
  const p: RRProduct = payload[0]?.payload?._raw;
  if (!p) return null;
  return (
    <div style={TOOLTIP_STYLE}>
      <p className="font-black text-[12px] text-foreground mb-1.5">{p.name}</p>
      <p className="text-[10px] font-mono text-muted-foreground mb-1.5">SKU: <span className="text-indigo-500 font-black">{p.sku}</span></p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <span className="text-[10px] text-muted-foreground">Rating</span>
        <span className="text-[10px] font-black" style={{ color: RATING_COLOR(p.avgRating) }}>{p.avgRating > 0 ? `${p.avgRating.toFixed(1)}★` : "—"}</span>
        <span className="text-[10px] text-muted-foreground">Reviews</span>
        <span className="text-[10px] font-black">{p.reviewCount.toLocaleString("en-IN")}</span>
        <span className="text-[10px] text-muted-foreground">Return Rate</span>
        <span className="text-[10px] font-black" style={{ color: p.returnRate > 15 ? "#EF4444" : "#10B981" }}>{p.returnRate.toFixed(1)}%</span>
        <span className="text-[10px] text-muted-foreground">Health</span>
        <span className="text-[10px] font-black" style={{ color: HEALTH_COLOR(p.healthScore) }}>{p.healthScore}/100</span>
        <span className="text-[10px] text-muted-foreground">Platform</span>
        <span className="text-[10px] font-black">{channelLabel(p.platform)}</span>
      </div>
    </div>
  );
}

export function SkuRatingsChart({ products }: { products: RRProduct[] }) {
  const [viewMode, setViewMode] = useState<ViewMode>("rating");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const PER_PAGE = 20;

  const filtered = useMemo(() => {
    let list = products.filter((p) =>
      !search || p.sku.toLowerCase().includes(search.toLowerCase()) || p.name.toLowerCase().includes(search.toLowerCase())
    );
    // Sort: for rating/health sort descending, for returns sort descending (worst first)
    list = [...list].sort((a, b) => {
      if (viewMode === "rating") return b.avgRating - a.avgRating;
      if (viewMode === "health") return b.healthScore - a.healthScore;
      if (viewMode === "reviews") return b.reviewCount - a.reviewCount;
      if (viewMode === "returns") return b.returnRate - a.returnRate;
      return 0;
    });
    return list;
  }, [products, search, viewMode]);

  const totalPages = Math.ceil(filtered.length / PER_PAGE);
  const paged = filtered.slice(page * PER_PAGE, (page + 1) * PER_PAGE);

  const chartData = paged.map((p) => ({
    sku: p.sku,
    label: p.sku,
    value:
      viewMode === "rating" ? p.avgRating
      : viewMode === "health" ? p.healthScore
      : viewMode === "reviews" ? p.reviewCount
      : p.returnRate,
    _raw: p,
  }));

  const domainMax =
    viewMode === "rating" ? 5
    : viewMode === "health" ? 100
    : viewMode === "reviews" ? Math.max(...chartData.map((d) => d.value), 100)
    : 100;

  // SKU summary pills
  const available = products.length;
  const rated = products.filter((p) => p.avgRating > 0).length;
  const unrated = available - rated;
  const critical = products.filter((p) => p.healthScore < 40).length;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="glass gradient-border rounded-3xl overflow-hidden"
    >
      {/* Header */}
      <div className="px-6 pt-5 pb-4 border-b border-border">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-xl bg-gradient-to-br from-indigo-500/20 to-purple-500/20 flex items-center justify-center">
              <Layers className="w-4 h-4 text-indigo-500" />
            </div>
            <div>
              <h2 className="font-black text-sm text-foreground tracking-tight">Available SKU Chart</h2>
              <p className="text-[10px] text-muted-foreground font-semibold">All SKU IDs with performance metrics</p>
            </div>
          </div>

          {/* Summary pills */}
          <div className="flex items-center gap-2 flex-wrap ml-2">
            <span className="text-[9px] font-black px-2 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-600 dark:text-indigo-400">
              {available} Total SKUs
            </span>
            <span className="text-[9px] font-black px-2 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400">
              {rated} Rated
            </span>
            {unrated > 0 && (
              <span className="text-[9px] font-black px-2 py-1 rounded-full bg-muted border border-border text-muted-foreground">
                {unrated} Unrated
              </span>
            )}
            {critical > 0 && (
              <span className="text-[9px] font-black px-2 py-1 rounded-full bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 animate-pulse">
                ● {critical} Critical
              </span>
            )}
          </div>

          {/* Controls */}
          <div className="ml-auto flex items-center gap-2 flex-wrap">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search SKU / name…"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                className="pl-7 pr-2 py-1.5 text-[10px] font-semibold bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-500 w-40"
              />
            </div>
            {/* View mode toggle */}
            <div className="flex bg-muted p-0.5 rounded-lg gap-0.5">
              {(["rating", "health", "reviews", "returns"] as ViewMode[]).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  className={cn(
                    "text-[9px] font-black px-2 py-1 rounded-md transition-all capitalize whitespace-nowrap",
                    viewMode === mode
                      ? "bg-background shadow text-indigo-600 dark:text-indigo-400"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {mode === "rating" ? "Rating" : mode === "health" ? "Health" : mode === "reviews" ? "Reviews" : "Returns"}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Bar Chart */}
      <div className="px-4 pt-4">
        <div className="flex items-center justify-between mb-2 px-2">
          <span className="text-[10px] font-black uppercase tracking-wider text-muted-foreground">
            {VIEW_LABELS[viewMode]} — {filtered.length} SKUs (showing {page * PER_PAGE + 1}–{Math.min((page + 1) * PER_PAGE, filtered.length)})
          </span>
          <div className="flex items-center gap-1.5 text-[9px] text-muted-foreground font-semibold">
            {viewMode === "rating" && <>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />≥4.5★</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500 inline-block" />3.5–4.4</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500 inline-block" />&lt;3.5</span>
            </>}
            {viewMode === "returns" && <>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500 inline-block" />&gt;18% High</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500 inline-block" />10–18%</span>
            </>}
          </div>
        </div>

        <ResponsiveContainer width="100%" height={Math.max(200, paged.length * 28)}>
          <BarChart
            data={chartData}
            layout="vertical"
            margin={{ top: 0, right: 60, left: 0, bottom: 0 }}
            barSize={16}
          >
            <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--border)" opacity={0.4} />
            <XAxis
              type="number"
              domain={[0, domainMax]}
              tick={{ fontSize: 9, fill: "var(--muted-foreground)", fontWeight: 600 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v) =>
                viewMode === "rating" ? `${v}★`
                : viewMode === "health" ? `${v}`
                : viewMode === "reviews" ? v >= 1000 ? `${(v / 1000).toFixed(1)}K` : String(v)
                : `${v}%`
              }
            />
            <YAxis
              type="category"
              dataKey="label"
              width={100}
              tick={{ fontSize: 9, fill: "var(--muted-foreground)", fontWeight: 700, fontFamily: "monospace" }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip content={<CustomTooltip />} cursor={{ fill: "var(--muted)", opacity: 0.3 }} />
            <Bar dataKey="value" radius={[0, 6, 6, 0]}>
              {chartData.map((d, i) => {
                const color =
                  viewMode === "rating" ? RATING_COLOR(d._raw.avgRating)
                  : viewMode === "health" ? HEALTH_COLOR(d._raw.healthScore)
                  : viewMode === "reviews" ? "#6366F1"
                  : d._raw.returnRate > 18 ? "#EF4444" : d._raw.returnRate > 10 ? "#F59E0B" : "#10B981";
                return <Cell key={i} fill={color} opacity={0.85} />;
              })}
              <LabelList
                dataKey="value"
                position="right"
                style={{ fontSize: 9, fontWeight: 700, fill: "var(--muted-foreground)" }}
                formatter={(v: any) => {
                  const n = Number(v);
                  if (viewMode === "rating") return `${n.toFixed(1)}★`;
                  if (viewMode === "health") return `${n}/100`;
                  if (viewMode === "reviews") return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(Math.round(n));
                  return `${n.toFixed(1)}%`;
                }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* SKU List Table (compact, shows all IDs clearly) */}
      <div className="px-4 pb-2 mt-2">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border">
                {["SKU ID", "Product Name", "Platform", "Rating", "Reviews", "Health", "Return %", "Status"].map((h) => (
                  <th key={h} className="px-2 py-2 text-left text-[9px] font-black uppercase tracking-wider text-muted-foreground whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paged.map((p, i) => (
                <motion.tr
                  key={`${p.id}-${i}`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: i * 0.02 }}
                  className="border-b border-border/40 hover:bg-muted/30 transition-colors"
                >
                  <td className="px-2 py-2">
                    <span className="font-mono font-black text-[10px] text-indigo-600 dark:text-indigo-400 bg-indigo-500/10 px-1.5 py-0.5 rounded">
                      {p.sku}
                    </span>
                  </td>
                  <td className="px-2 py-2 font-semibold text-[11px] text-foreground max-w-[200px] truncate">{p.name}</td>
                  <td className="px-2 py-2">
                    <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-muted border border-border text-muted-foreground">
                      {channelLabel(p.platform)}
                    </span>
                  </td>
                  <td className="px-2 py-2">
                    {p.avgRating > 0 ? (
                      <span className="flex items-center gap-1 font-black text-[10px]" style={{ color: RATING_COLOR(p.avgRating) }}>
                        <Star className="w-3 h-3 fill-current" />{p.avgRating.toFixed(1)}
                      </span>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-2 py-2 font-bold tabular-nums text-[10px]">{p.reviewCount.toLocaleString("en-IN")}</td>
                  <td className="px-2 py-2">
                    <div className="flex items-center gap-1.5">
                      <div className="w-14 h-1.5 bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${p.healthScore}%`, background: HEALTH_COLOR(p.healthScore) }}
                        />
                      </div>
                      <span className="text-[9px] font-black" style={{ color: HEALTH_COLOR(p.healthScore) }}>{p.healthScore}</span>
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    <span className={cn("font-black text-[10px]",
                      p.returnRate > 18 ? "text-red-500" : p.returnRate > 10 ? "text-amber-500" : "text-emerald-500"
                    )}>
                      {p.returnRate.toFixed(1)}%
                    </span>
                  </td>
                  <td className="px-2 py-2">
                    <span className={cn("text-[8px] font-black px-1.5 py-0.5 rounded-full border",
                      p.healthScore >= 80 ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800"
                      : p.healthScore >= 60 ? "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400 border-amber-200 dark:border-amber-800"
                      : "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400 border-red-200 dark:border-red-800"
                    )}>
                      {p.healthStatus}
                    </span>
                  </td>
                </motion.tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-6 py-3 border-t border-border">
          <p className="text-[10px] text-muted-foreground font-semibold">
            {filtered.length} SKUs total · Page {page + 1} of {totalPages}
          </p>
          <div className="flex items-center gap-1">
            <button
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
              className="text-[10px] font-black px-2.5 py-1 rounded-lg border border-border hover:bg-muted disabled:opacity-30 transition-all"
            >←</button>
            {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => i).map((i) => (
              <button key={i} onClick={() => setPage(i)}
                className={cn("text-[10px] font-black px-2.5 py-1 rounded-lg border transition-all",
                  page === i ? "bg-indigo-600 text-white border-indigo-600" : "border-border hover:bg-muted"
                )}
              >{i + 1}</button>
            ))}
            <button
              disabled={page === totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
              className="text-[10px] font-black px-2.5 py-1 rounded-lg border border-border hover:bg-muted disabled:opacity-30 transition-all"
            >→</button>
          </div>
        </div>
      )}
    </motion.div>
  );
}
