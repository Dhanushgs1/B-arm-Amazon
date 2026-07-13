"use client";

import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
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
  Sparkles
} from "lucide-react";

interface KPICardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  trend?: number;
  inverseTrend?: boolean; // If true, negative trend is good (e.g. ACOS)
  delay?: number;
  accent?: "purple" | "blue" | "green" | "cyan" | "orange" | "pink";
}

export function KPICard({ title, value, subtitle, trend, inverseTrend, delay = 0, accent }: KPICardProps) {
  const isPositive = trend != null ? trend > 0 : true;
  const isGood = trend != null ? (isPositive === !inverseTrend) : true;

  const accentColors = {
    purple: { text: "text-[#7C3AED]", bg: "bg-[#7C3AED]/5", border: "border-[#7C3AED]/10", sparkline: "#7C3AED" },
    blue: { text: "text-[#3B82F6]", bg: "bg-[#3B82F6]/5", border: "border-[#3B82F6]/10", sparkline: "#3B82F6" },
    green: { text: "text-[#22C55E]", bg: "bg-[#22C55E]/5", border: "border-[#22C55E]/10", sparkline: "#22C55E" },
    cyan: { text: "text-[#06B6D4]", bg: "bg-[#06B6D4]/5", border: "border-[#06B6D4]/10", sparkline: "#06B6D4" },
    orange: { text: "text-[#F59E0B]", bg: "bg-[#F59E0B]/5", border: "border-[#F59E0B]/10", sparkline: "#F59E0B" },
    pink: { text: "text-[#EC4899]", bg: "bg-[#EC4899]/5", border: "border-[#EC4899]/10", sparkline: "#EC4899" },
  };

  const style = accent ? accentColors[accent] : {
    text: "text-indigo-500 dark:text-indigo-400",
    bg: "bg-indigo-500/5",
    border: "border-indigo-500/10",
    sparkline: isGood ? "#10B981" : "#EF4444"
  };

  // Dynamically map icons based on title
  const getIcon = () => {
    const t = title.toLowerCase();
    if (t.includes("sales") || t.includes("revenue") || t.includes("value") || t.includes("spend") || t.includes("profit")) {
      return DollarSign;
    }
    if (t.includes("order") || t.includes("unit")) {
      return ShoppingBag;
    }
    if (t.includes("acos") || t.includes("roas") || t.includes("cvr") || t.includes("ctr")) {
      return Percent;
    }
    if (t.includes("impression") || t.includes("click")) {
      return Eye;
    }
    if (t.includes("campaign") || t.includes("product") || t.includes("catalog")) {
      return Activity;
    }
    if (t.includes("cpc")) {
      return MousePointer;
    }
    return Layers;
  };

  const CardIcon = getIcon();

  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.4, ease: "easeOut" }}
      className="glass rounded-2xl p-5 flex flex-col relative overflow-hidden group shadow-sm hover:shadow-[0_12px_30px_rgba(99,102,241,0.08)] hover:-translate-y-1 transition-all duration-300 border border-slate-200/60 dark:border-slate-800/60 bg-white/70 dark:bg-slate-900/40"
    >
      {/* Hover glow effect */}
      <div className="absolute -inset-0.5 bg-gradient-to-br from-indigo-500/5 to-purple-500/5 opacity-0 group-hover:opacity-100 transition duration-500 rounded-[inherit] pointer-events-none" />
      
      <div className="relative z-10 flex justify-between items-start mb-3">
        <div className="flex items-center gap-2">
          <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center border transition-colors", style.bg, style.border, style.text)}>
            <CardIcon className="w-3.5 h-3.5" />
          </div>
          <h3 className="text-[11px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-wider">
            {title}
          </h3>
        </div>
        
        {trend != null ? (
          <div
            className={cn(
              "flex items-center gap-0.5 text-[10px] font-black px-2 py-0.5 rounded-full border",
              isGood 
                ? "bg-emerald-500/5 text-emerald-600 dark:text-emerald-400 border-emerald-500/10" 
                : "bg-red-500/5 text-red-600 dark:text-red-400 border-red-500/10"
            )}
          >
            {isPositive ? <ArrowUpRight className="w-2.5 h-2.5" /> : <ArrowDownRight className="w-2.5 h-2.5" />}
            {Math.abs(trend).toFixed(1)}%
          </div>
        ) : (
          <div className="text-[9px] font-black text-indigo-500/60 bg-indigo-500/5 px-1.5 py-0.5 rounded border border-indigo-500/10 flex items-center gap-0.5">
            <Sparkles className="w-2.5 h-2.5" /> Real-time
          </div>
        )}
      </div>

      <div className="relative z-10 flex-1 flex flex-col justify-end pt-2">
        <div className="text-2xl font-black text-slate-900 dark:text-white tracking-tight">
          {value}
        </div>
        {subtitle && (
          <div className="text-[11px] font-bold text-slate-400 dark:text-slate-500 mt-0.5">
            {subtitle}
          </div>
        )}
      </div>

      {/* Premium Sparkline Background Path */}
      <div className="absolute bottom-0 left-0 right-0 h-6 opacity-20 pointer-events-none transition-opacity group-hover:opacity-35">
        <svg className="w-full h-full" viewBox="0 0 100 20" preserveAspectRatio="none">
          <path
            d={
              isGood 
                ? "M0 15 Q 15 10, 30 14 T 60 7 T 90 12 L 100 5 L 100 20 L 0 20 Z"
                : "M0 5 Q 15 12, 30 8 T 60 14 T 90 6 L 100 15 L 100 20 L 0 20 Z"
            }
            fill={style.sparkline}
          />
        </svg>
      </div>
    </motion.div>
  );
}
