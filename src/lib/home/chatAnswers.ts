// Answers the Home page's "Ask anything" box from our own data (the Business overview dataset), so
// common questions get an exact, instant answer without an AI service. Anything it does not
// recognise returns null and the page passes it to AI (when a key is configured on the server).
//
// Recognised: sales / revenue / orders for a period (yesterday, this or last week, last 7 / 30 /
// 90 days, this or last month, a named month), optionally for one channel; top N products; out
// of stock; most returns; ad spend, ROAS and ACOS.

import { channelPeriod, productRows, shortName, type Window } from "../bi/analytics.ts";
import { addDaysIso } from "../bi/forecast.ts";
import type { BiDataset, SalesChannelId } from "../bi/types.ts";

export interface ChatAnswer {
  /** Short answer; **bold** marks figures. One item per line. */
  text: string;
  href?: string;
  hrefLabel?: string;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_SHORT = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** ₹ in the Indian short form: ₹54.2 L, ₹3.00 Cr, ₹8,450. */
export function inrShort(v: number): string {
  const a = Math.abs(v);
  const s = a >= 1e7 ? `₹${(a / 1e7).toFixed(2)} Cr` : a >= 1e5 ? `₹${(a / 1e5).toFixed(1)} L` : `₹${Math.round(a).toLocaleString("en-IN")}`;
  return v < 0 ? `−${s}` : s;
}
const num = (v: number) => Math.round(v).toLocaleString("en-IN");
const dot = (iso: string) => iso.split("-").reverse().join(".");
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;
const win = (start: string, end: string): Window => ({ start, end, days: daysBetween(start, end) });
const monthEnd = (start: string) => { const [y, m] = start.split("-").map(Number); return `${y}-${String(m).padStart(2, "0")}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`; };
const monthName = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1][0].toUpperCase()}${MONTHS[Number(iso.slice(5, 7)) - 1].slice(1)} ${iso.slice(0, 4)}`;

const CHANNEL_WORDS: [RegExp, SalesChannelId][] = [
  [/\bamazon\b/, "amazon"], [/\bflipkart\b/, "flipkart"], [/\bmeesho\b/, "meesho"], [/\bshopify\b/, "shopify"], [/\b(website|offline|b-?arm)\b/, "barm"],
];
function channelOf(q: string): SalesChannelId | null {
  for (const [re, id] of CHANNEL_WORDS) if (re.test(q)) return id;
  return null;
}

/** The period a question asks about, ending no later than the dataset's last day. Default: last 30 days. */
/** A single day named in the question: "10 nov", "nov 10", "10th of november", "10.11.2026", "2026-11-10". */
export function dayOf(q: string, asOf: string): string | null {
  const iso = q.match(/\b(20\d\d)-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dm = q.match(/\b(\d{1,2})[./-](\d{1,2})(?:[./-](20\d\d))?\b/);
  const mon = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*";
  const a = q.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${mon}\\b`));
  const b = q.match(new RegExp(`\\b${mon}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`));
  let d: number | null = null, m: number | null = null, y: number | null = null;
  if (a) { d = Number(a[1]); m = MONTH_SHORT.indexOf(a[2].slice(0, 3)) + 1; }
  else if (b) { d = Number(b[2]); m = MONTH_SHORT.indexOf(b[1].slice(0, 3)) + 1; }
  else if (dm) { d = Number(dm[1]); m = Number(dm[2]); y = dm[3] ? Number(dm[3]) : null; }
  if (!d || !m || m < 1 || m > 12 || d > 31) return null;
  let year = y ?? Number(asOf.slice(0, 4));
  const pad = (n: number) => String(n).padStart(2, "0");
  if (!y && `${year}-${pad(m)}-${pad(d)}` > asOf) year -= 1; // "15 dec" asked in November means last December
  return `${year}-${pad(m)}-${pad(d)}`;
}

/** Period phrases, removed from an earlier question when a follow-up names a new period. */
export const PERIOD_WORDS = /\b(today|todays|yesterday|last day|latest day|(this|last|past|previous)\s+(week|month|quarter)|last\s+\d{1,3}\s+days?|month to date|mtd|(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*(\s+20\d\d)?|\d{1,2}(st|nd|rd|th)?|20\d\d-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}([./-]20\d\d)?)\b/g;

export function periodOf(q: string, asOf: string): { w: Window; label: string; explicit: boolean } {
  // today: the order uploads run a day behind, so the latest day on file stands in for it
  if (/\btoday'?s?\b|\blatest day\b|\bthis day\b/.test(q)) return { w: win(asOf, asOf), label: `${dot(asOf)} (the latest day on file; today's orders come with tomorrow's upload)`, explicit: true };
  const day = dayOf(q, asOf);
  if (day && day <= asOf) return { w: win(day, day), label: dot(day), explicit: true };
  if (day && day > asOf) return { w: win(asOf, asOf), label: `${dot(asOf)} (data on file only goes to this day, not ${dot(day)})`, explicit: true };
  const lastN = q.match(/\blast\s+(\d{1,3})\s+days?\b/);
  if (lastN) { const n = Math.min(365, Math.max(1, Number(lastN[1]))); return { w: win(addDaysIso(asOf, -(n - 1)), asOf), label: `the last ${n} days`, explicit: true }; }
  if (/\byesterday\b|\blast day\b/.test(q)) return { w: win(asOf, asOf), label: dot(asOf), explicit: true };
  if (/\b(this|last|past)\s+week\b|\blast 7\b/.test(q)) return { w: win(addDaysIso(asOf, -6), asOf), label: "the last 7 days", explicit: true };
  if (/\bthis month\b|\bmonth to date\b|\bmtd\b/.test(q)) return { w: win(`${asOf.slice(0, 7)}-01`, asOf), label: `${monthName(asOf)} so far`, explicit: true };
  if (/\blast month\b|\bprevious month\b/.test(q)) {
    const start = addDaysIso(`${asOf.slice(0, 7)}-01`, -1).slice(0, 7) + "-01";
    return { w: win(start, monthEnd(start)), label: monthName(start), explicit: true };
  }
  for (let i = 0; i < 12; i++) {
    if (new RegExp(`\\b(${MONTHS[i]}|${MONTH_SHORT[i]})\\b`).test(q)) {
      const yearM = q.match(/\b(20\d\d)\b/);
      let year = yearM ? Number(yearM[1]) : Number(asOf.slice(0, 4));
      const start = `${year}-${String(i + 1).padStart(2, "0")}-01`;
      if (!yearM && start > asOf) { year -= 1; }
      const s = `${year}-${String(i + 1).padStart(2, "0")}-01`;
      const e = monthEnd(s) > asOf ? asOf : monthEnd(s);
      return { w: win(s, e), label: e < monthEnd(s) ? `${monthName(s)} so far` : monthName(s), explicit: true };
    }
  }
  if (/\b(last|past)\s+(90|three months|quarter)\b/.test(q)) return { w: win(addDaysIso(asOf, -89), asOf), label: "the last 90 days", explicit: true };
  return { w: win(addDaysIso(asOf, -29), asOf), label: "the last 30 days", explicit: false };
}

function salesAnswer(ds: BiDataset, q: string): ChatAnswer {
  const { w, label } = periodOf(q, ds.asOf);
  const only = channelOf(q);
  const rows = ds.channels.filter((c) => !only || c.id === only).map((c) => channelPeriod(ds, c, w)).filter((p) => p.covered > 0 && (p.revenue || p.units));
  if (!rows.length) return { text: `No sales data on file for ${label}${only ? ` on ${only}` : ""}.` };
  const revenue = rows.reduce((s, p) => s + (p.revenue ?? 0), 0);
  const units = rows.reduce((s, p) => s + (p.units ?? 0), 0);
  const partial = rows.filter((p) => !p.complete);
  const who = only ? `${rows[0]?.label ?? only} sales` : "Sales";
  const when = w.days === 1 ? `on ${label}` : `in ${label} (${dot(w.start)} – ${dot(w.end)})`;
  const lines = [`${who} ${when}: **${inrShort(revenue)}** from **${num(units)}** units.`];
  if (rows.length > 1) {
    const sorted = [...rows].sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0));
    lines.push(...sorted.map((p) => `• ${p.label}: **${inrShort(p.revenue ?? 0)}**, ${num(p.units ?? 0)} units${revenue > 0 ? ` (${(((p.revenue ?? 0) / revenue) * 100).toFixed(0)}%)` : ""}`));
  }
  if (partial.length) lines.push(`Data covers only part of the period for ${partial.map((p) => `${p.label} (${p.covered} of ${w.days} days)`).join(", ")}.`);
  return { text: lines.join("\n"), href: "/dashboard/compare", hrefLabel: "Open Overall" };
}

function ordersAnswer(ds: BiDataset, q: string): ChatAnswer {
  const { w, label } = periodOf(q, ds.asOf);
  const only = channelOf(q);
  const rows = ds.channels.filter((c) => !only || c.id === only).map((c) => channelPeriod(ds, c, w)).filter((p) => p.covered > 0);
  const units = rows.reduce((s, p) => s + (p.units ?? 0), 0);
  const ret = rows.reduce((s, p) => s + (p.returns ?? 0), 0);
  return {
    text: [`Units sold in ${label}: **${num(units)}**${ret ? `, returns **${num(ret)}**, net **${num(units - ret)}**` : ""}.`,
      ...rows.filter((p) => p.units).sort((a, b) => (b.units ?? 0) - (a.units ?? 0)).map((p) => `• ${p.label}: ${num(p.units ?? 0)} units`)].join("\n"),
    href: "/dashboard/compare", hrefLabel: "Open Overall",
  };
}

function topProductsAnswer(ds: BiDataset, q: string): ChatAnswer {
  const n = Math.min(20, Math.max(1, Number(q.match(/\btop\s+(\d{1,2})\b/)?.[1] ?? 5)));
  const only = channelOf(q);
  const rows = productRows(ds, 30, only ? [only] : undefined).filter((p) => p.revenue > 0 || p.units > 0).sort((a, b) => b.revenue - a.revenue || b.units - a.units).slice(0, n);
  if (!rows.length) return { text: "No product sales in the last 30 days." };
  return {
    text: [`Top ${rows.length} products by sales, last 30 days${only ? ` on ${only}` : ""}:`, ...rows.map((p, i) => `${i + 1}. ${shortName(p.name)} (${p.channel}): **${inrShort(p.revenue)}**, ${num(p.units)} units`)].join("\n"),
    href: "/dashboard/executive", hrefLabel: "Open Business overview",
  };
}

function stockAnswer(ds: BiDataset): ChatAnswer {
  const rows = productRows(ds, 30).filter((p) => p.channel === "amazon" && p.stock !== null);
  const out = rows.filter((p) => p.stock === 0 && p.units > 0).sort((a, b) => b.units - a.units);
  const low = rows.filter((p) => p.stock! > 0 && p.daysOfCover !== null && p.daysOfCover < 14).sort((a, b) => (a.daysOfCover ?? 0) - (b.daysOfCover ?? 0));
  const asOf = ds.stock.map((s) => s.asOf).filter((d): d is string => !!d).sort().pop();
  if (!rows.length) return { text: "No FBA stock file on record." };
  const lines = [`Amazon FBA stock${asOf ? ` (file of ${dot(asOf)})` : ""}: **${out.length}** selling products have **0** available, **${low.length}** have under 2 weeks left.`];
  lines.push(...out.slice(0, 8).map((p) => `• ${shortName(p.name)}: 0 in FBA, ${num(p.units)} sold in 30 days${p.warehouse !== null ? `, ${num(p.warehouse)} in warehouse` : ""}`));
  if (low.length) lines.push(...low.slice(0, 5).map((p) => `• ${shortName(p.name)}: ${num(p.stock!)} left, about ${Math.floor(p.daysOfCover!)} days`));
  lines.push("0 in FBA while still selling often means orders ship from your own warehouse.");
  return { text: lines.join("\n"), href: "/dashboard/inventory", hrefLabel: "Open Inventory" };
}

function returnsAnswer(ds: BiDataset, q: string): ChatAnswer {
  const only = channelOf(q);
  const rows = productRows(ds, 30, only ? [only] : undefined).filter((p) => p.returns > 0).sort((a, b) => b.returns - a.returns).slice(0, 5);
  if (!rows.length) return { text: "No returns recorded in the last 30 days." };
  return {
    text: ["Most returned products, last 30 days:", ...rows.map((p, i) => `${i + 1}. ${shortName(p.name)} (${p.channel}): **${num(p.returns)}** returns${p.returnRatePct !== null ? ` (${p.returnRatePct.toFixed(1)}% of units)` : ""}`)].join("\n"),
    href: "/dashboard/executive", hrefLabel: "Open Business overview",
  };
}

function adsAnswer(ds: BiDataset, q: string): ChatAnswer {
  const { w, label } = periodOf(q, ds.asOf);
  const inW = (i: number) => ds.dates[i] >= w.start && ds.dates[i] <= w.end;
  const rows = ds.ads.map((a) => {
    let spend = 0, sales = 0, days = 0;
    a.spend.forEach((s, i) => { if (inW(i) && s !== null) { spend += s; sales += a.sales[i] ?? 0; days++; } });
    return { a, spend, sales, days };
  }).filter((r) => r.days > 0 && r.spend > 0);
  if (!rows.length) return { text: `No ad spend on file for ${label}.` };
  const spend = rows.reduce((s, r) => s + r.spend, 0);
  const lines = [`Ad spend in ${label}: **${inrShort(spend)}** before GST (**${inrShort(spend * ds.gstMultiplier)}** incl. 18% GST).`];
  lines.push(...rows.sort((a, b) => b.spend - a.spend).map((r) => `• ${r.a.label}: ${inrShort(r.spend)}${r.sales > 0 ? `, ROAS **${(r.sales / r.spend).toFixed(2)}x**, ACOS ${((r.spend / r.sales) * 100).toFixed(1)}%` : ""}${r.days < w.days ? ` (${r.days} of ${w.days} days on file)` : ""}`));
  return { text: lines.join("\n"), href: "/dashboard/daily-ad-spend", hrefLabel: "Open Daily Ad Spend" };
}

/** An answer from our data, or null when the question is not one of the recognised kinds. */
export function answerFromData(ds: BiDataset, question: string): ChatAnswer | null {
  const q = question.toLowerCase().replace(/[’']/g, "").replace(/\s+/g, " ").trim();
  if (!q) return null;
  if (/\bout of stock\b|\bstock\b|\brestock\b|\binventory\b/.test(q)) return stockAnswer(ds);
  if (/\breturn/.test(q)) return returnsAnswer(ds, q);
  if (/\btop\b.*\bproducts?\b|\bbest[- ]?sell|\bbest products?\b/.test(q)) return topProductsAnswer(ds, q);
  if (/\bad ?spend\b|\broas\b|\bacos\b|\badvertis|\bads\b|\bcampaign/.test(q)) return adsAnswer(ds, q);
  if (/\b(sell|sold|sales|revenue|turnover|earn)\b/.test(q)) return salesAnswer(ds, q);
  if (/\b(orders?|units)\b/.test(q)) return ordersAnswer(ds, q);
  return null;
}

/** A compact text summary of the dataset, given to AI as context for questions answerFromData skips. */
export function dataSummaryForAi(ds: BiDataset): string {
  const last30 = win(addDaysIso(ds.asOf, -29), ds.asOf);
  const lines = [`Data through ${ds.asOf}. Currency INR. Last 30 days (${last30.start} to ${last30.end}) by channel:`];
  for (const c of ds.channels) {
    const p = channelPeriod(ds, c, last30);
    if (p.covered) lines.push(`- ${c.label}: revenue ${Math.round(p.revenue ?? 0)}, units ${Math.round(p.units ?? 0)}, returns ${Math.round(p.returns ?? 0)}; basis: ${c.basis}`);
  }
  lines.push("Daily figures, last 14 days (revenue / units per channel):");
  for (let i = 13; i >= 0; i--) {
    const d = addDaysIso(ds.asOf, -i);
    const parts = ds.channels.map((c) => { const p = channelPeriod(ds, c, win(d, d)); return p.covered ? `${c.label} ${Math.round(p.revenue ?? 0)}/${Math.round(p.units ?? 0)}` : null; }).filter(Boolean);
    lines.push(`- ${d}: ${parts.join(", ")}`);
  }
  lines.push(`Note: data runs to ${ds.asOf}; orders for later days are not uploaded yet.`);
  const top = productRows(ds, 30).sort((a, b) => b.revenue - a.revenue).slice(0, 15);
  lines.push("Top products last 30 days:", ...top.map((p) => `- ${shortName(p.name)} [${p.channel}] revenue ${Math.round(p.revenue)}, units ${p.units}, returns ${p.returns}, FBA stock ${p.stock ?? "n/a"}`));
  return lines.join("\n");
}

/** A short follow-up that only names a period ("and today?", "i ask today", "what about 5 nov") reuses the
 *  previous question with the new period. Returns the question to answer, or null when it is not one. */
export function followUpQuestion(question: string, previous: string | undefined, asOf: string): string | null {
  if (!previous) return null;
  const q = question.toLowerCase().trim();
  if (q.split(/\s+/).length > 6 || !periodOf(q, asOf).explicit) return null;
  if (answerFromDataIntent(q)) return null; // it is a full question already
  const prevBase = previous.toLowerCase().replace(PERIOD_WORDS, " ").replace(/\s+/g, " ").trim();
  return `${prevBase} ${q}`;
}

/** True when the question already names something to answer about (sales, stock, ads, …). */
function answerFromDataIntent(q: string): boolean {
  return /\b(out of stock|stock|restock|inventory|return|top|best|ad ?spend|roas|acos|advertis|ads|campaign|sell|sold|sales|revenue|turnover|earn|orders?|units)\b/.test(q);
}
