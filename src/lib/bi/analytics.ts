// Executive dashboard analysis: KPIs, comparisons, rankings, advertising, health score and insights.
// Pure functions over a BiDataset — no I/O. Every figure says which days it covers; a channel or day
// without data is reported as missing and left out, never counted as zero.

import { addDaysIso, forecastSeries, type Forecast } from "./forecast.ts";
import type { BiDataset, BiChannel, BiProduct, SalesChannelId, Series } from "./types.ts";

// ── Windows ─────────────────────────────────────────────────────────────────────────────────

export interface Window { start: string; end: string; days: number }

export function windowEnding(end: string, days: number): Window {
  return { start: addDaysIso(end, -(days - 1)), end, days };
}
export function previousWindow(w: Window): Window {
  return windowEnding(addDaysIso(w.start, -1), w.days);
}
/** Month-to-date ending `asOf`, and the same number of days at the start of the previous month. */
export function monthToDate(asOf: string): { current: Window; previous: Window } {
  const day = Number(asOf.slice(8, 10));
  const current = { start: `${asOf.slice(0, 8)}01`, end: asOf, days: day };
  const prevMonthStart = addDaysIso(`${asOf.slice(0, 8)}01`, -1).slice(0, 8) + "01";
  const prevMonthLen = Number(addDaysIso(`${asOf.slice(0, 8)}01`, -1).slice(8, 10));
  const prevEnd = addDaysIso(prevMonthStart, Math.min(day, prevMonthLen) - 1);
  return { current, previous: { start: prevMonthStart, end: prevEnd, days: Math.min(day, prevMonthLen) } };
}
export function daysInMonth(iso: string): number {
  const next = addDaysIso(`${iso.slice(0, 8)}28`, 4).slice(0, 8) + "01";
  return Number(addDaysIso(next, -1).slice(8, 10));
}

/** Sum of a series over a window, with how many of its days actually have data. */
export function sumWindow(series: Series, dates: string[], w: Window): { value: number | null; covered: number } {
  let value = 0, covered = 0;
  dates.forEach((d, i) => {
    if (d < w.start || d > w.end) return;
    const v = series[i];
    if (v === null || !Number.isFinite(v)) return;
    value += v; covered++;
  });
  return { value: covered ? value : null, covered };
}

export const pctChange = (now: number | null, before: number | null): number | null =>
  now === null || before === null || before <= 0 ? null : ((now - before) / before) * 100;

// ── Channel figures ───────────────────────────────────────────────────────────────────────────

export interface ChannelPeriod {
  id: SalesChannelId;
  label: string;
  revenue: number | null;
  units: number | null;
  returns: number | null;
  covered: number;
  /** True when every day of the window has data for this channel. */
  complete: boolean;
}

export function channelPeriod(ds: BiDataset, ch: BiChannel, w: Window): ChannelPeriod {
  const r = sumWindow(ch.revenue, ds.dates, w);
  return {
    id: ch.id, label: ch.label,
    revenue: r.value,
    units: sumWindow(ch.units, ds.dates, w).value,
    returns: ch.returnsTracked ? sumWindow(ch.returns, ds.dates, w).value : null,
    covered: r.covered,
    complete: r.covered === w.days,
  };
}

export interface Totals {
  revenue: number;
  units: number;
  returns: number;
  /** Channels that have data for every day of the window — the only ones added into the totals. */
  included: SalesChannelId[];
  /** Channels left out because some days of the window have no data. */
  partial: { id: SalesChannelId; label: string; covered: number }[];
}

/** Totals over channels with complete data for the window (optionally only `only`). */
export function totals(ds: BiDataset, w: Window, only?: SalesChannelId[]): Totals {
  const t: Totals = { revenue: 0, units: 0, returns: 0, included: [], partial: [] };
  for (const ch of ds.channels) {
    if (only && !only.includes(ch.id)) continue;
    const p = channelPeriod(ds, ch, w);
    if (!p.complete) { if (p.covered > 0) t.partial.push({ id: ch.id, label: ch.label, covered: p.covered }); continue; }
    t.revenue += p.revenue ?? 0; t.units += p.units ?? 0; t.returns += p.returns ?? 0;
    t.included.push(ch.id);
  }
  return t;
}

/** Growth on a like-for-like basis: only channels complete in BOTH windows. */
export function likeForLike(ds: BiDataset, cur: Window, prev: Window, only?: SalesChannelId[]) {
  const a = totals(ds, cur, only), b = totals(ds, prev, only);
  const both = a.included.filter((id) => b.included.includes(id));
  const ca = totals(ds, cur, both), cb = totals(ds, prev, both);
  return { current: ca, previous: cb, channels: both, revenuePct: pctChange(ca.revenue, cb.revenue), unitsPct: pctChange(ca.units, cb.units) };
}

// ── Forecasts ─────────────────────────────────────────────────────────────────────────────────

export interface ChannelForecast { id: SalesChannelId; label: string; revenue: Forecast; units: Forecast; lastActual: string | null }

/** Each channel forecast from its own last day with data (channels are uploaded on different days). */
export function channelForecasts(ds: BiDataset, only?: SalesChannelId[]): ChannelForecast[] {
  return ds.channels.filter((c) => !only || only.includes(c.id)).map((c) => {
    const last = c.dataThrough ? ds.dates.indexOf(c.dataThrough) : -1;
    const dates = last >= 0 ? ds.dates.slice(0, last + 1) : [];
    return {
      id: c.id, label: c.label, lastActual: c.dataThrough,
      revenue: dates.length ? forecastSeries(c.revenue.slice(0, last + 1), dates) : { ok: false, reason: "no data" },
      units: dates.length ? forecastSeries(c.units.slice(0, last + 1), dates) : { ok: false, reason: "no data" },
    };
  });
}

export interface CombinedForecast {
  horizon: number;
  revenue: { total: number; low: number; high: number } | null;
  units: { total: number; low: number; high: number } | null;
  channels: SalesChannelId[];
  skipped: { id: SalesChannelId; reason: string }[];
}

/** Sum of the channel forecasts for a horizon. Ranges are combined assuming channels vary independently. */
export function combineForecasts(fs: ChannelForecast[], horizon: number): CombinedForecast {
  const out: CombinedForecast = { horizon, revenue: null, units: null, channels: [], skipped: [] };
  let rt = 0, rv = 0, ut = 0, uv = 0;
  for (const f of fs) {
    if (!f.revenue.ok || !f.units.ok) { out.skipped.push({ id: f.id, reason: !f.revenue.ok ? f.revenue.reason : (f.units as { reason: string }).reason }); continue; }
    const r = f.revenue.horizons[horizon], u = f.units.horizons[horizon];
    rt += r.total; rv += ((r.high - r.total) / 1.2816) ** 2;
    ut += u.total; uv += ((u.high - u.total) / 1.2816) ** 2;
    out.channels.push(f.id);
  }
  if (out.channels.length) {
    const rs = 1.2816 * Math.sqrt(rv), us = 1.2816 * Math.sqrt(uv);
    out.revenue = { total: rt, low: Math.max(0, rt - rs), high: rt + rs };
    out.units = { total: ut, low: Math.max(0, ut - us), high: ut + us };
  }
  return out;
}

/** Month-end estimate: actual month-to-date (complete channels) + forecast for the remaining days. */
export function monthEndEstimate(ds: BiDataset, fs: ChannelForecast[]) {
  const asOf = ds.asOf;
  const mtd = monthToDate(asOf).current;
  const remaining = daysInMonth(asOf) - mtd.days;
  let actual = 0, total = 0, variance = 0;
  const channels: SalesChannelId[] = [];
  for (const f of fs) {
    const ch = ds.channels.find((c) => c.id === f.id)!;
    if (!f.revenue.ok || !ch.dataThrough) continue;
    const covered = sumWindow(ch.revenue, ds.dates, { ...mtd, end: ch.dataThrough < asOf ? ch.dataThrough : asOf });
    // days from the channel's last actual to month end are forecast
    const gap = Math.max(0, Number(asOf.slice(8, 10)) - Number((ch.dataThrough < mtd.start ? mtd.start : ch.dataThrough).slice(8, 10)));
    const n = Math.min(f.revenue.daily.length, remaining + gap);
    const fc = f.revenue.daily.slice(0, n).reduce((s, v) => s + v, 0);
    const spread = n > 0 ? (f.revenue.horizons[30].high - f.revenue.horizons[30].total) * Math.sqrt(n / 30) : 0;
    actual += covered.value ?? 0; total += (covered.value ?? 0) + fc; variance += (spread / 1.2816) ** 2;
    channels.push(f.id);
  }
  const s = 1.2816 * Math.sqrt(variance);
  return { month: asOf.slice(0, 7), actualSoFar: actual, estimate: total, low: Math.max(actual, total - s), high: total + s, remainingDays: remaining, channels };
}

// ── Products ──────────────────────────────────────────────────────────────────────────────────

export interface ProductRow {
  key: string;
  channel: SalesChannelId;
  sku: string;
  name: string;
  units: number;
  revenue: number;
  prevUnits: number;
  prevRevenue: number;
  growthPct: number | null;
  returns: number;
  returnRatePct: number | null;
  /** Units per week for the last 4 complete weeks, oldest first. */
  weekly: number[];
  avgDailyUnits: number;
  stock: number | null;
  /** Date of the stock file the figure comes from. */
  stockAsOf: string | null;
  daysOfCover: number | null;
  reason: string;
}

function lastIndexOnOrBefore(dates: string[], d: string) {
  let idx = -1;
  dates.forEach((x, i) => { if (x <= d) idx = i; });
  return idx;
}

export function productRows(ds: BiDataset, days = 30, only?: SalesChannelId[]): ProductRow[] {
  const pd = ds.productDates;
  const stockBySku = new Map(ds.stock.map((s) => [s.sku.trim().toUpperCase(), s.available]));
  const stockAsOf = ds.stock.map((s) => s.asOf).filter((d): d is string => !!d).sort().pop() ?? null;
  const rows: ProductRow[] = [];
  for (const p of ds.products) {
    if (only && !only.includes(p.channel)) continue;
    const ch = ds.channels.find((c) => c.id === p.channel);
    if (!ch?.dataThrough) continue;
    const end = lastIndexOnOrBefore(pd, ch.dataThrough);
    if (end < days * 2 - 1) continue;
    const sum = (xs: number[], from: number, to: number) => xs.slice(from, to + 1).reduce((s, v) => s + v, 0);
    const units = sum(p.units, end - days + 1, end), prevUnits = sum(p.units, end - 2 * days + 1, end - days);
    const revenue = sum(p.revenue, end - days + 1, end), prevRevenue = sum(p.revenue, end - 2 * days + 1, end - days);
    const returns = sum(p.returns, end - days + 1, end);
    const weekly = [3, 2, 1, 0].map((k) => sum(p.units, end - 7 * (k + 1) + 1, end - 7 * k));
    const avgDailyUnits = units / days;
    const stock = p.channel === "amazon" ? stockBySku.get(p.sku.trim().toUpperCase()) ?? null : null;
    rows.push({
      key: `${p.channel}|${p.sku}`, channel: p.channel, sku: p.sku, name: p.name,
      units, revenue, prevUnits, prevRevenue, growthPct: pctChange(revenue, prevRevenue),
      returns, returnRatePct: ch.returnsTracked && units > 0 ? (returns / units) * 100 : null,
      weekly, avgDailyUnits, stock, stockAsOf: stock === null ? null : stockAsOf,
      daysOfCover: stock !== null && avgDailyUnits > 0 ? stock / avgDailyUnits : null,
      reason: "",
    });
  }
  return rows;
}

const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(0)}%`;

export interface Rankings {
  bestSellers: ProductRow[];
  topRevenue: ProductRow[];
  fastestGrowing: ProductRow[];
  gainingMomentum: ProductRow[];
  declining: ProductRow[];
  highReturns: ProductRow[];
  stockRisk: ProductRow[];
}

/** Rankings with the rule that put each product there written into `reason`. */
export function rankProducts(rows: ProductRow[], limit = 10): Rankings {
  const top = (xs: ProductRow[], key: (r: ProductRow) => number, why: (r: ProductRow) => string) =>
    [...xs].sort((a, b) => key(b) - key(a)).slice(0, limit).map((r) => ({ ...r, reason: why(r) }));
  const rising = (w: number[]) => w[1] > w[0] && w[2] > w[1] && w[3] > w[2];
  const falling = (w: number[]) => w[1] < w[0] && w[2] < w[1] && w[3] < w[2];
  return {
    bestSellers: top(rows.filter((r) => r.units > 0), (r) => r.units, (r) => `${r.units} units in 30 days`),
    topRevenue: top(rows.filter((r) => r.revenue > 0), (r) => r.revenue, (r) => `₹${Math.round(r.revenue).toLocaleString("en-IN")} in 30 days`),
    // a real base: at least 10 units before, and at least 10 more units now, so a 1 → 3 jump never tops the list
    fastestGrowing: top(rows.filter((r) => r.prevUnits >= 10 && r.units - r.prevUnits >= 10 && r.growthPct !== null), (r) => r.growthPct!,
      (r) => `Revenue ${fmtPct(r.growthPct!)} vs the previous 30 days (${r.prevUnits} → ${r.units} units)`),
    gainingMomentum: top(rows.filter((r) => rising(r.weekly) && r.weekly[3] >= 5), (r) => r.weekly[3] - r.weekly[0],
      (r) => `Weekly units rose three weeks running: ${r.weekly.join(" → ")}`),
    declining: top(rows.filter((r) => falling(r.weekly) && r.weekly[0] >= 5), (r) => r.weekly[0] - r.weekly[3],
      (r) => `Weekly units fell three weeks running: ${r.weekly.join(" → ")}`),
    highReturns: top(rows.filter((r) => r.returnRatePct !== null && r.units >= 10 && r.returnRatePct >= 10), (r) => r.returnRatePct!,
      (r) => `${r.returns} returns on ${r.units} units (${r.returnRatePct!.toFixed(0)}%)`),
    stockRisk: [...rows.filter((r) => r.daysOfCover !== null && r.avgDailyUnits >= 1 && r.daysOfCover < 14)]
      .sort((a, b) => a.daysOfCover! - b.daysOfCover!).slice(0, limit)
      .map((r) => ({ ...r, reason: `${r.stock} units available in FBA${r.stockAsOf ? ` on ${r.stockAsOf.split("-").reverse().join(".")}` : ""}, selling ${r.avgDailyUnits.toFixed(1)}/day → about ${Math.floor(r.daysOfCover!)} days of cover at that date${r.stock === 0 ? " (sales may be shipped by the seller instead — check before restocking)" : ""}` })),
  };
}

// ── Advertising ───────────────────────────────────────────────────────────────────────────────

export interface AdChannelRow {
  id: string; label: string; salesBasis: string;
  spend: number | null; sales: number | null; prevSpend: number | null; prevSales: number | null;
  /** Spend including GST (what the business pays). */
  spendGst: number | null;
  roas: number | null; acos: number | null; spendPct: number | null; roasPrev: number | null;
  covered: number; complete: boolean;
}

export function adChannels(ds: BiDataset, w: Window): AdChannelRow[] {
  const prev = previousWindow(w);
  return ds.ads.map((a) => {
    const s = sumWindow(a.spend, ds.dates, w), sa = sumWindow(a.sales, ds.dates, w);
    const ps = sumWindow(a.spend, ds.dates, prev), psa = sumWindow(a.sales, ds.dates, prev);
    const complete = s.covered === w.days, prevComplete = ps.covered === prev.days;
    return {
      id: a.id, label: a.label, salesBasis: a.salesBasis,
      spend: s.value, sales: sa.value, prevSpend: ps.value, prevSales: psa.value,
      spendGst: s.value === null ? null : s.value * ds.gstMultiplier,
      roas: s.value && sa.value !== null ? sa.value / s.value : null,
      acos: sa.value && s.value !== null ? (s.value / sa.value) * 100 : null,
      spendPct: complete && prevComplete ? pctChange(s.value, ps.value) : null,
      roasPrev: ps.value && psa.value !== null && prevComplete ? psa.value / ps.value : null,
      covered: s.covered, complete,
    };
  });
}

export function campaignFindings(ds: BiDataset) {
  const withRatios = ds.campaigns.map((c) => ({ ...c, roas: c.spend > 0 ? c.sales / c.spend : null, acos: c.sales > 0 ? (c.spend / c.sales) * 100 : null }));
  const wasted = withRatios.filter((c) => c.spend >= 1000 && c.sales === 0).sort((a, b) => b.spend - a.spend);
  const poor = withRatios.filter((c) => c.spend >= 2000 && c.sales > 0 && (c.acos ?? 0) > 50).sort((a, b) => b.spend - a.spend);
  const strong = withRatios.filter((c) => c.spend >= 1000 && (c.roas ?? 0) >= 5).sort((a, b) => b.sales - a.sales);
  const rising = withRatios.filter((c) => c.prevSpend >= 1000 && c.spend >= c.prevSpend * 1.5 && c.sales <= c.prevSales).sort((a, b) => (b.spend - b.prevSpend) - (a.spend - a.prevSpend));
  return { wasted, poor, strong, rising };
}

// ── Health score ──────────────────────────────────────────────────────────────────────────────

export interface HealthPart { name: string; weight: number; score: number | null; detail: string; rule: string }

const clamp = (v: number) => Math.max(0, Math.min(100, v));
const lerp = (v: number, zeroAt: number, hundredAt: number) => clamp(((v - zeroAt) / (hundredAt - zeroAt)) * 100);

export function healthScore(ds: BiDataset, w: Window): { score: number | null; parts: HealthPart[] } {
  const lfl = likeForLike(ds, w, previousWindow(w));
  const t = totals(ds, w);
  // TACOS compares a channel's ad spend with the same channel's sales, so a channel counts only when
  // both its ads and its sales are complete for the window (Shopify's ads = Google + Meta).
  const adRows = adChannels(ds, w);
  const adsFor: Record<string, string[]> = { amazon: ["amazon"], flipkart: ["flipkart"], meesho: ["meesho"], shopify: ["google", "meta"] };
  let adGst = 0, adRevenue = 0;
  const tacosChannels: string[] = [];
  for (const id of t.included) {
    const src = adRows.filter((a) => adsFor[id]?.includes(a.id));
    if (!src.length || src.some((a) => !a.complete || a.spendGst === null)) continue;
    adGst += src.reduce((s, a) => s + (a.spendGst ?? 0), 0);
    adRevenue += channelPeriod(ds, ds.channels.find((c) => c.id === id)!, w).revenue ?? 0;
    tacosChannels.push(ds.channels.find((c) => c.id === id)!.label);
  }
  const rows = productRows(ds, 30);
  const topAmazon = rows.filter((r) => r.channel === "amazon" && r.stock !== null).sort((a, b) => b.units - a.units).slice(0, 30);
  const covered = topAmazon.filter((r) => (r.daysOfCover ?? Infinity) >= 14).length;
  const returnsCh = ds.channels.filter((c) => c.returnsTracked && t.included.includes(c.id));
  const rt = totals(ds, w, returnsCh.map((c) => c.id));
  const lags = ds.channels.filter((c) => c.dataThrough).map((c) => Math.round((Date.parse(ds.asOf) - Date.parse(c.dataThrough!)) / 86_400_000));
  const parts: HealthPart[] = [
    { name: "Sales momentum", weight: 30, score: lfl.revenuePct === null ? null : lerp(lfl.revenuePct, -20, 20),
      detail: lfl.revenuePct === null ? "Not enough comparable data" : `Revenue ${fmtPct(lfl.revenuePct)} vs the previous ${w.days} days (${lfl.channels.length} channels)`,
      rule: "−20% or worse = 0, +20% or better = 100" },
    { name: "Ad efficiency (TACOS)", weight: 25, score: adGst > 0 && adRevenue > 0 ? lerp((adGst / adRevenue) * 100, 25, 8) : null,
      detail: adGst > 0 && adRevenue > 0 ? `Ad spend incl. GST is ${((adGst / adRevenue) * 100).toFixed(1)}% of sales (${tacosChannels.join(", ")}; channels with ad days missing are left out)` : "No channel has complete ads and sales data for the period",
      rule: "25% of sales or more = 0, 8% or less = 100" },
    { name: "Returns", weight: 15, score: rt.units > 0 ? lerp((rt.returns / rt.units) * 100, 20, 5) : null,
      detail: rt.units > 0 ? `${((rt.returns / rt.units) * 100).toFixed(1)}% of units returned (${returnsCh.map((c) => c.label).join(", ")})` : "Returns not tracked",
      rule: "20% or more = 0, 5% or less = 100" },
    { name: "Stock cover", weight: 15, score: topAmazon.length ? (covered / topAmazon.length) * 100 : null,
      detail: topAmazon.length ? `${covered} of the top ${topAmazon.length} Amazon products have 14+ days of FBA stock` : "No FBA stock data",
      rule: "Share of the 30 best-selling Amazon products with at least 14 days of stock" },
    { name: "Data freshness", weight: 15, score: lags.length ? lerp(lags.reduce((a, b) => a + b, 0) / lags.length, 10, 2) : null,
      detail: lags.length ? `Channels are on average ${(lags.reduce((a, b) => a + b, 0) / lags.length).toFixed(1)} days behind` : "No data",
      rule: "10+ days behind = 0, 2 days or less = 100" },
  ];
  const scored = parts.filter((p) => p.score !== null);
  const wsum = scored.reduce((s, p) => s + p.weight, 0);
  return { score: wsum ? scored.reduce((s, p) => s + p.score! * p.weight, 0) / wsum : null, parts };
}

// ── Insights ──────────────────────────────────────────────────────────────────────────────────

export type InsightKind = "fact" | "estimate" | "recommendation";
export interface Insight { kind: InsightKind; severity: "good" | "bad" | "neutral"; title: string; detail: string; period: string; action?: string; href?: string }

const inr = (v: number) => `₹${Math.round(v).toLocaleString("en-IN")}`;
const dot = (iso: string) => iso.split("-").reverse().join(".");

export function buildInsights(ds: BiDataset, w: Window): Insight[] {
  const out: Insight[] = [];
  const prev = previousWindow(w);
  const period = `${dot(w.start)} – ${dot(w.end)} vs ${dot(prev.start)} – ${dot(prev.end)}`;

  // channel growth (facts)
  const growth = ds.channels.map((c) => {
    const a = channelPeriod(ds, c, w), b = channelPeriod(ds, c, prev);
    return { c, a, b, pct: a.complete && b.complete ? pctChange(a.revenue, b.revenue) : null };
  }).filter((g) => g.pct !== null);
  for (const g of growth) {
    if (Math.abs(g.pct!) < 10) continue;
    out.push({ kind: "fact", severity: g.pct! > 0 ? "good" : "bad",
      title: `${g.c.label} revenue ${g.pct! > 0 ? "up" : "down"} ${Math.abs(g.pct!).toFixed(0)}%`,
      detail: `${inr(g.a.revenue!)} vs ${inr(g.b.revenue!)} (${g.c.basis})`, period,
      action: g.pct! < 0 ? `Open ${g.c.label} and check which products fell` : undefined,
      href: g.c.id === "amazon" ? "/dashboard" : `/dashboard/${g.c.id}` });
  }
  if (growth.length >= 2) {
    const best = [...growth].sort((a, b) => b.pct! - a.pct!)[0];
    if (best.pct! > 0) out.push({ kind: "fact", severity: "good", title: `${best.c.label} is the fastest-growing channel`, detail: `${fmtPct(best.pct!)} revenue growth, ahead of ${growth.filter((g) => g !== best).map((g) => `${g.c.label} ${fmtPct(g.pct!)}`).join(", ")}`, period });
  }

  // products (facts + recommendations)
  const r = rankProducts(productRows(ds, 30), 3);
  for (const p of r.gainingMomentum.slice(0, 2)) {
    const low = p.daysOfCover !== null && p.daysOfCover < 21;
    out.push({ kind: low ? "recommendation" : "fact", severity: "good", title: `${p.name} is gaining demand`, detail: `${p.reason} (${p.channel})`,
      period: "last 4 weeks", action: low ? `About ${Math.floor(p.daysOfCover!)} days of FBA stock left at the current rate — plan a replenishment` : undefined });
  }
  for (const p of r.declining.slice(0, 2)) out.push({ kind: "fact", severity: "bad", title: `${p.name} sales are declining`, detail: `${p.reason} (${p.channel})`, period: "last 4 weeks", action: "Check price, rating, stock and ads for this product" });
  for (const p of r.stockRisk.slice(0, 2)) out.push({ kind: "recommendation", severity: "bad", title: `${p.name} may run out of stock`, detail: p.reason, period: "stock as of the last FBA upload", action: "Send stock to FBA or reduce ad spend on it until it arrives", href: "/dashboard/inventory" });
  for (const p of r.highReturns.slice(0, 1)) out.push({ kind: "fact", severity: "bad", title: `High returns on ${p.name}`, detail: `${p.reason} (${p.channel})`, period: "last 30 days", action: "Read the return reasons for this product" });

  // advertising
  const f = campaignFindings(ds);
  const cw = ds.campaignWindow;
  const cPeriod = `${dot(cw.start)} – ${dot(cw.end)}`;
  for (const c of f.wasted.slice(0, 2)) out.push({ kind: "recommendation", severity: "bad", title: `Campaign "${c.name}" spent ${inr(c.spend)} with no sales`, detail: `${c.channel}, before GST`, period: cPeriod, action: "Pause it or cut its bids", href: "/dashboard/daily-ad-spend" });
  for (const c of f.poor.slice(0, 2)) out.push({ kind: "recommendation", severity: "bad", title: `Campaign "${c.name}" has high spend but low returns`, detail: `${inr(c.spend)} spend, ${inr(c.sales)} ad sales, ACOS ${c.acos!.toFixed(0)}%`, period: cPeriod, action: "Lower bids on its weakest targets" });
  for (const c of f.strong.slice(0, 1)) out.push({ kind: "recommendation", severity: "good", title: `Campaign "${c.name}" returns ${c.roas!.toFixed(1)}× its spend`, detail: `${inr(c.sales)} ad sales on ${inr(c.spend)} spend`, period: cPeriod, action: "A candidate for more budget if stock allows" });
  const wastedTotal = f.wasted.reduce((s, c) => s + c.spend, 0);
  if (wastedTotal > 0) out.push({ kind: "estimate", severity: "neutral", title: `About ${inr(wastedTotal * ds.gstMultiplier)} a month could be moved to better campaigns`, detail: `${f.wasted.length} campaigns spent with no sales (incl. GST)`, period: cPeriod, action: "Reallocate to campaigns with ROAS of 5× or more" });

  // estimates
  const fc = channelForecasts(ds);
  const me = monthEndEstimate(ds, fc);
  if (me.channels.length) out.push({ kind: "estimate", severity: "neutral", title: `${me.month} revenue may reach about ${inr(me.estimate)}`, detail: `80% range ${inr(me.low)} – ${inr(me.high)}; ${inr(me.actualSoFar)} so far (${me.channels.length} channels)`, period: `forecast for the remaining ${me.remainingDays} days`, action: undefined });

  const order: Record<InsightKind, number> = { recommendation: 0, fact: 1, estimate: 2 };
  return out.sort((a, b) => order[a.kind] - order[b.kind] || (a.severity === "bad" ? -1 : 1) - (b.severity === "bad" ? -1 : 1));
}

// ── Month pattern ─────────────────────────────────────────────────────────────────────────────

/** Revenue per calendar month per channel; months a channel only partly covers are flagged. */
export function monthly(ds: BiDataset) {
  const months = [...new Set(ds.dates.map((d) => d.slice(0, 7)))];
  return months.map((m) => {
    const w: Window = { start: `${m}-01`, end: addDaysIso(`${m}-01`, daysInMonth(`${m}-01`) - 1), days: daysInMonth(`${m}-01`) };
    const row: Record<string, number | string | boolean | null> = { month: m };
    let complete = true;
    for (const c of ds.channels) {
      const p = channelPeriod(ds, c, w);
      row[c.id] = p.revenue;
      if (p.revenue !== null && !p.complete) complete = false;
    }
    row.complete = complete;
    return row;
  });
}

export type { BiProduct };
