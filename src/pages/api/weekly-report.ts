// Weekly report: compares this week vs last week (WoW) across sales, units,
// ad spend/sales, ROAS and returns, plus per-product Top Gainers / Top Decliners.
// Emails via the "weeklyReport" template. Used by the Settings button and cron.
//
// POST body: { slot?, amazon_account_id, workspace_id, to, currency?, endDate?, send? }
// endDate: last day of "this week" (default: yesterday).

import type { NextApiRequest, NextApiResponse } from "next";
import { resolveSellerMateKey } from "@/lib/adAlerts";
import { buildAmazonSalesWorkbookForAccount } from "@/lib/amazonSalesExport";
import { categorizeTitle } from "@/lib/categoryMap";
import * as XLSX from "xlsx-js-style";

const SELLERMATE_BASE_URL = "https://api.sellermate.ai/public/v1/tools";

// SellerMate cold-caches report ranges: the first hit to an un-cached window
// can be slow enough to hit its ~10s gateway timeout (500), but the attempt
// warms the cache so a retry returns fast. Retry a few times before giving up.
async function callTool(tool: string, args: Record<string, any>, apiKey: string, attempts = 4) {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(`${SELLERMATE_BASE_URL}/${tool}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
        body: JSON.stringify(args),
      });
      if (r.ok) return r.json();
      lastErr = new Error(`${tool} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    } catch (e) {
      lastErr = e;
    }
    if (i < attempts - 1) await new Promise((res) => setTimeout(res, 800));
  }
  throw lastErr;
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

async function retailMap(apiKey: string, base: any, start: string, end: string) {
  // 336 products fit in one page of 500
  const res = await callTool("get_retail_product_performance", { ...base, start_date: start, end_date: end, page_size: 500 }, apiKey);
  const map = new Map<string, { name: string; sales: number; units: number }>();
  for (const r of (res.data || [])) {
    map.set(r.asin, { name: r.productName || r.asin, sales: r.totalSales || 0, units: r.unitsOrdered || 0 });
  }
  return { map, summary: res.summary || {} };
}

async function returnsCount(apiKey: string, base: any, start: string, end: string) {
  try {
    const res = await callTool("get_fba_customer_returns", { ...base, start_date: start, end_date: end, page_size: 1 }, apiKey);
    return res.total_count ?? (res.order_returns || []).length;
  } catch { return 0; }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { slot = "B", amazon_account_id, workspace_id, to, currency = "INR", endDate, send = true, accountName = "B-ARM" } = req.body || {};
  if (!amazon_account_id || !workspace_id) return res.status(400).json({ error: "amazon_account_id and workspace_id are required" });
  const apiKey = resolveSellerMateKey(slot === "B" ? "B" : "A");
  if (!apiKey) return res.status(500).json({ error: `Missing SellerMate API key for slot ${slot}` });

  // Windows: this week = [end-6, end]; last week = [end-13, end-7]. Default end = yesterday.
  let end = endDate as string | undefined;
  if (!end) { const d = new Date(); d.setDate(d.getDate() - 1); end = iso(d); }
  const endD = new Date(end + "T00:00:00");
  const thisStart = new Date(endD); thisStart.setDate(endD.getDate() - 6);
  const lastEnd = new Date(endD); lastEnd.setDate(endD.getDate() - 7);
  const lastStart = new Date(endD); lastStart.setDate(endD.getDate() - 13);
  const T = { start: iso(thisStart), end }, L = { start: iso(lastStart), end: iso(lastEnd) };
  const base = { amazon_account_id, workspace_id };

  try {
    // Sequential — SellerMate rate-limits bursts of heavy report calls.
    const tW = await retailMap(apiKey, base, T.start, T.end);
    const lW = await retailMap(apiKey, base, L.start, L.end);
    const retThis = await returnsCount(apiKey, base, T.start, T.end);
    const retLast = await returnsCount(apiKey, base, L.start, L.end);

    const ts = tW.summary, ls = lW.summary;
    const money = (v: number) => (currency === "INR" ? "₹" : "$") + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(v || 0));
    const compare = [
      { label: "Total Sales", lastStr: money(ls.totalSales), thisStr: money(ts.totalSales), deltaPct: pctChange(ls.totalSales, ts.totalSales), goodUp: true },
      { label: "Units Ordered", lastStr: String(ls.totalUnitsOrdered || 0), thisStr: String(ts.totalUnitsOrdered || 0), deltaPct: pctChange(ls.totalUnitsOrdered, ts.totalUnitsOrdered), goodUp: true },
      { label: "Ad Spend", lastStr: money(ls.totalAdSpend), thisStr: money(ts.totalAdSpend), deltaPct: pctChange(ls.totalAdSpend, ts.totalAdSpend), goodUp: false },
      { label: "Ad Sales", lastStr: money(ls.totalAdSales), thisStr: money(ts.totalAdSales), deltaPct: pctChange(ls.totalAdSales, ts.totalAdSales), goodUp: true },
      { label: "ROAS", lastStr: (ls.overallRoas || 0).toFixed(2) + "x", thisStr: (ts.overallRoas || 0).toFixed(2) + "x", deltaPct: pctChange(ls.overallRoas, ts.overallRoas), goodUp: true },
      { label: "ACOS", lastStr: (ls.overallAcos || 0).toFixed(1) + "%", thisStr: (ts.overallAcos || 0).toFixed(1) + "%", deltaPct: pctChange(ls.overallAcos, ts.overallAcos), goodUp: false },
      { label: "Returns", lastStr: String(retLast), thisStr: String(retThis), deltaPct: pctChange(retLast, retThis), goodUp: false },
    ];

    // Per-product movers: only products with meaningful sales in either week
    const asins = new Set<string>([...tW.map.keys(), ...lW.map.keys()]);
    const movers: any[] = [];
    for (const asin of asins) {
      const t = tW.map.get(asin), l = lW.map.get(asin);
      const thisSales = t?.sales || 0, lastSales = l?.sales || 0;
      if (thisSales < 500 && lastSales < 500) continue; // ignore noise
      movers.push({ name: t?.name || l?.name || asin, this: thisSales, last: lastSales, diff: thisSales - lastSales, deltaPct: pctChange(lastSales, thisSales) });
    }
    const gainers = movers.filter((m) => m.diff > 0).sort((a, b) => b.diff - a.diff).slice(0, 5);
    const losers = movers.filter((m) => m.diff < 0).sort((a, b) => a.diff - b.diff).slice(0, 5);

    // Platform line: only Amazon is connected today — structured as a list so
    // Flipkart/other marketplaces can be appended here once wired up.
    const platforms = [{ name: "Amazon", sales: ts.totalSales || 0 }];

    // Department breakdown (this week) — reuses the same per-product rows already
    // fetched above, categorized via the product->department map (categoryMap.ts).
    const deptAgg = new Map<string, { sales: number; units: number }>();
    for (const [asin, p] of tW.map.entries()) {
      const dept = categorizeTitle(p.name, asin);
      const d = deptAgg.get(dept) || { sales: 0, units: 0 };
      d.sales += p.sales;
      d.units += p.units;
      deptAgg.set(dept, d);
    }
    const departments = [...deptAgg.entries()]
      .map(([name, v]) => ({ name, sales: v.sales, units: v.units }))
      .sort((a, b) => b.sales - a.sales);

    const emailData = {
      currency, accountName,
      thisLabel: label(T.start, T.end), lastLabel: label(L.start, L.end),
      compare, gainers, losers, platforms, departments,
    };

    // Plain-text version of the two summary lines Barath sir asked for, formatted
    // for copy-pasting straight into a WhatsApp message.
    const waMoney = (v: number) => (currency === "INR" ? "₹" : "$") + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(v || 0));
    const whatsappText = [
      `📈 *Weekly Performance Report* — ${accountName}`,
      `${emailData.thisLabel} vs ${emailData.lastLabel}`,
      "",
      `🛒 *Platform Sales:* ${platforms.map((p) => `${p.name} ${waMoney(p.sales)}`).join(" · ")} → *Total ${waMoney(ts.totalSales || 0)}* (${pctChange(ls.totalSales, ts.totalSales) >= 0 ? "▲" : "▼"} ${Math.abs(pctChange(ls.totalSales, ts.totalSales)).toFixed(1)}% WoW)`,
      `🏥 *Department Breakup:* ${departments.map((d) => `${d.name} ${waMoney(d.sales)} (${d.units} units)`).join(" · ")}`,
    ].join("\n");

    // Attach the full per-product Amazon Sales Report spanning last week + this week — same L/T
    // window as the WoW comparison above, so the attachment's Growth Summary sheet lines up
    // exactly with the email body. Best-effort: a failure here must not block the email itself.
    let attachments: any[] | undefined;
    try {
      const { wb, filename } = await buildAmazonSalesWorkbookForAccount({
        apiKey, accountId: amazon_account_id, workspaceId: workspace_id,
        startDate: L.start, endDate: T.end, granularity: "weekly",
      });
      const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
      attachments = [{ filename, content: buf.toString("base64"), encoding: "base64" }];
    } catch (err) {
      console.error("[BARM AI] Weekly Amazon Sales Report attachment failed:", err);
    }

    let emailResult: any = null;
    if (send && to) {
      const proto = (req.headers["x-forwarded-proto"] as string) || "http";
      const host = req.headers.host;
      const r = await fetch(`${proto}://${host}/api/send-email`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "weeklyReport", to, data: emailData, attachments }),
      });
      emailResult = await r.json().catch(() => ({}));
      if (!r.ok) emailResult = { error: emailResult?.error || "send-email failed" };
    }

    return res.status(200).json({ thisWeek: T, lastWeek: L, compare, gainers, losers, platforms, departments, whatsappText, emailed: !!(send && to), emailResult });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "weekly-report failed" });
  }
}
