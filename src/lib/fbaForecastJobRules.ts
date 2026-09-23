// Pure rules for FBA Forecast report_generation_jobs rows — no Supabase
// imports, so they can be unit tested with plain `node --test`.
//
// A generate run can be killed by the Edge Function runtime (e.g. a warm
// worker hitting the memory limit) without ever writing "failed", which left
// the job stuck in "processing" and blocked every Regenerate for that date.
// Normal runs finish in well under a minute, so a job still "processing"
// after STALE_PROCESSING_MS is treated as failed and can be retried.

export const STALE_PROCESSING_MS = 5 * 60 * 1000;

export interface FbaJobTiming {
  status: string;
  error_message: string | null;
  started_at?: string | null;
  updated_at?: string | null;
}

/** True when a "processing" job has been running for more than STALE_PROCESSING_MS. */
export function isStaleProcessingJob(job: FbaJobTiming, nowMs: number = Date.now()): boolean {
  if (job.status !== "processing") return false;
  const since = Date.parse(job.started_at || job.updated_at || "");
  if (!Number.isFinite(since)) return false;
  return nowMs - since > STALE_PROCESSING_MS;
}

/** The job as the page should see it: a stale "processing" job reads as "failed" (so Retry is offered). */
export function withStaleProcessingAsFailed<T extends FbaJobTiming>(job: T | null, nowMs: number = Date.now()): T | null {
  if (!job || !isStaleProcessingJob(job, nowMs)) return job;
  return { ...job, status: "failed", error_message: "Generation did not finish within 5 minutes — please retry." };
}
