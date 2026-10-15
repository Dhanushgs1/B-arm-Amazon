// Godown Stock Analytics (user, 2026-10-13) — trends over the godown's own daily "Stock Out" history
// (barm_godown_daily) for the products on the current godown sheet. Stock and restock numbers are
// the Consolidated Stock Sheet's rows (src/lib/consolidatedStock.ts) as they are; this module adds
// no new stock source and never writes anything.
//
// Rules the user set:
//   * Only real godown days count. A date with no upload is a gap — never zero sales. Averages are
//     per covered day, and every window says how many of its days are covered.
//   * Too little history is said out loud: windows below their minimum covered days give
//     "Insufficient data", and seasonality stays "not available" until a year of days exists.
//   * Actual = read from the godown sheet / Monday snapshot. Estimate = calculated here or in the
//     Consolidated sheet (averages, growth, days left, run-out date, restock qty).

import { productKey, RUNNING_OUT_DAYS, type ConsolidatedRow } from "./consolidatedStock.ts";
import { currentGodownName, isGodownDuplicate } from "./godownProductAliases.ts";

export const GA_RULES = {
  recentDays: 7,            // "last 7 days" window, ending on the latest godown day
  baselineDays: 30,         // "last 30 days" window; growth compares the 7 days to days 8–30
  minRecentCovered: 4,      // fewer covered days than this in the 7-day window → insufficient
  minPriorCovered: 12,      // …or in days 8–30 (23 calendar days) → insufficient
  growthPct: 20,            // ±20 % = growing / dropping
  spikePct: 100,            // +100 % or more = spike
  lowVolumePerDay: 0.5,     // under 0.5 units/day over 30 days = low volume (too small to trend)
  seasonalityMinDays: 365,  // a calendar month has to repeat before seasonality means anything
  criticalDays: 15,
  highDays: RUNNING_OUT_DAYS, // 30, same as the Consolidated sheet's "running out" list
  watchDays: 45,
} as const;

export type GodownStatus = "SPIKE" | "GROWING" | "STABLE" | "DROPPING" | "NO SALES" | "LOW VOLUME" | "INSUFFICIENT DATA";
export type StockRisk = "OUT OF STOCK" | "CRITICAL" | "HIGH" | "WATCH" | "OK" | "NOT SELLING";

export interface GodownDailyRow { date: string; product: string; stockOut: number; closing: number | null }

const DAY = 86_400_000;
const toTime = (d: string) => Date.parse(d + "T00:00:00Z");
export const addDays = (d: string, n: number) => new Date(toTime(d) + n * DAY).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((toTime(b) - toTime(a)) / DAY);
/** Every calendar date from `from` to `to`, inclusive. */
export function calendar(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export interface Coverage {
  firstDate: string | null;
  lastDate: string | null;
  calendarDays: number;          // first → last, inclusive
  coveredDays: number;           // dates with a godown upload
  missingDays: number;
  coveragePct: number | null;
  missingRanges: { from: string; to: string; days: number }[];
  seasonalityReady: boolean;
  warnings: string[];
}

export function coverageOf(dates: Iterable<string>, rules = GA_RULES): Coverage {
  const covered = [...new Set(dates)].sort();
  if (!covered.length) {
    return { firstDate: null, lastDate: null, calendarDays: 0, coveredDays: 0, missingDays: 0, coveragePct: null, missingRanges: [], seasonalityReady: false, warnings: ["No godown history uploaded yet."] };
  }
  const first = covered[0], last = covered[covered.length - 1];
  const calendarDays = daysBetween(first, last) + 1;
  const missingRanges: Coverage["missingRanges"] = [];
  for (let i = 1; i < covered.length; i++) {
    const gap = daysBetween(covered[i - 1], covered[i]) - 1;
    if (gap > 0) missingRanges.push({ from: addDays(covered[i - 1], 1), to: addDays(covered[i], -1), days: gap });
  }
  const missingDays = calendarDays - covered.length;
  const seasonalityReady = covered.length >= rules.seasonalityMinDays;
  const warnings: string[] = [];
  const seasonalityReady0 = covered.length >= rules.seasonalityMinDays;
  warnings.push(`${seasonalityReady0 ? "" : "Only "}${covered.length} godown days of history (${first} to ${last}).`);
  if (missingDays) warnings.push(`${missingDays} day${missingDays === 1 ? "" : "s"} have no godown upload and are shown as gaps, not zero: ${missingRanges.map((r) => (r.days === 1 ? r.from : `${r.from} to ${r.to}`)).join(", ")}.`);
  if (!seasonalityReady) warnings.push(`Seasonality is not available: it needs at least ${rules.seasonalityMinDays} days of history so a month can be compared with the same month a year earlier.`);
  return { firstDate: first, lastDate: last, calendarDays, coveredDays: covered.length, missingDays, coveragePct: (covered.length / calendarDays) * 100, missingRanges, seasonalityReady, warnings };
}

/** Units and covered days of one product inside [from, to]. `byDate` holds only the product's real rows. */
function windowOf(byDate: Map<string, number>, from: string, to: string) {
  let units = 0, covered = 0;
  for (const [d, v] of byDate) if (d >= from && d <= to) { units += v; covered++; }
  return { units, covered, rate: covered ? units / covered : null };
}

export interface ProductTrend {
  product: string;
  status: GodownStatus;
  statusWhy: string;
  // actual (sums of real godown days)
  units7: number; covered7: number;
  units30: number; covered30: number;
  peakQty: number | null; peakDate: string | null;
  lastSaleDate: string | null;
  // estimates (rates per covered day)
  rate7: number | null;
  rate30: number | null;
  ratePrior: number | null;      // days 8–30
  growthPct: number | null;      // rate7 vs ratePrior
}

export function productTrend(product: string, byDate: Map<string, number>, asOf: string, rules = GA_RULES): ProductTrend {
  const w7 = windowOf(byDate, addDays(asOf, -(rules.recentDays - 1)), asOf);
  const w30 = windowOf(byDate, addDays(asOf, -(rules.baselineDays - 1)), asOf);
  const prior = windowOf(byDate, addDays(asOf, -(rules.baselineDays - 1)), addDays(asOf, -rules.recentDays));
  let peakQty: number | null = null, peakDate: string | null = null, lastSaleDate: string | null = null;
  for (const [d, v] of byDate) {
    if (d > asOf || v <= 0) continue;
    if (peakQty === null || v > peakQty || (v === peakQty && d > (peakDate as string))) { peakQty = v; peakDate = d; }
    if (!lastSaleDate || d > lastSaleDate) lastSaleDate = d;
  }
  const growthPct = prior.rate && w7.rate !== null ? ((w7.rate - prior.rate) / prior.rate) * 100 : null;
  const base = { product, units7: w7.units, covered7: w7.covered, units30: w30.units, covered30: w30.covered, peakQty, peakDate, lastSaleDate, rate7: w7.rate, rate30: w30.rate, ratePrior: prior.rate, growthPct };

  const status = ((): [GodownStatus, string] => {
    if (!w30.covered) return ["INSUFFICIENT DATA", "No godown days for this product in the last 30 days."];
    if (w30.units === 0) return ["NO SALES", `Nothing shipped on any of the ${w30.covered} godown days in the last 30 days.`];
    if (w7.covered < rules.minRecentCovered || prior.covered < rules.minPriorCovered) {
      return ["INSUFFICIENT DATA", `Needs ${rules.minRecentCovered}+ godown days in the last 7 and ${rules.minPriorCovered}+ in days 8–30; has ${w7.covered} and ${prior.covered}.`];
    }
    if ((w30.rate ?? 0) < rules.lowVolumePerDay) return ["LOW VOLUME", `Under ${rules.lowVolumePerDay} units/day over the last 30 days — too small to call a trend.`];
    if (growthPct === null) return ["SPIKE", "Selling in the last 7 days after nothing shipped in days 8–30."];
    if (growthPct >= rules.spikePct) return ["SPIKE", `Last 7 days are ${Math.round(growthPct)}% above days 8–30.`];
    if (growthPct >= rules.growthPct) return ["GROWING", `Last 7 days are ${Math.round(growthPct)}% above days 8–30.`];
    if (growthPct <= -rules.growthPct) return ["DROPPING", `Last 7 days are ${Math.round(-growthPct)}% below days 8–30.`];
    return ["STABLE", `Last 7 days are within ±${rules.growthPct}% of days 8–30.`];
  })();
  return { ...base, status: status[0], statusWhy: status[1] };
}

export interface StockView {
  currentStock: number;          // actual: godown sheet
  avgPerDay: number;             // estimate: Consolidated sheet's 10-day average
  daysLeft: number | null;       // estimate
  runOutDate: string | null;     // estimate
  risk: StockRisk;
}

export function stockView(row: Pick<ConsolidatedRow, "currentStock" | "avgPerDay">, asOf: string, rules = GA_RULES): StockView {
  const { currentStock, avgPerDay } = row;
  if (!(avgPerDay > 0)) return { currentStock, avgPerDay, daysLeft: null, runOutDate: null, risk: "NOT SELLING" };
  if (currentStock <= 0) return { currentStock, avgPerDay, daysLeft: 0, runOutDate: asOf, risk: "OUT OF STOCK" };
  const daysLeft = currentStock / avgPerDay;
  const risk: StockRisk = daysLeft < rules.criticalDays ? "CRITICAL" : daysLeft < rules.highDays ? "HIGH" : daysLeft < rules.watchDays ? "WATCH" : "OK";
  return { currentStock, avgPerDay, daysLeft, runOutDate: addDays(asOf, Math.floor(daysLeft)), risk };
}

export interface MonthRate { month: string; units: number; coveredDays: number; daysInMonth: number; ratePerDay: number; partial: boolean }

export interface ProductHistory {
  coveredDays: number;            // godown days with a row for this product, up to asOf
  meanPerDay: number | null;      // estimate: all those days
  medianPerDay: number | null;    // estimate
  vsAvgPct: number | null;        // last 7 days vs meanPerDay
  peakMonth: string | null;       // yyyy-mm of the peak day
  bestMonth: MonthRate | null;    // highest units per godown day, months with ≥ minMonthDays godown days only
  months: MonthRate[];
}

const MIN_MONTH_DAYS = 7;

export function productHistory(byDate: Map<string, number>, asOf: string, rate7: number | null, peakDate: string | null): ProductHistory {
  const vals: number[] = [];
  const by = new Map<string, { units: number; covered: number }>();
  for (const [d, v] of byDate) {
    if (d > asOf) continue;
    vals.push(v);
    const m = by.get(d.slice(0, 7)) ?? { units: 0, covered: 0 };
    m.units += v; m.covered++;
    by.set(d.slice(0, 7), m);
  }
  const sorted = [...vals].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const medianPerDay = !sorted.length ? null : sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const meanPerDay = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  const months: MonthRate[] = [...by].sort(([a], [b]) => (a < b ? -1 : 1)).map(([month, m]) => {
    const daysInMonth = monthLen(month);
    return { month, units: m.units, coveredDays: m.covered, daysInMonth, ratePerDay: m.units / m.covered, partial: m.covered < daysInMonth };
  });
  const bestMonth = months.filter((m) => m.coveredDays >= MIN_MONTH_DAYS && m.units > 0)
    .reduce<MonthRate | null>((best, m) => (!best || m.ratePerDay > best.ratePerDay ? m : best), null);
  return {
    coveredDays: vals.length, meanPerDay, medianPerDay,
    vsAvgPct: meanPerDay && rate7 !== null ? ((rate7 - meanPerDay) / meanPerDay) * 100 : null,
    peakMonth: peakDate ? peakDate.slice(0, 7) : null, bestMonth, months,
  };
}

// ── unusual days (user, 2026-10-13) ─────────────────────────────────────────────────────────────
// A day far above the product's usual level is FLAGGED, never excluded: excluding needs evidence
// that it was a bulk transfer, and none exists — FBA shipment records (Jul–Oct 2026) do not show up
// in godown Stock Out (2–5 % of pickups line up with a jump, no better than chance). So peaks and
// averages use every real day; the flag shows the original value, the usual level and why.
export const UNUSUAL_RULES = { minUnits: 20, ratio: 5, window: 30, minWindowDays: 10 } as const;
export interface UnusualDay { date: string; units: number; typical: number; ratio: number }

/** Days with ≥ 20 units and ≥ 5× the median of the product's selling days among the 30 godown days
 *  either side (needs 10+ such days to judge). */
export function unusualDays(byDate: Map<string, number>, asOf: string, r = UNUSUAL_RULES): UnusualDay[] {
  const l = [...byDate].filter(([d]) => d <= asOf).sort(([a], [b]) => (a < b ? -1 : 1));
  const out: UnusualDay[] = [];
  l.forEach(([d, v], i) => {
    if (v < r.minUnits) return;
    const win = l.slice(Math.max(0, i - r.window), i).concat(l.slice(i + 1, i + 1 + r.window)).map(([, x]) => x).filter((x) => x > 0).sort((a, b) => a - b);
    if (win.length < r.minWindowDays) return;
    const typical = win[win.length >> 1];
    if (v >= r.ratio * typical) out.push({ date: d, units: v, typical, ratio: v / typical });
  });
  return out;
}

// ── seasonality (only once a year of godown days exists) ────────────────────────────────────────
export const SEASON_RULES = { minMonthDays: 7, minMonths: 12, minPerDay: 0.5, high: 1.3, low: 0.7 } as const;
export interface Seasonality { ready: boolean; text: string; highMonths: string[]; lowMonths: string[]; yoyMonth: string | null; yoyPct: number | null; monthsUsed: number }

/** Calendar-month pattern: each month's units per godown day (months with 7+ godown days, from the
 *  first month the product sold), averaged per calendar month across years, against their mean.
 *  High ≥ 1.3×, low ≤ 0.7×. Year-on-year = the latest month vs the same month a year earlier. */
export function seasonalityOf(months: MonthRate[], historyReady: boolean, coveredDays: number, r = SEASON_RULES): Seasonality {
  const none = (text: string): Seasonality => ({ ready: false, text, highMonths: [], lowMonths: [], yoyMonth: null, yoyPct: null, monthsUsed: 0 });
  if (!historyReady) return none(`Not available — ${coveredDays} godown days (needs 365)`);
  const first = months.findIndex((m) => m.units > 0);
  if (first < 0) return none("No sales in the history");
  const usable = months.slice(first).filter((m) => m.coveredDays >= r.minMonthDays);
  if (usable.length < r.minMonths) return none(`Not enough history since first sale (${usable.length} months; needs ${r.minMonths})`);
  const byCal = new Map<number, number[]>();
  for (const m of usable) { const k = Number(m.month.slice(5, 7)); byCal.set(k, [...(byCal.get(k) ?? []), m.ratePerDay]); }
  const cal = [...byCal].map(([k, v]) => ({ k, rate: v.reduce((a, b) => a + b, 0) / v.length, years: v.length }));
  const base = cal.reduce((a, c) => a + c.rate, 0) / cal.length;
  const last = usable[usable.length - 1];
  const prev = usable.find((m) => m.month === `${Number(last.month.slice(0, 4)) - 1}${last.month.slice(4)}`);
  const yoyPct = prev && prev.ratePerDay > 0 ? ((last.ratePerDay - prev.ratePerDay) / prev.ratePerDay) * 100 : null;
  const yoy = { yoyMonth: prev ? last.month : null, yoyPct, monthsUsed: usable.length };
  if (base < r.minPerDay) return { ...none(`Too few sales to judge (${base.toFixed(1)}/day)`), ...yoy };
  const name = (c: { k: number; years: number }) => `${MONTHS[c.k - 1]}${c.years > 1 ? "" : "*"}`;
  const high = cal.filter((c) => c.rate >= r.high * base).sort((a, b) => b.rate - a.rate);
  const low = cal.filter((c) => c.rate <= r.low * base).sort((a, b) => a.rate - b.rate);
  const text = !high.length && !low.length ? "No clear season (every month within ±30% of usual)"
    : [high.length ? `High: ${high.map(name).join(", ")}` : "", low.length ? `Low: ${low.map(name).join(", ")}` : ""].filter(Boolean).join(" · ")
      + (high.concat(low).some((c) => c.years === 1) ? " (* seen in one year only)" : "");
  return { ready: true, text, highMonths: high.map((c) => MONTHS[c.k - 1]), lowMonths: low.map((c) => MONTHS[c.k - 1]), ...yoy };
}

/** One plain-language next step per product (the Seasonal Analytics tab's "Recommendation"). */
export function recommendation(p: Pick<ProductAnalytics, "risk" | "status" | "daysLeft" | "finalQtyToRestock" | "currentStock" | "discontinued" | "growthPct">): string {
  const qty = Math.round(p.finalQtyToRestock);
  const left = p.daysLeft === null ? "" : `about ${Math.floor(p.daysLeft)} days of stock left (est.)`;
  if (p.discontinued) return "Discontinued — no restock.";
  if (p.risk === "OUT OF STOCK") return `Out of stock while selling — restock now${qty ? `; final restock qty ${qty}` : ""}.`;
  if (p.risk === "CRITICAL") return `Restock now: ${left}${qty ? `; final restock qty ${qty}` : ""}.`;
  if (p.risk === "HIGH") return `Plan the restock this week: ${left}${qty ? `; final restock qty ${qty}` : ""}.`;
  if (p.status === "NO SALES") return p.currentStock > 0 ? `No sales in 30 days with ${Math.round(p.currentStock)} in stock — check the listing before buying more.` : "No sales and no stock — check if it is still listed.";
  if (p.status === "SPIKE") return "Sales jumped — check it is real demand (not a one-off bulk order) before ordering extra.";
  if (p.status === "DROPPING") return `Sales down ${p.growthPct === null ? "" : Math.round(-p.growthPct) + "% "}— check price, rating, listing and ads before reordering.`;
  if (p.status === "GROWING") return p.risk === "WATCH" ? `Growing and ${left} — keep an eye on stock.` : "Growing — stock is fine for now.";
  if (p.status === "INSUFFICIENT DATA") return "Not enough godown days to judge yet.";
  return p.risk === "WATCH" ? `Steady; ${left} — restock in the next few weeks.` : "No action needed.";
}

export interface ProductAnalytics extends ProductTrend, StockView, ProductHistory {
  recommendation: string;
  unusual: UnusualDay[];                                   // flagged only — still counted everywhere
  peakUnusual: UnusualDay | null;                          // the peak day itself is one of them
  peakExUnusual: { qty: number; date: string } | null;     // best day that is not flagged (reference only)
  seasonality: Seasonality;
  discontinued: boolean;
  // Restock, exactly as the Consolidated sheet (Monday snapshot inputs are actual; quantities are estimates)
  need180: number;
  stockIntransit: number | null;
  orderPlaced: number | null;
  qtyToRestock: number;
  purchaseQty: number | null;
  finalQtyToRestock: number;
  comboQty: number | null;
}

export interface SeriesPoint { date: string; units: number | null }
export interface PeriodPoint { label: string; start: string; units: number; coveredDays: number; calendarDays: number; ratePerDay: number | null; partial: boolean }

export interface GodownAnalytics {
  asOf: string;
  coverage: Coverage;
  products: ProductAnalytics[];
  daily: SeriesPoint[];          // every calendar date; null = no upload that day
  weekly: PeriodPoint[];
  monthly: PeriodPoint[];
}

function periods(daily: SeriesPoint[], keyOf: (d: string) => string, labelOf: (k: string) => string, lengthOf: (k: string) => number): PeriodPoint[] {
  const by = new Map<string, PeriodPoint>();
  for (const p of daily) {
    const k = keyOf(p.date);
    const cur = by.get(k) ?? { label: labelOf(k), start: k, units: 0, coveredDays: 0, calendarDays: 0, ratePerDay: null, partial: false };
    cur.calendarDays++;
    if (p.units !== null) { cur.units += p.units; cur.coveredDays++; }
    by.set(k, cur);
  }
  return [...by.values()].map((p) => ({ ...p, ratePerDay: p.coveredDays ? p.units / p.coveredDays : null, partial: p.coveredDays < lengthOf(p.start) }));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const mondayKey = (d: string) => { const t = new Date(toTime(d)); return addDays(d, -((t.getUTCDay() + 6) % 7)); };
const monthLen = (ym: string) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();

/** Calendar series of one product's Stock Out (null on dates with no godown row for it). */
export function productSeries(rows: GodownDailyRow[], product: string, from: string, to: string): { date: string; units: number | null; closing: number | null }[] {
  const key = productKey(product);
  const by = new Map<string, { units: number; closing: number | null }>();
  for (const r of rows) {
    if (isGodownDuplicate(r.product) || productKey(currentGodownName(r.product)) !== key || r.date < from || r.date > to) continue;
    const cur = by.get(r.date) ?? { units: 0, closing: null };
    cur.units += r.stockOut;
    if (r.closing !== null) cur.closing = (cur.closing ?? 0) + r.closing;
    by.set(r.date, cur);
  }
  return calendar(from, to).map((d) => ({ date: d, units: by.get(d)?.units ?? null, closing: by.get(d)?.closing ?? null }));
}

/** Everything the page shows. `rows` = the Consolidated sheet's rows (the products on the current
 *  godown sheet); `history` = barm_godown_daily up to `asOf` (the sheet's latest godown day). */
export function analyzeGodown(rows: ConsolidatedRow[], history: GodownDailyRow[], asOf: string, rules = GA_RULES): GodownAnalytics {
  const hist = history.filter((h) => h.date <= asOf && !isGodownDuplicate(h.product));
  const coverage = coverageOf(hist.map((h) => h.date), rules);
  const byProduct = new Map<string, Map<string, number>>();
  const totals = new Map<string, number>();
  for (const h of hist) {
    const k = productKey(currentGodownName(h.product));
    const m = byProduct.get(k) ?? new Map<string, number>();
    m.set(h.date, (m.get(h.date) ?? 0) + h.stockOut);
    byProduct.set(k, m);
    totals.set(h.date, (totals.get(h.date) ?? 0) + h.stockOut);
  }
  const products: ProductAnalytics[] = rows.map((r) => {
    const byDate = byProduct.get(productKey(r.godownName ?? r.product)) ?? new Map<string, number>();
    const trend = productTrend(r.product, byDate, asOf, rules);
    const hist = productHistory(byDate, asOf, trend.rate7, trend.peakDate);
    const unusual = unusualDays(byDate, asOf);
    const flagged = new Set(unusual.map((u) => u.date));
    let peakExUnusual: { qty: number; date: string } | null = null;
    for (const [d, v] of byDate) if (d <= asOf && v > 0 && !flagged.has(d) && (!peakExUnusual || v > peakExUnusual.qty || (v === peakExUnusual.qty && d > peakExUnusual.date))) peakExUnusual = { qty: v, date: d };
    const p = {
      ...trend,
      ...stockView(r, asOf, rules),
      ...hist,
      unusual, peakUnusual: unusual.find((u) => u.date === trend.peakDate) ?? null, peakExUnusual,
      seasonality: seasonalityOf(hist.months, coverage.seasonalityReady, coverage.coveredDays),
      discontinued: r.discontinued,
      need180: r.need180, stockIntransit: r.stockIntransit, orderPlaced: r.orderPlaced, qtyToRestock: r.qtyToRestock,
      purchaseQty: r.purchaseQty, finalQtyToRestock: r.finalQtyToRestock, comboQty: r.comboQty,
    };
    return { ...p, recommendation: recommendation(p) };
  });
  const daily: SeriesPoint[] = coverage.firstDate ? calendar(coverage.firstDate, coverage.lastDate as string).map((d) => ({ date: d, units: totals.has(d) ? (totals.get(d) as number) : null })) : [];
  const weekly = periods(daily, mondayKey, (k) => `Wk ${Number(k.slice(8))} ${MONTHS[Number(k.slice(5, 7)) - 1]}`, () => 7);
  const monthly = periods(daily, (d) => d.slice(0, 7), (k) => `${MONTHS[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`, monthLen);
  return { asOf, coverage, products, daily, weekly, monthly };
}

export const STATUS_ORDER: GodownStatus[] = ["SPIKE", "GROWING", "STABLE", "DROPPING", "NO SALES", "LOW VOLUME", "INSUFFICIENT DATA"];
export const RISK_ORDER: StockRisk[] = ["OUT OF STOCK", "CRITICAL", "HIGH", "WATCH", "OK", "NOT SELLING"];
