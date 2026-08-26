// Condition-driven alerts that fire when something changes, rather than on a fixed report
// schedule. Four detectors, all over the live SellerMate API:
//
//   spendSpike       — a campaign's spend jumped against its own trailing baseline
//   stockoutForecast — days of cover left at current velocity, before the shelf actually empties
//   buyBoxLoss       — buy box share collapsed on a product that was selling
//   conversionDrop   — traffic held but units fell, i.e. the listing stopped converting
//
// A NOTE ON "SUDDEN": get_hourly_performance lags roughly two days on this account (today returns
// no rows, yesterday returns a partial handful of hours), so intra-day detection is not possible
// from this source — spendSpike compares whole days and is therefore a next-morning signal, not a
// within-the-hour one. Daily aggregates for yesterday ARE current, which is what every detector
// here uses.
//
// Detectors throw on upstream failure rather than returning []. The endpoint runs them with
// allSettled, so one dead detector still can't suppress the other three — but the failure is
// reported instead of silently reading as "nothing wrong", which is the same thing on the wire
// and very much not the same thing in fact.

import { fetchAsinSkuMap } from "@/lib/adAlerts";
import { resolveProductName } from "@/lib/categoryMap";

const SELLERMATE_BASE_URL = "https://api.sellermate.ai/public/v1/tools";

export type AlertType = "spendSpike" | "stockoutForecast" | "buyBoxLoss" | "conversionDrop";

export interface LiveAlert {
  type: AlertType;
  entityId: string; // campaign name or ASIN — the dedupe key
  title: string;
  detail: string;
  action: string;
  /** Rupees at stake, used to rank the email. */
  impact: number;
  /** 1–3. A worsening bucket re-fires the alert before its cooldown expires. */
  severity: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callTool(tool: string, args: Record<string, any>, apiKey: string) {
  const r = await fetch(`${SELLERMATE_BASE_URL}/${tool}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`${tool}: ${await r.text()}`);
  return r.json();
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number, from: Date) => {
  const d = new Date(from);
  d.setDate(d.getDate() - n);
  return d;
};
const money = (v: number) => "₹" + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(v || 0));
const pct = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v * 100)}%`;

interface Ctx {
  apiKey: string;
  amazon_account_id: string;
  workspace_id: string;
  now: Date;
}

// Amazon listing titles run to 200 characters of keyword stuffing, which is unreadable in an
// email subject line or card heading. The seller's own short name is used wherever the SKU is
// known (same mapping the reports use); otherwise the raw title is clipped.
const asinSkuCache = new Map<string, Promise<Map<string, string[]>>>();
function asinSkuMap(ctx: Ctx) {
  const key = `${ctx.amazon_account_id}|${ctx.workspace_id}`;
  let p = asinSkuCache.get(key);
  if (!p) {
    p = fetchAsinSkuMap({ apiKey: ctx.apiKey, amazon_account_id: ctx.amazon_account_id, workspace_id: ctx.workspace_id })
      .catch(() => new Map<string, string[]>());
    asinSkuCache.set(key, p);
  }
  return p;
}
const clip = (s: string, len = 60) => ((s || "").length > len ? (s || "").slice(0, len).trimEnd() + "…" : s || "");
function displayName(raw: string | undefined, sku: string | undefined, fallback: string) {
  const resolved = resolveProductName(raw || "", sku || "");
  return clip(resolved || raw || fallback);
}

// ── 1. Spend spike ─────────────────────────────────────────────────────────
// Yesterday's spend per campaign against the mean of the 7 days before it. Requires a real
// baseline (a campaign that only started yesterday has nothing to be a spike against) and a
// meaningful absolute jump, so a ₹40 → ₹120 campaign doesn't page anyone at 200%.
export async function findSpendSpikes(
  ctx: Ctx,
  opts: { ratio?: number; minJump?: number } = {}
): Promise<LiveAlert[]> {
  const ratio = opts.ratio ?? 1.5;
  const minJump = opts.minJump ?? 1000;
  const day = iso(daysAgo(1, ctx.now));
  const baseStart = iso(daysAgo(8, ctx.now));
  const baseEnd = iso(daysAgo(2, ctx.now));

  const base = { amazon_account_id: ctx.amazon_account_id, workspace_id: ctx.workspace_id, page_size: 500 };
  const [today, baseline] = await Promise.all([
    callTool("get_campaign_performance", { ...base, start_date: day, end_date: day }, ctx.apiKey),
    callTool("get_campaign_performance", { ...base, start_date: baseStart, end_date: baseEnd }, ctx.apiKey),
  ]);

  const baseByName = new Map<string, { spend: number; sales: number }>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (baseline.data || []).forEach((c: any) => {
    baseByName.set(c.campaignName, { spend: (c.spend || 0) / 7, sales: (c.sales || 0) / 7 });
  });

  const out: LiveAlert[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (today.data || []).forEach((c: any) => {
    const spend = c.spend || 0;
    const prior = baseByName.get(c.campaignName);
    if (!prior || prior.spend <= 0) return;
    const jump = spend - prior.spend;
    if (spend < prior.spend * ratio || jump < minJump) return;

    const times = spend / prior.spend;
    const salesMoved = prior.sales > 0 ? (c.sales || 0) / prior.sales - 1 : null;
    // Spending more is only a problem if sales didn't follow. Say which it is rather than
    // treating every increase as waste — a scaling campaign is doing its job.
    const followed = salesMoved !== null && salesMoved >= times - 1 - 0.2;
    out.push({
      type: "spendSpike",
      entityId: c.campaignName,
      title: `Ad spend spike — ${c.campaignName}`,
      detail:
        `Spend ${money(prior.spend)}/day → ${money(spend)} (${times.toFixed(1)}×)` +
        (salesMoved === null ? ", no prior sales to compare" : `, sales ${pct(salesMoved)}`) +
        `. ACOS ${c.acos == null ? "n/a" : Math.round(c.acos) + "%"}, ${c.orders || 0} orders.`,
      action: followed
        ? `Sales scaled with the spend — confirm the higher budget on ${c.campaignName} is intended.`
        : `Spend rose without matching sales on ${c.campaignName} — check bids and budget.`,
      impact: followed ? jump * 0.25 : jump,
      severity: followed ? 1 : times >= 3 ? 3 : 2,
    });
  });
  return out.sort((a, b) => b.impact - a.impact);
}

// ── 2. Stockout forecast ───────────────────────────────────────────────────
// Days of cover = units on hand ÷ recent daily velocity. Catches a product on its way to zero,
// which the existing stockout alert cannot — that one only fires once the shelf is already empty
// and the ad budget has been wasted.
export async function findStockoutForecasts(
  ctx: Ctx,
  opts: { warnDays?: number; lookbackDays?: number } = {}
): Promise<LiveAlert[]> {
  const warnDays = opts.warnDays ?? 10;
  const lookbackDays = opts.lookbackDays ?? 14;
  const start = iso(daysAgo(lookbackDays, ctx.now));
  const end = iso(daysAgo(1, ctx.now));

  // Paginate the way src/lib/stockout.ts does: advance by what the page actually returned and
  // stop against `total`. Assigning rather than accumulating matters — get_inventory can repeat
  // an ASIN across pages, and summing those repeats inflated stock on hand, which pushed days of
  // cover up and made the alert count wander between runs (9, then 6, then 8 on identical input).
  const invByAsin = new Map<string, { name: string; sku: string; units: number }>();
  let offset = 0;
  for (let i = 0; i < 10; i++) {
    const inv = await callTool(
      "get_inventory",
      { amazon_account_id: ctx.amazon_account_id, workspace_id: ctx.workspace_id, limit: 200, offset },
      ctx.apiKey
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items: any[] = inv.items || [];
    for (const it of items) {
      if (!it.asin) continue;
      const units = (it.fbm?.quantity || 0) + (it.fba?.endingWarehouseBalance || 0);
      invByAsin.set(it.asin, { name: it.itemName || it.asin, sku: it.sku || "", units });
    }
    if (items.length === 0 || offset + items.length >= (inv.total || 0)) break;
    offset += items.length;
  }

  const perf = await callTool(
    "get_retail_product_performance",
    { amazon_account_id: ctx.amazon_account_id, workspace_id: ctx.workspace_id, start_date: start, end_date: end, page_size: 500 },
    ctx.apiKey
  );

  const out: LiveAlert[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (perf.data || []).forEach((r: any) => {
    const inv = invByAsin.get(r.asin);
    if (!inv) return; // no stock signal for this ASIN — say nothing rather than guess
    const velocity = (r.unitsOrdered || 0) / lookbackDays;
    if (velocity <= 0) return; // not selling; a low count here isn't a stockout risk
    if (inv.units <= 0) return; // already out — the existing stockout alert owns this case
    const cover = inv.units / velocity;
    if (cover > warnDays) return;

    const dailyRevenue = (r.totalSales || 0) / lookbackDays;
    const label = displayName(inv.name, inv.sku, r.asin);
    out.push({
      type: "stockoutForecast",
      entityId: r.asin,
      title: `Running out in ${cover < 1 ? "under a day" : `${Math.floor(cover)} day${Math.floor(cover) === 1 ? "" : "s"}`} — ${label}`,
      detail:
        `${inv.units} units left, selling ${velocity.toFixed(1)}/day over the last ${lookbackDays} days` +
        `${inv.sku ? ` · SKU ${inv.sku}` : ""}${r.adSpend > 0 ? ` · still advertising (${money(r.adSpend)} in the window)` : ""}.`,
      action: `Replenish ${label} — about ${money(dailyRevenue)}/day of sales stops when it runs out.`,
      // What the stockout costs is roughly the revenue lost per day it sits empty.
      impact: dailyRevenue * Math.max(1, warnDays - cover),
      severity: cover <= 3 ? 3 : cover <= 6 ? 2 : 1,
    });
  });
  return out.sort((a, b) => b.impact - a.impact);
}

// ── 3. Buy Box loss ────────────────────────────────────────────────────────
// Buy box share is the single fastest way to lose revenue without anything else changing —
// the listing is live, the stock is there, the ads still spend, and the orders simply stop.
export async function findBuyBoxLosses(
  ctx: Ctx,
  opts: { windowDays?: number; dropPoints?: number; floor?: number; minSales?: number } = {}
): Promise<LiveAlert[]> {
  const windowDays = opts.windowDays ?? 7;
  const dropPoints = opts.dropPoints ?? 20;
  const floor = opts.floor ?? 80;
  const minSales = opts.minSales ?? 2000;

  const recentStart = iso(daysAgo(windowDays, ctx.now));
  const recentEnd = iso(daysAgo(1, ctx.now));
  const priorStart = iso(daysAgo(windowDays * 2, ctx.now));
  const priorEnd = iso(daysAgo(windowDays + 1, ctx.now));

  const base = { amazon_account_id: ctx.amazon_account_id, workspace_id: ctx.workspace_id, page_size: 500 };
  const [recent, prior, skuByAsin] = await Promise.all([
    callTool("get_retail_product_performance", { ...base, start_date: recentStart, end_date: recentEnd }, ctx.apiKey),
    callTool("get_retail_product_performance", { ...base, start_date: priorStart, end_date: priorEnd }, ctx.apiKey),
    asinSkuMap(ctx),
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const priorByAsin = new Map<string, any>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prior.data || []).forEach((r: any) => priorByAsin.set(r.asin, r));

  const out: LiveAlert[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (recent.data || []).forEach((r: any) => {
    const p = priorByAsin.get(r.asin);
    if (!p) return;
    const now = r.buyBoxPercentage;
    const was = p.buyBoxPercentage;
    if (now == null || was == null) return;
    // Only meaningful on a product that was actually winning the box and actually sells.
    if (was < floor || now >= floor) return;
    if (was - now < dropPoints) return;
    if ((p.totalSales || 0) < minSales) return;

    const lost = Math.max(0, (p.totalSales || 0) - (r.totalSales || 0));
    // A dropped buy-box percentage that hasn't actually cost any revenue yet (demand held or grew
    // despite losing the box — another seller may be matching price, or this ASIN just isn't
    // price-sensitive) isn't something to act on today. Without this, roughly half of a typical
    // day's buyBoxLoss alerts were "impact ₹0" noise sitting between the genuinely urgent ones,
    // burying the products where the lost box actually cost real sales.
    if (lost <= 0) return;
    const label = displayName(r.productName, (skuByAsin.get(r.asin) || [])[0], r.asin);
    out.push({
      type: "buyBoxLoss",
      entityId: r.asin,
      title: `Buy Box down to ${Math.round(now)}% — ${label}`,
      detail:
        `Buy box ${Math.round(was)}% → ${Math.round(now)}% over the last ${windowDays} days. ` +
        `Sales ${money(p.totalSales || 0)} → ${money(r.totalSales || 0)}` +
        `${r.adSpend > 0 ? `, still spending ${money(r.adSpend)} on ads` : ""}.`,
      action: `Check pricing and other sellers on ${label} — ads keep paying while the box is lost.`,
      impact: lost,
      severity: now < 40 ? 3 : now < 60 ? 2 : 1,
    });
  });
  return out.sort((a, b) => b.impact - a.impact);
}

// ── 4. Conversion collapse ─────────────────────────────────────────────────
// Traffic arriving but not buying separates a demand problem from a listing problem: if sessions
// held and units fell, the shopper reached the page and chose not to buy.
export async function findConversionDrops(
  ctx: Ctx,
  opts: { windowDays?: number; minSessions?: number; cvrDrop?: number } = {}
): Promise<LiveAlert[]> {
  const windowDays = opts.windowDays ?? 7;
  const minSessions = opts.minSessions ?? 100;
  const cvrDrop = opts.cvrDrop ?? 0.4;

  const recentStart = iso(daysAgo(windowDays, ctx.now));
  const recentEnd = iso(daysAgo(1, ctx.now));
  const priorStart = iso(daysAgo(windowDays * 2, ctx.now));
  const priorEnd = iso(daysAgo(windowDays + 1, ctx.now));

  const base = { amazon_account_id: ctx.amazon_account_id, workspace_id: ctx.workspace_id, page_size: 500 };
  const [recent, prior, skuByAsin] = await Promise.all([
    callTool("get_retail_product_performance", { ...base, start_date: recentStart, end_date: recentEnd }, ctx.apiKey),
    callTool("get_retail_product_performance", { ...base, start_date: priorStart, end_date: priorEnd }, ctx.apiKey),
    asinSkuMap(ctx),
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const priorByAsin = new Map<string, any>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prior.data || []).forEach((r: any) => priorByAsin.set(r.asin, r));

  const out: LiveAlert[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (recent.data || []).forEach((r: any) => {
    const p = priorByAsin.get(r.asin);
    if (!p) return;
    const nowSessions = r.sessions || 0;
    const wasSessions = p.sessions || 0;
    if (wasSessions < minSessions || nowSessions < minSessions * 0.5) return;
    // Traffic must have held — if sessions collapsed too, this is a traffic problem and the
    // conversion framing would point at the wrong fix.
    if (nowSessions < wasSessions * 0.8) return;

    const wasCvr = wasSessions > 0 ? (p.unitsOrdered || 0) / wasSessions : 0;
    const nowCvr = nowSessions > 0 ? (r.unitsOrdered || 0) / nowSessions : 0;
    if (wasCvr <= 0) return;
    const fall = 1 - nowCvr / wasCvr;
    if (fall < cvrDrop) return;

    const lost = Math.max(0, (p.totalSales || 0) - (r.totalSales || 0));
    const label = displayName(r.productName, (skuByAsin.get(r.asin) || [])[0], r.asin);
    out.push({
      type: "conversionDrop",
      entityId: r.asin,
      title: `Traffic held, sales fell — ${label}`,
      detail:
        `Sessions ${wasSessions} → ${nowSessions} (held), but conversion ${(wasCvr * 100).toFixed(1)}% → ` +
        `${(nowCvr * 100).toFixed(1)}% (${pct(-fall)}). Units ${p.unitsOrdered || 0} → ${r.unitsOrdered || 0}` +
        `${r.buyBoxPercentage != null ? `, buy box ${Math.round(r.buyBoxPercentage)}%` : ""}.`,
      action: `Shoppers are reaching ${label} and not buying — check price, images, reviews and stock status.`,
      impact: lost,
      severity: fall >= 0.7 ? 3 : fall >= 0.55 ? 2 : 1,
    });
  });
  return out.sort((a, b) => b.impact - a.impact);
}
