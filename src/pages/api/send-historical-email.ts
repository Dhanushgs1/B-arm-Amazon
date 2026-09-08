// Automated/manual "Send" for the Historical 7/30 Day Analysis Report — same
// pattern as send-ad-spend-email.ts: rebuilds the same workbook the Reports
// page's "Generate & Download" button produces (so the attachment and the
// email body's headline counts always agree), then hands a summary + the
// workbook as an attachment to /api/send-email's "historicalReport" template.
//
// Recipients default to the same distribution list the Ad Spend report already
// uses — not the Settings notifEmail/ccEmail fields, which are a separate,
// per-account list used by the Daily Digest/Weekly Report.

import type { NextApiRequest, NextApiResponse } from "next";
import * as XLSX from "xlsx-js-style";
import { buildHistoricalAnalysisReportWorkbook } from "@/lib/historicalAnalysisReportExport";
import { internalFetch, internalOrigin } from "@/lib/internalFetch";

// See send-email.ts's own config comment — this route does the slow part (Supabase fetch across
// 30/7-day windows) before even calling send-email, so it needs the same raised Vercel timeout.
export const config = {
  maxDuration: 300,
};

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

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Same trailing-window math as buildHistoricalAnalysisReportWorkbook itself —
// duplicated here (rather than exported from historicalAnalysisReportExport.ts)
// purely to label the email's two windows; the workbook's own numbers are the
// source of truth regardless of what this computes.
function windowStart(endDate: string, days: number): string {
  const end = new Date(`${endDate}T00:00:00Z`);
  const start = new Date(end.getTime());
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return iso(start);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { endDate: endDateBody, accountName, to, cc } = req.body || {};
  // Defaults to yesterday (IST-agnostic UTC date, matching weekly-report.ts's
  // own default) so a cron caller doesn't need to compute a date itself.
  let endDate = endDateBody as string | undefined;
  if (!endDate) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    endDate = iso(d);
  }
  // `to`/`cc` explicitly present (even as "") means "use exactly this, don't
  // fall back to the real distribution list" — matches send-ad-spend-email.ts.
  const toAddr = to !== undefined ? to : DEFAULT_TO;
  const ccAddr = cc !== undefined ? cc : DEFAULT_CC;

  try {
    const result = await buildHistoricalAnalysisReportWorkbook({ endDate, accountName });
    const buf = XLSX.write(result.wb, { type: "buffer", bookType: "xlsx" });

    const emailRes = await internalFetch(`${internalOrigin(req)}/api/send-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "historicalReport",
        to: toAddr,
        cc: ccAddr || undefined,
        data: {
          endDate,
          win30Start: windowStart(endDate, 30),
          win7Start: windowStart(endDate, 7),
          currency: "INR",
          skuCount: result.skuCount,
          pairCount: result.pairCount,
          unmappedCampaignSpend: result.unmappedCampaignSpend,
          totalSpend30: result.totalSpend30,
          totalSpend7: result.totalSpend7,
          topWorstAcos: result.topWorstAcos,
        },
        attachments: [{ filename: result.filename, content: buf.toString("base64"), encoding: "base64" }],
      }),
    });
    const emailResult = await emailRes.json().catch(() => ({}));
    if (!emailRes.ok) {
      return res.status(500).json({ error: emailResult?.error || "send-email failed" });
    }

    return res.status(200).json({
      sent: true,
      to: toAddr,
      cc: ccAddr,
      filename: result.filename,
      skuCount: result.skuCount,
      pairCount: result.pairCount,
      emailResult,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message, endDate });
  }
}
