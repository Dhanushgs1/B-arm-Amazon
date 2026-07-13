"use client";

import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { ArrowUpRight, ArrowDownRight, TrendingUp } from "lucide-react";

interface KPICardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  trend?: number;
  inverseTrend?: boolean; // If true, negative trend is good (e.g. ACOS)
  delay?: number;
}

export function KPICard({ title, value, subtitle, trend, inverseTrend, delay = 0 }: KPICardProps) {
  const isPositive = trend ? trend > 0 : null;
  const isGood = isPositive === !inverseTrend;

  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.4, ease: "easeOut" }}
      className="glass rounded-2xl p-5 flex flex-col relative overflow-hidden group shadow-sm hover:shadow-lg transition-all duration-300 border border-border"
    >
      {/* Glow Effect */}
      <div className="absolute -inset-0.5 bg-gradient-to-br from-primary/10 to-accent/10 opacity-0 group-hover:opacity-100 transition duration-500 rounded-[inherit]" />
      
      <div className="relative z-10 flex justify-between items-start mb-2">
        <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
          {title}
        </h3>
        {trend != null && (
          <div
            className={cn(
              "flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full",
              isGood ? "bg-green-500/10 text-green-600 dark:text-green-400" : "bg-red-500/10 text-red-600 dark:text-red-400"
            )}
          >
            {isPositive ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
            {Math.abs(trend).toFixed(1)}%
          </div>
        )}
      </div>

      <div className="relative z-10 flex-1 flex flex-col justify-end">
        <div className="text-2xl font-black text-foreground tracking-tight">
          {value}
        </div>
        {subtitle && (
          <div className="text-xs font-medium text-muted-foreground mt-1">
            {subtitle}
          </div>
        )}
      </div>

      {/* Subtle Background Icon */}
      <TrendingUp className="absolute -bottom-4 -right-4 w-20 h-20 text-primary/5 group-hover:text-primary/10 transition-colors duration-500 -rotate-12" />
    </motion.div>
  );
}
