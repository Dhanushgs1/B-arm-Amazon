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
import { axisTick } from "@/lib/axisTick";

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
                tickFormatter={(val) => axisTick(val, valuePrefix)}
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
                tickFormatter={(val) => axisTick(val, valuePrefix)}
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

// Daily ads trend: one rupee chart (ad sales, ad spend and, where the page has it, total sales) and
// one ACOS % chart under it, each with its own single scale. ROAS is in the tooltip. (Replaces a
// chart that put ₹ and ratios on two y-axes, which flattened ROAS to a line at zero.)
const SERIES = {
  overallSales: { label: "Total sales", color: "var(--series-forecast)" },
  sales: { label: "Ad sales", color: "var(--series-shopify)" },
  spend: { label: "Ad spend", color: "var(--series-amazon)" },
  acos: { label: "ACOS", color: "var(--series-flipkart)" },
} as const;

const tooltipStyle = {
  backgroundColor: "var(--card)",
  borderRadius: "12px",
  border: "1px solid var(--border)",
  boxShadow: "0 10px 25px -5px rgb(0 0 0 / 0.1)",
  fontSize: "12px",
  fontWeight: 600,
  color: "var(--foreground)",
};

export function UnifiedTrendChart({ data, currency = "INR" }: UnifiedTrendChartProps) {
  const curPrefix = currency === "INR" ? "₹" : "$";
  const money = (v: number) => `${curPrefix}${new Intl.NumberFormat("en-IN").format(Math.round(v))}`;
  const hasTotal = data.some((d) => typeof d?.overallSales === "number");
  const moneyKeys = (hasTotal ? ["overallSales", "sales", "spend"] : ["sales", "spend"]) as ("overallSales" | "sales" | "spend")[];
  const xAxis = (
    <XAxis
      dataKey="date"
      axisLine={false}
      tickLine={false}
      tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
      dy={6}
      interval="preserveStartEnd"
      minTickGap={18}
    />
  );
  const legendItem = (k: keyof typeof SERIES, dashed = false) => (
    <span key={k} className="flex items-center gap-1.5">
      <span className="inline-block w-4 h-0.5 rounded" style={{ background: dashed ? "transparent" : SERIES[k].color, borderTop: dashed ? `2px dashed ${SERIES[k].color}` : undefined }} />
      {SERIES[k].label}
    </span>
  );

  return (
    <ChartCard>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h3 className="text-[15px] font-bold flex items-center gap-2 tracking-tight text-slate-800 dark:text-slate-100">
          <span className="w-2 h-2 rounded-full bg-indigo-500 shadow-[0_0_0_4px_rgba(99,102,241,0.12)]" />
          Daily ad sales, spend and ACOS
        </h3>
        <div className="flex items-center gap-4 text-[11px] font-semibold text-muted-foreground flex-wrap">
          {moneyKeys.map((k) => legendItem(k))}
          {legendItem("acos")}
        </div>
      </div>

      {/* min-h-0 lets the charts share the card's remaining height instead of overflowing it */}
      <div className="flex-1 w-full min-h-0 flex flex-col gap-2">
        <div className="flex-[2] min-h-0">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} syncId="ads-trend" margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" opacity={0.5} />
              {xAxis}
              <YAxis axisLine={false} tickLine={false} width={52} tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} tickFormatter={(v) => axisTick(v, curPrefix)} />
              <Tooltip
                cursor={{ stroke: "var(--muted-foreground)", strokeWidth: 1, strokeDasharray: "4 4" }}
                contentStyle={tooltipStyle}
                formatter={(value: any, name: any) => [typeof value === "number" ? money(value) : "—", name]}
                labelFormatter={(label: any, payload: any) => {
                  const p = payload?.[0]?.payload;
                  const roas = p && typeof p.roas === "number" ? ` · ROAS ${p.roas.toFixed(2)}x` : "";
                  return `${label}${roas}`;
                }}
              />
              {moneyKeys.map((k) => (
                <Line key={k} type="monotone" dataKey={k} name={SERIES[k].label} stroke={SERIES[k].color} strokeWidth={2} dot={data.length < 15 ? { r: 4, strokeWidth: 0, fill: SERIES[k].color } : false} activeDot={{ r: 5, strokeWidth: 2, stroke: "var(--card)" }} connectNulls={false} isAnimationActive={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="flex-1 min-h-0">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} syncId="ads-trend" margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" opacity={0.5} />
              {xAxis}
              <YAxis axisLine={false} tickLine={false} width={52} tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} tickFormatter={(v) => `${v}%`} />
              <Tooltip
                cursor={{ stroke: "var(--muted-foreground)", strokeWidth: 1, strokeDasharray: "4 4" }}
                contentStyle={tooltipStyle}
                formatter={(value: any, name: any) => [typeof value === "number" ? `${value.toFixed(1)}%` : "—", name]}
              />
              <Line type="monotone" dataKey="acos" name="ACOS" stroke={SERIES.acos.color} strokeWidth={2} dot={data.length < 15 ? { r: 4, strokeWidth: 0, fill: SERIES.acos.color } : false} activeDot={{ r: 5, strokeWidth: 2, stroke: "var(--card)" }} connectNulls={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
      <p className="text-[10px] text-muted-foreground mt-2">ACOS = ad spend ÷ ad sales for the day. Days without an ads upload are left blank, not zero.</p>
    </ChartCard>
  );
}
