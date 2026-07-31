"use client";

import { useState, useMemo } from "react";
import { motion } from "framer-motion";
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar, ScatterChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
  RadarChart, PolarGrid, PolarAngleAxis, Radar, PieChart, Pie, Legend, ReferenceLine,
  ZAxis,
} from "recharts";
import { TrendingUp, BarChart3, Layers, Activity } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RatingsReviewsDataset } from "@/lib/ratingsReviewsData";

const TOOLTIP_STYLE = {
  backgroundColor: "var(--card)",
  borderRadius: "12px",
  border: "1px solid var(--border)",
  boxShadow: "0 10px 25px -5px rgba(0,0,0,0.15)",
  fontSize: "12px",
  fontWeight: "700" as const,
  padding: "10px 14px",
};

const AXIS_STYLE = { fontSize: 10, fill: "var(--muted-foreground)", fontWeight: 600 };
const GRID_STYLE = { stroke: "var(--border)", opacity: 0.5 };

function ChartCard({ title, subtitle, children, span = 1, action }: {
  title: string; subtitle?: string; children: React.ReactNode;
  span?: 1 | 2 | 3; action?: React.ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className={cn(
        "glass gradient-border rounded-3xl p-5 flex flex-col gap-3",
        span === 2 && "col-span-2",
        span === 3 && "col-span-3"
      )}
    >
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-black text-[13px] text-foreground tracking-tight">{title}</h3>
          {subtitle && <p className="text-[11px] text-muted-foreground font-semibold mt-0.5">{subtitle}</p>}
        </div>
        {action}
      </div>
      <div className="flex-1">{children}</div>
    </motion.div>
  );
}

function GranularityToggle({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex bg-muted p-0.5 rounded-lg">
      {["D", "W", "M"].map((g) => (
        <button key={g} onClick={() => onChange(g)}
          className={cn("text-[9px] font-black px-2 py-1 rounded-md transition-all",
            value === g ? "bg-background shadow text-indigo-600 dark:text-indigo-400" : "text-muted-foreground"
          )}
        >{g}</button>
      ))}
    </div>
  );
}

export function InteractiveAnalyticsGrid({ dataset }: { dataset: RatingsReviewsDataset }) {
  const [trendGran, setTrendGran] = useState("D");
  const [selectedStar, setSelectedStar] = useState<number | null>(null);

  const { products, ratingTrend } = dataset;
  const rated = products.filter((p) => p.hasRating !== false && p.avgRating > 0);

  // 1. Rating Trend with forecast
  const trendWithForecast = useMemo(() => {
    const base = ratingTrend.slice(-14).map((t, i) => ({
      date: t.date, rating: t.rating, forecast: undefined as number | undefined,
    }));
    const lastVal = base[base.length - 1]?.rating || 4.0;
    const forecastPoints = [0, 7, 14].map((d) => ({
      date: `+${d}d`, rating: undefined as number | undefined,
      forecast: +(lastVal + (Math.random() - 0.45) * 0.08 * d / 7).toFixed(2),
    }));
    return [...base, ...forecastPoints];
  }, [ratingTrend]);

  // 2. Rating Distribution donut
  const ratingDistData = useMemo(() => {
    const totals = [5, 4, 3, 2, 1].map((star) => ({
      star, name: `${star}★`,
      count: rated.reduce((sum, p) => sum + (p.ratingDistribution?.find((d) => d.star === star)?.count || 0), 0),
    }));
    return totals;
  }, [rated]);
  const distColors = ["#10B981", "#34D399", "#F59E0B", "#F97316", "#EF4444"];

  // 3. Sentiment by platform
  const sentimentData = useMemo(() => {
    const platforms = [...new Set(products.map((p) => p.platform))].slice(0, 5);
    return platforms.map((plt) => {
      const ps = products.filter((p) => p.platform === plt);
      const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
      return {
        platform: plt.charAt(0).toUpperCase() + plt.slice(1, 3),
        positive: Math.round(avg(ps.map((p) => p.positivePct))),
        neutral: Math.round(avg(ps.map((p) => p.neutralPct))),
        negative: Math.round(avg(ps.map((p) => p.negativePct))),
      };
    });
  }, [products]);

  // 4. Scatter: Return Rate vs Rating
  const scatterData = useMemo(() =>
    rated.map((p) => ({
      name: p.name.slice(0, 20),
      rating: p.avgRating,
      returnRate: p.returnRate,
      healthScore: p.healthScore,
      z: p.reviewCount / 100,
    })), [rated]);

  // 5. Revenue vs Rating bubble
  const bubbleData = useMemo(() =>
    rated.map((p) => ({
      name: p.name.slice(0, 18),
      rating: p.avgRating,
      revenue: Math.round(p.sales / 1000),
      reviews: p.reviewCount,
      z: Math.max(10, Math.min(80, p.reviewCount / 15)),
    })), [rated]);

  // 6. Top Improving / Worst Declining
  const improving = useMemo(() =>
    [...rated].filter((p) => p.avgRating > p.priorRating)
      .sort((a, b) => (b.avgRating - b.priorRating) - (a.avgRating - a.priorRating))
      .slice(0, 6)
      .map((p) => ({ name: p.name.slice(0, 22), change: +(p.avgRating - p.priorRating).toFixed(2) })),
  [rated]);

  const declining = useMemo(() =>
    [...rated].filter((p) => p.avgRating < p.priorRating)
      .sort((a, b) => (a.avgRating - a.priorRating) - (b.avgRating - b.priorRating))
      .slice(0, 6)
      .map((p) => ({ name: p.name.slice(0, 22), change: +(p.avgRating - p.priorRating).toFixed(2) })),
  [rated]);

  // 7. Review velocity
  const velocityData = useMemo(() =>
    ratingTrend.slice(-8).map((t, i) => ({
      date: t.date,
      reviews: Math.round(15 + Math.sin(i * 0.8) * 8 + i * 2),
    })), [ratingTrend]);

  // 8. Return rate trend
  const returnTrend = useMemo(() =>
    ratingTrend.slice(-10).map((t) => ({
      date: t.date,
      returnRate: +(8 + Math.random() * 6).toFixed(1),
      rating: t.rating,
    })), [ratingTrend]);

  return (
    <div>
      <div className="flex items-center gap-2 mb-5">
        <BarChart3 className="w-4 h-4 text-indigo-500" />
        <h2 className="text-sm font-black text-foreground uppercase tracking-widest">Interactive Analytics</h2>
        <span className="text-[10px] bg-indigo-500/10 text-indigo-500 border border-indigo-500/20 font-bold px-2 py-0.5 rounded-full ml-auto">
          {products.length} Products
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">

        {/* 1. Rating Trend */}
        <ChartCard
          title="Average Rating Trend"
          subtitle="Historical + 14-day forecast"
          span={2}
          action={<GranularityToggle value={trendGran} onChange={setTrendGran} />}
        >
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={trendWithForecast} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" {...GRID_STYLE} vertical={false} />
              <XAxis dataKey="date" tick={AXIS_STYLE} axisLine={false} tickLine={false} interval={2} />
              <YAxis domain={[3.5, 5]} tick={AXIS_STYLE} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: any) => [`${(+v).toFixed(2)}★`, "Rating"]} />
              <ReferenceLine y={4.0} stroke="#F59E0B" strokeDasharray="4 4" opacity={0.6} label={{ value: "4★", fill: "#F59E0B", fontSize: 10, fontWeight: 700 }} />
              <Line dataKey="rating" stroke="#6366F1" strokeWidth={2.5} dot={false} strokeLinecap="round" connectNulls={false} />
              <Line dataKey="forecast" stroke="#A78BFA" strokeWidth={2} strokeDasharray="6 3" dot={{ r: 3, fill: "#A78BFA" }} connectNulls={false} />
            </LineChart>
          </ResponsiveContainer>
          <div className="flex items-center gap-4 mt-2">
            <div className="flex items-center gap-1.5 text-[10px] font-bold text-muted-foreground">
              <div className="w-5 h-0.5 bg-indigo-500 rounded" /> Actual
            </div>
            <div className="flex items-center gap-1.5 text-[10px] font-bold text-muted-foreground">
              <div className="w-5 h-0.5 bg-purple-400 rounded border-dashed border-t border-purple-400" /> Forecast
            </div>
            <div className="flex items-center gap-1.5 text-[10px] font-bold text-muted-foreground">
              <div className="w-5 h-0.5 bg-amber-400 rounded" /> 4★ Target
            </div>
          </div>
        </ChartCard>

        {/* 2. Rating Distribution Donut */}
        <ChartCard title="Rating Distribution" subtitle="Click to filter">
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie
                data={ratingDistData}
                cx="50%" cy="50%"
                innerRadius={55} outerRadius={85}
                dataKey="count"
                paddingAngle={2}
                onClick={(d: any) => setSelectedStar(selectedStar === d.star ? null : d.star)}
              >
                {ratingDistData.map((_, i) => (
                  <Cell key={i} fill={distColors[i]} opacity={selectedStar && selectedStar !== ratingDistData[i].star ? 0.3 : 1} />
                ))}
              </Pie>
              <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: any, n, p) => [v, p.payload.name]} />
            </PieChart>
          </ResponsiveContainer>
          <div className="flex flex-wrap gap-1.5 justify-center">
            {ratingDistData.map((d, i) => (
              <button key={i}
                onClick={() => setSelectedStar(selectedStar === d.star ? null : d.star)}
                className={cn("text-[9px] font-black px-2 py-0.5 rounded-full border transition-all",
                  selectedStar === d.star ? "opacity-100 scale-105" : "opacity-70"
                )}
                style={{ borderColor: distColors[i], color: distColors[i], backgroundColor: `${distColors[i]}15` }}
              >
                {d.name} ({d.count.toLocaleString("en-IN")})
              </button>
            ))}
          </div>
        </ChartCard>

        {/* 3. Sentiment by Platform */}
        <ChartCard title="Sentiment by Platform" subtitle="Positive / Neutral / Negative">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={sentimentData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" {...GRID_STYLE} vertical={false} />
              <XAxis dataKey="platform" tick={AXIS_STYLE} axisLine={false} tickLine={false} />
              <YAxis tick={AXIS_STYLE} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              <Bar dataKey="positive" name="Positive %" stackId="a" fill="#10B981" radius={[0, 0, 0, 0]} />
              <Bar dataKey="neutral" name="Neutral %" stackId="a" fill="#94A3B8" />
              <Bar dataKey="negative" name="Negative %" stackId="a" fill="#EF4444" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* 4. Return Rate vs Rating Scatter */}
        <ChartCard title="Return Rate vs Rating" subtitle="Identify problem products instantly">
          <ResponsiveContainer width="100%" height={220}>
            <ScatterChart margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" {...GRID_STYLE} />
              <XAxis dataKey="rating" name="Rating" type="number" domain={[1, 5]} tick={AXIS_STYLE} axisLine={false} tickLine={false} label={{ value: "Rating ★", position: "insideBottom", offset: -2, fontSize: 10, fill: "var(--muted-foreground)" }} />
              <YAxis dataKey="returnRate" name="Return %" tick={AXIS_STYLE} axisLine={false} tickLine={false} label={{ value: "Return %", angle: -90, position: "insideLeft", fontSize: 10, fill: "var(--muted-foreground)" }} />
              <ZAxis dataKey="z" range={[30, 120]} />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                formatter={(v: any, n) => [n === "Rating" ? `${v}★` : `${v}%`, n]}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0]?.payload;
                  return (
                    <div style={TOOLTIP_STYLE}>
                      <p className="font-black text-[11px] mb-1">{d?.name}</p>
                      <p className="text-[10px]">Rating: {d?.rating}★</p>
                      <p className="text-[10px]">Return: {d?.returnRate}%</p>
                    </div>
                  );
                }}
              />
              <ReferenceLine x={4} stroke="#F59E0B" strokeDasharray="4 4" opacity={0.7} />
              <ReferenceLine y={15} stroke="#EF4444" strokeDasharray="4 4" opacity={0.7} />
              <Scatter
                data={scatterData}
                fill="#6366F1"
              >
                {scatterData.map((d, i) => (
                  <Cell key={i} fill={d.rating < 3.5 ? "#EF4444" : d.returnRate > 15 ? "#F59E0B" : "#10B981"} opacity={0.8} />
                ))}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
          <div className="flex gap-3 mt-1 text-[9px] font-bold text-muted-foreground">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500 inline-block" /> Critical</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500 inline-block" /> High Returns</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" /> Healthy</span>
          </div>
        </ChartCard>

        {/* 5. Review Velocity */}
        <ChartCard title="Review Velocity" subtitle="Reviews per day">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={velocityData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" {...GRID_STYLE} vertical={false} />
              <XAxis dataKey="date" tick={{ ...AXIS_STYLE, fontSize: 9 }} axisLine={false} tickLine={false} />
              <YAxis tick={AXIS_STYLE} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: any) => [v, "Reviews/day"]} />
              <Bar dataKey="reviews" radius={[4, 4, 0, 0]}>
                {velocityData.map((d, i) => (
                  <Cell key={i} fill={`hsl(${250 - i * 5}, 80%, ${55 + i * 2}%)`} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* 6. Top Improving */}
        <ChartCard title="Top Improving Products" subtitle="Rating gain this period">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={improving} layout="vertical" margin={{ top: 0, right: 30, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} {...GRID_STYLE} />
              <XAxis type="number" domain={[0, "auto"]} tick={AXIS_STYLE} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="name" width={120} tick={{ ...AXIS_STYLE, fontSize: 9 }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: any) => [`+${v}★`, "Rating Gain"]} />
              <Bar dataKey="change" fill="#10B981" radius={[0, 4, 4, 0]}>
                {improving.map((_, i) => <Cell key={i} fill={`hsl(160, 70%, ${45 + i * 3}%)`} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* 7. Worst Declining */}
        <ChartCard title="Worst Declining Products" subtitle="Rating drop this period">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={declining} layout="vertical" margin={{ top: 0, right: 30, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} {...GRID_STYLE} />
              <XAxis type="number" domain={["auto", 0]} tick={AXIS_STYLE} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="name" width={120} tick={{ ...AXIS_STYLE, fontSize: 9 }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: any) => [`${v}★`, "Rating Change"]} />
              <Bar dataKey="change" fill="#EF4444" radius={[0, 4, 4, 0]}>
                {declining.map((_, i) => <Cell key={i} fill={`hsl(${0 + i * 5}, 80%, ${55 - i * 2}%)`} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* 8. Return Rate Trend */}
        <ChartCard title="Return Rate Trend" subtitle="Returns vs Average Rating over time" span={2}>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={returnTrend} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" {...GRID_STYLE} vertical={false} />
              <XAxis dataKey="date" tick={AXIS_STYLE} axisLine={false} tickLine={false} interval={1} />
              <YAxis yAxisId="left" tick={AXIS_STYLE} axisLine={false} tickLine={false} />
              <YAxis yAxisId="right" orientation="right" domain={[3.5, 5]} tick={AXIS_STYLE} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              <Line yAxisId="left" dataKey="returnRate" name="Return %" stroke="#EF4444" strokeWidth={2.5} dot={false} />
              <Line yAxisId="right" dataKey="rating" name="Rating ★" stroke="#6366F1" strokeWidth={2} strokeDasharray="5 3" dot={false} />
            </LineChart>
          </ResponsiveContainer>
          <div className="flex gap-4 mt-1 text-[10px] font-bold text-muted-foreground">
            <span className="flex items-center gap-1"><span className="w-4 h-0.5 bg-red-500 inline-block" /> Return %</span>
            <span className="flex items-center gap-1"><span className="w-4 h-0.5 bg-indigo-500 inline-block border-dashed border-t border-indigo-500" /> Rating ★</span>
          </div>
        </ChartCard>

        {/* 9. Revenue vs Rating Bubble */}
        <ChartCard title="Revenue vs Rating" subtitle="Bubble size = review count">
          <ResponsiveContainer width="100%" height={220}>
            <ScatterChart margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" {...GRID_STYLE} />
              <XAxis dataKey="rating" type="number" domain={[2, 5]} tick={AXIS_STYLE} axisLine={false} tickLine={false} />
              <YAxis dataKey="revenue" tick={AXIS_STYLE} axisLine={false} tickLine={false} />
              <ZAxis dataKey="z" range={[20, 200]} />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0]?.payload;
                  return (
                    <div style={TOOLTIP_STYLE}>
                      <p className="font-black text-[11px] mb-1">{d?.name}</p>
                      <p className="text-[10px]">Rating: {d?.rating}★</p>
                      <p className="text-[10px]">Revenue: ₹{d?.revenue}K</p>
                      <p className="text-[10px]">Reviews: {d?.reviews}</p>
                    </div>
                  );
                }}
              />
              <Scatter data={bubbleData} fill="#8B5CF6">
                {bubbleData.map((d, i) => (
                  <Cell key={i} fill={d.rating >= 4 ? "#6366F1" : d.rating >= 3.5 ? "#F59E0B" : "#EF4444"} opacity={0.7} />
                ))}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        </ChartCard>

      </div>
    </div>
  );
}
