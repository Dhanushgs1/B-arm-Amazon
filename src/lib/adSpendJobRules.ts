// Pure job-state rules for the Daily Ad Spend Report pipeline (adSpendJobs.ts) — dependency-free
// so they can be unit tested directly.

/** A "processing" job not touched for this long is dead, not running: the Edge Function can be
 *  stopped by Supabase (e.g. "CPU Time exceeded") before it marks the job failed, which used to
 *  leave Send on "still being generated" and Generate unable to restart it, forever. A normal
 *  run finishes in about a minute. */
export const STALE_PROCESSING_MS = 10 * 60 * 1000;

export function isStaleProcessing(job: { status: string; updated_at?: string | null }, now = Date.now()): boolean {
  if (job.status !== "processing" && job.status !== "pending") return false;
  const t = job.updated_at ? Date.parse(job.updated_at) : NaN;
  return Number.isFinite(t) && now - t > STALE_PROCESSING_MS;
}
