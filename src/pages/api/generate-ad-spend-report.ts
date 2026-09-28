// src/pages/api/generate-ad-spend-report.ts
// Lightweight "Generate" endpoint: creates/looks up a report_generation_jobs
// row and invokes the generate-ad-spend-report Edge Function, awaiting only
// its fast ack — never the actual report computation. See
// docs/superpowers/specs/2026-09-08-daily-ad-spend-async-architecture-design.md.
import type { NextApiRequest, NextApiResponse } from "next";
import { checkSessionOrInternal, edgeFunctionHeaders, guard } from "@/lib/apiAuth";
import { findOrCreateJob } from "@/lib/adSpendJobs";
import { supabase } from "@/lib/supabaseClient";

// Only writes "failed" while the job is still "pending" — i.e. before the
// Edge Function itself has taken over. A slow-but-real Edge Function
// response that already flipped the job to "processing" (or beyond) can
// never be clobbered by this route once this guard is in place; only the
// Edge Function itself is allowed to mark a job "completed"/"failed" once
// it has actually started running.
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

  const { endDate, accountName, rangeDays, force } = req.body || {};
  if (!endDate) return res.status(400).json({ error: "endDate is required" });

  const acctName = accountName || "";

  try {
    const { job, created } = await findOrCreateJob(endDate, acctName, !!force);

    if (!created) {
      // Already pending/processing/completed for this exact date — do not
      // invoke the Edge Function again (see Global Constraints: nothing
      // recomputes except an explicit force/Retry request).
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
      const edgeRes = await fetch(`${edgeBaseUrl}/generate-ad-spend-report`, {
        method: "POST",
        headers: edgeHeaders,
        body: JSON.stringify({ job_id: job.id, report_date: endDate, account_name: acctName, range_days: rangeDays }),
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
        // We only know the 8s acknowledgment window elapsed — not that the Edge
        // Function never received the request. It may still be starting (e.g. a
        // cold start) and will flip the job's status itself once it does.
        // Marking this "failed" here would race with, and could incorrectly
        // override, a real invocation that's actually running in the background.
        // Leave the job's row untouched (still "pending") so only the Edge
        // Function itself can move it forward from here.
        return res.status(202).json({
          success: false,
          job_id: job.id,
          status: "pending",
          message: "Report generation was triggered but did not acknowledge within 8s — it may still be starting. Check back shortly.",
        });
      }
      // A non-abort network error (e.g. DNS/connection failure) happened before
      // any response could possibly exist — this is a genuine, confirmed
      // failure to reach the Edge Function at all, safe to mark failed.
      await markJobFailedIfStillPending(job.id, `Edge Function invocation failed: ${message}`);
      return res.status(502).json({ error: `Edge Function invocation failed: ${message}` });
    }

    return res.status(200).json({ success: true, job_id: job.id, status: "processing" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message });
  }
}
