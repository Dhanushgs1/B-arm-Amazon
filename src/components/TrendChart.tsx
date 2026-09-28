"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Area,
  AreaChart,
  ComposedChart,
  Legend,
} from "recharts";
import { motion, useReducedMotion } from "framer-motion";

const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const;

/** Shared chart-card shell: the KPI cards' clean surface, fading up once as it arrives. */
function ChartCard({ className, children }: { className?: string; children: React.ReactNode }) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.2, duration: 0.6, ease: EASE_OUT_EXPO }}
      className={`premium-card rounded-2xl p-6 h-full flex flex-col ${className ?? ""}`}
    >
      {children}
    </motion.div>
  );
}

interface TrendChartProps {
  title: string;
  data: any[];
  dataKey: string;
  xAxisKey?: string;
  color?: string;
  type?: "line" | "area";
  height?: number;
  valuePrefix?: string;
}

export function TrendChart({
  title,
  data,
  dataKey,
  xAxisKey = "date",
  color = "#6D5EF8",
  type = "area",
  height = 240,
  valuePrefix = "",
}: TrendChartProps) {
  return (
    <ChartCard>
      <h3 className="text-[15px] font-bold mb-4 flex items-center gap-2 tracking-tight text-slate-800 dark:text-slate-100">
        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color, boxShadow: `0 0 0 4px ${color}1f` }} />
        {title}
      </h3>
      <div className="flex-1 w-full" style={{ minHeight: height }}>
        <ResponsiveContainer width="100%" height={height}>
          {type === "area" ? (
            <AreaChart data={data} margin={{ top: 5, right: 0, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id={`color-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={color} stopOpacity={0.45} />
                  <stop offset="95%" stopColor={color} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" opacity={0.5} />
              <XAxis
                dataKey={xAxisKey}
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                dy={10}
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                tickFormatter={(val) => `${valuePrefix}${val}`}
              />
              <Tooltip cursor={{ stroke: color, strokeWidth: 1, strokeDasharray: "4 4", opacity: 0.4 }}
                contentStyle={{
                  backgroundColor: "var(--card)",
                  borderRadius: "14px",
                  border: "1px solid var(--border)",
                  boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1)",
                  fontSize: "12px",
                  fontWeight: "bold",
                }}
                itemStyle={{ color: "var(--foreground)" }}
                formatter={(value: any) => [`${valuePrefix}${value}`, title]}
              />
              <Area
                type="monotone"
                dataKey={dataKey}
                stroke={color}
                strokeWidth={3}
                fillOpacity={1}
                fill={`url(#color-${dataKey})`}
                animationDuration={1500}
                animationEasing="ease-out"
              />
            </AreaChart>
          ) : (
            <LineChart data={data} margin={{ top: 5, right: 0, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" opacity={0.5} />
              <XAxis
                dataKey={xAxisKey}
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                dy={10}
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                tickFormatter={(val) => `${valuePrefix}${val}`}
              />
              <Tooltip cursor={{ stroke: color, strokeWidth: 1, strokeDasharray: "4 4", opacity: 0.4 }}
                contentStyle={{
                  backgroundColor: "var(--card)",
                  borderRadius: "14px",
                  border: "1px solid var(--border)",
                  boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1)",
                  fontSize: "12px",
                  fontWeight: "bold",
                }}
                itemStyle={{ color: "var(--foreground)" }}
                formatter={(value: any) => [`${valuePrefix}${value}`, title]}
              />
              <Line
                type="monotone"
                dataKey={dataKey}
                stroke={color}
                strokeWidth={3}
                dot={false}
                activeDot={{ r: 6, strokeWidth: 0, fill: color }}
                animationDuration={1500}
                animationEasing="ease-out"
              />
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}

interface UnifiedTrendChartProps {
  data: any[];
  currency?: string;
  height?: number;
}

export function UnifiedTrendChart({ data, currency = "INR", height = 320 }: UnifiedTrendChartProps) {
  const curPrefix = currency === "INR" ? "₹" : "$";

  return (
    <ChartCard>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-2">
        <h3 className="text-[15px] font-bold flex items-center gap-2 tracking-tight text-slate-800 dark:text-slate-100">
          <span className="w-2 h-2 rounded-full bg-indigo-500 shadow-[0_0_0_4px_rgba(99,102,241,0.12)]" />
          Unified Performance Trends
        </h3>
        <div className="flex items-center gap-4 text-[10px] font-extrabold uppercase tracking-wider text-slate-400">
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[#06B6D4]" /> Overall Sales</span>
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[#10B981]" /> Sales</span>
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[#3B82F6]" /> Spend</span>
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[#8B5CF6]" /> ROAS</span>
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[#F59E0B]" /> ACOS</span>
        </div>
      </div>

      {/* min-h-0 lets this flex child shrink to the card's remaining height so the
          chart fills the space instead of forcing a fixed pixel height that would
          overflow the card and collide with the section below it. */}
      <div className="flex-1 w-full min-h-0">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 10, right: -5, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" opacity={0.4} />
            <XAxis
              dataKey="date"
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 9, fill: "var(--muted-foreground)" }}
              dy={10}
              interval={data.length > 15 ? 1 : 0}
            />
            {/* Left Y-Axis for currency values (Sales, Spend) */}
            <YAxis
              yAxisId="currency"
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
              tickFormatter={(val) => {
                if (val >= 100000) return `${curPrefix}${(val / 1000).toFixed(0)}k`;
                return `${curPrefix}${val}`;
              }}
            />
            {/* Right Y-Axis for ratios/percentages (ROAS, ACOS) */}
            <YAxis
              yAxisId="ratio"
              orientation="right"
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
              tickFormatter={(val) => `${val}`}
            />
            <Tooltip
              cursor={{ stroke: "rgba(108, 99, 255, 0.2)", strokeWidth: 1, strokeDasharray: "4 4" }}
              contentStyle={{
                backgroundColor: "var(--card)",
                borderRadius: "16px",
                border: "1px solid var(--border)",
                boxShadow: "0 10px 25px -5px rgb(0 0 0 / 0.1)",
                fontSize: "12px",
                fontWeight: "bold",
                backdropFilter: "blur(10px)"
              }}
              formatter={(value: any, name: any) => {
                if (name === "Overall Sales" || name === "Sales" || name === "Spend") {
                  return [`${curPrefix}${new Intl.NumberFormat("en-IN").format(Math.round(value))}`, name];
                }
                if (name === "ROAS") {
                  return [`${value.toFixed(2)}x`, name];
                }
                if (name === "ACOS") {
                  return [`${value.toFixed(1)}%`, name];
                }
                return [value, name];
              }}
            />
            
            {/* Area for Sales (Left Axis) */}
            <defs>
              <linearGradient id="colorOverallSales" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#06B6D4" stopOpacity={0.2} />
                <stop offset="95%" stopColor="#06B6D4" stopOpacity={0.01} />
              </linearGradient>
              <linearGradient id="colorSales" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#10B981" stopOpacity={0.15} />
                <stop offset="95%" stopColor="#10B981" stopOpacity={0.01} />
              </linearGradient>
              <linearGradient id="colorSpend" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.15} />
                <stop offset="95%" stopColor="#3B82F6" stopOpacity={0.01} />
              </linearGradient>
            </defs>

            {/* Area for Overall Sales (Left Axis) — rendered first so it sits behind */}
            <Area
              yAxisId="currency"
              type="monotone"
              dataKey="overallSales"
              name="Overall Sales"
              stroke="#06B6D4"
              strokeWidth={2.5}
              fill="url(#colorOverallSales)"
              dot={data.length < 15 ? { r: 3, strokeWidth: 0, fill: "#06B6D4" } : false}
              activeDot={{ r: 6, strokeWidth: 0, fill: "#06B6D4" }}
            />

            {/* Area for Ad Sales (Left Axis) */}
            <Area
              yAxisId="currency"
              type="monotone"
              dataKey="sales"
              name="Sales"
              stroke="#10B981"
              strokeWidth={3}
              fill="url(#colorSales)"
              dot={data.length < 15 ? { r: 3, strokeWidth: 0, fill: "#10B981" } : false}
              activeDot={{ r: 6, strokeWidth: 0, fill: "#10B981" }}
            />
            
            {/* Area for Spend (Left Axis) */}
            <Area
              yAxisId="currency"
              type="monotone"
              dataKey="spend"
              name="Spend"
              stroke="#3B82F6"
              strokeWidth={2}
              fill="url(#colorSpend)"
              dot={data.length < 15 ? { r: 3, strokeWidth: 0, fill: "#3B82F6" } : false}
              activeDot={{ r: 5, strokeWidth: 0, fill: "#3B82F6" }}
            />
            
            {/* Line for ROAS (Right Axis) */}
            <Line
              yAxisId="ratio"
              type="monotone"
              dataKey="roas"
              name="ROAS"
              stroke="#8B5CF6"
              strokeWidth={2.5}
              dot={data.length < 15}
              activeDot={{ r: 5, strokeWidth: 0, fill: "#8B5CF6" }}
            />
            
            {/* Line for ACOS (Right Axis) */}
            <Line
              yAxisId="ratio"
              type="monotone"
              dataKey="acos"
              name="ACOS"
              stroke="#F59E0B"
              strokeWidth={2}
              strokeDasharray="4 4"
              dot={data.length < 15}
              activeDot={{ r: 5, strokeWidth: 0, fill: "#F59E0B" }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}
