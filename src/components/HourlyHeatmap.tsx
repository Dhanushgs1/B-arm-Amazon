"use client";

import { useQuery } from "@tanstack/react-query";
import { useDashboard } from "@/lib/DashboardContext";
import { mcp } from "@/lib/api";
import { Clock, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMemo } from "react";

const cur = (val: number, currency?: string) => {
  const sym = currency === "INR" ? "₹" : "$";
  if (!val) return `${sym}0`;
  return sym + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val));
};

// Format hour number (0-23) to readable 12h label
const hourLabel = (h: number) => {
  const hh = ((h % 24) + 24) % 24;
  if (hh === 0) return "12 AM";
  if (hh < 12) return `${hh} AM`;
  if (hh === 12) return "12 PM";
  return `${hh - 12} PM`;
};

// Short label for X-axis (compact)
const hourShort = (h: number) => {
  const hh = ((h % 24) + 24) % 24;
  if (hh === 0) return "12a";
  if (hh < 12) return `${hh}a`;
  if (hh === 12) return "12p";
  return `${hh - 12}p`;
};

// Hour-of-day spend vs sales pattern (from get_hourly_performance), for dayparting decisions.
export function HourlyHeatmap() {
  const { keySlot, startDate, endDate, account } = useDashboard();
  const currency = account?.currency;

  // Browser's timezone offset: converts UTC hours → local hours.
  // getTimezoneOffset() returns minutes behind UTC (IST = -330), so
  // local = UTC + round(330/60) = UTC + 6 (close enough for hour buckets).
  const tzOffsetHours = useMemo(() => Math.round(-new Date().getTimezoneOffset() / 60), []);

  const { data, isLoading } = useQuery({
    queryKey: ["hourly", keySlot, account?.id, startDate, endDate],
    queryFn: async () => {
      const res = await mcp("get_hourly_performance", {
        amazon_account_id: account?.id,
        workspace_id: account?.workspace_id,
        level: "campaign",
        group_by: ["hour"],
        start_date: startDate,
        end_date: endDate,
      }, keySlot);
      return (res.rows || []).filter((r: any) => r.hour != null);
    },
    enabled: !!account,
  });

  const rawRows: any[] = data || [];

  // Convert UTC hours to local timezone and build 24-hour array
  const rows = useMemo(() => {
    // Aggregate raw rows by UTC hour first (in case of duplicates)
    const utcMap = new Map<number, { sales: number; cost: number; impressions: number; clicks: number; orders: number }>();
    for (const r of rawRows) {
      const h = Number(r.hour);
      const existing = utcMap.get(h);
      if (existing) {
        existing.sales += r.sales || 0;
        existing.cost += r.cost || 0;
        existing.impressions += r.impressions || 0;
        existing.clicks += r.clicks || 0;
        existing.orders += r.orders || 0;
      } else {
        utcMap.set(h, {
          sales: r.sales || 0,
          cost: r.cost || 0,
          impressions: r.impressions || 0,
          clicks: r.clicks || 0,
          orders: r.orders || 0,
        });
      }
    }

    // Now map UTC hours to local timezone hours
    const localMap = new Map<number, { sales: number; cost: number; impressions: number; clicks: number; orders: number }>();
    for (const [utcHour, d] of utcMap) {
      const localHour = ((utcHour + tzOffsetHours) % 24 + 24) % 24;
      const existing = localMap.get(localHour);
      if (existing) {
        existing.sales += d.sales;
        existing.cost += d.cost;
        existing.impressions += d.impressions;
        existing.clicks += d.clicks;
        existing.orders += d.orders;
      } else {
        localMap.set(localHour, { ...d });
      }
    }

    // Fill all 24 local hours, compute ROAS/ACOS
    return Array.from({ length: 24 }, (_, h) => {
      const d = localMap.get(h) || { sales: 0, cost: 0, impressions: 0, clicks: 0, orders: 0 };
      return {
        hour: h,
        ...d,
        roas: d.cost > 0 ? d.sales / d.cost : 0,
        acos: d.sales > 0 ? (d.cost / d.sales) * 100 : 0,
      };
    });
  }, [rawRows, tzOffsetHours]);

  if (isLoading) {
    return (
      <div className="glass rounded-2xl border border-border p-5 shadow-sm h-[280px] flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }
  if (rawRows.length === 0) return null;

  const maxSales = Math.max(...rows.map((r) => r.sales), 1);
  const maxCost = Math.max(...rows.map((r) => r.cost), 1);

  // Best hour: highest ROAS among hours with meaningful spend; worst: highest ACOS with spend
  const totalSpend = rows.reduce((a, r) => a + r.cost, 0);
  const spendThreshold = totalSpend / rows.length / 2;
  const active = rows.filter((r) => r.cost > spendThreshold);
  const bestHour = active.length > 0 ? [...active].sort((a, b) => b.roas - a.roas)[0] : null;
  const worstHour = active.length > 0 ? [...active].sort((a, b) => b.acos - a.acos)[0] : null;
  const peakSalesHour = [...rows].sort((a, b) => b.sales - a.sales)[0];

  // Timezone label for transparency
  const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <div className="glass rounded-2xl border border-border p-5 shadow-sm">
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center"><Clock className="w-4 h-4 text-primary" /></div>
        <h3 className="font-bold text-sm">Hourly Performance (Dayparting)</h3>
        <span className="text-xs text-muted-foreground">spend vs sales by hour of day · {tzName}</span>
        <div className="ml-auto flex items-center gap-3 text-[10px] font-bold">
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-indigo-500" /> Spend</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-500" /> Sales</span>
        </div>
      </div>

      <div className="flex items-end gap-[3px] h-[150px] mt-4">
        {rows.map((r) => {
          const isBest = bestHour && r.hour === bestHour.hour;
          const isWorst = worstHour && r.hour === worstHour.hour;
          return (
            <div key={r.hour} className="flex-1 flex flex-col justify-end h-full group relative">
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2.5 py-1.5 bg-slate-900 text-white text-[10px] font-bold rounded-lg opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity whitespace-nowrap z-20 shadow-lg">
                {hourLabel(r.hour)} · Spend {cur(r.cost, currency)} · Sales {cur(r.sales, currency)}
                {r.roas > 0 && <> · ROAS {r.roas.toFixed(2)}x</>}
                {r.acos > 0 && <> · ACOS {r.acos.toFixed(1)}%</>}
              </div>
              <div className="flex items-end gap-[1px] h-full">
                <div
                  className="flex-1 rounded-t-sm bg-indigo-500/80 group-hover:bg-indigo-500 transition-colors"
                  style={{ height: `${Math.max(2, (r.cost / maxCost) * 100)}%` }}
                />
                <div
                  className={cn(
                    "flex-1 rounded-t-sm transition-colors",
                    isBest ? "bg-emerald-400 ring-1 ring-emerald-300" : isWorst ? "bg-red-400/80" : "bg-emerald-500/80 group-hover:bg-emerald-500"
                  )}
                  style={{ height: `${Math.max(2, (r.sales / maxSales) * 100)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex gap-[3px] mt-1">
        {rows.map((r) => (
          <div key={r.hour} className="flex-1 text-center text-[8px] font-bold text-muted-foreground">
            {r.hour % 3 === 0 ? hourShort(r.hour) : ""}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-4 text-[11px]">
        {bestHour && (
          <div className="p-2.5 rounded-xl bg-emerald-500/5 border border-emerald-500/20">
            <p className="font-black text-emerald-600 dark:text-emerald-400">🚀 Best hour: {hourLabel(bestHour.hour)}</p>
            <p className="text-muted-foreground font-semibold mt-0.5">ROAS {bestHour.roas.toFixed(2)}x — raise bids / budget here</p>
          </div>
        )}
        {worstHour && (
          <div className="p-2.5 rounded-xl bg-red-500/5 border border-red-500/20">
            <p className="font-black text-red-600 dark:text-red-400">⚠️ Costly hour: {hourLabel(worstHour.hour)}</p>
            <p className="text-muted-foreground font-semibold mt-0.5">ACOS {worstHour.acos.toFixed(1)}% — consider bid down / dayparting</p>
          </div>
        )}
        {peakSalesHour && peakSalesHour.sales > 0 && (
          <div className="p-2.5 rounded-xl bg-indigo-500/5 border border-indigo-500/20">
            <p className="font-black text-indigo-600 dark:text-indigo-400">📈 Peak sales: {hourLabel(peakSalesHour.hour)}</p>
            <p className="text-muted-foreground font-semibold mt-0.5">{cur(peakSalesHour.sales, currency)} sales in this hour window</p>
          </div>
        )}
      </div>
    </div>
  );
}
