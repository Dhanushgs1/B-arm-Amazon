"use client";

import Link from "next/link";
import { useQueries } from "@tanstack/react-query";
import { Loader2, TrendingUp, TrendingDown, Minus, Sparkles } from "lucide-react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from "recharts";
import { useDashboard } from "@/lib/DashboardContext";
import { KPICard } from "@/components/KPICard";
import {
  fetchAmazonSummary,
  fetchFlipkartAllSummary,
  fetchMeeshoSummary,
  fetchBarmSummary,
  type ChannelSummary,
} from "@/lib/channelSummary";

const cur = (v: number) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(v || 0))}`;
const num = (v: number) => new Intl.NumberFormat("en-IN").format(Math.round(v || 0));
const growth = (now: number, before: number): number | undefined =>
  before > 0 ? Math.round(((now - before) / before) * 1000) / 10 : undefined;
const dot = (isoDate: string) => isoDate.split("-").reverse().join(".");

const CHANNELS = [
  { id: "amazon", label: "Amazon", color: "#FF9900", href: "/dashboard", fetcher: fetchAmazonSummary },
  { id: "flipkart", label: "Flipkart", color: "#2874F0", href: "/dashboard/flipkart", fetcher: fetchFlipkartAllSummary },
  { id: "meesho", label: "Meesho", color: "#9F2089", href: "/dashboard/meesho", fetcher: fetchMeeshoSummary },
  { id: "barm", label: "BARM", color: "#10B981", href: "/dashboard/barm", fetcher: fetchBarmSummary },
] as const;

function Growth({ v, inverse }: { v: number | undefined; inverse?: boolean }) {
  if (v === undefined) return <span className="text-muted-foreground">—</span>;
  const good = inverse ? v < 0 : v > 0;
  const Icon = v > 0 ? TrendingUp : v < 0 ? TrendingDown : Minus;
  return (
    <span className={`inline-flex items-center gap-1 font-bold ${v === 0 ? "text-muted-foreground" : good ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
      <Icon className="w-3 h-3" /> {v > 0 ? "+" : ""}{v.toFixed(1)}%
    </span>
  );
}

// Amazon, Flipkart, Meesho and BARM side by side for the selected dates vs the same-length period
// before — each channel's numbers come from the same loaders as its own Overview/weekly report.
export function AllMarketplacesSummary() {
  const { startDate, endDate } = useDashboard();
  const queries = useQueries({
    queries: CHANNELS.map((c) => ({
      queryKey: ["all-marketplaces", c.id, startDate, endDate],
      queryFn: () => c.fetcher(startDate, endDate),
      enabled: !!startDate && !!endDate,
    })),
  });
  const rows = CHANNELS.map((c, i) => ({ ...c, q: queries[i], s: queries[i].data as ChannelSummary | undefined }));
  const loaded = rows.filter((r) => r.s);
  const allLoaded = loaded.length === rows.length;

  const sum = (pick: (s: ChannelSummary["current"]) => number | null, which: "current" | "previous") =>
    loaded.reduce((t, r) => t + (pick(r.s![which]) || 0), 0);
  const totals = {
    sales: sum((s) => s.sales, "current"), salesPrev: sum((s) => s.sales, "previous"),
    units: sum((s) => s.units, "current"), unitsPrev: sum((s) => s.units, "previous"),
    orders: sum((s) => s.orders, "current"),
    returns: sum((s) => s.allReturns, "current"), returnsPrev: sum((s) => s.allReturns, "previous"),
    net: sum((s) => s.netOrders, "current"), netPrev: sum((s) => s.netOrders, "previous"),
    spend: sum((s) => s.adSpendTax, "current"), spendPrev: sum((s) => s.adSpendTax, "previous"),
  };
  const range = loaded[0]?.s;
  const best = [...loaded].sort((a, b) => (b.s!.current.sales || 0) - (a.s!.current.sales || 0))[0];

  const insights: string[] = [];
  if (allLoaded && totals.sales > 0) {
    const share = (r: (typeof loaded)[number]) => ((r.s!.current.sales || 0) / totals.sales) * 100;
    if (best) insights.push(`${best.label} is the biggest marketplace at ${cur(best.s!.current.sales || 0)} — ${share(best).toFixed(0)}% of all gross sales.`);
    const overall = growth(totals.sales, totals.salesPrev);
    if (overall !== undefined) insights.push(`All marketplaces together: ${cur(totals.sales)}, ${overall >= 0 ? "up" : "down"} ${Math.abs(overall).toFixed(1)}% vs the previous period (${cur(totals.salesPrev)}).`);
    const movers = loaded
      .map((r) => ({ r, g: growth(r.s!.current.sales || 0, r.s!.previous.sales || 0) }))
      .filter((x): x is { r: (typeof loaded)[number]; g: number } => x.g !== undefined);
    const up = movers.filter((x) => x.g > 0).sort((a, b) => b.g - a.g);
    const down = movers.filter((x) => x.g < 0).sort((a, b) => a.g - b.g);
    if (up.length) insights.push(`Growing: ${up.map((x) => `${x.r.label} (+${x.g.toFixed(1)}%)`).join(", ")}.`);
    if (down.length) insights.push(`Declining: ${down.map((x) => `${x.r.label} (${x.g.toFixed(1)}%)`).join(", ")}.`);
    const rr = loaded
      .filter((r) => r.s!.returnsTracked !== false && r.s!.current.units > 0)
      .map((r) => ({ r, v: (r.s!.current.allReturns / r.s!.current.units) * 100 }))
      .sort((a, b) => b.v - a.v);
    if (rr.length) insights.push(`Highest return rate: ${rr[0].r.label} — ${rr[0].v.toFixed(1)}% of units returned (${num(rr[0].r.s!.current.allReturns)} of ${num(rr[0].r.s!.current.units)}).`);
    const tacos = loaded
      .filter((r) => r.s!.current.adSpendTax !== null && (r.s!.current.sales || 0) > 0)
      .map((r) => ({ r, v: ((r.s!.current.adSpendTax || 0) / (r.s!.current.sales || 1)) * 100 }))
      .sort((a, b) => a.v - b.v);
    if (tacos.length > 1) insights.push(`Ad spend efficiency (ad spend ÷ gross sales): ${tacos.map((x) => `${x.r.label} ${x.v.toFixed(1)}%`).join(" · ")} — lowest is most efficient.`);
    const stale = loaded.filter((r) => r.s!.dataThrough && r.s!.dataThrough < r.s!.currentRange.end);
    if (stale.length) insights.push(`⚠ ${stale.map((r) => `${r.label} data only goes up to ${dot(r.s!.dataThrough!)}`).join("; ")} — its last days read as zero, so its growth looks lower than reality.`);
  }
  const chartData = allLoaded
    ? rows.map((r) => ({ name: r.label, "This period": Math.round(r.s!.current.sales || 0), "Previous period": Math.round(r.s!.previous.sales || 0) }))
    : [];

  return (
    <div className="glass rounded-2xl border border-border p-5 shadow-sm space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-sm font-black tracking-tight">All Marketplaces — Amazon · Flipkart · Meesho · BARM</h3>
          <p className="text-[11px] text-muted-foreground">
            Gross Sales = sales before returns, on the same basis for every marketplace, so the totals add up.
          </p>
        </div>
        {range && (
          <span className="text-[11px] text-muted-foreground">
            {dot(range.currentRange.start)} – {dot(range.currentRange.end)} · vs {dot(range.previousRange.start)} – {dot(range.previousRange.end)}
          </span>
        )}
      </div>

      {!allLoaded && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground rounded-xl border border-dashed border-border px-4 py-3">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading {rows.filter((r) => !r.s && !r.q.error).map((r) => r.label).join(", ") || "…"} ({loaded.length} of {rows.length} ready) — the combined totals appear once every marketplace has loaded. Amazon takes the longest.
        </div>
      )}

      {allLoaded && insights.length > 0 && (
        <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 px-4 py-3 space-y-1.5">
          <p className="text-[10px] font-black uppercase tracking-widest text-indigo-600 dark:text-indigo-300 flex items-center gap-1.5">
            <Sparkles className="w-3 h-3" /> Insights
          </p>
          {insights.map((t) => (
            <p key={t} className="text-xs text-foreground">• {t}</p>
          ))}
        </div>
      )}

      {allLoaded && (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
          <KPICard title="Total Gross Sales" value={cur(totals.sales)} subtitle={`Last period ${cur(totals.salesPrev)}`} trend={growth(totals.sales, totals.salesPrev)} accent="green" />
          <KPICard title="Orders" value={num(totals.units)} subtitle={`units · ${num(totals.orders)} orders`} trend={growth(totals.units, totals.unitsPrev)} accent="blue" />
          <KPICard title="Returns" value={num(totals.returns)} subtitle="BARM not tracked" trend={growth(totals.returns, totals.returnsPrev)} inverseTrend accent="orange" />
          <KPICard title="Net Orders" value={num(totals.net)} subtitle="Orders − Returns" trend={growth(totals.net, totals.netPrev)} accent="cyan" />
          <KPICard title="Ad Spend" value={cur(totals.spend)} subtitle={totals.sales > 0 ? `${((totals.spend / totals.sales) * 100).toFixed(1)}% of gross sales (TACOS)` : "incl. 18% GST"} trend={growth(totals.spend, totals.spendPrev)} inverseTrend accent="pink" />
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
              <th className="py-2 pr-3">Marketplace</th>
              <th className="py-2 pr-3 text-right">Gross Sales</th>
              <th className="py-2 pr-3 text-right">vs last</th>
              <th className="py-2 pr-3 w-32">Share</th>
              <th className="py-2 pr-3 text-right">Orders (units)</th>
              <th className="py-2 pr-3 text-right">Returns</th>
              <th className="py-2 pr-3 text-right">Net Orders</th>
              <th className="py-2 pr-3 text-right">Ad Spend</th>
              <th className="py-2 pr-3 text-right">Data up to</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const s = r.s;
              const share = s && totals.sales > 0 ? (s.current.sales || 0) / totals.sales : 0;
              return (
                <tr key={r.id} className="border-b border-border/60 last:border-0">
                  <td className="py-2.5 pr-3">
                    <Link href={r.href} className="inline-flex items-center gap-2 font-bold hover:underline">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ background: r.color }} /> {r.label}
                    </Link>
                  </td>
                  {!s ? (
                    <td colSpan={8} className="py-2.5 text-muted-foreground">
                      {r.q.error ? `Couldn't load — ${r.q.error instanceof Error ? r.q.error.message : String(r.q.error)}` : (
                        <span className="inline-flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> Loading…</span>
                      )}
                    </td>
                  ) : (
                    <>
                      <td className="py-2.5 pr-3 text-right font-bold">{cur(s.current.sales || 0)}</td>
                      <td className="py-2.5 pr-3 text-right"><Growth v={growth(s.current.sales || 0, s.previous.sales || 0)} /></td>
                      <td className="py-2.5 pr-3">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
                            <div className="h-full rounded-full" style={{ width: `${Math.round(share * 100)}%`, background: r.color }} />
                          </div>
                          <span className="w-8 text-right text-muted-foreground">{share > 0 && share < 0.01 ? "<1" : Math.round(share * 100)}%</span>
                        </div>
                      </td>
                      <td className="py-2.5 pr-3 text-right">{num(s.current.units)} <span className="text-muted-foreground">({num(s.current.orders)})</span></td>
                      <td className="py-2.5 pr-3 text-right">
                        {s.returnsTracked === false ? (
                          <span className="text-muted-foreground">Not tracked</span>
                        ) : (
                          <>{num(s.current.allReturns)} <span className="text-muted-foreground">({num(s.current.customerReturns)} cust.)</span></>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-right">{num(s.current.netOrders)}</td>
                      <td className="py-2.5 pr-3 text-right">{s.current.adSpendTax === null ? <span className="text-muted-foreground">No ads</span> : cur(s.current.adSpendTax)}</td>
                      <td className={`py-2.5 pr-3 text-right ${s.dataThrough && s.dataThrough < s.currentRange.end ? "text-amber-600 dark:text-amber-400 font-bold" : "text-muted-foreground"}`}>
                        {s.dataThrough ? dot(s.dataThrough) : "—"}
                      </td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {allLoaded && (
        <div>
          <h4 className="text-xs font-black uppercase tracking-widest text-muted-foreground mb-2">Gross Sales — this period vs previous</h4>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(148,163,184,0.25)" />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v: number) => (v >= 100000 ? `₹${(v / 100000).toFixed(1)}L` : `₹${Math.round(v / 1000)}k`)} width={56} />
                <Tooltip formatter={(v) => cur(Number(v))} cursor={{ fill: "rgba(99,102,241,0.06)" }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="Previous period" fill="#CBD5E1" radius={[4, 4, 0, 0]} />
                <Bar dataKey="This period" fill="#6366F1" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        Gross Sales basis — Amazon: order item prices · Flipkart: listing price × units (computed) · Meesho: Quantity × Supplier Listed Price · BARM: Order Total Amount once per order. Returns include courier RTO; BARM has no returns data. Ad Spend includes 18% GST. An amber &quot;Data up to&quot; date means that marketplace&apos;s data stops before the end of the selected range.
      </p>
    </div>
  );
}
