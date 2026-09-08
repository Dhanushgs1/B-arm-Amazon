// src/pages/api/send-ad-spend-email.ts
// Lightweight "Send" for the Daily Ad Spend Report — reads the already-
// computed report for the selected date from daily_ad_spend_reports and
// dispatches the email via the send-ad-spend-email Edge Function. Never
// fetches marketplace data, never recalculates, never blocks on SMTP. See
// docs/superpowers/specs/2026-09-08-daily-ad-spend-async-architecture-design.md.
import type { NextApiRequest, NextApiResponse } from "next";
import { supabase } from "@/lib/supabaseClient";
import { findJob } from "@/lib/adSpendJobs";

const DEFAULT_TO = "kaviyapriyabarm@gmail.com";
const DEFAULT_CC = [
  "jayaprakashbarm@gmail.com",
  "dangibbs@b-arm.com",
  "nivetha@b-arm.com",
  "prinesh@b-arm.com",
  "akshaya.v@b-arm.com",
  "ceo@barmenterprises.com",
  "sriram@b-arm.com",
].join(",");

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { endDate, accountName, to, cc } = req.body || {};
  if (!endDate) return res.status(400).json({ error: "endDate is required" });

  const acctName = accountName || "";
  const toAddr = to !== undefined ? to : DEFAULT_TO;
  const ccAddr = cc !== undefined ? cc : DEFAULT_CC;

  try {
    const job = await findJob(endDate, acctName);
    if (!job) {
      return res.status(202).json({ success: false, status: "pending", message: "Report has not been generated yet for this date." });
    }
    if (job.status === "failed") {
      return res.status(409).json({ success: false, status: "failed", error: job.error_message || "Report generation failed." });
    }
    if (job.status !== "completed") {
      return res.status(202).json({ success: false, status: job.status, message: "Report is still being generated. Please try again shortly." });
    }

    const { data: reportRow, error: reportErr } = await supabase
      .from("daily_ad_spend_reports")
      .select("result_json")
      .eq("report_date", endDate)
      .eq("account_name", acctName)
      .maybeSingle();
    if (reportErr || !reportRow) {
      return res.status(500).json({ error: reportErr?.message || "Report row missing despite a completed job." });
    }
    const result = reportRow.result_json as {
      filename: string; productCount: number;
      platformTotals: { platform: string; daySpendTax: number; rangeSpendTax: number }[];
    };

    const edgeBaseUrl = process.env.SUPABASE_EDGE_URL;
    if (!edgeBaseUrl) return res.status(500).json({ error: "SUPABASE_EDGE_URL is not configured" });

    const ackController = new AbortController();
    const ackTimeout = setTimeout(() => ackController.abort(), 8000);
    try {
      const edgeRes = await fetch(`${edgeBaseUrl}/send-ad-spend-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: job.id, report_date: endDate, account_name: acctName, to: toAddr, cc: ccAddr || undefined }),
        signal: ackController.signal,
      });
      clearTimeout(ackTimeout);
      if (!edgeRes.ok) {
        const errBody = await edgeRes.json().catch(() => ({}));
        return res.status(502).json({ error: errBody?.error || "Edge Function invocation failed" });
      }
    } catch (fetchErr) {
      clearTimeout(ackTimeout);
      const message = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      return res.status(502).json({ error: `Edge Function invocation failed: ${message}` });
    }

    return res.status(200).json({
      sent: true,
      to: toAddr,
      cc: ccAddr,
      filename: result.filename,
      productCount: result.productCount,
      platformTotals: result.platformTotals,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message, endDate });
  }
}
