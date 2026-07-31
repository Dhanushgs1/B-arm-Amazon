"use client";

import { motion } from "framer-motion";
import { ShieldAlert, AlertTriangle, TrendingDown, Star, RotateCcw, Bell, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RatingsReviewsDataset } from "@/lib/ratingsReviewsData";

interface Alert {
  id: string;
  type: "critical" | "warning" | "info" | "success";
  title: string;
  detail: string;
  time: string;
  icon: string;
}

const TYPE_STYLES = {
  critical: "border-red-200 dark:border-red-800 bg-red-50/60 dark:bg-red-950/20",
  warning: "border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/20",
  info: "border-blue-200 dark:border-blue-800 bg-blue-50/60 dark:bg-blue-950/20",
  success: "border-emerald-200 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/20",
};

const TYPE_ICON_STYLES = {
  critical: "text-red-500",
  warning: "text-amber-500",
  info: "text-blue-500",
  success: "text-emerald-500",
};

export function RiskCenter({ dataset }: { dataset: RatingsReviewsDataset }) {
  const { products } = dataset;

  const critical = products.filter((p) => p.healthScore < 40);
  const highReturn = products.filter((p) => p.returnRate > 18);
  const negativeSpike = products.filter((p) => p.negativePct > 30);
  const ratingDrop = products.filter((p) => p.priorRating > p.avgRating + 0.2);
  const totalRevRisk = products.reduce((a, p) => a + (p.estimatedRevenueLost || 0), 0);

  const alerts: Alert[] = [
    ...(critical.length > 0 ? [{
      id: "critical", type: "critical" as const,
      title: `${critical.length} products in Critical health`,
      detail: `${critical.map((p) => p.name.slice(0, 25)).join(", ")} — risk of buy-box suppression`,
      time: "Now", icon: "🔴",
    }] : []),
    ...(highReturn.length > 0 ? [{
      id: "highReturn", type: "warning" as const,
      title: `${highReturn.length} SKUs with return rate >18%`,
      detail: `Margin erosion from reverse logistics. Avg return rate: ${(highReturn.reduce((a, p) => a + p.returnRate, 0) / highReturn.length).toFixed(1)}%`,
      time: "1h ago", icon: "⚠️",
    }] : []),
    ...(negativeSpike.length > 0 ? [{
      id: "negativeSpike", type: "warning" as const,
      title: `${negativeSpike.length} products with >30% negative reviews`,
      detail: "Rising risk of algorithmic demotion in search ranking",
      time: "2h ago", icon: "📉",
    }] : []),
    ...(ratingDrop.length > 0 ? [{
      id: "ratingDrop", type: "critical" as const,
      title: `${ratingDrop.length} products with significant rating drop`,
      detail: `Average drop: ${(ratingDrop.reduce((a, p) => a + (p.priorRating - p.avgRating), 0) / ratingDrop.length).toFixed(2)}★ from prior period`,
      time: "3h ago", icon: "⭐",
    }] : []),
    {
      id: "revenueRisk", type: "info" as const,
      title: `₹${(totalRevRisk / 1000).toFixed(0)}K total revenue at risk`,
      detail: "Addressable through packaging improvements and quality fixes",
      time: "Now", icon: "💸",
    },
    {
      id: "tip", type: "success" as const,
      title: "3 products recovered this period",
      detail: "Rating improved ≥0.3★ — packaging updates showing positive impact",
      time: "Today", icon: "✅",
    },
  ];

  const riskMetrics = [
    {
      label: "Critical Products",
      value: critical.length,
      max: products.length,
      color: "#EF4444",
      icon: ShieldAlert,
      desc: "Below health threshold 40/100",
    },
    {
      label: "Revenue At Risk",
      value: Math.round(totalRevRisk / 1000),
      max: Math.round(totalRevRisk / 500),
      color: "#F59E0B",
      icon: TrendingDown,
      desc: "₹K estimated monthly loss",
      prefix: "₹", suffix: "K",
    },
    {
      label: "High Return SKUs",
      value: highReturn.length,
      max: products.length,
      color: "#8B5CF6",
      icon: RotateCcw,
      desc: "Return rate above 18%",
    },
    {
      label: "Negative Spike",
      value: negativeSpike.length,
      max: products.length,
      color: "#F97316",
      icon: AlertTriangle,
      desc: "Negative reviews >30%",
    },
  ];

  return (
    <div>
      <div className="flex items-center gap-2 mb-5">
        <ShieldAlert className="w-4 h-4 text-red-500" />
        <h2 className="text-sm font-black text-foreground uppercase tracking-widest">Risk Center</h2>
        {critical.length > 0 && (
          <span className="animate-pulse text-[10px] font-black text-red-600 dark:text-red-400 bg-red-500/10 border border-red-500/20 px-2 py-0.5 rounded-full">
            ● {critical.length} Critical
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">

        {/* Risk Gauge Cards */}
        <div>
          <p className="text-[10px] font-black uppercase tracking-wider text-muted-foreground mb-3">Risk Indicators</p>
          <div className="grid grid-cols-2 gap-3">
            {riskMetrics.map(({ label, value, max, color, icon: Icon, desc, prefix = "", suffix = "" }, i) => {
              const pct = Math.min(100, Math.round((value / Math.max(max, 1)) * 100));
              return (
                <motion.div
                  key={label}
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: i * 0.08 }}
                  className="glass gradient-border rounded-2xl p-4"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <Icon className="w-4 h-4" style={{ color }} />
                    <span className="text-[10px] font-black uppercase tracking-wider text-muted-foreground">{label}</span>
                  </div>
                  <p className="text-2xl font-black mb-1" style={{ color }}>
                    {prefix}{value.toLocaleString("en-IN")}{suffix}
                  </p>
                  <div className="h-1.5 bg-muted rounded-full overflow-hidden mb-1">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${pct}%` }}
                      transition={{ duration: 0.8, delay: i * 0.1 + 0.2 }}
                      className="h-full rounded-full"
                      style={{ background: color }}
                    />
                  </div>
                  <p className="text-[9px] font-semibold text-muted-foreground">{desc}</p>
                </motion.div>
              );
            })}
          </div>
        </div>

        {/* AI Alerts Feed */}
        <div>
          <p className="text-[10px] font-black uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
            <Bell className="w-3 h-3" /> AI Alerts
          </p>
          <div className="space-y-2 max-h-[340px] overflow-y-auto custom-scrollbar pr-1">
            {alerts.map((alert, i) => (
              <motion.div
                key={alert.id}
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.08 }}
                className={cn("flex items-start gap-3 p-3.5 rounded-2xl border", TYPE_STYLES[alert.type])}
              >
                <span className="text-lg flex-shrink-0 mt-0.5">{alert.icon}</span>
                <div className="flex-1 min-w-0">
                  <p className={cn("text-[12px] font-black", TYPE_ICON_STYLES[alert.type])}>{alert.title}</p>
                  <p className="text-[11px] font-semibold text-muted-foreground mt-0.5 leading-relaxed">{alert.detail}</p>
                </div>
                <span className="text-[9px] font-bold text-muted-foreground flex-shrink-0">{alert.time}</span>
              </motion.div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}
