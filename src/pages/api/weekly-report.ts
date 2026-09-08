// Weekly report: compares this week vs last week (WoW) across sales, units,
// ad spend/sales, ROAS and returns, plus per-product Top Gainers / Top Decliners.
// Emails via the "weeklyReport" template. Used by the Settings button and cron.
//
// POST body: { slot?, amazon_account_id, workspace_id, to, currency?, endDate?, send? }
// endDate: last day of "this week" (default: yesterday).

import type { NextApiRequest, NextApiResponse } from "next";
import { buildWeeklySalesWorkbookFromHistorical } from "@/lib/weeklySalesExport";
import { fetchAllRows } from "@/lib/historicalAnalysisReportExport";
import { istDayWindowUtc, isStandardOrderId, isGenuineFbaReturn } from "@/lib/amazonReportShared";
import { fetchMisAmazonOrders, fetchMisFbaReturns } from "@/lib/misAdapters";
import { categorizeTitle, resolveProductName } from "@/lib/categoryMap";
import { internalFetch, internalOrigin } from "@/lib/internalFetch";
import * as XLSX from "xlsx-js-style";

// Every KPI in this email (Total Sales, Units Ordered, Ad Spend, Ad Sales, ROAS, ACOS, Returns) is
// sourced from the app's own synced/uploaded data — the MIS tables (fetchMisAmazonOrders,
// fetchMisFbaReturns) and the barm_amazon_sp/sb/sd_campaign ad-spend tables — never from a live
// SellerMate API call. This used to call SellerMate's get_retail_product_performance /
// get_fba_customer_returns for these numbers; that was replaced after confirming (see the
// ppc-dashboard-sellermate-summary-bug finding) that get_retail_product_performance is inflated
// ~1.7-2.2x at the source for this account, and per the seller's own standing instruction that no
// downloadable/emailed report may source figures from a live SellerMate pull.
async function fetchWeeklyAdRows(start: string, end: string) {
  const [spRows, sbRows, sdRows] = await Promise.all([
    fetchAllRows("barm_amazon_sp_advertised_product", (q: any) => q.gte("report_date", start).lte("report_date", end)),
    fetchAllRows("barm_amazon_sb_campaign", (q: any) => q.gte("report_date", start).lte("report_date", end)),
    fetchAllRows("barm_amazon_sd_campaign", (q: any) => q.gte("report_date", start).lte("report_date", end)),
  ]);
  return { spRows, sbRows, sdRows };
}

// Spend is a normal per-day figure on every ad-report row, safe to sum across the window. Sales
// fields with an "Nd" rolling-attribution-window name (sp's sales_7d, sd's sales_14d) are NOT —
// summing those across multiple days' rows would multiply-count the same rolling total, so each is
// read only once, off the window's own end-date row (same convention adSpendReportExport.ts's
// enrichAmazonActionRows uses). SB's plain "sales" field is per-day, so it's summed like spend.
function weekAdKpis(
  spRows: any[], sbRows: any[], sdRows: any[], start: string, end: string
): { spend: number; adSales: number } {
  const n = (v: unknown) => Number(v) || 0;
  const inRange = (r: { report_date?: string }) => !!r.report_date && r.report_date >= start && r.report_date <= end;
  const onEndDate = (rows: any[]) => rows.filter((r) => r.report_date === end);
  const spend =
    spRows.filter(inRange).reduce((s, r) => s + n(r.spend), 0) +
    sbRows.filter(inRange).reduce((s, r) => s + n(r.spend), 0) +
    sdRows.filter(inRange).reduce((s, r) => s + n(r.spend), 0);
  const adSales =
    onEndDate(spRows).reduce((s, r) => s + n(r.sales_7d), 0) +
    sbRows.filter(inRange).reduce((s, r) => s + n(r.sales), 0) +
    onEndDate(sdRows).reduce((s, r) => s + n(r.sales_14d), 0);
  return { spend, adSales };
}

// Local Y-M-D (avoid toISOString's UTC shift on an IST server, which would
// slide every window back a day).
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const label = (a: string, b: string) => {
  const f = (s: string) => new Date(s + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  return `${f(a)} – ${f(b)}`;
};
const pctChange = (last: number, now: number) => {
  if (!last) return now > 0 ? 100 : 0;
  return ((now - last) / last) * 100;
};

// SKU-wise, sourced from the uploaded Orders export (barm_amazon_am_orders) instead of
// SellerMate's live get_retail_product_performance tool — that API only exposes ASIN-level data,
// while the uploaded raw export carries the real per-order SKU.
async function retailMapBySku(start: string, end: string) {
  // IST calendar day (istDayWindowUtc), not the raw UTC purchase_date column —
  // matching historicalAnalysisReportExport.ts's convention. Filtering by the
  // raw UTC date instead put orders from the last ~5.5 hours of the UTC day on
  // the wrong side of the window, so this route's per-SKU movers (and the
  // Units Ordered summary line) could disagree with the attached Weekly Sales
  // Report XLSX by exactly the boundary orders.
  const window = istDayWindowUtc(start, end);
  const [rows, priceRows] = await Promise.all([
    fetchMisAmazonOrders((q) => q.gte("purchase_datetime", window.gte).lt("purchase_datetime", window.lt)),
    fetchAllRows("barm_amazon_price_listing", (q) => q),
  ]);
  const listingPriceBySku = new Map<string, number>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const r of priceRows as any[]) {
    const price = Number(r.price) || 0;
    if (r.seller_sku && price > 0 && !listingPriceBySku.has(r.seller_sku)) listingPriceBySku.set(r.seller_sku, price);
  }
  const map = new Map<string, { name: string; sku: string; sales: number; units: number }>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const r of rows as any[]) {
    if (!r.sku) continue;
    const cur = map.get(r.sku) || { name: "", sku: r.sku, sales: 0, units: 0 };
    if (r.product_name && !cur.name) cur.name = r.product_name;
    // Same corrections as the Excel builder (see weeklySalesExport.ts): item_price is the line
    // total, cancelled/non-standard-order-id rows aren't real sales, and a 0 price on a real
    // shipment falls back to the listing price. The email body and the attachment must not disagree.
    if (String(r.order_status || "").toLowerCase().startsWith("cancelled")) continue;
    if (!isStandardOrderId(r.amazon_order_id)) continue;
    const qty = r.quantity || 0;
    const linePrice = Number(r.item_price) || 0;
    cur.sales += linePrice > 0 ? linePrice : qty * (listingPriceBySku.get(r.sku) || 0);
    cur.units += qty;
    map.set(r.sku, cur);
  }
  map.forEach((p) => { p.name = resolveProductName(p.name || p.sku, p.sku) || p.name || p.sku; });
  return map;
}

// FBA returns in the window, same "genuine return" filter (excludes courier RTO/undeliverable
// parcels) the Historical Analysis Report and Weekly Sales Report attachment already use — counts
// return events (rows), matching what the old get_fba_customer_returns total_count represented.
async function returnsCount(start: string, end: string): Promise<number> {
  const rows = await fetchMisFbaReturns((q: any) => q.gte("return_date", start).lte("return_date", end));
  return rows.filter((r: any) => isGenuineFbaReturn(r)).length;
}

// Same fixed distribution list as send-ad-spend-email.ts / send-historical-email.ts — used only
// when the caller doesn't pass `to` (the Reports page's own manual "Send" button, which — like
// those two — has no per-account Settings row to read a recipient from). The cron and the Settings
// page's "Send Weekly Report Now" button always pass an explicit `to`/`cc` (Settings' notifEmail/
// ccEmail), so this fallback never overrides either of those.
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

  const { slot = "B", amazon_account_id, workspace_id, to: toBody, cc: ccBody, currency = "INR", endDate, send = true, accountName = "B-ARM" } = req.body || {};
  if (!amazon_account_id || !workspace_id) return res.status(400).json({ error: "amazon_account_id and workspace_id are required" });
  // Fallback applies only when the caller omits `to` entirely (the Reports page's manual "Send",
  // the only caller with no per-account recipient to pass). The Settings page and the cron always
  // pass an explicit `to` (Settings' notifEmail) but send `cc: ccEmail || undefined` when the
  // account has no CC configured — gating the whole fallback on `to` (not `cc` individually) keeps
  // that intentional "no CC" from being overwritten with DEFAULT_CC.
  const to = toBody !== undefined ? toBody : DEFAULT_TO;
  const cc = toBody !== undefined ? ccBody : (ccBody !== undefined ? ccBody : DEFAULT_CC);

  // Windows: this week = [end-6, end]; last week = [end-13, end-7]. Default end = yesterday.
  let end = endDate as string | undefined;
  if (!end) { const d = new Date(); d.setDate(d.getDate() - 1); end = iso(d); }
  const endD = new Date(end + "T00:00:00");
  const thisStart = new Date(endD); thisStart.setDate(endD.getDate() - 6);
  const lastEnd = new Date(endD); lastEnd.setDate(endD.getDate() - 7);
  const lastStart = new Date(endD); lastStart.setDate(endD.getDate() - 13);
  const T = { start: iso(thisStart), end }, L = { start: iso(lastStart), end: iso(lastEnd) };

  try {
    // Per-product data is SKU-wise, sourced from the uploaded Orders export (see retailMapBySku).
    const tMap = await retailMapBySku(T.start, T.end);
    const lMap = await retailMapBySku(L.start, L.end);
    const tSalesTotal = [...tMap.values()].reduce((s, p) => s + p.sales, 0);
    const lSalesTotal = [...lMap.values()].reduce((s, p) => s + p.sales, 0);
    const tUnitsTotal = [...tMap.values()].reduce((s, p) => s + p.units, 0);
    const lUnitsTotal = [...lMap.values()].reduce((s, p) => s + p.units, 0);

    // One fetch spanning both weeks (14 days), split by date below — same "fetch once, filter
    // twice" approach the rest of this file (and historicalAnalysisReportExport.ts) uses.
    const { spRows, sbRows, sdRows } = await fetchWeeklyAdRows(L.start, T.end);
    const tAd = weekAdKpis(spRows, sbRows, sdRows, T.start, T.end);
    const lAd = weekAdKpis(spRows, sbRows, sdRows, L.start, L.end);
    const roas = (a: { spend: number; adSales: number }) => (a.spend > 0 ? a.adSales / a.spend : 0);
    const acos = (a: { spend: number; adSales: number }) => (a.adSales > 0 ? (a.spend / a.adSales) * 100 : 0);

    const retThis = await returnsCount(T.start, T.end);
    const retLast = await returnsCount(L.start, L.end);

    const money = (v: number) => (currency === "INR" ? "₹" : "$") + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(v || 0));
    const compare = [
      { label: "Total Sales", lastStr: money(lSalesTotal), thisStr: money(tSalesTotal), deltaPct: pctChange(lSalesTotal, tSalesTotal), goodUp: true },
      { label: "Units Ordered", lastStr: String(lUnitsTotal || 0), thisStr: String(tUnitsTotal || 0), deltaPct: pctChange(lUnitsTotal, tUnitsTotal), goodUp: true },
      { label: "Ad Spend", lastStr: money(lAd.spend), thisStr: money(tAd.spend), deltaPct: pctChange(lAd.spend, tAd.spend), goodUp: false },
      { label: "Ad Sales", lastStr: money(lAd.adSales), thisStr: money(tAd.adSales), deltaPct: pctChange(lAd.adSales, tAd.adSales), goodUp: true },
      { label: "ROAS", lastStr: roas(lAd).toFixed(2) + "x", thisStr: roas(tAd).toFixed(2) + "x", deltaPct: pctChange(roas(lAd), roas(tAd)), goodUp: true },
      { label: "ACOS", lastStr: acos(lAd).toFixed(1) + "%", thisStr: acos(tAd).toFixed(1) + "%", deltaPct: pctChange(acos(lAd), acos(tAd)), goodUp: false },
      { label: "Returns", lastStr: String(retLast), thisStr: String(retThis), deltaPct: pctChange(retLast, retThis), goodUp: false },
    ];

    // Per-product movers: only products with meaningful sales in either week
    const skus = new Set<string>([...tMap.keys(), ...lMap.keys()]);
    const movers: any[] = [];
    for (const sku of skus) {
      const t = tMap.get(sku), l = lMap.get(sku);
      const thisSales = t?.sales || 0, lastSales = l?.sales || 0;
      if (thisSales < 500 && lastSales < 500) continue; // ignore noise
      movers.push({ name: t?.name || l?.name || sku, this: thisSales, last: lastSales, diff: thisSales - lastSales, deltaPct: pctChange(lastSales, thisSales) });
    }
    const gainers = movers.filter((m) => m.diff > 0).sort((a, b) => b.diff - a.diff).slice(0, 5);
    const losers = movers.filter((m) => m.diff < 0).sort((a, b) => a.diff - b.diff).slice(0, 5);
    // Best Sellers: top 5 by raw sales THIS week, regardless of growth direction — distinct from
    // Gainers/Decliners above, which rank by week-over-week change instead of absolute volume.
    const bestSellers = [...movers].sort((a, b) => b.this - a.this).slice(0, 5);

    // Platform line: only Amazon is connected today — structured as a list so
    // Flipkart/other marketplaces can be appended here once wired up.
    const platforms = [{ name: "Amazon", sales: tSalesTotal || 0 }];

    // Department breakdown, this week AND last week — reuses the same per-product rows already
    // fetched above, categorized via the product->department map (categoryMap.ts).
    function aggregateByDept(map: Map<string, { name: string; sku: string; sales: number; units: number }>) {
      const agg = new Map<string, { sales: number; units: number }>();
      for (const [sku, p] of map.entries()) {
        const dept = categorizeTitle(p.name, undefined, sku);
        const d = agg.get(dept) || { sales: 0, units: 0 };
        d.sales += p.sales;
        d.units += p.units;
        agg.set(dept, d);
      }
      return agg;
    }
    const deptThis = aggregateByDept(tMap);
    const deptLast = aggregateByDept(lMap);
    const deptNames = new Set<string>([...deptThis.keys(), ...deptLast.keys()]);
    const departments = [...deptNames]
      .map((name) => {
        const t = deptThis.get(name) || { sales: 0, units: 0 };
        const l = deptLast.get(name) || { sales: 0, units: 0 };
        return { name, sales: t.sales, units: t.units, lastSales: l.sales, lastUnits: l.units, deltaPct: pctChange(l.sales, t.sales) };
      })
      .sort((a, b) => b.sales - a.sales);

    const emailData = {
      currency, accountName,
      thisLabel: label(T.start, T.end), lastLabel: label(L.start, L.end),
      compare, gainers, losers, bestSellers, platforms, departments,
    };

    // Plain-text version of the two summary lines Barath sir asked for, formatted
    // for copy-pasting straight into a WhatsApp message.
    const waMoney = (v: number) => (currency === "INR" ? "₹" : "$") + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(v || 0));
    const whatsappText = [
      `📈 *Weekly Performance Report* — ${accountName}`,
      `${emailData.thisLabel} vs ${emailData.lastLabel}`,
      "",
      `🛒 *Platform Sales:* ${platforms.map((p) => `${p.name} ${waMoney(p.sales)}`).join(" · ")} → *Total ${waMoney(tSalesTotal || 0)}* (${pctChange(lSalesTotal, tSalesTotal) >= 0 ? "▲" : "▼"} ${Math.abs(pctChange(lSalesTotal, tSalesTotal)).toFixed(1)}% WoW)`,
      `🏥 *Department Breakup:* ${departments.map((d) => `${d.name} ${waMoney(d.sales)} (${d.units} units)`).join(" · ")}`,
    ].join("\n");

    // Attach the full per-SKU Amazon Sales Report spanning last week + this week — same L/T
    // window as the WoW comparison above, so the attachment's Growth Summary sheet lines up
    // exactly with the email body. Sourced from uploaded data (barm_amazon_am_orders/returns),
    // not the live API. Best-effort: a failure here must not block the email itself.
    let attachments: any[] | undefined;
    try {
      const { wb, filename } = await buildWeeklySalesWorkbookFromHistorical({ thisWeek: T, lastWeek: L });
      const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
      attachments = [{ filename, content: buf.toString("base64"), encoding: "base64" }];
    } catch (err) {
      console.error("[Marketplace360] Weekly Amazon Sales Report attachment failed:", err);
    }

    let emailResult: any = null;
    if (send && to) {
      const r = await internalFetch(`${internalOrigin(req)}/api/send-email`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "weeklyReport", to, cc, data: emailData, attachments }),
      });
      emailResult = await r.json().catch(() => ({}));
      if (!r.ok) emailResult = { error: emailResult?.error || "send-email failed" };
    }

    return res.status(200).json({ thisWeek: T, lastWeek: L, compare, gainers, losers, bestSellers, platforms, departments, whatsappText, emailed: !!(send && to), emailResult });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "weekly-report failed" });
  }
}
