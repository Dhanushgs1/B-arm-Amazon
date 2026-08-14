// Finds products that are out of stock (or below a threshold) yet still burning
// ad budget, and emails the list via the /api/send-email "stockout" template.
// Correlation logic lives in src/lib/stockout.ts (shared with the daily cron).
//
// POST body: { slot?, amazon_account_id, workspace_id, to, lowStockThreshold?, lookbackDays?, send? }

import type { NextApiRequest, NextApiResponse } from "next";
import { findStockoutAdSpend, resolveSellerMateKey } from "@/lib/stockout";
import { internalFetch } from "@/lib/internalFetch";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const {
    slot = "B",
    amazon_account_id,
    workspace_id,
    to,
    cc,
    lowStockThreshold = 0,
    lookbackDays = 7,
    send = true,
    currency = "INR",
  } = req.body || {};

  if (!amazon_account_id || !workspace_id) {
    return res.status(400).json({ error: "amazon_account_id and workspace_id are required" });
  }

  const apiKey = resolveSellerMateKey(slot === "B" ? "B" : "A");
  if (!apiKey) return res.status(500).json({ error: `Missing SellerMate API key for slot ${slot}` });

  try {
    const items = await findStockoutAdSpend({ apiKey, amazon_account_id, workspace_id, lowStockThreshold, lookbackDays });
    const totalWasted = items.reduce((a, i) => a + i.spend, 0);

    let emailResult: any = null;
    if (send && to && items.length > 0) {
      const proto = (req.headers["x-forwarded-proto"] as string) || "http";
      const host = req.headers.host;
      const r = await internalFetch(`${proto}://${host}/api/send-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "stockout", to, cc, data: { items, currency } }),
      });
      emailResult = await r.json().catch(() => ({}));
      if (!r.ok) emailResult = { error: emailResult?.error || "send-email failed" };
    }

    return res.status(200).json({
      count: items.length,
      totalWasted,
      lookbackDays,
      lowStockThreshold,
      items,
      emailed: !!(send && to && items.length > 0),
      emailResult,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "stockout-alert failed" });
  }
}
