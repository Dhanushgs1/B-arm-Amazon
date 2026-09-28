// Pure period bucketing for the Amazon Sales report (amazonSalesExport.ts), kept dependency-free so
// it can be unit tested. Every bucket lies inside [startDate, endDate] and together they cover it
// exactly — the selected range is never widened or trimmed.

export type SalesReportGranularity = "daily" | "weekly" | "monthly";

export interface PeriodBucket {
  label: string;
  start: string;
  end: string;
  // False when this bucket was clipped short by the selected range (e.g. the trailing week/month
  // only has 2 days of data) or, for a day, is still inside Amazon's ~48h sync lag — such a bucket
  // reads as a huge fake "decline" against a full neighbour, so the growth summary skips it.
  isFull: boolean;
}

const DAY = 86_400_000;
const toIso = (d: Date) => d.toISOString().slice(0, 10);
// UTC getters: every Date here is a UTC midnight, so local getters would print the previous day in
// any timezone west of UTC.
const fmtDot = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`;

/** Split [startDate, endDate] (YYYY-MM-DD) into consecutive buckets per the requested granularity. */
export function buildPeriods(startDate: string, endDate: string, granularity: SalesReportGranularity, today: Date = new Date()): PeriodBucket[] {
  const periods: PeriodBucket[] = [];
  const start = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");

  if (granularity === "daily") {
    // Amazon's own reporting sync typically finalizes a day's figures 24-48h later, so the most
    // recent 2 calendar days are marked "not full" — they still show in the data table, but the
    // growth summary skips them rather than reading a sync-lag dip as a fake sales decline.
    const reliableCutoff = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - 2 * DAY;
    for (let cursor = start; cursor <= end; cursor = new Date(cursor.getTime() + DAY)) {
      periods.push({ label: fmtDot(cursor), start: toIso(cursor), end: toIso(cursor), isFull: cursor.getTime() <= reliableCutoff });
    }
  } else if (granularity === "weekly") {
    for (let cursor = start; cursor <= end; ) {
      // Each bucket ends on the Sunday of ITS calendar week (ISO Monday-Sunday); a mid-week start
      // only ever affects the first bucket, which snaps every later one onto a real Mon-Sun week.
      const daysToSunday = (7 - cursor.getUTCDay()) % 7;
      const naturalWeekEnd = new Date(cursor.getTime() + daysToSunday * DAY);
      const weekEnd = new Date(Math.min(naturalWeekEnd.getTime(), end.getTime()));
      // Full only for a whole Monday-Sunday week: a first bucket starting mid-week is as short as a
      // clipped last one, and comparing it with a full week would read as a fake decline.
      const startsMonday = cursor.getUTCDay() === 1;
      periods.push({ label: `${fmtDot(cursor)}-${fmtDot(weekEnd)}`, start: toIso(cursor), end: toIso(weekEnd), isFull: startsMonday && weekEnd.getTime() === naturalWeekEnd.getTime() });
      cursor = new Date(weekEnd.getTime() + DAY);
    }
    // A trailing week clipped short by the selected end date stays (isFull: false), so the report
    // still covers the whole selected range; dropping it silently moved the effective end date.
  } else {
    // monthly — split on calendar month boundaries, clipped to the requested range
    for (let cursor = start; cursor <= end; ) {
      const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
      const bucketEnd = new Date(Math.min(monthEnd.getTime(), end.getTime()));
      periods.push({
        label: `${fmtDot(cursor)}-${fmtDot(bucketEnd)}`,
        start: toIso(cursor),
        end: toIso(bucketEnd),
        // Also require the bucket to start on the 1st — a mid-month-start first bucket that ends on
        // a month boundary would otherwise wrongly look "full" despite covering under half the month.
        isFull: cursor.getUTCDate() === 1 && bucketEnd.getTime() === monthEnd.getTime(),
      });
      cursor = new Date(bucketEnd.getTime() + DAY);
    }
  }
  return periods;
}
