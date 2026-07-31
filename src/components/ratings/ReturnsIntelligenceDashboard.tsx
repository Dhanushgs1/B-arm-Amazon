"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";
import { RotateCcw, TrendingUp, TrendingDown, AlertTriangle, Package } from "lucide-react";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, PieChart, Pie, Legend
} from "recharts";
import { cn } from "@/lib/utils";
import type { RatingsReviewsDataset } from "@/lib/ratingsReviewsData";

const TOOLTIP_STYLE = {
  backgroundColor: "var(--card)",
  borderRadius: "12px",
  border: "1px solid var(--border)",
  fontSize: "11px",
  fontWeight: "700" as const,
  padding: "8px 12px",
};
const AXIS_STYLE = { fontSize: 10, fill: "var(--muted-foreground)", fontWeight: 600 };

const RETURN_REASON_COLORS = ["#EF4444", "#F97316", "#F59E0B", "#8B5CF6", "#06B6D4", "#6366F1"];

export function ReturnsIntelligenceDashboard({ dataset }: { dataset: RatingsReviewsDataset }) {
  const { products } = dataset;

  // Top Return Reasons aggregated
  const topReasons = useMemo(() => {
    const reasonMap = new Map<string, { count: number; revenue: number }>();
    products.forEach((p) => {
      p.returnReasons.forEach((r) => {
        const ex = reasonMap.get(r.reason) || { count: 0, revenue: 0 };
        const returnCount = Math.round((r.pct / 100) * p.totalReturns);
        reasonMap.set(r.reason, {
          count: ex.count + returnCount,
          revenue: ex.revenue + returnCount * (p.sales / Math.max(p.reviewCount, 1)),
        });
      });
    });
    return [...reasonMap.entries()]
      .map(([reason, { count, revenue }]) => ({ reason, count, revenue: Math.round(revenue) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
  }, [products]);

  // Top products by return rate
  const highReturnProducts = useMemo(() =>
    [...products]
      .filter((p) => p.returnRate > 0)
      .sort((a, b) => b.returnRate - a.returnRate)
      .slice(0, 8)
      .map((p) => ({ name: p.name.slice(0, 22), returnRate: p.returnRate, revenue: p.sales })),
  [products]);

  // Return trend (simulated trend from rating trend)
  const returnTrendData = useMemo(() => {
    const avgReturn = products.reduce((a, p) => a + p.returnRate, 0) / Math.max(products.length, 1);
    return Array.from({ length: 8 }, (_, i) => ({
      week: `W${i + 1}`,
      returnRate: +(avgReturn + Math.sin(i * 0.8) * 2).toFixed(1),
      revenueLoss: Math.round(avgReturn * 500 + Math.sin(i * 0.8) * 5000),
    }));
  }, [products]);

  // Return Reason Donut
  const reasonDonutData = topReasons.slice(0, 6).map((r, i) => ({
    name: r.reason,
    value: r.count,
    fill: RETURN_REASON_COLORS[i],
  }));

  const totalReturns = products.reduce((a, p) => a + p.totalReturns, 0);
  const totalRevenueLoss = products.reduce((a, p) => a + (p.estimatedRevenueLost || 0), 0);
  const avgReturnRate = products.filter((p) => p.returnRate > 0).reduce((a, p, _, arr) => a + p.returnRate / arr.length, 0);

  return (
    <div>
      <div className="flex items-center gap-2 mb-5">
        <RotateCcw className="w-4 h-4 text-red-500" />
        <h2 className="text-sm font-black text-foreground uppercase tracking-widest">Returns Intelligence</h2>
        <span className="ml-auto text-[10px] font-black text-red-600 dark:text-red-400 bg-red-500/10 border border-red-500/20 px-2 py-0.5 rounded-full">
          {totalReturns.toLocaleString("en-IN")} Total Returns
        </span>
      </div>

      {/* Summary KPIs */}
      <div className="grid grid-cols-3 gap-3 mb-5">
        {[
          { label: "Total Returns", value: totalReturns.toLocaleString("en-IN"), icon: RotateCcw, color: "#EF4444" },
          { label: "Avg Return Rate", value: `${avgReturnRate.toFixed(1)}%`, icon: AlertTriangle, color: "#F59E0B" },
          { label: "Revenue Lost", value: `₹${(totalRevenueLoss / 1000).toFixed(0)}K`, icon: TrendingDown, color: "#8B5CF6" },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="glass gradient-border rounded-2xl p-4 border border-border">
            <div className="flex items-center gap-2 mb-1">
              <Icon className="w-4 h-4" style={{ color }} />
              <span className="text-[10px] font-black uppercase tracking-wider text-muted-foreground">{label}</span>
            </div>
            <p className="text-xl font-black" style={{ color }}>{value}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">

        {/* Top Return Reasons Bar */}
        <div className="glass gradient-border rounded-3xl p-5">
          <h3 className="text-[11px] font-black uppercase tracking-wider text-muted-foreground mb-4">Top Return Reasons</h3>
          <div className="space-y-3">
            {topReasons.map((r, i) => {
              const max = topReasons[0]?.count || 1;
              const pct = Math.round((r.count / max) * 100);
              return (
                <div key={r.reason} className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-black text-foreground">{r.reason}</span>
                    <div className="flex items-center gap-3">
                      <span className="text-[10px] font-bold text-muted-foreground">{r.count} returns</span>
                      <span className="text-[10px] font-black text-red-500">₹{(r.revenue / 1000).toFixed(0)}K lost</span>
                    </div>
                  </div>
                  <div className="h-2 bg-muted rounded-full overflow-hidden">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${pct}%` }}
                      transition={{ duration: 0.6, delay: i * 0.08 }}
                      className="h-full rounded-full"
                      style={{ background: RETURN_REASON_COLORS[i] }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Return Rate by Product */}
        <div className="glass gradient-border rounded-3xl p-5">
          <h3 className="text-[11px] font-black uppercase tracking-wider text-muted-foreground mb-4">SKUs with Highest Return Rate</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={highReturnProducts} layout="vertical" margin={{ top: 0, right: 40, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--border)" opacity={0.5} />
              <XAxis type="number" tick={AXIS_STYLE} axisLine={false} tickLine={false} tickFormatter={(v) => `${v}%`} />
              <YAxis type="category" dataKey="name" width={110} tick={{ ...AXIS_STYLE, fontSize: 9 }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: any) => [`${(+v).toFixed(1)}%`, "Return Rate"]} />
              <Bar dataKey="returnRate" radius={[0, 4, 4, 0]}>
                {highReturnProducts.map((d, i) => (
                  <Cell key={i} fill={d.returnRate > 20 ? "#EF4444" : d.returnRate > 12 ? "#F59E0B" : "#10B981"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Return Trend */}
        <div className="glass gradient-border rounded-3xl p-5">
          <h3 className="text-[11px] font-black uppercase tracking-wider text-muted-foreground mb-4">Return Rate Trend</h3>
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={returnTrendData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.5} vertical={false} />
              <XAxis dataKey="week" tick={AXIS_STYLE} axisLine={false} tickLine={false} />
              <YAxis tick={AXIS_STYLE} axisLine={false} tickLine={false} tickFormatter={(v) => `${v}%`} />
              <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: any) => [`${(+v).toFixed(1)}%`, "Return Rate"]} />
              <Line dataKey="returnRate" stroke="#EF4444" strokeWidth={2.5} dot={{ r: 3, fill: "#EF4444" }} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Return Reason Distribution Donut */}
        <div className="glass gradient-border rounded-3xl p-5">
          <h3 className="text-[11px] font-black uppercase tracking-wider text-muted-foreground mb-4">Return Reason Distribution</h3>
          <ResponsiveContainer width="100%" height={160}>
            <PieChart>
              <Pie data={reasonDonutData} cx="50%" cy="50%" innerRadius={45} outerRadius={70} dataKey="value" paddingAngle={2}>
                {reasonDonutData.map((d, i) => <Cell key={i} fill={d.fill} />)}
              </Pie>
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              <Legend
                formatter={(v) => <span className="text-[9px] font-bold text-muted-foreground">{v}</span>}
                iconSize={8}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>

      </div>
    </div>
  );
}
