"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useDashboard } from "@/lib/DashboardContext";
import { KPICard } from "@/components/KPICard";
import type { ChannelSummary } from "@/lib/channelSummary";

const cur = (v: number) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(v || 0))}`;
const num = (v: number) => new Intl.NumberFormat("en-IN").format(Math.round(v || 0));
const growth = (now: number, before: number): number | undefined =>
  before > 0 ? Math.round(((now - before) / before) * 1000) / 10 : undefined;
const dot = (isoDate: string) => isoDate.split("-").reverse().join(".");

// Short "selected dates vs the same-length period before" summary — Sales, Orders, Returns, Net
// Orders — shown at the top of a channel's Overview. Reads the dashboard's own date range.
export function ChannelSummaryStrip({
  channel,
  fetcher,
  title = "Summary",
}: {
  channel: string;
  fetcher: (start: string, end: string) => Promise<ChannelSummary>;
  title?: string;
}) {
  const { startDate, endDate } = useDashboard();
  const { data, isLoading, error } = useQuery({
    queryKey: ["channel-summary", channel, startDate, endDate],
    queryFn: () => fetcher(startDate, endDate),
    enabled: !!startDate && !!endDate,
  });

  return (
    <div className="glass rounded-2xl border border-border p-5 shadow-sm space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-black uppercase tracking-widest text-muted-foreground">{title}</h3>
        {data && (
          <span className="text-[11px] text-muted-foreground">
            {dot(data.currentRange.start)} – {dot(data.currentRange.end)} · vs {dot(data.previousRange.start)} – {dot(data.previousRange.end)}
          </span>
        )}
      </div>

      {(isLoading || (!data && !error)) && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-6 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading {channel} summary…
        </div>
      )}
      {error && (
        <p className="text-xs font-semibold text-red-600 dark:text-red-400">
          Couldn&apos;t load the summary — {error instanceof Error ? error.message : String(error)}
        </p>
      )}

      {data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
            {data.current.sales !== null && (
              <KPICard
                title={data.salesLabel ?? "Sales"}
                value={cur(data.current.sales)}
                subtitle={`Last period ${cur(data.previous.sales || 0)}`}
                trend={growth(data.current.sales, data.previous.sales || 0)}
                accent="green"
              />
            )}
            <KPICard
              title="Orders"
              value={num(data.current.units)}
              subtitle={`units · ${num(data.current.orders)} orders`}
              trend={growth(data.current.units, data.previous.units)}
              accent="blue"
            />
            {data.returnsTracked === false ? (
              <KPICard title="Returns" value="Not tracked" subtitle="No returns data for this channel" accent="orange" />
            ) : (
              <KPICard
                title="Returns"
                value={num(data.current.allReturns)}
                subtitle={`${num(data.current.customerReturns)} customer returns`}
                trend={growth(data.current.allReturns, data.previous.allReturns)}
                inverseTrend
                accent="orange"
              />
            )}
            <KPICard
              title="Net Orders"
              value={num(data.current.netOrders)}
              subtitle={data.returnsTracked === false ? "Same as Orders (returns not tracked)" : "Orders − Returns"}
              trend={growth(data.current.netOrders, data.previous.netOrders)}
              accent="cyan"
            />
            {data.current.adSpendTax !== null ? (
              <KPICard
                title="Ad Spend"
                value={cur(data.current.adSpendTax)}
                subtitle={`Last period ${cur(data.previous.adSpendTax || 0)}`}
                trend={growth(data.current.adSpendTax, data.previous.adSpendTax || 0)}
                inverseTrend
                accent="pink"
              />
            ) : data.current.sales !== null ? (
              <KPICard
                title="Avg Order Value"
                value={cur(data.current.orders ? data.current.sales / data.current.orders : 0)}
                subtitle="Sales ÷ orders"
                accent="purple"
              />
            ) : (
              <KPICard
                title="Return Rate"
                value={`${data.current.units ? ((data.current.allReturns / data.current.units) * 100).toFixed(1) : "0.0"}%`}
                subtitle="Returns ÷ Orders"
                accent="purple"
              />
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {data.note}
            {data.dataThrough && data.dataThrough < data.currentRange.end
              ? ` ⚠ Data only goes up to ${dot(data.dataThrough)}, so the last ${Math.round(
                  (Date.parse(data.currentRange.end) - Date.parse(data.dataThrough)) / 86_400_000
                )} day(s) of the selected range read as zero.`
              : ""}
          </p>
        </>
      )}
    </div>
  );
}
