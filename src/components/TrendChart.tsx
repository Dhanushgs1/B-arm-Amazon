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
  Bar,
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

// Daily trend in one chart, every day marked. Total sales (bars, left ₹ scale) is ~40x the ad figures,
// so ad sales and ad spend have their own ₹ scale (right); ACOS and ROAS (dashed) are drawn to their
// own scales, with exact values in the tooltip. Total sales is drawn only when the page passes it.
const SERIES = {
  overallSales: { label: "Total sales", color: "var(--series-meesho)" },
  sales: { label: "Ad sales", color: "var(--series-shopify)" },
  spend: { label: "Ad spend", color: "var(--series-amazon)" },
  roas: { label: "ROAS", color: "var(--series-barm)" },
  acos: { label: "ACOS", color: "var(--series-flipkart)" },
} as const;
type SeriesKey = keyof typeof SERIES;

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
  const keys: SeriesKey[] = [...(hasTotal ? (["overallSales"] as const) : []), "sales", "spend", "roas", "acos"];
  const mark = (k: SeriesKey) => (data.length <= 62 ? { r: 2.5, strokeWidth: 0, fill: SERIES[k].color } : false);
  const line = (k: SeriesKey, axis: "ads" | "pct" | "roas", dashed = false) => (
    <Line
      key={k}
      yAxisId={axis}
      type="monotone"
      dataKey={k}
      name={SERIES[k].label}
      stroke={SERIES[k].color}
      strokeWidth={2}
      strokeDasharray={dashed ? "5 4" : undefined}
      dot={mark(k)}
      activeDot={{ r: 5, strokeWidth: 2, stroke: "var(--card)" }}
      connectNulls={false}
      isAnimationActive={false}
    />
  );

  return (
    <ChartCard>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h3 className="text-[15px] font-bold flex items-center gap-2 tracking-tight text-slate-800 dark:text-slate-100">
          <span className="w-2 h-2 rounded-full bg-indigo-500 shadow-[0_0_0_4px_rgba(99,102,241,0.12)]" />
          Daily sales, ad spend, ROAS and ACOS
        </h3>
        <div className="flex items-center gap-4 text-[11px] font-semibold text-muted-foreground flex-wrap">
          {keys.map((k) => (
            <span key={k} className="flex items-center gap-1.5">
              {k === "overallSales"
                ? <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: SERIES[k].color, opacity: 0.45 }} />
                : <span className="inline-block w-4" style={{ borderTop: `2px ${k === "roas" || k === "acos" ? "dashed" : "solid"} ${SERIES[k].color}` }} />}
              {SERIES[k].label}
            </span>
          ))}
        </div>
      </div>

      {/* min-h-0 lets the chart fill the card's remaining height instead of overflowing it */}
      <div className="flex-1 w-full min-h-0">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" opacity={0.5} />
            <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} dy={6} interval="preserveStartEnd" minTickGap={18} />
            <YAxis yAxisId="total" hide={!hasTotal} axisLine={false} tickLine={false} width={52} tick={{ fontSize: 10, fill: SERIES.overallSales.color }} tickFormatter={(v) => axisTick(v, curPrefix)} />
            <YAxis yAxisId="ads" orientation={hasTotal ? "right" : "left"} axisLine={false} tickLine={false} width={52} tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} tickFormatter={(v) => axisTick(v, curPrefix)} />
            <YAxis yAxisId="pct" hide domain={[0, "auto"]} />
            <YAxis yAxisId="roas" hide domain={[0, "auto"]} />
            <Tooltip
              cursor={{ stroke: "var(--muted-foreground)", strokeWidth: 1, strokeDasharray: "4 4" }}
              contentStyle={tooltipStyle}
              formatter={(value: any, name: any) => {
                if (typeof value !== "number") return ["—", name];
                if (name === SERIES.roas.label) return [`${value.toFixed(2)}x`, name];
                if (name === SERIES.acos.label) return [`${value.toFixed(1)}%`, name];
                return [money(value), name];
              }}
            />
            {hasTotal && <Bar yAxisId="total" dataKey="overallSales" name={SERIES.overallSales.label} fill={SERIES.overallSales.color} fillOpacity={0.28} radius={[3, 3, 0, 0]} maxBarSize={18} isAnimationActive={false} />}
            {line("sales", "ads")}
            {line("spend", "ads")}
            {line("roas", "roas", true)}
            {line("acos", "pct", true)}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="text-[10px] text-muted-foreground mt-2">
        {hasTotal ? "Bars: total sales (left ₹ scale). Lines: ad sales and ad spend before GST (right ₹ scale)." : "Ad sales and ad spend before GST (₹ scale)."} ROAS and ACOS (dashed) use their own scales — hover a day for every value. Days without an ads upload are left blank, not zero.
      </p>
    </ChartCard>
  );
}
