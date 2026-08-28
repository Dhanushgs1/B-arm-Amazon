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
import nodemailer from "nodemailer";
import { readEmailSettings } from "@/lib/emailSettingsStore";
import { internalFetch, internalOrigin } from "@/lib/internalFetch";

const KEY_SLOTS = ["A", "B"] as const;

async function callReportEndpoint(req: NextApiRequest, pathname: string, body: Record<string, any>, label: string) {
  try {
    const r = await internalFetch(`${internalOrigin(req)}${pathname}`, {
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
async function sendMonthlyPlaceholder(toEmail: string, ccEmail?: string) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.SMTP_FROM, pass: process.env.SMTP_PASS },
  });
  const now = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  await transporter.sendMail({
    from: `Marketplace360 Dashboard <${process.env.SMTP_FROM}>`,
    to: toEmail,
    cc: ccEmail || undefined,
    subject: "Marketplace360 - Monthly Performance Report",
    html: `<p>Monthly report placeholder — generated ${now} IST. Live monthly metrics aren't wired up yet; see the Daily/Weekly reports for real data.</p>`,
  });
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
  if (s.liveAlerts) {
    // Once a day is the honest cadence: every detector compares whole days, so a second run
    // would re-scan identical numbers. Emails nothing unless something new fired.
    results.liveAlerts = await callReportEndpoint(req, "/api/live-alerts", acct, `[${slot}] Live alerts`);
  }
  if (isMonday && s.weeklySummary) {
    results.weekly = await callReportEndpoint(req, "/api/weekly-report", acct, `[${slot}] Weekly report`);
  }
  // Historical 7/30 Day Analysis Report and Daily Ad Spend Report (SKU-wise) are
  // handled OUTSIDE this per-slot loop, in handler() below — unlike everything else
  // here, both are single fixed-distribution-list sends (not scoped to one Amazon
  // account/Settings row), so running them once per slot here would double-send them.
  if (isFirstOfMonth && s.monthlySummary) {
    try {
      await sendMonthlyPlaceholder(s.notifEmail, s.ccEmail);
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
  // Vercel Cron sends "Authorization: Bearer $CRON_SECRET" when CRON_SECRET is set
  // as a project env var. Enforced only if you've set one — add it in Vercel
  // project settings to stop this public URL from being triggered by anyone else.
  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

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

  // Historical 7/30 Day Analysis Report (every Monday) and Daily Ad Spend Report
  // SKU-wise (every day) — both single fixed-distribution-list sends, so they run
  // ONCE here rather than once per KEY_SLOT (there's no free Vercel Cron slot to give
  // either its own schedule — vercel.json already uses both of this project's cron
  // entries — so both piggyback on this route's existing daily 9:00 AM IST trigger).
  let adSpendDaily: any = { skipped: dryRun ? "dryRun" : undefined };
  let historical: any = { skipped: !isMonday ? "not Monday" : dryRun ? "dryRun" : undefined };
  if (!dryRun) {
    adSpendDaily = await callReportEndpoint(req, "/api/send-ad-spend-email", {}, "Daily ad spend report");
    if (isMonday) {
      historical = await callReportEndpoint(req, "/api/send-historical-email", {}, "Historical report");
    }
  }

  return res.status(200).json({ ranAt: now.toISOString(), isMonday, isFirstOfMonth, dryRun, bySlot, adSpendDaily, historical });
}
