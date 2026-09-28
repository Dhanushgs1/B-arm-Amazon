"use client";

import { motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";
import { AnimatedNumber } from "@/components/AnimatedNumber";
import {
  ArrowUpRight,
  ArrowDownRight,
  DollarSign,
  ShoppingBag,
  Percent,
  Eye,
  Activity,
  MousePointer,
  Layers,
} from "lucide-react";

const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const;

interface KPICardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  trend?: number;
  inverseTrend?: boolean;
  /**
   * What `trend` is measured against, e.g. "vs 2026-08-08 – 2026-08-14".
   * Shown as the badge tooltip. Passing this also marks the card as one that
   * *expects* a comparison, so a missing `trend` reads as "No prior data"
   * rather than falling back to the generic "Real-time" chip.
   */
  trendBasis?: string;
  delay?: number;
  accent?: "purple" | "blue" | "green" | "cyan" | "orange" | "pink";
  onClick?: () => void;
}

export function KPICard({ title, value, subtitle, trend, inverseTrend, trendBasis, delay = 0, accent, onClick }: KPICardProps) {
  // Real period-over-period figures can land on exactly no change, which the
  // badge rounds to "0.0%". Treating that as negative (trend > 0 === false)
  // would paint a flat metric red with a down arrow, so call it out as flat.
  const isFlat = trend != null && Math.abs(trend) < 0.05;
  const isPositive = trend != null ? trend > 0 : true;
  const isGood = trend != null ? (isPositive === !inverseTrend) : true;

  const accentColors = {
    purple: { text: "text-[#6C63FF]", bg: "bg-[#6C63FF]/8", border: "border-[#6C63FF]/15", sparkline: "#6C63FF", topbar: "from-[#6D5EF8] to-[#8B5CF6]", cardBorder: "border-purple-500/30 dark:border-purple-500/20" },
    blue: { text: "text-[#3B82F6]", bg: "bg-[#3B82F6]/8", border: "border-[#3B82F6]/15", sparkline: "#3B82F6", topbar: "from-[#3B82F6] to-[#06B6D4]", cardBorder: "border-blue-500/30 dark:border-blue-500/20" },
    green: { text: "text-[#10B981]", bg: "bg-[#10B981]/8", border: "border-[#10B981]/15", sparkline: "#10B981", topbar: "from-[#10B981] to-[#34D399]", cardBorder: "border-emerald-500/30 dark:border-emerald-500/20" },
    cyan: { text: "text-[#06B6D4]", bg: "bg-[#06B6D4]/8", border: "border-[#06B6D4]/15", sparkline: "#06B6D4", topbar: "from-[#06B6D4] to-[#3B82F6]", cardBorder: "border-cyan-500/30 dark:border-cyan-500/20" },
    orange: { text: "text-[#F59E0B]", bg: "bg-[#F59E0B]/8", border: "border-[#F59E0B]/15", sparkline: "#F59E0B", topbar: "from-[#F59E0B] to-[#F97316]", cardBorder: "border-amber-500/30 dark:border-amber-500/20" },
    pink: { text: "text-[#EC4899]", bg: "bg-[#EC4899]/8", border: "border-[#EC4899]/15", sparkline: "#EC4899", topbar: "from-[#EC4899] to-[#8B5CF6]", cardBorder: "border-pink-500/30 dark:border-pink-500/20" },
  };

  const style = accent ? accentColors[accent] : {
    text: "text-indigo-500 dark:text-indigo-400",
    bg: "bg-indigo-500/8",
    border: "border-indigo-500/15",
    sparkline: isGood ? "#10B981" : "#EF4444",
    topbar: "from-[#6D5EF8] to-[#8B5CF6]",
    cardBorder: "border-indigo-500/20 dark:border-indigo-500/15"
  };

  // Dynamically map icons based on title
  const getIcon = () => {
    const t = title.toLowerCase();
    if (t.includes("sales") || t.includes("revenue") || t.includes("value") || t.includes("spend") || t.includes("profit")) return DollarSign;
    if (t.includes("order") || t.includes("unit")) return ShoppingBag;
    if (t.includes("acos") || t.includes("roas") || t.includes("cvr") || t.includes("ctr")) return Percent;
    if (t.includes("impression") || t.includes("click")) return Eye;
    if (t.includes("campaign") || t.includes("product") || t.includes("catalog")) return Activity;
    if (t.includes("cpc")) return MousePointer;
    return Layers;
  };

  const CardIcon = getIcon();
  const reduceMotion = useReducedMotion();
  // Pages pass small, closely spaced delays (0.02 … 0.2); spread them so the cards visibly arrive
  // one after another instead of all at once.
  const enterDelay = delay * 3;

  return (
    <motion.div
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      initial={reduceMotion ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: enterDelay, duration: 0.55, ease: EASE_OUT_EXPO }}
      className={cn(
        "premium-card premium-card-hover rounded-2xl p-[18px] flex flex-col relative overflow-hidden group",
        onClick && "cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60"
      )}
    >
      {/* Accent line — draws in from the left as the card arrives */}
      <motion.div
        initial={reduceMotion ? false : { scaleX: 0 }}
        animate={{ scaleX: 1 }}
        transition={{ delay: enterDelay + 0.15, duration: 0.8, ease: EASE_OUT_EXPO }}
        className={cn("absolute top-0 left-0 right-0 h-[2px] origin-left bg-gradient-to-r opacity-80 group-hover:opacity-100 transition-opacity", style.topbar)}
      />

      <div className="relative z-10 flex justify-between items-start mb-3">
        <div className="flex items-center gap-2.5">
          <div className={cn("w-8 h-8 rounded-xl flex items-center justify-center border transition-colors", style.bg, style.border, style.text)}>
            <CardIcon className="w-3.5 h-3.5" />
          </div>
          <h3 className="text-[10px] font-extrabold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
            {title}
          </h3>
        </div>

        {trend != null ? (
          <div
            title={trendBasis}
            className={cn(
              "flex items-center gap-0.5 text-[10px] font-extrabold px-1.5 py-0.5 rounded-full border",
              isFlat
                ? "bg-slate-500/8 text-slate-500 dark:text-slate-400 border-slate-500/15"
                : isGood
                  ? "bg-emerald-500/8 text-emerald-600 dark:text-emerald-400 border-emerald-500/15"
                  : "bg-red-500/8 text-red-600 dark:text-red-400 border-red-500/15"
            )}
          >
            {isFlat
              ? "0.0%"
              : <>
                  {isPositive ? <ArrowUpRight className="w-2.5 h-2.5" /> : <ArrowDownRight className="w-2.5 h-2.5" />}
                  {Math.abs(trend).toFixed(1)}%
                </>}
          </div>
        ) : trendBasis ? (
          <div
            title={trendBasis}
            className="text-[9px] font-extrabold text-slate-400 dark:text-slate-500 bg-slate-500/8 px-1.5 py-0.5 rounded-full border border-slate-500/15"
          >
            No prior data
          </div>
        ) : null}
      </div>

      <div className="relative z-10 flex-1 flex flex-col justify-end pt-1">
        <div className="text-[26px] leading-tight font-bold text-slate-900 dark:text-white tracking-tight">
          <AnimatedNumber value={value} delay={enterDelay + 0.1} />
        </div>
        {subtitle && (
          <div className="text-[11.5px] font-medium text-slate-500 dark:text-slate-400 mt-1">
            {subtitle}
          </div>
        )}
      </div>

      {/* Decorative wave — rises in softly behind the value */}
      <motion.div
        initial={reduceMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: enterDelay + 0.25, duration: 0.9, ease: EASE_OUT_EXPO }}
        className="absolute bottom-0 left-0 right-0 h-8 pointer-events-none"
      >
      <div className="w-full h-full opacity-[0.14] transition-opacity duration-500 group-hover:opacity-30">
        <svg className="w-full h-full" viewBox="0 0 100 20" preserveAspectRatio="none">
          <defs>
            <linearGradient id={`spark-${title.replace(/\W/g, "")}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={style.sparkline} stopOpacity="0.9" />
              <stop offset="100%" stopColor={style.sparkline} stopOpacity="0.1" />
            </linearGradient>
          </defs>
          <path
            d={
              isGood
                ? "M0 15 Q 15 10, 30 14 T 60 7 T 90 12 L 100 5 L 100 20 L 0 20 Z"
                : "M0 5 Q 15 12, 30 8 T 60 14 T 90 6 L 100 15 L 100 20 L 0 20 Z"
            }
            fill={`url(#spark-${title.replace(/\W/g, "")})`}
          />
        </svg>
      </div>
      </motion.div>
    </motion.div>
  );
}
