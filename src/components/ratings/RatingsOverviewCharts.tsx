"use client";

import { useMemo } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from "recharts";
import { TrendChart } from "@/components/TrendChart";
import type { RRProduct, RatingTrendPoint, CategoryInsight } from "@/lib/ratingsReviewsData";

function ratingColor(rating: number) {
  if (rating >= 4.2) return "#10B981";
  if (rating >= 3.5) return "#F59E0B";
  return "#EF4444";
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="glass gradient-border rounded-[22px] p-6 h-full flex flex-col">
      <h3 className="text-base font-extrabold mb-4 tracking-tight">{title}</h3>
      <div className="flex-1 w-full" style={{ minHeight: 260 }}>
        {children}
      </div>
    </div>
  );
}

const tooltipStyle = {
  backgroundColor: "var(--card)",
  borderRadius: "14px",
  border: "1px solid var(--border)",
  boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1)",
  fontSize: "12px",
  fontWeight: "bold" as const,
};

export function RatingByProductChart({ products }: { products: RRProduct[] }) {
  const data = useMemo(
    () => [...products].sort((a, b) => a.avgRating - b.avgRating).slice(0, 12).map((p) => ({ name: p.name.length > 18 ? p.name.slice(0, 18) + "…" : p.name, rating: p.avgRating, full: p.name })),
    [products]
  );
  return (
    <ChartCard title="Average Rating by Product (Lowest First)">
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={data} layout="vertical" margin={{ top: 5, right: 20, left: 10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--border)" opacity={0.5} />
          <XAxis type="number" domain={[0, 5]} tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
          <YAxis type="category" dataKey="name" width={140} tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v: any, _n, entry: any) => [`${v}★`, entry?.payload?.full || "Rating"]} />
          <Bar dataKey="rating" radius={[0, 6, 6, 0]}>
            {data.map((d, i) => <Cell key={i} fill={ratingColor(d.rating)} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export function RatingByCategoryChart({ categories }: { categories: CategoryInsight[] }) {
  const data = categories.map((c) => ({ name: c.category, rating: c.avgRating }));
  return (
    <ChartCard title="Average Rating by Category">
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={data} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" opacity={0.5} />
          <XAxis dataKey="name" tick={{ fontSize: 9, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} interval={0} angle={-15} textAnchor="end" height={50} />
          <YAxis domain={[0, 5]} tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => [`${v}★`, "Avg Rating"]} />
          <Bar dataKey="rating" radius={[6, 6, 0, 0]}>
            {data.map((d, i) => <Cell key={i} fill={ratingColor(d.rating)} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export function RatingTrendChart({ trend }: { trend: RatingTrendPoint[] }) {
  return <TrendChart title="Average Rating Trend" data={trend} dataKey="rating" color="#6D5EF8" type="line" height={260} />;
}

export function RatingDistributionChart({ products }: { products: RRProduct[] }) {
  const data = useMemo(() => {
    const totals = [5, 4, 3, 2, 1].map((star) => ({
      star: `${"★".repeat(star)}`,
      count: products.reduce((sum, p) => sum + (p.ratingDistribution.find((d) => d.star === star)?.count || 0), 0),
    }));
    return totals;
  }, [products]);

  const colors = ["#10B981", "#34D399", "#F59E0B", "#F97316", "#EF4444"];

  return (
    <ChartCard title="Rating Distribution">
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={data} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" opacity={0.5} />
          <XAxis dataKey="star" tick={{ fontSize: 13, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => [v, "Reviews"]} />
          <Bar dataKey="count" radius={[6, 6, 0, 0]}>
            {data.map((_, i) => <Cell key={i} fill={colors[i]} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
