// Vercel Cron entry point for the Ad Spend Report's history table — see
// scripts/ad_spend_history_table.sql and src/lib/adSpendReportExport.ts's
// saveAdSpendHistory. Wired into vercel.json's "crons" array.
//
// Runs daily and simply builds the Ad Spend Report workbook for `date`
// (defaulting to yesterday, IST) — the workbook itself is discarded here,
// only its side effect matters: buildAdSpendReportWorkbook upserts one row
// per active product per platform into barm_ad_spend_history. No email, no
// file — this only persists history so it accumulates even on days nobody
// opens the Download page. Unlike src/pages/api/cron/scheduled-reports.ts,
// this isn't per-account (Amazon/Flipkart/Meesho tables here aren't split by
// keySlot), so it runs once, not once per slot.

import type { NextApiRequest, NextApiResponse } from "next";
import { buildAdSpendReportWorkbook } from "@/lib/adSpendReportExport";

function yesterdayIst(): string {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  ist.setUTCDate(ist.getUTCDate() - 1);
  return ist.toISOString().slice(0, 10);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Same Vercel Cron auth as scheduled-reports.ts — enforced only if
  // CRON_SECRET is set as a project env var.
  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const dateParam = typeof req.query.date === "string" ? req.query.date : undefined;
  const endDate = dateParam || yesterdayIst();

  try {
    const { wb, ...stats } = await buildAdSpendReportWorkbook({ endDate });
    void wb; // discarded on purpose — only the Supabase history upsert matters here
    console.log(`[Marketplace360 Cron] ✅ Ad spend history saved for ${endDate}: ${stats.historyRowsSaved} rows`);
    return res.status(200).json({ ranAt: new Date().toISOString(), ...stats });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Marketplace360 Cron] ❌ Ad spend history failed for ${endDate}:`, err);
    return res.status(500).json({ error: message, endDate });
  }
}
