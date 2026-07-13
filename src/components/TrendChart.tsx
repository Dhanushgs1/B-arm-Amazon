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
} from "recharts";
import { cn } from "@/lib/utils";

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
  color = "#4f46e5",
  type = "area",
  height = 240,
  valuePrefix = "",
}: TrendChartProps) {
  return (
    <div className="glass rounded-2xl p-5 shadow-sm border border-border h-full flex flex-col">
      <h3 className="text-sm font-bold mb-4 flex items-center justify-between">
        {title}
      </h3>
      <div className="flex-1 w-full" style={{ minHeight: height }}>
        <ResponsiveContainer width="100%" height="100%">
          {type === "area" ? (
            <AreaChart data={data} margin={{ top: 5, right: 0, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id={`color-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={color} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={color} stopOpacity={0} />
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
              <Tooltip
                contentStyle={{
                  backgroundColor: "var(--card)",
                  borderRadius: "12px",
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
              <Tooltip
                contentStyle={{
                  backgroundColor: "var(--card)",
                  borderRadius: "12px",
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
    </div>
  );
}
