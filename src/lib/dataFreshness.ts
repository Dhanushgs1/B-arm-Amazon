// Shared "is this upload card stale" check for the Amazon/Flipkart/Meesho
// Upload pages. Every ad platform's own export lags roughly a day (today's
// spend isn't downloadable until tomorrow), so 1 day old is normal — this
// only flags a card once it falls further behind than that lag can explain,
// which in practice means whoever runs the daily upload skipped a day.
//
// Exists because the combined "Last 7 days" one-file upload (see
// combinedAdSpendUpload.ts) does NOT feed the tables the Ad Spend Report
// reads — only the per-report cards below it do — so it's easy to upload
// that one file daily and never notice the per-report cards went stale.

export function daysSince(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const then = new Date(`${dateStr}T00:00:00Z`).getTime();
  if (!Number.isFinite(then)) return null;
  const days = Math.floor((Date.now() - then) / 86_400_000);
  return days >= 0 ? days : null;
}

export function staleness(maxDate: string | null, staleAfterDays: number): { days: number; text: string } | null {
  const days = daysSince(maxDate);
  if (days === null || days <= staleAfterDays) return null;
  return {
    days,
    text:
      days === 1
        ? "1 day old — the Ad Spend Report needs this uploaded daily"
        : `${days} days old — the Ad Spend Report needs this uploaded daily`,
  };
}
