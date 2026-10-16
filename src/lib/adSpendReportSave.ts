import * as XLSX from "xlsx-js-style";
import { supabasePublic } from "@/lib/amazonReportUpload";
import { AD_SPEND_REPORT_TYPE } from "@/lib/adSpendJobs";
import { buildAdSpendReportWorkbook, type AdSpendReportOpts, type AdSpendReportResult } from "@/lib/adSpendReportExport";

// Reports page "Generate & Download": the downloaded workbook is also saved as the date's report
// for the email — same storage path, daily_ad_spend_reports row and completed job the
// generate-ad-spend-report Edge Function writes (supabase/functions/generate-ad-spend-report). So
// "Send" mails exactly the Summary and attachment that were just downloaded, instead of a separate
// Edge Function build that can differ (or never finish: that function can be stopped by Supabase's
// CPU limit, leaving the job "processing" and Send stuck on "still being generated").

export interface AdSpendSaveResult {
  saved: boolean;
  /** Why the email copy could not be saved (the download itself still happened). */
  error?: string;
}

export async function saveAdSpendReportForEmail(
  result: AdSpendReportResult,
  xlsxBytes: Uint8Array,
  accountName: string,
): Promise<AdSpendSaveResult> {
  try {
    const reportDate = result.endDate;
    const now = new Date().toISOString();
    const storagePath = `${reportDate}/${accountName || "default"}.xlsx`;
    const { error: uploadError } = await supabasePublic.storage.from("ad-spend-reports").upload(storagePath, xlsxBytes, {
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      upsert: true,
    });
    if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

    // Job row first (the report row references it), completed straight away: the work is done.
    const { data: job, error: jobError } = await supabasePublic
      .from("report_generation_jobs")
      .upsert(
        {
          report_date: reportDate,
          report_type: AD_SPEND_REPORT_TYPE,
          account_name: accountName,
          status: "completed",
          error_message: null,
          completed_at: now,
          updated_at: now,
          // A new report has not been mailed yet — same reset the Edge Function does.
          email_status: "not_sent",
          email_sent_at: null,
          email_error: null,
        },
        { onConflict: "report_date,report_type,account_name" },
      )
      .select("id")
      .single();
    if (jobError || !job) throw new Error(`Job save failed: ${jobError?.message ?? "no row returned"}`);

    // wb isn't JSON — it is the file uploaded above; everything else is what the email renders.
    const { wb: _wb, ...resultJson } = result;
    void _wb;
    const { error: reportError } = await supabasePublic.from("daily_ad_spend_reports").upsert(
      {
        report_date: reportDate,
        account_name: accountName,
        job_id: (job as { id: number }).id,
        result_json: resultJson,
        xlsx_storage_path: storagePath,
        updated_at: now,
      },
      { onConflict: "report_date,account_name" },
    );
    if (reportError) throw new Error(`Report save failed: ${reportError.message}`);
    return { saved: true };
  } catch (err) {
    return { saved: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Builds the report, downloads it, and saves that same file + figures for the email. */
export async function exportAndSaveAdSpendReport(
  opts: AdSpendReportOpts,
): Promise<Omit<AdSpendReportResult, "wb"> & { emailCopy: AdSpendSaveResult }> {
  const result = await buildAdSpendReportWorkbook(opts);
  // One set of bytes for both the download and the saved copy, so they are the same file.
  const bytes = new Uint8Array(XLSX.write(result.wb, { type: "array", bookType: "xlsx", bookSST: true, compression: true }) as ArrayBuffer);
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = result.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);

  const emailCopy = await saveAdSpendReportForEmail(result, bytes, opts.accountName || "");
  const { wb: _wb, ...stats } = result;
  void _wb;
  return { ...stats, emailCopy };
}
