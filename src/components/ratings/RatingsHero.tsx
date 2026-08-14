"use client";

import { useMemo, useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Sparkles, AlertTriangle, TrendingDown, ShieldCheck, Brain, RefreshCw,
  Star, Activity, DollarSign, Package
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { RatingsReviewsDataset } from "@/lib/ratingsReviewsData";

interface RatingsHeroProps {
  dataset: RatingsReviewsDataset;
  isLoading?: boolean;
  onRefresh?: () => void;
}

function AnimatedCounter({ target, prefix = "", suffix = "", duration = 1500 }: {
  target: number; prefix?: string; suffix?: string; duration?: number;
}) {
  const [current, setCurrent] = useState(0);
  useEffect(() => {
    let start = 0;
    const step = target / (duration / 16);
    const timer = setInterval(() => {
      start += step;
      if (start >= target) { setCurrent(target); clearInterval(timer); }
      else setCurrent(Math.floor(start));
    }, 16);
    return () => clearInterval(timer);
  }, [target, duration]);
  return <>{prefix}{current.toLocaleString("en-IN")}{suffix}</>;
}

function HealthRing({ score, size = 120 }: { score: number; size?: number }) {
  const radius = (size - 16) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = (score / 100) * circumference;
  const color = score >= 80 ? "#10B981" : score >= 60 ? "#F59E0B" : "#EF4444";
  const gradId = "healthGrad";
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <defs>
          <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#6D28D9" />
            <stop offset="100%" stopColor="#2563EB" />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={radius} stroke="rgba(255,255,255,0.1)" strokeWidth={10} fill="none" />
        <motion.circle
          cx={size / 2} cy={size / 2} r={radius}
          stroke={`url(#${gradId})`} strokeWidth={10} fill="none"
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: circumference - progress }}
          transition={{ duration: 1.5, ease: "easeOut" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-black text-white leading-none">{score}</span>
        <span className="text-[10px] text-white/60 font-bold uppercase tracking-wider mt-0.5">/ 100</span>
      </div>
    </div>
  );
}

function StarsDisplay({ rating }: { rating: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((s) => (
        <Star key={s} className={cn("w-4 h-4", s <= Math.round(rating) ? "fill-amber-400 text-amber-400" : "text-white/20")} />
      ))}
      <span className="ml-1.5 text-white/80 font-bold text-sm">{rating.toFixed(1)}</span>
    </div>
  );
}

export function RatingsHero({ dataset, isLoading, onRefresh }: RatingsHeroProps) {
  const stats = useMemo(() => {
    const { products, executiveSummary } = dataset;
    const rated = products.filter((p) => p.hasRating !== false && p.avgRating > 0);
    const totalReviews = products.reduce((a, p) => a + p.reviewCount, 0);
    const weightedRating = rated.length
      ? rated.reduce((a, p) => a + p.avgRating * p.reviewCount, 0) / rated.reduce((a, p) => a + p.reviewCount, 0)
      : 0;
    const healthScore = rated.length
      ? Math.round(rated.reduce((a, p) => a + p.healthScore, 0) / rated.length)
      : 0;
    const atRisk = products.filter((p) => p.healthScore < 60).length;
    const revenueAtRisk = products.reduce((a, p) => a + (p.estimatedRevenueLost || 0), 0);
    const returning = products.filter((p) => p.returnRate > 15).length;
    const recovered = products.filter((p) => p.priorRating < p.avgRating && p.avgRating >= 4).length;

    return { healthScore, weightedRating, totalReviews, atRisk, revenueAtRisk, returning, recovered, executiveSummary };
  }, [dataset]);

  const bullets = useMemo(() => {
    const { healthScore, weightedRating, atRisk, revenueAtRisk, recovered } = stats;
    return [
      `Rating ${weightedRating >= 4.2 ? "stable" : "needs attention"} at ${weightedRating.toFixed(1)}★ across catalog`,
      `${atRisk} product${atRisk !== 1 ? "s" : ""} need immediate action — below health threshold`,
      `Estimated revenue at risk: ₹${(revenueAtRisk / 1000).toFixed(0)}K/month from low-rated SKUs`,
      `${recovered} product${recovered !== 1 ? "s" : ""} recovered — rating improved ≥0.3★ this period`,
    ];
  }, [stats]);

  const [visibleBullets, setVisibleBullets] = useState<number[]>([]);
  useEffect(() => {
    bullets.forEach((_, i) => {
      setTimeout(() => setVisibleBullets((prev) => [...prev, i]), 400 + i * 350);
    });
  }, [bullets]);

  return (
    <motion.div
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="relative overflow-hidden rounded-3xl border border-purple-500/20 shadow-2xl shadow-purple-500/10"
    >
      {/* Mesh gradient background */}
      <div className="absolute inset-0 bg-gradient-to-br from-violet-950 via-indigo-950 to-slate-950" />
      <div className="absolute inset-0 opacity-40">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-purple-600 rounded-full blur-3xl opacity-20" />
        <div className="absolute bottom-0 right-1/4 w-80 h-80 bg-blue-600 rounded-full blur-3xl opacity-20" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 bg-violet-500 rounded-full blur-3xl opacity-10" />
      </div>

      {/* Shimmer overlay */}
      <div className="absolute inset-0 opacity-5 shimmer" />

      <div className="relative z-10 p-6 lg:p-8">
        <div className="flex flex-col lg:flex-row gap-8">

          {/* Left: Title + Health Score */}
          <div className="flex items-start gap-6 flex-shrink-0">
            <div className="flex flex-col items-center gap-2">
              <div className="relative">
                <div className="absolute inset-0 rounded-full bg-purple-500 blur-xl opacity-30 animate-pulse" />
                {isLoading ? (
                  <div className="w-[120px] h-[120px] rounded-full bg-white/10 animate-pulse" />
                ) : (
                  <HealthRing score={stats.healthScore} size={120} />
                )}
              </div>
              <span className="text-[10px] font-black uppercase tracking-widest text-white/50">AI Health Score</span>
            </div>

            <div className="flex flex-col gap-2 pt-2">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-purple-500 to-indigo-500 flex items-center justify-center">
                  <Brain className="w-3.5 h-3.5 text-white" />
                </div>
                <span className="text-[11px] font-black uppercase tracking-[0.15em] text-purple-300">AI Command Center</span>
              </div>
              <h1 className="text-2xl lg:text-3xl font-black text-white leading-tight tracking-tight">
                Ratings & Reviews
                <br />
                <span className="bg-gradient-to-r from-purple-300 to-blue-300 bg-clip-text text-transparent">
                  Intelligence
                </span>
              </h1>
              <StarsDisplay rating={stats.weightedRating} />
              <div className="flex items-center gap-1.5 mt-1">
                <span className={cn(
                  "text-[10px] font-black px-2.5 py-1 rounded-full border",
                  stats.healthScore >= 80
                    ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-300"
                    : stats.healthScore >= 60
                    ? "bg-amber-500/20 border-amber-500/40 text-amber-300"
                    : "bg-red-500/20 border-red-500/40 text-red-300"
                )}>
                  {stats.healthScore >= 80 ? "✓ HEALTHY" : stats.healthScore >= 60 ? "⚠ NEEDS ATTENTION" : "⚠ CRITICAL"}
                </span>
                <button
                  onClick={onRefresh}
                  className="flex items-center gap-1 text-[10px] font-bold text-white/40 hover:text-white/70 transition-colors px-2 py-1 rounded-lg hover:bg-white/5"
                >
                  <RefreshCw className="w-3 h-3" /> Refresh
                </button>
              </div>
            </div>
          </div>

          {/* Center: Stat Pills */}
          <div className="flex flex-col justify-center gap-3 flex-1 lg:border-l lg:border-r border-white/10 lg:px-8">
            <div className="grid grid-cols-2 gap-3">
              {[
                { icon: Package, label: "Products At Risk", value: stats.atRisk, suffix: " SKUs", color: "from-red-500/20 to-red-600/10 border-red-500/20 text-red-300" },
                { icon: DollarSign, label: "Revenue At Risk", value: Math.round(stats.revenueAtRisk / 1000), prefix: "₹", suffix: "K", color: "from-amber-500/20 to-amber-600/10 border-amber-500/20 text-amber-300" },
                { icon: Activity, label: "Total Reviews", value: stats.totalReviews, suffix: "", color: "from-blue-500/20 to-blue-600/10 border-blue-500/20 text-blue-300" },
                { icon: ShieldCheck, label: "Recovered SKUs", value: stats.recovered, suffix: " this week", color: "from-emerald-500/20 to-emerald-600/10 border-emerald-500/20 text-emerald-300" },
              ].map(({ icon: Icon, label, value, prefix = "", suffix, color }) => (
                <motion.div
                  key={label}
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.4, delay: 0.2 }}
                  className={cn("rounded-2xl border bg-gradient-to-br p-3.5", color)}
                >
                  <div className="flex items-center gap-1.5 mb-1">
                    <Icon className="w-3.5 h-3.5 opacity-70" />
                    <span className="text-[10px] font-bold uppercase tracking-wider opacity-70">{label}</span>
                  </div>
                  <p className="text-xl font-black text-white">
                    <AnimatedCounter target={value} prefix={prefix} suffix={suffix} />
                  </p>
                </motion.div>
              ))}
            </div>
          </div>

          {/* Right: AI Summary Feed */}
          <div className="flex-1 min-w-0 lg:min-w-[280px] lg:max-w-[360px]">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-5 h-5 rounded-md bg-gradient-to-br from-purple-500 to-indigo-500 flex items-center justify-center">
                <Sparkles className="w-3 h-3 text-white" />
              </div>
              <span className="text-[11px] font-black text-white/60 uppercase tracking-widest">AI Summary</span>
              <span className="ml-auto text-[9px] bg-purple-500/30 text-purple-300 border border-purple-500/40 px-2 py-0.5 rounded-full font-bold">LIVE</span>
            </div>
            <div className="space-y-2">
              {bullets.map((bullet, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, x: 20 }}
                  animate={visibleBullets.includes(i) ? { opacity: 1, x: 0 } : { opacity: 0, x: 20 }}
                  transition={{ duration: 0.3 }}
                  className="flex items-start gap-2.5 p-3 rounded-xl bg-white/5 border border-white/10"
                >
                  <span className="flex-shrink-0 mt-0.5">
                    {i === 0 ? "★" : i === 1 ? "⚠" : i === 2 ? "₹" : "✓"}
                  </span>
                  <p className="text-[12px] text-white/75 font-semibold leading-relaxed">{bullet}</p>
                </motion.div>
              ))}
            </div>
          </div>

        </div>

        {/* Bottom bar */}
        <div className="mt-6 pt-4 border-t border-white/10 flex items-center gap-4 flex-wrap">
          {[
            { icon: Brain, label: "AI-Powered Insights" },
            { icon: Activity, label: "Real-time Analysis" },
            { icon: AlertTriangle, label: "Anomaly Detection" },
            { icon: TrendingDown, label: "Trend Forecasting" },
          ].map(({ icon: Icon, label }) => (
            <div key={label} className="flex items-center gap-1.5 text-[10px] text-white/40 font-semibold">
              <Icon className="w-3 h-3" />
              {label}
            </div>
          ))}
        </div>
      </div>
    </motion.div>
  );
}
