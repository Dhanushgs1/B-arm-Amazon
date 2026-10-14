"use client";

// Godown Stock Analytics — trends over the godown's daily Stock Out history (barm_godown_daily) for
// the products on the current godown sheet, with the Consolidated Stock Sheet's stock and restock
// numbers and the week's Monday snapshot. All calculations: src/lib/godownAnalytics.ts. Read-only:
// uploads stay on the Consolidated Stock page. Missing dates are gaps, never zero.

import { Fragment, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ResponsiveContainer, ComposedChart, LineChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from "recharts";
import { AlertTriangle, ChevronDown, ChevronRight, Download, Info, Search, TrendingUp, TrendingDown, Zap, Minus, HelpCircle, CircleSlash } from "lucide-react";
import { InventoryTabs } from "@/components/InventoryTabs";
import { KPICard } from "@/components/KPICard";
import { QueryErrorState } from "@/components/QueryErrorState";
import { useDashboard } from "@/lib/DashboardContext";
import { fetchGodownAnalytics, type GodownAnalyticsData } from "@/lib/godownAnalyticsData";
import { analyzeGodown, productSeries, addDays, GA_RULES, STATUS_ORDER, RISK_ORDER, type GodownStatus, type ProductAnalytics, type StockRisk } from "@/lib/godownAnalytics";
import { exportGodownAnalytics } from "@/lib/godownAnalyticsExport";
import { weeklyLabel } from "@/lib/consolidatedStockExport";

const int = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(v)));
const dec = (v: number | null | undefined, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d }).format(v));
const pct = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${Math.round(v)}%`);
const dateLong = (iso: string | null) => (iso ? new Date(iso + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—");
const dayLabel = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

// Dataviz reference palette (same as Seasonal Analytics), light/dark.
const PALETTE = {
  light: { s1: "#2a78d6", s2: "#eb6834", grid: "#e7e6e2", axis: "#52514e", surface: "#fcfcfb", text: "#0b0b0b" },
  dark: { s1: "#3987e5", s2: "#d95926", grid: "#33332f", axis: "#c3c2b7", surface: "#1a1a19", text: "#ffffff" },
};
function useIsDark() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const el = document.documentElement;
    const read = () => setDark(el.classList.contains("dark"));
    read();
    const mo = new MutationObserver(read);
    mo.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);
  return dark;
}

// Colour never carries meaning alone — icon + label on every badge.
const STATUS_META: Record<GodownStatus, { icon: typeof TrendingUp; label: string; cls: string }> = {
  SPIKE: { icon: Zap, label: "Spike", cls: "bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-800" },
  GROWING: { icon: TrendingUp, label: "Growing", cls: "bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800" },
  STABLE: { icon: Minus, label: "Stable", cls: "bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800/60 dark:text-slate-300 dark:border-slate-700" },
  DROPPING: { icon: TrendingDown, label: "Dropping", cls: "bg-red-100 text-red-800 border-red-300 dark:bg-red-950/50 dark:text-red-300 dark:border-red-800" },
  "NO SALES": { icon: CircleSlash, label: "No sales", cls: "bg-zinc-100 text-zinc-700 border-zinc-300 dark:bg-zinc-800/60 dark:text-zinc-300 dark:border-zinc-700" },
  "LOW VOLUME": { icon: Minus, label: "Low volume", cls: "bg-slate-50 text-slate-500 border-slate-200 dark:bg-slate-900/60 dark:text-slate-400 dark:border-slate-800" },
  "INSUFFICIENT DATA": { icon: HelpCircle, label: "Insufficient data", cls: "bg-slate-50 text-slate-500 border-slate-200 dark:bg-slate-900/60 dark:text-slate-400 dark:border-slate-800" },
};
const RISK_META: Record<StockRisk, { label: string; cls: string }> = {
  "OUT OF STOCK": { label: "Out of stock", cls: "bg-red-600 text-white" },
  CRITICAL: { label: `Critical (< ${GA_RULES.criticalDays} d)`, cls: "bg-[#FFC7CE] text-[#9C0006] dark:bg-red-950 dark:text-red-300" },
  HIGH: { label: `High (< ${GA_RULES.highDays} d)`, cls: "bg-orange-100 text-orange-800 dark:bg-orange-950/60 dark:text-orange-300" },
  WATCH: { label: `Watch (< ${GA_RULES.watchDays} d)`, cls: "bg-yellow-100 text-yellow-800 dark:bg-yellow-950/60 dark:text-yellow-300" },
  OK: { label: "OK", cls: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" },
  "NOT SELLING": { label: "Not selling", cls: "text-muted-foreground" },
};

function StatusBadge({ s }: { s: GodownStatus }) {
  const m = STATUS_META[s];
  const Icon = m.icon;
  return <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[10px] font-bold ${m.cls}`}><Icon size={11} /> {m.label}</span>;
}
const RiskBadge = ({ r }: { r: StockRisk }) => <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold ${RISK_META[r].cls}`}>{RISK_META[r].label}</span>;
const Est = () => <span className="ml-0.5 rounded bg-amber-100 px-1 text-[8px] font-bold normal-case text-amber-800 dark:bg-amber-900/60 dark:text-amber-200" title="Estimate — calculated, not read from the sheet">est.</span>;

type SortKey = "product" | "status" | "units30" | "rate7" | "growthPct" | "currentStock" | "daysLeft" | "risk" | "finalQtyToRestock" | "peakQty";
const SORTERS: Record<SortKey, (a: ProductAnalytics, b: ProductAnalytics) => number> = {
  product: (a, b) => a.product.localeCompare(b.product),
  status: (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
  units30: (a, b) => a.units30 - b.units30,
  rate7: (a, b) => (a.rate7 ?? -1) - (b.rate7 ?? -1),
  growthPct: (a, b) => (a.growthPct ?? -Infinity) - (b.growthPct ?? -Infinity),
  currentStock: (a, b) => a.currentStock - b.currentStock,
  daysLeft: (a, b) => (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity),
  risk: (a, b) => RISK_ORDER.indexOf(a.risk) - RISK_ORDER.indexOf(b.risk),
  finalQtyToRestock: (a, b) => a.finalQtyToRestock - b.finalQtyToRestock,
  peakQty: (a, b) => (a.peakQty ?? -1) - (b.peakQty ?? -1),
};

export default function GodownAnalyticsPage() {
  const { endDate } = useDashboard();
  const asOfPicked = /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : undefined;
  const { data, isLoading, isError, error, refetch } = useQuery<GodownAnalyticsData>({ queryKey: ["godown_analytics", asOfPicked ?? "latest"], queryFn: () => fetchGodownAnalytics(asOfPicked) });
  const dark = useIsDark();
  const P = dark ? PALETTE.dark : PALETTE.light;

  const [search, setSearch] = useState("");
  const [statuses, setStatuses] = useState<Set<GodownStatus>>(new Set());
  const [risk, setRisk] = useState<StockRisk | "ALL" | "AT RISK">("ALL");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "finalQtyToRestock", desc: true });
  const [open, setOpen] = useState<string | null>(null);
  const [period, setPeriod] = useState<"daily" | "weekly" | "monthly">("daily");

  const a = useMemo(() => (data?.asOf ? analyzeGodown(data.consolidated.rows, data.history, data.asOf) : null), [data]);
  const counts = useMemo(() => {
    const c = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<GodownStatus, number>;
    a?.products.forEach((p) => c[p.status]++);
    return c;
  }, [a]);
  const shown = useMemo(() => {
    if (!a) return [];
    const q = search.trim().toLowerCase();
    const atRisk: StockRisk[] = ["OUT OF STOCK", "CRITICAL", "HIGH"];
    const rows = a.products.filter((p) => (!q || p.product.toLowerCase().includes(q))
      && (!statuses.size || statuses.has(p.status))
      && (risk === "ALL" || (risk === "AT RISK" ? atRisk.includes(p.risk) : p.risk === risk)));
    const f = SORTERS[sort.key];
    return rows.sort((x, y) => (sort.desc ? -f(x, y) : f(x, y)) || x.product.localeCompare(y.product));
  }, [a, search, statuses, risk, sort]);

  const kpi = useMemo(() => {
    if (!a) return null;
    const last30 = a.daily.filter((d) => d.date >= addDays(a.asOf, -(GA_RULES.baselineDays - 1)));
    const covered = last30.filter((d) => d.units !== null);
    const units = covered.reduce((s, d) => s + (d.units ?? 0), 0);
    return {
      units, covered: covered.length, rate: covered.length ? units / covered.length : null,
      atRisk: a.products.filter((p) => ["OUT OF STOCK", "CRITICAL", "HIGH"].includes(p.risk)).length,
      restock: a.products.reduce((s, p) => s + p.finalQtyToRestock, 0),
    };
  }, [a]);

  const toggleStatus = (s: GodownStatus) => setStatuses((cur) => { const n = new Set(cur); if (n.has(s)) n.delete(s); else n.add(s); return n; });
  const th = (key: SortKey | null, label: React.ReactNode, cls = "text-right") => (
    <th className={`whitespace-nowrap px-2.5 py-2.5 ${cls} ${key ? "cursor-pointer select-none hover:underline" : ""}`}
      onClick={key ? () => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "product" })) : undefined}
      aria-sort={key && sort.key === key ? (sort.desc ? "descending" : "ascending") : undefined}>
      {label}{key && sort.key === key ? (sort.desc ? " ↓" : " ↑") : ""}
    </th>
  );
  const td = "px-2.5 py-2 text-right tabular-nums";

  const dailyData = a ? a.daily.map((d) => ({ x: dayLabel(d.date), units: d.units })) : [];
  const periodData = a && period !== "daily" ? (period === "weekly" ? a.weekly : a.monthly).map((p) => ({ x: p.label, units: p.units, rate: p.ratePerDay, covered: p.coveredDays, of: p.calendarDays, partial: p.partial })) : [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Godown Stock Analytics</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {isLoading ? <>Loading godown history…</> : a ? <>History <b className="text-foreground">{dateLong(a.coverage.firstDate)} – {dateLong(a.coverage.lastDate)}</b> · latest godown day up to {dateLong(asOfPicked ?? null)} · current stock as on <b className="text-foreground">{dateLong(data?.consolidated.snapshotDate ?? null)}</b></> : <>No godown history up to {dateLong(asOfPicked ?? null)}</>}
          </p>
          {data?.consolidated.weekly && <p className="mt-0.5 text-xs text-muted-foreground">{weeklyLabel(data.consolidated.weekly)}</p>}
        </div>
        <InventoryTabs />
      </div>

      {isLoading ? (
        <div className="py-16 text-sm text-muted-foreground">Loading godown history…</div>
      ) : isError ? (
        <QueryErrorState message={`Godown analytics couldn't load: ${(error as Error)?.message ?? "unknown error"}`} onRetry={() => refetch()} />
      ) : !a || !kpi ? (
        <div className="glass rounded-2xl border border-border p-10 text-center text-sm font-semibold">No godown stock uploaded yet. Upload the godown sheet on the Consolidated Stock page.</div>
      ) : (
        <>
          <div role="alert" id="coverage-warning" className="rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/60 dark:text-amber-200">
            <p className="flex items-center gap-1.5 font-bold"><AlertTriangle className="h-4 w-4 shrink-0" /> Data coverage: {a.coverage.coveredDays} godown days out of {a.coverage.calendarDays} calendar days ({dec(a.coverage.coveragePct, 0)}%)</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-6">{a.coverage.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          </div>
          {data?.consolidated.weekly && data.consolidated.weekly.status !== "ok" && (
            <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-xs font-semibold text-amber-900 dark:border-amber-700 dark:bg-amber-950/60 dark:text-amber-200">{weeklyLabel(data.consolidated.weekly)}</div>
          )}

          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <KPICard title="Products" value={int(a.products.length)} subtitle="On the current godown sheet" accent="purple" />
            <KPICard title="Shipped, last 30 days" value={int(kpi.units)} subtitle={`Actual · ${kpi.covered} godown days of 30`} accent="blue" />
            <KPICard title="Average per godown day" value={dec(kpi.rate)} subtitle="Estimate · last 30 days, gaps left out" accent="cyan" />
            <KPICard title="Stock-out risk" value={int(kpi.atRisk)} subtitle={`Out of stock or under ${GA_RULES.highDays} days left (est.)`} accent="orange" onClick={() => setRisk("AT RISK")} />
            <KPICard title="Final qty to restock" value={int(kpi.restock)} subtitle="Estimate · same as Consolidated sheet" accent="green" />
          </div>

          <div className="glass rounded-2xl border border-border p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-bold">Units shipped — all products</p>
                <p className="text-[11px] text-muted-foreground">{period === "daily" ? "Breaks in the line are dates with no godown upload — not zero sales." : "Totals over godown days only; partial periods are marked in the tooltip."}</p>
              </div>
              <div className="inline-flex rounded-lg border border-border p-0.5 text-[11px] font-bold">
                {(["daily", "weekly", "monthly"] as const).map((p) => (
                  <button key={p} onClick={() => setPeriod(p)} className={`rounded-md px-2.5 py-1 capitalize ${period === p ? "bg-indigo-600 text-white" : "text-muted-foreground"}`}>{p}</button>
                ))}
              </div>
            </div>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                {period === "daily" ? (
                  <LineChart data={dailyData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke={P.grid} vertical={false} />
                    <XAxis dataKey="x" tick={{ fill: P.axis, fontSize: 10 }} interval="preserveStartEnd" minTickGap={24} />
                    <YAxis tick={{ fill: P.axis, fontSize: 10 }} width={44} />
                    <Tooltip contentStyle={{ background: P.surface, color: P.text, fontSize: 12 }} formatter={(v) => (v === null || v === undefined ? "No upload (gap)" : int(Number(v)))} />
                    <Line type="linear" dataKey="units" name="Units shipped" stroke={P.s1} strokeWidth={2} dot={{ r: 1.5 }} connectNulls={false} isAnimationActive={false} />
                  </LineChart>
                ) : (
                  <ComposedChart data={periodData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke={P.grid} vertical={false} />
                    <XAxis dataKey="x" tick={{ fill: P.axis, fontSize: 10 }} />
                    <YAxis yAxisId="u" tick={{ fill: P.axis, fontSize: 10 }} width={50} />
                    <YAxis yAxisId="r" orientation="right" tick={{ fill: P.axis, fontSize: 10 }} width={40} />
                    <Tooltip contentStyle={{ background: P.surface, color: P.text, fontSize: 12 }}
                      labelFormatter={(l, pl) => { const d = pl?.[0]?.payload as { covered: number; of: number; partial: boolean } | undefined; return d ? `${l} · ${d.covered} of ${d.of} days uploaded${d.partial ? " (partial)" : ""}` : String(l); }}
                      formatter={(v, n) => (n === "Avg/day (est.)" ? dec(Number(v)) : int(Number(v)))} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar yAxisId="u" dataKey="units" name="Units shipped" fill={P.s1} radius={[3, 3, 0, 0]} isAnimationActive={false} />
                    <Line yAxisId="r" dataKey="rate" name="Avg/day (est.)" stroke={P.s2} strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} />
                  </ComposedChart>
                )}
              </ResponsiveContainer>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-1.5">
              {STATUS_ORDER.map((s) => (
                <button key={s} onClick={() => toggleStatus(s)} aria-pressed={statuses.has(s)}
                  className={`rounded-lg border px-2 py-1 text-[11px] font-bold transition ${statuses.has(s) ? "border-indigo-600 bg-indigo-600 text-white" : "border-border bg-background text-muted-foreground hover:text-foreground"}`}>
                  {STATUS_META[s].label} <span className="tabular-nums opacity-80">({counts[s]})</span>
                </button>
              ))}
              {statuses.size > 0 && <button onClick={() => setStatuses(new Set())} className="px-2 text-[11px] font-bold text-indigo-600 underline">Clear</button>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select id="risk-filter" value={risk} onChange={(e) => setRisk(e.target.value as typeof risk)} className="rounded-lg border border-border bg-background px-2 py-2 text-xs">
                <option value="ALL">All stock-out risks</option>
                <option value="AT RISK">At risk (out / critical / high)</option>
                {RISK_ORDER.map((r) => <option key={r} value={r}>{RISK_META[r].label}</option>)}
              </select>
              <label className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input id="analytics-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search product" className="w-56 rounded-lg border border-border bg-background py-2 pl-8 pr-3 text-xs" />
              </label>
              <button onClick={() => exportGodownAnalytics(a, shown)} disabled={!shown.length} className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-3.5 py-2 text-xs font-bold hover:bg-muted disabled:opacity-60">
                <Download className="h-3.5 w-3.5" /> Export Excel
              </button>
            </div>
          </div>

          <div className="glass overflow-hidden rounded-2xl border border-border">
            <p className="flex items-center gap-1.5 border-b border-border px-3 py-2 text-[11px] text-muted-foreground">
              <Info className="h-3.5 w-3.5" /> {shown.length} of {a.products.length} products · plain numbers are actual (godown sheet / Monday snapshot), <Est /> = estimate · growth = last 7 days vs days 8–30, per godown day · click a product for its daily chart
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs" id="analytics-table">
                <thead className="bg-[#C5E0B3] text-[10px] uppercase tracking-wider text-[#1f3d12] dark:bg-[#2f4a24] dark:text-[#dcefd0]">
                  <tr>
                    {th("product", "Product", "text-left")}
                    {th("status", "Status", "text-left")}
                    {th("units30", "Shipped 30d")}
                    {th("rate7", <>Avg/day 7d<Est /></>)}
                    {th("growthPct", <>Growth<Est /></>)}
                    {th("peakQty", "Peak day")}
                    {th("currentStock", "Current stock")}
                    {th("daysLeft", <>Days left<Est /></>)}
                    {th("risk", "Stock-out risk", "text-left")}
                    {th(null, "In transit")}
                    {th(null, "Order placed")}
                    {th("finalQtyToRestock", <>Final restock<Est /></>)}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((p) => (
                    <Fragment key={p.product}>
                      <tr className="cursor-pointer border-t border-border/60 hover:bg-muted/30" onClick={() => setOpen(open === p.product ? null : p.product)}>
                        <td className="px-3 py-2 font-semibold"><span className="inline-flex items-center gap-1">{open === p.product ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{p.product}{p.discontinued && <span className="ml-1 rounded bg-zinc-200 px-1 text-[9px] text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200">discontinued</span>}</span></td>
                        <td className="px-2.5 py-2" title={p.statusWhy}><StatusBadge s={p.status} /></td>
                        <td className={td} title={`${p.covered30} godown days of 30`}>{int(p.units30)}<span className="text-[9px] text-muted-foreground"> /{p.covered30}d</span></td>
                        <td className={td}>{dec(p.rate7)}</td>
                        <td className={`${td} ${p.growthPct !== null && p.growthPct <= -GA_RULES.growthPct ? "text-red-600 dark:text-red-400" : p.growthPct !== null && p.growthPct >= GA_RULES.growthPct ? "text-emerald-700 dark:text-emerald-400" : ""}`}>{pct(p.growthPct)}</td>
                        <td className={td} title={p.peakDate ?? ""}>{int(p.peakQty)}</td>
                        <td className={`${td} font-bold`}>{int(p.currentStock)}</td>
                        <td className={td} title={p.runOutDate ? `Runs out around ${dateLong(p.runOutDate)} (estimate)` : ""}>{int(p.daysLeft)}</td>
                        <td className="px-2.5 py-2"><RiskBadge r={p.risk} /></td>
                        <td className={td}>{int(p.stockIntransit)}</td>
                        <td className={td}>{int(p.orderPlaced)}</td>
                        <td className={`${td} font-bold`}>{int(p.finalQtyToRestock)}</td>
                      </tr>
                      {open === p.product && <tr><td colSpan={12} className="bg-muted/20 p-0"><Drill p={p} data={data as GodownAnalyticsData} from={a.coverage.firstDate as string} to={a.asOf} P={P} /></td></tr>}
                    </Fragment>
                  ))}
                  {!shown.length && <tr><td colSpan={12} className="px-3 py-10 text-center text-muted-foreground">No products match these filters.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Drill({ p, data, from, to, P }: { p: ProductAnalytics; data: GodownAnalyticsData; from: string; to: string; P: typeof PALETTE.light }) {
  const series = useMemo(() => productSeries(data.history, p.product, from, to).map((d) => ({ ...d, x: dayLabel(d.date) })), [data, p.product, from, to]);
  const item = (label: React.ReactNode, value: React.ReactNode) => <div><p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p><p className="text-sm font-bold tabular-nums">{value}</p></div>;
  return (
    <div className="space-y-3 p-4" id="product-drilldown">
      <p className="text-xs"><StatusBadge s={p.status} /> <span className="ml-1 text-muted-foreground">{p.statusWhy}</span></p>
      <p className="text-xs font-semibold" id="drill-recommendation">Recommendation: {p.recommendation}</p>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={series} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={P.grid} vertical={false} />
            <XAxis dataKey="x" tick={{ fill: P.axis, fontSize: 10 }} interval="preserveStartEnd" minTickGap={24} />
            <YAxis yAxisId="u" tick={{ fill: P.axis, fontSize: 10 }} width={40} />
            <YAxis yAxisId="c" orientation="right" tick={{ fill: P.axis, fontSize: 10 }} width={50} />
            <Tooltip contentStyle={{ background: P.surface, color: P.text, fontSize: 12 }} formatter={(v) => (v === null || v === undefined ? "No upload (gap)" : int(Number(v)))} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar yAxisId="u" dataKey="units" name="Units shipped (actual)" fill={P.s1} isAnimationActive={false} />
            <Line yAxisId="c" dataKey="closing" name="Closing stock, godown sheet rows (actual)" stroke={P.s2} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="text-[11px] text-muted-foreground">Missing bars and breaks in the line are dates with no godown upload. Closing stock is the godown sheet&apos;s daily Closing for this product&apos;s rows; current stock below also counts inbound, unfulfillable, QC and packing godown stock.</p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        {item("Shipped last 7 days", <>{int(p.units7)} <span className="text-[10px] font-normal text-muted-foreground">({p.covered7} godown days)</span></>)}
        {item("Shipped last 30 days", <>{int(p.units30)} <span className="text-[10px] font-normal text-muted-foreground">({p.covered30} godown days)</span></>)}
        {item(<>Avg/day 7d / days 8–30<Est /></>, `${dec(p.rate7)} / ${dec(p.ratePrior)}`)}
        {item("Peak day", p.peakQty === null ? "—" : `${int(p.peakQty)} on ${dateLong(p.peakDate)}`)}
        {item("Last sale", dateLong(p.lastSaleDate))}
        {item(<>Overall avg / median per godown day<Est /></>, `${dec(p.meanPerDay)} / ${dec(p.medianPerDay)}`)}
        {item(<>Best month<Est /></>, p.bestMonth ? `${new Date(p.bestMonth.month + "-01T00:00:00Z").toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" })} · ${dec(p.bestMonth.ratePerDay)}/day${p.bestMonth.partial ? ` (${p.bestMonth.coveredDays} of ${p.bestMonth.daysInMonth} days)` : ""}` : "—")}
        {item("Current stock", int(p.currentStock))}
        {item(<>Avg/day, 10 godown days<Est /></>, dec(p.avgPerDay))}
        {item(<>Days of stock left<Est /></>, int(p.daysLeft))}
        {item(<>Runs out around<Est /></>, dateLong(p.runOutDate))}
        {item("In transit (Monday)", int(p.stockIntransit))}
        {item("Order placed (Monday)", int(p.orderPlaced))}
        {item("Purchase sheet qty (Monday)", int(p.purchaseQty))}
        {item(<>Need for 180 days<Est /></>, int(p.need180))}
        {item(<>Qty to restock<Est /></>, int(p.qtyToRestock))}
        {item(<>Final qty to restock<Est /></>, int(p.finalQtyToRestock))}
        {item("Combo component qty (Monday)", int(p.comboQty))}
      </div>
    </div>
  );
}
