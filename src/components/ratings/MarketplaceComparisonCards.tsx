"use client";

import { motion } from "framer-motion";
import { Star, TrendingUp, TrendingDown, ShieldCheck, Package } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PlatformSummary } from "@/lib/ratingsReviewsData";

const PLATFORM_META: Record<string, { label: string; color: string; gradient: string; emoji: string }> = {
  amazon: { label: "Amazon", color: "#FF9900", gradient: "from-amber-500 to-orange-500", emoji: "🟠" },
  amazon_ca: { label: "Amazon CA", color: "#FF9900", gradient: "from-amber-400 to-orange-400", emoji: "🍁" },
  amazon_us: { label: "Amazon US", color: "#FF9900", gradient: "from-amber-500 to-orange-500", emoji: "🇺🇸" },
  flipkart: { label: "Flipkart", color: "#2874F0", gradient: "from-blue-600 to-blue-500", emoji: "🔵" },
  meesho: { label: "Meesho", color: "#F43397", gradient: "from-pink-500 to-rose-500", emoji: "🛍️" },
  shopsy: { label: "Shopsy", color: "#6366F1", gradient: "from-indigo-500 to-purple-500", emoji: "🛒" },
  jiomart: { label: "JioMart", color: "#005DAA", gradient: "from-blue-700 to-blue-600", emoji: "🔷" },
  blinkit: { label: "Blinkit", color: "#FFD700", gradient: "from-yellow-400 to-amber-400", emoji: "⚡" },
  barm: { label: "B-Arm", color: "#10B981", gradient: "from-emerald-500 to-teal-500", emoji: "💊" },
  sbi: { label: "SBI", color: "#2563EB", gradient: "from-blue-600 to-indigo-600", emoji: "🏦" },
  "1mg": { label: "1mg", color: "#DC2626", gradient: "from-red-500 to-rose-500", emoji: "💊" },
  other: { label: "Other", color: "#94A3B8", gradient: "from-slate-400 to-slate-500", emoji: "🌐" },
};

const DEMO_PLATFORMS: PlatformSummary[] = [
  { platform: "amazon", label: "Amazon", productCount: 10, avgRating: 4.2, totalReviews: 8450, totalReturns: 312, negativeReviewPct: 14.5, salesImpact: -24000, healthScore: 78 },
  { platform: "flipkart", label: "Flipkart", productCount: 10, avgRating: 4.0, totalReviews: 5230, totalReturns: 487, negativeReviewPct: 19.2, salesImpact: -38000, healthScore: 65 },
  { platform: "meesho", label: "Meesho", productCount: 5, avgRating: 3.8, totalReviews: 2100, totalReturns: 290, negativeReviewPct: 24.1, salesImpact: -18000, healthScore: 55 },
];

function HealthBar({ score }: { score: number }) {
  const color = score >= 80 ? "#10B981" : score >= 60 ? "#F59E0B" : "#EF4444";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-black/20 dark:bg-white/10 rounded-full overflow-hidden">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${score}%` }}
          transition={{ duration: 0.8 }}
          className="h-full rounded-full"
          style={{ background: color }}
        />
      </div>
      <span className="text-[10px] font-black" style={{ color }}>{score}/100</span>
    </div>
  );
}

function StarRating({ rating }: { rating: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((s) => (
        <Star key={s} className={cn("w-3 h-3",
          s <= Math.floor(rating) ? "fill-current text-amber-400"
          : s - 0.5 <= rating ? "fill-current text-amber-400 opacity-60"
          : "text-white/30"
        )} />
      ))}
      <span className="ml-1 text-[11px] font-black text-white/80">{rating.toFixed(1)}</span>
    </div>
  );
}

export function MarketplaceComparisonCards({ platforms }: { platforms: PlatformSummary[] }) {
  const displayPlatforms = platforms.length > 0 ? platforms : DEMO_PLATFORMS;

  return (
    <div>
      <div className="flex items-center gap-2 mb-5">
        <Package className="w-4 h-4 text-indigo-500" />
        <h2 className="text-sm font-black text-foreground uppercase tracking-widest">Marketplace Comparison</h2>
        <span className="text-[10px] bg-muted text-muted-foreground border border-border font-bold px-2 py-0.5 rounded-full">
          {displayPlatforms.length} Platforms
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {displayPlatforms.map((platform, i) => {
          const meta = PLATFORM_META[platform.platform] || PLATFORM_META.other;
          const isHealthy = platform.healthScore >= 70;

          return (
            <motion.div
              key={platform.platform}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.1 }}
              className="relative rounded-3xl overflow-hidden border border-border shadow-lg hover:shadow-xl transition-all duration-300 hover:-translate-y-1 cursor-default"
            >
              {/* Gradient header */}
              <div className={cn("px-5 py-4 bg-gradient-to-r text-white relative overflow-hidden", meta.gradient)}>
                <div className="absolute top-0 right-0 w-24 h-24 rounded-full bg-white/10 blur-2xl" />
                <div className="relative z-10">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xl">{meta.emoji}</span>
                      <h3 className="font-black text-base">{meta.label}</h3>
                    </div>
                    <span className={cn(
                      "text-[9px] font-black px-2 py-0.5 rounded-full",
                      isHealthy ? "bg-white/20 text-white" : "bg-red-500/40 text-white"
                    )}>
                      {isHealthy ? "✓ Healthy" : "⚠ At Risk"}
                    </span>
                  </div>
                  <StarRating rating={platform.avgRating} />
                  <HealthBar score={platform.healthScore} />
                </div>
              </div>

              {/* Body */}
              <div className="bg-card p-4 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { label: "Total Reviews", value: platform.totalReviews.toLocaleString("en-IN"), icon: Star, good: true },
                    { label: "Total Returns", value: platform.totalReturns.toLocaleString("en-IN"), icon: Package, good: false },
                    { label: "Negative Reviews", value: `${platform.negativeReviewPct.toFixed(1)}%`, icon: TrendingDown, good: platform.negativeReviewPct < 15 },
                    { label: "Sales Impact", value: `₹${Math.abs(platform.salesImpact / 1000).toFixed(0)}K`, icon: platform.salesImpact >= 0 ? TrendingUp : TrendingDown, good: platform.salesImpact >= 0 },
                  ].map(({ label, value, icon: Icon, good }) => (
                    <div key={label} className="p-2.5 rounded-xl bg-muted/40 border border-border">
                      <div className="flex items-center gap-1 mb-0.5">
                        <Icon className={cn("w-3 h-3", good ? "text-emerald-500" : "text-red-500")} />
                        <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">{label}</span>
                      </div>
                      <p className={cn("text-sm font-black", good ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>{value}</p>
                    </div>
                  ))}
                </div>

                {/* Products count */}
                <div className="flex items-center justify-between pt-1 border-t border-border">
                  <span className="text-[10px] text-muted-foreground font-semibold">
                    {platform.productCount} products listed
                  </span>
                  <div className="flex items-center gap-1">
                    <ShieldCheck className={cn("w-3.5 h-3.5", isHealthy ? "text-emerald-500" : "text-amber-500")} />
                    <span className={cn("text-[10px] font-black", isHealthy ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400")}>
                      Health: {platform.healthScore}/100
                    </span>
                  </div>
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
