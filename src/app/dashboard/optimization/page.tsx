"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDashboard } from "@/lib/DashboardContext";
import { mcp, mcpAllNegatives, mcpAllPages } from "@/lib/api";
import { DataTable } from "@/components/DataTable";
import { KPICard } from "@/components/KPICard";
import { PageHero } from "@/components/PageHero";
import { QueryErrorState } from "@/components/QueryErrorState";
import { HourlyHeatmap } from "@/components/HourlyHeatmap";
import { Loader2, Ban, Tag as TagIcon, CalendarClock, Sparkles, TrendingDown, Rocket, Moon, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

const cur = (val: number, currency?: string) => {
  const sym = currency === "INR" ? "₹" : "$";
  if (!val) return `${sym}0`;
  return sym + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val));
};
const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));

const stateBadge = (val: string) => {
  const v = (val || "").toUpperCase();
  return (
    <span className={cn(
      "px-2.5 py-0.5 rounded-full text-xs font-bold uppercase border",
      v === "ENABLED"
        ? "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-400 border-green-200 dark:border-green-900"
        : v === "PAUSED"
          ? "bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-400 border-yellow-200 dark:border-yellow-900"
          : "bg-muted text-muted-foreground border-border"
    )}>
      {v || "—"}
    </span>
  );
};

export default function OptimizationPage() {
  const { keySlot, startDate, endDate, account, contextLoading } = useDashboard();
  const currency = account?.currency;
  const [expandedAction, setExpandedAction] = useState<string | null>(null);

  const baseArgs = {
    amazon_account_id: account?.id,
    workspace_id: account?.workspace_id,
  };

  // Account-wide benchmark (whole marketplace, this date range).
  const { data: summary } = useQuery({
    queryKey: ["mkt_summary", keySlot, account?.id, startDate, endDate],
    queryFn: () => mcp("get_marketplace_summary", {
      workspace_id: account?.workspace_id,
      start_date: startDate,
      end_date: endDate,
    }, keySlot),
    enabled: !!account,
  });

  // Full negatives inventory.
  const { data: negatives, isLoading: negLoading, isError: negError, refetch: refetchNegatives } = useQuery({
    queryKey: ["negatives", keySlot, account?.id],
    queryFn: () => mcpAllNegatives(baseArgs, keySlot),
    enabled: !!account,
  });

  // Campaign id -> name map (negatives only carry ids).
  const { data: campaigns } = useQuery({
    queryKey: ["opt_campaigns", keySlot, account?.id],
    queryFn: () => mcp("list_campaigns", { ...baseArgs, page_size: 500 }, keySlot),
    enabled: !!account,
  });

  // Dayparting schedules (bid + placement types).
  const { data: daypartings } = useQuery({
    queryKey: ["daypartings", keySlot, account?.id],
    queryFn: async () => {
      const results = await Promise.all(
        ["bid", "placement"].map((type) =>
          mcp("list_daypartings", { ...baseArgs, type }, keySlot)
            .then((r) => (r.daypartings || []).map((d: any) => ({ ...d, type })))
            .catch(() => [])
        )
      );
      return results.flat();
    },
    enabled: !!account,
  });

  // Tags across data types.
  const { data: tags } = useQuery({
    queryKey: ["tags", keySlot, account?.id],
    queryFn: async () => {
      const results = await Promise.all(
        ["campaign", "targeting", "product", "search_term"].map((data_type) =>
          mcp("get_tags", { ...baseArgs, data_type }, keySlot)
            .then((r) => (r.tags || []).map((t: any) => ({ ...t, dataType: data_type })))
            .catch(() => [])
        )
      );
      return results.flat();
    },
    enabled: !!account,
  });

  const campaignNameById: Record<string, string> = {};
  for (const c of campaigns?.campaigns || []) {
    if (c.campaignId) campaignNameById[c.campaignId] = c.name;
  }

  // ── AI Action Plan inputs ──
  // Top search terms by spend (500 covers all meaningful spenders).
  const { data: searchTerms } = useQuery({
    queryKey: ["opt_search_terms", keySlot, account?.id, startDate, endDate],
    queryFn: () => mcp("get_search_term_performance", {
      ...baseArgs,
      start_date: startDate,
      end_date: endDate,
      page_size: 500,
      sort_field: "cost",
      sort_direction: "desc",
    }, keySlot),
    enabled: !!account,
  });

  // Target-level performance for bleeder / winner detection.
  const { data: targetPerf } = useQuery({
    queryKey: ["bid_perf", keySlot, account?.id, startDate, endDate], // shared with Bid Adjustment page cache
    queryFn: () => mcpAllPages("get_targeting_performance", {
      ...baseArgs,
      start_date: startDate,
      end_date: endDate,
      group_by: ["targetingValue", "targetingType", "campaignName", "adGroupName"],
    }, keySlot),
    enabled: !!account,
  });

  // Hourly rows (same call/key as HourlyHeatmap — served from cache).
  const { data: hourly } = useQuery({
    queryKey: ["hourly", keySlot, account?.id, startDate, endDate],
    queryFn: async () => {
      const res = await mcp("get_hourly_performance", {
        ...baseArgs,
        level: "campaign",
        group_by: ["hour"],
        start_date: startDate,
        end_date: endDate,
      }, keySlot);
      return (res.rows || []).filter((r: any) => r.hour != null).sort((a: any, b: any) => a.hour - b.hour);
    },
    enabled: !!account,
  });

  const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

  // Enabled negative keyword texts (for "already negated" cross-check).
  const negTextSet = new Set<string>();
  for (const n of negatives || []) {
    if ((n.state || "").toUpperCase() !== "ENABLED") continue;
    if (n.keywordText) negTextSet.add(norm(n.keywordText));
  }

  // 1) Search terms burning money with zero orders, not yet negated.
  const wastedTerms = (searchTerms?.data || [])
    .filter((t: any) => t.orders === 0 && t.clicks >= 10 && !negTextSet.has(norm(t.searchTerm)))
    .sort((a: any, b: any) => b.spend - a.spend);
  const wastedTermSpend = wastedTerms.reduce((a: number, t: any) => a + (t.spend || 0), 0);

  // 2) Bleeding targets: high ACOS with real spend → cut bids toward 30%.
  const bleeders = (targetPerf || [])
    .filter((p: any) => p.acos > 45 && p.spend > 500 && p.sales > 0)
    .sort((a: any, b: any) => b.spend - a.spend);
  const bleederSavings = bleeders.reduce((a: number, p: any) => a + p.spend * (1 - 30 / p.acos), 0);

  // 3) Weak hours: ROAS under half the account average with meaningful spend.
  const overallRoas =
    searchTerms?.summary?.overallRoas ||
    summary?.accounts?.find((a: any) => a.id === account?.id)?.metrics?.roas ||
    3;
  const weakHours = (hourly || [])
    .filter((h: any) => (h.cost || 0) > 0 && (h.roas || 0) < overallRoas / 2)
    .sort((a: any, b: any) => (b.cost || 0) - (a.cost || 0));
  const weakHourSpend = weakHours.reduce((a: number, h: any) => a + (h.cost || 0), 0);

  // 4) Winners to scale: strong ROAS with volume.
  const winners = (targetPerf || [])
    .filter((p: any) => p.roas > 5 && p.orders >= 3)
    .sort((a: any, b: any) => b.sales - a.sales);
  const winnerPotential = winners.slice(0, 10).reduce((a: number, p: any) => a + p.sales * 0.15, 0);

  const actions = [
    {
      id: "negate",
      icon: Ban,
      color: "amber",
      title: `Negate ${num(wastedTerms.length)} wasted search terms`,
      impact: wastedTermSpend,
      impactLabel: "spend saved / period",
      description: "Customer searches with 10+ clicks and zero orders, not blocked by any active negative yet.",
      detailCols: ["Search Term", "Spend", "Clicks", "Impressions", "CPC"],
      items: wastedTerms.map((t: any) => [
        t.searchTerm,
        cur(t.spend, currency),
        num(t.clicks),
        num(t.impressions),
        cur(t.cpc, currency),
      ]),
      howTo: "SellerMate → Search Terms Bulk Actions → add these as negative exact.",
    },
    {
      id: "bleeders",
      icon: TrendingDown,
      color: "red",
      title: `Cut bids on ${num(bleeders.length)} bleeding targets`,
      impact: bleederSavings,
      impactLabel: "est. savings at 30% ACOS",
      description: "Targets spending real money above 45% ACOS — reduce bids proportionally to pull them back to target.",
      detailCols: ["Target", "Campaign", "ACOS", "Spend", "Sales", "Suggested Change"],
      items: bleeders.map((p: any) => [
        p.targetingValue,
        p.campaignName,
        `${p.acos.toFixed(1)}%`,
        cur(p.spend, currency),
        cur(p.sales, currency),
        `cut bid −${Math.round((1 - 30 / p.acos) * 100)}%`,
      ]),
      howTo: "Bid Adjustment tab → filter \"Reduce\" → exact new bid per target.",
    },
    {
      id: "dayparting",
      icon: Moon,
      color: "indigo",
      title: `Daypart ${num(weakHours.length)} weak hours`,
      impact: weakHourSpend * 0.5,
      impactLabel: "recoverable from weak hours",
      description: `Hours converting under half the account ROAS (${overallRoas.toFixed(1)}x) — schedule bid-down windows in SellerMate.`,
      detailCols: ["Hour", "ROAS", "Spend", "Sales", "Clicks"],
      items: weakHours.map((h: any) => [
        h.label,
        `${(h.roas || 0).toFixed(2)}x`,
        cur(h.cost, currency),
        cur(h.sales, currency),
        num(h.clicks),
      ]),
      howTo: "SellerMate → Dayparting → create a bid schedule lowering these hours.",
    },
    {
      id: "scale",
      icon: Rocket,
      color: "emerald",
      title: `Scale ${num(winners.length)} winning targets`,
      impact: winnerPotential,
      impactLabel: "growth from +15% bids (top 10)",
      description: "Targets above 5x ROAS with proven order volume — raise bids for placement share while stock allows.",
      detailCols: ["Target", "Campaign", "ROAS", "Sales", "Orders"],
      items: winners.map((p: any) => [
        p.targetingValue,
        p.campaignName,
        `${p.roas.toFixed(2)}x`,
        cur(p.sales, currency),
        num(p.orders),
      ]),
      howTo: "Bid Adjustment tab → filter \"Increase\" → exact new bid per target.",
    },
  ].filter((a) => a.impact > 0).sort((a, b) => b.impact - a.impact);

  const actionColor: Record<string, string> = {
    amber: "border-amber-200 dark:border-amber-900 bg-amber-50/60 dark:bg-amber-950/20 text-amber-700 dark:text-amber-400",
    red: "border-red-200 dark:border-red-900 bg-red-50/60 dark:bg-red-950/20 text-red-700 dark:text-red-400",
    indigo: "border-indigo-200 dark:border-indigo-900 bg-indigo-50/60 dark:bg-indigo-950/20 text-indigo-700 dark:text-indigo-400",
    emerald: "border-emerald-200 dark:border-emerald-900 bg-emerald-50/60 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-400",
  };

  const negRows = (negatives || []).map((n: any) => ({
    ...n,
    label: n.keywordText || n.expressionValue || n.expression?.[0]?.value || "—",
    campaignName: campaignNameById[n.campaignId] || n.campaignId || "—",
  }));

  const enabledNegs = negRows.filter((n: any) => (n.state || "").toUpperCase() === "ENABLED");
  const negKeywords = negRows.filter((n: any) => n.type === "NegativeKeyword");
  const negProducts = negRows.filter((n: any) => n.type !== "NegativeKeyword");

  // The summary spans every marketplace in the workspace — pick the metrics
  // block for THIS account ("totals" lacks ctr/cpc and mixes currencies).
  const acctMetrics =
    summary?.accounts?.find((a: any) => a.id === account?.id)?.metrics ||
    summary?.accounts?.[0]?.metrics ||
    summary?.totals;

  const negColumns = [
    {
      key: "label",
      label: "Negative Keyword / ASIN",
      sortable: true,
      render: (val: string, row: any) => (
        <div className="max-w-[260px]">
          <span className="font-bold text-foreground text-sm block truncate" title={val}>{val}</span>
          <span className="text-[10px] text-muted-foreground font-mono font-bold">
            {row.type === "NegativeKeyword" ? "Keyword" : "Product"} · {row.scope === "adGroup" ? "Ad group level" : "Campaign level"}
          </span>
        </div>
      ),
    },
    {
      key: "matchType",
      label: "Match Type",
      sortable: true,
      render: (val: string) => (
        <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-px rounded font-mono font-bold uppercase">
          {(val || "—").replace("NEGATIVE_", "")}
        </span>
      ),
    },
    {
      key: "campaignName",
      label: "Campaign",
      sortable: true,
      render: (val: string) => (
        <span className="text-xs font-semibold block max-w-[220px] truncate" title={val}>{val}</span>
      ),
    },
    { key: "state", label: "State", sortable: true, render: (val: string) => stateBadge(val) },
    { key: "sponsoredType", label: "Ad Type", sortable: true, render: (val: string) => <span className="text-xs font-semibold text-muted-foreground">{val || "—"}</span> },
    {
      key: "updatedAt",
      label: "Last Updated",
      sortable: true,
      render: (val: string) => <span className="text-xs font-semibold text-muted-foreground">{val ? val.slice(0, 10) : "—"}</span>,
    },
  ];

  return (
    <div className="space-y-8 pb-12">
      <PageHero
        title="Optimization Center"
        subtitle="Account benchmarks, hourly patterns, negative targets, dayparting schedules and tags — everything the ads engine is doing."
        workspace={account?.name?.split(" ").slice(0, 2).join(" ")}
        dateRange={`${startDate} → ${endDate}`}
        primaryAction="AI Optimization Report"
        chips={acctMetrics ? [
          { label: "Account Spend", value: cur(acctMetrics.spend, currency) },
          { label: "Account Sales", value: cur(acctMetrics.sales, currency) },
          { label: "Account ACOS", value: `${(acctMetrics.acos || 0).toFixed(1)}%` },
          { label: "Account ROAS", value: `${(acctMetrics.roas || 0).toFixed(2)}x` },
        ] : []}
      />

      {contextLoading ? (
        <div className="flex h-[400px] items-center justify-center text-muted-foreground flex-col gap-4 glass rounded-2xl border border-border">
          <Loader2 className="w-7 h-7 animate-spin text-primary" />
          <p className="font-semibold text-sm">Connecting...</p>
        </div>
      ) : (
        <>
          {/* ── Account benchmark KPIs ── */}
          {acctMetrics && (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
              <KPICard title="Account ACOS" value={`${(acctMetrics.acos || 0).toFixed(1)}%`} subtitle="Benchmark for all targets" accent="purple" delay={0.02} />
              <KPICard title="Account ROAS" value={`${(acctMetrics.roas || 0).toFixed(2)}x`} subtitle="Whole-account return" accent="green" delay={0.06} />
              <KPICard title="Clicks" value={num(acctMetrics.clicks)} subtitle={`CTR ${(acctMetrics.ctr || 0).toFixed(2)}%`} accent="blue" delay={0.1} />
              <KPICard title="Orders" value={num(acctMetrics.orders)} subtitle="Ad-attributed orders" accent="cyan" delay={0.14} />
              <KPICard title="Avg CPC" value={cur(acctMetrics.cpc, currency)} subtitle="Account-wide" accent="orange" delay={0.18} />
              <KPICard title="Impressions" value={num(acctMetrics.impressions)} subtitle="This date range" accent="pink" delay={0.22} />
            </div>
          )}

          {/* ── AI Action Plan: prioritized by estimated impact ── */}
          {actions.length > 0 && (
            <div className="glass gradient-border rounded-[22px] p-6">
              <div className="flex items-center gap-2.5 mb-4">
                <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#6D5EF8] to-[#8B5CF6] flex items-center justify-center shadow-md shadow-indigo-500/20">
                  <Sparkles className="w-4.5 h-4.5 text-white" />
                </div>
                <div>
                  <h3 className="font-extrabold text-lg tracking-tight">AI Action Plan</h3>
                  <p className="text-xs text-muted-foreground font-semibold">
                    This week&apos;s priorities, ranked by estimated money impact — computed live from search terms, targets, negatives and hourly data.
                  </p>
                </div>
              </div>
              <div className="space-y-3">
                {actions.map((a, i) => {
                  const Icon = a.icon;
                  const isOpen = expandedAction === a.id;
                  return (
                    <div key={a.id} className={cn("rounded-2xl border overflow-hidden", actionColor[a.color])}>
                      <button
                        onClick={() => setExpandedAction(isOpen ? null : a.id)}
                        className="w-full p-4 flex flex-col md:flex-row md:items-start gap-3 text-left cursor-pointer hover:bg-black/[0.03] dark:hover:bg-white/[0.03] transition-colors"
                      >
                        <div className="flex items-center gap-3 flex-shrink-0">
                          <span className="w-7 h-7 rounded-full bg-white/70 dark:bg-black/30 border border-current flex items-center justify-center text-sm font-black">
                            {i + 1}
                          </span>
                          <Icon className="w-5 h-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="font-extrabold text-sm">{a.title}</p>
                          <p className="text-xs text-muted-foreground font-semibold mt-0.5">{a.description}</p>
                          {!isOpen && a.items.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 mt-2">
                              {a.items.slice(0, 3).map((row: string[], j: number) => (
                                <span key={j} className="text-[10px] font-bold bg-white/70 dark:bg-black/30 border border-current/20 px-2 py-0.5 rounded-full truncate max-w-[280px]" title={row.join(" · ")}>
                                  {row[0]} · {row[1]}
                                </span>
                              ))}
                              {a.items.length > 3 && (
                                <span className="text-[10px] font-extrabold px-2 py-0.5">+{num(a.items.length - 3)} more</span>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="text-right flex-shrink-0 flex items-start gap-3">
                          <div>
                            <p className="text-lg font-extrabold">{cur(a.impact, currency)}</p>
                            <p className="text-[10px] font-bold text-muted-foreground">{a.impactLabel}</p>
                          </div>
                          <ChevronDown className={cn("w-4 h-4 mt-1.5 transition-transform", isOpen && "rotate-180")} />
                        </div>
                      </button>

                      {isOpen && (
                        <div className="px-4 pb-4">
                          <p className="text-[11px] font-bold text-muted-foreground mb-2">
                            👉 {a.howTo}
                          </p>
                          <div className="rounded-xl border border-current/15 bg-white/60 dark:bg-black/20 overflow-x-auto max-h-[340px] overflow-y-auto">
                            <table className="w-full text-left text-xs whitespace-nowrap">
                              <thead className="sticky top-0 bg-white/90 dark:bg-slate-950/90 backdrop-blur-sm">
                                <tr>
                                  {a.detailCols.map((c: string) => (
                                    <th key={c} className="px-3 py-2 font-extrabold text-[10px] uppercase tracking-wider text-muted-foreground border-b border-current/10">
                                      {c}
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-current/5">
                                {a.items.map((row: string[], j: number) => (
                                  <tr key={j} className="hover:bg-black/[0.03] dark:hover:bg-white/[0.03]">
                                    {row.map((cell: string, k: number) => (
                                      <td key={k} className={cn("px-3 py-1.5 font-semibold", k === 0 && "font-bold text-foreground max-w-[300px] truncate")} title={k === 0 ? cell : undefined}>
                                        {cell}
                                      </td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Hourly performance / dayparting insight ── */}
          <HourlyHeatmap />

          {/* ── Dayparting schedules + tags status ── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="glass rounded-2xl border border-border p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center"><CalendarClock className="w-4 h-4 text-primary" /></div>
                <h3 className="font-bold text-sm">Dayparting Schedules</h3>
                <span className="ml-auto text-xs font-bold text-muted-foreground bg-muted px-2 py-0.5 rounded-full">{num((daypartings || []).length)}</span>
              </div>
              {(daypartings || []).length === 0 ? (
                <p className="text-xs text-muted-foreground font-semibold">
                  No dayparting schedules configured. The hourly chart above shows where a bid/budget schedule would help — set one up in SellerMate.
                </p>
              ) : (
                <div className="space-y-2">
                  {(daypartings || []).map((d: any) => (
                    <div key={d.id} className="p-3 rounded-xl border border-border bg-muted/40 text-xs flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-bold truncate">{d.name || d.id}</p>
                        <p className="text-muted-foreground font-semibold mt-0.5 capitalize">{d.type} dayparting</p>
                      </div>
                      {stateBadge(d.state || d.status)}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="glass rounded-2xl border border-border p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center"><TagIcon className="w-4 h-4 text-primary" /></div>
                <h3 className="font-bold text-sm">Tags</h3>
                <span className="ml-auto text-xs font-bold text-muted-foreground bg-muted px-2 py-0.5 rounded-full">{num((tags || []).length)}</span>
              </div>
              {(tags || []).length === 0 ? (
                <p className="text-xs text-muted-foreground font-semibold">
                  No tags created yet. Tags group campaigns/targets for bulk analysis — create them in SellerMate&apos;s Ads Manager.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {(tags || []).map((t: any, i: number) => (
                    <span key={(t.id || t.name || "") + i} className="flex items-center gap-1.5 bg-primary/5 border border-primary/15 text-primary px-3 py-1.5 rounded-full text-xs font-bold">
                      <TagIcon className="w-3 h-3" /> {t.name || t.tag || "—"}
                      <span className="text-[10px] text-muted-foreground font-extrabold capitalize">{t.dataType}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ── Negative targets ── */}
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <KPICard title="Total Negatives" value={num(negRows.length)} subtitle="Keywords + products" accent="purple" delay={0.02} />
              <KPICard title="Active Negatives" value={num(enabledNegs.length)} subtitle="Currently blocking" accent="green" delay={0.06} />
              <KPICard title="Negative Keywords" value={num(negKeywords.length)} subtitle="Search term blocks" accent="blue" delay={0.1} />
              <KPICard title="Negative Products" value={num(negProducts.length)} subtitle="ASIN blocks" accent="orange" delay={0.14} />
            </div>

            {negLoading ? (
              <div className="flex h-[240px] items-center justify-center text-muted-foreground flex-col gap-4 glass rounded-2xl border border-border">
                <Loader2 className="w-7 h-7 animate-spin text-primary" />
                <p className="font-semibold text-sm">Loading negative targets...</p>
              </div>
            ) : negError ? (
              <QueryErrorState
                compact
                message="Negative targets couldn't load — retry, or the list below may be incomplete rather than genuinely empty."
                onRetry={() => refetchNegatives()}
              />
            ) : (
              <DataTable data={negRows} columns={negColumns} defaultSort="updatedAt" exportName="negative-targets" />
            )}
          </div>
        </>
      )}
    </div>
  );
}
