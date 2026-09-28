// The one scheduled morning email, replacing four that used to arrive separately:
//   1. Daily Performance Report          — endpoint deleted; its KPIs and top-5 lists live here
//   2. Ad Spend on Out-of-Stock Products (/api/stockout-alert)
//   3. Bleeding Campaigns                (/api/ad-alerts)
//   4. Wasted Search Terms               (/api/ad-alerts)
//
// The three alert endpoints still exist for manual one-off sends; this calls the same shared
// detectors (src/lib/stockout.ts, src/lib/adAlerts.ts), so the numbers agree. The old daily
// report did not — it recomputed its own counts from a single day with a separate heuristic
// while the alerts used a 7-day lookback, so the two disagreed on the same morning.
//
// Skips the actual email when SellerMate returns no real numbers for the day (totalSales,
// adSpend, adSales and orders all zero) — that combination isn't "a quiet day" for an active
// account, it's SellerMate's sync lag or an API hiccup for that single day (the 7-day-lookback
// bleeding/wasted-term detectors below can still show real, non-zero numbers on that same
// no-data day, which is what a zero-everywhere-except-alerts email looked like and prompted
// this change). The response JSON below still reports `emailed:false` either way, so a genuinely
// broken cron stays visible in the Vercel logs even though no confusing mail goes out.
//
// POST body: { slot?, amazon_account_id, workspace_id, to, cc?, currency?, date?, send?,
//              acosThreshold?, minSpend?, lookbackDays?, lowStockThreshold?, attachWorkbook? }

import type { NextApiRequest, NextApiResponse } from "next";
import { findBleedingCampaigns, findWastedSearchTerms, resolveSellerMateKey, fetchAsinSkuMap } from "@/lib/adAlerts";
import { findStockoutAdSpend } from "@/lib/stockout";
import { buildAmazonSalesWorkbook } from "@/lib/amazonSalesExport";
import { resolveProductName } from "@/lib/categoryMap";
import { internalFetch, internalOrigin } from "@/lib/internalFetch";
import { checkInternal, guard } from "@/lib/apiAuth";
import * as XLSX from "xlsx-js-style";

const SELLERMATE_BASE_URL = "https://api.sellermate.ai/public/v1/tools";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callTool(tool: string, args: Record<string, any>, apiKey: string, attempt = 0): Promise<any> {
  const r = await fetch(`${SELLERMATE_BASE_URL}/${tool}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify(args),
  });
  // SellerMate's rate limit is on requests IN FLIGHT at once, not per-minute — this file fires 8
  // calls in one Promise.all below (several of which fan out into more of their own), which
  // routinely trips it. Every call site catches its own failure down to an empty/zero default (by
  // design — one flaky call must not kill the whole digest), but that meant a 429 here read
  // exactly like "genuinely nothing to report": Inventory Health showed Out of Stock/Low Stock/
  // Value all as 0 on a day SellerMate was simply rejecting this call, not because the account
  // had zero inventory issues. Retry with backoff before letting it fall through to that default.
  if (r.status === 429 && attempt < 3) {
    await new Promise((res) => setTimeout(res, 600 * (attempt + 1)));
    return callTool(tool, args, apiKey, attempt + 1);
  }
  if (!r.ok) throw new Error(`${tool}: ${await r.text()}`);
  return r.json();
}

// get_inventory paginates at 200/page — a single call (this file's old behaviour) silently
// truncated any account with more than 200 SKUs, undercounting Out of Stock/Low Stock/Value
// against whatever fell on later pages. Same page-until-exhausted pattern as the stockout
// forecast detector in liveAlerts.ts, capped at 10 pages (2000 items) as a runaway backstop.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAllInventory(amazon_account_id: string, workspace_id: string, apiKey: string): Promise<any[]> {
  const items: any[] = [];
  let offset = 0;
  for (let i = 0; i < 10; i++) {
    const page = await callTool("get_inventory", { amazon_account_id, workspace_id, limit: 200, offset }, apiKey);
    const pageItems: any[] = page.items || [];
    items.push(...pageItems);
    if (pageItems.length === 0 || offset + pageItems.length >= (page.total || 0)) break;
    offset += pageItems.length;
  }
  return items;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  // Cron/server-only: callable solely via internalFetch (signed with INTERNAL_API_SECRET).
  if (!guard(req, res, checkInternal)) return;

  const {
    slot = "B", amazon_account_id, workspace_id, to, cc, currency = "INR",
    date, send = true, accountName = "B-ARM",
    acosThreshold = 40, minSpend = 500, lookbackDays = 7, lowStockThreshold = 5,
    // The detailed per-product workbook lives in the Monday weekly report, which is built from the
    // uploaded SKU-level exports and carries the full Growth Summary with category insights. The
    // daily attachment is the Amazon Sales report (daily buckets, last 7 days, from the synced MIS
    // tables) — a thinner second copy of the same figures — so the digest ships as a body-only
    // email by default. Pass attachWorkbook:true to get it back for a one-off.
    attachWorkbook = false,
  } = req.body || {};

  if (!amazon_account_id || !workspace_id) {
    return res.status(400).json({ error: "amazon_account_id and workspace_id are required" });
  }
  const apiKey = resolveSellerMateKey(slot === "B" ? "B" : "A");
  if (!apiKey) return res.status(500).json({ error: `Missing SellerMate API key for slot ${slot}` });

  // Default to yesterday — the current day is still inside Amazon's reporting sync lag.
  let day = date as string | undefined;
  if (!day) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    day = d.toISOString().slice(0, 10);
  }
  const base = { amazon_account_id, workspace_id, start_date: day, end_date: day };
  const dateLabel = new Date(day + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  // The single day before `day` — purely for the KPI block's day-over-day trend arrows. A bare
  // "Total Sales ₹1,70,815" doesn't say whether that's a good day or a bad one; comparing against
  // the prior day does. Kept to just Sales/Spend/Orders/Units (retail + campaign summaries) rather
  // than re-running every detector for a second day, which isn't worth the extra SellerMate calls.
  const prevDay = (() => { const d = new Date(day + "T00:00:00"); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();
  const prevBase = { amazon_account_id, workspace_id, start_date: prevDay, end_date: prevDay };

  try {
    // Every call here must degrade to an empty/zero default on failure, never throw — a single
    // SellerMate hiccup on any one of these previously took the whole Promise.all down, which
    // killed the entire digest send with nothing surfaced anywhere the recipient would see it
    // (only a Vercel function log nobody was watching). That silently reproduced exactly the
    // "quiet day vs. broken cron" ambiguity this digest exists to avoid — see the file comment
    // above. The KPI block reports the single day; the three detectors below it look back
    // `lookbackDays`.
    const [cp, st, prod, retail, inv, stockoutItems, bleedingItems, wasted, prevCp, prevRetail] = await Promise.all([
      callTool("get_campaign_performance", { ...base, page_size: 500 }, apiKey).catch(() => ({ data: [], summary: {} })),
      callTool("get_search_term_performance", { ...base, page_size: 100, sort_field: "attributedSales14d", sort_direction: "desc" }, apiKey).catch(() => ({ data: [] })),
      callTool("get_advertised_product_performance", { ...base, page_size: 100, sort_field: "attributedSales14d", sort_direction: "desc" }, apiKey).catch(() => ({ data: [] })),
      callTool("get_retail_product_performance", { ...base, page_size: 500 }, apiKey).catch(() => ({ summary: {} })),
      fetchAllInventory(amazon_account_id, workspace_id, apiKey).catch(() => []),
      findStockoutAdSpend({ apiKey, amazon_account_id, workspace_id, lowStockThreshold, lookbackDays }).catch(() => []),
      findBleedingCampaigns({ apiKey, amazon_account_id, workspace_id, acosThreshold, minSpend, lookbackDays }).catch(() => []),
      findWastedSearchTerms({ apiKey, amazon_account_id, workspace_id, minSpend: 100, lookbackDays }).catch(() => ({ terms: [], totalWasted: 0 })),
      callTool("get_campaign_performance", { ...prevBase, page_size: 500 }, apiKey).catch(() => ({ summary: {} })),
      callTool("get_retail_product_performance", { ...prevBase, page_size: 500 }, apiKey).catch(() => ({ summary: {} })),
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cpRows: any[] = cp.data || [];
    const cs = cp.summary || {};
    const rs = retail.summary || {};
    const prevCs = prevCp.summary || {};
    const prevRs = prevRetail.summary || {};
    // Undefined (not 0) when the prior day genuinely has no comparable data, so the email can
    // omit the trend arrow instead of rendering a misleading "-100%" against a blank baseline.
    const pct = (nowV: number, prevV: number): number | undefined => (prevV > 0 ? (nowV - prevV) / prevV : undefined);
    const previousMetrics = {
      totalSales: prevRs.totalSales || prevCs.totalSales || 0,
      adSpend: prevCs.totalSpend || 0,
      orders: prevCs.totalOrders || 0,
      units: prevRs.totalUnitsOrdered || 0,
    };

    const metrics = {
      totalSales: rs.totalSales || cs.totalSales || 0,
      adSpend: cs.totalSpend || 0,
      adSales: rs.totalAdSales || cs.totalSales || 0,
      roas: cs.overallRoas || 0,
      acos: cs.overallAcos || 0,
      orders: cs.totalOrders || 0,
      units: rs.totalUnitsOrdered || 0,
    };
    const deltas = {
      totalSales: pct(metrics.totalSales, previousMetrics.totalSales),
      adSpend: pct(metrics.adSpend, previousMetrics.adSpend),
      orders: pct(metrics.orders, previousMetrics.orders),
      units: pct(metrics.units, previousMetrics.units),
    };

    const topCampaigns = [...cpRows]
      .filter((c) => c.sales > 0).sort((a, b) => b.sales - a.sales).slice(0, 5)
      .map((c) => ({ name: c.campaignName, sales: c.sales, acos: c.acos }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const topTerms = (st.data || []).filter((t: any) => t.sales > 0).slice(0, 5)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((t: any) => ({ term: t.searchTerm, sales: t.sales, orders: t.orders }));

    const skuByAsin = await fetchAsinSkuMap({ apiKey, amazon_account_id, workspace_id }).catch(() => new Map<string, string[]>());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const topProducts = (prod.data || []).filter((p: any) => p.sales > 0).slice(0, 5)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((p: any) => {
        const sku = (skuByAsin.get(p.adAsin) || [])[0] || "";
        return { name: resolveProductName(p.adProductName, sku) || p.adProductName, sales: p.sales, acos: p.acos };
      });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const invItems: any[] = inv || [];
    let outOfStock = 0, low = 0, totalValue = 0;
    for (const it of invItems) {
      const q = (it.fbm?.quantity || 0) + (it.fba?.endingWarehouseBalance || 0);
      totalValue += q * (it.price || 0);
      if (q === 0) outOfStock++; else if (q <= 5) low++;
    }

    const wastedTerms = wasted.terms || [];
    const emailData = {
      dateLabel, accountName, currency, metrics, deltas,
      stockoutItems, bleedingItems, wastedTerms,
      topCampaigns, topProducts, topTerms,
      inventory: { outOfStock, low, totalValue },
    };

    // Full per-SKU workbook, same as the Reports page's Amazon Daily Sales download. Best-effort:
    // the digest must still go out if the workbook build fails.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let attachments: any[] | undefined;
    if (attachWorkbook) {
      try {
        const weekStart = new Date(day + "T00:00:00Z");
        weekStart.setUTCDate(weekStart.getUTCDate() - 6);
        const { wb, filename } = await buildAmazonSalesWorkbook({
          startDate: weekStart.toISOString().slice(0, 10), endDate: day, granularity: "daily",
        });
        const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
        attachments = [{ filename, content: buf.toString("base64"), encoding: "base64" }];
      } catch (err) {
        console.error("[Marketplace360] Daily digest attachment failed:", err);
      }
    }

    // All four headline numbers at zero means SellerMate had nothing for this single day —
    // see the file header comment. Sending anyway is what produced a "₹0 sales, ₹89,906 at
    // risk" email that read as broken rather than quiet.
    const hasRealData = metrics.totalSales > 0 || metrics.adSpend > 0 || metrics.adSales > 0 || metrics.orders > 0;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let emailResult: any = null;
    if (send && to && hasRealData) {
      const r = await internalFetch(`${internalOrigin()}/api/send-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "dailyDigest", to, cc, data: emailData, attachments }),
      });
      emailResult = await r.json().catch(() => ({}));
      if (!r.ok) emailResult = { error: emailResult?.error || "send-email failed" };
    } else if (send && to && !hasRealData) {
      console.warn(`[Marketplace360] Daily digest for ${day} skipped — SellerMate returned no sales/spend/orders for this day (sync lag or API issue).`);
    }

    return res.status(200).json({
      // Status metadata only — the sales/spend figures go out in the email, not in this response
      // (whose first 300 chars the cron writes to the function log).
      date: day, dateLabel,
      counts: { stockout: stockoutItems.length, bleeding: bleedingItems.length, wastedTerms: wastedTerms.length },
      attached: !!attachments,
      emailed: !!(send && to && hasRealData),
      skippedNoData: !!(send && to && !hasRealData),
      emailResult,
    });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : "daily-digest failed" });
  }
}
