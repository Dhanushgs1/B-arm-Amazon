"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer, ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, BarChart, Bar, Legend,
} from "recharts";
import { ArrowDownRight, ArrowUpRight, CheckCircle2, AlertTriangle, Lightbulb, LineChart as LineIcon, RefreshCw, Target, Info } from "lucide-react";
import { useDashboard } from "@/lib/DashboardContext";
import { QueryErrorState } from "@/components/QueryErrorState";
import { EmptyState } from "@/components/EmptyState";
import { cn } from "@/lib/utils";
import { addDaysIso } from "@/lib/bi/forecast";
import {
  windowEnding, reportWindow, previousWindow, monthToDate, likeForLike, totals, channelPeriod, channelForecasts, combineForecasts,
  monthEndEstimate, productRows, rankProducts, adChannels, campaignFindings, healthScore, buildInsights, monthly,
  sumWindow, pctChange, comparableChannel, type Insight, type ProductRow, type Window,
} from "@/lib/bi/analytics";
import type { BiDataset, SalesChannelId } from "@/lib/bi/types";

type Dataset = BiDataset & { cacheAgeSeconds?: number; refreshing?: boolean };

// ── formatting ────────────────────────────────────────────────────────────────────────────────
const inr = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `₹${Math.round(v).toLocaleString("en-IN")}`);
const inrShort = (v: number) => (v >= 1e7 ? `₹${(v / 1e7).toFixed(2)} Cr` : v >= 1e5 ? `₹${(v / 1e5).toFixed(1)} L` : v >= 1e3 ? `₹${(v / 1e3).toFixed(1)}K` : `₹${Math.round(v)}`);
const num = (v: number | null | undefined) => (v === null || v === undefined ? "—" : Math.round(v).toLocaleString("en-IN"));
const dot = (iso: string) => iso.split("-").reverse().join(".");
const dayLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const monthLabel = (ym: string) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "short", year: "2-digit", timeZone: "UTC" });

const CH_COLOR: Record<SalesChannelId, string> = {
  amazon: "var(--series-amazon)", flipkart: "var(--series-flipkart)", meesho: "var(--series-meesho)", shopify: "var(--series-shopify)", barm: "var(--series-barm)",
};
const CH_HREF: Record<string, string> = { amazon: "/dashboard", flipkart: "/dashboard/flipkart", meesho: "/dashboard/meesho", shopify: "/dashboard/shopify", barm: "/dashboard/barm", google: "/dashboard/shopify/sources", meta: "/dashboard/shopify/sources" };

// ── small building blocks ─────────────────────────────────────────────────────────────────────
function Section({ title, subtitle, children, action, id }: { title: string; subtitle?: string; children: React.ReactNode; action?: React.ReactNode; id?: string }) {
  return (
    <section id={id} className="rounded-2xl border border-border bg-card shadow-sm p-5 sm:p-6 min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h2 className="text-[15px] font-bold tracking-tight text-foreground">{title}</h2>
          {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Change({ pct, inverse, label }: { pct: number | null; inverse?: boolean; label?: string }) {
  if (pct === null) return <span className="text-xs text-muted-foreground">{label ?? "no like-for-like comparison"}</span>;
  const up = pct >= 0;
  const good = inverse ? !up : up;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-xs font-semibold tabular-nums")} style={{ color: good ? "var(--status-good)" : "var(--status-bad)" }}>
      <Icon className="w-3.5 h-3.5" aria-hidden="true" />
      {up ? "+" : ""}{pct.toFixed(1)}%
      <span className="sr-only">{good ? "(better)" : "(worse)"}</span>
    </span>
  );
}

function Tile({ label, value, sub, children, badge }: { label: string; value: string; sub?: React.ReactNode; children?: React.ReactNode; badge?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card shadow-sm p-4 sm:p-5 min-w-0 flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-muted-foreground">{label}</p>
        {badge && <span className="text-[10px] font-bold uppercase tracking-wide rounded-full px-2 py-0.5 bg-muted text-muted-foreground">{badge}</span>}
      </div>
      <p className="text-2xl sm:text-[26px] font-bold tracking-tight tabular-nums text-foreground">{value}</p>
      {sub && <div className="text-xs text-muted-foreground leading-snug">{sub}</div>}
      {children}
    </div>
  );
}

const KIND_META: Record<Insight["kind"], { label: string; icon: typeof Info; cls: string }> = {
  recommendation: { label: "Recommendation", icon: Lightbulb, cls: "bg-amber-500/10 text-amber-700 dark:text-amber-300" },
  fact: { label: "Fact", icon: CheckCircle2, cls: "bg-sky-500/10 text-sky-700 dark:text-sky-300" },
  estimate: { label: "Estimate", icon: LineIcon, cls: "bg-violet-500/10 text-violet-700 dark:text-violet-300" },
};

function Tabs<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { id: T; label: string; count?: number }[]; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button key={o.id} role="tab" aria-selected={value === o.id} onClick={() => onChange(o.id)}
          className={cn("text-xs font-semibold rounded-lg px-3 py-1.5 border transition-colors",
            value === o.id ? "bg-foreground text-background border-foreground" : "border-border text-muted-foreground hover:text-foreground")}>
          {o.label}{o.count !== undefined && <span className="ml-1 opacity-70 tabular-nums">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ── monthly target (kept in this browser until a targets table is approved) ──────────────────
function useMonthlyTarget(month: string) {
  const key = `m360ExecTarget:${month}`;
  const [, bump] = useState(0);
  const raw = useSyncExternalStore(
    (cb) => { window.addEventListener("storage", cb); return () => window.removeEventListener("storage", cb); },
    () => { try { return localStorage.getItem(key); } catch { return null; } },
    () => null,
  );
  const v = Number(raw);
  const target = raw && Number.isFinite(v) && v > 0 ? v : null;
  const save = (next: number | null) => {
    try { if (next) localStorage.setItem(key, String(next)); else localStorage.removeItem(key); } catch { /* storage unavailable */ }
    bump((n) => n + 1);
  };
  return [target, save] as const;
}

// ── page ──────────────────────────────────────────────────────────────────────────────────────
export function ExecutiveDashboard() {
  const { loggedInUser } = useDashboard();
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<Dataset>({
    queryKey: ["bi-dataset"],
    queryFn: async () => {
      const r = await fetch("/api/bi/dataset");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      return j as Dataset;
    },
    staleTime: 10 * 60_000,
  });

  if (loggedInUser === "Lkn") {
    return <EmptyState title="The executive overview covers B-ARM's channels" description="Sign in with the B-ARM account to see it." />;
  }
  if (isLoading) {
    return (
      <div role="status" aria-label="Building the business overview" className="space-y-5">
        <div className="space-y-2"><div className="h-7 w-64 rounded-lg bg-muted animate-pulse" /><div className="h-4 w-96 max-w-full rounded bg-muted animate-pulse" /></div>
        <p className="text-sm text-muted-foreground">Building the overview from seven months of orders, ads and stock. The first load after a restart takes up to a minute; later loads are instant.</p>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-28 rounded-2xl bg-muted animate-pulse" />)}</div>
        <div className="h-80 rounded-2xl bg-muted animate-pulse" />
      </div>
    );
  }
  if (isError || !data) return <QueryErrorState message={error instanceof Error ? error.message : undefined} onRetry={() => refetch()} />;
  return <Overview ds={data} refreshing={!!data.refreshing || isFetching} onRefresh={() => refetch()} />;
}

const PERIODS = [{ id: "7", label: "7 days" }, { id: "30", label: "30 days" }, { id: "90", label: "90 days" }] as const;

function Overview({ ds, refreshing, onRefresh }: { ds: Dataset; refreshing: boolean; onRefresh: () => void }) {
  const [periodId, setPeriodId] = useState<"7" | "30" | "90">("30");
  const [only, setOnly] = useState<SalesChannelId | "all">("all");
  const sel = useMemo(() => (only === "all" ? undefined : [only]), [only]);
  // KPIs end on the last day every included channel has data, so a channel uploaded later does not drop out.
  const reportEnd = useMemo(() => {
    const ends = ds.channels.filter((c) => c.dataThrough && !c.closedNote && (!sel || sel.includes(c.id))).map((c) => c.dataThrough!).sort();
    const fallback = ends[0] ?? ds.asOf;
    // with an Intervals row, the report runs to its To date (the same window as the weekly reports)
    return ds.intervals ? ds.intervals.to30 : fallback;
  }, [ds, sel]);
  const w: Window = reportWindow(ds, Number(periodId) as 7 | 30 | 90, reportEnd);
  const w30: Window = reportWindow(ds, 30, reportEnd);
  const prev = previousWindow(w);

  const a = useMemo(() => {
    const lfl = likeForLike(ds, w, prev, sel);
    const cur = totals(ds, w, sel);
    const mtd = monthToDate(reportEnd);
    const mtdL = likeForLike(ds, mtd.current, mtd.previous, sel);
    const fcs = channelForecasts(ds, sel);
    const horizons = [7, 15, 30, 90].map((h) => combineForecasts(fcs, h));
    const me = monthEndEstimate(ds, fcs);
    const rows = productRows(ds, 30, sel);
    const ranks = rankProducts(rows, 10);
    const ads = adChannels(ds, w);
    const camp = campaignFindings(ds);
    const health = healthScore(ds, w30);
    const insights = buildInsights(ds, w30);
    return { lfl, cur, mtd, mtdL, fcs, horizons, me, ranks, ads, camp, health, insights, months: monthly(ds) };
  }, [ds, w.start, w.end, prev.start, sel?.[0]]); // eslint-disable-line react-hooks/exhaustive-deps

  const latest = ds.channels.filter((c) => c.dataThrough && !c.closedNote && (!sel || sel.includes(c.id))).map((c) => {
    const i = ds.dates.indexOf(c.dataThrough!);
    return { c, day: c.dataThrough!, revenue: c.revenue[i], dayBefore: i > 0 ? c.revenue[i - 1] : null };
  });
  const returnRate = a.cur.units > 0 ? (a.cur.returns / a.cur.units) * 100 : null;
  const [target, setTarget] = useMonthlyTarget(a.me.month);

  return (
    <div className="space-y-5 pb-12">
      {/* header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Business overview</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {dot(w.start)} – {dot(w.end)} vs {dot(prev.start)} – {dot(prev.end)} · {ds.intervals && periodId !== "90" ? "report window from Intervals" : ds.intervals ? "ending on the Intervals To date" : "data as of each channel's last upload"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Tabs label="Period" value={periodId} onChange={setPeriodId} options={PERIODS.map((p) => ({ id: p.id, label: p.label }))} />
          <Tabs label="Channel" value={only} onChange={setOnly} options={[{ id: "all" as const, label: "All" }, ...ds.channels.map((c) => ({ id: c.id, label: c.label }))]} />
          <button onClick={onRefresh} className="inline-flex items-center gap-1.5 text-xs font-semibold rounded-lg px-3 py-1.5 border border-border text-muted-foreground hover:text-foreground" aria-label="Reload the overview">
            <RefreshCw className={cn("w-3.5 h-3.5", refreshing && "animate-spin")} aria-hidden="true" /> {refreshing ? "Updating…" : "Reload"}
          </button>
        </div>
      </div>

      {/* data freshness strip */}
      <div className="flex flex-wrap gap-2" aria-label="Data freshness">
        {ds.channels.map((c) => {
          const lag = c.dataThrough ? Math.round((Date.parse(ds.asOf) - Date.parse(c.dataThrough)) / 86_400_000) : null;
          return (
            <span key={c.id} className="inline-flex items-center gap-1.5 text-xs rounded-full border border-border bg-card px-2.5 py-1">
              <span className="w-2 h-2 rounded-full" style={{ background: CH_COLOR[c.id] }} aria-hidden="true" />
              <span className="font-semibold text-foreground">{c.label}</span>
              <span className={cn("text-muted-foreground", !c.closedNote && lag !== null && lag > 3 && "text-amber-700 dark:text-amber-400 font-semibold")}>
                {c.closedNote ? `history to ${c.dataThrough ? dayLabel(c.dataThrough) : "—"} · ${c.closedNote}` : c.dataThrough ? `through ${dayLabel(c.dataThrough)}` : "no data"}
              </span>
            </span>
          );
        })}
        {ds.errors.map((e) => (
          <span key={e.source} className="inline-flex items-center gap-1.5 text-xs rounded-full border border-red-300 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 px-2.5 py-1">
            <AlertTriangle className="w-3 h-3" aria-hidden="true" /> {e.source} could not load — left out
          </span>
        ))}
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <Tile label={`Revenue · last ${w.days} days`} value={inr(a.cur.revenue)}
          sub={<><Change pct={a.lfl.revenuePct} /> <span>vs previous {w.days} days{a.lfl.channels.length < a.cur.included.length ? ` (${a.lfl.channels.length} channels comparable)` : ""}</span>
            {a.cur.partial.length > 0 && <p className="mt-1">Not included (missing days): {a.cur.partial.map((p) => p.label).join(", ")}</p>}</>} />
        <Tile label="Units sold" value={num(a.cur.units)} sub={<><Change pct={a.lfl.unitsPct} /> <span>vs previous {w.days} days</span></>} />
        <Tile label="Returns" value={num(a.cur.returns)} sub={returnRate === null ? "no returns data" : `${returnRate.toFixed(1)}% of units · net units ${num(a.cur.units - a.cur.returns)}`} />
        <Tile label="Month to date" value={inr(a.mtdL.current.revenue)}
          sub={<><Change pct={a.mtdL.revenuePct} /> <span>vs the same {a.mtd.current.days} days last month</span></>} />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Tile label="Latest day per channel" value={inr(latest.reduce((s, l) => s + (l.revenue ?? 0), 0))}
          sub={<><p>Change vs the day before</p><ul className="space-y-0.5 mt-1">{latest.map((l) => (
            <li key={l.c.id} className="flex justify-between gap-2"><span>{l.c.label} · {dayLabel(l.day)}</span><span className="tabular-nums text-foreground">{inr(l.revenue)} <Change pct={pctChange(l.revenue, l.dayBefore)} label="" /></span></li>
          ))}</ul></>} badge="Actual" />
        <Tile label={`Expected ${monthLabel(a.me.month)} revenue`} value={inr(a.me.estimate)} badge="Estimate"
          sub={<>80% range {inrShort(a.me.low)} – {inrShort(a.me.high)} · {inr(a.me.actualSoFar)} sold so far (each channel up to its last upload), the rest forecast</>}>
          <TargetBar target={target} setTarget={setTarget} estimate={a.me.estimate} actual={a.me.actualSoFar} />
        </Tile>
        <HealthTile health={a.health} />
      </div>

      {/* trend + forecast */}
      <Section title="Revenue trend and forecast" subtitle="Daily revenue for the last 90 days, then the forecast for the next 30 with its 80% range. Forecast days are estimates, not results.">
        <TrendChart ds={ds} sel={sel} fcs={a.fcs} />
      </Section>

      {/* insights */}
      <Insights items={a.insights} />

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <ForecastTable horizons={a.horizons} fcs={a.fcs} />
        <MonthlyChart months={a.months} ds={ds} />
      </div>

      <ChannelTable ds={ds} w={w} sel={sel} ads={a.ads} />
      <ProductSection ranks={a.ranks} />
      <AdsSection ds={ds} ads={a.ads} camp={a.camp} w={w} />

      {ds.notes.length > 0 && (
        <Section title="About this data">
          <ul className="space-y-1.5 text-xs text-muted-foreground list-disc pl-4">
            {ds.notes.map((n) => <li key={n}>{n}</li>)}
            {ds.channels.map((c) => <li key={c.id}><span className="font-semibold text-foreground">{c.label} revenue:</span> {c.basis}.</li>)}
            <li>Built {new Date(ds.generatedAt).toLocaleString("en-IN")} from the uploaded reports in Supabase; rebuilt every 20 minutes.</li>
          </ul>
        </Section>
      )}
    </div>
  );
}

function TargetBar({ target, setTarget, estimate, actual }: { target: number | null; setTarget: (v: number | null) => void; estimate: number; actual: number }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  if (editing) {
    return (
      <form className="flex gap-2 mt-2" onSubmit={(e) => { e.preventDefault(); const v = Number(draft.replace(/[^\d.]/g, "")); setTarget(v > 0 ? v : null); setEditing(false); }}>
        <label className="sr-only" htmlFor="exec-target">Monthly revenue target in rupees</label>
        <input id="exec-target" autoFocus inputMode="numeric" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="e.g. 15000000" className="flex-1 min-w-0 rounded-lg border border-border bg-background px-2 py-1 text-xs" />
        <button className="text-xs font-semibold rounded-lg px-2.5 py-1 bg-foreground text-background">Save</button>
      </form>
    );
  }
  if (!target) {
    return <button onClick={() => { setDraft(""); setEditing(true); }} className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-primary"><Target className="w-3.5 h-3.5" aria-hidden="true" /> Set a monthly target</button>;
  }
  const pctActual = Math.min(100, (actual / target) * 100), pctEst = Math.min(100, (estimate / target) * 100);
  return (
    <div className="mt-2 space-y-1">
      <div className="h-2 rounded-full bg-muted overflow-hidden relative" role="img" aria-label={`${pctActual.toFixed(0)}% of target reached, ${pctEst.toFixed(0)}% expected by month end`}>
        <div className="absolute inset-y-0 left-0 bg-foreground/20" style={{ width: `${pctEst}%` }} />
        <div className="absolute inset-y-0 left-0 bg-foreground" style={{ width: `${pctActual}%` }} />
      </div>
      <p className="text-xs text-muted-foreground">
        Target {inrShort(target)} · {((actual / target) * 100).toFixed(0)}% reached, {((estimate / target) * 100).toFixed(0)}% expected{" "}
        <button onClick={() => { setDraft(String(target)); setEditing(true); }} className="font-semibold text-primary">Edit</button>
        <span className="block opacity-80">Saved in this browser only.</span>
      </p>
    </div>
  );
}

function HealthTile({ health }: { health: ReturnType<typeof healthScore> }) {
  const [open, setOpen] = useState(false);
  const s = health.score;
  const tone = s === null ? "text-muted-foreground" : s >= 70 ? "text-[color:var(--status-good)]" : s >= 45 ? "text-amber-600 dark:text-amber-400" : "text-[color:var(--status-bad)]";
  return (
    <div className="rounded-2xl border border-border bg-card shadow-sm p-4 sm:p-5 min-w-0">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-muted-foreground">Business health · last 30 days</p>
        <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className="text-xs font-semibold text-primary">{open ? "Hide" : "How it's scored"}</button>
      </div>
      <p className={cn("text-2xl sm:text-[26px] font-bold tabular-nums mt-1.5", tone)}>{s === null ? "—" : `${Math.round(s)} / 100`}</p>
      <ul className="mt-2 space-y-1.5">
        {health.parts.map((p) => (
          <li key={p.name} className="text-xs">
            <div className="flex justify-between gap-2"><span className="text-foreground font-medium">{p.name} <span className="text-muted-foreground font-normal">· {p.weight}%</span></span><span className="tabular-nums">{p.score === null ? "n/a" : Math.round(p.score)}</span></div>
            <div className="h-1.5 rounded-full bg-muted mt-1 overflow-hidden"><div className="h-full bg-foreground/70" style={{ width: `${p.score ?? 0}%` }} /></div>
            {open && <p className="text-muted-foreground mt-1">{p.detail}. Scale: {p.rule}.</p>}
          </li>
        ))}
      </ul>
      {open && <p className="text-[11px] text-muted-foreground mt-2">Score = weighted average of the parts that have data; parts without data are left out and the weights re-spread.</p>}
    </div>
  );
}

function TrendChart({ ds, sel, fcs }: { ds: BiDataset; sel?: SalesChannelId[]; fcs: ReturnType<typeof channelForecasts> }) {
  const data = useMemo(() => {
    const chans = ds.channels.filter((c) => !sel || sel.includes(c.id));
    const fcOk = fcs.filter((f) => f.revenue.ok);
    // actuals: last 90 days up to the earliest last-upload among channels (so the line never drops at a ragged end)
    const end = chans.filter((c) => !c.closedNote || chans.length === 1).map((c) => c.dataThrough).filter(Boolean).sort()[0] ?? ds.asOf;
    const endIdx = ds.dates.indexOf(end);
    const rows: Record<string, number | string | null | [number, number]>[] = [];
    for (let i = Math.max(0, endIdx - 89); i <= endIdx; i++) {
      let v = 0, any = false;
      for (const c of chans) { const x = c.revenue[i]; if (x !== null) { v += x; any = true; } }
      rows.push({ date: ds.dates[i], label: dayLabel(ds.dates[i]), actual: any ? v : null, forecast: null, range: null });
    }
    // forecast: sum of channel forecasts aligned by calendar day
    for (let h = 1; h <= 30; h++) {
      const d = addDaysIso(end, h);
      let v = 0, varSum = 0;
      for (const f of fcOk) {
        if (!f.revenue.ok || !f.lastActual) continue;
        const k = Math.round((Date.parse(d) - Date.parse(f.lastActual)) / 86_400_000) - 1;
        if (k < 0) { const ch = ds.channels.find((c) => c.id === f.id)!; v += ch.revenue[ds.dates.indexOf(d)] ?? 0; continue; }
        v += f.revenue.daily[k] ?? 0;
        const spread30 = f.revenue.horizons[30].high - f.revenue.horizons[30].total;
        varSum += (spread30 / 1.2816 / Math.sqrt(30)) ** 2;
      }
      const s = 1.2816 * Math.sqrt(varSum);
      rows.push({ date: d, label: dayLabel(d), actual: null, forecast: v, range: [Math.max(0, v - s), v + s] });
    }
    const last = rows.findLast((r) => r.actual !== null);
    if (last) { last.forecast = last.actual as number; last.range = [last.actual as number, last.actual as number]; }
    return rows;
  }, [ds, sel, fcs]);

  return (
    <div className="h-[300px] sm:h-[340px]" role="img" aria-label="Daily revenue for the last 90 days and the 30-day forecast with its 80% range">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={28} />
          <YAxis tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} width={64} tickFormatter={(v) => inrShort(v)} />
          <Tooltip
            cursor={{ stroke: "var(--muted-foreground)", strokeWidth: 1 }}
            contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 12, fontSize: 12 }}
            formatter={(value: unknown, name: unknown) => {
              if (name === "range" && Array.isArray(value)) return [`${inr(value[0])} – ${inr(value[1])}`, "80% range"];
              return [inr(value as number), name === "actual" ? "Actual" : "Forecast (estimate)"];
            }}
          />
          <Area dataKey="range" stroke="none" fill="var(--series-forecast)" fillOpacity={0.12} isAnimationActive={false} />
          <Line dataKey="actual" stroke="var(--series-amazon)" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
          <Line dataKey="forecast" stroke="var(--series-forecast)" strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function Insights({ items }: { items: Insight[] }) {
  const [kind, setKind] = useState<"all" | Insight["kind"]>("all");
  const shown = items.filter((i) => kind === "all" || i.kind === kind);
  const count = (k: Insight["kind"]) => items.filter((i) => i.kind === k).length;
  return (
    <Section title="What needs attention" subtitle="Every item is computed from the uploaded data; facts are measured, estimates are forecasts, recommendations are rule-based suggestions."
      action={<Tabs label="Insight type" value={kind} onChange={setKind} options={[{ id: "all", label: "All", count: items.length }, { id: "recommendation", label: "Actions", count: count("recommendation") }, { id: "fact", label: "Facts", count: count("fact") }, { id: "estimate", label: "Estimates", count: count("estimate") }]} />}>
      {shown.length === 0 ? <EmptyState compact title="Nothing to flag for this period" /> : (
        <ul className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {shown.map((i, n) => {
            const m = KIND_META[i.kind];
            return (
              <li key={n} className="rounded-xl border border-border p-3.5 flex flex-col sm:flex-row gap-2 sm:gap-3">
                <span className={cn("shrink-0 self-start inline-flex items-center gap-1 h-6 rounded-full px-2 text-[11px] font-bold", m.cls)}><m.icon className="w-3 h-3" aria-hidden="true" />{m.label}</span>
                <div className="min-w-0 space-y-0.5">
                  <p className="text-sm font-semibold text-foreground">{i.title}</p>
                  <p className="text-xs text-muted-foreground">{i.detail}</p>
                  <p className="text-[11px] text-muted-foreground">Period: {i.period}</p>
                  {i.action && <p className="text-xs font-medium text-foreground">→ {i.action}{i.href && <> · <Link href={i.href} className="text-primary font-semibold">Open</Link></>}</p>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function ForecastTable({ horizons, fcs }: { horizons: ReturnType<typeof combineForecasts>[]; fcs: ReturnType<typeof channelForecasts> }) {
  const acc = fcs.flatMap((f) => (f.revenue.ok && f.revenue.avgAbsErrorPct !== null ? [{ label: f.label, err: f.revenue.avgAbsErrorPct, method: f.revenue.method }] : []));
  const noCheck = fcs.filter((f) => f.revenue.ok && f.revenue.avgAbsErrorPct === null).map((f) => f.label);
  const skipped = horizons[0]?.skipped ?? [];
  return (
    <Section title="Sales forecast" subtitle="Estimates from each channel's own history — not results. 80% of outcomes are expected inside the range.">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-muted-foreground border-b border-border"><th scope="col" className="py-2 pr-3 font-semibold">Next</th><th scope="col" className="py-2 pr-3 font-semibold text-right">Revenue</th><th scope="col" className="py-2 pr-3 font-semibold text-right">80% range</th><th scope="col" className="py-2 font-semibold text-right">Units</th></tr></thead>
          <tbody className="divide-y divide-border">
            {horizons.map((h) => (
              <tr key={h.horizon}>
                <td className="py-2 pr-3 font-medium">{h.horizon} days</td>
                <td className="py-2 pr-3 text-right tabular-nums">{h.revenue ? inr(h.revenue.total) : "—"}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">{h.revenue ? `${inrShort(h.revenue.low)} – ${inrShort(h.revenue.high)}` : "—"}</td>
                <td className="py-2 text-right tabular-nums">{h.units ? `${num(h.units.total)} (${num(h.units.low)}–${num(h.units.high)})` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4 space-y-1.5 text-xs text-muted-foreground">
        {acc.length > 0 && <p><span className="font-semibold text-foreground">Accuracy check:</span> forecasts made 4–7 weeks ago for the following 28 days were off on average by {acc.map((x) => `${x.label} ±${x.err.toFixed(0)}% (${x.method})`).join(", ")}.</p>}
        {noCheck.length > 0 && <p>{noCheck.join(" and ")}: too little history to check accuracy yet — treat as a rough guide.</p>}
        {acc.some((x) => x.err > 25) && <p className="text-amber-700 dark:text-amber-400 font-medium">Treat the {acc.filter((x) => x.err > 25).map((x) => x.label).join(" and ")} {acc.filter((x) => x.err > 25).length > 1 ? "forecasts" : "forecast"} with caution: past forecasts missed by more than 25% on average (sale events such as Big Billion Days and festive peaks are not predictable from history yet), so the range above is likely too narrow.</p>}
        {skipped.length > 0 && <p>Not forecast (too little history): {skipped.map((s) => s.id).join(", ")}.</p>}
        <p><span className="font-semibold text-foreground">Method:</span> each channel&apos;s weekday pattern plus its recent level or a damped trend, using 4 or 8 weeks of history — whichever would have forecast that channel best over the last four 28-day checks (shown in brackets above). It does not know about festivals, promotions, stock-outs or price changes, and cannot learn yearly seasonality until there is a full year of history (from April 2027).</p>
      </div>
    </Section>
  );
}

function MonthlyChart({ months, ds }: { months: ReturnType<typeof monthly>; ds: BiDataset }) {
  const data = months.map((m) => ({ ...m, label: `${monthLabel(m.month as string)}${m.complete ? "" : "*"}` }));
  return (
    <Section title="Monthly revenue by channel" subtitle="* = a channel has days missing in that month (e.g. the month in progress), so it is not comparable yet.">
      <div className="h-[260px]" role="img" aria-label="Monthly revenue by channel since April 2026">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="22%">
            <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} width={64} tickFormatter={(v) => inrShort(v)} />
            <Tooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 12, fontSize: 12 }} formatter={(v: unknown, n: unknown) => [inr(v as number), ds.channels.find((c) => c.id === n)?.label ?? String(n)]} />
            <Legend formatter={(n: string) => <span className="text-xs text-muted-foreground">{ds.channels.find((c) => c.id === n)?.label ?? n}</span>} />
            {ds.channels.map((c, i) => (
              <Bar key={c.id} dataKey={c.id} stackId="m" fill={CH_COLOR[c.id]} stroke="var(--card)" strokeWidth={2} radius={i === ds.channels.length - 1 ? [4, 4, 0, 0] : 0} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="text-xs text-muted-foreground mt-2">Peak months cannot be called seasonal yet: there is one partial year of history.</p>
    </Section>
  );
}

function ChannelTable({ ds, w, sel, ads }: { ds: BiDataset; w: Window; sel?: SalesChannelId[]; ads: ReturnType<typeof adChannels> }) {
  const prev = previousWindow(w);
  const rows = ds.channels.filter((c) => !sel || sel.includes(c.id)).map((c) => {
    const like = comparableChannel(ds, c, w, prev);
    const cur = channelPeriod(ds, c, w), curLike = channelPeriod(ds, like, w), before = channelPeriod(ds, like, prev);
    const adId = c.id === "shopify" ? null : c.id;
    const ad = ads.find((x) => x.id === adId);
    const shopifyAds = c.id === "shopify" ? ads.filter((x) => x.id === "google" || x.id === "meta") : [];
    const spendGst = ad ? ad.spendGst : shopifyAds.length ? shopifyAds.reduce((s, x) => s + (x.spendGst ?? 0), 0) : null;
    const adComplete = ad ? ad.complete : shopifyAds.every((x) => x.complete);
    return { c, cur, growth: curLike.complete && before.complete ? pctChange(curLike.revenue, before.revenue) : null, spendGst, adComplete };
  });
  const total = rows.reduce((s, r) => s + (r.cur.complete ? r.cur.revenue ?? 0 : 0), 0);
  const best = [...rows].filter((r) => r.growth !== null).sort((a, b) => b.growth! - a.growth!)[0];
  return (
    <Section title="Marketplace comparison" subtitle={`Last ${w.days} days vs the ${w.days} before. Profit per channel is not shown: there is no reliable product cost data yet.`}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[800px]">
          <thead><tr className="text-left text-xs text-muted-foreground border-b border-border">
            {["Channel", "Revenue", "Share", "Growth", "Units", "Return rate", "Ad spend (incl. GST)", "TACOS"].map((h, i) => <th key={h} scope="col" className={cn("py-2 pr-3 font-semibold", i > 0 && "text-right")}>{h}</th>)}
          </tr></thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.c.id}>
                <td className="py-2.5 pr-3"><Link href={CH_HREF[r.c.id]} className="inline-flex items-center gap-2 font-semibold hover:text-primary"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: CH_COLOR[r.c.id] }} aria-hidden="true" />{r.c.label}</Link>
                  {r.c.id === best?.c.id && <span className="ml-2 text-[10px] font-bold uppercase text-[color:var(--status-good)]">fastest growing</span>}
                  {!r.cur.complete && <span className="block text-[11px] text-amber-700 dark:text-amber-400">{r.cur.covered} of {w.days} days uploaded</span>}</td>
                <td className="py-2.5 pr-3 text-right tabular-nums">{inr(r.cur.revenue)}</td>
                <td className="py-2.5 pr-3 text-right tabular-nums">{r.cur.complete && total > 0 ? `${(((r.cur.revenue ?? 0) / total) * 100).toFixed(0)}%` : "—"}</td>
                <td className="py-2.5 pr-3 text-right"><Change pct={r.growth} label="—" /></td>
                <td className="py-2.5 pr-3 text-right tabular-nums">{num(r.cur.units)}</td>
                <td className="py-2.5 pr-3 text-right tabular-nums">{r.cur.returns !== null && r.cur.units ? `${((r.cur.returns / r.cur.units) * 100).toFixed(1)}%` : "not tracked"}</td>
                <td className="py-2.5 pr-3 text-right tabular-nums">{r.spendGst === null ? "—" : inr(r.spendGst)}{!r.adComplete && r.spendGst !== null && <span className="block text-[11px] text-amber-700 dark:text-amber-400">ad days missing</span>}</td>
                <td className="py-2.5 text-right tabular-nums">{r.spendGst !== null && r.cur.revenue && r.adComplete && r.cur.complete ? `${((r.spendGst / r.cur.revenue) * 100).toFixed(1)}%` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

type RankKey = keyof ReturnType<typeof rankProducts>;
const RANK_TABS: { id: RankKey; label: string }[] = [
  { id: "bestSellers", label: "Best sellers" }, { id: "topRevenue", label: "Top revenue" }, { id: "fastestGrowing", label: "Fastest growing" },
  { id: "gainingMomentum", label: "Gaining momentum" }, { id: "declining", label: "Declining" }, { id: "highReturns", label: "High returns" }, { id: "stockRisk", label: "Stock risk" },
];

function ProductSection({ ranks }: { ranks: ReturnType<typeof rankProducts> }) {
  const [tab, setTab] = useState<RankKey>("bestSellers");
  const rows: ProductRow[] = ranks[tab];
  return (
    <Section title="Products" subtitle="Last 30 days of each channel's data vs the 30 before; per channel and SKU. Each row says why it is listed."
      action={<Tabs label="Product ranking" value={tab} onChange={setTab} options={RANK_TABS.map((t) => ({ ...t, count: ranks[t.id].length }))} />}>
      {rows.length === 0 ? <EmptyState compact title="No product meets this rule right now" /> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[720px]">
            <thead><tr className="text-left text-xs text-muted-foreground border-b border-border">
              {["#", "Product", "Channel", "Units", "Revenue", "Growth", "Stock", "Why it's here"].map((h, i) => <th key={h} scope="col" className={cn("py-2 pr-3 font-semibold", i >= 3 && i <= 6 && "text-right")}>{h}</th>)}
            </tr></thead>
            <tbody className="divide-y divide-border">
              {rows.map((p, i) => (
                <tr key={p.key}>
                  <td className="py-2.5 pr-3 text-muted-foreground tabular-nums">{i + 1}</td>
                  <td className="py-2.5 pr-3 max-w-[280px]"><p className="font-medium truncate" title={p.name}>{p.name}</p><p className="text-[11px] text-muted-foreground">{p.sku}</p></td>
                  <td className="py-2.5 pr-3"><span className="inline-flex items-center gap-1.5 text-xs"><span className="w-2 h-2 rounded-sm" style={{ background: CH_COLOR[p.channel] }} aria-hidden="true" />{p.channel}</span></td>
                  <td className="py-2.5 pr-3 text-right tabular-nums">{num(p.units)}</td>
                  <td className="py-2.5 pr-3 text-right tabular-nums">{inr(p.revenue)}</td>
                  <td className="py-2.5 pr-3 text-right"><Change pct={p.growthPct} label="new" /></td>
                  <td className="py-2.5 pr-3 text-right text-xs tabular-nums whitespace-nowrap">
                    {p.stock !== null && <p title={p.stockAsOf ? `Amazon FBA available on ${dot(p.stockAsOf)}` : "Amazon FBA available"}>FBA {num(p.stock)}</p>}
                    {p.warehouse !== null && <p className="text-muted-foreground" title={`${p.warehouseSource === "override" ? "Edited stock (current_stock_override)" : "current_stock sheet"}${p.warehouseAsOf ? ` on ${dot(p.warehouseAsOf)}` : ""}`}>WH {num(p.warehouse)}{p.warehouseAsOf ? ` · ${dot(p.warehouseAsOf).slice(0, 5)}` : ""}</p>}
                    {p.stock === null && p.warehouse === null && <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="py-2.5 text-xs text-muted-foreground">{p.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function AdsSection({ ds, ads, camp, w }: { ds: BiDataset; ads: ReturnType<typeof adChannels>; camp: ReturnType<typeof campaignFindings>; w: Window }) {
  const [tab, setTab] = useState<"wasted" | "poor" | "strong" | "rising">("wasted");
  const list = camp[tab];
  const cw = ds.campaignWindow;
  const wastedGst = camp.wasted.reduce((s, c) => s + c.spend, 0) * ds.gstMultiplier;
  return (
    <Section title="Advertising" subtitle={`Spend, ad sales and efficiency for the last ${w.days} days. Ad sales are as each ad platform reports them.`}
      action={<Link href="/dashboard/daily-ad-spend" className="text-xs font-semibold text-primary">Daily ad spend →</Link>}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[720px]">
          <thead><tr className="text-left text-xs text-muted-foreground border-b border-border">
            {["Platform", "Spend (incl. GST)", "Change", "Ad sales", "ROAS", "ACOS", "Ad sales basis"].map((h, i) => <th key={h} scope="col" className={cn("py-2 pr-3 font-semibold", i >= 1 && i <= 5 && "text-right")}>{h}</th>)}
          </tr></thead>
          <tbody className="divide-y divide-border">
            {ads.map((a) => (
              <tr key={a.id}>
                <td className="py-2.5 pr-3 font-semibold"><Link href={CH_HREF[a.id] ?? "/dashboard/daily-ad-spend"} className="hover:text-primary">{a.label}</Link>{!a.complete && <span className="block text-[11px] font-normal text-amber-700 dark:text-amber-400">{a.covered} of {w.days} days uploaded</span>}</td>
                <td className="py-2.5 pr-3 text-right tabular-nums">{inr(a.spendGst)}</td>
                <td className="py-2.5 pr-3 text-right"><Change pct={a.spendPct} inverse label="—" /></td>
                <td className="py-2.5 pr-3 text-right tabular-nums">{inr(a.sales)}</td>
                <td className="py-2.5 pr-3 text-right tabular-nums">{a.roas === null ? "—" : `${a.roas.toFixed(1)}×`}</td>
                <td className="py-2.5 pr-3 text-right tabular-nums">{a.acos === null ? "—" : `${a.acos.toFixed(0)}%`}</td>
                <td className="py-2.5 text-xs text-muted-foreground max-w-[240px]">{a.salesBasis}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Campaigns · {dot(cw.start)} – {dot(cw.end)}</h3>
        <Tabs label="Campaign group" value={tab} onChange={setTab} options={[
          { id: "wasted", label: "Spend, no sales", count: camp.wasted.length }, { id: "poor", label: "High ACOS", count: camp.poor.length },
          { id: "strong", label: "Strong ROAS", count: camp.strong.length }, { id: "rising", label: "Rising cost", count: camp.rising.length },
        ]} />
      </div>
      {tab === "wasted" && wastedGst > 0 && (
        <p className="mt-3 text-xs rounded-lg bg-amber-500/10 text-amber-800 dark:text-amber-300 px-3 py-2">
          <span className="font-bold">Recommendation:</span> {inr(wastedGst)} (incl. GST) went to {camp.wasted.length} campaigns with no attributed sales. Moving it to the strong-ROAS campaigns below is the first budget change to consider — check stock for those products first.
        </p>
      )}
      {list.length === 0 ? <EmptyState compact title="No campaign meets this rule" /> : (
        <div className="overflow-x-auto mt-3">
          <table className="w-full text-sm min-w-[640px]">
            <thead><tr className="text-left text-xs text-muted-foreground border-b border-border">
              {["Campaign", "Platform", "Spend", "Ad sales", "ROAS", "Previous 30 days"].map((h, i) => <th key={h} scope="col" className={cn("py-2 pr-3 font-semibold", i >= 2 && i <= 4 && "text-right")}>{h}</th>)}
            </tr></thead>
            <tbody className="divide-y divide-border">
              {list.slice(0, 12).map((c) => (
                <tr key={`${c.channel}|${c.name}`}>
                  <td className="py-2 pr-3 max-w-[320px] truncate font-medium" title={c.name}>{c.name}</td>
                  <td className="py-2 pr-3 text-xs">{c.channel}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{inr(c.spend)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{inr(c.sales)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{c.roas === null ? "—" : `${c.roas.toFixed(1)}×`}</td>
                  <td className="py-2 text-xs text-muted-foreground tabular-nums">{inr(c.prevSpend)} spend · {inr(c.prevSales)} sales</td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.length > 12 && <p className="text-xs text-muted-foreground mt-2">Showing 12 of {list.length}. Spend is before GST.</p>}
        </div>
      )}
    </Section>
  );
}

// kept for future drill-down use (summing any series over a window)
export { sumWindow };
