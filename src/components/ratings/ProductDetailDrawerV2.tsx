"use client";

import { motion, AnimatePresence } from "framer-motion";
import { X, Star, TrendingUp, TrendingDown, RotateCcw, Zap, ChevronRight, Package, Activity } from "lucide-react";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, Cell, PieChart, Pie
} from "recharts";
import { cn } from "@/lib/utils";
import type { RRProduct } from "@/lib/ratingsReviewsData";
import { channelLabel } from "@/lib/barmRatingReviewData";

const TOOLTIP_STYLE = {
  backgroundColor: "var(--card)",
  borderRadius: "10px",
  border: "1px solid var(--border)",
  fontSize: "11px",
  fontWeight: "700" as const,
  padding: "8px 12px",
};

const DIST_COLORS = ["#10B981", "#34D399", "#F59E0B", "#F97316", "#EF4444"];

interface ProductDetailDrawerV2Props {
  product: RRProduct | null;
  currency?: string;
  onClose: () => void;
}

export function ProductDetailDrawerV2({ product, currency = "INR", onClose }: ProductDetailDrawerV2Props) {
  if (!product) return null;

  const cur = (v: number) => {
    const sym = currency === "INR" ? "₹" : "$";
    return sym + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(v || 0));
  };

  const ratingDelta = product.avgRating - (product.priorRating || product.avgRating);
  const trendData = product.ratingTrend.map((t) => ({ date: t.date, rating: t.rating }));
  const distData = (product.ratingDistribution || []).map((d, i) => ({ ...d, name: `${d.star}★`, fill: DIST_COLORS[i] }));
  const returnData = (product.returnReasons || []).slice(0, 6);
  const posKw = (product.positiveKeywords || []).slice(0, 8);
  const negKw = (product.negativeKeywords || []).slice(0, 8);

  const healthColor = product.healthScore >= 80 ? "#10B981" : product.healthScore >= 60 ? "#F59E0B" : "#EF4444";

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex">
        {/* Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="flex-1 bg-black/50 backdrop-blur-sm"
          onClick={onClose}
        />

        {/* Drawer */}
        <motion.div
          initial={{ x: "100%" }}
          animate={{ x: 0 }}
          exit={{ x: "100%" }}
          transition={{ type: "spring", damping: 28, stiffness: 300 }}
          className="w-full max-w-[680px] bg-background border-l border-border overflow-y-auto custom-scrollbar"
        >
          {/* Header */}
          <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border px-6 py-4 flex items-start justify-between gap-4">
            <div className="flex items-start gap-3 min-w-0">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500/20 to-purple-500/20 flex items-center justify-center flex-shrink-0">
                <Package className="w-5 h-5 text-indigo-500" />
              </div>
              <div className="min-w-0">
                <h2 className="font-black text-base text-foreground leading-tight truncate">{product.name}</h2>
                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                  <span className="text-[10px] font-mono text-muted-foreground">{product.sku}</span>
                  <span className="text-[9px] font-black uppercase px-1.5 py-0.5 rounded bg-muted border border-border text-muted-foreground">
                    {channelLabel(product.platform)}
                  </span>
                  <span className="text-[9px] font-bold text-muted-foreground">{product.brand}</span>
                  <span className="text-[9px] font-bold text-muted-foreground">{product.category}</span>
                </div>
              </div>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-muted transition-colors flex-shrink-0">
              <X className="w-4 h-4 text-muted-foreground" />
            </button>
          </div>

          <div className="p-6 space-y-6">

            {/* KPI Row */}
            <div className="grid grid-cols-4 gap-3">
              {[
                { label: "Avg Rating", value: product.hasRating !== false ? `${product.avgRating.toFixed(1)}★` : "—", color: product.avgRating >= 4 ? "#10B981" : product.avgRating >= 3.5 ? "#F59E0B" : "#EF4444" },
                { label: "Reviews", value: product.reviewCount.toLocaleString("en-IN"), color: "#6366F1" },
                { label: "Return Rate", value: `${product.returnRate.toFixed(1)}%`, color: product.returnRate > 15 ? "#EF4444" : "#F59E0B" },
                { label: "Health", value: `${product.healthScore}/100`, color: healthColor },
              ].map(({ label, value, color }) => (
                <div key={label} className="glass rounded-2xl p-3 text-center border border-border">
                  <p className="text-[9px] font-black uppercase tracking-wider text-muted-foreground mb-1">{label}</p>
                  <p className="text-lg font-black" style={{ color }}>{value}</p>
                </div>
              ))}
            </div>

            {/* Rating History */}
            {trendData.length > 1 && (
              <div className="glass rounded-2xl p-4 border border-border">
                <h3 className="text-[11px] font-black uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
                  <TrendingUp className="w-3.5 h-3.5 text-indigo-500" /> Rating History
                </h3>
                <ResponsiveContainer width="100%" height={120}>
                  <LineChart data={trendData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                    <XAxis dataKey="date" tick={{ fontSize: 9, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} interval={1} />
                    <YAxis domain={[Math.min(...trendData.map((d) => d.rating)) - 0.2, 5]} tick={{ fontSize: 9, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: any) => [`${(+v).toFixed(2)}★`, "Rating"]} />
                    <Line dataKey="rating" stroke="#6366F1" strokeWidth={2.5} dot={false} strokeLinecap="round" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Review Breakdown + Return Reasons */}
            <div className="grid grid-cols-2 gap-3">
              {/* Rating Distribution */}
              <div className="glass rounded-2xl p-4 border border-border">
                <h3 className="text-[11px] font-black uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                  <Star className="w-3 h-3 text-amber-500" /> Rating Distribution
                </h3>
                <ResponsiveContainer width="100%" height={100}>
                  <BarChart data={distData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                    <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                      {distData.map((d, i) => <Cell key={i} fill={DIST_COLORS[i]} />)}
                    </Bar>
                    <XAxis dataKey="name" tick={{ fontSize: 9, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: any) => [v, "Reviews"]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Return Reasons */}
              <div className="glass rounded-2xl p-4 border border-border">
                <h3 className="text-[11px] font-black uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                  <RotateCcw className="w-3 h-3 text-red-500" /> Return Reasons
                </h3>
                <div className="space-y-1.5">
                  {returnData.map((r) => (
                    <div key={r.reason} className="flex items-center gap-2">
                      <span className="text-[9px] text-muted-foreground font-semibold w-24 truncate">{r.reason}</span>
                      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                        <div className="h-full bg-red-500 rounded-full" style={{ width: `${r.pct}%` }} />
                      </div>
                      <span className="text-[9px] font-black text-muted-foreground">{r.pct}%</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Sentiment */}
            <div className="glass rounded-2xl p-4 border border-border">
              <h3 className="text-[11px] font-black uppercase tracking-wider text-muted-foreground mb-3">Review Sentiment</h3>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[10px] font-semibold text-muted-foreground w-16">Positive</span>
                <div className="flex-1 h-3 bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${product.positivePct}%` }} />
                </div>
                <span className="text-[10px] font-black text-emerald-600 dark:text-emerald-400 w-10 text-right">{product.positivePct}%</span>
              </div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[10px] font-semibold text-muted-foreground w-16">Neutral</span>
                <div className="flex-1 h-3 bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-slate-400 rounded-full" style={{ width: `${product.neutralPct}%` }} />
                </div>
                <span className="text-[10px] font-black text-slate-500 w-10 text-right">{product.neutralPct}%</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold text-muted-foreground w-16">Negative</span>
                <div className="flex-1 h-3 bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-red-500 rounded-full" style={{ width: `${product.negativePct}%` }} />
                </div>
                <span className="text-[10px] font-black text-red-600 dark:text-red-400 w-10 text-right">{product.negativePct}%</span>
              </div>
            </div>

            {/* Keywords */}
            <div className="grid grid-cols-2 gap-3">
              <div className="glass rounded-2xl p-4 border border-border">
                <h3 className="text-[10px] font-black uppercase tracking-wider text-emerald-600 dark:text-emerald-400 mb-2">Customers Love</h3>
                <div className="flex flex-wrap gap-1.5">
                  {posKw.map((kw) => (
                    <span key={kw.text} className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
                      {kw.text}
                    </span>
                  ))}
                </div>
              </div>
              <div className="glass rounded-2xl p-4 border border-border">
                <h3 className="text-[10px] font-black uppercase tracking-wider text-red-600 dark:text-red-400 mb-2">Complaints</h3>
                <div className="flex flex-wrap gap-1.5">
                  {negKw.map((kw) => (
                    <span key={kw.text} className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-red-500/10 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800">
                      {kw.text}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* Review Summary */}
            <div className="glass rounded-2xl p-4 border border-border">
              <h3 className="text-[11px] font-black uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                <Activity className="w-3.5 h-3.5 text-indigo-500" /> AI Review Summary
              </h3>
              <p className="text-[12px] text-muted-foreground leading-relaxed font-semibold">{product.reviewSummary}</p>
            </div>

            {/* AI Recommendations */}
            <div>
              <h3 className="text-[11px] font-black uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5 text-indigo-500" /> AI Recommendations
              </h3>
              <div className="space-y-2">
                {(product.recommendations || []).map((rec, i) => (
                  <motion.div
                    key={rec}
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.08 }}
                    className="flex items-center gap-3 p-3 rounded-xl bg-indigo-500/5 border border-indigo-200 dark:border-indigo-800"
                  >
                    <div className="w-5 h-5 rounded-full bg-indigo-500/20 flex items-center justify-center flex-shrink-0">
                      <span className="text-[9px] font-black text-indigo-600 dark:text-indigo-400">{i + 1}</span>
                    </div>
                    <p className="text-[12px] font-bold text-foreground flex-1">{rec}</p>
                    <ChevronRight className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />
                  </motion.div>
                ))}
              </div>
            </div>

            {/* Sales Impact */}
            {product.estimatedRevenueLost > 0 && (
              <div className="rounded-2xl border border-red-200 dark:border-red-800 bg-red-50/40 dark:bg-red-950/20 p-4">
                <div className="flex items-center gap-3">
                  <TrendingDown className="w-5 h-5 text-red-500 flex-shrink-0" />
                  <div>
                    <p className="font-black text-red-700 dark:text-red-400">Estimated Revenue Impact</p>
                    <p className="text-2xl font-black text-red-600 dark:text-red-400 mt-0.5">-{cur(product.estimatedRevenueLost)}</p>
                    <p className="text-[11px] text-muted-foreground font-semibold mt-0.5">
                      Due to {Math.abs(product.salesChangePct).toFixed(0)}% sales decline from rating drop
                    </p>
                  </div>
                </div>
              </div>
            )}

          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
