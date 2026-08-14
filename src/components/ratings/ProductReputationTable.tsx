"use client";

import React from "react";

import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Star, TrendingUp, TrendingDown, AlertTriangle, ChevronDown, ChevronUp,
  Activity, RotateCcw, Zap, Search, SlidersHorizontal
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { RRProduct } from "@/lib/ratingsReviewsData";
import { channelLabel } from "@/lib/barmRatingReviewData";
import {
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Cell, Tooltip,
  PieChart, Pie,
} from "recharts";

const TOOLTIP_STYLE = {
  backgroundColor: "var(--card)",
  borderRadius: "10px",
  border: "1px solid var(--border)",
  fontSize: "11px",
  fontWeight: "700" as const,
  padding: "8px 12px",
};

function HealthRingSmall({ score }: { score: number }) {
  const size = 28, r = 10;
  const circ = 2 * Math.PI * r;
  const stroke = score >= 80 ? "#10B981" : score >= 60 ? "#F59E0B" : "#EF4444";
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--border)" strokeWidth={3} fill="none" />
        <motion.circle
          cx={size / 2} cy={size / 2} r={r} stroke={stroke} strokeWidth={3} fill="none"
          strokeLinecap="round"
          strokeDasharray={circ}
          initial={{ strokeDashoffset: circ }}
          animate={{ strokeDashoffset: circ - (score / 100) * circ }}
          transition={{ duration: 0.8 }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-[7px] font-black" style={{ color: stroke }}>{score}</span>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    Excellent: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800",
    Good: "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400 border-blue-200 dark:border-blue-800",
    "Needs Attention": "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400 border-amber-200 dark:border-amber-800",
    Watch: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400 border-amber-200 dark:border-amber-800",
    Critical: "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400 border-red-200 dark:border-red-800",
  };
  return (
    <span className={cn("text-[9px] font-black px-2 py-0.5 rounded-full border whitespace-nowrap", map[status] || map.Watch)}>
      {status}
    </span>
  );
}

function PriorityBadge({ priority }: { priority: "Critical" | "High" | "Medium" | "Low" }) {
  const map = {
    Critical: "bg-red-500 text-white",
    High: "bg-orange-500 text-white",
    Medium: "bg-amber-500 text-white",
    Low: "bg-slate-400 text-white",
  };
  return <span className={cn("text-[8px] font-black px-1.5 py-0.5 rounded uppercase tracking-wider", map[priority])}>{priority}</span>;
}

function ExpandedRow({ product }: { product: RRProduct }) {
  const distColors = ["#10B981", "#34D399", "#F59E0B", "#F97316", "#EF4444"];
  const distData = (product.ratingDistribution || []).map((d, i) => ({ ...d, name: `${d.star}★`, fill: distColors[i] }));
  const returnData = (product.returnReasons || []).slice(0, 5).map((r) => ({ name: r.reason, value: r.pct }));

  return (
    <motion.tr
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <td colSpan={12} className="px-4 pb-4 pt-0">
        <div className="bg-muted/30 rounded-2xl p-4 border border-border grid grid-cols-1 md:grid-cols-3 gap-4">

          {/* Rating Distribution */}
          <div>
            <p className="text-[10px] font-black uppercase tracking-wider text-muted-foreground mb-2">Rating Distribution</p>
            <ResponsiveContainer width="100%" height={100}>
              <BarChart data={distData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                  {distData.map((d, i) => <Cell key={i} fill={distColors[i]} />)}
                </Bar>
                <XAxis dataKey="name" tick={{ fontSize: 9, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: any) => [v, "Reviews"]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Return Reasons */}
          <div>
            <p className="text-[10px] font-black uppercase tracking-wider text-muted-foreground mb-2">Return Reasons</p>
            <div className="space-y-1.5">
              {returnData.map((r, i) => (
                <div key={r.name} className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground font-semibold w-28 truncate">{r.name}</span>
                  <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                    <div className="h-full rounded-full bg-red-500" style={{ width: `${r.value}%` }} />
                  </div>
                  <span className="text-[10px] font-black text-muted-foreground">{r.value}%</span>
                </div>
              ))}
            </div>
          </div>

          {/* AI Recommendations */}
          <div>
            <p className="text-[10px] font-black uppercase tracking-wider text-muted-foreground mb-2">AI Recommendations</p>
            <div className="space-y-1.5">
              {(product.recommendations || []).slice(0, 4).map((rec, i) => (
                <div key={i} className="flex items-start gap-1.5">
                  <Zap className="w-3 h-3 text-indigo-500 flex-shrink-0 mt-0.5" />
                  <p className="text-[11px] font-semibold text-foreground">{rec}</p>
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground">Review Summary:</span>
            </div>
            <p className="text-[10px] text-muted-foreground leading-relaxed mt-1">{(product.reviewSummary || "").slice(0, 120)}…</p>
          </div>
        </div>
      </td>
    </motion.tr>
  );
}

interface ProductReputationTableProps {
  products: RRProduct[];
  currency?: string;
  onProductClick?: (p: RRProduct) => void;
}

type SortKey = "avgRating" | "reviewCount" | "returnRate" | "healthScore" | "sales" | "negativePct";

export function ProductReputationTable({ products, currency = "INR", onProductClick }: ProductReputationTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("healthScore");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const PER_PAGE = 10;

  const cur = (v: number) => {
    const sym = currency === "INR" ? "₹" : "$";
    return sym + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(v || 0));
  };

  const sorted = useMemo(() => {
    let list = [...products];
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q));
    }
    list.sort((a, b) => {
      const av = (a as any)[sortKey] || 0;
      const bv = (b as any)[sortKey] || 0;
      return sortDir === "asc" ? av - bv : bv - av;
    });
    return list;
  }, [products, sortKey, sortDir, search]);

  const paged = sorted.slice(page * PER_PAGE, (page + 1) * PER_PAGE);
  const totalPages = Math.ceil(sorted.length / PER_PAGE);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setShortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  };
  function setShortDir(fn: (d: "asc" | "desc") => "asc" | "desc") {
    setSortDir((d) => fn(d));
  }

  const SortableHeader = ({ label, k }: { label: string; k: SortKey }) => (
    <th
      className="px-3 py-3 text-left text-[9px] font-black uppercase tracking-widest text-muted-foreground cursor-pointer hover:text-foreground transition-colors whitespace-nowrap"
      onClick={() => toggleSort(k)}
    >
      <div className="flex items-center gap-1">
        {label}
        {sortKey === k && (sortDir === "asc" ? <TrendingUp className="w-2.5 h-2.5" /> : <TrendingDown className="w-2.5 h-2.5" />)}
      </div>
    </th>
  );

  return (
    <div>
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <Activity className="w-4 h-4 text-indigo-500" />
        <h2 className="text-sm font-black text-foreground uppercase tracking-widest">Product Reputation</h2>
        <span className="text-[10px] bg-muted text-muted-foreground border border-border font-bold px-2 py-0.5 rounded-full">
          {sorted.length} SKUs
        </span>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search products…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              className="pl-8 pr-3 py-1.5 text-[11px] font-semibold bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-500 w-48"
            />
          </div>
          <button className="flex items-center gap-1 text-[10px] font-black text-muted-foreground px-2.5 py-1.5 border border-border rounded-lg hover:bg-muted transition-colors">
            <SlidersHorizontal className="w-3 h-3" /> Filter
          </button>
        </div>
      </div>

      <div className="glass gradient-border rounded-3xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[900px]">
            <thead className="bg-muted/50 border-b border-border">
              <tr>
                <th className="px-3 py-3 text-left text-[9px] font-black uppercase tracking-widest text-muted-foreground">Product</th>
                <th className="px-3 py-3 text-left text-[9px] font-black uppercase tracking-widest text-muted-foreground">Platform</th>
                <SortableHeader label="Rating" k="avgRating" />
                <th className="px-3 py-3 text-left text-[9px] font-black uppercase tracking-widest text-muted-foreground">Change</th>
                <SortableHeader label="Reviews" k="reviewCount" />
                <SortableHeader label="Neg %" k="negativePct" />
                <SortableHeader label="Return %" k="returnRate" />
                <SortableHeader label="Revenue" k="sales" />
                <th className="px-3 py-3 text-left text-[9px] font-black uppercase tracking-widest text-muted-foreground">Top Complaint</th>
                <SortableHeader label="Health" k="healthScore" />
                <th className="px-3 py-3 text-left text-[9px] font-black uppercase tracking-widest text-muted-foreground">Status</th>
                <th className="px-3 py-3 text-left text-[9px] font-black uppercase tracking-widest text-muted-foreground"></th>
              </tr>
            </thead>
            <tbody>
                {paged.map((p, i) => {
                  const ratingDelta = p.avgRating - (p.priorRating || p.avgRating);
                  const priority: "Critical" | "High" | "Medium" | "Low" =
                    p.healthScore < 40 ? "Critical" : p.healthScore < 60 ? "High" : p.healthScore < 75 ? "Medium" : "Low";
                  const rowBg =
                    p.avgRating < 3 ? "bg-red-50/30 dark:bg-red-950/10"
                    : p.avgRating < 4 ? "bg-amber-50/20 dark:bg-amber-950/10"
                    : "";

                  return (
                    <React.Fragment key={`${p.id}-${i}`}>
                      <motion.tr
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: i * 0.03 }}
                        className={cn(
                          "border-b border-border/50 hover:bg-muted/30 transition-colors cursor-pointer",
                          rowBg
                        )}
                        onClick={() => setExpandedId(expandedId === p.id ? null : p.id)}
                      >
                        {/* Product */}
                        <td className="px-3 py-3">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500/20 to-purple-500/20 flex items-center justify-center flex-shrink-0">
                              <Star className="w-3.5 h-3.5 text-indigo-500" />
                            </div>
                            <div className="min-w-0">
                              <p className="font-black text-[11px] text-foreground truncate max-w-[180px]" title={p.name}>{p.name}</p>
                              <p className="text-[9px] font-mono text-muted-foreground">{p.sku}</p>
                            </div>
                          </div>
                        </td>

                        {/* Platform */}
                        <td className="px-3 py-3">
                          <span className="text-[9px] font-black uppercase px-2 py-0.5 rounded-full bg-muted border border-border text-muted-foreground">
                            {channelLabel(p.platform)}
                          </span>
                        </td>

                        {/* Rating */}
                        <td className="px-3 py-3">
                          {p.hasRating !== false && p.avgRating > 0 ? (
                            <div className="flex items-center gap-1">
                              <Star className={cn("w-3.5 h-3.5 fill-current",
                                p.avgRating >= 4.2 ? "text-emerald-500" : p.avgRating >= 3.5 ? "text-amber-500" : "text-red-500"
                              )} />
                              <span className={cn("font-black",
                                p.avgRating >= 4.2 ? "text-emerald-600 dark:text-emerald-400" : p.avgRating >= 3.5 ? "text-amber-600 dark:text-amber-400" : "text-red-600 dark:text-red-400"
                              )}>{p.avgRating.toFixed(1)}</span>
                            </div>
                          ) : <span className="text-muted-foreground">—</span>}
                        </td>

                        {/* Rating Change */}
                        <td className="px-3 py-3">
                          {p.priorRating > 0 && (
                            <span className={cn("flex items-center gap-0.5 font-black text-[10px]",
                              ratingDelta > 0.05 ? "text-emerald-500" : ratingDelta < -0.05 ? "text-red-500" : "text-muted-foreground"
                            )}>
                              {ratingDelta > 0.05 ? <TrendingUp className="w-3 h-3" /> : ratingDelta < -0.05 ? <TrendingDown className="w-3 h-3" /> : null}
                              {ratingDelta > 0 ? "+" : ""}{ratingDelta.toFixed(2)}★
                            </span>
                          )}
                        </td>

                        {/* Reviews */}
                        <td className="px-3 py-3 font-bold tabular-nums">
                          {p.reviewCount.toLocaleString("en-IN")}
                        </td>

                        {/* Negative % */}
                        <td className="px-3 py-3">
                          <span className={cn("font-black", p.negativePct > 30 ? "text-red-500" : p.negativePct > 15 ? "text-amber-500" : "text-muted-foreground")}>
                            {p.negativePct.toFixed(1)}%
                          </span>
                        </td>

                        {/* Return % */}
                        <td className="px-3 py-3">
                          <span className={cn("font-black", p.returnRate > 18 ? "text-red-500" : p.returnRate > 10 ? "text-amber-500" : "text-emerald-500")}>
                            {p.returnRate.toFixed(1)}%
                          </span>
                        </td>

                        {/* Revenue */}
                        <td className="px-3 py-3 font-bold tabular-nums">{cur(p.sales)}</td>

                        {/* Top Complaint */}
                        <td className="px-3 py-3">
                          {p.negativeKeywords[0] && (
                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-500/10 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800 truncate max-w-[100px] block">
                              {p.negativeKeywords[0].text}
                            </span>
                          )}
                        </td>

                        {/* Health */}
                        <td className="px-3 py-3">
                          <HealthRingSmall score={p.healthScore} />
                        </td>

                        {/* Status */}
                        <td className="px-3 py-3">
                          <StatusPill status={p.healthStatus} />
                        </td>

                        {/* Expand */}
                        <td className="px-3 py-3 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <PriorityBadge priority={priority} />
                            <button
                              onClick={(e) => { e.stopPropagation(); onProductClick?.(p); }}
                              className="text-[9px] font-black text-indigo-500 hover:text-indigo-600 transition-colors px-1.5 py-0.5 rounded border border-indigo-200 dark:border-indigo-800 hover:bg-indigo-50 dark:hover:bg-indigo-950/30"
                            >
                              Details
                            </button>
                            {expandedId === p.id
                              ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />
                              : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
                            }
                          </div>
                        </td>
                      </motion.tr>

                      {/* Expanded row */}
                      <AnimatePresence>
                        {expandedId === p.id && <ExpandedRow key={`${p.id}-expanded`} product={p} />}
                      </AnimatePresence>
                    </React.Fragment>
                  );
                })}

              {paged.length === 0 && (
                <tr>
                  <td colSpan={12} className="px-4 py-12 text-center text-muted-foreground font-semibold text-sm">
                    {search ? `No products match "${search}"` : "No rated products found."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-border">
            <p className="text-[10px] text-muted-foreground font-semibold">
              Showing {page * PER_PAGE + 1}–{Math.min((page + 1) * PER_PAGE, sorted.length)} of {sorted.length}
            </p>
            <div className="flex items-center gap-1">
              <button
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
                className="text-[10px] font-black px-2.5 py-1 rounded-lg border border-border hover:bg-muted disabled:opacity-30 transition-all"
              >←</button>
              {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => i).map((i) => (
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
      </div>
    </div>
  );
}
