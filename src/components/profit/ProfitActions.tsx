"use client";

// Profit & actions (user, 12 Nov 2026): what the business earns after product cost and ads, per month
// and product (the B-ARM ERP's figures), and a short list of what to do next per product (last 30
// days). Rules: lib/profitRules.ts; data: lib/profitData.ts and the Business overview dataset.

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Boxes, PackageX, Search, TrendingUp } from "lucide-react";
import type { BiDataset } from "@/lib/bi/types";
import { productRows } from "@/lib/bi/analytics";
import { addDaysIso } from "@/lib/bi/forecast";
import { marketplacesOnly } from "@/lib/home/chatAnswers";
import { loadErpProfit, loadProductAds } from "@/lib/profitData";
import { adSpendByMonth, breakEvenAcos, productAction, profitByMonth, type Action } from "@/lib/profitRules";
import { cn } from "@/lib/utils";

const inr = (v: number) => `₹${Math.round(v).toLocaleString("en-IN")}`;
const inrShort = (v: number) => {
  const a = Math.abs(v), s = a >= 1e7 ? `₹${(a / 1e7).toFixed(2)} Cr` : a >= 1e5 ? `₹${(a / 1e5).toFixed(1)} L` : `₹${Math.round(a).toLocaleString("en-IN")}`;
  return v < 0 ? `−${s}` : s;
};
const pct = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v.toFixed(1)}%`);
const monthLabel = (m: string) => new Date(`${m}T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
const MARKET_ORDER = ["Amazon", "Flipkart", "Meesho"];
const ACTIONS: Action[] = ["Restock", "Cut ads", "Check quality", "Raise ads"];
const ACTION_ICON: Record<Action, typeof Boxes> = { Restock: Boxes, "Cut ads": ArrowDownRight, "Check quality": AlertTriangle, "Raise ads": ArrowUpRight };
const short = (n: string) => { const w = n.trim().split(/\s+/); return w.length > 7 ? `${w.slice(0, 7).join(" ")}…` : n.trim(); };

function useBi() {
  return useQuery<BiDataset>({
    queryKey: ["bi-dataset"],
    queryFn: async () => {
      const r = await fetch("/api/bi/dataset");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      return j as BiDataset;
    },
    staleTime: 10 * 60_000,
  });
}

function Card({ title, sub, children, right }: { title: string; sub?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-4 pb-3 border-b border-slate-100 dark:border-slate-800">
        <div>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-white">{title}</h2>
          {sub && <p className="text-xs text-slate-500 mt-0.5">{sub}</p>}
        </div>
        {right}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

const th = "py-2 pr-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500 whitespace-nowrap";
const td = "py-2 pr-3 tabular-nums whitespace-nowrap";

export function ProfitActions() {
  const bi = useBi();
  const erp = useQuery({ queryKey: ["erp-profit"], queryFn: () => loadErpProfit(), staleTime: 10 * 60_000 });
  const asOf = bi.data?.asOf;
  const start30 = asOf ? addDaysIso(asOf, -29) : "";
  const ads = useQuery({ queryKey: ["product-ads", start30, asOf], queryFn: () => loadProductAds(start30, asOf!), enabled: !!asOf, staleTime: 10 * 60_000 });

  const months = useMemo(() => (erp.data && bi.data ? profitByMonth(erp.data, adSpendByMonth(bi.data.dates, bi.data.ads)) : []), [erp.data, bi.data]);
  const monthKeys = [...new Set(months.map((m) => m.month))].sort();
  const [pickedMonth, setPickedMonth] = useState<string | null>(null);
  const month = pickedMonth ?? monthKeys[monthKeys.length - 1] ?? null;
  const latest = monthKeys[monthKeys.length - 1];
  const latestRows = months.filter((m) => m.month === latest);
  const sum = (k: "revenue" | "margin" | "adSpend" | "profitAfterAds") => latestRows.reduce((t, r) => t + (r[k] ?? 0), 0);

  const [onlyNoCost, setOnlyNoCost] = useState(false);
  const [q, setQ] = useState("");
  const products = useMemo(() => {
    if (!erp.data || !month) return [];
    return erp.data.skus.filter((s) => s.month === month && (s.units > 0 || s.revenue > 0) && (!onlyNoCost || s.noCost) && (!q || `${s.name} ${s.sku}`.toLowerCase().includes(q.toLowerCase())))
      .sort((a, b) => b.revenue - a.revenue);
  }, [erp.data, month, onlyNoCost, q]);
  const noCostCount = erp.data && month ? new Set(erp.data.skus.filter((s) => s.month === month && s.noCost).map((s) => `${s.marketplace}|${s.sku}`)).size : 0;

  const actions = useMemo(() => {
    if (!bi.data || !erp.data || !ads.data) return [];
    const be = breakEvenAcos(erp.data);
    const adBy = new Map(ads.data.map((a) => [`${a.channel}|${a.sku}`, a]));
    return productRows(marketplacesOnly(bi.data), 30).filter((p) => ["amazon", "flipkart", "meesho"].includes(p.channel)).map((p) => {
      const ad = adBy.get(`${p.channel}|${p.sku}`);
      const breakEven = be.get(`${p.channel}|${p.sku}`) ?? null;
      const r = productAction({ units: p.units, revenue: p.revenue, growthPct: p.growthPct, returnRatePct: p.returnRatePct, stock: p.stock, daysOfCover: p.daysOfCover, adSpend: ad?.spend ?? 0, adSales: ad?.sales ?? 0, breakEvenAcos: breakEven });
      return { p, ad, breakEven, ...r };
    }).filter((x) => x.action).sort((a, b) => ACTIONS.indexOf(a.action!) - ACTIONS.indexOf(b.action!) || b.p.revenue - a.p.revenue);
  }, [bi.data, erp.data, ads.data]);
  const [filter, setFilter] = useState<Action | "All">("All");
  const shownActions = actions.filter((a) => filter === "All" || a.action === filter);

  const loading = bi.isLoading || erp.isLoading;
  const error = bi.error || erp.error || ads.error;

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-24">
      <header className="pt-1">
        <h1 className="text-[28px] leading-tight font-semibold tracking-tight text-slate-900 dark:text-white">Profit &amp; actions</h1>
        <p className="text-sm text-slate-500 mt-1">What Amazon, Flipkart and Meesho earn after product cost and ads, and what to do next for each product.</p>
      </header>

      {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">Couldn&apos;t load the figures ({error instanceof Error ? error.message : "error"}). Reload to try again.</div>}
      {loading && <div role="status" className="grid grid-cols-2 lg:grid-cols-4 gap-3">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-24 rounded-2xl bg-white border border-slate-200 animate-pulse" />)}</div>}

      {latest && (
        <>
          {/* latest ERP month */}
          <section aria-label={`${monthLabel(latest)} totals`} className="grid grid-cols-2 lg:grid-cols-4 gap-px rounded-2xl overflow-hidden border border-slate-200 dark:border-slate-800 bg-slate-200 dark:bg-slate-800">
            {[
              { l: `Revenue excl. tax · ${monthLabel(latest)}`, v: inrShort(sum("revenue")), s: "Amazon, Flipkart and Meesho (ERP)" },
              { l: "Gross margin", v: inrShort(sum("margin")), s: `${pct(sum("revenue") ? (sum("margin") / sum("revenue")) * 100 : null)} of revenue, after product cost` },
              { l: "Ad spend", v: inrShort(sum("adSpend")), s: "excl. GST, all three marketplaces" },
              { l: "Profit after ads", v: inrShort(sum("profitAfterAds")), s: `${pct(sum("revenue") ? (sum("profitAfterAds") / sum("revenue")) * 100 : null)} of revenue` },
            ].map((t) => (
              <div key={t.l} className="bg-white dark:bg-slate-900 p-5">
                <p className="text-xs font-medium text-slate-500">{t.l}</p>
                <p className="mt-2 text-[26px] leading-none font-semibold tracking-tight text-slate-900 dark:text-white tabular-nums">{t.v}</p>
                <p className="mt-2 text-xs text-slate-500">{t.s}</p>
              </div>
            ))}
          </section>

          <Card title="Profit by month" sub="The B-ARM ERP's figures (its monthly invoice reports), less ad spend excl. GST. Months the ERP has not received yet are not shown.">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[760px]">
                <thead><tr className="text-left border-b border-slate-100 dark:border-slate-800">
                  <th className={th}>Month</th><th className={th}>Marketplace</th><th className={cn(th, "text-right")}>Revenue excl. tax</th><th className={cn(th, "text-right")}>Product cost</th>
                  <th className={cn(th, "text-right")}>Gross margin</th><th className={cn(th, "text-right")}>Margin %</th><th className={cn(th, "text-right")}>Ad spend</th><th className={cn(th, "text-right")}>Profit after ads</th>
                </tr></thead>
                <tbody>
                  {[...monthKeys].reverse().map((mk) => {
                    const rows = months.filter((m) => m.month === mk).sort((a, b) => MARKET_ORDER.indexOf(a.marketplace) - MARKET_ORDER.indexOf(b.marketplace));
                    const tot = (k: "revenue" | "cost" | "margin" | "adSpend" | "profitAfterAds") => rows.reduce((t, r) => t + (r[k] ?? 0), 0);
                    return [
                      ...rows.map((r, i) => (
                        <tr key={`${mk}${r.marketplace}`} className="text-slate-700 dark:text-slate-300">
                          <td className={cn(td, "font-medium text-slate-900 dark:text-white")}>{i === 0 ? monthLabel(mk) : ""}</td>
                          <td className={td}>{r.marketplace}{r.linesWithoutCost > 0 && <span title={`${r.linesWithoutCost} sold lines have no cost price, so margin is overstated`} className="ml-1.5 text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded px-1">{r.linesWithoutCost} no cost</span>}</td>
                          <td className={cn(td, "text-right")}>{inr(r.revenue)}</td><td className={cn(td, "text-right")}>{inr(r.cost)}</td>
                          <td className={cn(td, "text-right")}>{inr(r.margin)}</td><td className={cn(td, "text-right")}>{pct(r.marginPct)}</td>
                          <td className={cn(td, "text-right")}>{r.adSpend === null ? "—" : inr(r.adSpend)}</td>
                          <td className={cn(td, "text-right font-semibold", (r.profitAfterAds ?? 0) < 0 ? "text-red-700" : "text-slate-900 dark:text-white")}>{r.profitAfterAds === null ? "—" : inr(r.profitAfterAds)}</td>
                        </tr>
                      )),
                      <tr key={`${mk}total`} className="border-b border-slate-200 dark:border-slate-700 font-semibold text-slate-900 dark:text-white">
                        <td className={td} /><td className={td}>Total</td>
                        <td className={cn(td, "text-right")}>{inr(tot("revenue"))}</td><td className={cn(td, "text-right")}>{inr(tot("cost"))}</td>
                        <td className={cn(td, "text-right")}>{inr(tot("margin"))}</td><td className={cn(td, "text-right")}>{pct(tot("revenue") ? (tot("margin") / tot("revenue")) * 100 : null)}</td>
                        <td className={cn(td, "text-right")}>{inr(tot("adSpend"))}</td><td className={cn(td, "text-right")}>{inr(tot("profitAfterAds"))}</td>
                      </tr>,
                    ];
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <Card
            title={`Products · ${month ? monthLabel(month) : ""}`}
            sub="Margin per product from the ERP (net of returns). Products with no cost price in Master show their whole revenue as margin."
            right={<div className="flex flex-wrap gap-1.5">{monthKeys.map((mk) => <button key={mk} onClick={() => setPickedMonth(mk)} className={cn("rounded-full px-3 py-1 text-xs border", mk === month ? "bg-slate-900 text-white border-slate-900 dark:bg-white dark:text-slate-900" : "border-slate-200 text-slate-600 hover:bg-slate-50")}>{monthLabel(mk).split(" ")[0]}</button>)}</div>}
          >
            <div className="flex flex-wrap items-center gap-3 mb-3">
              <label className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden />
                <span className="sr-only">Find a product</span>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a product or SKU" className="pl-8 pr-3 h-8 w-64 rounded-lg border border-slate-200 text-sm outline-none focus:border-slate-400 bg-white dark:bg-slate-900" />
              </label>
              <button onClick={() => setOnlyNoCost((v) => !v)} className={cn("inline-flex items-center gap-1.5 rounded-full px-3 h-8 text-xs border", onlyNoCost ? "bg-amber-50 border-amber-300 text-amber-800" : "border-slate-200 text-slate-600 hover:bg-slate-50")}>
                <PackageX className="w-3.5 h-3.5" /> No cost price ({noCostCount})
              </button>
              {noCostCount > 0 && <Link href="/dashboard/master" className="text-xs font-medium text-slate-700 underline underline-offset-4">Add costs in Master</Link>}
            </div>
            <div className="overflow-x-auto max-h-[520px]">
              <table className="w-full text-sm min-w-[720px]">
                <thead className="sticky top-0 bg-white dark:bg-slate-900"><tr className="text-left border-b border-slate-100 dark:border-slate-800">
                  <th className={th}>Product</th><th className={th}>Channel</th><th className={cn(th, "text-right")}>Net units</th><th className={cn(th, "text-right")}>Revenue excl. tax</th>
                  <th className={cn(th, "text-right")}>Cost</th><th className={cn(th, "text-right")}>Margin</th><th className={cn(th, "text-right")}>Margin %</th>
                </tr></thead>
                <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
                  {products.slice(0, 150).map((s) => (
                    <tr key={`${s.marketplace}${s.sku}`} className="text-slate-700 dark:text-slate-300">
                      <td className={cn(td, "max-w-[340px] truncate")} title={`${s.name} (${s.sku})`}>{short(s.name)} <span className="text-[11px] text-slate-400">{s.sku}</span>{s.noCost && <span className="ml-1.5 text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded px-1">no cost</span>}</td>
                      <td className={td}>{s.marketplace}</td><td className={cn(td, "text-right")}>{Math.round(s.units).toLocaleString("en-IN")}</td>
                      <td className={cn(td, "text-right")}>{inr(s.revenue)}</td><td className={cn(td, "text-right")}>{inr(s.cost)}</td>
                      <td className={cn(td, "text-right", s.margin < 0 && "text-red-700")}>{inr(s.margin)}</td><td className={cn(td, "text-right")}>{pct(s.revenue ? (s.margin / s.revenue) * 100 : null)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {products.length > 150 && <p className="text-xs text-slate-500 mt-2">Showing the 150 largest of {products.length}. Search to find the rest.</p>}
            </div>
          </Card>
        </>
      )}

      <Card
        title="What to do next"
        sub={asOf ? `Per product, last 30 days to ${asOf.split("-").reverse().join(".")}. Break-even ACOS = the product's margin ÷ its sales (ERP); ad spend excl. GST.` : undefined}
        right={<div className="flex flex-wrap gap-1.5">{(["All", ...ACTIONS] as const).map((a) => {
          const n = a === "All" ? actions.length : actions.filter((x) => x.action === a).length;
          return <button key={a} onClick={() => setFilter(a)} className={cn("rounded-full px-3 py-1 text-xs border", filter === a ? "bg-slate-900 text-white border-slate-900 dark:bg-white dark:text-slate-900" : "border-slate-200 text-slate-600 hover:bg-slate-50")}>{a} ({n})</button>;
        })}</div>}
      >
        {(bi.isLoading || erp.isLoading || ads.isLoading) && <p className="text-sm text-slate-500">Working out the actions…</p>}
        {!ads.isLoading && actions.length === 0 && bi.data && erp.data && <p className="text-sm text-slate-500">Nothing needs action right now.</p>}
        {shownActions.length > 0 && (
          <div className="overflow-x-auto max-h-[640px]">
            <table className="w-full text-sm min-w-[980px]">
              <thead className="sticky top-0 bg-white dark:bg-slate-900"><tr className="text-left border-b border-slate-100 dark:border-slate-800">
                <th className={th}>Action</th><th className={th}>Product</th><th className={cn(th, "text-right")}>Units (30d)</th><th className={cn(th, "text-right")}>Trend</th>
                <th className={cn(th, "text-right")}>Ad spend</th><th className={cn(th, "text-right")}>ACOS</th><th className={cn(th, "text-right")}>Break-even</th>
                <th className={cn(th, "text-right")}>Returns</th><th className={cn(th, "text-right")}>FBA days</th><th className={th}>Why</th>
              </tr></thead>
              <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
                {shownActions.slice(0, 200).map(({ p, ad, breakEven, action, acos, reason }) => {
                  const Icon = ACTION_ICON[action!];
                  return (
                    <tr key={`${p.channel}${p.sku}`} className="text-slate-700 dark:text-slate-300 align-top">
                      <td className={td}><span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 dark:border-slate-700 px-2.5 py-0.5 text-xs font-medium text-slate-800 dark:text-slate-200"><Icon className="w-3.5 h-3.5" aria-hidden />{action}</span></td>
                      <td className={cn(td, "max-w-[300px] truncate")} title={`${p.name} (${p.sku})`}>{short(p.name)} <span className="text-[11px] text-slate-400 capitalize">{p.channel}</span></td>
                      <td className={cn(td, "text-right")}>{p.units.toLocaleString("en-IN")}</td>
                      <td className={cn(td, "text-right")}>{p.growthPct === null ? "—" : `${p.growthPct >= 0 ? "▲" : "▼"} ${Math.abs(p.growthPct).toFixed(0)}%`}</td>
                      <td className={cn(td, "text-right")}>{ad?.spend ? inr(ad.spend) : "—"}</td>
                      <td className={cn(td, "text-right")}>{pct(acos)}</td>
                      <td className={cn(td, "text-right")}>{pct(breakEven)}</td>
                      <td className={cn(td, "text-right")}>{pct(p.returnRatePct)}</td>
                      <td className={cn(td, "text-right")}>{p.stock === null ? "—" : p.stock === 0 ? "0" : p.daysOfCover === null ? "—" : Math.floor(p.daysOfCover)}</td>
                      <td className="py-2 text-xs text-slate-500 min-w-[240px]">{reason}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-slate-500 mt-3 flex items-start gap-1.5"><TrendingUp className="w-3.5 h-3.5 mt-0.5 shrink-0" />Restock: FBA stock is 0 or lasts under 3 weeks. Cut ads: ACOS above break-even, or ₹500+ spend with no ad sales. Check quality: 15%+ returned (10+ units). Raise ads: ACOS under half its break-even, sales steady, 45+ days of stock. Products without a cost price get no ad advice.</p>
      </Card>
    </div>
  );
}
