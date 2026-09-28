// supabase/functions/generate-fba-forecast-report/index.ts
// Runs the full FBA Forecast Report calculation — the slow part that must
// never run inside a Vercel request. Responds fast, then keeps working via
// EdgeRuntime.waitUntil so the caller (a Vercel route) never waits on it.
// Mirrors ../generate-ad-spend-report/index.ts exactly.
import { createClient } from "npm:@supabase/supabase-js@2.110.8";
import { rejectUnlessInternal } from "../_shared/internalAuth.ts";
import { buildFbaForecastReportWorkbook } from "../_shared/fbaForecastReportExport.ts";
import { writeXlsxWithViews } from "../_shared/xlsxWriter.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  // Only the Vercel API routes and the pg_cron job hold INTERNAL_API_SECRET (see _shared/internalAuth.ts).
  const rejected = await rejectUnlessInternal(req);
  if (rejected) return rejected;
  const body = await req.json().catch(() => ({}));
  // report_date is passed through EXACTLY as received from the dashboard's
  // own selected date — never reformatted, never defaulted to "today".
  const { job_id, report_date } = body as { job_id?: number; report_date?: string };
  if (!job_id || !report_date) return jsonResponse({ error: "job_id and report_date are required" }, 400);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);

  const run = async () => {
    try {
      const { error: statusError } = await supabase.from("report_generation_jobs").update({
        status: "processing", started_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq("id", job_id);
      if (statusError) throw new Error(`Failed to mark job as processing: ${statusError.message}`);

      const result = await buildFbaForecastReportWorkbook(report_date);

      // writeXlsxWithViews wraps XLSX.write (type: "buffer", see the
      // matching comment in ../generate-ad-spend-report/index.ts) and adds
      // the frozen panes / tab colours xlsx-js-style can't write itself.
      const xlsxBytes = writeXlsxWithViews(result.wb);
      const storagePath = `${report_date}/fba-forecast-report.xlsx`;
      const { error: uploadError } = await supabase.storage
        .from("fba-forecast-reports")
        .upload(storagePath, xlsxBytes, {
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          // A regenerate overwrites this same path; the default max-age=3600
          // let Storage's CDN keep serving the previous workbook for up to an hour.
          cacheControl: "0",
          upsert: true,
        });
      if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

      const { wb: _wb, ...resultJson } = result;
      const { error: upsertError } = await supabase.from("fba_forecast_reports").upsert({
        report_date, job_id, result_json: resultJson, xlsx_storage_path: storagePath,
        generated_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }, { onConflict: "report_date" });
      if (upsertError) throw new Error(`fba_forecast_reports upsert failed: ${upsertError.message}`);

      await supabase.from("report_generation_jobs").update({
        status: "completed", completed_at: new Date().toISOString(), updated_at: new Date().toISOString(), error_message: null,
      }).eq("id", job_id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await supabase.from("report_generation_jobs").update({
        status: "failed", completed_at: new Date().toISOString(), updated_at: new Date().toISOString(), error_message: message,
      }).eq("id", job_id);
    }
  };

  // deno-lint-ignore no-explicit-any
  const edgeRuntime = (globalThis as any).EdgeRuntime;
  if (edgeRuntime?.waitUntil) {
    edgeRuntime.waitUntil(run());
  } else {
    run();
  }
  return jsonResponse({ success: true, job_id, status: "processing" });
});
