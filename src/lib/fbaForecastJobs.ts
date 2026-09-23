// Job-row lookup/dedupe for the FBA Forecast Report generation pipeline —
// same pattern as adSpendJobs.ts's findOrCreateJob, reusing the SAME
// report_generation_jobs table (report_type = 'fba_forecast'), not a
// parallel job-status table. Keyed on report_date alone (account_name is
// always '' — this report has no per-account dimension).
//
// report_date here is ALWAYS the dashboard's own selected date (`endDate`
// from useDashboard()) — never the server's real "today". See
// src/app/dashboard/fba/page.tsx, which is the only caller.
import { supabase } from "@/lib/supabaseClient";
import { withStaleProcessingAsFailed } from "@/lib/fbaForecastJobRules";

export const FBA_FORECAST_REPORT_TYPE = "fba_forecast";

export interface FbaForecastJobRow {
  id: number;
  report_date: string;
  status: "pending" | "processing" | "completed" | "failed";
  error_message: string | null;
  started_at?: string | null;
  updated_at?: string | null;
}

/** A job stuck in "processing" past STALE_PROCESSING_MS is returned as
 *  "failed" (see fbaForecastJobRules.ts), so the page offers Retry and
 *  findOrCreateFbaForecastJob can start a fresh run. */
export async function findFbaForecastJob(reportDate: string): Promise<FbaForecastJobRow | null> {
  const { data, error } = await supabase
    .from("report_generation_jobs")
    .select("id, report_date, status, error_message, started_at, updated_at")
    .eq("report_date", reportDate)
    .eq("report_type", FBA_FORECAST_REPORT_TYPE)
    .eq("account_name", "")
    .maybeSingle();
  if (error) throw new Error(`Job lookup failed: ${error.message}`);
  return withStaleProcessingAsFailed((data as FbaForecastJobRow) || null);
}

/**
 * Returns the existing job for `reportDate` unless it's missing, `failed`,
 * or `force` is true — in which case it creates (or resets) a `pending`
 * job and returns `created: true` so the caller knows to invoke the Edge
 * Function. A `processing` job is ALWAYS returned as-is regardless of
 * `force`, matching adSpendJobs.ts's findOrCreateJob exactly — except one
 * stuck past STALE_PROCESSING_MS, which findFbaForecastJob reports as
 * `failed` and so can be retried.
 */
export async function findOrCreateFbaForecastJob(
  reportDate: string,
  force: boolean
): Promise<{ job: FbaForecastJobRow; created: boolean }> {
  const existing = await findFbaForecastJob(reportDate);
  if (existing && (existing.status === "processing" || (existing.status !== "failed" && !force))) {
    return { job: existing, created: false };
  }
  const { data, error } = await supabase
    .from("report_generation_jobs")
    .upsert(
      {
        report_date: reportDate,
        report_type: FBA_FORECAST_REPORT_TYPE,
        account_name: "",
        status: "pending",
        error_message: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "report_date,report_type,account_name" }
    )
    .select("id, report_date, status, error_message")
    .single();
  if (error) throw new Error(`Job creation failed: ${error.message}`);
  return { job: data as FbaForecastJobRow, created: true };
}

/**
 * Downloads the completed report's .xlsx bytes from Supabase Storage,
 * looking up its storage path from fba_forecast_reports for this
 * report_date (the dashboard's selected date). Safe to call directly from
 * the browser — `supabase` uses the public anon key, and the
 * "fba-forecast-reports" bucket's storage policy
 * (scripts/fba_forecast_report_tables.sql) grants anon read.
 *
 * A regenerate overwrites the same storage path, and Storage's CDN keeps
 * serving the previous file for up to an hour (cache-control max-age=3600).
 * Keying the request on this report's own generated_at (cacheNonce) gives
 * each generation its own URL, so Download always gets the latest file.
 */
export async function fetchFbaForecastReportBlob(reportDate: string): Promise<Blob> {
  const { data: reportRow, error: rowErr } = await supabase
    .from("fba_forecast_reports")
    .select("xlsx_storage_path, generated_at")
    .eq("report_date", reportDate)
    .maybeSingle();
  if (rowErr) throw new Error(`Looking up report failed: ${rowErr.message}`);
  if (!reportRow?.xlsx_storage_path) throw new Error("Report has no stored file yet.");
  const { data: blob, error: dlErr } = await supabase.storage
    .from("fba-forecast-reports")
    .download(reportRow.xlsx_storage_path, { cacheNonce: String(reportRow.generated_at ?? Date.now()) }, { cache: "no-store" });
  if (dlErr) throw new Error(`Downloading report failed: ${dlErr.message}`);
  return blob;
}
