"use client";

// Flipkart advertising KPIs for the selected dates, at the top of the Flipkart Overview (user,
// 12 Nov 2026: moved up from the old block lower down). Ads rows: loadMarketplaceAds("flipkart")
// — the daily ads upload, with the older campaign-performance upload for the days before it began,
// the same rows as the Overall page. Gross sales for TACOS: the "Sales, Orders & Returns" strip.

import { useQuery } from "@tanstack/react-query";
import { Megaphone } from "lucide-react";
import { useDashboard } from "@/lib/DashboardContext";
import { KPICard } from "@/components/KPICard";
import { QueryErrorState } from "@/components/QueryErrorState";
import { loadMarketplaceAds } from "@/lib/overallData";
import { fetchFlipkartOrderSummary, previousRange } from "@/lib/channelSummary";
import { DEFAULT_GST_MULTIPLIER } from "@/lib/masterProductSkuid";
import { adCampaigns, adDailySeries, adTotals, pct, ratio } from "@/lib/uploadedAmazonRules";
import { UnifiedTrendChart } from "@/components/TrendChart";
import { useBiDailySales } from "@/lib/useBiDailySales";

const cur = (v: number) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(v || 0))}`;
const num = (v: number) => new Intl.NumberFormat("en-IN").format(Math.round(v || 0));
const one = (v: number) => (Math.round(v * 10) / 10).toFixed(1);
const dot = (iso: string) => iso.split("-").reverse().join(".");
const dayLabel = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", { month: "short", day: "numeric" });
};
const growth = (a: number | null, b: number | null) => (a === null || b === null || b === 0 ? undefined : Math.round(((a - b) / b) * 1000) / 10);

export function FlipkartAdvertising() {
  const { startDate, endDate } = useDashboard();
  const ready = !!startDate && !!endDate;
  const prev = ready ? previousRange(startDate, endDate) : { start: "", end: "" };

  // Same query keys as the Overall page and the strip above, so these loads are shared.
  const adsQ = useQuery({
    queryKey: ["overall-ads", "flipkart", prev.start, endDate],
    queryFn: () => loadMarketplaceAds("flipkart", prev.start, endDate),
    enabled: ready,
  });
  const salesQ = useQuery({
    queryKey: ["channel-summary", "Flipkart", startDate, endDate],
    queryFn: () => fetchFlipkartOrderSummary(startDate, endDate),
    enabled: ready,
  });

  const totalByDay = useBiDailySales("flipkart");

  const rows = adsQ.data;
  const campaigns = rows ? adCampaigns(rows, startDate, endDate) : [];
  const chartData = rows ? adDailySeries(rows, startDate, endDate).map((d) => ({ ...d, overallSales: totalByDay.get(d.rawDate) ?? null, date: dayLabel(d.rawDate) })) : [];
  const now = rows ? adTotals(rows, startDate, endDate) : null;
  const before = rows ? adTotals(rows, prev.start, prev.end) : null;
  const firstAdDay = rows && rows.length ? rows.reduce((m, r) => (r.date.slice(0, 10) < m ? r.date.slice(0, 10) : m), "9999-12-31") : null;
  const adsShort = !!now?.through && endDate > now.through;
  const comparable = !!firstAdDay && firstAdDay <= prev.start && !adsShort;
  const trend = (a: number | null, b: number | null) => (comparable ? growth(a, b) : undefined);
  const roas = now ? ratio(now.sales, now.spend) : null;
  const acos = now ? pct(now.spend, now.sales) : null;
  const spendGst = now ? now.spend * DEFAULT_GST_MULTIPLIER : null;
  const gross = salesQ.data?.current.sales ?? null;
  const tacos = spendGst !== null && gross ? pct(spendGst, gross) : null;

  return (
    <div className="glass rounded-2xl border border-border p-5 shadow-sm space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2">
          <Megaphone className="w-3.5 h-3.5" aria-hidden="true" /> Advertising
        </h3>
        {ready && <span className="text-[11px] text-muted-foreground">{dot(startDate)} – {dot(endDate)}{comparable ? ` · vs ${dot(prev.start)} – ${dot(prev.end)}` : now ? " · no like-for-like previous period on file" : ""}</span>}
      </div>

      {(adsQ.isLoading || !ready) && (
        <div role="status" aria-label="Loading advertising figures" className="grid grid-cols-2 lg:grid-cols-5 gap-3 animate-pulse">
          {Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-24 rounded-2xl bg-muted" />)}
        </div>
      )}
      {adsQ.isError && (
        <QueryErrorState compact message="The Flipkart ads uploads could not be read. Nothing is shown rather than partial totals." onRetry={() => adsQ.refetch()} />
      )}
      {now && (
        <>
          {adsShort && (
            <p className="text-[11px] text-amber-700 dark:text-amber-400">Ads data is on file through {dot(now.through!)}; the later selected days are missing, not zero.</p>
          )}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <KPICard title="Ad Spend (incl. 18% GST)" value={cur(spendGst || 0)} subtitle={`${cur(now.spend)} before GST`} trend={trend(now.spend, before?.spend ?? null)} inverseTrend accent="pink" />
            <KPICard title="Ad Sales" value={cur(now.sales)} subtitle={`${num(now.orders)} ad orders`} trend={trend(now.sales, before?.sales ?? null)} accent="green" />
            <KPICard title="ROAS" value={roas === null ? "—" : `${roas.toFixed(2)}x`} subtitle="Ad sales ÷ ad spend" trend={trend(roas, before ? ratio(before.sales, before.spend) : null)} accent="purple" />
            <KPICard title="ACOS" value={acos === null ? "—" : `${one(acos)}%`} subtitle="Ad spend ÷ ad sales" trend={trend(acos, before ? pct(before.spend, before.sales) : null)} inverseTrend accent="orange" />
            <KPICard title="TACOS" value={tacos === null ? "—" : `${one(tacos)}%`} subtitle="Ad spend incl. GST ÷ gross sales" inverseTrend accent="cyan" />
          </div>

          <div className="h-[420px]">
            <UnifiedTrendChart data={chartData} currency="INR" height={360} />
          </div>

          <div>
            <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
              <h4 className="text-xs font-black uppercase tracking-widest text-muted-foreground">Campaigns by spend</h4>
              <span className="text-[11px] text-muted-foreground">{num(campaigns.length)} campaigns</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                    <th scope="col" className="py-2 pr-3 font-extrabold">Campaign</th>
                    <th scope="col" className="py-2 pr-3 font-extrabold text-right">Spend</th>
                    <th scope="col" className="py-2 pr-3 font-extrabold text-right">Ad sales</th>
                    <th scope="col" className="py-2 pr-3 font-extrabold text-right">Orders</th>
                    <th scope="col" className="py-2 pr-3 font-extrabold text-right">ACOS</th>
                    <th scope="col" className="py-2 font-extrabold text-right">ROAS</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {campaigns.slice(0, 15).map((c) => (
                    <tr key={c.name}>
                      <td className="py-2 pr-3 font-semibold text-foreground max-w-[320px] truncate" title={c.name}>{c.name}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{cur(c.spend)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{cur(c.sales)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{num(c.orders)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{c.acos === null ? <span className="text-muted-foreground">no sales</span> : `${one(c.acos)}%`}</td>
                      <td className="py-2 text-right tabular-nums">{c.roas === null ? <span className="text-muted-foreground">—</span> : `${one(c.roas)}x`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {campaigns.length > 15 && (
              <p className="text-[11px] text-muted-foreground mt-3">Showing the 15 largest by spend of {num(campaigns.length)}. Spend is before GST, as the Flipkart ads report shows it.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
