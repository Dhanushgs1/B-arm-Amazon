// Seasonal Analytics engine — pure functions over the cached payload of public.seasonal_sales_daily()
// (scripts/seasonal_analytics_daily.sql). No I/O here, so node --test can exercise every rule.
//
// Identity: the master product is master_product_skuid."Product Name" — the table has no separate
// master ID column, and product_forecast_summary_live_v's "Product" column is exactly that name.
// Every metric is computed at master level (all SKUs of that name, across marketplaces) and again
// per SKU (marketplace + SKU ID) for drill-down. SKUs the view could not map ("Unknown") are kept
// apart as unmapped and never merged into a product.
//
// Missing vs zero: a marketplace day is MISSING when the marketplace has no upload for it (see
// buildCoverage) — it is NaN in every series and excluded from averages, never counted as 0.
//
// Nothing here guesses a cause. A reason is attached only when a data source that could support it
// (seasonal recurrence, daily stock, current stock, daily ad spend) actually covers the period;
// otherwise the reason says the cause is not confirmed and the evidence says which source is missing.

// ── Payload (shape of the jsonb the SQL function returns) ───────────────────────────────────────

export interface SeasonalPayload {
  generated_at?: string;
  cache_refreshed_at?: string;
  cache_error?: string | null;
  skus: [string, string, string | null, boolean][]; // [marketplace, sku_id, product, mapped]
  daily: [number, string, number][]; // [sku index, yyyy-mm-dd, units]
  coverage: { marketplace: string; first_date: string; last_date: string; days_with_data: number; dates: string[] }[];
  quality: { marketplace: string; unparseable_dates: number; missing_quantity: number; missing_sku: number; duplicate_rows: number }[];
  view_quality?: { rows: number; blank_sku: number; unknown_product: number; products: number };
  unmatched: { marketplace: string; rows: number; units: number; skus: number }[];
  stock_now: [string, number | null][]; // [product, current stock]
  stock_daily: [string, string, number][]; // [master product name, date, closing stock]
  ad_daily: [string, string, string, number][]; // [marketplace, sku, date, spend]
}

export interface AnalysisOptions {
  marketplaces?: string[]; // default: all
  from?: string; // inclusive yyyy-mm-dd, clipped to available data
  to?: string; // inclusive yyyy-mm-dd, clipped to available data; the analysis "as of" date
}

// ── Tunables (kept together so the rules are reviewable in one place) ───────────────────────────

export const RULES = {
  recentDays: 28, // "recent" = last 4 weeks
  currentDays: 7, // "current" = last 7 days
  growthPct: 40, // recent vs baseline beyond ±40% is a significant change
  currentSpikePct: 75, // last-7-day jump that flags a spike even when the 4-week average has not moved
  currentDropPct: 60,
  weekUpFactor: 1.25, // a week counts as "above baseline" when its rate is ≥ 1.25× baseline
  weekDownFactor: 0.75,
  sustainedWeeks: 3, // ≥ 3 of the last 4 weeks in the same direction = sustained
  minBaselineWeeks: 4, // fewer complete baseline weeks → INSUFFICIENT DATA
  minUnitsPerWeek: 2, // below this on both sides → LOW VOLUME (percentages would be noise)
  minAbsChange28d: 5, // a "significant" change must also move ≥ 5 units over 4 weeks
  dailyFeedShare: 0.9, // marketplaces with rows on ≥ 90% of days are daily feeds: gaps = missing
  minMonthCoverage: 0.5, // a month needs ≥ 50% covered days to rank as a peak/low month
  seasonalHighIndex: 1.25, // month rate ≥ 1.25× that year's average month
  seasonalLowIndex: 0.8,
  minSeasonYears: 2, // a month must repeat in ≥ 2 years before anything is called seasonal
  lowStockCoverDays: 7,
  adChangePct: 30,
} as const;

// ── Output types ────────────────────────────────────────────────────────────────────────────────

export type Status =
  | "HIGH GROWTH"
  | "UNUSUAL SPIKE"
  | "DEMAND DROP"
  | "UNUSUAL DECLINE"
  | "SEASONAL HIGH"
  | "SEASONAL LOW"
  | "STABLE"
  | "LOW VOLUME"
  | "INSUFFICIENT DATA";

export type Confidence = "HIGH" | "MEDIUM" | "LOW";

export interface MonthPoint { month: string; units: number; coveredDays: number; daysInMonth: number; rate: number | null; complete: boolean }
export interface WeekPoint { weekStart: string; units: number; coveredDays: number; partial: boolean }

export interface Seasonality {
  determinable: boolean;
  yearsObserved: number;
  recurringHigh: number[]; // month numbers 1-12
  recurringLow: number[];
  label: string;
  evidence: string[];
  confidence: Confidence;
  observedPeakMonth: string | null; // yyyy-mm, from available history (descriptive only)
  observedLowMonth: string | null;
}

export interface Metrics {
  coveredDays: number;
  totalUnits: number;
  dailyMean: number | null;
  dailyMedian: number | null;
  dailyMin: number | null;
  dailyMax: number | null;
  peakQty: number | null;
  peakDate: string | null;
  peakMonth: string | null; // yyyy-mm with the highest units/day among sufficiently covered months
  peakWeekStart: string | null;
  peakWeekUnits: number | null;
  peakWeekRate: number | null; // units/day in the best week (≥ 6 covered days)
  baselineMean: number | null; // units/day before the recent window
  baselineMedianWeekly: number | null; // median of weekly units/day before the recent window
  baseline: number | null; // the baseline used for classification
  baselineMethod: string;
  baselineWeeks: number;
  recentAvg: number | null; // units/day, last 28 days
  currentAvg: number | null; // units/day, last 7 days
  currentUnits: number | null; // units, last 7 days
  prevAvg: number | null; // units/day, the 28 days before the recent window
  sameMonthHistAvg: number | null; // same calendar month in earlier years, units/day
  growthPct: number | null; // recent vs baseline
  changeVsMeanPct: number | null; // recent vs historical mean
  changeVsPrevPct: number | null; // recent vs previous 28 days
  peakVsAvgPct: number | null;
  currentVsPeakPct: number | null; // current daily avg as % of the peak day
  recentWeeks: { start: string; rate: number | null }[];
  weeksUp: number;
  weeksDown: number;
  changeStart: string | null;
  changeDurationDays: number | null;
  excludedMarketplaces: string[]; // dropped from like-for-like comparisons (no coverage in both periods)
}

export interface Analysis {
  status: Status;
  pattern: string | null; // Sustained / Short-term / Temporary
  peakApproaching: boolean;
  statusReason: string; // why it was classified this way (numbers)
  likelyReason: string; // evidence-backed cause, or "Cause not confirmed from available data."
  evidence: string[];
  confidence: Confidence;
  recommendation: string;
  seasonality: Seasonality;
}

export interface SkuResult {
  key: string; // marketplace|sku
  marketplace: string;
  sku: string;
  master: string | null; // null when unmapped
  metrics: Metrics;
  analysis: Analysis;
  weekly: WeekPoint[];
  monthly: MonthPoint[];
}

export interface MasterResult {
  master: string;
  skuKeys: string[];
  skuIds: string[];
  marketplaces: string[];
  currentStock: number | null;
  metrics: Metrics;
  analysis: Analysis;
  weekly: WeekPoint[];
  monthly: MonthPoint[];
  contributions: { key: string; deltaPerDay: number; sharePct: number | null }[];
  peakContributors: { key: string; units: number }[];
}

export interface DataQuality {
  historicalStart: string;
  historicalEnd: string;
  totalDays: number;
  totalMonths: number;
  marketplaces: {
    marketplace: string;
    firstDate: string;
    lastDate: string;
    daysWithData: number;
    rangeDays: number;
    feed: "daily" | "sparse";
    missingDates: string[];
    unparseableDates: number;
    missingQuantity: number;
    duplicateRows: number;
  }[];
  coverageNote: string;
  viewRows: number | null;
  viewBlankSku: number | null;
  viewUnknownProduct: number | null;
  unmappedSkus: string[]; // marketplace|sku with no master product
  unmatchedOrders: { marketplace: string; rows: number; units: number; skus: number }[];
  incompleteMonths: string[];
  stockHistory: string;
  adHistory: string;
  warnings: string[];
}

export interface SeasonalResult {
  asOf: string;
  from: string;
  marketplaces: string[];
  generatedAt: string | null;
  quality: DataQuality;
  masters: MasterResult[];
  skus: SkuResult[];
  unmapped: SkuResult[];
}

// ── Date helpers (UTC day arithmetic on yyyy-mm-dd) ─────────────────────────────────────────────

const DAY = 86_400_000;
export const toTime = (d: string) => Date.parse(d + "T00:00:00Z");
export const toDate = (t: number) => new Date(t).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => toDate(toTime(d) + n * DAY);
export const daysBetween = (a: string, b: string) => Math.round((toTime(b) - toTime(a)) / DAY);
const monthOf = (d: string) => d.slice(0, 7);
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthName = (m: number) => MONTH_NAMES[m - 1];
export const monthLabel = (ym: string) => `${monthName(Number(ym.slice(5, 7)))} ${ym.slice(0, 4)}`;
const daysInMonth = (ym: string) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();

const fmt = (n: number | null | undefined, dp = 1) =>
  n === null || n === undefined || !Number.isFinite(n) ? "n/a" : Number(n.toFixed(dp)).toLocaleString("en-IN");
const pct = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? "n/a" : `${n > 0 ? "+" : ""}${Math.round(n)}%`);

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const pctChange = (a: number | null, b: number | null) => (a === null || b === null || b === 0 ? null : ((a - b) / b) * 100);

// ── Coverage ────────────────────────────────────────────────────────────────────────────────────

/** Per-marketplace "is this day covered" over the day axis. A daily feed (rows on ≥ 90% of its
 *  days, e.g. Amazon/Flipkart order reports) treats a day with no rows as MISSING — an upload gap
 *  is far likelier than zero orders. A sparse feed (low-volume channel such as the website) has
 *  genuine no-order days, so inside its first..last range a day with no rows is a real zero. */
export function buildCoverage(payload: SeasonalPayload, start: string, nDays: number) {
  const out = new Map<string, { covered: Uint8Array; feed: "daily" | "sparse"; missing: string[] }>();
  for (const c of payload.coverage) {
    const has = new Set(c.dates);
    const rangeDays = daysBetween(c.first_date, c.last_date) + 1;
    const feed = c.days_with_data / rangeDays >= RULES.dailyFeedShare ? "daily" : "sparse";
    const covered = new Uint8Array(nDays);
    const missing: string[] = [];
    for (let i = 0; i < nDays; i++) {
      const d = addDays(start, i);
      if (d < c.first_date || d > c.last_date) continue;
      if (feed === "daily" && !has.has(d)) { missing.push(d); continue; }
      covered[i] = 1;
    }
    out.set(c.marketplace, { covered, feed, missing });
  }
  return out;
}

// ── Series & windows ────────────────────────────────────────────────────────────────────────────

/** An entity's daily units split by marketplace; NaN = missing (not covered), 0 = real zero. */
type Series = Map<string, Float64Array>;

interface Ctx {
  start: string; // day 0
  n: number; // number of days; day n-1 is asOf
  asOf: string;
}

function windowRate(series: Series, a: number, b: number, mkts: Iterable<string>): { rate: number | null; covered: number } {
  a = Math.max(0, a);
  if (b < a) return { rate: null, covered: 0 };
  let rate = 0, any = false, coveredMax = 0;
  for (const m of mkts) {
    const arr = series.get(m);
    if (!arr) continue;
    let sum = 0, cov = 0;
    for (let i = a; i <= b; i++) if (!Number.isNaN(arr[i])) { sum += arr[i]; cov++; }
    if (cov) { rate += sum / cov; any = true; coveredMax = Math.max(coveredMax, cov); }
  }
  return { rate: any ? rate : null, covered: coveredMax };
}

/** The like-for-like marketplace set: each must have at least `minDays[k]` covered days in window k.
 *  Rates are always summed per marketplace over that marketplace's own covered days, so a
 *  marketplace whose data starts mid-history (Meesho from July) contributes its real rate to both
 *  sides instead of looking like a growth spurt; one with too little coverage on either side is
 *  left out of the comparison entirely. */
function comparableMarkets(series: Series, windows: [number, number][], minDays: number[]): { use: string[]; excluded: string[] } {
  const use: string[] = [], excluded: string[] = [];
  for (const [m, arr] of series) {
    const ok = windows.every(([a, b], k) => {
      a = Math.max(0, a);
      if (b < a) return false;
      let cov = 0;
      for (let i = a; i <= b; i++) if (!Number.isNaN(arr[i])) cov++;
      return cov >= minDays[k];
    });
    (ok ? use : excluded).push(m);
  }
  return { use, excluded };
}

function totalSeries(series: Series, n: number): Float64Array {
  const t = new Float64Array(n).fill(NaN);
  for (const arr of series.values()) for (let i = 0; i < n; i++) if (!Number.isNaN(arr[i])) t[i] = (Number.isNaN(t[i]) ? 0 : t[i]) + arr[i];
  return t;
}

function weeklySeries(total: Float64Array, ctx: Ctx, series: Series): WeekPoint[] {
  // Monday-aligned calendar weeks
  const out: WeekPoint[] = [];
  const dow = (new Date(toTime(ctx.start)).getUTCDay() + 6) % 7; // 0 = Monday
  let i = -dow;
  while (i < ctx.n) {
    let units = 0, cov = 0, partial = false;
    for (let k = i; k < i + 7; k++) {
      if (k < 0 || k >= ctx.n) { partial = true; continue; }
      if (!Number.isNaN(total[k])) { units += total[k]; cov++; }
      for (const arr of series.values()) if (Number.isNaN(arr[k])) partial = true;
    }
    out.push({ weekStart: addDays(ctx.start, i), units, coveredDays: cov, partial: partial || cov < 7 });
    i += 7;
  }
  return out;
}

function monthlySeries(total: Float64Array, ctx: Ctx): MonthPoint[] {
  const map = new Map<string, { units: number; cov: number }>();
  for (let i = 0; i < ctx.n; i++) {
    const m = monthOf(addDays(ctx.start, i));
    const e = map.get(m) ?? { units: 0, cov: 0 };
    if (!Number.isNaN(total[i])) { e.units += total[i]; e.cov++; }
    map.set(m, e);
  }
  return [...map].map(([month, e]) => {
    const dim = daysInMonth(month);
    return { month, units: e.units, coveredDays: e.cov, daysInMonth: dim, rate: e.cov ? e.units / e.cov : null, complete: e.cov >= dim * 0.95 };
  });
}

// ── Metrics ─────────────────────────────────────────────────────────────────────────────────────

export function computeMetrics(series: Series, ctx: Ctx): { metrics: Metrics; total: Float64Array; weekly: WeekPoint[]; monthly: MonthPoint[] } {
  const T = ctx.n - 1;
  const R = RULES.recentDays;
  const total = totalSeries(series, ctx.n);
  const vals: number[] = [];
  let peakQty: number | null = null, peakIdx = -1;
  for (let i = 0; i < ctx.n; i++) {
    if (Number.isNaN(total[i])) continue;
    vals.push(total[i]);
    if (peakQty === null || total[i] > peakQty) { peakQty = total[i]; peakIdx = i; }
  }
  const totalUnits = vals.reduce((a, b) => a + b, 0);
  const weekly = weeklySeries(total, ctx, series);
  const monthly = monthlySeries(total, ctx);

  const recentW: [number, number] = [T - R + 1, T];
  const baseW: [number, number] = [0, T - R];
  const prevW: [number, number] = [T - 2 * R + 1, T - R];

  const minBaseDays = RULES.minBaselineWeeks * 7;
  const br = comparableMarkets(series, [baseW, recentW], [minBaseDays, R / 2]);
  const baselineMean = windowRate(series, ...baseW, br.use).rate;
  // Per marketplace: complete 7-day blocks of the baseline period (counted back from the start of
  // the recent window, ≥ 6 covered days each); the product baseline is the sum over marketplaces.
  let medianSum = 0, weeksMin = Infinity, medianUsable = br.use.length > 0;
  for (const mk of br.use) {
    const rates: number[] = [];
    for (let e = T - R; e - 6 >= 0; e -= 7) {
      const w = windowRate(series, e - 6, e, [mk]);
      if (w.rate !== null && w.covered >= 6) rates.push(w.rate);
    }
    weeksMin = Math.min(weeksMin, rates.length);
    const md = median(rates);
    if (md === null || rates.length < 6) medianUsable = false; else medianSum += md;
  }
  const baselineWeeks = br.use.length ? weeksMin : 0;
  const baselineMedianWeekly = medianUsable ? medianSum : null;
  // Median of weekly rates resists a one-off historical spike; it falls back to the mean when there
  // are too few weeks for a median to mean anything, or when an intermittent seller's median week is 0.
  let baseline: number | null, baselineMethod: string;
  if (baselineMedianWeekly !== null && baselineMedianWeekly > 0) {
    baseline = baselineMedianWeekly; baselineMethod = `median of weekly averages, ≥ ${baselineWeeks} weeks per marketplace`;
  } else {
    baseline = baselineMean; baselineMethod = baselineWeeks ? `mean of ${baselineWeeks}+ week(s) before the recent window` : "no baseline period";
  }

  const recentAvg = windowRate(series, ...recentW, br.use).rate;
  const allRecent = windowRate(series, ...recentW, series.keys()).rate;
  const currentW = windowRate(series, T - RULES.currentDays + 1, T, br.use.length ? br.use : series.keys());
  const pr = comparableMarkets(series, [prevW, recentW], [R / 2, R / 2]);
  const prevAvg = windowRate(series, ...prevW, pr.use).rate;
  const recentForPrev = windowRate(series, ...recentW, pr.use).rate;

  const recentWeeks: { start: string; rate: number | null }[] = [];
  let weeksUp = 0, weeksDown = 0;
  for (let k = 3; k >= 0; k--) {
    const e = T - k * 7;
    const w = windowRate(series, e - 6, e, br.use);
    recentWeeks.push({ start: addDays(ctx.start, Math.max(0, e - 6)), rate: w.rate });
    if (baseline !== null && w.rate !== null) {
      if (w.rate >= baseline * RULES.weekUpFactor && w.rate > baseline) weeksUp++;
      if (w.rate <= baseline * RULES.weekDownFactor && w.rate < baseline) weeksDown++;
    }
  }

  // Same calendar month in earlier years (needs data from a previous year).
  const curMonth = ctx.asOf.slice(5, 7), curYear = ctx.asOf.slice(0, 4);
  const sameMonth = monthly.filter((m) => m.month.slice(5, 7) === curMonth && m.month.slice(0, 4) < curYear && m.rate !== null && m.coveredDays >= m.daysInMonth * RULES.minMonthCoverage);
  const sameMonthHistAvg = sameMonth.length ? sameMonth.reduce((a, m) => a + (m.rate as number), 0) / sameMonth.length : null;

  const rankable = monthly.filter((m) => m.rate !== null && m.coveredDays >= m.daysInMonth * RULES.minMonthCoverage);
  const peakMonth = rankable.length ? rankable.reduce((a, b) => ((b.rate as number) > (a.rate as number) ? b : a)).month : null;
  const fullWeeks = weekly.filter((w) => w.coveredDays >= 6);
  const wr = (w: WeekPoint) => w.units / w.coveredDays;
  const peakWeek = fullWeeks.length ? fullWeeks.reduce((a, b) => (wr(b) > wr(a) ? b : a)) : null;

  const dailyMean = vals.length ? totalUnits / vals.length : null;
  const growthPct = pctChange(recentAvg, baseline);

  // Start of the current run: walk back week by week while the week stays on the same side.
  let changeStart: string | null = null, changeDurationDays: number | null = null;
  if (baseline !== null && growthPct !== null && Math.abs(growthPct) >= RULES.growthPct) {
    const up = growthPct > 0;
    let first = -1;
    for (let e = T; e - 6 >= 0; e -= 7) {
      const w = windowRate(series, e - 6, e, br.use).rate;
      if (w === null) break;
      const on = up ? w >= baseline * RULES.weekUpFactor : w <= baseline * RULES.weekDownFactor;
      if (!on) break;
      first = e - 6;
    }
    if (first >= 0) {
      // refine to the first day inside that week that is already on the changed side
      for (let i = first; i <= Math.min(first + 6, T); i++) {
        const v = total[i];
        if (!Number.isNaN(v) && (up ? v >= baseline * RULES.weekUpFactor : v <= baseline * RULES.weekDownFactor)) { first = i; break; }
      }
      changeStart = addDays(ctx.start, first);
      changeDurationDays = T - first + 1;
    }
  }

  return {
    total, weekly, monthly,
    metrics: {
      coveredDays: vals.length,
      totalUnits,
      dailyMean,
      dailyMedian: median(vals),
      dailyMin: vals.length ? Math.min(...vals) : null,
      dailyMax: vals.length ? Math.max(...vals) : null,
      peakQty,
      peakDate: peakIdx >= 0 ? addDays(ctx.start, peakIdx) : null,
      peakMonth,
      peakWeekStart: peakWeek?.weekStart ?? null,
      peakWeekUnits: peakWeek?.units ?? null,
      peakWeekRate: peakWeek ? wr(peakWeek) : null,
      baselineMean,
      baselineMedianWeekly,
      baseline,
      baselineMethod,
      baselineWeeks,
      recentAvg: recentAvg ?? allRecent,
      currentAvg: currentW.rate,
      currentUnits: currentW.rate === null ? null : Math.round(currentW.rate * RULES.currentDays),
      prevAvg,
      sameMonthHistAvg,
      growthPct,
      changeVsMeanPct: pctChange(recentAvg, baselineMean),
      changeVsPrevPct: pctChange(recentForPrev, prevAvg),
      peakVsAvgPct: pctChange(peakQty, dailyMean),
      currentVsPeakPct: currentW.rate !== null && peakQty ? (currentW.rate / peakQty) * 100 : null,
      recentWeeks,
      weeksUp,
      weeksDown,
      changeStart,
      changeDurationDays,
      excludedMarketplaces: br.excluded,
    },
  };
}

// ── Seasonality ─────────────────────────────────────────────────────────────────────────────────

export function detectSeasonality(monthly: MonthPoint[]): Seasonality {
  const usable = monthly.filter((m) => m.rate !== null && m.coveredDays >= m.daysInMonth * RULES.minMonthCoverage);
  const years = [...new Set(usable.map((m) => m.month.slice(0, 4)))];
  const observedPeak = usable.length ? usable.reduce((a, b) => ((b.rate as number) > (a.rate as number) ? b : a)) : null;
  const observedLow = usable.length ? usable.reduce((a, b) => ((b.rate as number) < (a.rate as number) ? b : a)) : null;

  // index of each month vs its own year's average month (years with ≥ 3 usable months)
  const idx = new Map<number, { year: string; index: number }[]>();
  for (const y of years) {
    const ms = usable.filter((m) => m.month.startsWith(y));
    if (ms.length < 3) continue;
    const avg = ms.reduce((a, m) => a + (m.rate as number), 0) / ms.length;
    if (avg <= 0) continue;
    for (const m of ms) {
      const mo = Number(m.month.slice(5, 7));
      const list = idx.get(mo) ?? [];
      list.push({ year: y, index: (m.rate as number) / avg });
      idx.set(mo, list);
    }
  }
  const repeated = [...idx].filter(([, l]) => l.length >= RULES.minSeasonYears);
  const recurringHigh = repeated.filter(([, l]) => l.every((x) => x.index >= RULES.seasonalHighIndex)).map(([m]) => m).sort((a, b) => a - b);
  const recurringLow = repeated.filter(([, l]) => l.every((x) => x.index <= RULES.seasonalLowIndex)).map(([m]) => m).sort((a, b) => a - b);
  const determinable = repeated.length > 0;
  const evidence: string[] = [];
  for (const m of [...recurringHigh, ...recurringLow]) {
    const l = idx.get(m)!;
    evidence.push(`${monthName(m)}: ${l.map((x) => `${x.year} ${x.index.toFixed(2)}× the year's average month`).join("; ")}`);
  }
  const maxYears = Math.max(0, ...[...idx.values()].map((l) => l.length));
  const confidence: Confidence = !determinable || (!recurringHigh.length && !recurringLow.length) ? "LOW" : maxYears >= 3 ? "HIGH" : "MEDIUM";
  let label: string;
  if (!determinable) {
    label = `Not determinable — ${usable.length} usable month(s) in ${years.length} year(s); no calendar month repeats yet`;
  } else if (recurringHigh.length || recurringLow.length) {
    label = `Seasonal${recurringHigh.length ? ` · high ${recurringHigh.map(monthName).join(", ")}` : ""}${recurringLow.length ? ` · low ${recurringLow.map(monthName).join(", ")}` : ""}`;
  } else {
    label = `No recurring pattern across ${maxYears} year(s)`;
  }
  return {
    determinable, yearsObserved: years.length, recurringHigh, recurringLow, label, evidence, confidence,
    observedPeakMonth: observedPeak?.month ?? null,
    observedLowMonth: observedLow && observedLow !== observedPeak ? observedLow.month : null,
  };
}

// ── Classification, reasons, recommendations ────────────────────────────────────────────────────

export interface ReasonInputs {
  stockNow?: number | null; // master product's current stock (forecast view snapshot)
  stockDaily?: Map<string, number>; // date -> closing stock (inventory_daily_stock), master level
  adDaily?: Map<string, number>; // date -> ad spend summed over the entity's SKUs
  adCoverage?: { first: string; last: string } | null; // range the ad feeds cover at all
  attribution?: string[]; // "where the change comes from" lines (master only)
}

function confidenceFor(m: Metrics, consistentWeeks: number): Confidence {
  let s = 0;
  if (m.baselineWeeks >= 12) s += 2; else if (m.baselineWeeks >= 8) s += 1;
  if (consistentWeeks >= 4) s += 2; else if (consistentWeeks >= 3) s += 1;
  if (m.growthPct !== null && Math.abs(m.growthPct) >= 75) s += 1;
  if ((m.baseline ?? 0) * 7 >= 7) s += 1;
  return s >= 5 ? "HIGH" : s >= 3 ? "MEDIUM" : "LOW";
}

export function classify(m: Metrics, monthly: MonthPoint[], asOf: string, inputs: ReasonInputs = {}): Analysis {
  const seasonality = detectSeasonality(monthly);
  const base = m.baseline, recent = m.recentAvg, cur = m.currentAvg;
  const evidence: string[] = [];
  const num = (label: string, v: number | null) => `${label} = ${fmt(v)} units/day`;

  evidence.push(num("Historical baseline", base) + ` (${m.baselineMethod})`);
  evidence.push(num("Historical mean", m.baselineMean));
  evidence.push(num("Recent 4-week average", recent));
  evidence.push(num("Last 7 days", cur));
  if (m.excludedMarketplaces.length) evidence.push(`Like-for-like: ${m.excludedMarketplaces.join(", ")} excluded from comparisons (no data in both periods)`);

  let status: Status, pattern: string | null = null, statusReason: string;
  const delta28 = base !== null && recent !== null ? Math.abs(recent - base) * RULES.recentDays : 0;
  const delta7 = base !== null && cur !== null ? Math.abs(cur - base) * RULES.currentDays : 0;
  const lowVolume = Math.max(base ?? 0, recent ?? 0) * 7 < RULES.minUnitsPerWeek;

  if (base === null || m.baselineWeeks < RULES.minBaselineWeeks) {
    status = "INSUFFICIENT DATA";
    statusReason = `Only ${m.baselineWeeks} complete week(s) of history before the recent 4-week window (need ≥ ${RULES.minBaselineWeeks}).`;
  } else if (lowVolume) {
    status = "LOW VOLUME";
    statusReason = `Sells under ${RULES.minUnitsPerWeek} units/week in both periods — percentage changes would be noise.`;
  } else if (m.growthPct !== null && m.growthPct >= RULES.growthPct && delta28 >= RULES.minAbsChange28d) {
    const sustained = m.weeksUp >= RULES.sustainedWeeks;
    status = sustained ? "HIGH GROWTH" : "UNUSUAL SPIKE";
    pattern = sustained ? "Sustained" : "Short-term";
    statusReason = `Recent 4-week average is ${Math.round(m.growthPct)}% above the historical baseline; ${m.weeksUp} of the last 4 weeks were ≥ ${RULES.weekUpFactor}× baseline.`;
  } else if (m.growthPct !== null && m.growthPct <= -RULES.growthPct && delta28 >= RULES.minAbsChange28d) {
    const sustained = m.weeksDown >= RULES.sustainedWeeks;
    status = sustained ? "DEMAND DROP" : "UNUSUAL DECLINE";
    pattern = sustained ? "Sustained" : "Temporary";
    statusReason = `Recent 4-week average is ${Math.abs(Math.round(m.growthPct))}% below the historical baseline; ${m.weeksDown} of the last 4 weeks were ≤ ${RULES.weekDownFactor}× baseline.`;
  } else if (cur !== null && base > 0 && ((cur - base) / base) * 100 >= RULES.currentSpikePct && delta7 >= 4) {
    status = "UNUSUAL SPIKE"; pattern = "Short-term";
    statusReason = `Last 7 days are ${Math.round(((cur - base) / base) * 100)}% above baseline while the 4-week average has not moved significantly.`;
  } else if (cur !== null && base > 0 && ((cur - base) / base) * 100 <= -RULES.currentDropPct && delta7 >= 4) {
    status = "UNUSUAL DECLINE"; pattern = "Temporary";
    statusReason = `Last 7 days are ${Math.abs(Math.round(((cur - base) / base) * 100))}% below baseline while the 4-week average has not moved significantly.`;
  } else {
    status = "STABLE";
    statusReason = `Recent 4-week average is within ±${RULES.growthPct}% of the historical baseline (${pct(m.growthPct)}).`;
  }
  if (m.changeStart) evidence.push(`Change began ${m.changeStart} (${m.changeDurationDays} day(s) ago, inclusive)`);
  if (m.peakQty !== null) evidence.push(`Historical peak = ${fmt(m.peakQty, 0)} units on ${m.peakDate}`);

  // Seasonal overlay — only with repeated evidence (≥ 2 years of the same month).
  const month = Number(asOf.slice(5, 7));
  const next1 = (month % 12) + 1, next2 = (next1 % 12) + 1;
  let seasonalCause = false;
  if (seasonality.recurringHigh.includes(month) && ["HIGH GROWTH", "UNUSUAL SPIKE", "STABLE"].includes(status) && (recent ?? 0) > (base ?? 0)) {
    status = "SEASONAL HIGH"; seasonalCause = true;
    statusReason = `${monthName(month)} is a recurring high-demand month and recent sales are above baseline (${pct(m.growthPct)}).`;
  } else if (seasonality.recurringLow.includes(month) && ["DEMAND DROP", "UNUSUAL DECLINE", "STABLE"].includes(status) && (recent ?? 0) < (base ?? 0)) {
    status = "SEASONAL LOW"; seasonalCause = true;
    statusReason = `Current decline matches historically weak ${monthName(month)} demand (${pct(m.growthPct)} vs baseline).`;
  }
  const peakApproaching = !seasonality.recurringHigh.includes(month) && (seasonality.recurringHigh.includes(next1) || seasonality.recurringHigh.includes(next2));
  if (peakApproaching) {
    const pm = seasonality.recurringHigh.includes(next1) ? next1 : next2;
    evidence.push(`Peak approaching: ${monthName(pm)} has been a high-demand month in every observed year — a historical pattern, not a forecast`);
  }
  evidence.push(`Seasonality: ${seasonality.label}`);
  evidence.push(...seasonality.evidence);
  if (!seasonality.determinable && seasonality.observedPeakMonth) {
    evidence.push(`Observed peak month in available data: ${monthLabel(seasonality.observedPeakMonth)} (single occurrence — not confirmed as seasonal)`);
  }

  // ── Likely reason: only what a data source covering the period supports ──
  const reasons: string[] = [];
  const up = status === "HIGH GROWTH" || status === "UNUSUAL SPIKE" || status === "SEASONAL HIGH";
  const down = status === "DEMAND DROP" || status === "UNUSUAL DECLINE" || status === "SEASONAL LOW";
  let reasonConf: Confidence | null = null;

  if (seasonalCause) {
    reasons.push(status === "SEASONAL HIGH" ? "Likely seasonal demand pattern." : "Consistent with historical seasonal demand.");
    reasonConf = seasonality.confidence;
  }

  const windowStart = m.changeStart ?? addDays(asOf, -(RULES.recentDays - 1));
  // Inventory (history): daily closing stock across the change window.
  if ((up || down) && inputs.stockDaily && inputs.stockDaily.size) {
    const days: number[] = [];
    for (let d = windowStart; d <= asOf; d = addDays(d, 1)) { const v = inputs.stockDaily.get(d); if (v !== undefined) days.push(v); }
    if (days.length >= 7) {
      const out = days.filter((v) => v <= 0).length;
      if (down && out / days.length >= 0.5) {
        reasons.push("Sales may be constrained by low inventory availability.");
        evidence.push(`Stock history: closing stock ≤ 0 on ${out} of ${days.length} recorded days since ${windowStart}`);
        reasonConf = reasonConf ?? (days.length >= 14 ? "HIGH" : "MEDIUM");
      }
      if (up) {
        const before: number[] = [];
        for (let d = addDays(windowStart, -21); d < windowStart; d = addDays(d, 1)) { const v = inputs.stockDaily.get(d); if (v !== undefined) before.push(v); }
        const outBefore = before.filter((v) => v <= 0).length;
        if (before.length >= 7 && outBefore >= 3 && days.every((v) => v > 0)) {
          reasons.push("Sales recovery coincides with improved stock availability.");
          evidence.push(`Stock history: out of stock on ${outBefore} of ${before.length} days before ${windowStart}, in stock on all ${days.length} recorded days since`);
          reasonConf = reasonConf ?? "MEDIUM";
        }
      }
    } else {
      evidence.push(`Stock history: daily stock not recorded for this period (inventory_daily_stock covers other dates)`);
    }
  }
  // Inventory (present): current stock snapshot from the forecast view.
  if (down && inputs.stockNow !== undefined && inputs.stockNow !== null && !reasons.some((r) => r.includes("inventory"))) {
    const cover = base && base > 0 ? inputs.stockNow / base : null;
    if (inputs.stockNow <= 0 || (cover !== null && cover < RULES.lowStockCoverDays)) {
      reasons.push("Sales may be constrained by low inventory availability.");
      evidence.push(`Current Stock = ${fmt(inputs.stockNow, 0)} (product_forecast_summary_live_v)${cover !== null ? ` ≈ ${fmt(cover)} days of baseline demand` : ""} — current snapshot, stock history for the decline period not available`);
      reasonConf = reasonConf ?? "LOW";
    }
  }
  // Advertising: needs daily ad spend covering both the baseline and the recent window.
  if ((up || down) && inputs.adCoverage) {
    const recentStart = addDays(asOf, -(RULES.recentDays - 1));
    if (inputs.adCoverage.last >= asOf && inputs.adCoverage.first <= addDays(recentStart, -RULES.recentDays)) {
      const sum = (a: string, b: string) => { let s = 0; for (let d = a; d <= b; d = addDays(d, 1)) s += inputs.adDaily?.get(d) ?? 0; return s; };
      const recentSpend = sum(recentStart, asOf) / RULES.recentDays;
      const prevSpend = sum(addDays(recentStart, -RULES.recentDays), addDays(recentStart, -1)) / RULES.recentDays;
      const ch = pctChange(recentSpend, prevSpend);
      if (ch !== null && Math.abs(ch) >= RULES.adChangePct && (ch > 0) === up) {
        reasons.push(`Sales movement coincides with ${up ? "increased" : "decreased"} advertising activity.`);
        evidence.push(`Ad spend: ₹${fmt(prevSpend, 0)}/day → ₹${fmt(recentSpend, 0)}/day (${pct(ch)}) over the same periods`);
        reasonConf = reasonConf ?? "MEDIUM";
      } else {
        evidence.push(`Ad spend changed ${pct(ch)} over the same periods — no matching movement`);
      }
    } else {
      evidence.push(`Advertising: daily ad spend only available ${inputs.adCoverage.first} → ${inputs.adCoverage.last}; cannot test the recent period`);
    }
  }
  if ((up || down) && inputs.attribution?.length) evidence.push(...inputs.attribution);

  if (!reasons.length) {
    if (status === "HIGH GROWTH") reasons.push("Sustained demand growth (no seasonal, stock or advertising driver found in available data).");
    else if (status === "UNUSUAL SPIKE") reasons.push("Short-term sales spike — cause not confirmed from available data.");
    else if (status === "DEMAND DROP") reasons.push("Sustained demand decline — cause not confirmed from available data.");
    else if (status === "STABLE") reasons.push("No significant change.");
    else if (status === "LOW VOLUME" || status === "INSUFFICIENT DATA") reasons.push("Not assessed — see status.");
    else reasons.push("Cause not confirmed from available data.");
  }

  const consistent = up ? m.weeksUp : down ? m.weeksDown : 4 - Math.max(m.weeksUp, m.weeksDown);
  let confidence: Confidence = status === "INSUFFICIENT DATA" || status === "LOW VOLUME" ? "LOW" : confidenceFor(m, consistent);
  if ((status === "SEASONAL HIGH" || status === "SEASONAL LOW") && seasonality.confidence !== "HIGH") confidence = seasonality.confidence;
  if (reasonConf === "LOW" && confidence === "HIGH") confidence = "MEDIUM";

  return {
    status, pattern, peakApproaching, statusReason,
    likelyReason: [...new Set(reasons)].join(" "),
    evidence, confidence,
    recommendation: recommend(status, peakApproaching, m, inputs.stockNow ?? null, seasonality),
    seasonality,
  };
}

function recommend(status: Status, peakApproaching: boolean, m: Metrics, stockNow: number | null, s: Seasonality): string {
  const cover = stockNow !== null && m.recentAvg ? stockNow / m.recentAvg : null;
  const stockLine = stockNow !== null ? ` Current stock ${fmt(stockNow, 0)} units${cover !== null ? ` ≈ ${fmt(cover, 0)} days at the recent rate` : ""}.` : "";
  const peak = peakApproaching ? ` Historical sales repeatedly peak in ${s.recurringHigh.map(monthName).join("/")}. Monitor stock and demand closely.` : "";
  switch (status) {
    case "HIGH GROWTH": return `Sales are significantly above the historical baseline. Review stock availability and advertising capacity.${stockLine}${peak}`;
    case "UNUSUAL SPIKE": return `Sales are significantly above normal but there is insufficient historical recurrence to classify this as seasonal. Confirm the spike is genuine before committing stock.${stockLine}${peak}`;
    case "DEMAND DROP": return `Recent sales are significantly below historical baseline. Investigate inventory, advertising and demand conditions.${stockLine}${peak}`;
    case "UNUSUAL DECLINE": return `Sales are significantly below normal and require investigation.${stockLine}${peak}`;
    case "SEASONAL HIGH": return `Historical data shows recurring high demand during this period. Prepare inventory accordingly.${stockLine}`;
    case "SEASONAL LOW": return `Decline matches a recurring seasonal low. Avoid over-stocking; review again when the season turns.${peak}`;
    case "STABLE": return peakApproaching ? `Historical sales repeatedly peak during this upcoming period. Monitor stock and demand closely.${stockLine}` : `Sales are in line with the historical baseline. No action indicated.`;
    case "LOW VOLUME": return `Volume too low for reliable trend signals. Review manually if strategically important.`;
    default: return `Not enough history to classify. Re-check once more weeks of data are available.`;
  }
}

// ── Orchestration ───────────────────────────────────────────────────────────────────────────────

export function analyze(payload: SeasonalPayload, opts: AnalysisOptions = {}): SeasonalResult {
  const allMkts = payload.coverage.map((c) => c.marketplace);
  const mkts = (opts.marketplaces?.length ? opts.marketplaces : allMkts).filter((m) => allMkts.includes(m));
  const cov = payload.coverage.filter((c) => mkts.includes(c.marketplace));
  if (!cov.length) throw new Error("No sales data for the selected marketplaces.");
  const dataStart = cov.map((c) => c.first_date).sort()[0];
  const dataEnd = cov.map((c) => c.last_date).sort().at(-1) as string;
  const start = opts.from && opts.from > dataStart ? opts.from : dataStart;
  const asOf = opts.to && opts.to < dataEnd ? opts.to : dataEnd;
  if (asOf < start) throw new Error("Selected date range has no data.");
  const n = daysBetween(start, asOf) + 1;
  const ctx: Ctx = { start, n, asOf };
  const coverage = buildCoverage(payload, start, n);

  // SKU series
  const skuSeries = new Map<number, Float64Array>();
  payload.skus.forEach(([mk], i) => {
    if (!mkts.includes(mk)) return;
    const c = coverage.get(mk);
    const arr = new Float64Array(n);
    for (let d = 0; d < n; d++) arr[d] = c?.covered[d] ? 0 : NaN;
    skuSeries.set(i, arr);
  });
  for (const [i, d, u] of payload.daily) {
    const arr = skuSeries.get(i);
    if (!arr) continue;
    const k = daysBetween(start, d);
    if (k < 0 || k >= n) continue;
    // a sale on an uncovered day still happened — count it (the day is then known, not missing)
    arr[k] = (Number.isNaN(arr[k]) ? 0 : arr[k]) + Number(u);
  }

  // side inputs
  const stockNow = new Map(payload.stock_now.map(([p, s]) => [p, s === null ? null : Number(s)]));
  const stockDaily = new Map<string, Map<string, number>>();
  for (const [p, d, v] of payload.stock_daily) {
    const m = stockDaily.get(p) ?? new Map<string, number>();
    m.set(d, Number(v)); stockDaily.set(p, m);
  }
  const adBySku = new Map<string, Map<string, number>>();
  const adRange = new Map<string, { first: string; last: string }>();
  for (const [mk, sku, d, v] of payload.ad_daily) {
    const key = `${mk}|${sku}`;
    const m = adBySku.get(key) ?? new Map<string, number>();
    m.set(d, (m.get(d) ?? 0) + Number(v)); adBySku.set(key, m);
    const r = adRange.get(mk);
    adRange.set(mk, { first: !r || d < r.first ? d : r.first, last: !r || d > r.last ? d : r.last });
  }

  const skus: SkuResult[] = [];
  const unmapped: SkuResult[] = [];
  const skuByIdx = new Map<number, SkuResult>();
  const byMaster = new Map<string, number[]>();
  payload.skus.forEach(([mk, sku, product, mapped], i) => {
    const arr = skuSeries.get(i);
    if (!arr) return;
    const series: Series = new Map([[mk, arr]]);
    const { metrics, weekly, monthly } = computeMetrics(series, ctx);
    const master = mapped && product ? product : null;
    const analysis = classify(metrics, monthly, asOf, {
      stockNow: null,
      adDaily: adBySku.get(`${mk}|${sku}`),
      adCoverage: adRange.get(mk) ?? null,
    });
    const r: SkuResult = { key: `${mk}|${sku}`, marketplace: mk, sku, master, metrics, analysis, weekly, monthly };
    skuByIdx.set(i, r);
    if (master) {
      skus.push(r);
      const list = byMaster.get(master) ?? [];
      list.push(i); byMaster.set(master, list);
    } else unmapped.push(r);
  });

  const masters: MasterResult[] = [];
  for (const [master, idxs] of byMaster) {
    const series: Series = new Map();
    for (const i of idxs) {
      const mk = payload.skus[i][0];
      const src = skuSeries.get(i)!;
      const cur = series.get(mk);
      if (!cur) { series.set(mk, Float64Array.from(src)); continue; }
      for (let d = 0; d < n; d++) {
        if (Number.isNaN(src[d])) continue;
        cur[d] = (Number.isNaN(cur[d]) ? 0 : cur[d]) + src[d];
      }
    }
    const { metrics, weekly, monthly } = computeMetrics(series, ctx);
    const rs = idxs.map((i) => skuByIdx.get(i)!);

    // Which SKUs drive the change (recent vs that SKU's own baseline)
    const deltas = rs.map((r) => ({ key: r.key, deltaPerDay: (r.metrics.recentAvg ?? 0) - (r.metrics.baseline ?? r.metrics.baselineMean ?? 0) }));
    const totalDelta = deltas.reduce((a, d) => a + d.deltaPerDay, 0);
    // Share of the movement in the master's direction only, so SKUs moving the other way cannot push
    // a share past 100%.
    const sameDirTotal = deltas.filter((d) => Math.sign(d.deltaPerDay) === Math.sign(totalDelta)).reduce((a, d) => a + d.deltaPerDay, 0);
    const contributions = deltas
      .map((d) => ({ ...d, sharePct: sameDirTotal !== 0 && Math.sign(d.deltaPerDay) === Math.sign(totalDelta) ? (d.deltaPerDay / sameDirTotal) * 100 : null }))
      .sort((a, b) => Math.abs(b.deltaPerDay) - Math.abs(a.deltaPerDay));
    const peakIdx = metrics.peakDate ? daysBetween(start, metrics.peakDate) : -1;
    const peakContributors = peakIdx >= 0
      ? idxs.map((i) => ({ key: `${payload.skus[i][0]}|${payload.skus[i][1]}`, units: skuSeries.get(i)![peakIdx] })).filter((x) => x.units > 0).sort((a, b) => b.units - a.units)
      : [];

    const attribution: string[] = [];
    if (rs.length > 1 && totalDelta !== 0 && Math.abs(totalDelta) * RULES.recentDays >= RULES.minAbsChange28d) {
      const top = contributions.find((c) => c.sharePct !== null);
      if (top) attribution.push(`Change concentration: ${top.key.replace("|", " · ")} accounts for ${Math.round(top.sharePct!)}% of the SKU-level ${totalDelta > 0 ? "increase" : "decrease"} (${fmt(top.deltaPerDay)} units/day vs its own baseline)`);
      const sameDir = contributions.filter((c) => Math.sign(c.deltaPerDay) === Math.sign(totalDelta) && Math.abs(c.deltaPerDay) * RULES.recentDays >= 1).length;
      attribution.push(`${sameDir} of ${rs.length} SKUs moved in the same direction — ${sameDir === rs.length ? "change is across all SKUs" : sameDir === 1 ? "change is driven by one SKU" : "change is partial"}`);
    }

    const adDaily = new Map<string, number>();
    // ad coverage = the range every marketplace of this product has ad data for (intersection)
    const ranges: { first: string; last: string }[] = [];
    for (const r of rs) {
      for (const [d, v] of adBySku.get(r.key) ?? []) adDaily.set(d, (adDaily.get(d) ?? 0) + v);
      const ar = adRange.get(r.marketplace);
      if (ar) ranges.push(ar);
    }
    const adCoverage = ranges.length
      ? { first: ranges.map((x) => x.first).sort().at(-1) as string, last: ranges.map((x) => x.last).sort()[0] }
      : null;

    const analysis = classify(metrics, monthly, asOf, {
      stockNow: stockNow.get(master) ?? null,
      stockDaily: stockDaily.get(master),
      adDaily, adCoverage, attribution,
    });
    masters.push({
      master,
      skuKeys: rs.map((r) => r.key),
      skuIds: [...new Set(rs.map((r) => r.sku))],
      marketplaces: [...new Set(rs.map((r) => r.marketplace))],
      currentStock: stockNow.get(master) ?? null,
      metrics, analysis, weekly, monthly, contributions, peakContributors,
    });
  }
  masters.sort((a, b) => b.metrics.totalUnits - a.metrics.totalUnits);

  // ── data quality ──
  const qByMkt = new Map(payload.quality.map((q) => [q.marketplace, q]));
  const allMonths = monthlySeries(new Float64Array(n).fill(0), ctx);
  const stockDates = payload.stock_daily.map((r) => r[1]).sort();
  const adDates = payload.ad_daily.map((r) => r[2]).sort();
  const warnings: string[] = [];
  const totalMonths = Math.round((n / 30.44) * 10) / 10;
  if (n < 182) warnings.push(`Only ${n} days (${totalMonths} months) of history — below the 6-month target; baselines use all available history.`);
  const distinctYearsPerMonth = new Set(allMonths.map((m) => m.month.slice(5, 7))).size === allMonths.length;
  if (distinctYearsPerMonth) warnings.push("No calendar month appears in more than one year, so seasonality cannot be confirmed by recurrence yet. Seasonal/Peak-approaching flags stay off until it can.");
  for (const c of cov) if (c.first_date > start) warnings.push(`${c.marketplace} data starts ${c.first_date}; earlier days are MISSING (not zero) and it is excluded from like-for-like comparisons where it lacks coverage.`);
  for (const q of payload.quality) if (mkts.includes(q.marketplace) && q.unparseable_dates > 0) warnings.push(`${q.marketplace}: ${q.unparseable_dates.toLocaleString("en-IN")} order rows have a date that cannot be parsed (e.g. no year) and are excluded here and in product_forecast_summary_live_v.`);

  return {
    asOf, from: start, marketplaces: mkts, generatedAt: payload.cache_refreshed_at ?? payload.generated_at ?? null,
    quality: {
      historicalStart: start,
      historicalEnd: asOf,
      totalDays: n,
      totalMonths,
      marketplaces: cov.map((c) => {
        const cv = coverage.get(c.marketplace)!;
        const q = qByMkt.get(c.marketplace);
        return {
          marketplace: c.marketplace, firstDate: c.first_date, lastDate: c.last_date, daysWithData: c.days_with_data,
          rangeDays: daysBetween(c.first_date, c.last_date) + 1, feed: cv.feed, missingDates: cv.missing,
          unparseableDates: q?.unparseable_dates ?? 0, missingQuantity: q?.missing_quantity ?? 0, duplicateRows: q?.duplicate_rows ?? 0,
        };
      }),
      coverageNote: `Daily feeds (rows on ≥ ${RULES.dailyFeedShare * 100}% of days) treat a day with no rows as missing; sparse feeds treat it as a genuine zero-sales day.`,
      viewRows: payload.view_quality?.rows ?? null,
      viewBlankSku: payload.view_quality?.blank_sku ?? null,
      viewUnknownProduct: payload.view_quality?.unknown_product ?? null,
      unmappedSkus: unmapped.map((u) => u.key),
      unmatchedOrders: payload.unmatched.filter((u) => mkts.includes(u.marketplace)),
      incompleteMonths: allMonths.filter((m) => m.coveredDays < m.daysInMonth).map((m) => m.month),
      stockHistory: stockDates.length ? `inventory_daily_stock: ${stockDates[0]} → ${stockDates.at(-1)}` : "No daily stock history",
      adHistory: adDates.length ? `Daily ad spend: ${adDates[0]} → ${adDates.at(-1)}` : "No daily ad spend history",
      warnings,
    },
    masters, skus, unmapped,
  };
}

/** Daily rows for one master product's drill-down chart (per SKU + total; missing days are null). */
export function masterDaily(payload: SeasonalPayload, res: SeasonalResult, m: MasterResult) {
  const n = daysBetween(res.from, res.asOf) + 1;
  const coverage = buildCoverage(payload, res.from, n);
  const keyIdx = new Map(payload.skus.map(([mk, sku], i) => [`${mk}|${sku}`, i]));
  const days = Array.from({ length: n }, (_, i) => addDays(res.from, i));
  const perSku: Record<string, (number | null)[]> = {};
  for (const key of m.skuKeys) {
    const mk = key.split("|")[0];
    const cv = coverage.get(mk);
    const arr: (number | null)[] = days.map((_, i) => (cv?.covered[i] ? 0 : null));
    perSku[key] = arr;
  }
  for (const [i, d, u] of payload.daily) {
    const key = `${payload.skus[i][0]}|${payload.skus[i][1]}`;
    if (!perSku[key] || keyIdx.get(key) !== i) continue;
    const k = daysBetween(res.from, d);
    if (k < 0 || k >= n) continue;
    perSku[key][k] = (perSku[key][k] ?? 0) + Number(u);
  }
  const total = days.map((_, i) => {
    let s: number | null = null;
    for (const key of m.skuKeys) { const v = perSku[key][i]; if (v !== null) s = (s ?? 0) + v; }
    return s;
  });
  return { days, total, perSku };
}

// ── Browser DTOs ────────────────────────────────────────────────────────────────────────────────
// The full SeasonalResult is ~5 MB (evidence for 800 SKUs). The list view only needs headline
// numbers plus compact weekly/monthly rate arrays on shared axes; full SKU evidence and daily
// series are sent only for the master product being drilled into.

const r2 = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

export interface SlimMetrics {
  current: number | null; currentUnits: number | null; recent: number | null; mean: number | null; median: number | null;
  baseline: number | null; peak: number | null; peakDate: string | null; peakMonth: string | null;
  peakWeekStart: string | null; peakWeekRate: number | null; // best Monday-week, as units/day
  growth: number | null; vsMean: number | null; vsPrev: number | null; vsPeak: number | null; peakVsAvg: number | null;
  changeStart: string | null; duration: number | null; totalUnits: number; coveredDays: number;
}
export interface ListEntity {
  status: Status; pattern: string | null; peakApproaching: boolean; confidence: Confidence;
  statusReason: string; likelyReason: string; seasonality: string; observedPeakMonth: string | null;
  m: SlimMetrics;
  w: (number | null)[]; // weekly units/day on weekAxis
  mo: (number | null)[]; // monthly units/day on monthAxis
}
export interface ListMaster extends ListEntity {
  master: string; skuIds: string[]; skuKeys: string[]; marketplaces: string[]; currentStock: number | null; evidence: string[]; recommendation: string;
  /** SKU with the largest share of the master's change (in the change's direction), and how many SKUs moved that way */
  driver: { key: string; sharePct: number; deltaPerDay: number } | null;
  movingSkus: number;
}
export interface ListSku extends ListEntity { key: string; marketplace: string; sku: string; master: string | null; recommendation: string }
export interface SeasonalListDto {
  asOf: string; from: string; marketplaces: string[]; availableMarketplaces: string[]; generatedAt: string | null;
  quality: DataQuality; weekAxis: string[]; monthAxis: string[];
  masters: ListMaster[]; skus: ListSku[]; unmapped: ListSku[];
}

function slim(m: Metrics): SlimMetrics {
  return {
    current: r2(m.currentAvg), currentUnits: m.currentUnits, recent: r2(m.recentAvg), mean: r2(m.dailyMean), median: r2(m.dailyMedian),
    baseline: r2(m.baseline), peak: m.peakQty, peakDate: m.peakDate, peakMonth: m.peakMonth,
    peakWeekStart: m.peakWeekStart, peakWeekRate: r2(m.peakWeekRate),
    growth: r2(m.growthPct), vsMean: r2(m.changeVsMeanPct), vsPrev: r2(m.changeVsPrevPct), vsPeak: r2(m.currentVsPeakPct), peakVsAvg: r2(m.peakVsAvgPct),
    changeStart: m.changeStart, duration: m.changeDurationDays, totalUnits: m.totalUnits, coveredDays: m.coveredDays,
  };
}
const weekRates = (w: WeekPoint[]) => w.map((p) => (p.coveredDays ? r2(p.units / p.coveredDays) : null));
const monthRates = (mo: MonthPoint[]) => mo.map((p) => r2(p.rate));
function entity(a: Analysis, m: Metrics, w: WeekPoint[], mo: MonthPoint[]): ListEntity {
  return {
    status: a.status, pattern: a.pattern, peakApproaching: a.peakApproaching, confidence: a.confidence,
    statusReason: a.statusReason, likelyReason: a.likelyReason, seasonality: a.seasonality.label, observedPeakMonth: a.seasonality.observedPeakMonth,
    m: slim(m), w: weekRates(w), mo: monthRates(mo),
  };
}

function driverOf(x: MasterResult): Pick<ListMaster, "driver" | "movingSkus"> {
  const total = x.contributions.reduce((a, c) => a + c.deltaPerDay, 0);
  const top = x.contributions.find((c) => c.sharePct !== null);
  return {
    driver: top && x.contributions.length > 1 ? { key: top.key, sharePct: Math.round(top.sharePct as number), deltaPerDay: r2(top.deltaPerDay) as number } : null,
    movingSkus: x.contributions.filter((c) => Math.sign(c.deltaPerDay) === Math.sign(total) && Math.abs(c.deltaPerDay) * RULES.recentDays >= 1).length,
  };
}

export function toListDto(r: SeasonalResult, availableMarketplaces: string[]): SeasonalListDto {
  const any = r.masters[0] ?? r.skus[0] ?? r.unmapped[0];
  const sku = (s: SkuResult): ListSku => ({ ...entity(s.analysis, s.metrics, s.weekly, s.monthly), key: s.key, marketplace: s.marketplace, sku: s.sku, master: s.master, recommendation: s.analysis.recommendation });
  return {
    asOf: r.asOf, from: r.from, marketplaces: r.marketplaces, availableMarketplaces, generatedAt: r.generatedAt, quality: r.quality,
    weekAxis: any ? any.weekly.map((w) => w.weekStart) : [],
    monthAxis: any ? any.monthly.map((m) => m.month) : [],
    masters: r.masters.map((x) => ({
      ...entity(x.analysis, x.metrics, x.weekly, x.monthly),
      master: x.master, skuIds: x.skuIds, skuKeys: x.skuKeys, marketplaces: x.marketplaces, currentStock: x.currentStock,
      evidence: x.analysis.evidence, recommendation: x.analysis.recommendation,
      ...driverOf(x),
    })),
    skus: r.skus.map(sku),
    unmapped: r.unmapped.map(sku),
  };
}

export interface SeasonalDetailDto {
  master: MasterResult;
  skus: SkuResult[];
  daily: { days: string[]; total: (number | null)[]; perSku: Record<string, (number | null)[]> };
}

export function toDetailDto(payload: SeasonalPayload, r: SeasonalResult, master: string): SeasonalDetailDto | null {
  const m = r.masters.find((x) => x.master === master);
  if (!m) return null;
  const keys = new Set(m.skuKeys);
  return { master: m, skus: r.skus.filter((s) => keys.has(s.key)), daily: masterDaily(payload, r, m) };
}
