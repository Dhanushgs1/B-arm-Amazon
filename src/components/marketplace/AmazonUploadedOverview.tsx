"use client";

import { useQuery } from "@tanstack/react-query";
import { Megaphone } from "lucide-react";
import { useDashboard } from "@/lib/DashboardContext";
import { KPICard } from "@/components/KPICard";
import { UnifiedTrendChart } from "@/components/TrendChart";
import { QueryErrorState } from "@/components/QueryErrorState";
import { EmptyState } from "@/components/EmptyState";
import { UploadOnlyOverview } from "@/components/marketplace/UploadOnlyOverview";
import { ChannelSummaryStrip } from "@/components/marketplace/ChannelSummaryStrip";
import { fetchAmazonSummary, previousRange } from "@/lib/channelSummary";
import { DEFAULT_GST_MULTIPLIER } from "@/lib/masterProductSkuid";
import { loadMarketplaceAds } from "@/lib/overallData";
import { adCampaigns, adDailySeries, adTotals, pct, ratio } from "@/lib/uploadedAmazonRules";
import { fetchAllReportDataInfo, REPORT_LABEL, type UploadReportType } from "@/lib/amazonReportUpload";

// The Amazon Overview while SellerMate is switched off. Every figure comes from uploaded data, read
// through the SAME loaders the Overall page uses, so the two pages cannot disagree:
//   - sales, orders, returns, ad spend incl. GST: fetchAmazonSummary (the Weekly Sales Report rules)
//   - advertising detail: loadMarketplaceAds("amazon") (the ads card reports)
// A day with nothing uploaded is a gap in the chart and "—" on a card, never 0.

const cur = (v: number) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(v || 0))}`;
const num = (v: number) => new Intl.NumberFormat("en-IN").format(Math.round(v || 0));
const one = (v: number) => (Math.round(v * 10) / 10).toFixed(1);
const growth = (now: number | null, before: number | null): number | undefined =>
  now === null || before === null || before <= 0 ? undefined : Math.round(((now - before) / before) * 1000) / 10;
const dot = (iso: string) => iso.split("-").reverse().join(".");
const dayLabel = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", { month: "short", day: "numeric" });
};

const DATA_ON_FILE: UploadReportType[] = ["sp_advertised_product", "sb_campaign", "sd_campaign", "fba_inventory", "inventory_ledger", "price_listing"];

export function AmazonUploadedOverview() {
  const { startDate, endDate } = useDashboard();
  const ready = !!startDate && !!endDate;
  const prev = ready ? previousRange(startDate, endDate) : { start: "", end: "" };

  // Same query key and loader as the Overall page, so moving between the two reuses the cache.
  const adsQ = useQuery({
    queryKey: ["overall-ads", "amazon", prev.start, endDate],
    queryFn: () => loadMarketplaceAds("amazon", prev.start, endDate),
    enabled: ready,
  });
  const { data: info, isError: infoError } = useQuery({
    queryKey: ["amazon-report-data-info"],
    queryFn: fetchAllReportDataInfo,
  });

  const rows = adsQ.data;
  const now = rows ? adTotals(rows, startDate, endDate) : null;
  const before = rows ? adTotals(rows, prev.start, prev.end) : null;
  const basis = ready ? `vs ${dot(prev.start)} – ${dot(prev.end)}` : undefined;
  const roas = now ? ratio(now.sales, now.spend) : null;
  const acos = now ? pct(now.spend, now.sales) : null;
  const pRoas = before ? ratio(before.sales, before.spend) : null;
  const pAcos = before ? pct(before.spend, before.sales) : null;
  const campaigns = rows ? adCampaigns(rows, startDate, endDate) : [];
  const chartData = rows ? adDailySeries(rows, startDate, endDate).map((d) => ({ ...d, date: dayLabel(d.rawDate) })) : [];
  const adsShort = !!now?.through && endDate > now.through;
  // A change vs the previous period is only shown when both periods are fully covered by uploads.
  // If the uploads start part-way through the previous window, or stop before the end of this one,
  // the two totals cover different numbers of days and the percentage would mislead.
  const firstAdDay = rows && rows.length ? rows.reduce((m, r) => (r.date.slice(0, 10) < m ? r.date.slice(0, 10) : m), "9999-12-31") : null;
  const comparable = !!firstAdDay && firstAdDay <= prev.start && !adsShort;
  const trendOf = (a: number | null, b: number | null) => (comparable ? growth(a, b) : undefined);
  const trendBasis = comparable ? basis : undefined;

  const summary = (
    <div className="space-y-6">
      {/* ad spend is in the Advertising section below (before GST), so not repeated here */}
      <ChannelSummaryStrip channel="Amazon" fetcher={fetchAmazonSummary} title="Sales, orders and returns" hideAdSpend />

      <div className="glass rounded-2xl border border-border p-5 shadow-sm space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-xs font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2">
            <Megaphone className="w-3.5 h-3.5" aria-hidden="true" /> Advertising
          </h3>
          {ready && <span className="text-[11px] text-muted-foreground">{dot(startDate)} – {dot(endDate)}{comparable ? ` · ${basis}` : now ? " · no like-for-like previous period on file" : ""}</span>}
        </div>

        {(adsQ.isLoading || !ready) && (
          <div role="status" aria-label="Loading advertising figures" className="space-y-4 animate-pulse">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-24 rounded-2xl bg-muted" />)}
            </div>
            <div className="h-72 rounded-2xl bg-muted" />
          </div>
        )}

        {adsQ.isError && (
          <QueryErrorState
            compact
            message={`The uploaded Amazon ads data could not be read${adsQ.error instanceof Error ? ` (${adsQ.error.message})` : ""}. Nothing is shown rather than partial totals.`}
            onRetry={() => adsQ.refetch()}
          />
        )}

        {now && before && (
          now.through === null ? (
            <EmptyState compact title="No ads data for these dates" description="No Amazon ads rows are on file for the selected period. Pick dates inside the uploaded range, or upload the ads reports." />
          ) : (
            <>
              {adsShort && (
                <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-xs text-amber-700 dark:text-amber-400 font-semibold">
                  Ads data is on file through {dot(now.through)}; the selected dates run to {dot(endDate)}. The later days are missing, not zero, so the totals below cover fewer days than the sales above.
                </div>
              )}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <KPICard title="Ad Spend (incl. 18% GST)" value={cur(now.spend * DEFAULT_GST_MULTIPLIER)} subtitle={`${cur(now.spend)} before GST · ROAS and ACOS use this`} trend={trendOf(now.spend, before.spend)} trendBasis={trendBasis} inverseTrend accent="orange" />
                <KPICard title="Ad Sales" value={cur(now.sales)} subtitle={`${num(now.orders)} ad orders`} trend={trendOf(now.sales, before.sales)} trendBasis={trendBasis} accent="green" />
                <KPICard title="ROAS" value={roas === null ? "—" : `${one(roas)}x`} subtitle={roas === null ? "No ad spend in this period" : "Ad sales ÷ ad spend"} trend={trendOf(roas, pRoas)} trendBasis={trendBasis} accent="purple" />
                <KPICard title="ACOS" value={acos === null ? "—" : `${one(acos)}%`} subtitle={acos === null ? "No ad sales in this period" : "Ad spend ÷ ad sales"} trend={trendOf(acos, pAcos)} trendBasis={trendBasis} inverseTrend accent="pink" />
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
                  <p className="text-[11px] text-muted-foreground mt-3">Showing the 15 largest by spend of {num(campaigns.length)}. Every campaign is in the Historical Analysis Report on the Download page.</p>
                )}
              </div>
            </>
          )
        )}
      </div>
    </div>
  );

  return (
    <UploadOnlyOverview
      title="Amazon Overview"
      subtitle="Amazon · From your uploaded reports"
      uploadHref="/dashboard/upload"
      downloadHref="/dashboard/reports"
      summary={summary}
      dataOnFile={DATA_ON_FILE.map((type) => {
        const i = info?.[type];
        return {
          label: REPORT_LABEL[type],
          value: infoError
            ? "Couldn't check"
            : !i
            ? null
            : i.minDate
            ? `${i.minDate} to ${i.maxDate} (${i.rowCount.toLocaleString("en-IN")} rows)`
            : i.rowCount > 0
            ? `${i.rowCount.toLocaleString("en-IN")} rows`
            : "No data uploaded yet",
        };
      })}
    />
  );
}
