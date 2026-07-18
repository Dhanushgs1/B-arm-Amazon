// Builds a rich daily report from live SellerMate data (yesterday by default):
// KPIs, top-5 & loss-5 campaigns, top-5 search terms, top-5 products, inventory
// health, and an action-needed alert summary. Emails via the "dailyReport"
// template. Used by the Settings "Send Daily Report Now" button and the cron.
//
// POST body: { slot?, amazon_account_id, workspace_id, to, currency?, date?, send? }
// date: YYYY-MM-DD to report on (default: yesterday).

import type { NextApiRequest, NextApiResponse } from "next";
import { resolveSellerMateKey } from "@/lib/adAlerts";
import { buildAmazonSalesWorkbookForAccount } from "@/lib/amazonSalesExport";
import * as XLSX from "xlsx-js-style";

const SELLERMATE_BASE_URL = "https://api.sellermate.ai/public/v1/tools";

async function callTool(tool: string, args: Record<string, any>, apiKey: string) {
  const r = await fetch(`${SELLERMATE_BASE_URL}/${tool}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`${tool}: ${await r.text()}`);
  return r.json();
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const {
    slot = "B", amazon_account_id, workspace_id, to, currency = "INR",
    date, send = true, accountName = "B-ARM",
  } = req.body || {};

  if (!amazon_account_id || !workspace_id) {
    return res.status(400).json({ error: "amazon_account_id and workspace_id are required" });
  }
  const apiKey = resolveSellerMateKey(slot === "B" ? "B" : "A");
  if (!apiKey) return res.status(500).json({ error: `Missing SellerMate API key for slot ${slot}` });

  // Default to "yesterday" — pass an explicit date to override (avoids Date.now surprises).
  let day = date as string | undefined;
  if (!day) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    day = d.toISOString().slice(0, 10);
  }
  const base = { amazon_account_id, workspace_id, start_date: day, end_date: day };
  const dateLabel = new Date(day + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });

  try {
    const [cp, st, prod, retail, inv] = await Promise.all([
      callTool("get_campaign_performance", { ...base, page_size: 500 }, apiKey),
      callTool("get_search_term_performance", { ...base, page_size: 100, sort_field: "attributedSales14d", sort_direction: "desc" }, apiKey),
      callTool("get_advertised_product_performance", { ...base, page_size: 100, sort_field: "attributedSales14d", sort_direction: "desc" }, apiKey),
      callTool("get_retail_product_performance", { ...base, page_size: 500 }, apiKey).catch(() => ({ summary: {} })),
      callTool("get_inventory", { amazon_account_id, workspace_id, limit: 200, offset: 0 }, apiKey),
    ]);

    const cpRows: any[] = cp.data || [];
    const cs = cp.summary || {};
    const rs = retail.summary || {};

    // KPIs
    const metrics = {
      totalSales: rs.totalSales || cs.totalSales || 0,
      adSpend: cs.totalSpend || 0,
      adSales: rs.totalAdSales || cs.totalSales || 0,
      roas: cs.overallRoas || 0,
      acos: cs.overallAcos || 0,
      orders: cs.totalOrders || 0,
      units: rs.totalUnitsOrdered || 0,
    };

    // Top / Loss campaigns
    const topCampaigns = [...cpRows]
      .filter((c) => c.sales > 0).sort((a, b) => b.sales - a.sales).slice(0, 5)
      .map((c) => ({ name: c.campaignName, sales: c.sales, acos: c.acos }));
    const lossCampaigns = [...cpRows]
      .filter((c) => c.spend > 0 && (c.orders === 0 || (c.acos != null && c.acos >= 40)))
      .sort((a, b) => b.spend - a.spend).slice(0, 5)
      .map((c) => ({ name: c.campaignName, spend: c.spend, acos: c.acos, orders: c.orders }));

    // Top search terms & products (by ad sales)
    const topTerms = (st.data || []).filter((t: any) => t.sales > 0).slice(0, 5)
      .map((t: any) => ({ term: t.searchTerm, sales: t.sales, orders: t.orders }));
    const topProducts = (prod.data || []).filter((p: any) => p.sales > 0).slice(0, 5)
      .map((p: any) => ({ name: p.adProductName, sales: p.sales, acos: p.acos }));

    // Inventory health (first page snapshot of 200 — enough for a health count)
    const invItems: any[] = inv.items || [];
    let outOfStock = 0, low = 0, totalValue = 0;
    for (const it of invItems) {
      const q = (it.fbm?.quantity || 0) + (it.fba?.endingWarehouseBalance || 0);
      totalValue += q * (it.price || 0);
      if (q === 0) outOfStock++; else if (q <= 5) low++;
    }

    // Alert counts (reuse loss-campaign heuristic; wasted-terms quick scan over the day)
    const bleeding = cpRows.filter((c) => c.spend >= 500 && (c.orders === 0 || (c.acos != null && c.acos >= 40))).length;
    const wastedTermRows = (st.data || []).filter((t: any) => t.orders === 0 && t.spend >= 100);
    const wastedTerms = wastedTermRows.length;
    const wastedSpend = wastedTermRows.reduce((a: number, t: any) => a + t.spend, 0)
      + cpRows.filter((c) => c.orders === 0 && c.spend > 0).reduce((a, c) => a + c.spend, 0);

    const emailData = {
      dateLabel, accountName, currency, metrics,
      alerts: { stockout: outOfStock, bleeding, wastedTerms, wastedSpend },
      topCampaigns, lossCampaigns, topTerms, topProducts,
      inventory: { outOfStock, low, totalValue },
    };

    // Attach the full per-product Amazon Sales Report as an Excel workbook — the email body only
    // shows top-5 lists, this gives every product. Widened to the trailing 7 days ending on `day`
    // (not just the single reported day) so the attachment's Growth Summary has two full days to
    // actually compare — a lone day has nothing to diff against. Best-effort: if it fails, the
    // report/email itself must still go out.
    let attachments: any[] | undefined;
    try {
      const weekStart = new Date(day + "T00:00:00Z");
      weekStart.setUTCDate(weekStart.getUTCDate() - 6);
      const { wb, filename } = await buildAmazonSalesWorkbookForAccount({
        apiKey, accountId: amazon_account_id, workspaceId: workspace_id,
        startDate: weekStart.toISOString().slice(0, 10), endDate: day, granularity: "daily",
      });
      const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
      attachments = [{ filename, content: buf.toString("base64"), encoding: "base64" }];
    } catch (err) {
      console.error("[BARM AI] Daily Amazon Sales Report attachment failed:", err);
    }

    let emailResult: any = null;
    if (send && to) {
      const proto = (req.headers["x-forwarded-proto"] as string) || "http";
      const host = req.headers.host;
      const r = await fetch(`${proto}://${host}/api/send-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "dailyReport", to, data: emailData, attachments }),
      });
      emailResult = await r.json().catch(() => ({}));
      if (!r.ok) emailResult = { error: emailResult?.error || "send-email failed" };
    }

    return res.status(200).json({ date: day, dateLabel, metrics, emailData, emailed: !!(send && to), emailResult });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "daily-report failed" });
  }
}
