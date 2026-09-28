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
import { buildHistoricalAnalysisReportWorkbook, slimHistoricalWorkbookForEmail } from "@/lib/historicalAnalysisReportExport";
import { internalFetch, internalOrigin } from "@/lib/internalFetch";
import { checkSessionOrInternal, guard, isInternalRequest } from "@/lib/apiAuth";

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

// Vercel's 4.5 MB request-body cap, less headroom for the JSON envelope and email summary fields.
const MAX_ATTACHMENT_BASE64_BYTES = 4 * 1024 * 1024;

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
  // Browser-facing (Reports page "Send"): requires the signed-in dashboard session.
  if (!guard(req, res, checkSessionOrInternal)) return;

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
  // Only a signed server call may choose recipients; a browser request always goes to the fixed
  // distribution list, whatever to/cc its body carries.
  const trusted = isInternalRequest(req.headers);
  const toAddr = trusted && to !== undefined ? to : DEFAULT_TO;
  const ccAddr = trusted && cc !== undefined ? cc : DEFAULT_CC;

  try {
    const result = await buildHistoricalAnalysisReportWorkbook({ endDate, accountName });
    // The emailed copy leaves out the raw upload dumps (slimHistoricalWorkbookForEmail) — the full
    // workbook was ~50 MB uncompressed and ~11.7 MB even compressed, while this request can carry at
    // most 4.5 MB. Same bookSST + DEFLATE options as the download.
    const buf = XLSX.write(slimHistoricalWorkbookForEmail(result.wb), { type: "buffer", bookType: "xlsx", bookSST: true, compression: true });
    // The attachment travels base64-encoded inside a JSON POST to /api/send-email, and Vercel caps a
    // function's request body at 4.5 MB — fail with a clear reason instead of an opaque 413.
    const base64Bytes = Math.ceil(buf.length / 3) * 4;
    if (base64Bytes > MAX_ATTACHMENT_BASE64_BYTES) {
      return res.status(413).json({
        error: `Historical report attachment is ${(buf.length / 1048576).toFixed(1)} MB (${(base64Bytes / 1048576).toFixed(1)} MB encoded), over the ${(MAX_ATTACHMENT_BASE64_BYTES / 1048576).toFixed(1)} MB an email request can carry, even without the raw sheets. Download it from the Reports page instead.`,
        endDate,
      });
    }

    const emailRes = await internalFetch(`${internalOrigin()}/api/send-email`, {
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
