"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RatingsReviewsDataset } from "@/lib/ratingsReviewsData";

interface FeedItem {
  id: string;
  type: "warning" | "success" | "info" | "critical";
  icon: string;
  title: string;
  detail: string;
  time: string;
}

const TYPE_STYLES = {
  critical: {
    border: "border-red-200 dark:border-red-900",
    bg: "bg-red-50/40 dark:bg-red-950/10",
    dot: "bg-red-500",
    time: "text-red-500",
  },
  warning: {
    border: "border-amber-200 dark:border-amber-900",
    bg: "bg-amber-50/40 dark:bg-amber-950/10",
    dot: "bg-amber-500",
    time: "text-amber-500",
  },
  info: {
    border: "border-blue-200 dark:border-blue-900",
    bg: "bg-blue-50/40 dark:bg-blue-950/10",
    dot: "bg-blue-500",
    time: "text-blue-500",
  },
  success: {
    border: "border-emerald-200 dark:border-emerald-900",
    bg: "bg-emerald-50/40 dark:bg-emerald-950/10",
    dot: "bg-emerald-500",
    time: "text-emerald-500",
  },
};

function buildFeed(dataset: RatingsReviewsDataset): FeedItem[] {
  const { products } = dataset;
  const items: FeedItem[] = [];

  const critical = products.filter((p) => p.healthScore < 40);
  const declining = products.filter((p) => p.priorRating > p.avgRating + 0.15).sort((a, b) => (a.avgRating - a.priorRating) - (b.avgRating - b.priorRating));
  const improving = products.filter((p) => p.avgRating > p.priorRating + 0.1).sort((a, b) => (b.avgRating - b.priorRating) - (a.avgRating - a.priorRating));
  const highReturn = products.filter((p) => p.returnRate > 18);
  const negativeSpike = products.filter((p) => p.negativePct > 30);
  const topImpact = products.sort((a, b) => b.estimatedRevenueLost - a.estimatedRevenueLost)[0];

  if (critical.length > 0) {
    items.push({
      id: "crit1",
      type: "critical",
      icon: "🔴",
      title: `${critical.length} products in Critical health score`,
      detail: `Risk of search demotion and buy-box suppression — immediate action required`,
      time: "Just now",
    });
  }

  if (declining.length > 0) {
    const d = declining[0];
    items.push({
      id: "dec1",
      type: "warning",
      icon: "⚠",
      title: `Rating dropped ${(d.priorRating - d.avgRating).toFixed(1)}★ on "${d.name.slice(0, 30)}"`,
      detail: `Now at ${d.avgRating.toFixed(1)}★ — revenue may decline ${Math.abs(d.salesChangePct).toFixed(0)}% if trend continues`,
      time: "1h ago",
    });
  }

  if (highReturn.length > 0) {
    items.push({
      id: "ret1",
      type: "warning",
      icon: "📦",
      title: `Returns increased on ${highReturn.length} SKUs`,
      detail: `Top: ${highReturn[0]?.name.slice(0, 30)} at ${highReturn[0]?.returnRate.toFixed(1)}% return rate`,
      time: "2h ago",
    });
  }

  if (improving.length > 0) {
    const p = improving[0];
    items.push({
      id: "imp1",
      type: "success",
      icon: "⭐",
      title: `"${p.name.slice(0, 30)}" recovered +${(p.avgRating - p.priorRating).toFixed(1)}★`,
      detail: `Customers love ${p.positiveKeywords[0]?.text || "quality"} — positive reviews increased`,
      time: "3h ago",
    });
  }

  if (negativeSpike.length > 0) {
    items.push({
      id: "neg1",
      type: "warning",
      icon: "📉",
      title: `Negative reviews increased — ${negativeSpike.length} products affected`,
      detail: `${negativeSpike[0]?.negativeKeywords[0]?.text || "Packaging issues"} is the top complaint`,
      time: "4h ago",
    });
  }

  if (topImpact) {
    items.push({
      id: "imp2",
      type: "info",
      icon: "💸",
      title: `₹${(topImpact.estimatedRevenueLost / 1000).toFixed(0)}K revenue impact detected`,
      detail: `"${topImpact.name.slice(0, 35)}" is the highest-impact product — consider immediate intervention`,
      time: "5h ago",
    });
  }

  items.push({
    id: "tip1",
    type: "info",
    icon: "💡",
    title: "Competitor rating improved in your category",
    detail: "Monitor closely — consider accelerating review generation to maintain search ranking",
    time: "Yesterday",
  });

  items.push({
    id: "tip2",
    type: "success",
    icon: "✅",
    title: "Packaging update showing positive results",
    detail: "Return rate down 2.3% after switching to corrugated boxes for sensory product line",
    time: "2d ago",
  });

  return items;
}

export function AiInsightsFeed({ dataset }: { dataset: RatingsReviewsDataset }) {
  const feedItems = buildFeed(dataset);
  const [visible, setVisible] = useState<string[]>([]);

  useEffect(() => {
    feedItems.forEach((item, i) => {
      setTimeout(() => setVisible((prev) => [...prev, item.id]), i * 200);
    });
  }, []);

  return (
    <div>
      <div className="flex items-center gap-2 mb-5">
        <MessageSquare className="w-4 h-4 text-indigo-500" />
        <h2 className="text-sm font-black text-foreground uppercase tracking-widest">AI Insights Feed</h2>
        <span className="ml-2 text-[10px] font-black bg-indigo-500/10 text-indigo-500 border border-indigo-500/20 px-2 py-0.5 rounded-full">
          Live
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground font-semibold">
          {feedItems.length} insights
        </span>
      </div>

      <div className="glass gradient-border rounded-3xl p-5">
        <div className="relative">
          {/* Timeline line */}
          <div className="absolute left-[18px] top-0 bottom-0 w-px bg-gradient-to-b from-indigo-500/40 via-border to-transparent" />

          <div className="space-y-3">
            <AnimatePresence>
              {feedItems.map((item, i) => {
                const style = TYPE_STYLES[item.type];
                const isVisible = visible.includes(item.id);
                return (
                  <motion.div
                    key={item.id}
                    initial={{ opacity: 0, x: 30 }}
                    animate={isVisible ? { opacity: 1, x: 0 } : { opacity: 0, x: 30 }}
                    transition={{ type: "spring", damping: 25, stiffness: 200 }}
                    className="flex items-start gap-4 pl-2"
                  >
                    {/* Dot + icon */}
                    <div className="relative flex-shrink-0 w-8 h-8 flex items-center justify-center">
                      <div className={cn("w-3 h-3 rounded-full ring-4 ring-background", style.dot)} />
                    </div>

                    {/* Card */}
                    <div className={cn("flex-1 rounded-2xl border p-3.5 transition-all hover:shadow-sm", style.border, style.bg)}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-start gap-2 flex-1 min-w-0">
                          <span className="text-base flex-shrink-0">{item.icon}</span>
                          <div className="min-w-0">
                            <p className="text-[12px] font-black text-foreground">{item.title}</p>
                            <p className="text-[11px] font-semibold text-muted-foreground mt-0.5 leading-relaxed">{item.detail}</p>
                          </div>
                        </div>
                        <span className={cn("text-[9px] font-black flex-shrink-0 mt-0.5", style.time)}>{item.time}</span>
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}
