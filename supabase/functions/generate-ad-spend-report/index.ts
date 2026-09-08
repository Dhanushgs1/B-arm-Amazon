// supabase/functions/generate-ad-spend-report/index.ts
// Runs the full Daily Ad Spend Report calculation (marketplace fetch, SKU
// resolution, GST/CPC/ACOS, Action Sheet Gemini calls) — the slow part that
// must never run inside a Vercel request. Responds fast, then keeps working
// via EdgeRuntime.waitUntil so the caller (a Vercel route or pg_cron) never
// waits on it either.
import { createClient } from "npm:@supabase/supabase-js@2.110.8";
// Default import, not `import * as` — see the matching comment in
// ../_shared/adSpendReportExport.ts for why (Deno's npm compat nests the
// real exports at `.default` for this package).
import XLSX from "npm:xlsx-js-style@1.2.0";
import { buildAdSpendReportWorkbook } from "../_shared/adSpendReportExport.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  const body = await req.json().catch(() => ({}));
  const { job_id, report_date, account_name, range_days } = body as {
    job_id?: number; report_date?: string; account_name?: string; range_days?: number;
  };
  if (!job_id || !report_date) return jsonResponse({ error: "job_id and report_date are required" }, 400);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
  const acctName = account_name || "";

  const run = async () => {
    try {
      const { error: statusError } = await supabase.from("report_generation_jobs").update({
        status: "processing",
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        email_status: "not_sent",
        email_sent_at: null,
        email_error: null,
      }).eq("id", job_id);
      if (statusError) throw new Error(`Failed to mark job as processing: ${statusError.message}`);

      // report_date is passed through to buildAdSpendReportWorkbook's endDate
      // option exactly as received — no reformatting, no "today" fallback.
      const result = await buildAdSpendReportWorkbook({
        endDate: report_date,
        rangeDays: range_days,
        accountName: acctName || undefined,
      });

      // type: "array" returns a bare ArrayBuffer under this Deno npm-compat
      // setup (no .length property, only .byteLength) rather than a
      // Uint8Array like Node's xlsx-js-style gives — confirmed by direct
      // probe. type: "buffer" correctly returns a real Uint8Array here.
      const xlsxBytes = XLSX.write(result.wb, { type: "buffer", bookType: "xlsx" }) as Uint8Array;
      const storagePath = `${report_date}/${acctName || "default"}.xlsx`;
      const { error: uploadError } = await supabase.storage
        .from("ad-spend-reports")
        .upload(storagePath, xlsxBytes, {
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          upsert: true,
        });
      if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

      // wb (the XLSX.WorkBook object) isn't JSON-serializable and is already
      // persisted above as the real file — everything else on the result is
      // plain data the email template needs.
      const { wb: _wb, ...resultJson } = result;

      const { error: upsertError } = await supabase.from("daily_ad_spend_reports").upsert({
        report_date,
        account_name: acctName,
        job_id,
        result_json: resultJson,
        xlsx_storage_path: storagePath,
        updated_at: new Date().toISOString(),
      }, { onConflict: "report_date,account_name" });
      if (upsertError) throw new Error(`daily_ad_spend_reports upsert failed: ${upsertError.message}`);

      await supabase.from("report_generation_jobs").update({
        status: "completed",
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        error_message: null,
      }).eq("id", job_id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await supabase.from("report_generation_jobs").update({
        status: "failed",
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        error_message: message,
      }).eq("id", job_id);
    }
  };

  // deno-lint-ignore no-explicit-any
  const edgeRuntime = (globalThis as any).EdgeRuntime;
  if (edgeRuntime?.waitUntil) {
    edgeRuntime.waitUntil(run());
  } else {
    // `supabase functions serve` (local dev) has no EdgeRuntime global — fire
    // without awaiting so the HTTP response still returns immediately.
    run();
  }

  return jsonResponse({ accepted: true, job_id, status: "processing" });
});
