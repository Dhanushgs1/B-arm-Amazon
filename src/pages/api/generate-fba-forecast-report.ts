// src/pages/api/generate-fba-forecast-report.ts
// Lightweight "Generate" endpoint: creates/looks up a report_generation_jobs
// row (report_type='fba_forecast') and invokes the generate-fba-forecast-
// report Edge Function, awaiting only its fast ack — never the actual
// report computation. Mirrors generate-ad-spend-report.ts exactly.
import type { NextApiRequest, NextApiResponse } from "next";
import { checkSessionOrInternal, edgeFunctionHeaders, guard } from "@/lib/apiAuth";
import { findOrCreateFbaForecastJob } from "@/lib/fbaForecastJobs";
import { supabase } from "@/lib/supabaseClient";

async function markJobFailedIfStillPending(jobId: number, message: string): Promise<void> {
  await supabase.from("report_generation_jobs").update({
    status: "failed",
    error_message: message,
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", jobId).eq("status", "pending");
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Browser-facing: requires the signed-in dashboard session (or a signed server call).
  if (!guard(req, res, checkSessionOrInternal)) return;
  // Checked before any job row is created: the Edge Function rejects calls without this secret.
  const edgeHeaders = edgeFunctionHeaders();
  if (!edgeHeaders) return res.status(503).json({ error: "INTERNAL_API_SECRET is not configured" });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // reportDate is ALWAYS the dashboard's own selected date (endDate from
  // useDashboard()) — the caller must never pass "today" as a fallback.
  const { reportDate, force } = req.body || {};
  if (!reportDate) return res.status(400).json({ error: "reportDate is required" });

  try {
    const { job, created } = await findOrCreateFbaForecastJob(reportDate, !!force);
    if (!created) {
      return res.status(200).json({ success: true, job_id: job.id, status: job.status, error_message: job.error_message });
    }

    const edgeBaseUrl = process.env.SUPABASE_EDGE_URL;
    if (!edgeBaseUrl) {
      await markJobFailedIfStillPending(job.id, "SUPABASE_EDGE_URL is not configured");
      return res.status(500).json({ error: "SUPABASE_EDGE_URL is not configured" });
    }

    const ackController = new AbortController();
    const ackTimeout = setTimeout(() => ackController.abort(), 8000);
    try {
      const edgeRes = await fetch(`${edgeBaseUrl}/generate-fba-forecast-report`, {
        method: "POST",
        headers: edgeHeaders,
        body: JSON.stringify({ job_id: job.id, report_date: reportDate }),
        signal: ackController.signal,
      });
      clearTimeout(ackTimeout);
      if (!edgeRes.ok) {
        const errBody = await edgeRes.json().catch(() => ({}));
        const message = errBody?.error || "Edge Function invocation failed";
        await markJobFailedIfStillPending(job.id, message);
        return res.status(502).json({ error: message });
      }
    } catch (fetchErr) {
      clearTimeout(ackTimeout);
      const isAckTimeout = fetchErr instanceof Error && fetchErr.name === "AbortError";
      const message = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      if (isAckTimeout) {
        // Only the 8s acknowledgment window elapsed — the Edge Function may
        // still be starting (cold start) and will flip the job's status
        // itself once it does. Leave the job "pending" so only the Edge
        // Function can move it forward from here (see the matching comment
        // in generate-ad-spend-report.ts).
        return res.status(202).json({
          success: false,
          job_id: job.id,
          status: "pending",
          message: "Report generation was triggered but did not acknowledge within 8s — it may still be starting. Check back shortly.",
        });
      }
      await markJobFailedIfStillPending(job.id, `Edge Function invocation failed: ${message}`);
      return res.status(502).json({ error: `Edge Function invocation failed: ${message}` });
    }

    return res.status(200).json({ success: true, job_id: job.id, status: "processing" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message });
  }
}
