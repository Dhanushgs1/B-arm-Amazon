// Sales forecasting for the executive dashboard. Pure functions, no I/O, so every rule is testable.
//
// Method (deliberately simple and explainable):
//   1. Weekday pattern: each weekday's average relative to the overall average over the fit window
//      (so a Sunday dip or Monday peak repeats in the forecast).
//   2. Level and trend: a straight line fitted to the weekday-adjusted daily values, flattened
//      gradually going forward (damped) so a short swing is not extended for 90 days. One variant
//      uses no trend at all (the recent level carried forward).
//   3. Which variant: four are tried — 8 or 4 weeks of history, with or without trend — and each
//      channel uses the one that would have forecast its last four 28-day periods best (rolling
//      check). A channel whose recent history includes a sale event usually ends up on the shorter,
//      level-only variant, because an 8-week trend fitted across the event overshoots afterwards.
//   4. Range: from how far actual days scattered around the fit (plus trend uncertainty), shown as
//      an 80% range. The accuracy shown is the chosen variant's average error over those checks.
// Missing days (null) are left out of every average; they are never treated as zero sales.
// It cannot see festivals, promotions, stock-outs or price changes, and with one partial year of
// history it cannot learn annual seasonality. The UI states these limits next to every forecast.

export const FORECAST = {
  minPoints: 21,
  damping: 0.97, // each further day keeps 97% of the previous day's trend step
  z80: 1.2816, // two-sided 80% normal interval
  backtestDays: 28,
  /** How far back each rolling accuracy check starts (days before the last actual). */
  backtestOrigins: [28, 35, 42, 49],
} as const;

export interface ForecastOptions { fitDays: number; trend: boolean }
export const VARIANTS: (ForecastOptions & { label: string })[] = [
  { fitDays: 56, trend: true, label: "8-week trend" },
  { fitDays: 28, trend: true, label: "4-week trend" },
  { fitDays: 56, trend: false, label: "8-week level" },
  { fitDays: 28, trend: false, label: "4-week level" },
];
const DEFAULT: ForecastOptions = { fitDays: 56, trend: true };

export type Series = (number | null)[];

export interface ForecastResult {
  ok: true;
  /** Point forecast for each future day, index 0 = the day after the last actual. */
  daily: number[];
  /** Total and 80% range for each horizon asked for. */
  horizons: Record<number, { total: number; low: number; high: number }>;
  /** Average daily value of the last 28 actual days, for context. */
  recentDailyAvg: number;
  /** Trend per week as a % of the recent daily average (0 for a level-only variant). */
  trendPctPerWeek: number;
  /** Signed error of the 28-day total from the most recent check, as a %. null = not enough history. */
  backtestErrorPct: number | null;
  /** Average absolute error over the rolling checks, as a %. null = not enough history. */
  avgAbsErrorPct: number | null;
  method: string;
  pointsUsed: number;
}
export type Forecast = ForecastResult | { ok: false; reason: string };

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Weekday of an ISO date (0 = Sunday), in UTC so it never depends on the viewer's timezone. */
export function weekday(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

export function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekdayFactors(values: Series, dates: string[]): number[] {
  const sums = Array(7).fill(0), counts = Array(7).fill(0);
  const all: number[] = [];
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) return;
    const w = weekday(dates[i]);
    sums[w] += v; counts[w]++; all.push(v);
  });
  const overall = mean(all);
  if (overall <= 0) return Array(7).fill(1);
  const raw = sums.map((s, w) => (counts[w] >= 2 ? s / counts[w] / overall : 1));
  const norm = mean(raw);
  return raw.map((f) => (norm > 0 ? Math.max(0.2, f / norm) : 1));
}

function fit(values: Series, dates: string[], o: ForecastOptions) {
  const n = values.length;
  const start = Math.max(0, n - o.fitDays);
  const vs = values.slice(start), ds = dates.slice(start);
  const factors = weekdayFactors(vs, ds);
  const pts: { t: number; z: number }[] = [];
  vs.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) return;
    pts.push({ t: i, z: v / factors[weekday(ds[i])] });
  });
  if (pts.length < Math.min(FORECAST.minPoints, Math.floor(o.fitDays * 0.75))) return null;
  const tm = mean(pts.map((p) => p.t)), zm = mean(pts.map((p) => p.z));
  const sxx = pts.reduce((a, p) => a + (p.t - tm) ** 2, 0);
  const b = o.trend && sxx > 0 ? pts.reduce((a, p) => a + (p.t - tm) * (p.z - zm), 0) / sxx : 0;
  const a = zm - b * tm;
  const resid = pts.map((p) => p.z - (a + b * p.t));
  const sigma = Math.sqrt(resid.reduce((s, r) => s + r * r, 0) / Math.max(1, pts.length - (o.trend ? 2 : 1)));
  const seB = o.trend && sxx > 0 ? sigma / Math.sqrt(sxx) : 0;
  return { a, b, sigma, seB, factors, lastT: vs.length - 1, points: pts.length };
}

function project(model: NonNullable<ReturnType<typeof fit>>, lastDate: string, days: number) {
  const daily: number[] = [];
  const trendSteps: number[] = [];
  let cum = 0, step = 1;
  for (let h = 1; h <= days; h++) {
    step *= FORECAST.damping;
    cum += step;
    trendSteps.push(cum);
    const level = model.a + model.b * (model.lastT + cum);
    daily.push(Math.max(0, level) * model.factors[weekday(addDaysIso(lastDate, h))]);
  }
  return { daily, trendSteps };
}

/** % error of a 28-day total forecast made `back` days before the last actual. */
export function backtest(values: Series, dates: string[], o: ForecastOptions = DEFAULT, back: number = FORECAST.backtestDays): number | null {
  const cut = values.length - back;
  if (cut < FORECAST.minPoints) return null;
  const model = fit(values.slice(0, cut), dates.slice(0, cut), o);
  if (!model) return null;
  const { daily } = project(model, dates[cut - 1], FORECAST.backtestDays);
  let predicted = 0, actual = 0, used = 0;
  values.slice(cut, cut + FORECAST.backtestDays).forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) return;
    predicted += daily[i]; actual += v; used++;
  });
  if (used < FORECAST.backtestDays / 2 || actual <= 0) return null;
  return ((predicted - actual) / actual) * 100;
}

/** Average absolute error of a variant over the rolling checks; null if fewer than 2 checks run. */
export function rollingError(values: Series, dates: string[], o: ForecastOptions): number | null {
  const errs = FORECAST.backtestOrigins.map((b) => backtest(values, dates, o, b)).filter((e): e is number => e !== null);
  return errs.length >= 2 ? mean(errs.map(Math.abs)) : null;
}

/** Forecast with fixed options. */
export function forecastSeries(values: Series, dates: string[], horizons: number[] = [7, 15, 30, 90], o: ForecastOptions = DEFAULT, method = "8-week trend"): Forecast {
  if (values.length !== dates.length || !dates.length) return { ok: false, reason: "no data" };
  const model = fit(values, dates, o);
  if (!model) return { ok: false, reason: `needs at least ${FORECAST.minPoints} days with data in the last ${o.fitDays}` };
  const maxH = Math.max(...horizons);
  const { daily, trendSteps } = project(model, dates[dates.length - 1], maxH);
  const meanFactor = mean(model.factors);
  const out: ForecastResult["horizons"] = {};
  for (const H of horizons) {
    const total = daily.slice(0, H).reduce((s, v) => s + v, 0);
    const noise = model.sigma * meanFactor * Math.sqrt(H);
    const trendUnc = model.seB * meanFactor * trendSteps.slice(0, H).reduce((s, v) => s + v, 0);
    const spread = FORECAST.z80 * Math.sqrt(noise ** 2 + trendUnc ** 2);
    out[H] = { total, low: Math.max(0, total - spread), high: total + spread };
  }
  const recent = values.slice(-28).filter((v): v is number => v !== null && Number.isFinite(v));
  const recentDailyAvg = mean(recent);
  return {
    ok: true, daily, horizons: out, recentDailyAvg,
    trendPctPerWeek: recentDailyAvg > 0 ? (model.b * 7 * meanFactor / recentDailyAvg) * 100 : 0,
    backtestErrorPct: backtest(values, dates, o),
    avgAbsErrorPct: rollingError(values, dates, o),
    method, pointsUsed: model.points,
  };
}

/** Forecast with whichever variant had the lowest rolling error for this series. */
export function forecastAuto(values: Series, dates: string[], horizons: number[] = [7, 15, 30, 90]): Forecast {
  let best: (typeof VARIANTS)[number] | null = null, bestErr = Infinity;
  for (const v of VARIANTS) {
    const e = rollingError(values, dates, v);
    if (e !== null && e < bestErr) { best = v; bestErr = e; }
  }
  const pick = best ?? VARIANTS[0];
  const f = forecastSeries(values, dates, horizons, pick, pick.label);
  if (f.ok || best === null) return f;
  // the chosen variant could not fit (too few recent points): fall back to the default
  return forecastSeries(values, dates, horizons, VARIANTS[0], VARIANTS[0].label);
}
