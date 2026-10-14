// Vercel Cron entry point — triggered by the "crons" schedule in vercel.json.
//
// The equivalent node-cron jobs in src/instrumentation.ts only work while a Next.js
// server process stays alive continuously (fine for local `next dev`/`next start`,
// but Vercel serverless functions are frozen between requests, so those timers never
// actually fire in production). Vercel Cron instead calls this route on its own
// schedule regardless of whether any function instance happens to be warm.
//
// Runs daily; internally decides whether today is also a weekly (Monday) or
// monthly (1st) send, mirroring the three separate node-cron schedules. Loops
// over both accounts (keySlot "A" = Lkn, "B" = Barm) — each has its own
// settings row in Supabase, so one account's config can never leak into the
// other's automated emails.

import type { NextApiRequest, NextApiResponse } from "next";
import { readEmailSettings } from "@/lib/emailSettingsStore";
import { internalFetch, internalOrigin } from "@/lib/internalFetch";
import { checkCron, guard } from "@/lib/apiAuth";

const KEY_SLOTS = ["A", "B"] as const;

async function callReportEndpoint(req: NextApiRequest, pathname: string, body: Record<string, any>, label: string) {
  try {
    const r = await internalFetch(`${internalOrigin()}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    console.log(`[Marketplace360 Cron] ${r.ok ? "✅" : "❌"} ${label}:`, JSON.stringify(j).slice(0, 300));
    return { ok: r.ok, result: j };
  } catch (err: any) {
    console.error(`[Marketplace360 Cron] ❌ ${label} failed:`, err);
    return { ok: false, error: err?.message || String(err) };
  }
}

// Placeholder monthly summary (mirrors the instrumentation.ts version) — no live
// data wiring exists for the monthly send yet, only daily/weekly pull real metrics.
// Routed through /api/send-email (Resend) like every other send in this file now goes through,
// rather than its own direct nodemailer/Gmail SMTP call — see send-email.ts's own comment on why.
async function sendMonthlyPlaceholder(req: NextApiRequest, toEmail: string, ccEmail?: string) {
  const now = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const r = await internalFetch(`${internalOrigin()}/api/send-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "custom",
      to: toEmail,
      cc: ccEmail || undefined,
      subject: "Marketplace360 - Monthly Performance Report",
      data: {
        html: `<p>Monthly report placeholder — generated ${now} IST. Live monthly metrics aren't wired up yet; see the Daily/Weekly reports for real data.</p>`,
      },
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || "Monthly placeholder send failed");
}

async function runForSlot(req: NextApiRequest, slot: string, isMonday: boolean, isFirstOfMonth: boolean, dryRun: boolean) {
  const s = await readEmailSettings(slot);
  if (!(s.emailAlerts && s.notifEmail && s.amazonAccountId && s.workspaceId)) {
    return { skipped: true, reason: "Email alerts not configured — save Settings once to store account context." };
  }

  if (dryRun) {
    return {
      dryRun: true,
      wouldSend: {
        dailyDigest: !!s.dailySummary,
        liveAlerts: !!s.liveAlerts,
        fbaWarehouseLow: !!(s.fbaWarehouseAlerts ?? slot === "B"),
        highAcosTrend: !!s.highAcosDaily,
        ratingDrop: isMonday && !!(s.ratingDropAlerts ?? slot === "B"),
        weekly: isMonday && !!s.weeklySummary,
        monthly: isFirstOfMonth && !!s.monthlySummary,
      },
    };
  }

  const acct = {
    slot,
    amazon_account_id: s.amazonAccountId,
    workspace_id: s.workspaceId,
    to: s.notifEmail,
    cc: s.ccEmail || undefined,
    currency: s.currency || "INR",
  };

  const results: Record<string, any> = {};

  // Campaign history persistence — unconditional, unlike the email sends below: it
  // writes today's campaign-history row to Supabase (see campaignStateTracker.ts) so
  // the dashboard can keep showing a campaign as Paused instead of losing it entirely
  // if a later API pull omits it. Independent of whether this account has any email
  // toggle on, so it must not be gated behind s.dailySummary etc.
  results.campaignHistory = await callReportEndpoint(
    req,
    "/api/campaign-state-check",
    { slot, amazon_account_id: acct.amazon_account_id, workspace_id: acct.workspace_id },
    `[${slot}] Campaign history snapshot`
  );

  // `dailySummary` now means the combined digest. The separate daily report was deleted — it
  // showed only counts of the stockout / bleeding / wasted-term findings (computed by a different
  // one-day heuristic, so its numbers disagreed with the alert emails' 7-day detectors), and the
  // digest carries the same KPIs plus the actual rows behind each count. /api/stockout-alert and
  // /api/ad-alerts still exist for manual one-off sends; the digest calls the same detectors.
  if (s.dailySummary) {
    // Always sends, including on a quiet day — a digest that goes missing is indistinguishable
    // from a cron that stopped.
    results.dailyDigest = await callReportEndpoint(
      req,
      "/api/daily-digest",
      { ...acct, acosThreshold: s.acosThreshold || 40, minSpend: 500, lookbackDays: 7, lowStockThreshold: s.lowStockThreshold || 5 },
      `[${slot}] Daily digest`
    );
  }
  // The four emails below are the client's daily list (sheet "Mail to be triggered", 2026-10-11):
  // each goes out on any day it has something to report — never as an empty mail (user, 2026-10-11).
  if (s.liveAlerts) {
    // "Things need attention": everything firing today (conversion drops and products running out
    // within stockoutWarnDays first), new items marked NEW.
    results.liveAlerts = await callReportEndpoint(
      req, "/api/live-alerts", { ...acct, daily: true, warnDays: Number(s.stockoutWarnDays) || 10 }, `[${slot}] Things need attention`
    );
  }
  // FBA stock — every SKU failing the 24-FC rule (under 8 FCs stocked, or a stocked FC at 20 units or
  // less), newly failing ones marked NEW, plus every SKU's stock per FC as a CSV. On by default for
  // B-ARM only (the account the FC list was made for); Settings can switch it either way.
  if (s.fbaWarehouseAlerts ?? slot === "B") {
    results.fbaWarehouseLow = await callReportEndpoint(req, "/api/fba-warehouse-alerts", { ...acct, daily: true }, `[${slot}] FBA stock`);
  }
  // High ACOS — campaigns above highAcosThreshold (default 14%) over the last 7 days, ACOS per day.
  // Sends only if yesterday's Last 7 days upload is already in, at most once per date; otherwise the
  // Upload page / 30-minute monitor send it after the upload (see high-acos-report.ts).
  if (s.highAcosDaily) {
    results.highAcosTrend = await callReportEndpoint(
      req, "/api/high-acos-report", { ...acct, threshold: Number(s.highAcosThreshold) || 14 }, `[${slot}] High ACOS`
    );
  }
  // Rating drop — listings that fell from 4★+ to below 4★ since the last ratings snapshot.
  // Mondays, only if this week's ratings upload is already in and not yet mailed; otherwise the
  // Ratings & Reviews upload sends it (see rating-drop-alert.ts). On by default for B-ARM.
  if (isMonday && (s.ratingDropAlerts ?? slot === "B")) {
    results.ratingDrop = await callReportEndpoint(req, "/api/rating-drop-alert", acct, `[${slot}] Rating drop`);
  }
  if (isMonday && s.weeklySummary) {
    results.weekly = await callReportEndpoint(req, "/api/weekly-report", acct, `[${slot}] Weekly report`);
  }
  // The Historical 7/30 Day Analysis Report and Daily Ad Spend Report stay manual-only — see handler() below.
  if (isFirstOfMonth && s.monthlySummary) {
    try {
      await sendMonthlyPlaceholder(req, s.notifEmail, s.ccEmail);
      results.monthly = { ok: true };
      console.log(`[Marketplace360 Cron] ✅ [${slot}] Monthly report sent → ${s.notifEmail}`);
    } catch (err: any) {
      results.monthly = { ok: false, error: err?.message || String(err) };
      console.error(`[Marketplace360 Cron] ❌ [${slot}] Monthly report failed:`, err);
    }
  }

  return { results };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Vercel Cron sends "Authorization: Bearer $CRON_SECRET" once CRON_SECRET is set as a project
  // env var. Fails closed: with no CRON_SECRET configured this public URL refuses to run (503)
  // rather than running for anyone.
  if (!guard(req, res, checkCron)) return;

  // ?dryRun=1 — confirms routing, settings, and today's Monday/1st-of-month
  // flags without actually sending any report or email. Useful for verifying
  // the endpoint after a deploy without spamming the configured inbox.
  const dryRun = req.query.dryRun === "1";
  const now = new Date();
  const isMonday = now.getUTCDay() === 1;
  const isFirstOfMonth = now.getUTCDate() === 1;

  // Each slot is isolated: one account's unexpected throw (a bug, an unguarded
  // Supabase/SellerMate call) must never take the other account's email down
  // with it — that's exactly the failure mode that made whole days of digest
  // mail vanish for BOTH accounts when only one of them was actually affected.
  const bySlot: Record<string, any> = {};
  for (const slot of KEY_SLOTS) {
    try {
      bySlot[slot] = await runForSlot(req, slot, isMonday, isFirstOfMonth, dryRun);
    } catch (err: any) {
      console.error(`[Marketplace360 Cron] ❌ [${slot}] runForSlot threw:`, err);
      bySlot[slot] = { error: err?.message || String(err) };
    }
  }

  // Historical 7/30 Day Analysis Report and Daily Ad Spend Report (SKU-wise) used to piggyback on
  // this route's daily trigger, auto-sending to a hardcoded distribution list with no on/off toggle,
  // which surprised the recipients. Both are manual-only — the Reports page's Send button (confirmed
  // again for the ad spend report by the user, 2026-10-11).
  const adSpendDaily = { skipped: "manual only — use the Reports page's Send button" };
  const historical = { skipped: "manual only — use the Reports page's Send button" };

  return res.status(200).json({ ranAt: now.toISOString(), isMonday, isFirstOfMonth, dryRun, bySlot, adSpendDaily, historical });
}
