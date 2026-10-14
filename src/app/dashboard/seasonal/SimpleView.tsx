"use client";

// Default Seasonal Analytics view, laid out like the Inventory tab: 4 KPI cards, an insights &
// recommendations panel, then one sortable/searchable table (shared DataTable) with peak, normal
// and current sales side by side. Row click opens the product drill-down.

import { KPICard } from "@/components/KPICard";
import { DataTable } from "@/components/DataTable";
import { useState } from "react";
import { TrendingDown, TrendingUp, AlertTriangle, PackageX, Store } from "lucide-react";
import type { ListMaster, MarketplaceSlice, Status } from "@/lib/seasonalAnalytics";
import { marketplaceInsight, trendOf, type MarketplaceInsight, type MarketplaceTrend } from "@/lib/seasonalPlain";

type Label = "Falling" | "Growing" | "Sudden jump" | "Sudden dip" | "Steady" | "Low sales";

const LABEL: Record<Status, Label> = {
  "DEMAND DROP": "Falling",
  "HIGH GROWTH": "Growing",
  "SEASONAL HIGH": "Growing",
  "UNUSUAL SPIKE": "Sudden jump",
  "UNUSUAL DECLINE": "Sudden dip",
  "SEASONAL LOW": "Sudden dip",
  STABLE: "Steady",
  "LOW VOLUME": "Low sales",
  "INSUFFICIENT DATA": "Low sales",
};

const PILL: Record<Label, string> = {
  Falling: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-400 border-red-200 dark:border-red-900",
  Growing: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-400 border-green-200 dark:border-green-900",
  "Sudden jump": "bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-400 border-yellow-200 dark:border-yellow-900",
  "Sudden dip": "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-400 border-orange-200 dark:border-orange-900",
  Steady: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border-slate-200 dark:border-slate-700",
  "Low sales": "bg-slate-50 text-slate-500 dark:bg-slate-900 dark:text-slate-400 border-slate-200 dark:border-slate-800",
};

const LOW_STOCK_DAYS = 15;
const num = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("en-IN", { maximumFractionDigits: Math.abs(v) >= 10 ? 0 : 1 }).format(v));
const pct = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${Math.round(v)}%`);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const shortDate = (d: string | null) => (d ? new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—");

interface Row {
  master: string;
  skuList: string;
  marketplaces: string;
  label: Label;
  peak: number | null;
  peakDate: string | null;
  bestMonth: string | null; // yyyy-mm with the highest units/day
  bestMonthUnits: number | null;
  bestMonthRate: number | null;
  bestMonthComplete: boolean;
  normal: number | null;
  now: number | null;
  change: number | null; // recent (30 days) vs usual (overall average), %
  vsPeak: number | null; // last 7 days vs peak week, %
  stock: number | null;
  stockDays: number | null; // Current Stock ÷ last-7-day sales — the popup's "Stock Left"
  stockNote: string | null; // why stockDays is missing
  slices: MarketplaceSlice[];
  mpInsight: MarketplaceInsight | null;
  impact: number; // units/month gained or lost vs normal
  priority: number; // |impact| — default sort, biggest movers (up or down) first
  action: string;
}

function actionFor(label: Label, stock: number | null, stockDays: number | null): string {
  switch (label) {
    case "Falling": return stock !== null && stock <= 0 ? "Restock first — stock is 0" : "Check stock, price, listing & ads";
    case "Growing": return stockDays !== null && stockDays < LOW_STOCK_DAYS ? `Reorder now — ~${Math.max(0, Math.round(stockDays))} days of stock left` : "Keep stock ready";
    case "Sudden jump": return "Don't overstock yet — check next week";
    case "Sudden dip": return "Watch next 7 days";
    default: return "No action";
  }
}

export function toRows(masters: ListMaster[]): Row[] {
  return masters.map((m) => {
    const label = LABEL[m.status];
    const c = m.stockCoverage;
    const stockDays = c.kind === "ok" ? c.days : null;
    const stockNote = c.kind === "scope-mismatch" ? "all marketplaces" : c.kind === "no-sales" ? "no sales" : null;
    return {
      master: m.master,
      skuList: m.skuIds.join(", "),
      marketplaces: m.marketplaces.join(", "),
      label,
      peak: m.m.peak,
      peakDate: m.m.peakDate,
      bestMonth: m.m.peakMonth,
      bestMonthUnits: m.m.peakMonthUnits,
      bestMonthRate: m.m.peakMonthRate,
      bestMonthComplete: m.m.peakMonthComplete,
      normal: m.m.baseline,
      now: m.m.recent,
      change: m.m.growth,
      vsPeak: m.m.current !== null && m.m.peakWeekRate ? ((m.m.current - m.m.peakWeekRate) / m.m.peakWeekRate) * 100 : null,
      stock: m.currentStock,
      stockDays,
      stockNote,
      slices: m.byMarketplace,
      mpInsight: marketplaceInsight(m.byMarketplace),
      impact: m.m.recent !== null && m.m.baseline !== null ? (m.m.recent - m.m.baseline) * 30 : 0,
      priority: m.m.recent !== null && m.m.baseline !== null ? Math.abs(m.m.recent - m.m.baseline) * 30 : 0,
      action: actionFor(label, m.currentStock, stockDays),
    };
  });
}

const TREND: Record<MarketplaceTrend, { arrow: string; cls: string }> = {
  up: { arrow: "▲", cls: "border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950/50 dark:text-green-400" },
  down: { arrow: "▼", cls: "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-400" },
  steady: { arrow: "●", cls: "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300" },
  low: { arrow: "·", cls: "border-slate-200 bg-transparent text-slate-400 dark:border-slate-800 dark:text-slate-500" },
};

/** One chip per marketplace: same status rules as the product, run on that marketplace alone. */
export function MarketplaceChips({ slices }: { slices: MarketplaceSlice[] }) {
  return (
    <span className="mt-0.5 flex flex-wrap gap-1">
      {slices.map((x) => {
        const t = trendOf(x.status), st = TREND[t];
        const g = x.growth === null ? "" : ` ${x.growth > 0 ? "+" : ""}${Math.round(x.growth)}%`;
        return (
          <span key={x.marketplace} className={`whitespace-nowrap rounded border px-1 text-[10px] font-semibold ${st.cls}`}
            title={`${x.marketplace}: usual ${num(x.baseline)}/day → recent ${num(x.recent)}/day${t === "low" ? " (too few sales to judge)" : ""}`}>
            {st.arrow} {x.marketplace}{t === "low" ? "" : g}
          </span>
        );
      })}
    </span>
  );
}

export function SimpleView({ masters, onPick }: { masters: ListMaster[]; onPick: (master: string) => void }) {
  const [onlyGaps, setOnlyGaps] = useState(false);
  const allRows = toRows(masters);
  const gapRows = allRows.filter((r) => r.mpInsight && r.mpInsight.kind !== "all-up" && r.mpInsight.kind !== "all-down");
  const rows = onlyGaps ? gapRows : allRows;
  const count = (l: Label[]) => rows.filter((r) => l.includes(r.label)).length;
  const byImpact = (a: Row, b: Row) => Math.abs(b.impact) - Math.abs(a.impact);
  const falling = rows.filter((r) => r.label === "Falling").sort(byImpact);
  const growing = rows.filter((r) => r.label === "Growing").sort(byImpact);
  const stockRisk = rows.filter((r) => (r.label === "Growing" && r.stockDays !== null && r.stockDays < LOW_STOCK_DAYS) || (r.label === "Falling" && r.stock !== null && r.stock <= 0)).sort(byImpact);
  const sudden = rows.filter((r) => r.label === "Sudden jump" || r.label === "Sudden dip").sort(byImpact);
  const mixed = gapRows.filter((r) => r.mpInsight?.kind === "mixed").sort(byImpact);

  const columns = [
    {
      key: "master",
      label: "Product",
      sortable: true,
      render: (val: string, row: Row) => (
        <div className="max-w-[260px]">
          <span className="block truncate text-sm font-semibold text-foreground" title={val}>{val}</span>
          {row.slices.length > 1 ? <MarketplaceChips slices={row.slices} /> : <span className="block truncate text-[10px] text-muted-foreground" title={row.marketplaces}>{row.marketplaces}</span>}
        </div>
      ),
    },
    {
      key: "skuList",
      label: "SKU",
      sortable: true,
      render: (val: string) => <span className="block max-w-[200px] whitespace-normal break-words font-mono text-xs font-bold text-foreground" title={val}>{val}</span>,
    },
    {
      key: "label",
      label: "Sales Status",
      sortable: true,
      render: (val: Label) => <span className={`whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-bold ${PILL[val]}`}>{val}</span>,
    },
    {
      key: "peak",
      label: "Peak Sales",
      sortable: true,
      render: (val: number | null, row: Row) => (
        <div><span className="font-bold text-foreground">{num(val)}</span><span className="block text-[10px] text-muted-foreground">{shortDate(row.peakDate)}</span></div>
      ),
    },
    {
      key: "bestMonthUnits",
      label: "Best Month",
      sortable: true,
      render: (val: number | null, row: Row) => row.bestMonth === null ? <span className="text-muted-foreground">—</span> : (
        <div title={row.bestMonthComplete ? undefined : "Some days of this month have no data, so its total is a partial count"}>
          <span className="font-bold text-foreground">{monthLabel(row.bestMonth)}</span>
          <span className="block text-[10px] text-muted-foreground">{num(val)} units · {num(row.bestMonthRate)}/day{row.bestMonthComplete ? "" : " · part month"}</span>
        </div>
      ),
    },
    { key: "normal", label: "Usual / Day", sortable: true, render: (val: number | null) => num(val) },
    {
      key: "now",
      label: "Recent / Day",
      sortable: true,
      render: (val: number | null) => <span className="font-bold text-foreground">{num(val)}</span>,
    },
    {
      key: "change",
      label: "vs Usual",
      sortable: true,
      render: (val: number | null) => (
        <span className={`font-bold ${val === null ? "text-muted-foreground" : val >= 40 ? "text-green-600 dark:text-green-400" : val <= -40 ? "text-red-600 dark:text-red-400" : "text-foreground"}`}>{pct(val)}</span>
      ),
    },
    {
      key: "vsPeak",
      label: "vs Peak",
      sortable: true,
      render: (val: number | null) => (
        <span className={`font-bold ${val === null ? "text-muted-foreground" : val >= -10 ? "text-green-600 dark:text-green-400" : val >= -50 ? "text-yellow-600 dark:text-yellow-400" : "text-red-600 dark:text-red-400"}`}>{pct(val)}</span>
      ),
    },
    {
      key: "stock",
      label: "Stock",
      sortable: true,
      render: (val: number | null, row: Row) => (
        <div><span className={`font-bold ${val !== null && val <= 0 ? "text-red-600 dark:text-red-400" : "text-foreground"}`}>{num(val)}</span>
          {row.stockDays !== null ? <span className={`block text-[10px] ${row.stockDays < LOW_STOCK_DAYS ? "font-bold text-red-600 dark:text-red-400" : "text-muted-foreground"}`}>~{num(row.stockDays)} days</span>
            : row.stockNote && <span className="block text-[10px] text-muted-foreground">{row.stockNote === "all marketplaces" ? "shared stock · days need All" : "no sales"}</span>}</div>
      ),
    },
    {
      key: "action",
      label: "Action",
      sortable: false,
      render: (val: string, row: Row) => <span className={`block max-w-[220px] whitespace-normal text-xs font-semibold ${row.label === "Falling" || val.startsWith("Reorder") ? "text-red-700 dark:text-red-400" : row.label === "Growing" ? "text-green-700 dark:text-green-400" : "text-muted-foreground"}`}>{val}</span>,
    },
  ];

  return (
    <div className="space-y-6">
      {/* KPI Dashboard */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <KPICard title="Growing Products" value={num(count(["Growing"]))} subtitle="Sales up for 3+ of last 4 weeks" delay={0.05} accent="green" />
        <KPICard title="Falling Products" value={num(count(["Falling"]))} subtitle="Sales down for 3+ of last 4 weeks" delay={0.1} accent="pink" />
        <KPICard title="Sudden Changes" value={num(count(["Sudden jump", "Sudden dip"]))} subtitle="Jumped or dipped recently (watch)" delay={0.15} accent="orange" />
        <KPICard title="Steady Products" value={num(count(["Steady", "Low sales"]))} subtitle="Normal sales (no action)" delay={0.2} accent="blue" />
      </div>

      {/* Actionable insights panel */}
      {(falling.length > 0 || growing.length > 0 || stockRisk.length > 0 || sudden.length > 0 || mixed.length > 0) && (
        <div className="glass space-y-3 rounded-2xl border border-border p-5 shadow-sm">
          <h3 className="flex items-center gap-2 text-sm font-bold">
            <AlertTriangle className="h-4 w-4 text-amber-500" /> Sales Insights & Recommendations
          </h3>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {mixed.slice(0, 3).map((r) => (
              <Insight key={`m-${r.master}`} r={r} tone="yellow" icon={Store} title={`Up on ${r.mpInsight!.up.join(" & ")} · down on ${r.mpInsight!.down.join(" & ")}`} onPick={onPick}
                detail={r.mpInsight!.text} action={`Compare price, stock & ads on ${r.mpInsight!.down.join(" & ")} with ${r.mpInsight!.up.join(" & ")}`} />
            ))}
            {stockRisk.slice(0, 3).map((r) => (
              <Insight key={`s-${r.master}`} r={r} tone="red" icon={PackageX} title={r.stock !== null && r.stock <= 0 ? "Out of Stock + Falling" : "Stock Running Out"} onPick={onPick}
                detail={`Stock ${num(r.stock)}${r.stockDays !== null ? ` · ~${Math.round(r.stockDays)} days left` : ""} · Now ${num(r.now)}/day`} />
            ))}
            {falling.filter((r) => !stockRisk.includes(r)).slice(0, 3).map((r) => (
              <Insight key={`f-${r.master}`} r={r} tone="red" icon={TrendingDown} title={`Sales Falling (${pct(r.change)})`} onPick={onPick}
                detail={`Normal ${num(r.normal)}/day → Now ${num(r.now)}/day · Peak ${num(r.peak)} on ${shortDate(r.peakDate)}`} />
            ))}
            {sudden.slice(0, 3).map((r) => (
              <Insight key={`u-${r.master}`} r={r} tone="yellow" icon={AlertTriangle} title={`${r.label} (${pct(r.change)})`} onPick={onPick}
                detail={`Normal ${num(r.normal)}/day → Now ${num(r.now)}/day`} />
            ))}
            {growing.filter((r) => !stockRisk.includes(r)).slice(0, 3).map((r) => (
              <Insight key={`g-${r.master}`} r={r} tone="green" icon={TrendingUp} title={`Sales Growing (${pct(r.change)})`} onPick={onPick}
                detail={`Normal ${num(r.normal)}/day → Now ${num(r.now)}/day · Peak ${num(r.peak)} on ${shortDate(r.peakDate)}`} />
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button onClick={() => setOnlyGaps((v) => !v)} className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 font-bold ${onlyGaps ? "border-amber-400 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-950/50 dark:text-amber-300" : "border-border text-muted-foreground hover:text-foreground"}`}>
          <Store size={13} /> Different trend by marketplace ({gapRows.length})
        </button>
        <span className="text-muted-foreground">Products growing on one marketplace but falling or flat on another.</span>
      </div>
      <DataTable data={rows} columns={columns} defaultSort="priority" exportName="seasonal_sales_status" onRowClick={(r) => onPick(r.master)} />
      <p className="text-[11px] text-muted-foreground">
        <b>Usual</b> = overall average sales per day (all days) · <b>Recent</b> = per day over the last 30 days · <b>Best Month</b> = the month with the highest sales per day · <b>vs Peak</b> = last 7 days vs the best week · <b>Stock days</b> = stock ÷ sales per day over the last 7 days · <b>▲ ▼ ●</b> = growing, falling or steady on that marketplace. Click a row for details.
      </p>
    </div>
  );
}

const TONE = {
  red: { box: "border-red-200 dark:border-red-900 bg-red-50/50 dark:bg-red-950/20", icon: "text-red-500", title: "text-red-800 dark:text-red-400", action: "text-red-700 dark:text-red-500" },
  yellow: { box: "border-yellow-200 dark:border-yellow-900 bg-yellow-50/50 dark:bg-yellow-950/20", icon: "text-yellow-500", title: "text-yellow-800 dark:text-yellow-400", action: "text-yellow-700 dark:text-yellow-500" },
  green: { box: "border-green-200 dark:border-green-900 bg-green-50/50 dark:bg-green-950/20", icon: "text-green-500", title: "text-green-800 dark:text-green-400", action: "text-green-700 dark:text-green-500" },
};

function Insight({ r, tone, icon: Icon, title, detail, onPick, action }: { r: Row; tone: keyof typeof TONE; icon: typeof TrendingUp; title: string; detail: string; onPick: (m: string) => void; action?: string }) {
  const t = TONE[tone];
  return (
    <button onClick={() => onPick(r.master)} className={`flex items-start gap-2.5 rounded-xl border p-3 text-left text-xs transition hover:shadow-md ${t.box}`}>
      <Icon className={`mt-0.5 h-4 w-4 flex-shrink-0 ${t.icon}`} />
      <div className="min-w-0">
        <p className={`font-bold ${t.title}`}>{title}</p>
        <p className="mt-0.5 max-w-[240px] truncate font-semibold" title={r.master}>{r.master}</p>
        <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">SKU: {r.skuList.length > 40 ? r.skuList.slice(0, 40) + "…" : r.skuList}</p>
        <p className="mt-0.5 text-[10px] text-muted-foreground">{detail}</p>
        <p className={`mt-1.5 font-bold ${t.action}`}>Action: {action ?? r.action}</p>
      </div>
    </button>
  );
}
