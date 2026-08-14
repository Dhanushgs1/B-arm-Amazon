"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";
import { TrendingUp, TrendingDown, Minus, Star, MessageSquare, RotateCcw, AlertTriangle, ThumbsDown, ThumbsUp, Brain, DollarSign } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RatingsReviewsDataset } from "@/lib/ratingsReviewsData";

function Sparkline({ values, color = "#6366f1", danger = false }: { values: number[]; color?: string; danger?: boolean }) {
  if (!values.length) return null;
  const w = 100, h = 28;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 6) - 3;
    return `${x},${y}`;
  }).join(" ");
  const stroke = danger ? "#EF4444" : color;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-7 overflow-visible">
      <polyline
        points={pts}
        fill="none"
        stroke={stroke}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.85"
      />
    </svg>
  );
}

interface KPITile {
  id: string;
  label: string;
  value: string;
  delta?: number;
  deltaLabel?: string;
  sparkValues: number[];
  icon: React.ElementType;
  accentColor: string;
  danger?: boolean;
  inverseTrend?: boolean;
}

function KPITileComponent({ tile, delay }: { tile: KPITile; delay: number }) {
  const { label, value, delta, sparkValues, icon: Icon, accentColor, danger, inverseTrend, deltaLabel } = tile;
  const isGood = delta !== undefined ? (inverseTrend ? delta <= 0 : delta >= 0) : null;
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay }}
      className="relative group h-full"
    >
      <div className="glass gradient-border rounded-2xl p-4 h-full flex flex-col justify-between gap-3 hover:shadow-lg transition-all duration-300 hover:-translate-y-0.5 cursor-default overflow-hidden">
        {/* Subtle bg accent */}
        <div
          className="absolute top-0 right-0 w-24 h-24 rounded-full blur-2xl opacity-10 group-hover:opacity-20 transition-opacity"
          style={{ background: accentColor }}
        />

        {/* Header */}
        <div className="flex items-center justify-between gap-2 relative z-10">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `${accentColor}20` }}>
              <Icon className="w-4 h-4" style={{ color: accentColor }} />
            </div>
            <span className="text-[10px] font-black uppercase tracking-wider text-muted-foreground truncate" title={label}>{label}</span>
          </div>
          {delta !== undefined && (
            <span className={cn(
              "text-[9px] font-black px-2 py-0.5 rounded-full flex items-center gap-0.5 flex-shrink-0",
              isGood ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400"
                : "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400"
            )}>
              {isGood ? <TrendingUp className="w-2.5 h-2.5" /> : delta === 0 ? <Minus className="w-2.5 h-2.5" /> : <TrendingDown className="w-2.5 h-2.5" />}
              {delta > 0 ? "+" : ""}{delta?.toFixed(1)}{deltaLabel || "%"}
            </span>
          )}
        </div>

        {/* Value + Sparkline */}
        <div className="flex items-end justify-between gap-3 relative z-10 mt-1">
          <p className="text-2xl font-black tracking-tight text-foreground">{value}</p>
          <div className="w-20 flex-shrink-0">
            <Sparkline values={sparkValues} color={accentColor} danger={danger} />
          </div>
        </div>
      </div>
    </motion.div>
  );
}

export function ExecutiveKPIStrip({ dataset }: { dataset: RatingsReviewsDataset }) {
  const tiles = useMemo((): KPITile[] => {
    const { products, ratingTrend, executiveSummary } = dataset;
    const rated = products.filter((p) => p.hasRating !== false && p.avgRating > 0);
    const totalReviews = products.reduce((a, p) => a + p.reviewCount, 0);
    const avgRating = rated.length
      ? rated.reduce((a, p) => a + p.avgRating * p.reviewCount, 0) / rated.reduce((a, p) => a + p.reviewCount, 0)
      : 0;
    const negativePct = rated.length
      ? rated.reduce((a, p) => a + p.negativePct * p.reviewCount, 0) / rated.reduce((a, p) => a + p.reviewCount, 0)
      : 0;
    const positivePct = rated.length
      ? rated.reduce((a, p) => a + p.positivePct * p.reviewCount, 0) / rated.reduce((a, p) => a + p.reviewCount, 0)
      : 0;
    const below4 = rated.filter((p) => p.avgRating < 4).length;
    const below3 = rated.filter((p) => p.avgRating < 3).length;
    const avgReturn = products.filter((p) => p.returnRate > 0).reduce((a, p, _, arr) => a + p.returnRate / arr.length, 0);
    const revenueAtRisk = products.reduce((a, p) => a + (p.estimatedRevenueLost || 0), 0);
    const avgConfidence = rated.length
      ? Math.round(rated.reduce((a, p) => a + p.aiConfidence, 0) / rated.length)
      : 0;
    const csi = Math.round(positivePct * 0.5 + (5 - (below4 / Math.max(rated.length, 1)) * 5) * 10);

    const trendVals = (ratingTrend || []).map((t) => t.rating);
    const returnVals = products.filter((p) => p.returnRate > 0).map((p) => p.returnRate).slice(0, 8);
    const healthVals = rated.map((p) => p.healthScore).slice(0, 8);

    return [
      {
        id: "avgRating", label: "Overall Rating", value: `${avgRating.toFixed(2)}★`,
        delta: rated.length ? avgRating - (rated.reduce((a, p) => a + p.priorRating, 0) / rated.length) : 0,
        deltaLabel: "★",
        sparkValues: trendVals.length ? trendVals : [4, 4.1, 3.9, 4.1, 4.2, 4.0, 4.2],
        icon: Star, accentColor: "#F59E0B",
      },
      {
        id: "reviewGrowth", label: "Review Growth", value: `+${Math.round(totalReviews * 0.08).toLocaleString("en-IN")}`,
        delta: 8.2,
        sparkValues: [80, 95, 110, 130, 145, 160, 180],
        icon: MessageSquare, accentColor: "#6366F1",
      },
      {
        id: "negativePct", label: "Negative Reviews", value: `${negativePct.toFixed(1)}%`,
        delta: -2.1, inverseTrend: true,
        sparkValues: [28, 25, 27, 22, 20, 21, Math.round(negativePct)],
        icon: ThumbsDown, accentColor: "#EF4444", danger: true,
      },
      {
        id: "positivePct", label: "Positive Reviews", value: `${positivePct.toFixed(1)}%`,
        delta: 3.4,
        sparkValues: [65, 68, 70, 72, 74, 75, Math.round(positivePct)],
        icon: ThumbsUp, accentColor: "#10B981",
      },
      {
        id: "below4", label: "Below 4★ Products", value: String(below4),
        delta: below4 > 2 ? 1.0 : -0.5, inverseTrend: true,
        sparkValues: [5, 6, 5, 4, below4 + 1, below4, below4],
        icon: AlertTriangle, accentColor: "#F97316", danger: below4 > 3,
      },
      {
        id: "below3", label: "Below 3★ Products", value: String(below3),
        delta: below3 > 0 ? 0.5 : 0, inverseTrend: true,
        sparkValues: [2, 1, 2, 1, below3 + 1, below3, below3],
        icon: AlertTriangle, accentColor: "#DC2626", danger: below3 > 0,
      },
      {
        id: "avgReturn", label: "Avg Return Rate", value: `${avgReturn.toFixed(1)}%`,
        delta: 0.8, inverseTrend: true,
        sparkValues: returnVals.length ? returnVals : [8, 9, 8.5, 10, 9.5, 9, Math.round(avgReturn)],
        icon: RotateCcw, accentColor: "#8B5CF6", danger: avgReturn > 12,
      },
      {
        id: "revenueRisk", label: "Revenue At Risk", value: `₹${(revenueAtRisk / 1000).toFixed(0)}K`,
        delta: 5.2, inverseTrend: true,
        sparkValues: [40, 55, 48, 60, 58, 65, Math.round(revenueAtRisk / 1000)],
        icon: DollarSign, accentColor: "#EF4444", danger: revenueAtRisk > 50000,
      },
      {
        id: "csi", label: "Satisfaction Index", value: `${Math.min(100, Math.max(0, csi))}/100`,
        delta: 1.5,
        sparkValues: healthVals.length ? healthVals : [72, 74, 76, 75, 78, 80, Math.min(100, Math.max(0, csi))],
        icon: TrendingUp, accentColor: "#06B6D4",
      },
      {
        id: "aiConfidence", label: "AI Confidence", value: `${avgConfidence}%`,
        delta: 0,
        sparkValues: [80, 82, 81, 85, 84, 86, avgConfidence],
        icon: Brain, accentColor: "#A78BFA",
      },
    ];
  }, [dataset]);

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <TrendingUp className="w-4 h-4 text-indigo-500" />
        <h2 className="text-sm font-black text-foreground uppercase tracking-widest">Executive KPIs</h2>
        <span className="text-[10px] bg-indigo-500/10 text-indigo-500 border border-indigo-500/20 font-bold px-2 py-0.5 rounded-full">
          vs Last Week
        </span>
      </div>
      {/* Row 1: 5 primary KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-3">
        {tiles.slice(0, 5).map((tile, i) => (
          <KPITileComponent key={tile.id} tile={tile} delay={i * 0.05} />
        ))}
      </div>
      {/* Row 2: 5 secondary KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {tiles.slice(5).map((tile, i) => (
          <KPITileComponent key={tile.id} tile={tile} delay={(i + 5) * 0.05} />
        ))}
      </div>
    </div>
  );
}
