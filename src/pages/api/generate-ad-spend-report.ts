// src/pages/api/generate-ad-spend-report.ts
// Lightweight "Generate" endpoint: creates/looks up a report_generation_jobs
// row and invokes the generate-ad-spend-report Edge Function, awaiting only
// its fast ack — never the actual report computation. See
// docs/superpowers/specs/2026-09-08-daily-ad-spend-async-architecture-design.md.
import type { NextApiRequest, NextApiResponse } from "next";
import { findOrCreateJob } from "@/lib/adSpendJobs";
import { supabase } from "@/lib/supabaseClient";

async function markJobFailed(jobId: number, message: string): Promise<void> {
  await supabase.from("report_generation_jobs").update({
    status: "failed",
    error_message: message,
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", jobId);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
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
      await markJobFailed(job.id, "SUPABASE_EDGE_URL is not configured");
      return res.status(500).json({ error: "SUPABASE_EDGE_URL is not configured" });
    }

    const ackController = new AbortController();
    const ackTimeout = setTimeout(() => ackController.abort(), 8000);
    try {
      const edgeRes = await fetch(`${edgeBaseUrl}/generate-ad-spend-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: job.id, report_date: endDate, account_name: acctName, range_days: rangeDays }),
        signal: ackController.signal,
      });
      clearTimeout(ackTimeout);
      if (!edgeRes.ok) {
        const errBody = await edgeRes.json().catch(() => ({}));
        const message = errBody?.error || "Edge Function invocation failed";
        await markJobFailed(job.id, message);
        return res.status(502).json({ error: message });
      }
    } catch (fetchErr) {
      clearTimeout(ackTimeout);
      const message = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      await markJobFailed(job.id, `Edge Function invocation failed: ${message}`);
      return res.status(502).json({ error: `Edge Function invocation failed: ${message}` });
    }

    return res.status(200).json({ success: true, job_id: job.id, status: "processing" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message });
  }
}
