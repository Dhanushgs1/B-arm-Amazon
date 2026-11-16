"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useDashboard } from "@/lib/DashboardContext";
import { KPICard } from "@/components/KPICard";
import type { ChannelSummary } from "@/lib/channelSummary";
import { DEFAULT_GST_MULTIPLIER } from "@/lib/masterProductSkuid";
import { SourceBox } from "@/components/SourceBox";
import { OVERALL_SOURCES, type SourceBoxData, type SourceChannel, type SourceMetric, type SourcePart } from "@/lib/dataSources";

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
  adSpendBeforeGst = false,
  source,
}: {
  /** Which channel's entries in dataSources.ts describe these cards; with it, a card opens the "where is this from" box. */
  source?: SourceChannel;
  channel: string;
  fetcher: (start: string, end: string) => Promise<ChannelSummary>;
  title?: string;
  /** Show Ad Spend before GST (the page's advertising section shows it incl. GST). */
  adSpendBeforeGst?: boolean;
}) {
  const { startDate, endDate } = useDashboard();
  const { data, isLoading, error } = useQuery({
    queryKey: ["channel-summary", channel, startDate, endDate],
    queryFn: () => fetcher(startDate, endDate),
    enabled: !!startDate && !!endDate,
  });

  // "Where is this from": one part per figure the card is built from. The loader's own note for the
  // selected dates (which days are ERP figures) is shown inside the box only, not on the page.
  const [sourceBox, setSourceBox] = useState<SourceBoxData | null>(null);
  const opener = (title: string, value: string, metrics: [SourceMetric, string, string?][], formula?: string) => {
    if (!source || !data) return undefined;
    const parts: SourcePart[] = metrics.flatMap(([metric, label, v]) => {
      const info = OVERALL_SOURCES[source][metric];
      const fromOrders = metric !== "adSpend" && metric !== "adSales";
      return info ? [{ label, value: v, info, dataThrough: fromOrders ? data.dataThrough : undefined, note: fromOrders ? data.note : undefined }] : [];
    });
    if (!parts.length) return undefined;
    return () => setSourceBox({ title: `${channel} · ${title}`, value, formula, parts, start: data.currentRange.start, end: data.currentRange.end });
  };

  return (
    <div className="glass rounded-2xl border border-border p-5 shadow-sm space-y-4">
      <SourceBox data={sourceBox} onClose={() => setSourceBox(null)} />
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
                onClick={opener(data.salesLabel ?? "Sales", cur(data.current.sales), [["sales", "Sales"]])}
              />
            )}
            <KPICard
              title="Orders"
              value={num(data.current.units)}
              subtitle={`units · ${num(data.current.orders)} orders`}
              trend={growth(data.current.units, data.previous.units)}
              accent="blue"
              onClick={opener("Orders", `${num(data.current.units)} units · ${num(data.current.orders)} orders`, [["orders", "Orders"]])}
            />
            {data.returnsTracked === false ? (
              <KPICard title="Returns" value="Not tracked" subtitle="No returns data for this channel" accent="orange" />
            ) : (
              <KPICard
                title="Returns"
                value={num(data.current.allReturns)}
                subtitle={data.current.returnsValue !== undefined ? `${cur(data.current.returnsValue)} returned${data.current.sales ? ` · ${(Math.round((data.current.returnsValue / data.current.sales) * 1000) / 10).toFixed(1)}% of sales` : ""}` : `${num(data.current.customerReturns)} customer returns`}
                trend={growth(data.current.allReturns, data.previous.allReturns)}
                inverseTrend
                accent="orange"
                onClick={opener("Returns", `${num(data.current.allReturns)} units`, [["returns", "Returns"]])}
              />
            )}
            <KPICard
              title="Net Orders"
              value={num(data.current.netOrders)}
              subtitle={data.returnsTracked === false ? "Same as Orders (returns not tracked)" : "Orders − Returns"}
              trend={growth(data.current.netOrders, data.previous.netOrders)}
              accent="cyan"
              onClick={opener("Net Orders", num(data.current.netOrders), [["netOrders", "Net orders"]])}
            />
            {data.current.adSpendTax !== null ? (
              <KPICard
                title={adSpendBeforeGst ? "Ad Spend (before GST)" : "Ad Spend"}
                value={cur(adSpendBeforeGst ? data.current.adSpendTax / DEFAULT_GST_MULTIPLIER : data.current.adSpendTax)}
                subtitle={data.adSpendComparable === false ? "Ad data does not cover both periods in full" : `Last period ${cur(adSpendBeforeGst ? (data.previous.adSpendTax || 0) / DEFAULT_GST_MULTIPLIER : data.previous.adSpendTax || 0)}`}
                trend={data.adSpendComparable === false ? undefined : growth(data.current.adSpendTax, data.previous.adSpendTax || 0)}
                inverseTrend
                accent="pink"
                onClick={opener(adSpendBeforeGst ? "Ad Spend (before GST)" : "Ad Spend", cur(adSpendBeforeGst ? data.current.adSpendTax / DEFAULT_GST_MULTIPLIER : data.current.adSpendTax), [["adSpend", "Ad spend"]], adSpendBeforeGst ? "This card shows the spend before GST (the × 1.18 is not applied here)." : undefined)}
              />
            ) : data.current.sales !== null ? (
              <KPICard
                title="Avg Order Value"
                value={cur(data.current.orders ? data.current.sales / data.current.orders : 0)}
                subtitle="Sales ÷ orders"
                accent="purple"
                onClick={opener("Avg Order Value", cur(data.current.orders ? data.current.sales / data.current.orders : 0), [["sales", "Sales", cur(data.current.sales)], ["orders", "Orders", num(data.current.orders)]], "Sales ÷ orders.")}
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
          {!!data.current.unpricedUnits && (
            <p role="status" className="rounded-xl border border-amber-500/40 bg-amber-500/5 px-4 py-2.5 text-xs font-semibold text-amber-700 dark:text-amber-400">
              {num(data.current.unpricedUnits)} units across {num(data.current.unpricedSkus || 0)} product{data.current.unpricedSkus === 1 ? "" : "s"} have no listing price on file.
              They are counted in Orders but add ₹0 to {data.salesLabel ?? "Sales"}, so {data.salesLabel ?? "Sales"} is understated. Upload the current listings file to price them.
            </p>
          )}
          {/* the source note (data.note) is not shown here, by request (12 Nov 2026); only a data gap is flagged */}
          {data.dataThrough && data.dataThrough < data.currentRange.end && (
            <p className="text-[11px] text-muted-foreground">
              ⚠ Data only goes up to {dot(data.dataThrough)}, so the last {Math.round((Date.parse(data.currentRange.end) - Date.parse(data.dataThrough)) / 86_400_000)} day(s) of the selected range read as zero.
            </p>
          )}
        </>
      )}
    </div>
  );
}
