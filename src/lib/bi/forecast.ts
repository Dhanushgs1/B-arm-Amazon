// Sales forecasting for the executive dashboard. Pure functions, no I/O, so every rule is testable.
//
// Method (deliberately simple and explainable):
//   1. Weekday pattern: each weekday's average over the last 8 weeks relative to the overall average
//      (so a Sunday dip or Monday peak repeats in the forecast).
//   2. Trend: a straight line fitted to the weekday-adjusted daily values of the last 8 weeks,
//      flattened gradually going forward (damped), so a recent rise or fall is not extended
//      indefinitely — over 90 days an undamped line would compound a short-term swing.
//   3. Range: built from how far actual days scattered around the fitted line (plus the uncertainty
//      of the trend itself), shown as an 80% range — roughly 4 in 5 outcomes should fall inside it.
//   4. Accuracy check: the same method run as if it were 28 days ago, compared with what actually
//      happened in those 28 days.
// Missing days (null) are left out of every average; they are never treated as zero sales.
// It cannot see festivals, promotions, stock-outs or price changes, and with one partial year of
// history it cannot learn annual seasonality. The UI states these limits next to every forecast.

export const FORECAST = {
  fitDays: 56,
  minPoints: 28,
  damping: 0.97, // each further day keeps 97% of the previous day's trend step
  z80: 1.2816, // two-sided 80% normal interval
  backtestDays: 28,
} as const;

export type Series = (number | null)[];

export interface ForecastResult {
  ok: true;
  /** Point forecast for each future day, index 0 = the day after the last actual. */
  daily: number[];
  /** Total and 80% range for each horizon asked for. */
  horizons: Record<number, { total: number; low: number; high: number }>;
  /** Average daily value of the last 28 actual days, for context. */
  recentDailyAvg: number;
  /** Trend per day at the start of the forecast, as a % of the recent daily average. */
  trendPctPerWeek: number;
  /** Error of the same method on the most recent 28 days, as a %. null = not enough history. */
  backtestErrorPct: number | null;
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

function fit(values: Series, dates: string[]) {
  const n = values.length;
  const start = Math.max(0, n - FORECAST.fitDays);
  const vs = values.slice(start), ds = dates.slice(start);
  const factors = weekdayFactors(vs, ds);
  const pts: { t: number; z: number }[] = [];
  vs.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) return;
    pts.push({ t: i, z: v / factors[weekday(ds[i])] });
  });
  if (pts.length < FORECAST.minPoints) return null;
  const tm = mean(pts.map((p) => p.t)), zm = mean(pts.map((p) => p.z));
  const sxx = pts.reduce((a, p) => a + (p.t - tm) ** 2, 0);
  const b = sxx > 0 ? pts.reduce((a, p) => a + (p.t - tm) * (p.z - zm), 0) / sxx : 0;
  const a = zm - b * tm;
  const resid = pts.map((p) => p.z - (a + b * p.t));
  const sigma = Math.sqrt(resid.reduce((s, r) => s + r * r, 0) / Math.max(1, pts.length - 2));
  const seB = sxx > 0 ? sigma / Math.sqrt(sxx) : 0;
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

/** Forecast `values` (one per date in `dates`, null = no data) for the given horizons in days. */
export function forecastSeries(values: Series, dates: string[], horizons: number[] = [7, 15, 30, 90]): Forecast {
  if (values.length !== dates.length || !dates.length) return { ok: false, reason: "no data" };
  const model = fit(values, dates);
  if (!model) return { ok: false, reason: `needs at least ${FORECAST.minPoints} days with data in the last ${FORECAST.fitDays}` };
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
    ok: true,
    daily,
    horizons: out,
    recentDailyAvg,
    trendPctPerWeek: recentDailyAvg > 0 ? (model.b * 7 * meanFactor / recentDailyAvg) * 100 : 0,
    backtestErrorPct: backtest(values, dates),
    pointsUsed: model.points,
  };
}

/** % error of a 28-day total forecast made 28 days before the last actual. */
export function backtest(values: Series, dates: string[]): number | null {
  const cut = values.length - FORECAST.backtestDays;
  if (cut < FORECAST.minPoints) return null;
  const model = fit(values.slice(0, cut), dates.slice(0, cut));
  if (!model) return null;
  const { daily } = project(model, dates[cut - 1], FORECAST.backtestDays);
  let predicted = 0, actual = 0, used = 0;
  values.slice(cut).forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) return;
    predicted += daily[i]; actual += v; used++;
  });
  if (used < FORECAST.backtestDays / 2 || actual <= 0) return null;
  return ((predicted - actual) / actual) * 100;
}
