// src/lib/adSpendJobs.ts
// Shared job-row lookup/dedupe logic for the async Daily Ad Spend Report
// pipeline, used by both /api/generate-ad-spend-report and the rewritten
// /api/send-ad-spend-email — kept in one place so "what counts as a
// duplicate" is defined exactly once.
import { supabase } from "@/lib/supabaseClient";
import { isStaleProcessing } from "@/lib/adSpendJobRules";

export const AD_SPEND_REPORT_TYPE = "ad_spend_daily";

export interface JobRow {
  id: number;
  report_date: string;
  report_type: string;
  account_name: string;
  status: "pending" | "processing" | "completed" | "failed";
  error_message: string | null;
  email_status: "not_sent" | "sending" | "sent" | "failed";
  email_sent_at: string | null;
  email_error: string | null;
  updated_at?: string | null;
}

export { STALE_PROCESSING_MS, isStaleProcessing } from "@/lib/adSpendJobRules";

export async function findJob(reportDate: string, accountName: string): Promise<JobRow | null> {
  const { data, error } = await supabase
    .from("report_generation_jobs")
    .select("*")
    .eq("report_date", reportDate)
    .eq("report_type", AD_SPEND_REPORT_TYPE)
    .eq("account_name", accountName)
    .maybeSingle();
  if (error) throw new Error(`Job lookup failed: ${error.message}`);
  return (data as JobRow) || null;
}

/**
 * Returns the existing job for (reportDate, accountName) unless it's missing,
 * `failed`, or `force` is true — in which case it creates (or resets) a
 * `pending` job and returns `created: true` so the caller knows to invoke the
 * Edge Function. A `completed`/`processing` job is returned as-is (created:
 * false) so a normal Generate click never recomputes silently.
 *
 * A `processing` job is ALWAYS returned as-is regardless of `force` — a
 * generation that is actively running right now must never be raced by a
 * second job cycle for the same key (e.g. a double-click on "Retry" while
 * the previous run is still in flight).
 */
export async function findOrCreateJob(
  reportDate: string,
  accountName: string,
  force: boolean
): Promise<{ job: JobRow; created: boolean }> {
  const existing = await findJob(reportDate, accountName);
  const stale = existing ? isStaleProcessing(existing) : false;
  if (existing && !stale && (existing.status === "processing" || (existing.status !== "failed" && !force))) {
    return { job: existing, created: false };
  }
  const { data, error } = await supabase
    .from("report_generation_jobs")
    .upsert(
      {
        report_date: reportDate,
        report_type: AD_SPEND_REPORT_TYPE,
        account_name: accountName,
        status: "pending",
        error_message: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "report_date,report_type,account_name" }
    )
    .select("*")
    .single();
  if (error) throw new Error(`Job creation failed: ${error.message}`);
  return { job: data as JobRow, created: true };
}
