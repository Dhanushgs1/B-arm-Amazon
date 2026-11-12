import test from "node:test";
import assert from "node:assert/strict";
import { forecastSeries, backtest, addDaysIso, weekday } from "./forecast.ts";

const datesFrom = (start: string, n: number) => Array.from({ length: n }, (_, i) => addDaysIso(start, i));

test("dates and weekdays are timezone-independent", () => {
  assert.equal(addDaysIso("2026-10-31", 1), "2026-11-01");
  assert.equal(weekday("2026-11-12"), 4); // Thursday
});

test("flat series: forecast equals the level, range contains it, backtest near zero", () => {
  const dates = datesFrom("2026-08-01", 84);
  const values = dates.map(() => 1000);
  const f = forecastSeries(values, dates);
  assert.ok(f.ok);
  if (!f.ok) return;
  assert.ok(Math.abs(f.horizons[30].total - 30000) < 1);
  assert.ok(f.horizons[30].low <= 30000 && f.horizons[30].high >= 30000);
  assert.ok(Math.abs(f.backtestErrorPct ?? 99) < 0.5);
});

test("weekday pattern repeats in the forecast", () => {
  const dates = datesFrom("2026-08-02", 84); // starts on a Sunday
  const values = dates.map((d) => (weekday(d) === 0 ? 500 : 1000));
  const f = forecastSeries(values, dates);
  assert.ok(f.ok);
  if (!f.ok) return;
  const nextDates = datesFrom(addDaysIso(dates[83], 1), 7);
  const sunday = f.daily[nextDates.findIndex((d) => weekday(d) === 0)];
  const monday = f.daily[nextDates.findIndex((d) => weekday(d) === 1)];
  assert.ok(sunday < monday * 0.6, `sunday ${sunday} vs monday ${monday}`);
});

test("a rising trend is projected upward but damped (90 days grows less than a straight line)", () => {
  const dates = datesFrom("2026-08-01", 84);
  const values = dates.map((_, i) => 1000 + 10 * i);
  const f = forecastSeries(values, dates);
  assert.ok(f.ok);
  if (!f.ok) return;
  assert.ok(f.trendPctPerWeek > 0);
  const straight90 = Array.from({ length: 90 }, (_, h) => 1000 + 10 * (84 + h)).reduce((a, b) => a + b, 0);
  assert.ok(f.horizons[90].total < straight90);
  assert.ok(f.horizons[90].total > 90 * values[83] * 0.95);
});

test("missing days are skipped, never read as zero; too little data is refused", () => {
  const dates = datesFrom("2026-08-01", 84);
  const values = dates.map((_, i) => (i % 5 === 0 ? null : 1000));
  const f = forecastSeries(values, dates);
  assert.ok(f.ok);
  if (f.ok) assert.ok(Math.abs(f.horizons[7].total - 7000) < 1);
  const sparse = dates.map((_, i) => (i > 70 ? 1000 : null));
  const g = forecastSeries(sparse, dates);
  assert.equal(g.ok, false);
  assert.equal(backtest(sparse, dates), null);
});

test("forecasts never go negative", () => {
  const dates = datesFrom("2026-08-01", 84);
  const values = dates.map((_, i) => Math.max(0, 2000 - 30 * i));
  const f = forecastSeries(values, dates);
  assert.ok(f.ok);
  if (f.ok) assert.ok(f.daily.every((v) => v >= 0) && f.horizons[90].low >= 0);
});
