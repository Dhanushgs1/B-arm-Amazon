// src/pages/api/download-ad-spend-report.ts
// Fetches the already-generated workbook for a completed report_generation_jobs
// row and hands the browser a short-lived signed URL to it, plus the same
// summary fields the old client-side exportAdSpendReport() call used to
// return directly — so "Generate & Download" can show its usual status line
// without recomputing anything itself.
//
// Reads only what generate-ad-spend-report (the Edge Function) already wrote
// to daily_ad_spend_reports (result_json, xlsx_storage_path) — same contract
// as send-ad-spend-email.ts, so download and email are always the exact same
// file, never two independently-computed copies.
import type { NextApiRequest, NextApiResponse } from "next";
import { supabase } from "@/lib/supabaseClient";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const { endDate, accountName } = req.query;
  if (!endDate || typeof endDate !== "string") return res.status(400).json({ error: "endDate is required" });
  const acctName = typeof accountName === "string" ? accountName : "";

  try {
    const { data: reportRow, error: reportErr } = await supabase
      .from("daily_ad_spend_reports")
      .select("result_json, xlsx_storage_path")
      .eq("report_date", endDate)
      .eq("account_name", acctName)
      .maybeSingle();
    if (reportErr) return res.status(500).json({ error: reportErr.message });
    if (!reportRow) return res.status(404).json({ error: "No saved report found for that date — generate it first." });

    const { data: signed, error: signErr } = await supabase.storage
      .from("ad-spend-reports")
      .createSignedUrl(reportRow.xlsx_storage_path as string, 300);
    if (signErr || !signed?.signedUrl) {
      return res.status(500).json({ error: signErr?.message || "Could not create a download link for the saved workbook" });
    }

    const result = reportRow.result_json as {
      filename: string; productCount: number; platformTotals: unknown; lowSpendCampaignCount: number; historyRowsSaved: number;
    };
    return res.status(200).json({
      downloadUrl: signed.signedUrl,
      filename: result.filename,
      productCount: result.productCount,
      platformTotals: result.platformTotals,
      lowSpendCampaignCount: result.lowSpendCampaignCount,
      historyRowsSaved: result.historyRowsSaved,
    });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
