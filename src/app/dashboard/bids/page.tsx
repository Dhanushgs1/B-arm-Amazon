"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDashboard } from "@/lib/DashboardContext";
import { mcp, mcpAllTargets, mcpAllPages, mcpAllNegatives } from "@/lib/api";
import { DataTable } from "@/components/DataTable";
import { KPICard } from "@/components/KPICard";
import { KpiDrilldownModal } from "@/components/KpiDrilldownModal";
import { PageHero } from "@/components/PageHero";
import { AcosBadge, acosRowClass } from "@/components/AcosBadge";
import {
  Loader2, ShieldAlert, TrendingUp, TrendingDown, PauseCircle,
  Minus, Rocket, AlertTriangle, Ban, Trophy
} from "lucide-react";
import { cn } from "@/lib/utils";

const cur = (val: number, currency?: string) => {
  const sym = currency === "INR" ? "₹" : "$";
  if (!val) return `${sym}0`;
  return sym + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(val);
};
const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));
const pct = (val: number) => `${(val || 0).toFixed(1)}%`;

const TARGET_ACOS = 30; // bid suggestions steer toward this ACOS

// Human-readable label for whatever a list_targets row actually is —
// keyword text, an auto-targeting bucket, or a product/ASIN expression.
const targetLabel = (t: any) => {
  if (t.keywordText) return t.keywordText;
  if (t.targetingValue) return t.targetingValue;
  if (t.expressionValue) return t.expressionValue;
  if (t.expressionType) return t.expressionType;
  return "—";
};

// Normalize for joining list_targets against get_targeting_performance rows
// ("Close match" vs "close-match", casing, stray spaces).
const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const joinKey = (label: string, campaign: string, adGroup: string) =>
  `${norm(label)}|${norm(campaign)}|${norm(adGroup)}`;

type Action = "increase" | "reduce" | "pause" | "keep" | "nodata";

// Bid recommendation steering toward TARGET_ACOS. Uses the live bid when the
// inventory has synced; falls back to observed CPC as the base before that.
const recommend = (base: number, perf: any): { action: Action; newBid: number | null; reason: string } => {
  if (!perf || !perf.clicks) return { action: "nodata", newBid: null, reason: "No clicks in range" };
  if (!perf.orders && perf.clicks >= 15)
    return { action: "pause", newBid: base ? Math.max(1, base * 0.5) : null, reason: `${perf.clicks} clicks, 0 orders — cut hard or pause` };
  if (perf.acos > TARGET_ACOS && perf.sales > 0) {
    const nb = base ? Math.max(1, base * (TARGET_ACOS / perf.acos)) : null;
    return { action: "reduce", newBid: nb, reason: `ACOS ${perf.acos.toFixed(0)}% > ${TARGET_ACOS}% target` };
  }
  if (perf.roas > 5 && perf.orders >= 3)
    return { action: "increase", newBid: base ? base * 1.15 : null, reason: `ROAS ${perf.roas.toFixed(1)}x — scale for more volume` };
  return { action: "keep", newBid: null, reason: "Performing within target" };
};

const ACTION_META: Record<Action, { label: string; cls: string; icon: any }> = {
  increase: { label: "Increase", cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20", icon: TrendingUp },
  reduce: { label: "Reduce", cls: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20", icon: TrendingDown },
  pause: { label: "Pause / Cut", cls: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20", icon: PauseCircle },
  keep: { label: "Keep", cls: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20", icon: Minus },
  nodata: { label: "No Data", cls: "bg-muted text-muted-foreground border-border", icon: Minus },
};

const FILTERS: { id: string; label: string }[] = [
  { id: "all", label: "All" },
  { id: "increase", label: "Increase" },
  { id: "reduce", label: "Reduce" },
  { id: "pause", label: "Pause / Cut" },
  { id: "keep", label: "Keep" },
  { id: "nodata", label: "No Data" },
];

export default function BidAdjustmentPage() {
  const { keySlot, startDate, endDate, account, contextLoading, setSelectedCampaignName } = useDashboard();
  const [filter, setFilter] = useState("all");
  const [kpiModal, setKpiModal] = useState<{ title: string; data: any[] } | null>(null);

  // ── Primary (fast) query: performance for the date range.
  // The page renders as soon as this arrives.
  const { data: perfData, isLoading: perfLoading } = useQuery({
    queryKey: ["bid_perf", keySlot, account?.id, startDate, endDate],
    queryFn: async () =>
      mcpAllPages("get_targeting_performance", {
        amazon_account_id: account?.id,
        workspace_id: account?.workspace_id,
        start_date: startDate,
        end_date: endDate,
        group_by: ["targetingValue", "targetingType", "campaignName", "adGroupName"],
      }, keySlot),
    enabled: !!account,
  });

  // ── Secondary (slow) query: full live-target inventory (bids + zero-traffic
  // targets). Fetched only after the user clicks "No Data" — the graded table
  // works without it (CPC-based suggestions), so the initial load stays fast.
  const [wantTargets, setWantTargets] = useState(false);
  const { data: targetsData, isLoading: targetsLoading, isFetching: targetsFetching } = useQuery({
    queryKey: ["bid_targets", keySlot, account?.id],
    queryFn: async () =>
      mcpAllTargets({
        amazon_account_id: account?.id,
        workspace_id: account?.workspace_id,
        state: ["ENABLED"],
      }, keySlot, 20),
    enabled: !!account && wantTargets,
    staleTime: 5 * 60 * 1000,
  });

  // Campaign budgets — cheap single call, gives context to every suggestion.
  const { data: campaignsData } = useQuery({
    queryKey: ["bid_campaigns", keySlot, account?.id],
    queryFn: () => mcp("list_campaigns", {
      amazon_account_id: account?.id,
      workspace_id: account?.workspace_id,
      page_size: 500,
    }, keySlot),
    enabled: !!account,
  });

  // Existing negatives — lets Pause candidates show "already negated".
  const { data: negativesData } = useQuery({
    queryKey: ["bid_negatives", keySlot, account?.id],
    queryFn: () => mcpAllNegatives({
      amazon_account_id: account?.id,
      workspace_id: account?.workspace_id,
    }, keySlot),
    enabled: !!account,
  });

  // Account-wide benchmark for the same date range.
  const { data: summaryData } = useQuery({
    queryKey: ["bid_summary", keySlot, account?.id, startDate, endDate],
    queryFn: () => mcp("get_marketplace_summary", {
      workspace_id: account?.workspace_id,
      start_date: startDate,
      end_date: endDate,
    }, keySlot),
    enabled: !!account,
  });

  const currency = account?.currency;
  // Summary spans every marketplace in the workspace — pick this account's block.
  const acct =
    summaryData?.accounts?.find((a: any) => a.id === account?.id)?.metrics ||
    summaryData?.accounts?.[0]?.metrics ||
    summaryData?.totals;

  // Campaign name -> budget, and campaignId -> name (negatives only carry ids).
  const budgetByCampaign: Record<string, number> = {};
  const campaignNameById: Record<string, string> = {};
  for (const c of campaignsData?.campaigns || []) {
    if (c.name) budgetByCampaign[norm(c.name)] = c.budget?.budget || 0;
    if (c.campaignId) campaignNameById[c.campaignId] = c.name;
  }

  // Enabled negative keywords keyed by (text, campaign name).
  const negSet = new Set<string>();
  for (const n of negativesData || []) {
    if ((n.state || "").toUpperCase() !== "ENABLED") continue;
    const text = n.keywordText || n.expressionValue || "";
    const cName = campaignNameById[n.campaignId] || "";
    if (text) negSet.add(`${norm(text)}|${norm(cName)}`);
  }

  // ── Bid map from inventory (once synced) ──
  const bidMap: Record<string, any> = {};
  const matchedKeys = new Set<string>();
  for (const t of targetsData || []) {
    bidMap[joinKey(targetLabel(t), t.campaignName, t.adGroupName)] = t;
  }

  // ── Graded rows: one per performance row, enriched with live bid when available ──
  const gradedRows = (perfData || []).map((p: any) => {
    const key = joinKey(p.targetingValue, p.campaignName, p.adGroupName);
    const t = bidMap[key];
    if (t) matchedKeys.add(key);
    const bid = t?.bid || 0;
    const base = bid || p.cpc || 0;
    const rec = recommend(base, p);
    const deltaPct = rec.newBid != null && base ? ((rec.newBid - base) / base) * 100 : null;
    const negated = rec.action === "pause" && negSet.has(`${norm(p.targetingValue)}|${norm(p.campaignName)}`);
    return {
      label: p.targetingValue || "—",
      negated,
      budget: budgetByCampaign[norm(p.campaignName)] || 0,
      campaignName: p.campaignName,
      adGroupName: p.adGroupName,
      sponsoredType: t?.sponsoredType || p.targetingType || "",
      matchType: t?.matchType || "",
      expressionType: t?.expressionType || "",
      keywordText: t?.keywordText || "",
      bid: bid || null,
      spend: p.spend || 0,
      sales: p.sales || 0,
      orders: p.orders || 0,
      clicks: p.clicks || 0,
      impressions: p.impressions || 0,
      acos: p.acos || 0,
      roas: p.roas || 0,
      cpc: p.cpc || 0,
      action: rec.action,
      newBid: rec.newBid,
      deltaPct,
      reason: rec.reason,
    };
  });

  // ── No-data rows: enabled targets with zero traffic (only once inventory synced) ──
  const noDataRows = (targetsData || [])
    .filter((t: any) => !matchedKeys.has(joinKey(targetLabel(t), t.campaignName, t.adGroupName)))
    .map((t: any) => ({
      label: targetLabel(t),
      campaignName: t.campaignName,
      adGroupName: t.adGroupName,
      sponsoredType: t.sponsoredType || "",
      matchType: t.matchType || "",
      expressionType: t.expressionType || "",
      keywordText: t.keywordText || "",
      bid: t.bid || null,
      negated: false,
      budget: budgetByCampaign[norm(t.campaignName)] || 0,
      spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0, acos: 0, roas: 0, cpc: 0,
      action: "nodata" as Action,
      newBid: null,
      deltaPct: null,
      reason: "No clicks in range",
    }));

  // ── KPI aggregates (from graded rows — the actionable set) ──
  const increaseList = gradedRows.filter((r: any) => r.action === "increase").sort((a: any, b: any) => b.sales - a.sales);
  const reduceList = gradedRows.filter((r: any) => r.action === "reduce").sort((a: any, b: any) => b.spend - a.spend);
  const pauseList = gradedRows.filter((r: any) => r.action === "pause").sort((a: any, b: any) => b.spend - a.spend);
  const activeSpend = gradedRows.reduce((a: number, r: any) => a + r.spend, 0);
  const activeSales = gradedRows.reduce((a: number, r: any) => a + r.sales, 0);
  // Savings ≈ spend scaled by how much the bid/CPC is being cut.
  const estSavings = [...reduceList, ...pauseList].reduce((a: number, r: any) => {
    const base = r.bid || r.cpc;
    if (r.newBid == null || !base) return a;
    return a + r.spend * (1 - r.newBid / base);
  }, 0);
  const estGrowth = increaseList.slice(0, 10).reduce((a: number, r: any) => a + r.sales * 0.15, 0);

  const filtered =
    filter === "all" ? gradedRows
    : filter === "nodata" ? noDataRows
    : gradedRows.filter((r: any) => r.action === filter);

  const bidsSynced = !!targetsData;

  const columns = [
    {
      key: "label",
      label: "Keyword / Target",
      sortable: true,
      render: (val: string, row: any) => (
        <div className="max-w-[280px]">
          <span className="font-bold text-foreground text-sm block truncate" title={val}>
            {val}
          </span>
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            {row.sponsoredType && (
              <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-px rounded font-mono font-bold">
                {row.sponsoredType}
              </span>
            )}
            {row.matchType && (
              <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-px rounded font-mono font-bold uppercase">
                {row.matchType}
              </span>
            )}
            {!row.keywordText && row.expressionType && (
              <span className="text-[10px] font-extrabold px-1.5 py-px rounded-full bg-violet-500/10 text-violet-600 dark:text-violet-400">
                {row.expressionType}
              </span>
            )}
          </div>
        </div>
      ),
    },
    {
      key: "campaignName",
      label: "Campaign",
      sortable: true,
      render: (val: string, row: any) => (
        <div className="max-w-[180px]">
          <button
            onClick={() => setSelectedCampaignName(val)}
            className="text-primary hover:underline text-xs block w-full truncate text-left focus:outline-none font-semibold"
            title={val}
          >
            {val || "—"}
          </button>
          {row.budget > 0 && (
            <span className="text-[10px] font-bold text-muted-foreground">
              Budget {cur(row.budget, currency)}/day
            </span>
          )}
        </div>
      ),
    },
    {
      key: "bid",
      label: "Current Bid",
      sortable: true,
      render: (val: number | null) => {
        if (val != null) return <span className="font-bold text-foreground">{cur(val, currency)}</span>;
        return bidsSynced
          ? <span className="text-xs text-muted-foreground font-semibold">—</span>
          : (
            <button
              onClick={() => setWantTargets(true)}
              className="text-[10px] font-bold text-primary hover:underline"
              title="Load live bids from the target inventory"
            >
              {targetsFetching ? "syncing…" : "load bids"}
            </button>
          );
      },
    },
    {
      key: "newBid",
      label: "Suggested Bid",
      sortable: true,
      render: (val: number | null, row: any) => {
        if (val == null) return <span className="text-xs text-muted-foreground font-semibold">—</span>;
        const up = row.deltaPct != null && row.deltaPct > 0;
        return (
          <div>
            <span className={cn(
              "px-2 py-0.5 rounded-full text-xs font-extrabold",
              up ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-red-500/10 text-red-600 dark:text-red-400"
            )}>
              {up ? "↑" : "↓"} {cur(val, currency)}
            </span>
            {row.deltaPct != null && (
              <span className="block text-[10px] font-bold text-muted-foreground mt-0.5">
                {row.deltaPct > 0 ? "+" : ""}{row.deltaPct.toFixed(0)}% {row.bid == null ? "vs CPC" : ""}
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: "action",
      label: "Action",
      sortable: true,
      render: (val: Action, row: any) => {
        const meta = ACTION_META[val] || ACTION_META.nodata;
        const Icon = meta.icon;
        return (
          <div>
            <span
              className={cn("inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-extrabold border", meta.cls)}
              title={row.reason}
            >
              <Icon className="w-3 h-3" /> {meta.label}
            </span>
            {val === "pause" && (
              <span className={cn(
                "block text-[10px] font-bold mt-0.5",
                row.negated ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"
              )}>
                {row.negated ? "✓ already negated" : "not negated yet"}
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: "spend",
      label: "Spend",
      sortable: true,
      render: (val: number) => <span className="font-bold text-foreground">{cur(val, currency)}</span>,
    },
    {
      key: "sales",
      label: "Sales",
      sortable: true,
      render: (val: number) => <span className="text-emerald-600 dark:text-emerald-400 font-extrabold">{cur(val, currency)}</span>,
    },
    { key: "acos", label: "ACOS", sortable: true, render: (val: number) => (val ? <AcosBadge value={val} /> : <span className="text-xs text-muted-foreground">—</span>) },
    {
      key: "roas",
      label: "ROAS",
      sortable: true,
      render: (val: number) => (
        <span className={cn(
          "px-2 py-0.5 rounded-full text-xs font-extrabold",
          val > 5 ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : val > 3 ? "bg-blue-500/10 text-blue-600 dark:text-blue-400" : val > 0 ? "bg-amber-500/10 text-amber-600 dark:text-amber-400" : "text-muted-foreground"
        )}>
          {val ? `${val.toFixed(2)}x` : "—"}
        </span>
      ),
    },
    { key: "cpc", label: "CPC", sortable: true, render: (val: number) => (val ? cur(val, currency) : "—") },
    { key: "clicks", label: "Clicks", sortable: true, render: (val: number) => num(val) },
    { key: "orders", label: "Orders", sortable: true, render: (val: number) => num(val) },
  ];

  return (
    <div className="space-y-8 pb-12">
      <PageHero
        title="Bid Adjustment"
        subtitle="Performance-graded bid recommendations — raise winners, cut bleeders and pause dead spend."
        workspace={account?.name?.split(" ").slice(0, 2).join(" ")}
        dateRange={`${startDate} → ${endDate}`}
        primaryAction="AI Bid Report"
        chips={[
          { label: "Graded Targets", value: num(gradedRows.length) },
          { label: "Target Spend", value: cur(activeSpend, currency) },
          { label: "Target Sales", value: cur(activeSales, currency) },
          { label: "Est. Savings", value: cur(estSavings, currency) },
          ...(acct ? [{ label: "Acct Benchmark", value: `${(acct.acos || 0).toFixed(1)}% ACOS · ${(acct.roas || 0).toFixed(2)}x` }] : []),
        ]}
      />

      <div className="glass rounded-2xl border border-amber-200 dark:border-amber-900 bg-amber-50/50 dark:bg-amber-950/20 p-4 flex items-start gap-3">
        <ShieldAlert className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
        <div className="text-xs">
          <p className="font-bold text-amber-800 dark:text-amber-400">Read-only preview</p>
          <p className="text-muted-foreground mt-0.5">
            Suggestions target {TARGET_ACOS}% ACOS. This dashboard&apos;s API key only has reporting access — apply the bid changes in SellerMate / Ads console.
          </p>
        </div>
      </div>

      {contextLoading || perfLoading ? (
        <div className="flex h-[400px] items-center justify-center text-muted-foreground flex-col gap-4 glass rounded-2xl border border-border">
          <Loader2 className="w-7 h-7 animate-spin text-primary" />
          <p className="font-semibold text-sm">{contextLoading ? "Connecting..." : "Loading performance..."}</p>
        </div>
      ) : (
        <>
          {/* ── KPI Dashboard ── */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <KPICard title="Graded Targets" value={num(gradedRows.length)} subtitle="With traffic in range" accent="blue" delay={0.02} onClick={() => setKpiModal({ title: "Graded Targets", data: gradedRows })} />
            <KPICard title="Scale Ups" value={num(increaseList.length)} subtitle="Raise bid candidates" accent="green" delay={0.06} onClick={() => setKpiModal({ title: "Scale Ups", data: increaseList })} />
            <KPICard title="Bid Cuts" value={num(reduceList.length)} subtitle={`ACOS > ${TARGET_ACOS}%`} accent="orange" inverseTrend delay={0.1} onClick={() => setKpiModal({ title: "Bid Cuts", data: reduceList })} />
            <KPICard title="Pause Ideas" value={num(pauseList.length)} subtitle="Clicks, zero orders" accent="pink" inverseTrend delay={0.14} onClick={() => setKpiModal({ title: "Pause Ideas", data: pauseList })} />
            <KPICard title="Est. Savings" value={cur(estSavings, currency)} subtitle="From cuts & pauses" accent="purple" delay={0.18} onClick={() => setKpiModal({ title: "Estimated Savings", data: [...reduceList, ...pauseList] })} />
            <KPICard title="Growth Potential" value={`+${cur(estGrowth, currency)}`} subtitle="From top scale-ups" accent="cyan" delay={0.22} onClick={() => setKpiModal({ title: "Growth Potential", data: increaseList.slice(0, 10) })} />
          </div>

          <KpiDrilldownModal 
            isOpen={!!kpiModal} 
            onClose={() => setKpiModal(null)} 
            title={kpiModal?.title || ""} 
            data={kpiModal?.data || []} 
            columns={columns} 
          />

          {/* ── Opportunity Cards ── */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {increaseList.slice(0, 1).map((r: any) => (
              <div key={"up" + r.label + r.campaignName} className="p-4 rounded-2xl border border-emerald-200 dark:border-emerald-900 bg-gradient-to-br from-emerald-50/80 to-white dark:from-emerald-950/30 dark:to-transparent text-xs hover:-translate-y-0.5 transition-transform">
                <p className="font-extrabold text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5 text-sm"><Trophy className="w-4 h-4" /> Best Scale-Up</p>
                <p className="font-bold mt-1.5 truncate text-[13px]" title={r.label}>{r.label}</p>
                <p className="text-muted-foreground mt-1 font-bold">ROAS {r.roas.toFixed(2)}x · {cur(r.sales, currency)} sales</p>
                <p className="font-extrabold text-emerald-700 dark:text-emerald-500 mt-2">
                  {cur(r.bid || r.cpc, currency)} → {cur(r.newBid, currency)}
                </p>
              </div>
            ))}
            {reduceList.slice(0, 1).map((r: any) => (
              <div key={"down" + r.label + r.campaignName} className="p-4 rounded-2xl border border-amber-200 dark:border-amber-900 bg-gradient-to-br from-amber-50/80 to-white dark:from-amber-950/30 dark:to-transparent text-xs hover:-translate-y-0.5 transition-transform">
                <p className="font-extrabold text-amber-700 dark:text-amber-400 flex items-center gap-1.5 text-sm"><AlertTriangle className="w-4 h-4" /> Biggest Bleeder</p>
                <p className="font-bold mt-1.5 truncate text-[13px]" title={r.label}>{r.label}</p>
                <p className="text-muted-foreground mt-1 font-bold">ACOS {pct(r.acos)} · {cur(r.spend, currency)} spend</p>
                <p className="font-extrabold text-amber-700 dark:text-amber-500 mt-2">
                  {cur(r.bid || r.cpc, currency)} → {cur(r.newBid, currency)}
                </p>
              </div>
            ))}
            {pauseList.slice(0, 1).map((r: any) => (
              <div key={"pause" + r.label + r.campaignName} className="p-4 rounded-2xl border border-red-200 dark:border-red-900 bg-gradient-to-br from-red-50/80 to-white dark:from-red-950/30 dark:to-transparent text-xs hover:-translate-y-0.5 transition-transform">
                <p className="font-extrabold text-red-700 dark:text-red-400 flex items-center gap-1.5 text-sm"><Ban className="w-4 h-4" /> Dead Spend</p>
                <p className="font-bold mt-1.5 truncate text-[13px]" title={r.label}>{r.label}</p>
                <p className="text-muted-foreground mt-1 font-bold">{r.clicks} clicks · 0 orders · {cur(r.spend, currency)} wasted</p>
                <p className="font-extrabold text-red-700 dark:text-red-500 mt-2">Pause or cut to {cur(r.newBid, currency)}</p>
              </div>
            ))}
            {increaseList.slice(1, 2).map((r: any) => (
              <div key={"up2" + r.label + r.campaignName} className="p-4 rounded-2xl border border-blue-200 dark:border-blue-900 bg-gradient-to-br from-blue-50/80 to-white dark:from-blue-950/30 dark:to-transparent text-xs hover:-translate-y-0.5 transition-transform">
                <p className="font-extrabold text-blue-700 dark:text-blue-400 flex items-center gap-1.5 text-sm"><Rocket className="w-4 h-4" /> Scale Opportunity</p>
                <p className="font-bold mt-1.5 truncate text-[13px]" title={r.label}>{r.label}</p>
                <p className="text-muted-foreground mt-1 font-bold">{r.orders} orders · ROAS {r.roas.toFixed(2)}x</p>
                <p className="font-extrabold text-blue-700 dark:text-blue-500 mt-2">
                  {cur(r.bid || r.cpc, currency)} → {cur(r.newBid, currency)}
                </p>
              </div>
            ))}
          </div>

          {/* ── Action filter chips ── */}
          <div className="flex items-center gap-2 flex-wrap">
            {FILTERS.map((f) => {
              const isNoData = f.id === "nodata";
              const count = f.id === "all"
                ? gradedRows.length
                : isNoData
                  ? (bidsSynced ? noDataRows.length : null)
                  : gradedRows.filter((r: any) => r.action === f.id).length;
              return (
                <button
                  key={f.id}
                  onClick={() => {
                    setFilter(f.id);
                    if (isNoData) setWantTargets(true); // lazy-load the big inventory
                  }}
                  className={cn(
                    "px-3.5 py-1.5 rounded-full text-xs font-extrabold border transition-all",
                    filter === f.id
                      ? "bg-gradient-to-r from-[#6D5EF8] to-[#8B5CF6] text-white border-transparent shadow-md shadow-indigo-500/20"
                      : "bg-background border-border text-muted-foreground hover:border-primary hover:text-foreground"
                  )}
                >
                  {f.label}{" "}
                  <span className="opacity-70">
                    {count == null ? "(load)" : `(${num(count)})`}
                  </span>
                </button>
              );
            })}
            {targetsFetching && (
              <span className="flex items-center gap-1.5 text-[11px] font-bold text-muted-foreground">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" /> Syncing live bids…
              </span>
            )}
            {bidsSynced && !targetsFetching && (
              <span className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400">✓ Live bids synced</span>
            )}
          </div>

          {filter === "nodata" && !bidsSynced && targetsLoading ? (
            <div className="flex h-[240px] items-center justify-center text-muted-foreground flex-col gap-4 glass rounded-2xl border border-border">
              <Loader2 className="w-7 h-7 animate-spin text-primary" />
              <p className="font-semibold text-sm">Loading full target inventory…</p>
              <p className="text-xs">Large accounts can take ~15-30s — only fetched when you need it.</p>
            </div>
          ) : (
            <DataTable data={filtered} columns={columns} defaultSort="spend" rowClassName={acosRowClass} exportName="bid-adjustment" />
          )}
        </>
      )}
    </div>
  );
}
