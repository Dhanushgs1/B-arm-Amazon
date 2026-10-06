"use client";

// Seasonal Analytics — sales intelligence per master product (master_product_skuid "Product Name")
// with SKU drill-down. Every number comes from /api/seasonal-analytics, which aggregates server
// side from the same sources as product_forecast_summary_live_v; this page only filters, sorts and
// draws. Missing data is shown as missing ("n/a" / gaps), never as zero.

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, Cell, ReferenceLine,
} from "recharts";
import {
  TrendingUp, TrendingDown, Zap, AlertTriangle, Sun, Snowflake, Minus, HelpCircle, CalendarClock, RefreshCw, Download,
  Search, ChevronDown, ChevronRight, X, Database, Loader2, Info, Layers, Boxes, CalendarRange, Activity,
} from "lucide-react";
import { SimpleView } from "./SimpleView";
import type { SeasonalListDto, SeasonalDetailDto, ListMaster, ListSku, Status, Confidence } from "@/lib/seasonalAnalytics";

// ── palette (dataviz reference palette; light/dark steps of the same hues) ──────────────────────
const PALETTE = {
  light: { s1: "#2a78d6", s2: "#eb6834", grid: "#e7e6e2", axis: "#52514e", surface: "#fcfcfb", text: "#0b0b0b", mid: "#b9b8b3", good: "#0ca30c", critical: "#d03b3b", warning: "#fab219", serious: "#ec835a" },
  dark: { s1: "#3987e5", s2: "#d95926", grid: "#33332f", axis: "#c3c2b7", surface: "#1a1a19", text: "#ffffff", mid: "#5d5c57", good: "#0ca30c", critical: "#d03b3b", warning: "#fab219", serious: "#ec835a" },
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

// ── status meta: colour never carries meaning alone — always icon + label ───────────────────────
const STATUS_META: Record<Status, { icon: typeof TrendingUp; cls: string; color: keyof typeof PALETTE.light }> = {
  "HIGH GROWTH": { icon: TrendingUp, cls: "bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800", color: "good" },
  "UNUSUAL SPIKE": { icon: Zap, cls: "bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-800", color: "warning" },
  "DEMAND DROP": { icon: TrendingDown, cls: "bg-red-100 text-red-800 border-red-300 dark:bg-red-950/50 dark:text-red-300 dark:border-red-800", color: "critical" },
  "UNUSUAL DECLINE": { icon: AlertTriangle, cls: "bg-orange-100 text-orange-800 border-orange-300 dark:bg-orange-950/50 dark:text-orange-300 dark:border-orange-800", color: "serious" },
  "SEASONAL HIGH": { icon: Sun, cls: "bg-blue-100 text-blue-800 border-blue-300 dark:bg-blue-950/50 dark:text-blue-300 dark:border-blue-800", color: "s1" },
  "SEASONAL LOW": { icon: Snowflake, cls: "bg-indigo-100 text-indigo-800 border-indigo-300 dark:bg-indigo-950/50 dark:text-indigo-300 dark:border-indigo-800", color: "s1" },
  STABLE: { icon: Minus, cls: "bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800/60 dark:text-slate-300 dark:border-slate-700", color: "mid" },
  "LOW VOLUME": { icon: Minus, cls: "bg-slate-50 text-slate-500 border-slate-200 dark:bg-slate-900/60 dark:text-slate-400 dark:border-slate-800", color: "mid" },
  "INSUFFICIENT DATA": { icon: HelpCircle, cls: "bg-slate-50 text-slate-500 border-slate-200 dark:bg-slate-900/60 dark:text-slate-400 dark:border-slate-800", color: "mid" },
};
const STATUSES = Object.keys(STATUS_META) as Status[];

function StatusBadge({ status, pattern }: { status: Status; pattern?: string | null }) {
  const m = STATUS_META[status];
  const Icon = m.icon;
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[10px] font-bold ${m.cls}`}>
      <Icon size={11} /> {status}{pattern ? <span className="font-medium opacity-80">· {pattern}</span> : null}
    </span>
  );
}
function PeakBadge() {
  return <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-violet-300 bg-violet-100 px-1.5 py-0.5 text-[10px] font-bold text-violet-800 dark:border-violet-800 dark:bg-violet-950/50 dark:text-violet-300"><CalendarClock size={11} /> PEAK APPROACHING</span>;
}
function ConfidenceBadge({ c }: { c: Confidence }) {
  const cls = c === "HIGH" ? "text-emerald-700 dark:text-emerald-400" : c === "MEDIUM" ? "text-amber-700 dark:text-amber-400" : "text-slate-500 dark:text-slate-400";
  const dots = c === "HIGH" ? 3 : c === "MEDIUM" ? 2 : 1;
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-bold ${cls}`} title="Evidence strength: history length, comparable periods, consistency, size of the change">
      <span className="flex gap-0.5">{[0, 1, 2].map((i) => <span key={i} className={`h-1.5 w-1.5 rounded-full ${i < dots ? "bg-current" : "bg-current opacity-20"}`} />)}</span>{c}
    </span>
  );
}

// ── formatting ──────────────────────────────────────────────────────────────────────────────────
const n1 = (v: number | null | undefined, dp = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "n/a" : Number(v.toFixed(dp)).toLocaleString("en-IN"));
const pc = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "n/a" : `${v > 0 ? "+" : ""}${Math.round(v)}%`);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ml = (ym: string | null | undefined) => (ym ? `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}` : "n/a");
const dl = (d: string | null | undefined) => (d ? new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "n/a");
const skuLabel = (m: ListMaster) => (m.skuIds.length === 1 ? m.skuIds[0] : `${m.skuIds.length} SKUs`);
/** Combined identity: [master_product_skuid] | [SKU ID] | [Product Name]. In master_product_skuid the
 *  master key IS the Product Name, so the name is shown once rather than twice. */
const identity = (master: string | null, sku: string) => `${master ?? "UNMAPPED"} | ${sku}`;
const growthCls = (v: number | null) => (v === null ? "text-muted-foreground" : v >= 40 ? "text-emerald-700 dark:text-emerald-400" : v <= -40 ? "text-red-700 dark:text-red-400" : "");

// ── data loading ────────────────────────────────────────────────────────────────────────────────
async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body as T;
}

type SortKey = "name" | "current" | "recent" | "baseline" | "median" | "peak" | "growth" | "vsMean" | "status" | "units";

export default function SeasonalAnalyticsPage() {
  const dark = useIsDark();
  const P = dark ? PALETTE.dark : PALETTE.light;

  // server-side filters
  const [marketplaces, setMarketplaces] = useState<string[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // client-side filters
  const [masterFilter, setMasterFilter] = useState("");
  const [skuFilter, setSkuFilter] = useState("");
  const [nameSearch, setNameSearch] = useState("");
  const [monthFilter, setMonthFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [level, setLevel] = useState<"master" | "sku">("master");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "units", dir: -1 });
  const [showQuality, setShowQuality] = useState(false);
  const [view, setView] = useState<"simple" | "analysis">("simple");
  const [moreFilters, setMoreFilters] = useState(false);

  const [selected, setSelected] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0); // bumped by Refresh
  const query = useMemo(() => {
    const qs = new URLSearchParams();
    if (marketplaces.length) qs.set("marketplaces", marketplaces.join(","));
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    return qs.toString();
  }, [marketplaces, from, to]);
  const reqKey = `${query}#${nonce}`;
  // last response, tagged with the request it answers — loading is derived, not set in the effect
  const [resp, setResp] = useState<{ key: string; data?: SeasonalListDto; error?: string } | null>(null);
  const [lastData, setLastData] = useState<SeasonalListDto | null>(null);
  useEffect(() => {
    let live = true;
    getJson<SeasonalListDto>(`/api/seasonal-analytics?${query}`)
      .then((d) => { if (live) { setResp({ key: reqKey, data: d }); setLastData(d); } })
      .catch((e) => { if (live) setResp({ key: reqKey, error: e instanceof Error ? e.message : String(e) }); });
    return () => { live = false; };
  }, [query, reqKey]);
  const loading = resp?.key !== reqKey;
  const data = resp?.key === reqKey && resp.data ? resp.data : lastData;
  const error = resp?.key === reqKey ? resp.error ?? null : null;
  const load = () => setNonce((n) => n + 1);


  // ── filtering (same predicate drives table, KPIs and charts) ──
  const masterMatches = useCallback((m: ListMaster) => {
    if (masterFilter && m.master !== masterFilter) return false;
    if (nameSearch && !m.master.toLowerCase().includes(nameSearch.toLowerCase()) && !m.skuIds.some((s) => s.toLowerCase().includes(nameSearch.toLowerCase()))) return false;
    if (skuFilter && !m.skuIds.some((s) => s.toLowerCase().includes(skuFilter.toLowerCase()))) return false;
    if (monthFilter && m.m.peakMonth !== monthFilter) return false;
    if (statusFilter === "PEAK APPROACHING") { if (!m.peakApproaching) return false; }
    else if (statusFilter && m.status !== statusFilter) return false;
    return true;
  }, [masterFilter, nameSearch, skuFilter, monthFilter, statusFilter]);
  const skuMatches = useCallback((s: ListSku) => {
    if (masterFilter && s.master !== masterFilter) return false;
    if (nameSearch && !(s.master ?? "").toLowerCase().includes(nameSearch.toLowerCase()) && !s.sku.toLowerCase().includes(nameSearch.toLowerCase())) return false;
    if (skuFilter && !s.sku.toLowerCase().includes(skuFilter.toLowerCase())) return false;
    if (monthFilter && s.m.peakMonth !== monthFilter) return false;
    if (statusFilter === "PEAK APPROACHING") { if (!s.peakApproaching) return false; }
    else if (statusFilter && s.status !== statusFilter) return false;
    return true;
  }, [masterFilter, nameSearch, skuFilter, monthFilter, statusFilter]);

  const masters = useMemo(() => (data?.masters ?? []).filter(masterMatches), [data, masterMatches]);
  const skus = useMemo(() => (data?.skus ?? []).filter(skuMatches), [data, skuMatches]);

  // series for trend charts: SKU filter → sum matching SKUs; otherwise sum matching masters
  const trendSource: { w: (number | null)[]; mo: (number | null)[] }[] = useMemo(
    () => (skuFilter ? skus : masters),
    [skuFilter, skus, masters],
  );
  const sumAxis = (arrs: (number | null)[][], len: number) =>
    Array.from({ length: len }, (_, i) => {
      let s: number | null = null;
      for (const a of arrs) if (a[i] !== null && a[i] !== undefined) s = (s ?? 0) + (a[i] as number);
      return s;
    });
  const weekly = useMemo(() => {
    if (!data) return [];
    const vals = sumAxis(trendSource.map((x) => x.w), data.weekAxis.length);
    return data.weekAxis
      .map((w, i) => ({ week: w, rate: vals[i] === null ? null : Math.round((vals[i] as number) * 10) / 10 }))
      .filter((p) => !monthFilter || p.week.slice(0, 7) === monthFilter || addDaysStr(p.week, 6).slice(0, 7) === monthFilter);
  }, [data, trendSource, monthFilter]);
  const monthly = useMemo(() => {
    if (!data) return [];
    const vals = sumAxis(trendSource.map((x) => x.mo), data.monthAxis.length);
    return data.monthAxis.map((m, i) => ({ month: ml(m), key: m, rate: vals[i] === null ? null : Math.round((vals[i] as number) * 10) / 10 }));
  }, [data, trendSource]);

  // ── KPIs ──
  const kpis = useMemo(() => {
    const count = (s: Status) => masters.filter((m) => m.status === s).length;
    return {
      masters: masters.length,
      skus: masters.reduce((a, m) => a + m.skuKeys.length, 0),
      growth: count("HIGH GROWTH"),
      drop: count("DEMAND DROP"),
      seasonal: masters.filter((m) => m.status === "SEASONAL HIGH" || m.status === "SEASONAL LOW" || m.seasonality.startsWith("Seasonal")).length,
      peak: masters.filter((m) => m.peakApproaching).length,
      spikes: count("UNUSUAL SPIKE"),
      declines: count("UNUSUAL DECLINE"),
    };
  }, [masters]);

  // ── table rows ──
  const sortVal = (r: ListMaster | ListSku, k: SortKey): number | string => {
    switch (k) {
      case "name": return "master" in r && r.master ? r.master : "";
      case "current": return r.m.current ?? -Infinity;
      case "recent": return r.m.recent ?? -Infinity;
      case "baseline": return r.m.baseline ?? -Infinity;
      case "median": return r.m.median ?? -Infinity;
      case "peak": return r.m.peak ?? -Infinity;
      case "growth": return r.m.growth ?? -Infinity;
      case "vsMean": return r.m.vsMean ?? -Infinity;
      case "status": return r.status;
      default: return r.m.totalUnits;
    }
  };
  const rows = useMemo(() => {
    const list: (ListMaster | ListSku)[] = level === "master" ? masters : skus;
    return [...list].sort((a, b) => {
      const x = sortVal(a, sort.key), y = sortVal(b, sort.key);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [level, masters, skus, sort]);
  const [paging, setPaging] = useState<{ rows: unknown; size: number }>({ rows: null, size: 50 });
  const pageSize = paging.rows === rows ? paging.size : 50; // new row set → back to the first 50
  const setPageSize = (f: (n: number) => number) => setPaging({ rows, size: f(pageSize) });

  const exportCsv = () => {
    const head = ["Master Product SKU ID (master_product_skuid Product Name)", "SKU ID", "Product Name", "Identity", "Marketplace(s)", "Current Sales (units, last 7d)", "Current Avg (units/day, 7d)", "Recent Avg (units/day, 28d)", "Historical Average (units/day)", "Historical Median (units/day)", "Baseline (units/day)", "Historical Peak (units/day)", "Peak Date", "Peak Month", "Growth % vs baseline", "Change vs Average %", "Change vs Previous 28d %", "Seasonality", "Status", "Pattern", "Peak Approaching", "Confidence", "Why (classification)", "Likely Reason", "Evidence", "Recommendation"];
    const esc = (v: unknown) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = rows.map((r) => {
      const isM = "skuIds" in r;
      const master = isM ? r.master : (r as ListSku).master;
      const sku = isM ? r.skuIds.join(" / ") : (r as ListSku).sku;
      const mk = isM ? r.marketplaces.join(" / ") : (r as ListSku).marketplace;
      return [master ?? "UNMAPPED", sku, master ?? "", identity(master, isM ? skuLabel(r) : sku), mk, r.m.currentUnits, r.m.current, r.m.recent, r.m.mean, r.m.median, r.m.baseline, r.m.peak, r.m.peakDate, r.m.peakMonth, r.m.growth, r.m.vsMean, r.m.vsPrev, r.seasonality, r.status, r.pattern, r.peakApproaching ? "Yes" : "No", r.confidence, r.statusReason, r.likelyReason, isM ? (r as ListMaster).evidence.join(" • ") : "", r.recommendation].map(esc).join(",");
    });
    const blob = new Blob(["﻿" + [head.map(esc).join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `Seasonal_Analytics_${level === "master" ? "Master_Products" : "SKUs"}_${data?.asOf ?? ""}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const clearFilters = () => { setMasterFilter(""); setSkuFilter(""); setNameSearch(""); setMonthFilter(""); setStatusFilter(""); };
  const anyClientFilter = masterFilter || skuFilter || nameSearch || monthFilter || statusFilter;

  // ── chart datasets ──
  const top = <T,>(xs: T[], f: (x: T) => number | null, k = 10) => [...xs].filter((x) => f(x) !== null).sort((a, b) => (f(b) as number) - (f(a) as number)).slice(0, k);
  const short = (s: string) => (s.length > 28 ? s.slice(0, 27) + "…" : s);
  const peakProducts = top(masters, (m) => m.m.peak).map((m) => ({ name: short(m.master), full: m.master, value: m.m.peak, sub: `peak ${dl(m.m.peakDate)} · ${skuLabel(m)}` }));
  const growthProducts = top(masters.filter((m) => m.status === "HIGH GROWTH" || m.status === "UNUSUAL SPIKE"), (m) => m.m.growth).map((m) => ({ name: short(m.master), full: m.master, value: Math.round(m.m.growth ?? 0), sub: `${n1(m.m.baseline)} → ${n1(m.m.recent)} units/day · ${m.status}` }));
  const dropProducts = top(masters.filter((m) => m.status === "DEMAND DROP" || m.status === "UNUSUAL DECLINE"), (m) => -(m.m.growth ?? 0)).map((m) => ({ name: short(m.master), full: m.master, value: Math.round(m.m.growth ?? 0), sub: `${n1(m.m.baseline)} → ${n1(m.m.recent)} units/day · ${m.status}` }));
  const vsAvg = top(masters, (m) => m.m.totalUnits, 12).map((m) => ({ name: short(m.master), full: m.master, baseline: m.m.baseline, recent: m.m.recent }));
  const vsPeak = top(masters, (m) => m.m.totalUnits, 12).map((m) => ({ name: short(m.master), full: m.master, value: m.m.vsPeak === null ? null : Math.round(m.m.vsPeak), sub: `last 7d ${n1(m.m.current)}/day vs peak day ${n1(m.m.peak, 0)}` }));
  const peakMonthDist = (data?.monthAxis ?? []).map((mo) => ({ name: ml(mo), value: masters.filter((m) => m.m.peakMonth === mo).length }));
  const buckets: [string, number, number][] = [["≤ −75%", -Infinity, -75], ["−75…−40%", -75, -40], ["−40…−15%", -40, -15], ["−15…+15%", -15, 15], ["+15…+40%", 15, 40], ["+40…+75%", 40, 75], ["≥ +75%", 75, Infinity]];
  const growthDist = buckets.map(([name, a, b], i) => ({ name, i, value: masters.filter((m) => m.m.growth !== null && m.m.growth > a && m.m.growth <= b).length }));
  const divColor = (i: number) => (i < 3 ? P.critical : i > 3 ? P.s1 : P.mid);

  const axisProps = { tick: { fontSize: 10, fill: P.axis }, axisLine: { stroke: P.grid }, tickLine: false } as const;
  const tooltipStyle = { contentStyle: { background: P.surface, border: `1px solid ${P.grid}`, borderRadius: 8, fontSize: 11, color: P.text }, labelStyle: { color: P.text, fontWeight: 700 }, itemStyle: { color: P.text } };

  const masterOptions = useMemo(() => (data?.masters ?? []).map((m) => m.master).sort(), [data]);

  return (
    <div className="space-y-4 pb-10">
      {/* ── header (same plain style as the Inventory tab) ── */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="mb-0.5 text-2xl font-bold tracking-tight">Seasonal Analytics</h1>
          <p className="text-sm text-muted-foreground">
            {marketplaces.length ? marketplaces.join(", ") : "All marketplaces"} · Sales data up to {data ? dl(data.asOf) : "…"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs font-bold">
          <div className="flex rounded-lg border border-border bg-background p-0.5">
            <button onClick={() => setView("simple")} className={`rounded-md px-3 py-1.5 ${view === "simple" ? "bg-indigo-600 text-white" : "text-muted-foreground hover:text-foreground"}`}>Summary</button>
            <button onClick={() => setView("analysis")} className={`rounded-md px-3 py-1.5 ${view === "analysis" ? "bg-indigo-600 text-white" : "text-muted-foreground hover:text-foreground"}`}>Full Details</button>
          </div>
          {view === "analysis" && <button onClick={exportCsv} disabled={!data} className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 hover:bg-muted disabled:opacity-50"><Download size={14} /> Export CSV</button>}
          <button onClick={load} className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 hover:bg-muted"><RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh</button>
        </div>
      </div>

      {/* ── filters: search + marketplace always visible, the rest on demand ── */}
      {view === "analysis" && <div className="premium-card space-y-2.5 rounded-2xl p-3 text-xs">
        <div className="flex flex-wrap items-end gap-2.5">
          <label className="min-w-[220px] flex-1">
            <div className="relative"><Search size={15} className="absolute left-2.5 top-2.5 text-muted-foreground" /><input value={nameSearch} onChange={(e) => setNameSearch(e.target.value)} placeholder="Search product name or SKU ID" className="w-full rounded-lg border border-border bg-background py-2 pl-8 pr-2 text-sm" /></div>
          </label>
          <div>
            <p className="mb-1 text-[9px] font-extrabold uppercase tracking-wider text-muted-foreground">Marketplace</p>
            <div className="flex flex-wrap gap-1">
              {(data?.availableMarketplaces ?? []).map((mk) => {
                const on = marketplaces.length === 0 || marketplaces.includes(mk);
                return (
                  <button key={mk} onClick={() => {
                    const all = data?.availableMarketplaces ?? [];
                    const cur = marketplaces.length ? marketplaces : all;
                    const next = cur.includes(mk) ? cur.filter((x) => x !== mk) : [...cur, mk];
                    setMarketplaces(next.length === all.length || next.length === 0 ? [] : next);
                  }} className={`rounded-md border px-2 py-1 font-semibold ${on ? "border-indigo-400 bg-indigo-50 text-indigo-700 dark:border-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300" : "border-border text-muted-foreground"}`}>{mk}</button>
                );
              })}
            </div>
          </div>
          <button onClick={() => setMoreFilters((v) => !v)} className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 font-semibold text-muted-foreground hover:text-foreground">{moreFilters ? <ChevronDown size={12} /> : <ChevronRight size={12} />} More filters</button>
          {(anyClientFilter || from || to) && <button onClick={() => { clearFilters(); setFrom(""); setTo(""); }} className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 font-semibold text-muted-foreground hover:text-foreground"><X size={12} /> Clear</button>}
        </div>
        {moreFilters && (
          <div className="flex flex-wrap items-end gap-2.5 border-t border-border pt-2.5">
          <label>
            <p className="mb-1 text-[9px] font-extrabold uppercase tracking-wider text-muted-foreground">From</p>
            <input type="date" value={from} min={data?.quality.historicalStart} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="rounded-md border border-border bg-background px-2 py-1" />
          </label>
          <label>
            <p className="mb-1 text-[9px] font-extrabold uppercase tracking-wider text-muted-foreground">To (as of)</p>
            <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="rounded-md border border-border bg-background px-2 py-1" />
          </label>
          <label className="min-w-[200px] flex-1">
            <p className="mb-1 text-[9px] font-extrabold uppercase tracking-wider text-muted-foreground">Master product</p>
            <select value={masterFilter} onChange={(e) => setMasterFilter(e.target.value)} className="w-full rounded-md border border-border bg-background px-2 py-1">
              <option value="">All master products</option>
              {masterOptions.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label>
            <p className="mb-1 text-[9px] font-extrabold uppercase tracking-wider text-muted-foreground">SKU ID</p>
            <input value={skuFilter} onChange={(e) => setSkuFilter(e.target.value)} placeholder="e.g. B-TB-G" className="w-32 rounded-md border border-border bg-background px-2 py-1" />
          </label>
          <label>
            <p className="mb-1 text-[9px] font-extrabold uppercase tracking-wider text-muted-foreground" title="Keeps products whose historical peak month is this month, and zooms the weekly trend to it">Peak month</p>
            <select value={monthFilter} onChange={(e) => setMonthFilter(e.target.value)} className="rounded-md border border-border bg-background px-2 py-1">
              <option value="">Any month</option>
              {(data?.monthAxis ?? []).map((m) => <option key={m} value={m}>{ml(m)}</option>)}
            </select>
          </label>
          <label>
            <p className="mb-1 text-[9px] font-extrabold uppercase tracking-wider text-muted-foreground">Status</p>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="rounded-md border border-border bg-background px-2 py-1">
              <option value="">All statuses</option>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              <option value="PEAK APPROACHING">PEAK APPROACHING</option>
            </select>
          </label>
          </div>
        )}
      </div>}

      {error && (
        <div className="rounded-xl border border-red-300 bg-red-50 p-3 text-xs font-semibold text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          <AlertTriangle size={14} className="mr-1 inline" /> {error}
        </div>
      )}
      {loading && !data && (
        <div className="flex items-center justify-center gap-2 py-24 text-sm text-muted-foreground"><Loader2 className="animate-spin" size={18} /> Loading seasonal analytics…</div>
      )}

      {data && view === "simple" && <SimpleView masters={data.masters} onPick={setSelected} />}

      {data && view === "analysis" && (
        <>
          {/* ── KPIs ── */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9">
            <Kpi icon={Layers} label="Master products" value={kpis.masters} />
            <Kpi icon={Boxes} label="SKUs" value={kpis.skus} sub="marketplace × SKU" />
            <Kpi icon={CalendarRange} label="Historical period" value={`${data.quality.totalDays} days`} sub={`${dl(data.quality.historicalStart)} – ${dl(data.quality.historicalEnd)}`} />
            <Kpi icon={TrendingUp} label="High growth" value={kpis.growth} onClick={() => setStatusFilter("HIGH GROWTH")} />
            <Kpi icon={TrendingDown} label="Demand drop" value={kpis.drop} onClick={() => setStatusFilter("DEMAND DROP")} />
            <Kpi icon={Sun} label="Seasonal" value={kpis.seasonal} sub={kpis.seasonal ? undefined : "needs ≥ 2 years"} />
            <Kpi icon={CalendarClock} label="Peak approaching" value={kpis.peak} sub={kpis.peak ? undefined : "needs ≥ 2 years"} onClick={() => setStatusFilter("PEAK APPROACHING")} />
            <Kpi icon={Zap} label="Unusual spikes" value={kpis.spikes} onClick={() => setStatusFilter("UNUSUAL SPIKE")} />
            <Kpi icon={AlertTriangle} label="Unusual declines" value={kpis.declines} onClick={() => setStatusFilter("UNUSUAL DECLINE")} />
          </div>

          {/* ── data quality ── */}
          <div className="premium-card rounded-2xl">
            <button onClick={() => setShowQuality((v) => !v)} className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left">
              <span className="flex items-center gap-2 text-xs font-bold"><Database size={14} className="text-indigo-500" /> Data coverage & quality
                <span className="font-medium text-muted-foreground">· {data.quality.totalDays} days ({data.quality.totalMonths} months) · {data.quality.warnings.length} note(s)</span>
              </span>
              {showQuality ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            {(showQuality || data.quality.warnings.length > 0) && (
              <div className="space-y-1 px-4 pb-3">
                {data.quality.warnings.map((w) => <p key={w} className="flex gap-1.5 text-[11px] text-amber-800 dark:text-amber-300"><Info size={12} className="mt-0.5 flex-shrink-0" />{w}</p>)}
              </div>
            )}
            {showQuality && (
              <div className="space-y-3 border-t border-border px-4 py-3 text-[11px]">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px]">
                    <thead className="text-left text-[9px] uppercase tracking-wider text-muted-foreground"><tr><th className="py-1">Marketplace</th><th>First date</th><th>Last date</th><th>Days with data</th><th>Feed</th><th>Missing dates</th><th>Duplicate rows removed</th><th>Unparseable dates</th><th>Missing quantity</th></tr></thead>
                    <tbody>
                      {data.quality.marketplaces.map((q) => (
                        <tr key={q.marketplace} className="border-t border-border/60">
                          <td className="py-1 font-semibold">{q.marketplace}</td><td>{q.firstDate}</td><td>{q.lastDate}</td><td>{q.daysWithData} / {q.rangeDays}</td>
                          <td title={data.quality.coverageNote}>{q.feed}</td><td>{q.missingDates.length ? q.missingDates.slice(0, 5).join(", ") + (q.missingDates.length > 5 ? ` +${q.missingDates.length - 5}` : "") : "none"}</td>
                          <td>{q.duplicateRows.toLocaleString("en-IN")}</td><td className={q.unparseableDates ? "font-bold text-amber-700 dark:text-amber-400" : ""}>{q.unparseableDates.toLocaleString("en-IN")}</td><td>{q.missingQuantity}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-muted-foreground">{data.quality.coverageNote}</p>
                <div className="grid gap-1 sm:grid-cols-2">
                  <p>Forecast view rows: <b>{data.quality.viewRows ?? "n/a"}</b> · blank SKU ID: <b>{data.quality.viewBlankSku ?? "n/a"}</b> (flagged, excluded) · unmapped (&quot;Unknown&quot;) product: <b>{data.quality.viewUnknownProduct ?? "n/a"}</b></p>
                  <p>SKUs without a master product: <b>{data.quality.unmappedSkus.length}</b>{data.quality.unmappedSkus.length ? ` — ${data.quality.unmappedSkus.join(", ")}` : ""} (kept separate, never merged)</p>
                  <p>Orders for SKUs not in the forecast view: {data.quality.unmatchedOrders.length ? data.quality.unmatchedOrders.map((u) => `${u.marketplace} ${u.rows} rows / ${u.units} units (${u.skus} SKUs)`).join("; ") : "none"}</p>
                  <p>Incomplete months: {data.quality.incompleteMonths.map(ml).join(", ") || "none"}</p>
                  <p>{data.quality.stockHistory}</p>
                  <p>{data.quality.adHistory}</p>
                </div>
              </div>
            )}
          </div>

          {/* ── charts ── */}
          <div className="grid gap-3 lg:grid-cols-2">
            <ChartCard title="1 · Historical sales trend" sub={`Weekly average units/day${skuFilter ? " · matching SKUs" : ` · ${masters.length} master products`}${monthFilter ? ` · ${ml(monthFilter)}` : ""}. Partial weeks use covered days only.`}>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={weekly} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                  <CartesianGrid stroke={P.grid} vertical={false} />
                  <XAxis dataKey="week" {...axisProps} tickFormatter={(w) => dl(w).replace(/ \d{4}$/, "")} minTickGap={24} />
                  <YAxis {...axisProps} width={44} />
                  <Tooltip {...tooltipStyle} labelFormatter={(w) => `Week of ${dl(String(w))}`} formatter={(v) => [`${v} units/day`, "Sales"]} />
                  <Line type="monotone" dataKey="rate" stroke={P.s1} strokeWidth={2} dot={false} activeDot={{ r: 4 }} connectNulls={false} />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="2 · Monthly sales trend" sub="Average units/day per month (months with partial coverage use covered days).">
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={monthly} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                  <CartesianGrid stroke={P.grid} vertical={false} />
                  <XAxis dataKey="month" {...axisProps} />
                  <YAxis {...axisProps} width={44} />
                  <Tooltip {...tooltipStyle} formatter={(v) => [`${v} units/day`, "Sales"]} cursor={{ fill: P.grid, opacity: 0.4 }} />
                  <Bar dataKey="rate" fill={P.s1} radius={[4, 4, 0, 0]} maxBarSize={36}>
                    {monthly.map((m) => <Cell key={m.key} fill={P.s1} fillOpacity={data.quality.incompleteMonths.includes(m.key) ? 0.45 : 1} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <p className="text-[10px] text-muted-foreground">Faded bars = incomplete months ({data.quality.incompleteMonths.map(ml).join(", ") || "none"}).</p>
            </ChartCard>

            <ChartCard title="3 · Historical peak products" sub="Highest single-day units per master product (all its SKUs combined).">
              <HBar data={peakProducts} color={P.s1} P={P} unit=" units" onPick={setSelected} />
            </ChartCard>

            <ChartCard title="4 · High growth products" sub="Recent 4-week avg vs historical baseline (HIGH GROWTH and UNUSUAL SPIKE).">
              <HBar data={growthProducts} color={P.good} P={P} unit="%" onPick={setSelected} empty="No product is significantly above its baseline." />
            </ChartCard>

            <ChartCard title="5 · Demand drop products" sub="Recent 4-week avg vs historical baseline (DEMAND DROP and UNUSUAL DECLINE).">
              <HBar data={dropProducts} color={P.critical} P={P} unit="%" onPick={setSelected} empty="No product is significantly below its baseline." />
            </ChartCard>

            <ChartCard title="6 · Seasonal demand by month" sub={kpis.seasonal ? "Products whose recurring high-demand months fall in each month." : "Seasonality needs the same calendar month in ≥ 2 years. Showing observed peak months instead (single occurrence, not confirmed seasonal)."}>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={(data.monthAxis).map((mo) => ({ name: ml(mo), value: masters.filter((m) => m.observedPeakMonth === mo).length }))} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                  <CartesianGrid stroke={P.grid} vertical={false} />
                  <XAxis dataKey="name" {...axisProps} />
                  <YAxis {...axisProps} width={44} allowDecimals={false} />
                  <Tooltip {...tooltipStyle} formatter={(v) => [`${v} products`, "Observed peak month"]} cursor={{ fill: P.grid, opacity: 0.4 }} />
                  <Bar dataKey="value" fill={P.s1} radius={[4, 4, 0, 0]} maxBarSize={36} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="7 · Current vs historical average" sub="Top 12 master products by volume — baseline vs recent 4-week average (units/day).">
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={vsAvg} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }} barGap={2}>
                  <CartesianGrid stroke={P.grid} horizontal={false} />
                  <XAxis type="number" {...axisProps} />
                  <YAxis type="category" dataKey="name" {...axisProps} width={150} />
                  <Tooltip {...tooltipStyle} labelFormatter={(_, p) => (p?.[0]?.payload as { full?: string })?.full ?? ""} formatter={(v, k) => [`${n1(Number(v))} units/day`, k === "baseline" ? "Historical baseline" : "Recent 4-week avg"]} cursor={{ fill: P.grid, opacity: 0.4 }} />
                  <Legend wrapperStyle={{ fontSize: 10, color: P.axis }} formatter={(k) => (k === "baseline" ? "Historical baseline" : "Recent 4-week avg")} />
                  <Bar dataKey="baseline" fill={P.s1} radius={[0, 4, 4, 0]} barSize={7} />
                  <Bar dataKey="recent" fill={P.s2} radius={[0, 4, 4, 0]} barSize={7} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="8 · Current vs historical peak" sub="Top 12 by volume — last-7-day daily average as % of the peak day.">
              <HBar data={vsPeak} color={P.s1} P={P} unit="%" onPick={setSelected} />
            </ChartCard>

            <ChartCard title="9 · Peak month distribution" sub="Number of master products whose highest-rate month is each month.">
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={peakMonthDist} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                  <CartesianGrid stroke={P.grid} vertical={false} />
                  <XAxis dataKey="name" {...axisProps} />
                  <YAxis {...axisProps} width={44} allowDecimals={false} />
                  <Tooltip {...tooltipStyle} formatter={(v) => [`${v} products`, "Peak month"]} cursor={{ fill: P.grid, opacity: 0.4 }} />
                  <Bar dataKey="value" fill={P.s1} radius={[4, 4, 0, 0]} maxBarSize={36} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="10 · Growth / decline distribution" sub="Master products by recent-vs-baseline change. Red = decline, blue = growth, grey = within ±15%.">
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={growthDist} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                  <CartesianGrid stroke={P.grid} vertical={false} />
                  <XAxis dataKey="name" {...axisProps} interval={0} />
                  <YAxis {...axisProps} width={44} allowDecimals={false} />
                  <Tooltip {...tooltipStyle} formatter={(v) => [`${v} products`, "Count"]} cursor={{ fill: P.grid, opacity: 0.4 }} />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={44}>
                    {growthDist.map((g) => <Cell key={g.name} fill={divColor(g.i)} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>

          {/* ── main table ── */}
          <div className="premium-card overflow-hidden rounded-2xl">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
              <div>
                <h2 className="text-sm font-bold">{level === "master" ? "Master Product Performance" : "Individual SKU Performance"}</h2>
                <p className="text-[10px] text-muted-foreground">{rows.length} rows · units/day unless stated · Current = last 7 days · Recent = last 28 days · click a row to drill down</p>
              </div>
              <div className="flex rounded-lg border border-border p-0.5 text-[11px] font-bold">
                <button onClick={() => setLevel("master")} className={`rounded-md px-2.5 py-1 ${level === "master" ? "bg-indigo-600 text-white" : "text-muted-foreground"}`}>Master products</button>
                <button onClick={() => setLevel("sku")} className={`rounded-md px-2.5 py-1 ${level === "sku" ? "bg-indigo-600 text-white" : "text-muted-foreground"}`}>SKUs</button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1500px] text-[11px]">
                <thead className="bg-muted/40 text-left text-[9px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <Th k="name" sort={sort} setSort={setSort}>Master Product SKU ID | SKU ID | Product Name</Th>
                    <Th k="current" sort={sort} setSort={setSort} right>Current</Th>
                    <Th k="recent" sort={sort} setSort={setSort} right>Recent avg</Th>
                    <Th k="baseline" sort={sort} setSort={setSort} right>Hist. avg (baseline / mean)</Th>
                    <Th k="median" sort={sort} setSort={setSort} right>Hist. median</Th>
                    <Th k="peak" sort={sort} setSort={setSort} right>Peak · date · month</Th>
                    <Th k="growth" sort={sort} setSort={setSort} right>Growth %</Th>
                    <Th k="vsMean" sort={sort} setSort={setSort} right>vs avg %</Th>
                    <th className="px-2 py-2">Seasonality</th>
                    <Th k="status" sort={sort} setSort={setSort}>Status</Th>
                    <th className="px-2 py-2">Likely reason · why</th>
                    <th className="px-2 py-2">Recommendation</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, pageSize).map((r) => {
                    const isM = "skuIds" in r;
                    const master = isM ? (r as ListMaster).master : (r as ListSku).master;
                    const sku = isM ? skuLabel(r as ListMaster) : `${(r as ListSku).sku}`;
                    const key = isM ? (r as ListMaster).master : (r as ListSku).key;
                    return (
                      <tr key={key} onClick={() => master && setSelected(master)} className="cursor-pointer border-t border-border/60 align-top hover:bg-muted/40">
                        <td className="max-w-[260px] px-2 py-2">
                          <p className="font-bold">{master ?? <span className="text-amber-700">UNMAPPED</span>}</p>
                          <p className="text-muted-foreground">SKU: {sku}{!isM && <> · {(r as ListSku).marketplace}</>}{isM && <> · {(r as ListMaster).marketplaces.join(", ")}</>}</p>
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums"><b>{n1(r.m.current)}</b><p className="text-muted-foreground">{r.m.currentUnits ?? "n/a"} units/7d</p></td>
                        <td className="px-2 py-2 text-right tabular-nums">{n1(r.m.recent)}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{n1(r.m.baseline)}<p className="text-muted-foreground">mean {n1(r.m.mean)}</p></td>
                        <td className="px-2 py-2 text-right tabular-nums">{n1(r.m.median)}</td>
                        <td className="px-2 py-2 text-right tabular-nums"><b>{n1(r.m.peak, 0)}</b><p className="text-muted-foreground">{dl(r.m.peakDate)}</p><p className="text-muted-foreground">{ml(r.m.peakMonth)}</p></td>
                        <td className={`px-2 py-2 text-right font-bold tabular-nums ${growthCls(r.m.growth)}`}>{pc(r.m.growth)}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{pc(r.m.vsMean)}</td>
                        <td className="max-w-[160px] px-2 py-2 text-muted-foreground">{r.seasonality}</td>
                        <td className="px-2 py-2"><div className="flex flex-col items-start gap-1"><StatusBadge status={r.status} pattern={r.pattern} />{r.peakApproaching && <PeakBadge />}<ConfidenceBadge c={r.confidence} /></div></td>
                        <td className="max-w-[300px] px-2 py-2"><p className="font-semibold">{r.likelyReason}</p><p className="text-muted-foreground">{r.statusReason}</p></td>
                        <td className="max-w-[260px] px-2 py-2 text-muted-foreground">{r.recommendation}</td>
                      </tr>
                    );
                  })}
                  {!rows.length && <tr><td colSpan={12} className="px-4 py-10 text-center text-muted-foreground">No products match the current filters.</td></tr>}
                </tbody>
              </table>
            </div>
            {rows.length > pageSize && (
              <button onClick={() => setPageSize((n) => n + 100)} className="w-full border-t border-border py-2 text-xs font-bold text-indigo-600 hover:bg-muted/40 dark:text-indigo-400">Show more ({rows.length - pageSize} remaining)</button>
            )}
          </div>
        </>
      )}

      {selected && data && (
        <DrillDown master={selected} list={data} params={{ marketplaces, from, to }} onClose={() => setSelected(null)} P={P} />
      )}
    </div>
  );
}

function addDaysStr(d: string, n: number) {
  return new Date(Date.parse(d + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
}

// ── small components ────────────────────────────────────────────────────────────────────────────

function Kpi({ icon: Icon, label, value, sub, onClick }: { icon: typeof TrendingUp; label: string; value: string | number; sub?: string; onClick?: () => void }) {
  return (
    <div onClick={onClick} role={onClick ? "button" : undefined} tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter") onClick(); } : undefined}
      className={`premium-card rounded-2xl p-3 ${onClick ? "premium-card-hover cursor-pointer" : ""}`}>
      <div className="flex items-center gap-1.5 text-[9px] font-extrabold uppercase tracking-wider text-muted-foreground"><Icon size={12} className="text-indigo-500" />{label}</div>
      <p className="mt-1.5 text-xl font-bold tabular-nums">{value}</p>
      {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

function ChartCard({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="premium-card space-y-2 rounded-2xl p-4">
      <div><h3 className="text-xs font-bold">{title}</h3><p className="text-[10px] text-muted-foreground">{sub}</p></div>
      {children}
    </div>
  );
}

function Th({ k, sort, setSort, right, children }: { k: SortKey; sort: { key: SortKey; dir: 1 | -1 }; setSort: (s: { key: SortKey; dir: 1 | -1 }) => void; right?: boolean; children: React.ReactNode }) {
  const on = sort.key === k;
  return (
    <th className={`cursor-pointer select-none px-2 py-2 ${right ? "text-right" : ""} ${on ? "text-foreground" : ""}`} onClick={() => setSort({ key: k, dir: on ? (sort.dir === 1 ? -1 : 1) : -1 })}>
      {children}{on ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
    </th>
  );
}

type Pal = typeof PALETTE.light;
function HBar({ data, color, P, unit, onPick, empty }: { data: { name: string; full: string; value: number | null; sub: string }[]; color: string; P: Pal; unit: string; onPick: (m: string) => void; empty?: string }) {
  if (!data.length) return <p className="py-16 text-center text-xs text-muted-foreground">{empty ?? "No data for the current filters."}</p>;
  return (
    <ResponsiveContainer width="100%" height={Math.max(160, data.length * 24 + 30)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 40, left: 8, bottom: 0 }}>
        <CartesianGrid stroke={P.grid} horizontal={false} />
        <XAxis type="number" tick={{ fontSize: 10, fill: P.axis }} axisLine={{ stroke: P.grid }} tickLine={false} />
        <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: P.axis }} axisLine={false} tickLine={false} width={150} />
        <ReferenceLine x={0} stroke={P.axis} />
        <Tooltip
          contentStyle={{ background: P.surface, border: `1px solid ${P.grid}`, borderRadius: 8, fontSize: 11, color: P.text }}
          labelStyle={{ color: P.text, fontWeight: 700 }} itemStyle={{ color: P.text }}
          cursor={{ fill: P.grid, opacity: 0.4 }}
          labelFormatter={(_, p) => (p?.[0]?.payload as { full?: string })?.full ?? ""}
          formatter={(v, _k, item) => [`${v}${unit}`, (item?.payload as { sub?: string })?.sub ?? ""]}
        />
        <Bar dataKey="value" fill={color} radius={4} barSize={12} cursor="pointer" onClick={(d) => { const full = (d as unknown as { payload?: { full?: string } }).payload?.full; if (full) onPick(full); }}
          label={{ position: "right", fontSize: 10, fill: P.axis, formatter: (v: unknown) => `${v}${unit}` }} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function Field({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border p-2.5"><p className="text-[9px] font-extrabold uppercase tracking-wider text-muted-foreground">{label}</p><p className="mt-0.5 text-sm font-bold tabular-nums">{value}</p>{sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}</div>
  );
}

// ── drill-down ──────────────────────────────────────────────────────────────────────────────────

function DrillDown({ master, list, params, onClose, P }: {
  master: string; list: SeasonalListDto;
  params: { marketplaces: string[]; from: string; to: string }; onClose: () => void; P: Pal;
}) {
  const [openSku, setOpenSku] = useState<string | null>(null);
  const summary = list.masters.find((m) => m.master === master);
  const url = useMemo(() => {
    const qs = new URLSearchParams({ master });
    if (params.marketplaces.length) qs.set("marketplaces", params.marketplaces.join(","));
    if (params.from) qs.set("from", params.from);
    if (params.to) qs.set("to", params.to);
    return `/api/seasonal-analytics?${qs}`;
  }, [master, params.marketplaces, params.from, params.to]);
  const [resp, setResp] = useState<{ url: string; detail?: SeasonalDetailDto; err?: string } | null>(null);
  useEffect(() => {
    let live = true;
    getJson<SeasonalDetailDto>(url)
      .then((d) => { if (live) setResp({ url, detail: d }); })
      .catch((e) => { if (live) setResp({ url, err: e instanceof Error ? e.message : String(e) }); });
    return () => { live = false; };
  }, [url]);
  const detail = resp?.url === url ? resp.detail ?? null : null;
  const err = resp?.url === url ? resp.err ?? null : null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const daily = useMemo(() => {
    if (!detail) return [];
    const base = detail.master.metrics.baseline;
    return detail.daily.days.map((d, i) => ({ d, total: detail.daily.total[i], baseline: base }));
  }, [detail]);

  const m = detail?.master;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div className="h-full w-full max-w-4xl overflow-y-auto bg-background shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-border bg-background/95 px-5 py-3 backdrop-blur">
          <div className="min-w-0">
            <p className="text-[9px] font-extrabold uppercase tracking-wider text-muted-foreground">Master product summary</p>
            <h2 className="truncate text-lg font-bold">{master}</h2>
            <p className="text-[11px] text-muted-foreground">Master Product SKU ID: {master} · SKU IDs: {summary?.skuIds.join(", ")}</p>
          </div>
          <button onClick={onClose} className="rounded-lg border border-border p-1.5 hover:bg-muted" aria-label="Close"><X size={16} /></button>
        </div>

        {err && <p className="m-5 rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">{err}</p>}
        {!detail && !err && <div className="flex items-center justify-center gap-2 py-24 text-sm text-muted-foreground"><Loader2 className="animate-spin" size={16} /> Loading drill-down…</div>}

        {m && (
          <div className="space-y-4 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={m.analysis.status} pattern={m.analysis.pattern} />
              {m.analysis.peakApproaching && <PeakBadge />}
              <ConfidenceBadge c={m.analysis.confidence} />
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Field label="Total SKUs" value={m.skuKeys.length} sub={m.marketplaces.join(", ")} />
              <Field label="Current sales" value={`${n1(m.metrics.currentAvg)} /day`} sub={`${m.metrics.currentUnits ?? "n/a"} units, last 7 days`} />
              <Field label="Historical average" value={`${n1(m.metrics.baseline)} /day`} sub={`mean ${n1(m.metrics.baselineMean)} · median day ${n1(m.metrics.dailyMedian)}`} />
              <Field label="Recent average" value={`${n1(m.metrics.recentAvg)} /day`} sub="last 28 days" />
              <Field label="Historical peak" value={`${n1(m.metrics.peakQty, 0)} units`} sub={`${dl(m.metrics.peakDate)} · peak month ${ml(m.metrics.peakMonth)}`} />
              <Field label="Peak week" value={m.metrics.peakWeekUnits !== null ? `${n1(m.metrics.peakWeekUnits, 0)} units` : "n/a"} sub={m.metrics.peakWeekStart ? `week of ${dl(m.metrics.peakWeekStart)}` : undefined} />
              <Field label="Growth % vs baseline" value={<span className={growthCls(m.metrics.growthPct)}>{pc(m.metrics.growthPct)}</span>} sub={`vs prev 28d ${pc(m.metrics.changeVsPrevPct)} · vs mean ${pc(m.metrics.changeVsMeanPct)}`} />
              <Field label="Peak vs average / current vs peak" value={`${pc(m.metrics.peakVsAvgPct)}`} sub={`current = ${n1(m.metrics.currentVsPeakPct, 0)}% of peak day`} />
              <Field label="Change started" value={m.metrics.changeStart ? dl(m.metrics.changeStart) : "n/a"} sub={m.metrics.changeDurationDays ? `${m.metrics.changeDurationDays} days` : "no significant change run"} />
              <Field label="Seasonality" value={<span className="text-xs">{m.analysis.seasonality.label}</span>} sub={`same month last year: ${m.metrics.sameMonthHistAvg === null ? "no prior-year data" : n1(m.metrics.sameMonthHistAvg) + "/day"}`} />
              <Field label="Current stock" value={m.currentStock === null ? "n/a" : n1(m.currentStock, 0)} sub="product_forecast_summary_live_v" />
              <Field label="Covered days" value={m.metrics.coveredDays} sub={`${n1(m.metrics.totalUnits, 0)} units total`} />
            </div>

            <div className="rounded-xl border border-border p-3 text-xs">
              <p className="text-[9px] font-extrabold uppercase tracking-wider text-muted-foreground">Likely reason</p>
              <p className="mt-0.5 font-bold">{m.analysis.likelyReason}</p>
              <p className="mt-1 text-muted-foreground">{m.analysis.statusReason}</p>
              <p className="mt-2 text-[9px] font-extrabold uppercase tracking-wider text-muted-foreground">Evidence</p>
              <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-[11px]">{m.analysis.evidence.map((e) => <li key={e}>{e}</li>)}</ul>
              <p className="mt-2 text-[9px] font-extrabold uppercase tracking-wider text-muted-foreground">Recommendation</p>
              <p className="mt-0.5">{m.analysis.recommendation}</p>
            </div>

            <ChartCard title="Daily sales — all SKUs combined" sub="Units per day; gaps are missing data (no upload), not zero. Dashed line = historical baseline.">
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={daily} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                  <CartesianGrid stroke={P.grid} vertical={false} />
                  <XAxis dataKey="d" tick={{ fontSize: 10, fill: P.axis }} axisLine={{ stroke: P.grid }} tickLine={false} tickFormatter={(d) => dl(d).replace(/ \d{4}$/, "")} minTickGap={28} />
                  <YAxis tick={{ fontSize: 10, fill: P.axis }} axisLine={{ stroke: P.grid }} tickLine={false} width={40} />
                  <Tooltip contentStyle={{ background: P.surface, border: `1px solid ${P.grid}`, borderRadius: 8, fontSize: 11, color: P.text }} labelStyle={{ color: P.text, fontWeight: 700 }} itemStyle={{ color: P.text }}
                    labelFormatter={(d) => dl(String(d))} formatter={(v, k) => [v === null ? "missing" : `${n1(Number(v))} units${k === "baseline" ? "/day" : ""}`, k === "baseline" ? "Baseline" : "Sales"]} />
                  <Line type="monotone" dataKey="total" stroke={P.s1} strokeWidth={2} dot={false} connectNulls={false} activeDot={{ r: 4 }} />
                  <Line type="monotone" dataKey="baseline" stroke={P.axis} strokeDasharray="4 4" strokeWidth={1} dot={false} />
                  {m.metrics.peakDate && <ReferenceLine x={m.metrics.peakDate} stroke={P.s2} label={{ value: `Peak ${n1(m.metrics.peakQty, 0)}`, fontSize: 10, fill: P.axis, position: "top" }} />}
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            <div className="rounded-xl border border-border">
              <div className="border-b border-border px-3 py-2">
                <h3 className="text-xs font-bold">SKU breakdown</h3>
                <p className="text-[10px] text-muted-foreground">Is the change across all SKUs or driven by one? Contribution = share of the master product&apos;s change in its direction. Click a SKU for its evidence.</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] text-[11px]">
                  <thead className="text-left text-[9px] uppercase tracking-wider text-muted-foreground">
                    <tr><th className="px-2 py-1.5">Master | SKU ID | Marketplace</th><th className="px-2 text-right">Current /day</th><th className="px-2 text-right">Hist. avg</th><th className="px-2 text-right">Peak · date</th><th className="px-2 text-right">Growth %</th><th className="px-2 text-right">Contribution</th><th className="px-2 text-right">Units on peak day</th><th className="px-2">Status</th></tr>
                  </thead>
                  <tbody>
                    {detail.skus.map((s) => {
                      const c = m.contributions.find((x) => x.key === s.key);
                      const pk = m.peakContributors.find((x) => x.key === s.key);
                      const open = openSku === s.key;
                      return (
                        <Fragment key={s.key}>
                          <tr className="cursor-pointer border-t border-border/60 hover:bg-muted/40" onClick={() => setOpenSku(open ? null : s.key)}>
                            <td className="px-2 py-1.5"><span className="font-semibold">{identity(master, s.sku)}</span> <span className="text-muted-foreground">· {s.marketplace}</span></td>
                            <td className="px-2 text-right tabular-nums">{n1(s.metrics.currentAvg)}</td>
                            <td className="px-2 text-right tabular-nums">{n1(s.metrics.baseline)}</td>
                            <td className="px-2 text-right tabular-nums">{n1(s.metrics.peakQty, 0)} · {dl(s.metrics.peakDate)}</td>
                            <td className={`px-2 text-right font-bold tabular-nums ${growthCls(s.metrics.growthPct)}`}>{pc(s.metrics.growthPct)}</td>
                            <td className="px-2 text-right tabular-nums">{c ? `${c.deltaPerDay > 0 ? "+" : ""}${n1(c.deltaPerDay)}/day${c.sharePct !== null ? ` (${Math.round(c.sharePct)}%)` : ""}` : "n/a"}</td>
                            <td className="px-2 text-right tabular-nums">{pk ? n1(pk.units, 0) : "0"}</td>
                            <td className="px-2 py-1.5"><StatusBadge status={s.analysis.status} pattern={s.analysis.pattern} /></td>
                          </tr>
                          {open && (
                            <tr className="bg-muted/30"><td colSpan={8} className="px-3 py-2">
                              <p className="font-semibold">{s.analysis.likelyReason}</p>
                              <p className="text-muted-foreground">{s.analysis.statusReason}</p>
                              <ul className="mt-1 list-disc pl-4 text-[10px] text-muted-foreground">{s.analysis.evidence.map((e) => <li key={e}>{e}</li>)}</ul>
                              <p className="mt-1">{s.analysis.recommendation}</p>
                              <p className="mt-1"><ConfidenceBadge c={s.analysis.confidence} /></p>
                            </td></tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground"><Activity size={10} className="mr-1 inline" />Peak approaching / seasonal signals are historical patterns, not forecasts.</p>
          </div>
        )}
      </div>
    </div>
  );
}
