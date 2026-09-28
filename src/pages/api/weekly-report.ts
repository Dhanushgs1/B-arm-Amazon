// Weekly report: compares this week vs last week (WoW) across sales, units,
// ad spend/sales, ROAS and returns, plus per-product Top Gainers / Top Decliners.
// Emails via the "weeklyReport" template. Used by the Settings button and cron.
//
// POST body: { slot?, amazon_account_id, workspace_id, to, currency?, endDate?, send? }
// endDate: last day of "this week" (default: yesterday).

import type { NextApiRequest, NextApiResponse } from "next";
import { buildWeeklySalesWorkbookFromHistorical } from "@/lib/weeklySalesExport";
import { fetchAllRows } from "@/lib/historicalAnalysisReportExport";
import { spCampaignDays, isSplitCoveredCampaignRow } from "@/lib/amazonSpendRules";
import { weekAdKpis, roasOf, acosPctOf, productMapForPeriod } from "@/lib/weeklyEmailKpis";
import { internalFetch, internalOrigin } from "@/lib/internalFetch";
import { checkSessionOrInternal, guard, isInternalRequest } from "@/lib/apiAuth";
import { readEmailSettings } from "@/lib/emailSettingsStore";
import * as XLSX from "xlsx-js-style";

// See send-email.ts's own config comment — this route's Supabase fetches (MIS orders/returns
// across two weeks, ad-spend tables, the attached workbook) can run long, so it needs the same
// raised Vercel timeout.
export const config = {
  maxDuration: 300,
};

// Every KPI in this email (Total Sales, Units Ordered, Ad Spend, Ad Sales, ROAS, ACOS, Returns) is
// sourced from the app's own synced/uploaded data — the attached Weekly Sales workbook's own totals
// (MIS orders + AM/FBA/SellerFlex returns) and the barm_amazon_sp/sb/sd_campaign ad-spend tables — never from a live
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

// Week ad KPIs (weekAdKpis in weeklyEmailKpis.ts) sum spend AND sales over every day of the week.
// SP spend is a plain sum of every SP-table row (the seller's rule for every report), which includes
// the seller's per-SKU split of Brand/Display spend; an SB/SD campaign-day already split that way is
// dropped so its spend isn't counted twice (24 Sep 2026). SB/SD sales are kept for those days — the
// split rows carry spend only, so Ad Sales would otherwise lose that campaign's attributed sales.
function adKpisForWeek(spRows: any[], sbRows: any[], sdRows: any[], start: string, end: string) {
  const splitDays = spCampaignDays(spRows);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spendOnly = (r: any) => (isSplitCoveredCampaignRow(r, splitDays) ? { ...r, spend: 0 } : r);
  return weekAdKpis(spRows, sbRows.map(spendOnly), sdRows.map(spendOnly), start, end);
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
  // Browser-facing (Reports and Settings buttons) and called by cron: session or signed call.
  if (!guard(req, res, checkSessionOrInternal)) return;

  const { slot = "B", amazon_account_id, workspace_id, to: bodyTo, cc: bodyCc, recipients, currency = "INR", endDate, send = true, accountName = "B-ARM" } = req.body || {};
  if (!amazon_account_id || !workspace_id) return res.status(400).json({ error: "amazon_account_id and workspace_id are required" });
  // Recipients are never taken from a browser request. A signed server call (the cron) passes the
  // saved notifEmail/ccEmail as to/cc; the Settings button asks for recipients:"saved" and gets
  // this slot's saved settings; anything else (the Reports page "Send") gets the fixed list.
  let toBody: string | undefined, ccBody: string | undefined;
  if (isInternalRequest(req.headers)) {
    toBody = bodyTo; ccBody = bodyCc;
  } else if (recipients === "saved") {
    const saved = await readEmailSettings(slot === "A" ? "A" : "B");
    if (!saved.notifEmail) return res.status(400).json({ error: "No alert email saved in Settings" });
    toBody = saved.notifEmail; ccBody = saved.ccEmail || undefined;
  }
  // Fallback applies only when no recipient was resolved above — gating the whole fallback on
  // `to` (not `cc` individually) keeps an intentional "no CC" from being overwritten with DEFAULT_CC.
  const to = toBody !== undefined ? toBody : DEFAULT_TO;
  const cc = toBody !== undefined ? ccBody : DEFAULT_CC;

  // Windows: this week = [end-6, end]; last week = [end-13, end-7]. Default end = yesterday.
  let end = endDate as string | undefined;
  if (!end) { const d = new Date(); d.setDate(d.getDate() - 1); end = iso(d); }
  const endD = new Date(end + "T00:00:00");
  const thisStart = new Date(endD); thisStart.setDate(endD.getDate() - 6);
  const lastEnd = new Date(endD); lastEnd.setDate(endD.getDate() - 7);
  const lastStart = new Date(endD); lastStart.setDate(endD.getDate() - 13);
  const T = { start: iso(thisStart), end }, L = { start: iso(lastStart), end: iso(lastEnd) };

  try {
    // Sales, units and returns are the attached workbook's own figures (same build, same rows), so
    // the email body can never disagree with its attachment: Total Sales is the workbook's net-of-
    // returns Total Sales, Units Ordered its Orders, and Returns shows both its All Returns and its
    // Customer Returns units (AM + FBA + SellerFlex; customer = courier RTO excluded), per the
    // seller's choice — IST days, end date included.
    const built = await buildWeeklySalesWorkbookFromHistorical({ thisWeek: T, lastWeek: L });
    const totalsFor = (w: { start: string; end: string }) => built.periodTotals.find((p) => p.start === w.start && p.end === w.end)!;
    const tTot = totalsFor(T), lTot = totalsFor(L);
    const tMap = productMapForPeriod(built.productPeriods, tTot.label);
    const lMap = productMapForPeriod(built.productPeriods, lTot.label);
    const tSalesTotal = tTot.totalSales, lSalesTotal = lTot.totalSales;
    const tUnitsTotal = tTot.orders, lUnitsTotal = lTot.orders;
    const returnsStr = (t: { allReturns: number; customerReturns: number }) => `${t.allReturns} (${t.customerReturns} customer)`;

    // One fetch spanning both weeks (14 days), split by date below — same "fetch once, filter
    // twice" approach the rest of this file (and historicalAnalysisReportExport.ts) uses.
    const { spRows, sbRows, sdRows } = await fetchWeeklyAdRows(L.start, T.end);
    const tAd = adKpisForWeek(spRows, sbRows, sdRows, T.start, T.end);
    const lAd = adKpisForWeek(spRows, sbRows, sdRows, L.start, L.end);
    const roas = roasOf, acos = acosPctOf;

    const money = (v: number) => (currency === "INR" ? "₹" : "$") + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(v || 0));
    const compare = [
      { label: "Total Sales", lastStr: money(lSalesTotal), thisStr: money(tSalesTotal), deltaPct: pctChange(lSalesTotal, tSalesTotal), goodUp: true },
      { label: "Units Ordered", lastStr: String(lUnitsTotal || 0), thisStr: String(tUnitsTotal || 0), deltaPct: pctChange(lUnitsTotal, tUnitsTotal), goodUp: true },
      { label: "Ad Spend", lastStr: money(lAd.spend), thisStr: money(tAd.spend), deltaPct: pctChange(lAd.spend, tAd.spend), goodUp: false },
      { label: "Ad Sales", lastStr: money(lAd.adSales), thisStr: money(tAd.adSales), deltaPct: pctChange(lAd.adSales, tAd.adSales), goodUp: true },
      { label: "ROAS", lastStr: roas(lAd).toFixed(2) + "x", thisStr: roas(tAd).toFixed(2) + "x", deltaPct: pctChange(roas(lAd), roas(tAd)), goodUp: true },
      { label: "ACOS", lastStr: acos(lAd).toFixed(1) + "%", thisStr: acos(tAd).toFixed(1) + "%", deltaPct: pctChange(acos(lAd), acos(tAd)), goodUp: false },
      // Week-over-week % tracks All Returns — the figure Total Orders is reduced by.
      { label: "Returns", lastStr: returnsStr(lTot), thisStr: returnsStr(tTot), deltaPct: pctChange(lTot.allReturns, tTot.allReturns), goodUp: false },
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

    // Department breakdown, this week AND last week — the workbook's own per-product rows and the
    // department each carries there (Product Master first, categoryMap.ts fallback).
    function aggregateByDept(map: ReturnType<typeof productMapForPeriod>) {
      const agg = new Map<string, { sales: number; units: number }>();
      for (const p of map.values()) {
        const dept = p.category;
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
      const buf = XLSX.write(built.wb, { type: "buffer", bookType: "xlsx" });
      attachments = [{ filename: built.filename, content: buf.toString("base64"), encoding: "base64" }];
    } catch (err) {
      console.error("[Marketplace360] Weekly Amazon Sales Report attachment failed:", err);
    }

    let emailResult: any = null;
    if (send && to) {
      const r = await internalFetch(`${internalOrigin()}/api/send-email`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "weeklyReport", to, cc, data: emailData, attachments }),
      });
      emailResult = await r.json().catch(() => ({}));
      if (!r.ok) emailResult = { error: emailResult?.error || "send-email failed" };
    }

    // Only what the UIs read (Settings shows whatsappText); the report body itself goes out by email.
    return res.status(200).json({ thisWeek: T, lastWeek: L, whatsappText, emailed: !!(send && to), emailResult });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "weekly-report failed" });
  }
}
