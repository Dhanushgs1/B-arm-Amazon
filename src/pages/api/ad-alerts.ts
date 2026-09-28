// Runs the ad-waste alert detectors (bleeding campaigns + wasted search terms)
// and emails each finding via the generic /api/send-email "adAlert" template.
// Shared builders in src/lib/adAlerts.ts (also used by the daily cron).
//
// POST body: { slot?, amazon_account_id, workspace_id, to, currency?,
//              acosThreshold?, minSpend?, lookbackDays?, send?, alerts? }
// alerts: optional array subset of ["bleeding","wastedTerms"] (default both).

import type { NextApiRequest, NextApiResponse } from "next";
import { findBleedingCampaigns, findWastedSearchTerms, resolveSellerMateKey } from "@/lib/adAlerts";
import { SITE_URL } from "@/lib/siteUrl";
import { internalFetch, internalOrigin } from "@/lib/internalFetch";
import { checkInternal, guard } from "@/lib/apiAuth";

// dateRangeLabel is defined below and hoisted; used to stamp the data window.

const cur = (v: number, currency = "INR") =>
  (currency === "INR" ? "₹" : "$") + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(v || 0));

export function dateRangeLabel(lookbackDays: number, now = new Date()) {
  const end = now;
  const start = new Date(now);
  start.setDate(start.getDate() - (lookbackDays - 1));
  const fmt = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  return lookbackDays <= 1 ? fmt(end) : `${fmt(start)} – ${fmt(end)}`;
}

export function bleedingEmail(items: any[], currency: string, rangeLabel = "") {
  const total = items.reduce((a, c) => a + c.spend, 0);
  const range = rangeLabel ? ` <span style="color:#9ca3af;font-weight:600;">· Data: ${rangeLabel}</span>` : "";
  return {
    subject: "🚨 Marketplace360 - Bleeding Campaigns (high ACOS / no orders)",
    data: {
      emoji: "&#128680;",
      title: "Bleeding Campaigns",
      subtitle: `${items.length} campaign${items.length > 1 ? "s" : ""} burning ${cur(total, currency)} with weak returns — review bids or pause.${range}`,
      columns: [
        { label: "Campaign", align: "left" },
        { label: "Spend", align: "right" },
        { label: "Sales", align: "right" },
        { label: "ACOS", align: "center" },
        { label: "Orders", align: "center" },
      ],
      rows: items.map((c) => [
        { text: c.campaignName, bold: true },
        { text: cur(c.spend, currency), color: "#dc2626", bold: true },
        { text: cur(c.sales, currency), color: "#059669", bold: true },
        { text: c.acos == null ? "—" : `${Math.round(c.acos)}%`, badge: true, color: "#991b1b", badgeBg: "#fee2e2" },
        { text: String(c.orders), color: c.orders === 0 ? "#dc2626" : "#111", bold: true },
      ]),
      ctaText: "View Campaigns",
      ctaUrl: `${SITE_URL}/dashboard/campaigns`,
    },
  };
}

export function wastedTermsEmail(terms: any[], totalWasted: number, currency: string, rangeLabel = "") {
  const range = rangeLabel ? ` <span style="color:#9ca3af;font-weight:600;">· Data: ${rangeLabel}</span>` : "";
  return {
    subject: "💸 Marketplace360 - Wasted Search Terms (spend, zero orders)",
    data: {
      emoji: "&#128184;",
      title: "Wasted Search Terms",
      subtitle: `${terms.length} search term${terms.length > 1 ? "s" : ""} spent ${cur(totalWasted, currency)} with zero orders — add as negative keywords.${range}`,
      headerBg: "#fffbeb", headerBorder: "#fde68a", headerColor: "#92400e",
      columns: [
        { label: "Search Term", align: "left" },
        { label: "Spend", align: "right" },
        { label: "Clicks", align: "center" },
        { label: "Orders", align: "center" },
      ],
      rows: terms.map((t) => [
        { text: t.searchTerm, bold: true },
        { text: cur(t.spend, currency), color: "#dc2626", bold: true },
        { text: String(t.clicks), color: "#6b7280" },
        { text: "0", badge: true, color: "#991b1b", badgeBg: "#fee2e2" },
      ]),
      ctaText: "View Search Terms",
      ctaUrl: `${SITE_URL}/dashboard/searchterms`,
    },
  };
}

async function sendEmail(req: NextApiRequest, to: string, cc: string | undefined, subject: string, dataObj: any) {
  const r = await internalFetch(`${internalOrigin()}/api/send-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "adAlert", to, cc, subject, data: dataObj }),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, result: j };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  // Cron/server-only: callable solely via internalFetch (signed with INTERNAL_API_SECRET).
  if (!guard(req, res, checkInternal)) return;

  const {
    slot = "B", amazon_account_id, workspace_id, to, cc, currency = "INR",
    acosThreshold = 40, minSpend = 500, lookbackDays = 7, send = true,
    alerts = ["bleeding", "wastedTerms"],
  } = req.body || {};

  if (!amazon_account_id || !workspace_id) {
    return res.status(400).json({ error: "amazon_account_id and workspace_id are required" });
  }
  const apiKey = resolveSellerMateKey(slot === "B" ? "B" : "A");
  if (!apiKey) return res.status(500).json({ error: `Missing SellerMate API key for slot ${slot}` });

  const out: any = { sent: [], skipped: [] };
  try {
    if (alerts.includes("bleeding")) {
      const items = await findBleedingCampaigns({ apiKey, amazon_account_id, workspace_id, acosThreshold, minSpend, lookbackDays });
      out.bleeding = { count: items.length, totalSpend: Math.round(items.reduce((a, c) => a + c.spend, 0)) };
      if (send && to && items.length > 0) {
        const em = bleedingEmail(items, currency, dateRangeLabel(lookbackDays));
        const r = await sendEmail(req, to, cc, em.subject, em.data);
        out.sent.push({ alert: "bleeding", ok: r.ok, msg: r.result?.message || r.result?.error });
      } else out.skipped.push("bleeding");
    }

    if (alerts.includes("wastedTerms")) {
      const { terms, totalWasted } = await findWastedSearchTerms({ apiKey, amazon_account_id, workspace_id, minSpend: 100, lookbackDays });
      out.wastedTerms = { count: terms.length, totalWasted: Math.round(totalWasted) };
      if (send && to && terms.length > 0) {
        const em = wastedTermsEmail(terms, totalWasted, currency, dateRangeLabel(lookbackDays));
        const r = await sendEmail(req, to, cc, em.subject, em.data);
        out.sent.push({ alert: "wastedTerms", ok: r.ok, msg: r.result?.message || r.result?.error });
      } else out.skipped.push("wastedTerms");
    }

    return res.status(200).json(out);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "ad-alerts failed", partial: out });
  }
}
