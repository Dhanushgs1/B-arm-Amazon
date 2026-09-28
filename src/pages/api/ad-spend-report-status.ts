// src/pages/api/ad-spend-report-status.ts
// GET-only status check for the dashboard's polling — separate from the
// generate/send routes so polling never accidentally re-triggers either.
import type { NextApiRequest, NextApiResponse } from "next";
import { checkSessionOrInternal, guard } from "@/lib/apiAuth";
import { findJob } from "@/lib/adSpendJobs";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Browser-facing: requires the signed-in dashboard session (or a signed server call).
  if (!guard(req, res, checkSessionOrInternal)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const { endDate, accountName } = req.query;
  if (!endDate || typeof endDate !== "string") return res.status(400).json({ error: "endDate is required" });
  try {
    const job = await findJob(endDate, typeof accountName === "string" ? accountName : "");
    return res.status(200).json({ job });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
