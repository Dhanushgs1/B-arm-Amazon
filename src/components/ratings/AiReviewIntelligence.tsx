"use client";

import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Brain, AlertTriangle, ThumbsUp, MessageSquare, TrendingUp, TrendingDown, Zap, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RatingsReviewsDataset } from "@/lib/ratingsReviewsData";

const EMOTION_DATA = [
  { emoji: "😊", label: "Happy", pct: 38, color: "#10B981" },
  { emoji: "😐", label: "Neutral", pct: 22, color: "#94A3B8" },
  { emoji: "😡", label: "Angry", pct: 18, color: "#EF4444" },
  { emoji: "😢", label: "Disappointed", pct: 12, color: "#8B5CF6" },
  { emoji: "😍", label: "Love", pct: 7, color: "#F59E0B" },
  { emoji: "🤔", label: "Confused", pct: 3, color: "#06B6D4" },
];

const SEVERITY_COLORS: Record<string, string> = {
  Critical: "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400 border-red-200 dark:border-red-800",
  High: "bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-400 border-orange-200 dark:border-orange-800",
  Medium: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400 border-amber-200 dark:border-amber-800",
  Low: "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400 border-blue-200 dark:border-blue-800",
};

function ComplaintCard({ complaint, idx }: {
  complaint: { theme: string; pct: number; products: number; revenue: number; severity: string; trend: "up" | "down" | "stable"; suggestion: string };
  idx: number;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <motion.div
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: idx * 0.06 }}
      className="glass gradient-border rounded-2xl overflow-hidden"
    >
      <div
        className="flex items-center gap-3 p-4 cursor-pointer hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex-shrink-0 w-8 h-8 rounded-xl bg-red-500/10 flex items-center justify-center">
          <AlertTriangle className="w-4 h-4 text-red-500" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="font-black text-[13px] text-foreground truncate">{complaint.theme}</p>
            <span className={cn("text-[9px] font-black px-1.5 py-0.5 rounded-full border flex-shrink-0", SEVERITY_COLORS[complaint.severity])}>
              {complaint.severity}
            </span>
          </div>
          <div className="flex items-center gap-3 mt-1 text-[11px] text-muted-foreground font-semibold">
            <span className="font-black text-red-500">{complaint.pct}%</span>
            <span>·</span>
            <span>{complaint.products} products</span>
            <span>·</span>
            <span>₹{(complaint.revenue / 1000).toFixed(0)}K revenue impact</span>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {complaint.trend === "up" ? (
            <TrendingUp className="w-4 h-4 text-red-500" />
          ) : complaint.trend === "down" ? (
            <TrendingDown className="w-4 h-4 text-emerald-500" />
          ) : (
            <div className="w-4 h-0.5 bg-muted-foreground rounded" />
          )}
          {expanded ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
        </div>
      </div>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
          >
            <div className="px-4 pb-4 border-t border-border">
              <div className="pt-3 flex items-start gap-2">
                <div className="w-6 h-6 rounded-lg bg-indigo-500/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Zap className="w-3.5 h-3.5 text-indigo-500" />
                </div>
                <div>
                  <p className="text-[10px] font-black text-indigo-500 uppercase tracking-wider mb-1">AI Suggestion</p>
                  <p className="text-[12px] text-muted-foreground font-semibold">{complaint.suggestion}</p>
                </div>
              </div>
              {/* Bar showing pct */}
              <div className="mt-3">
                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${complaint.pct}%` }}
                    transition={{ duration: 0.6 }}
                    className="h-full bg-red-500 rounded-full"
                  />
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function KeywordCloud({ keywords, type }: { keywords: { text: string; count: number }[]; type: "positive" | "negative" }) {
  const max = Math.max(...keywords.map((k) => k.count), 1);
  const color = type === "positive" ? "#10B981" : "#EF4444";
  const bg = type === "positive" ? "rgba(16,185,129,0.1)" : "rgba(239,68,68,0.1)";
  return (
    <div className="flex flex-wrap gap-2 justify-center p-4">
      {keywords.map((kw, i) => {
        const size = 10 + Math.round((kw.count / max) * 8);
        const opacity = 0.5 + (kw.count / max) * 0.5;
        return (
          <motion.span
            key={kw.text}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity, scale: 1 }}
            transition={{ delay: i * 0.04 }}
            whileHover={{ scale: 1.1 }}
            className="cursor-default rounded-full px-3 py-1 font-black border transition-all"
            style={{ fontSize: `${size}px`, color, background: bg, borderColor: `${color}30` }}
          >
            {kw.text} <span className="opacity-60 font-semibold text-[9px]">×{kw.count}</span>
          </motion.span>
        );
      })}
    </div>
  );
}

export function AiReviewIntelligence({ dataset }: { dataset: RatingsReviewsDataset }) {
  const [kwTab, setKwTab] = useState<"positive" | "negative">("negative");
  const [showAllComplaints, setShowAllComplaints] = useState(false);

  const { products, executiveSummary } = dataset;

  // Build complaint themes from real data
  const complaintThemes = useMemo(() => {
    const themeMap = new Map<string, { count: number; revenue: number; products: number }>();
    products.forEach((p) => {
      p.negativeKeywords.forEach((kw) => {
        const existing = themeMap.get(kw.text) || { count: 0, revenue: 0, products: 0 };
        themeMap.set(kw.text, {
          count: existing.count + kw.count,
          revenue: existing.revenue + (p.estimatedRevenueLost || 0) * (kw.count / Math.max(p.reviewCount, 1)),
          products: existing.products + 1,
        });
      });
    });
    const total = Array.from(themeMap.values()).reduce((a, b) => a + b.count, 0) || 1;
    return Array.from(themeMap.entries())
      .map(([theme, { count, revenue, products: prods }], i) => ({
        theme,
        pct: Math.round((count / total) * 100),
        products: prods,
        revenue: Math.round(revenue),
        severity: count / total > 0.2 ? "Critical" : count / total > 0.12 ? "High" : count / total > 0.06 ? "Medium" : "Low",
        trend: (i % 3 === 0 ? "up" : i % 3 === 1 ? "down" : "stable") as "up" | "down" | "stable",
        suggestion: {
          "Poor Packaging": "Upgrade to double-wall corrugated boxes. Consider branded tape and void fill to reduce transit damage.",
          "Late Delivery": "Switch critical SKUs to FBA. Review SLA agreements with 3PL partners for FBM orders.",
          "Bad Quality": "Conduct QC audit on manufacturing batch. Add pre-shipment inspection for high-return SKUs.",
          "Size Issue": "Add detailed measurements to listing images. Update size chart with body measurements vs. product dimensions.",
          "Damaged on Arrival": "Implement fragile item labeling. Add protective inner packaging for delicate SKUs.",
          "Not as Described": "Audit listing copy against actual product specs. Update A+ content with real photos.",
          "Difficult to Use": "Create instructional video for product page. Improve unboxing and quickstart guide.",
          "Overpriced": "Run A/B test on price points. Consider bundle deals to improve perceived value.",
        }[theme] || "Review customer feedback and take corrective action on this complaint theme.",
      }))
      .sort((a, b) => b.pct - a.pct);
  }, [products]);

  const positiveThemes = useMemo(() => {
    const themeMap = new Map<string, number>();
    products.forEach((p) => p.positiveKeywords.forEach((kw) => {
      themeMap.set(kw.text, (themeMap.get(kw.text) || 0) + kw.count);
    }));
    return Array.from(themeMap.entries()).map(([theme, count]) => ({ theme, count })).sort((a, b) => b.count - a.count);
  }, [products]);

  const allKeywords = {
    positive: products.flatMap((p) => p.positiveKeywords).reduce((acc, kw) => {
      const ex = acc.find((k) => k.text === kw.text);
      if (ex) ex.count += kw.count; else acc.push({ ...kw });
      return acc;
    }, [] as { text: string; count: number }[]).sort((a, b) => b.count - a.count).slice(0, 15),
    negative: products.flatMap((p) => p.negativeKeywords).reduce((acc, kw) => {
      const ex = acc.find((k) => k.text === kw.text);
      if (ex) ex.count += kw.count; else acc.push({ ...kw });
      return acc;
    }, [] as { text: string; count: number }[]).sort((a, b) => b.count - a.count).slice(0, 15),
  };

  const visibleComplaints = showAllComplaints ? complaintThemes : complaintThemes.slice(0, 5);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Brain className="w-4 h-4 text-indigo-500" />
        <h2 className="text-sm font-black text-foreground uppercase tracking-widest">AI Review Intelligence</h2>
        <span className="text-[10px] bg-purple-500/10 text-purple-500 border border-purple-500/20 font-bold px-2 py-0.5 rounded-full ml-auto">
          AI-Powered
        </span>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">

        {/* Complaint Themes */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="w-3.5 h-3.5 text-red-500" />
            <h3 className="text-xs font-black text-foreground uppercase tracking-wider">Top Complaint Themes</h3>
          </div>
          <div className="space-y-2">
            {visibleComplaints.map((c, i) => (
              <ComplaintCard key={c.theme} complaint={c} idx={i} />
            ))}
          </div>
          {complaintThemes.length > 5 && (
            <button
              onClick={() => setShowAllComplaints((v) => !v)}
              className="mt-3 w-full text-[10px] font-black text-indigo-500 border border-indigo-200 dark:border-indigo-800 py-2 rounded-xl hover:bg-indigo-50 dark:hover:bg-indigo-950/30 transition-all"
            >
              {showAllComplaints ? "Show Less" : `+ ${complaintThemes.length - 5} More Complaints`}
            </button>
          )}
        </div>

        {/* Right column: Positive Themes + Emotions */}
        <div className="space-y-4">

          {/* Positive Themes */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <ThumbsUp className="w-3.5 h-3.5 text-emerald-500" />
              <h3 className="text-xs font-black text-foreground uppercase tracking-wider">What Customers Love</h3>
            </div>
            <div className="glass gradient-border rounded-2xl p-4">
              <div className="flex flex-wrap gap-2">
                {positiveThemes.slice(0, 10).map((theme, i) => (
                  <motion.div
                    key={theme.theme}
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: i * 0.05 }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-700 dark:text-emerald-400"
                  >
                    <ThumbsUp className="w-3 h-3" />
                    <span className="text-[11px] font-black">{theme.theme}</span>
                    <span className="text-[9px] font-bold opacity-60">×{theme.count}</span>
                  </motion.div>
                ))}
              </div>
            </div>
          </div>

          {/* Emotion Detection */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <MessageSquare className="w-3.5 h-3.5 text-purple-500" />
              <h3 className="text-xs font-black text-foreground uppercase tracking-wider">Emotion Detection</h3>
            </div>
            <div className="glass gradient-border rounded-2xl p-4">
              <div className="space-y-3">
                {EMOTION_DATA.map((em, i) => (
                  <motion.div
                    key={em.label}
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.07 }}
                    className="flex items-center gap-3"
                  >
                    <span className="text-xl flex-shrink-0">{em.emoji}</span>
                    <span className="text-[11px] font-black text-foreground w-24 flex-shrink-0">{em.label}</span>
                    <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${em.pct}%` }}
                        transition={{ duration: 0.7, delay: 0.3 + i * 0.08 }}
                        className="h-full rounded-full"
                        style={{ background: em.color }}
                      />
                    </div>
                    <span className="text-[11px] font-black text-muted-foreground w-8 text-right flex-shrink-0">{em.pct}%</span>
                  </motion.div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Keyword Cloud */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <MessageSquare className="w-3.5 h-3.5 text-indigo-500" />
          <h3 className="text-xs font-black text-foreground uppercase tracking-wider">Review Keyword Cloud</h3>
          <div className="flex bg-muted p-0.5 rounded-lg ml-auto">
            {(["positive", "negative"] as const).map((t) => (
              <button key={t} onClick={() => setKwTab(t)}
                className={cn("text-[9px] font-black px-2.5 py-1 rounded-md transition-all capitalize",
                  kwTab === t ? "bg-background shadow text-foreground" : "text-muted-foreground"
                )}
              >{t}</button>
            ))}
          </div>
        </div>
        <div className="glass gradient-border rounded-2xl min-h-[120px] flex items-center justify-center">
          <KeywordCloud keywords={allKeywords[kwTab]} type={kwTab} />
        </div>
      </div>
    </div>
  );
}
