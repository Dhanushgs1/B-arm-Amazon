// The Home page's headline cards and KPI tiles, from the Business overview dataset. Short, plain
// sentences with the key figure in **bold** and a link to the page that explains it.

import { channelPeriod, productRows, type Window } from "../bi/analytics.ts";
import { addDaysIso } from "../bi/forecast.ts";
import type { BiDataset } from "../bi/types.ts";
import { inrShort } from "./chatAnswers.ts";

export interface Headline { text: string; href: string; linkLabel: string; tone: "good" | "bad" | "neutral" }
export interface Tile { label: string; value: string; sub: string; change: number | null; inverse?: boolean; href: string }

const num = (v: number) => Math.round(v).toLocaleString("en-IN");
const pct = (a: number, b: number) => (b > 0 ? ((a - b) / b) * 100 : null);
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;
const w = (start: string, end: string): Window => ({ start, end, days: days(start, end) });
const monthEnd = (start: string) => { const [y, m] = start.split("-").map(Number); return `${y}-${String(m).padStart(2, "0")}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`; };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthLabel = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

/** The last calendar month that has ended, and the month before it. */
export function lastFullMonths(asOf: string): { cur: Window; prev: Window } {
  const curStart = addDaysIso(`${asOf.slice(0, 7)}-01`, -1).slice(0, 7) + "-01";
  const prevStart = addDaysIso(curStart, -1).slice(0, 7) + "-01";
  return { cur: w(curStart, monthEnd(curStart)), prev: w(prevStart, monthEnd(prevStart)) };
}

/** Sales per channel for a window, channels with every day covered only (missing days are not zero). */
function channelSales(ds: BiDataset, win: Window) {
  return ds.channels.map((c) => channelPeriod(ds, c, win)).filter((p) => p.complete);
}

export function homeHeadlines(ds: BiDataset): Headline[] {
  const out: Headline[] = [];
  const asOf = ds.asOf;

  // 1. last full month vs the month before, like for like
  const { cur, prev } = lastFullMonths(asOf);
  const a = channelSales(ds, cur), b = channelSales(ds, prev);
  const both = a.filter((x) => b.some((y) => y.id === x.id));
  if (both.length) {
    const ra = both.reduce((s, x) => s + (x.revenue ?? 0), 0);
    const rb = both.reduce((s, x) => s + (b.find((y) => y.id === x.id)!.revenue ?? 0), 0);
    const ch = pct(ra, rb);
    const moves = both.map((x) => ({ x, d: (x.revenue ?? 0) - (b.find((y) => y.id === x.id)!.revenue ?? 0) }));
    const driver = [...moves].sort((p, q) => (ch !== null && ch < 0 ? p.d - q.d : q.d - p.d))[0];
    const top = [...both].sort((p, q) => (q.revenue ?? 0) - (p.revenue ?? 0))[0];
    if (ch !== null) {
      out.push({
        tone: ch >= 0 ? "good" : "bad",
        text: `Sales ${ch >= 0 ? "rose" : "fell"} **${Math.abs(ch).toFixed(1)}%** in ${monthLabel(cur.start)}, mostly **${driver.x.label}** (${driver.d >= 0 ? "+" : "−"}${inrShort(Math.abs(driver.d)).replace("−", "")}). **${top.label}** brings **${ra > 0 ? (((top.revenue ?? 0) / ra) * 100).toFixed(0) : 0}%** of ${monthLabel(cur.start)} sales (${inrShort(ra)}).`,
        href: "/dashboard/compare", linkLabel: "Open Overall",
      });
    }
  }

  // 2. units, last 7 days vs the 7 before
  const w7 = w(addDaysIso(asOf, -6), asOf), p7 = w(addDaysIso(asOf, -13), addDaysIso(asOf, -7));
  const u7 = channelSales(ds, w7), u7p = channelSales(ds, p7);
  const both7 = u7.filter((x) => u7p.some((y) => y.id === x.id));
  if (both7.length) {
    const ua = both7.reduce((s, x) => s + (x.units ?? 0), 0), ub = both7.reduce((s, x) => s + (u7p.find((y) => y.id === x.id)!.units ?? 0), 0);
    const ch = pct(ua, ub);
    out.push({ tone: ch === null || ch >= 0 ? "good" : "bad", text: `**${num(ua)}** units in the last 7 days${ch === null ? "" : ` (${ch >= 0 ? "up" : "down"} ${Math.abs(ch).toFixed(1)}% on the week before)`}.`, href: "/dashboard/compare", linkLabel: "Open Overall" });
  }

  // 3. FBA stock
  const rows = productRows(ds, 30);
  const amz = rows.filter((p) => p.channel === "amazon" && p.stock !== null);
  const out0 = amz.filter((p) => p.stock === 0 && p.units > 0).length;
  const low = amz.filter((p) => (p.stock ?? 0) > 0 && p.daysOfCover !== null && p.daysOfCover < 14).length;
  if (amz.length) out.push({ tone: out0 + low > 0 ? "bad" : "good", text: out0 + low > 0 ? `**${out0}** selling products have **0** FBA stock and **${low}** have under 2 weeks left.` : "Every selling Amazon product has at least 2 weeks of FBA stock.", href: "/dashboard/inventory", linkLabel: "Open Inventory" });

  // 4. advertising, last 30 days
  const w30 = w(addDaysIso(asOf, -29), asOf);
  let spend = 0, adSales = 0;
  for (const ad of ds.ads) ad.spend.forEach((s, i) => { if (s !== null && ds.dates[i] >= w30.start && ds.dates[i] <= w30.end) { spend += s; adSales += ad.sales[i] ?? 0; } });
  const sales30 = channelSales(ds, w30).reduce((s, x) => s + (x.revenue ?? 0), 0);
  if (spend > 0) out.push({ tone: "neutral", text: `Ad spend **${inrShort(spend * ds.gstMultiplier)}** incl. GST in the last 30 days; ads returned **${(adSales / spend).toFixed(1)}x**${sales30 > 0 ? `, TACOS **${(((spend * ds.gstMultiplier) / sales30) * 100).toFixed(1)}%**` : ""}.`, href: "/dashboard/daily-ad-spend", linkLabel: "Open Daily Ad Spend" });

  // 5. returns, last 30 days
  const ret = channelSales(ds, w30).filter((x) => x.returns !== null);
  const ru = ret.reduce((s, x) => s + (x.units ?? 0), 0), rr = ret.reduce((s, x) => s + (x.returns ?? 0), 0);
  const worst = rows.filter((p) => p.returns > 0).sort((p, q) => q.returns - p.returns)[0];
  if (ru > 0) out.push({ tone: rr / ru > 0.1 ? "bad" : "neutral", text: `Returns are **${((rr / ru) * 100).toFixed(1)}%** of units in the last 30 days${worst ? `; most on **${worst.name.split(/\s+/).slice(0, 5).join(" ")}** (${num(worst.returns)})` : ""}.`, href: "/dashboard/executive", linkLabel: "Open Business overview" });

  return out;
}

export function homeTiles(ds: BiDataset): Tile[] {
  const asOf = ds.asOf;
  const tiles: Tile[] = [];
  const { cur, prev } = lastFullMonths(asOf);
  const sum = (win: Window, k: "revenue" | "units" | "returns") => channelSales(ds, win).reduce((s, x) => s + (x[k] ?? 0), 0);

  const ra = sum(cur, "revenue"), rb = sum(prev, "revenue");
  tiles.push({ label: `Sales · ${monthLabel(cur.start)}`, value: inrShort(ra), sub: `${monthLabel(prev.start)}: ${inrShort(rb)}`, change: pct(ra, rb), href: "/dashboard/compare" });

  const y = w(asOf, asOf), yb = w(addDaysIso(asOf, -1), addDaysIso(asOf, -1));
  const ua = sum(y, "units"), ub = sum(yb, "units");
  tiles.push({ label: `Units · ${asOf.slice(8, 10)} ${MONTHS[Number(asOf.slice(5, 7)) - 1].slice(0, 3)}`, value: num(ua), sub: "vs day before", change: pct(ua, ub), href: "/dashboard/compare" });

  const w30 = w(addDaysIso(asOf, -29), asOf);
  const s30 = sum(w30, "revenue"), s30p = sum(w(addDaysIso(asOf, -59), addDaysIso(asOf, -30)), "revenue");
  tiles.push({ label: "Sales · last 30 days", value: inrShort(s30), sub: "vs the 30 days before", change: pct(s30, s30p), href: "/dashboard/executive" });

  let spend = 0, adSales = 0;
  for (const ad of ds.ads) ad.spend.forEach((s, i) => { if (s !== null && ds.dates[i] >= w30.start && ds.dates[i] <= w30.end) { spend += s; adSales += ad.sales[i] ?? 0; } });
  tiles.push({ label: "Ad spend · 30 days", value: inrShort(spend * ds.gstMultiplier), sub: spend > 0 ? `incl. 18% GST · ROAS ${(adSales / spend).toFixed(1)}x` : "incl. 18% GST", change: null, href: "/dashboard/daily-ad-spend" });

  const selling = new Set(productRows(ds, 30).filter((p) => p.units > 0).map((p) => p.key)).size;
  tiles.push({ label: "Products selling", value: num(selling), sub: "with sales in the last 30 days", change: null, href: "/dashboard/executive" });
  return tiles;
}
