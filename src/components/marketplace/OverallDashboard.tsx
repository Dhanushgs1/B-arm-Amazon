"use client";

import { useState } from "react";
import Link from "next/link";
import { useQueries, useQuery } from "@tanstack/react-query";
import { ArrowRight, Loader2, ThumbsUp, AlertTriangle, Trophy, TrendingDown, TrendingUp } from "lucide-react";
import { useDashboard } from "@/lib/DashboardContext";
import { KPICard } from "@/components/KPICard";
import { BrandLogo, type BrandId } from "@/components/BrandLogo";
import { ProductSearchBox } from "@/components/marketplace/ProductSearchBox";
import { fetchAmazonSummary, fetchFlipkartAllSummary, fetchMeeshoSummary, previousRange, type ChannelSummary } from "@/lib/channelSummary";
import { fetchShopifyAllSummary, fetchShopifyOrders } from "@/lib/shopifyOrders";
import { resolveDailySpend } from "@/lib/adSpendDailyRules";
import { shopifySourceDetail } from "@/lib/shopifySourceRules";
import { loadMarketplaceAds, loadSpendWindows, type MarketplaceAdKey } from "@/lib/overallData";
import { matchesProductQuery } from "@/lib/productSearch";
import {
  campaignStatsFromRows, campaignStatsFromSpend, campaignHighlights,
  platformInsights, platformMetrics, platformStatus, CAMPAIGN_MIN_SPEND, GST_MULTIPLIER, GOOD_ACOS, BAD_ACOS,
  type AdPlatform, type CampaignStat, type Insight, type PlatformSnapshot, type PlatformStatus,
} from "@/lib/overallRules";
import { cn } from "@/lib/utils";

const cur = (v: number) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(v || 0))}`;
const num = (v: number) => new Intl.NumberFormat("en-IN").format(Math.round(v || 0));
const one = (v: number) => (Math.round(v * 10) / 10).toFixed(1);

// Same query keys as AllMarketplacesSummary, so the detail table below shares these loads.
const SALES = [
  { id: "amazon", fetcher: fetchAmazonSummary },
  { id: "flipkart", fetcher: fetchFlipkartAllSummary },
  { id: "meesho", fetcher: fetchMeeshoSummary },
  { id: "shopify", fetcher: fetchShopifyAllSummary },
] as const;
const MARKET_ADS: MarketplaceAdKey[] = ["amazon", "flipkart", "meesho"];

type PlatformKey = "amazon" | "flipkart" | "meesho" | "shopify" | "google" | "meta";
const PLATFORMS: { key: PlatformKey; label: string; color: string; href: string; brand?: BrandId; letter?: string; salesNote: string }[] = [
  { key: "amazon", label: "Amazon", color: "#FF9900", href: "/dashboard", brand: "amazon", salesNote: "Gross sales" },
  { key: "flipkart", label: "Flipkart", color: "#2874F0", href: "/dashboard/flipkart", brand: "flipkart", salesNote: "Gross sales" },
  { key: "meesho", label: "Meesho", color: "#9F2089", href: "/dashboard/meesho", brand: "meesho", salesNote: "Gross sales" },
  { key: "shopify", label: "Shopify (website)", color: "#5E8E3E", href: "/dashboard/shopify", brand: "shopify", salesNote: "Order total, cancellations left out" },
  { key: "google", label: "Google Ads", color: "#4285F4", href: "/dashboard/shopify/sources?source=google_ads", letter: "G", salesNote: "Shopify orders from Google Ads" },
  { key: "meta", label: "Meta Ads", color: "#0866FF", href: "/dashboard/shopify/sources?source=meta_ads", letter: "M", salesNote: "Shopify orders from Meta Ads" },
];
const AD_TABS: { key: AdPlatform; label: string }[] = [
  { key: "amazon", label: "Amazon" }, { key: "flipkart", label: "Flipkart" }, { key: "meesho", label: "Meesho" }, { key: "google", label: "Google Ads" }, { key: "meta", label: "Meta Ads" },
];

function Mark({ p, size = 18 }: { p: (typeof PLATFORMS)[number]; size?: number }) {
  if (p.brand) return <BrandLogo brand={p.brand} size={size} />;
  return (
    <span className="inline-flex items-center justify-center rounded-md text-white font-black" style={{ width: size, height: size, background: p.color, fontSize: size * 0.6 }} aria-hidden>
      {p.letter}
    </span>
  );
}

function Growth({ v, inverse }: { v: number | null; inverse?: boolean }) {
  if (v === null) return null;
  const good = inverse ? v < 0 : v > 0;
  const Icon = v >= 0 ? TrendingUp : TrendingDown;
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-[11px] font-bold", Math.abs(v) < 0.05 ? "text-muted-foreground" : good ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>
      <Icon className="w-3 h-3" /> {v > 0 ? "+" : ""}{one(v)}%
    </span>
  );
}

const STATUS: Record<PlatformStatus, { label: string; cls: string }> = {
  good: { label: "Doing well", cls: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30" },
  watch: { label: "Needs attention", cls: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30" },
  steady: { label: "Steady", cls: "bg-muted text-muted-foreground border-border" },
};

/** Orders, returns and cancellations for a marketplace card (Google/Meta have none of their own). */
function OrderStats({ s }: { s: ChannelSummary }) {
  const c = s.current;
  const tracked = s.returnsTracked !== false;
  const rate = tracked && c.units > 0 ? (c.allReturns / c.units) * 100 : null;
  return (
    <div className="grid grid-cols-3 gap-2 text-xs border-t border-border/60 pt-2.5">
      <div>
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">Orders</p>
        <p className="font-black">{num(c.orders)}</p>
        <p className="text-[10px] text-muted-foreground">{num(c.units)} units</p>
      </div>
      <div>
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">Returns</p>
        <p className="font-black">{tracked ? num(c.allReturns) : "—"}</p>
        <p className="text-[10px] text-muted-foreground">{tracked ? `${rate === null ? "—" : one(rate) + "%"} of units · ${num(c.customerReturns)} customer` : "Not tracked"}</p>
      </div>
      <div>
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">Cancelled</p>
        <p className="font-black">{c.cancelledOrders === undefined ? "—" : num(c.cancelledOrders)}</p>
        <p className="text-[10px] text-muted-foreground">{c.cancelledOrders === undefined ? "Not tracked" : `last period ${num(s.previous.cancelledOrders ?? 0)}`}</p>
      </div>
    </div>
  );
}

function PlatformCard({ p, snap, loading, insights, note, summary }: { p: (typeof PLATFORMS)[number]; snap: PlatformSnapshot; loading: boolean; insights: Insight[]; note?: string; summary?: ChannelSummary }) {
  const m = platformMetrics(snap);
  const status = platformStatus(insights);
  return (
    <Link href={p.href} className="group glass rounded-2xl border border-border p-4 shadow-sm space-y-3 min-w-0 hover:border-indigo-500/40 transition-colors">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-black text-sm truncate"><Mark p={p} /> {p.label}</span>
        {loading ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
        ) : (
          <span className={cn("text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full border whitespace-nowrap", STATUS[status].cls)}>{STATUS[status].label}</span>
        )}
      </div>
      <div>
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">{p.salesNote}</p>
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-2xl font-black tracking-tight">{snap.sales === null ? "…" : cur(snap.sales)}</span>
          <Growth v={m.salesGrowth} />
        </div>
        {snap.salesPrev !== null && <p className="text-[11px] text-muted-foreground">{snap.attributed && snap.orders !== null ? `${num(snap.orders)} orders · ` : ""}last period {cur(snap.salesPrev)}</p>}
      </div>
      {summary && <OrderStats s={summary} />}
      <div className="grid grid-cols-3 gap-2 text-xs border-t border-border/60 pt-2.5">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">Ad spend</p>
          <p className="font-black">{snap.adSpend === null ? (loading ? "…" : "No ads") : cur(snap.adSpend * GST_MULTIPLIER)}</p>
          <Growth v={m.spendGrowth} inverse />
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">ROAS</p>
          <p className="font-black">{m.roas === null ? "—" : `${one(m.roas)}x`}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">{snap.attributed ? "Cost / order" : "TACOS"}</p>
          <p className="font-black">
            {snap.attributed
              ? snap.adSpend && snap.orders ? cur(snap.adSpend / snap.orders) : "—"
              : m.tacos === null ? "—" : `${one(m.tacos)}%`}
          </p>
        </div>
      </div>
      {insights.length > 0 && (
        <ul className="space-y-1">
          {insights.map((i) => (
            <li key={i.text} className={cn("text-[11px] leading-snug", i.tone === "good" ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300")}>
              {i.tone === "good" ? "▲" : "●"} {i.text}
            </li>
          ))}
        </ul>
      )}
      {note && <p className="text-[10px] text-muted-foreground">{note}</p>}
      <span className="inline-flex items-center gap-1 text-[11px] font-bold text-indigo-600 dark:text-indigo-400 group-hover:underline">
        Open {p.label} <ArrowRight className="w-3 h-3" />
      </span>
    </Link>
  );
}

function CampaignList({ title, icon, rows, tone, empty }: { title: string; icon: React.ReactNode; rows: CampaignStat[]; tone: "good" | "bad"; empty: string }) {
  return (
    <div className={cn("rounded-xl border p-3 space-y-2", tone === "good" ? "border-emerald-500/25 bg-emerald-500/5" : "border-red-500/25 bg-red-500/5")}>
      <p className="text-[10px] font-black uppercase tracking-widest flex items-center gap-1.5">{icon} {title}</p>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        rows.map((c) => (
          <div key={c.id} className="flex items-baseline justify-between gap-3 text-xs">
            <span className="font-semibold truncate" title={c.name}>{c.name}</span>
            <span className="whitespace-nowrap text-muted-foreground">
              {cur(c.spend)} → <span className="font-bold text-foreground">{cur(c.sales ?? 0)}</span>
              {c.acos !== null ? ` · ACOS ${one(c.acos)}%` : " · no sales"}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

function CampaignsSection({ stats, loading }: { stats: Record<AdPlatform, CampaignStat[] | undefined>; loading: Record<AdPlatform, boolean> }) {
  const [tab, setTab] = useState<AdPlatform>("amazon");
  const [search, setSearch] = useState("");
  const all = stats[tab] ?? [];
  const shown = all.filter((c) => matchesProductQuery(search, c.name, c.id));
  const h = campaignHighlights(all);
  const spendOnly = tab === "google" || tab === "meta";
  const verdictCls: Record<string, string> = {
    best: "text-emerald-700 dark:text-emerald-300", losing: "text-red-600 dark:text-red-400", ok: "text-muted-foreground", small: "text-muted-foreground", "spend-only": "text-muted-foreground",
  };
  const verdictLabel: Record<string, string> = { best: "Best", losing: "Losing", ok: "OK", small: "Low spend", "spend-only": "" };

  return (
    <div className="glass rounded-2xl border border-border p-5 shadow-sm space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-black tracking-tight">Which campaigns work — per platform</h3>
        <div className="flex flex-wrap gap-1.5">
          {AD_TABS.map((t) => {
            const p = PLATFORMS.find((x) => x.key === t.key)!;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => { setTab(t.key); setSearch(""); }}
                className={cn("inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-black border", tab === t.key ? "bg-indigo-600 text-white border-indigo-600" : "bg-background border-border hover:bg-muted")}
              >
                <Mark p={p} size={14} /> {t.label}
                {stats[t.key] && <span className="opacity-70 font-bold">{stats[t.key]!.length}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {loading[tab] && !stats[tab] ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-6 justify-center"><Loader2 className="w-4 h-4 animate-spin" /> Loading campaigns…</div>
      ) : (
        <>
          {spendOnly ? (
            <p className="text-[11px] text-muted-foreground rounded-xl border border-dashed border-border px-3 py-2">
              The {tab === "google" ? "Google Ads" : "Meta"} upload has spend per campaign but no sales per campaign, so campaigns are ranked by spend.
              Sales from these ads (Shopify orders tagged {tab === "google" ? "Google Ads" : "Meta Ads"}) are on the platform card above and the{" "}
              <Link href={`/dashboard/shopify/sources?source=${tab === "google" ? "google_ads" : "meta_ads"}`} className="font-bold text-indigo-600 dark:text-indigo-400 hover:underline">Google &amp; Meta page</Link>.
            </p>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <CampaignList title={`Best — ACOS ${GOOD_ACOS}% or less`} icon={<Trophy className="w-3 h-3 text-emerald-600" />} rows={h.best} tone="good" empty={`No campaign with at least ₹${CAMPAIGN_MIN_SPEND[tab]} spend has ACOS at or under ${GOOD_ACOS}%.`} />
              <CampaignList title={`Losing money — no sales or ACOS over ${BAD_ACOS}%`} icon={<AlertTriangle className="w-3 h-3 text-red-600" />} rows={h.losing} tone="bad" empty="No campaign is losing money in these dates." />
            </div>
          )}

          <ProductSearchBox value={search} onChange={setSearch} shown={shown.length} total={all.length} placeholder="Search campaign…" noun="campaigns" />
          {all.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">No ad spend uploaded for these dates.</p>
          ) : (
            <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-background">
                  <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                    <th className="py-2 pr-3 font-black">{tab === "meesho" ? "Product (SKU)" : "Campaign"}</th>
                    <th className="py-2 pr-3 font-black text-right">Spend</th>
                    {spendOnly ? (
                      <th className="py-2 pr-3 font-black text-right">Clicks</th>
                    ) : (
                      <>
                        <th className="py-2 pr-3 font-black text-right">{tab === "meesho" ? "Sales (est.)" : "Ad sales"}</th>
                        <th className="py-2 pr-3 font-black text-right">Orders</th>
                        <th className="py-2 pr-3 font-black text-right">ROAS</th>
                        <th className="py-2 pr-3 font-black text-right">ACOS</th>
                        <th className="py-2 font-black">Verdict</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((c) => (
                    <tr key={c.id} className="border-b border-border/60">
                      <td className="py-1.5 pr-3 font-semibold min-w-[220px]">{c.name}</td>
                      <td className="py-1.5 pr-3 text-right whitespace-nowrap">{cur(c.spend)}</td>
                      {spendOnly ? (
                        <td className="py-1.5 pr-3 text-right">{c.clicks === null ? "—" : num(c.clicks)}</td>
                      ) : (
                        <>
                          <td className="py-1.5 pr-3 text-right whitespace-nowrap">{cur(c.sales ?? 0)}</td>
                          <td className="py-1.5 pr-3 text-right">{num(c.orders ?? 0)}</td>
                          <td className="py-1.5 pr-3 text-right">{c.roas === null ? "—" : `${one(c.roas)}x`}</td>
                          <td className="py-1.5 pr-3 text-right">{c.acos === null ? "—" : `${one(c.acos)}%`}</td>
                          <td className={cn("py-1.5 font-bold whitespace-nowrap", verdictCls[c.verdict])}>{verdictLabel[c.verdict]}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      <p className="text-[11px] text-muted-foreground">
        Campaign spend is as the ad console shows it (no GST). Ad sales are what each ads report credits to the campaign: Amazon 7-day sales, Flipkart revenue,
        Meesho ad orders × that product&apos;s average Meesho price. Campaigns under ₹{CAMPAIGN_MIN_SPEND.amazon} spend (Meesho ₹{CAMPAIGN_MIN_SPEND.meesho}) are marked Low spend and not judged.
      </p>
    </div>
  );
}

/** The Overall page: every platform's sales and ad spend for the selected dates, what is doing well,
 *  what needs attention, and which campaigns work. Rules: overallRules.ts (unit tested). */
export function OverallDashboard() {
  const { startDate: start, endDate: end } = useDashboard();
  const enabled = !!start && !!end;
  const prev = enabled ? previousRange(start, end) : { start: "", end: "" };

  const salesQ = useQueries({
    queries: SALES.map((c) => ({ queryKey: ["all-marketplaces-v2", c.id, start, end], queryFn: () => c.fetcher(start, end), enabled })),
  });
  const adsQ = useQueries({
    queries: MARKET_ADS.map((k) => ({ queryKey: ["overall-ads", k, prev.start, end], queryFn: () => loadMarketplaceAds(k, prev.start, end), enabled })),
  });
  const windowsQ = useQueries({
    queries: (["google", "meta"] as const).map((k) => ({ queryKey: ["overall-spend", k, prev.start, end], queryFn: () => loadSpendWindows(k, prev.start, end), enabled })),
  });
  const ordersQ = useQuery({ queryKey: ["shopify-orders-all"], queryFn: fetchShopifyOrders });

  const sales = Object.fromEntries(SALES.map((c, i) => [c.id, salesQ[i].data as ChannelSummary | undefined]));
  const salesErr = Object.fromEntries(SALES.map((c, i) => [c.id, salesQ[i].error]));
  const ads = Object.fromEntries(MARKET_ADS.map((k, i) => [k, adsQ[i].data]));

  const sumAds = (k: MarketplaceAdKey, from: string, to: string) => {
    const rows = ads[k];
    if (!rows) return null;
    const inRange = rows.filter((r) => r.date >= from && r.date <= to);
    return { spend: inRange.reduce((t, r) => t + r.spend, 0), sales: inRange.reduce((t, r) => t + r.sales, 0) };
  };

  // Google / Meta: spend per day from the report windows, sales from the Shopify orders they brought
  const paid = (["google", "meta"] as const).map((k, i) => {
    const rows = windowsQ[i].data;
    const orders = ordersQ.data;
    if (!rows || !orders) return null;
    const source = k === "google" ? "google_ads" : "meta_ads";
    const now = resolveDailySpend(rows, start, end);
    const before = resolveDailySpend(rows, prev.start, prev.end);
    return { now, d: shopifySourceDetail(orders, source, now, start, end), p: shopifySourceDetail(orders, source, before, prev.start, prev.end), before };
  });
  const [google, meta] = paid;

  const snaps: Record<PlatformKey, PlatformSnapshot> = {} as Record<PlatformKey, PlatformSnapshot>;
  for (const k of MARKET_ADS) {
    const s = sales[k];
    const a = sumAds(k, start, end);
    const b = sumAds(k, prev.start, prev.end);
    snaps[k] = {
      key: k, label: PLATFORMS.find((p) => p.key === k)!.label,
      sales: s ? s.current.sales ?? 0 : null, salesPrev: s ? s.previous.sales ?? 0 : null, orders: s ? s.current.orders : null,
      adSpend: a ? a.spend : null, adSpendPrev: b ? b.spend : null, adSales: a ? a.sales : null,
      dataThrough: s?.dataThrough ?? null, rangeEnd: end,
    };
  }
  const shop = sales.shopify;
  const bothPaid = google && meta;
  snaps.shopify = {
    key: "shopify", label: "Shopify",
    sales: shop ? shop.current.sales ?? 0 : null, salesPrev: shop ? shop.previous.sales ?? 0 : null, orders: shop ? shop.current.orders : null,
    adSpend: bothPaid ? google.now.spend + meta.now.spend : null, adSpendPrev: bothPaid ? google.before.spend + meta.before.spend : null,
    adSales: bothPaid ? google.d.coveredSales + meta.d.coveredSales : null, rangeEnd: end,
  };
  for (const [k, x] of [["google", google], ["meta", meta]] as const) {
    snaps[k] = {
      key: k, label: PLATFORMS.find((p) => p.key === k)!.label, attributed: true,
      sales: x ? x.d.sales : null, salesPrev: x ? x.p.sales : null, orders: x ? x.d.netOrders : null,
      adSpend: x ? x.now.spend : null, adSpendPrev: x ? x.before.spend : null, adSales: x ? x.d.coveredSales : null, rangeEnd: end,
    };
  }

  const loading: Record<PlatformKey, boolean> = {
    amazon: !sales.amazon || !ads.amazon, flipkart: !sales.flipkart || !ads.flipkart, meesho: !sales.meesho || !ads.meesho,
    shopify: !shop || !bothPaid, google: !google, meta: !meta,
  };
  const insights = Object.fromEntries(PLATFORMS.map((p) => [p.key, loading[p.key] ? [] : platformInsights(snaps[p.key])])) as Record<PlatformKey, Insight[]>;
  const coverageNote = (x: typeof google) =>
    x && x.now.coveredDays < x.now.totalDays ? `Spend known for ${x.now.coveredDays} of ${x.now.totalDays} days — ROAS uses those days only.` : undefined;

  // Totals: Google/Meta sales are already inside Shopify, so only their spend is added.
  const salesKeys: PlatformKey[] = ["amazon", "flipkart", "meesho", "shopify"];
  const spendKeys: PlatformKey[] = ["amazon", "flipkart", "meesho", "google", "meta"];
  const salesReady = salesKeys.filter((k) => snaps[k].sales !== null);
  const spendReady = spendKeys.filter((k) => snaps[k].adSpend !== null);
  const tot = {
    sales: salesReady.reduce((t, k) => t + (snaps[k].sales ?? 0), 0),
    salesPrev: salesReady.reduce((t, k) => t + (snaps[k].salesPrev ?? 0), 0),
    orders: salesReady.reduce((t, k) => t + (snaps[k].orders ?? 0), 0),
    returns: salesReady.reduce((t, k) => t + (sales[k]?.current.allReturns ?? 0), 0),
    returnsPrev: salesReady.reduce((t, k) => t + (sales[k]?.previous.allReturns ?? 0), 0),
    units: salesReady.reduce((t, k) => t + (sales[k]?.current.units ?? 0), 0),
    cancelled: salesReady.reduce((t, k) => t + (sales[k]?.current.cancelledOrders ?? 0), 0),
    cancelledPrev: salesReady.reduce((t, k) => t + (sales[k]?.previous.cancelledOrders ?? 0), 0),
    spend: spendReady.reduce((t, k) => t + (snaps[k].adSpend ?? 0), 0) * GST_MULTIPLIER,
    spendPrev: spendReady.reduce((t, k) => t + (snaps[k].adSpendPrev ?? 0), 0) * GST_MULTIPLIER,
  };
  const spendFor = (k: PlatformKey) => (k === "shopify" ? (snaps.google.adSpend ?? 0) + (snaps.meta.adSpend ?? 0) : snaps[k].adSpend ?? 0);
  const tacosKeys = salesKeys.filter((k) => snaps[k].sales !== null && (k === "shopify" ? snaps.google.adSpend !== null && snaps.meta.adSpend !== null : snaps[k].adSpend !== null));
  const tacosSales = tacosKeys.reduce((t, k) => t + (snaps[k].sales ?? 0), 0);
  const tacos = tacosSales > 0 ? (tacosKeys.reduce((t, k) => t + spendFor(k), 0) * GST_MULTIPLIER / tacosSales) * 100 : null;
  const g = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 1000) / 10 : undefined);
  const allSales = salesReady.length === salesKeys.length;
  const allSpend = spendReady.length === spendKeys.length;
  const partial = (ready: number, of: number) => (ready < of ? ` · ${ready} of ${of} loaded` : "");

  const allInsights = PLATFORMS.flatMap((p) => insights[p.key]);
  const good = allInsights.filter((i) => i.tone === "good");
  const watch = allInsights.filter((i) => i.tone === "watch");
  const best = salesReady.length ? [...salesReady].sort((a, b) => (snaps[b].sales ?? 0) - (snaps[a].sales ?? 0))[0] : null;

  const campaignStats: Record<AdPlatform, CampaignStat[] | undefined> = {
    amazon: ads.amazon && campaignStatsFromRows(ads.amazon, start, end, CAMPAIGN_MIN_SPEND.amazon),
    flipkart: ads.flipkart && campaignStatsFromRows(ads.flipkart, start, end, CAMPAIGN_MIN_SPEND.flipkart),
    meesho: ads.meesho && campaignStatsFromRows(ads.meesho, start, end, CAMPAIGN_MIN_SPEND.meesho),
    google: google ? campaignStatsFromSpend(google.now.campaigns) : undefined,
    meta: meta ? campaignStatsFromSpend(meta.now.campaigns) : undefined,
  };
  const campaignLoading: Record<AdPlatform, boolean> = {
    amazon: adsQ[0].isLoading, flipkart: adsQ[1].isLoading, meesho: adsQ[2].isLoading, google: !google, meta: !meta,
  };

  if (!enabled) return null;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        <KPICard title="Total Sales" value={cur(tot.sales)} subtitle={`Last period ${cur(tot.salesPrev)}${partial(salesReady.length, salesKeys.length)}`} trend={allSales ? g(tot.sales, tot.salesPrev) : undefined} accent="green" />
        <KPICard title="Orders" value={num(tot.orders)} subtitle={`${num(tot.units)} units · all 4 sales channels${partial(salesReady.length, salesKeys.length)}`} accent="blue" />
        <KPICard title="Returns" value={num(tot.returns)} subtitle={`${tot.units > 0 ? one((tot.returns / tot.units) * 100) + "% of units" : ""} · Shopify not tracked${partial(salesReady.length, salesKeys.length)}`} trend={allSales ? g(tot.returns, tot.returnsPrev) : undefined} inverseTrend accent="orange" />
        <KPICard title="Cancelled Orders" value={num(tot.cancelled)} subtitle={`Last period ${num(tot.cancelledPrev)}${partial(salesReady.length, salesKeys.length)}`} trend={allSales ? g(tot.cancelled, tot.cancelledPrev) : undefined} inverseTrend accent="purple" />
        <KPICard title="Total Ad Spend" value={cur(tot.spend)} subtitle={`incl. 18% GST · all 5 ad platforms${partial(spendReady.length, spendKeys.length)}`} trend={allSpend ? g(tot.spend, tot.spendPrev) : undefined} inverseTrend accent="pink" />
        <KPICard title="TACOS" value={tacos === null ? "…" : `${one(tacos)}%`} subtitle={`Ad spend incl. GST ÷ sales${tacosKeys.length < salesKeys.length ? ` · without ${salesKeys.filter((k) => !tacosKeys.includes(k)).map((k) => PLATFORMS.find((p) => p.key === k)!.label).join(", ")} (loading)` : ""}`} accent="orange" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {PLATFORMS.map((p) => (
          <div key={p.key} className="flex flex-col">
            <PlatformCard
              p={p}
              snap={snaps[p.key]}
              loading={loading[p.key]}
              insights={insights[p.key]}
              summary={p.key in sales ? sales[p.key] : undefined}
              note={p.key === "google" ? coverageNote(google) : p.key === "meta" ? coverageNote(meta) : p.key in salesErr && salesErr[p.key] ? "Sales couldn't load — reload the page to retry." : undefined}
            />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="glass rounded-2xl border border-emerald-500/25 p-5 shadow-sm space-y-2">
          <h3 className="text-xs font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-300 flex items-center gap-1.5"><ThumbsUp className="w-3.5 h-3.5" /> Doing well</h3>
          {best && allSales && tot.sales > 0 && (
            <p className="text-xs">• <b>{PLATFORMS.find((p) => p.key === best)!.label}</b> is the biggest at {cur(snaps[best].sales ?? 0)} — {Math.round(((snaps[best].sales ?? 0) / tot.sales) * 100)}% of all sales.</p>
          )}
          {good.map((i) => <p key={i.platform + i.text} className="text-xs">• <b>{i.platform}:</b> {i.text}</p>)}
          {good.length === 0 && <p className="text-xs text-muted-foreground">Nothing stands out yet{allSales && allSpend ? "" : " — still loading some platforms"}.</p>}
        </div>
        <div className="glass rounded-2xl border border-amber-500/25 p-5 shadow-sm space-y-2">
          <h3 className="text-xs font-black uppercase tracking-widest text-amber-700 dark:text-amber-300 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> Needs attention</h3>
          {watch.map((i) => <p key={i.platform + i.text} className="text-xs">• <b>{i.platform}:</b> {i.text}</p>)}
          {watch.length === 0 && <p className="text-xs text-muted-foreground">Nothing to act on{allSales && allSpend ? "" : " yet — still loading some platforms"}.</p>}
        </div>
      </div>

      <CampaignsSection stats={campaignStats} loading={campaignLoading} />
    </div>
  );
}
