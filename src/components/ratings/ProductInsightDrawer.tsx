"use client";

import { useState } from "react";
import { X, MessageSquareText, RotateCcw, Sparkles, ThumbsUp, ThumbsDown, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScoreRing } from "@/components/ScoreRing";
import { TrendChart } from "@/components/TrendChart";
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import type { RRProduct } from "@/lib/ratingsReviewsData";

const cur = (val: number, currency = "INR") => {
  const sym = currency === "INR" ? "₹" : "$";
  return sym + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val || 0));
};

const RETURN_COLORS = ["#EF4444", "#F97316", "#F59E0B", "#8B5CF6", "#3B82F6", "#94A3B8"];

const healthColor = (score: number) => (score >= 85 ? "#10B981" : score >= 70 ? "#3B82F6" : score >= 50 ? "#F59E0B" : "#EF4444");

export function ProductInsightDrawer({ product, currency, onClose }: { product: RRProduct; currency?: string; onClose: () => void }) {
  const [tab, setTab] = useState<"reviews" | "returns" | "recommendations">("reviews");

  const tabs = [
    { id: "reviews" as const, label: "AI Review Analysis", icon: MessageSquareText },
    { id: "returns" as const, label: "Return Reasons", icon: RotateCcw },
    { id: "recommendations" as const, label: "AI Recommendations", icon: Sparkles },
  ];

  const sentimentData = [
    { name: "Positive", value: product.positivePct, color: "#10B981" },
    { name: "Negative", value: product.negativePct, color: "#EF4444" },
    { name: "Neutral", value: product.neutralPct, color: "#94A3B8" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-sm transition-opacity duration-300">
      <div className="absolute inset-0" onClick={onClose} />
      <div className="relative w-full max-w-3xl h-full bg-background border-l border-border shadow-2xl flex flex-col z-10 animate-in slide-in-from-right duration-300">
        {/* Header */}
        <div className="p-6 border-b border-border flex items-center justify-between bg-card/30">
          <div className="min-w-0">
            <span className="text-xs text-muted-foreground font-mono">{product.category} · {product.platform.toUpperCase()} · {product.sku}</span>
            <h2 className="text-base font-bold tracking-tight truncate text-foreground pr-4" title={product.name}>{product.name}</h2>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full border border-border flex items-center justify-center hover:bg-muted text-muted-foreground transition-colors flex-shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* KPI strip */}
        <div className="px-6 py-4 border-b border-border grid grid-cols-4 gap-3 bg-card/10">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Rating</p>
            <p className="text-lg font-black flex items-center gap-1"><Star className="w-4 h-4 fill-amber-400 text-amber-400" /> {product.avgRating.toFixed(1)}</p>
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Reviews</p>
            <p className="text-lg font-black">{product.reviewCount.toLocaleString("en-IN")}</p>
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Return Rate</p>
            <p className={cn("text-lg font-black", product.returnRate > 18 ? "text-red-500" : "text-foreground")}>{product.returnRate.toFixed(1)}%</p>
          </div>
          <div className="flex items-center gap-2">
            <ScoreRing value={product.healthScore} label="AI Health Score" color={healthColor(product.healthScore)} />
          </div>
        </div>

        {/* Tabs */}
        <div className="px-6 border-b border-border flex gap-1 bg-card/10 overflow-x-auto whitespace-nowrap">
          {tabs.map((t) => {
            const Icon = t.icon;
            const isActive = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  "flex items-center gap-2 px-4 py-3 text-xs font-bold border-b-2 transition-all duration-200",
                  isActive ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className="w-3.5 h-3.5" /> {t.label}
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {tab === "reviews" && (
            <div className="space-y-6">
              <div className="glass rounded-xl border border-border p-5">
                <h3 className="font-bold text-sm mb-3">Overall Review Summary</h3>
                <p className="text-xs text-muted-foreground leading-relaxed">{product.reviewSummary}</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="glass rounded-xl border border-border p-5">
                  <h3 className="font-bold text-sm mb-3">Customer Sentiment</h3>
                  <ResponsiveContainer width="100%" height={180}>
                    <PieChart>
                      <Pie data={sentimentData} dataKey="value" nameKey="name" innerRadius={45} outerRadius={70} paddingAngle={2}>
                        {sentimentData.map((s, i) => <Cell key={i} fill={s.color} />)}
                      </Pie>
                      <Tooltip formatter={(v: any, n: any) => [`${v}%`, n]} />
                      <Legend iconSize={8} wrapperStyle={{ fontSize: 11, fontWeight: 700 }} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>

                <div className="glass rounded-xl border border-border p-5">
                  <h3 className="font-bold text-sm mb-3">Rating Trend</h3>
                  <TrendChart title="" data={product.ratingTrend} dataKey="rating" color="#6D5EF8" type="line" height={180} />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="glass rounded-xl border border-emerald-200 dark:border-emerald-900 p-5">
                  <h3 className="font-bold text-sm mb-3 flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400"><ThumbsUp className="w-4 h-4" /> Top Positive Keywords</h3>
                  <div className="flex flex-wrap gap-2">
                    {product.positiveKeywords.map((k) => (
                      <span key={k.text} className="px-2.5 py-1 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-900">
                        {k.text} · {k.count}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="glass rounded-xl border border-red-200 dark:border-red-900 p-5">
                  <h3 className="font-bold text-sm mb-3 flex items-center gap-1.5 text-red-600 dark:text-red-400"><ThumbsDown className="w-4 h-4" /> Top Negative Keywords</h3>
                  <div className="flex flex-wrap gap-2">
                    {product.negativeKeywords.map((k) => (
                      <span key={k.text} className="px-2.5 py-1 rounded-full text-[11px] font-bold bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-400 border border-red-200 dark:border-red-900">
                        {k.text} · {k.count}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {tab === "returns" && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="glass rounded-xl border border-border p-5">
                  <h3 className="font-bold text-sm mb-3">Return Reasons</h3>
                  <ResponsiveContainer width="100%" height={220}>
                    <PieChart>
                      <Pie data={product.returnReasons} dataKey="pct" nameKey="reason" innerRadius={40} outerRadius={75} paddingAngle={2}>
                        {product.returnReasons.map((_, i) => <Cell key={i} fill={RETURN_COLORS[i % RETURN_COLORS.length]} />)}
                      </Pie>
                      <Tooltip formatter={(v: any, n: any) => [`${v}%`, n]} />
                      <Legend iconSize={8} wrapperStyle={{ fontSize: 10, fontWeight: 700 }} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="glass rounded-xl border border-border p-5">
                  <h3 className="font-bold text-sm mb-3">Return Reasons — Breakdown</h3>
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={product.returnReasons} layout="vertical" margin={{ left: 10, right: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--border)" opacity={0.5} />
                      <XAxis type="number" tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} unit="%" />
                      <YAxis type="category" dataKey="reason" width={90} tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
                      <Tooltip formatter={(v: any) => [`${v}%`, "Share of Returns"]} />
                      <Bar dataKey="pct" radius={[0, 6, 6, 0]}>
                        {product.returnReasons.map((_, i) => <Cell key={i} fill={RETURN_COLORS[i % RETURN_COLORS.length]} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="glass rounded-xl border border-border p-5 grid grid-cols-2 gap-4">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Total Returns</p>
                  <p className="text-lg font-black">{product.totalReturns.toLocaleString("en-IN")}</p>
                </div>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Return Rate</p>
                  <p className="text-lg font-black">{product.returnRate.toFixed(1)}%</p>
                </div>
              </div>
            </div>
          )}

          {tab === "recommendations" && (
            <div className="space-y-6">
              <div className="glass rounded-xl border border-border p-5 flex items-center gap-5">
                <ScoreRing value={product.healthScore} label={product.healthStatus} color={healthColor(product.healthScore)} />
                <div className="text-xs text-muted-foreground leading-relaxed">
                  <p className="font-bold text-foreground text-sm mb-1">AI Product Health Score</p>
                  Based on rating ({product.avgRating.toFixed(1)}★), sentiment ({product.negativePct}% negative), return rate ({product.returnRate.toFixed(1)}%) and sales trend ({product.salesChangePct > 0 ? "+" : ""}{product.salesChangePct.toFixed(1)}%).
                  {product.estimatedRevenueLost > 0 && ` Estimated revenue impact: ${cur(product.estimatedRevenueLost, currency)}.`}
                </div>
              </div>

              <div className="glass rounded-xl border border-border p-5">
                <h3 className="font-bold text-sm mb-3 flex items-center gap-1.5"><Sparkles className="w-4 h-4 text-indigo-500" /> AI Recommendation Engine</h3>
                <div className="space-y-2">
                  {product.recommendations.map((r, i) => (
                    <div key={r} className="flex items-center gap-3 p-3 rounded-xl border border-indigo-200 dark:border-indigo-900 bg-indigo-50/50 dark:bg-indigo-950/20">
                      <span className="w-6 h-6 rounded-full bg-indigo-500 text-white text-[11px] font-black flex items-center justify-center flex-shrink-0">{i + 1}</span>
                      <span className="text-xs font-bold text-foreground">{r}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
