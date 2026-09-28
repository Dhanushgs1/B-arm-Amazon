// Pure trailing-window arithmetic on "YYYY-MM-DD" strings. Done in UTC on the date alone, so the
// result never depends on the machine's or browser's timezone and never shifts the selected day.

/** The `days`-long window ending ON `endDate` (inclusive): start = endDate − (days − 1). */
export function trailingWindow(endDate: string, days: number): { start: string; end: string } {
  const d = new Date(`${endDate}T00:00:00Z`);
  // Round-trip check rejects impossible calendar dates ("2026-02-30") as well as bad formats.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== endDate) {
    throw new Error(`Invalid report end date "${endDate}" — expected YYYY-MM-DD`);
  }
  if (!Number.isInteger(days) || days < 1) throw new Error(`Invalid window length ${days} — expected a whole number of days >= 1`);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return { start: d.toISOString().slice(0, 10), end: endDate };
}
