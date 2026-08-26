// Manual "Send" for the Daily Ad Spend Report — called from the button next to
// "Generate & Download" on the Reports page. Rebuilds the same workbook
// buildAdSpendReportWorkbook already produces for that download (so the
// attachment and the numbers in the email body always agree), then hands the
// summary + the workbook as an attachment to /api/send-email's "adSpendDaily"
// template.
//
// Recipients default to the same distribution list Aparna already sends this
// report to by hand every day — not the Settings notifEmail/ccEmail fields,
// which are a different list (used by the Daily Digest/Weekly Report).

import type { NextApiRequest, NextApiResponse } from "next";
import * as XLSX from "xlsx-js-style";
import { buildAdSpendReportWorkbook } from "@/lib/adSpendReportExport";
import { internalFetch } from "@/lib/internalFetch";

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

// 'YYYY-MM-DD' -> 'DD-MM-YYYY', matching the sample manual email's date format.
function dmy(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { endDate: endDateBody, rangeDays, accountName, to, cc } = req.body || {};
  // Defaults to yesterday so the daily cron (instrumentation.ts / scheduled-reports.ts)
  // doesn't need to compute a date itself — matches weekly-report.ts's own default.
  let endDate = endDateBody as string | undefined;
  if (!endDate) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    endDate = d.toISOString().slice(0, 10);
  }
  // `to`/`cc` explicitly present (even as "") means "use exactly this, don't
  // fall back to the real distribution list" — a `|| DEFAULT` here would
  // silently restore the CEO/team cc on every test send that passes cc: "".
  const toAddr = to !== undefined ? to : DEFAULT_TO;
  const ccAddr = cc !== undefined ? cc : DEFAULT_CC;

  try {
    const result = await buildAdSpendReportWorkbook({ endDate, rangeDays, accountName });
    const buf = XLSX.write(result.wb, { type: "buffer", bookType: "xlsx" });

    const dayLabel = dmy(result.endDate);
    const rangeLabel = `${dmy(result.rangeStart)} to ${dmy(result.endDate)}`;

    const proto = (req.headers["x-forwarded-proto"] as string) || "http";
    const host = req.headers.host;
    const emailRes = await internalFetch(`${proto}://${host}/api/send-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "adSpendDaily",
        to: toAddr,
        cc: ccAddr || undefined,
        data: {
          dayLabel,
          rangeLabel,
          currency: "INR",
          platformSummaries: result.platformSummaries,
          productCount: result.productCount,
          lowSpendCampaignCount: result.lowSpendCampaignCount,
          incompleteDates: result.incompleteDates,
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
      productCount: result.productCount,
      platformTotals: result.platformTotals,
      emailResult,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message, endDate });
  }
}
