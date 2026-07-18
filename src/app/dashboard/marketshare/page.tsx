"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDashboard } from "@/lib/DashboardContext";
import { mcp } from "@/lib/api";
import { DataTable } from "@/components/DataTable";
import { KPICard } from "@/components/KPICard";
import { Loader2, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";

const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));
const pct = (val: number | null | undefined) => (val == null ? "—" : `${val.toFixed(1)}%`);

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const shareBadge = (val: number | null | undefined) => (
  <span className={cn(
    "px-2 py-0.5 rounded-full text-xs font-bold",
    val == null || val === 0 ? "text-muted-foreground"
      : val >= 30 ? "bg-green-500/10 text-green-700 dark:text-green-400"
      : val >= 10 ? "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400"
      : "bg-red-500/10 text-red-700 dark:text-red-400"
  )}>
    {pct(val)}
  </span>
);

export default function MarketSharePage() {
  const { keySlot, endDate, account, contextLoading, setSelectedAsin } = useDashboard();

  // SQP is a monthly report — default to the last full month before endDate
  const end = new Date(endDate);
  const defaultRef = new Date(end.getFullYear(), end.getMonth() - 1, 1);
  const [refMonth, setRefMonth] = useState<string>(`${defaultRef.getFullYear()}-${defaultRef.getMonth() + 1}`);
  const [year, month] = refMonth.split("-").map(Number);

  // Last 6 selectable months
  const monthOptions = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(end.getFullYear(), end.getMonth() - 1 - i, 1);
    return { value: `${d.getFullYear()}-${d.getMonth() + 1}`, label: `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}` };
  });

  const { data, isLoading } = useQuery({
    queryKey: ["sqp", keySlot, account?.id, refMonth],
    queryFn: async () => {
      const all: any[] = [];
      for (let page = 0; page < 5; page++) {
        const res = await mcp("get_sqp_report", {
          amazon_account_id: account?.id,
          workspace_id: account?.workspace_id,
          month,
          year,
          page,
          page_size: 200,
          sort_field: "searchQueryData.searchQueryVolume",
        }, keySlot);
        const rows = res.reports || [];
        all.push(...rows);
        if (rows.length < 200) break;
      }
      return all;
    },
    enabled: !!account,
  });

  const rows = (data || []).map((r: any) => ({
    searchQuery: r.searchQueryData?.searchQuery || "—",
    asin: r.asin,
    volume: r.searchQueryData?.searchQueryVolume || 0,
    score: r.searchQueryData?.searchQueryScore || 0,
    marketImpressions: r.impressionData?.totalQueryImpressionCount || 0,
    myImpressions: r.impressionData?.asinImpressionCount || 0,
    impressionShare: r.impressionData?.asinImpressionShare,
    marketClicks: r.clickData?.totalClickCount || 0,
    myClicks: r.clickData?.asinClickCount || 0,
    clickShare: r.clickData?.asinClickShare,
    cartAddShare: r.cartAddData?.asinCartAddShare,
    marketPurchases: r.purchaseData?.totalPurchaseCount || 0,
    myPurchases: r.purchaseData?.asinPurchaseCount || 0,
    purchaseShare: r.purchaseData?.asinPurchaseShare,
  }));

  // KPIs
  const totalQueries = new Set(rows.map((r: any) => r.searchQuery)).size;
  const totalMarketImpr = rows.reduce((a: number, r: any) => a + r.marketImpressions, 0);
  const totalMyImpr = rows.reduce((a: number, r: any) => a + r.myImpressions, 0);
  const weightedImprShare = totalMarketImpr ? (totalMyImpr / totalMarketImpr) * 100 : 0;
  const totalMarketPurch = rows.reduce((a: number, r: any) => a + r.marketPurchases, 0);
  const totalMyPurch = rows.reduce((a: number, r: any) => a + r.myPurchases, 0);
  const purchShare = totalMarketPurch ? (totalMyPurch / totalMarketPurch) * 100 : 0;

  // Opportunities: high volume but low impression share
  const opportunities = rows
    .filter((r: any) => r.volume > 50 && (r.impressionShare || 0) < 10)
    .sort((a: any, b: any) => b.volume - a.volume)
    .slice(0, 3);

  const columns = [
    {
      key: "searchQuery",
      label: "Search Query",
      sortable: true,
      render: (val: string) => <span className="font-semibold text-sm block min-w-[200px] max-w-[320px] whitespace-normal break-words">{val}</span>,
    },
    {
      key: "asin",
      label: "ASIN",
      sortable: true,
      render: (val: string) => (
        <button onClick={() => setSelectedAsin(val)} className="font-mono font-bold text-primary hover:underline text-xs focus:outline-none">
          {val || "—"}
        </button>
      ),
    },
    { key: "volume", label: "Search Volume", sortable: true, render: (v: number) => <span className="font-bold">{num(v)}</span> },
    { key: "impressionShare", label: "Impression Share", sortable: true, render: shareBadge },
    { key: "clickShare", label: "Click Share", sortable: true, render: shareBadge },
    { key: "cartAddShare", label: "Cart Add Share", sortable: true, render: shareBadge },
    { key: "purchaseShare", label: "Purchase Share", sortable: true, render: shareBadge },
    { key: "myImpressions", label: "My Impressions", sortable: true, render: (v: number) => num(v) },
    { key: "marketImpressions", label: "Market Impressions", sortable: true, render: (v: number) => num(v) },
    { key: "myPurchases", label: "My Purchases", sortable: true, render: (v: number) => num(v) },
    { key: "marketPurchases", label: "Market Purchases", sortable: true, render: (v: number) => num(v) },
    { key: "score", label: "Query Score", sortable: true, render: (v: number) => num(v) },
  ];

  return (
    <div className="space-y-6 pb-10">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight mb-0.5">Market Share (Search Query Performance)</h1>
          <p className="text-muted-foreground text-sm">
            {account?.name} · Amazon SQP monthly report — your share of the market&apos;s impressions, clicks & purchases per search query
          </p>
        </div>
        <select
          value={refMonth}
          onChange={(e) => setRefMonth(e.target.value)}
          className="bg-background border border-border rounded-xl px-3 py-2 text-sm font-bold focus:border-primary focus:outline-none"
        >
          {monthOptions.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </div>

      {contextLoading || isLoading ? (
        <div className="flex h-[400px] items-center justify-center text-muted-foreground flex-col gap-4 glass rounded-2xl border border-border">
          <Loader2 className="w-7 h-7 animate-spin text-primary" />
          <p className="font-semibold text-sm">{contextLoading ? "Connecting..." : "Loading SQP Report..."}</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="flex h-[300px] items-center justify-center text-muted-foreground glass rounded-2xl border border-border">
          <p className="font-semibold text-sm">No SQP data for {MONTH_NAMES[month - 1]} {year} — try an earlier month.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <KPICard title="Ranked Search Queries" value={num(totalQueries)} subtitle={`${MONTH_NAMES[month - 1]} ${year}`} delay={0.05} />
            <KPICard title="Impression Share" value={`${weightedImprShare.toFixed(1)}%`} subtitle="Your share of market impressions" delay={0.1} />
            <KPICard title="Purchase Share" value={`${purchShare.toFixed(1)}%`} subtitle={`${num(totalMyPurch)} of ${num(totalMarketPurch)} market purchases`} delay={0.15} />
            <KPICard title="Market Impressions" value={num(totalMarketImpr)} subtitle="Total demand across your queries" delay={0.2} />
          </div>

          {opportunities.length > 0 && (
            <div className="glass rounded-2xl border border-border p-5 shadow-sm space-y-3">
              <h3 className="font-bold text-sm flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-primary" /> Share-Growth Opportunities
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {opportunities.map((o: any) => (
                  <div key={o.searchQuery + o.asin} className="p-3 rounded-xl border border-indigo-200 dark:border-indigo-900 bg-indigo-50/50 dark:bg-indigo-950/20 text-xs">
                    <p className="font-bold text-indigo-800 dark:text-indigo-400">🎯 &quot;{o.searchQuery}&quot;</p>
                    <p className="text-muted-foreground mt-1 font-bold">Volume: {num(o.volume)} · Your impression share: {pct(o.impressionShare)}</p>
                    <p className="font-bold text-indigo-700 dark:text-indigo-500 mt-1.5">High demand, low visibility — target this query with exact-match campaigns.</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <DataTable data={rows} columns={columns} defaultSort="volume" exportName={`sqp-${year}-${month}`} />
        </>
      )}
    </div>
  );
}
