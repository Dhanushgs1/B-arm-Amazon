"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Brain, ChevronDown, ChevronUp, AlertTriangle, Package, Layers, Clock, TrendingDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RatingsReviewsDataset } from "@/lib/ratingsReviewsData";

const ROOT_CAUSE_GROUPS = [
  {
    id: "quality",
    label: "Quality Issues",
    icon: "🏭",
    color: "from-red-500/10 to-red-600/5 border-red-200 dark:border-red-900",
    badgeColor: "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400",
    confidence: 89,
    priority: "Critical" as const,
    rootCause: "Product quality control failures — manufacturing defects, material degradation, or inconsistent batch quality.",
    suggestedFix: "Conduct a full QC audit on the last 3 production batches. Implement 100% inspection for high-return SKUs. Review supplier compliance.",
    expectedImprovement: "18–25% reduction in return rate",
    timeline: "3–6 weeks",
  },
  {
    id: "packaging",
    label: "Packaging Issues",
    icon: "📦",
    color: "from-orange-500/10 to-orange-600/5 border-orange-200 dark:border-orange-900",
    badgeColor: "bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-400",
    confidence: 84,
    priority: "High" as const,
    rootCause: "Transit damage from inadequate protective packaging. Products arriving damaged is a top complaint across 43% of negative reviews.",
    suggestedFix: "Upgrade to double-wall corrugated boxes. Add air pillows or foam inserts for fragile items. Redesign inner packaging for glass/liquid products.",
    expectedImprovement: "12–18% fewer damaged-on-arrival returns",
    timeline: "2–4 weeks",
  },
  {
    id: "fulfillment",
    label: "Fulfillment Issues",
    icon: "🚚",
    color: "from-amber-500/10 to-amber-600/5 border-amber-200 dark:border-amber-900",
    badgeColor: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400",
    confidence: 76,
    priority: "High" as const,
    rootCause: "Late delivery complaints increasing — likely driven by FBM order delays in Tier-2/3 cities and last-mile logistics failures.",
    suggestedFix: "Shift critical SKUs to FBA. Audit 3PL SLA compliance. Add buffer stock in regional fulfillment centers.",
    expectedImprovement: "Delivery-related complaints reduced by 30%",
    timeline: "4–8 weeks",
  },
  {
    id: "listing",
    label: "Listing Issues",
    icon: "📋",
    color: "from-blue-500/10 to-blue-600/5 border-blue-200 dark:border-blue-900",
    badgeColor: "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400",
    confidence: 71,
    priority: "Medium" as const,
    rootCause: "Product description mismatch causing \"Not as Described\" returns. Images show older product version; bullet points missing key specifications.",
    suggestedFix: "Audit top-10 return-heavy SKUs. Update A+ content with real product photos. Add measurement tables and comparison charts.",
    expectedImprovement: "8–12% fewer expectation-mismatch returns",
    timeline: "1–2 weeks",
  },
  {
    id: "pricing",
    label: "Price Issues",
    icon: "💰",
    color: "from-purple-500/10 to-purple-600/5 border-purple-200 dark:border-purple-900",
    badgeColor: "bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-400",
    confidence: 62,
    priority: "Medium" as const,
    rootCause: "Price-to-value perception gap. Products priced 15–20% above segment average are receiving \"Overpriced\" complaints, increasing negative review volume.",
    suggestedFix: "Run A/B price test at 5% lower price point. Bundle complementary accessories to improve perceived value. Highlight premium features in copy.",
    expectedImprovement: "10–15% improvement in value-for-money sentiment",
    timeline: "1–3 weeks",
  },
  {
    id: "competition",
    label: "Competition",
    icon: "⚔️",
    color: "from-slate-500/10 to-slate-600/5 border-slate-200 dark:border-slate-700",
    badgeColor: "bg-slate-100 text-slate-700 dark:bg-slate-800/60 dark:text-slate-400",
    confidence: 55,
    priority: "Low" as const,
    rootCause: "Competitor products gaining review volume and improving ratings in the same category, potentially cannibalizing organic search ranking.",
    suggestedFix: "Analyze top 3 competitor ASINs. Identify feature gaps. Accelerate review generation on high-performing SKUs.",
    expectedImprovement: "Recover 5–8% search ranking positions",
    timeline: "6–12 weeks",
  },
];

const PRIORITY_COLORS: Record<string, string> = {
  Critical: "bg-red-500 text-white",
  High: "bg-orange-500 text-white",
  Medium: "bg-amber-500 text-white",
  Low: "bg-slate-400 text-white",
};

function RootCauseCard({ group, idx, affectedProducts, revenueRisk }: {
  group: typeof ROOT_CAUSE_GROUPS[0];
  idx: number;
  affectedProducts: number;
  revenueRisk: number;
}) {
  const [expanded, setExpanded] = useState(idx < 2);

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: idx * 0.07 }}
      className={cn("rounded-3xl border bg-gradient-to-br overflow-hidden", group.color)}
    >
      {/* Header */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-4 p-5 text-left hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
      >
        <span className="text-2xl flex-shrink-0">{group.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-black text-sm text-foreground">{group.label}</h3>
            <span className={cn("text-[8px] font-black px-1.5 py-0.5 rounded uppercase tracking-wider", PRIORITY_COLORS[group.priority])}>
              {group.priority}
            </span>
          </div>
          <div className="flex items-center gap-4 text-[10px] text-muted-foreground font-semibold">
            <span className="flex items-center gap-1"><Package className="w-3 h-3" /> {affectedProducts} SKUs</span>
            <span className="flex items-center gap-1"><TrendingDown className="w-3 h-3 text-red-500" /> ₹{(revenueRisk / 1000).toFixed(0)}K risk</span>
            <span>AI Confidence: <strong className="text-foreground">{group.confidence}%</strong></span>
          </div>
        </div>

        {/* Confidence bar */}
        <div className="flex-shrink-0 w-16">
          <div className="h-1.5 bg-black/10 dark:bg-white/10 rounded-full overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${group.confidence}%` }}
              transition={{ duration: 0.8, delay: idx * 0.07 + 0.2 }}
              className="h-full bg-indigo-500 rounded-full"
            />
          </div>
          <p className="text-[8px] text-muted-foreground font-bold mt-0.5 text-right">{group.confidence}%</p>
        </div>

        {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground flex-shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />}
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
          >
            <div className="px-5 pb-5 border-t border-black/10 dark:border-white/10">
              <div className="pt-4 grid grid-cols-1 md:grid-cols-2 gap-4">

                {/* Root Cause */}
                <div className="space-y-1">
                  <p className="text-[9px] font-black uppercase tracking-widest text-muted-foreground flex items-center gap-1">
                    <Brain className="w-3 h-3" /> Root Cause
                  </p>
                  <p className="text-[12px] font-semibold text-foreground leading-relaxed">{group.rootCause}</p>
                </div>

                {/* Suggested Fix */}
                <div className="space-y-1">
                  <p className="text-[9px] font-black uppercase tracking-widest text-indigo-500 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" /> Suggested Fix
                  </p>
                  <p className="text-[12px] font-semibold text-foreground leading-relaxed">{group.suggestedFix}</p>
                </div>

                {/* Bottom row */}
                <div className="md:col-span-2 flex flex-wrap gap-3 pt-1">
                  <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
                    <span className="text-[9px] font-black text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">Expected Improvement</span>
                    <span className="text-[11px] font-black text-emerald-700 dark:text-emerald-300">{group.expectedImprovement}</span>
                  </div>
                  <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-500/10 border border-blue-500/20">
                    <Clock className="w-3 h-3 text-blue-500" />
                    <span className="text-[9px] font-black text-blue-600 dark:text-blue-400 uppercase tracking-wider">Timeline</span>
                    <span className="text-[11px] font-black text-blue-700 dark:text-blue-300">{group.timeline}</span>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export function AiRootCauseCenter({ dataset }: { dataset: RatingsReviewsDataset }) {
  const { products } = dataset;
  const totalRevRisk = products.reduce((a, p) => a + (p.estimatedRevenueLost || 0), 0);
  const criticalCount = products.filter((p) => p.healthScore < 50).length;

  // Distribute affected products and revenue across groups
  const groupStats = ROOT_CAUSE_GROUPS.map((g, i) => ({
    affectedProducts: Math.max(1, Math.round(products.length * [0.4, 0.35, 0.25, 0.2, 0.15, 0.1][i])),
    revenueRisk: Math.round(totalRevRisk * [0.35, 0.25, 0.2, 0.1, 0.07, 0.03][i]),
  }));

  return (
    <div>
      <div className="flex items-center gap-2 mb-5">
        <Brain className="w-4 h-4 text-indigo-500" />
        <h2 className="text-sm font-black text-foreground uppercase tracking-widest">AI Root Cause Analysis</h2>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[10px] font-bold text-red-600 dark:text-red-400 bg-red-500/10 border border-red-500/20 px-2 py-0.5 rounded-full">
            {criticalCount} Critical Issues
          </span>
        </div>
      </div>
      <div className="space-y-3">
        {ROOT_CAUSE_GROUPS.map((group, i) => (
          <RootCauseCard
            key={group.id}
            group={group}
            idx={i}
            affectedProducts={groupStats[i].affectedProducts}
            revenueRisk={groupStats[i].revenueRisk}
          />
        ))}
      </div>
    </div>
  );
}
