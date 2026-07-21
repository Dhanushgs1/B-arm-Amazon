// Vercel Cron entry point — triggered by the "crons" schedule in vercel.json.
//
// The equivalent node-cron jobs in src/instrumentation.ts only work while a Next.js
// server process stays alive continuously (fine for local `next dev`/`next start`,
// but Vercel serverless functions are frozen between requests, so those timers never
// actually fire in production). Vercel Cron instead calls this route on its own
// schedule regardless of whether any function instance happens to be warm.
//
// Runs daily; internally decides whether today is also a weekly (Monday) or
// monthly (1st) send, mirroring the three separate node-cron schedules.

import type { NextApiRequest, NextApiResponse } from "next";
import fs from "fs";
import path from "path";
import nodemailer from "nodemailer";

const SETTINGS_FILE = path.join(process.cwd(), ".email-settings.json");

function readSettings(): Record<string, any> {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function baseUrl(req: NextApiRequest) {
  const proto = (req.headers["x-forwarded-proto"] as string) || "http";
  const host = req.headers.host;
  return `${proto}://${host}`;
}

async function callReportEndpoint(req: NextApiRequest, pathname: string, body: Record<string, any>, label: string) {
  try {
    const r = await fetch(`${baseUrl(req)}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    console.log(`[BARM AI Cron] ${r.ok ? "✅" : "❌"} ${label}:`, JSON.stringify(j).slice(0, 300));
    return { ok: r.ok, result: j };
  } catch (err: any) {
    console.error(`[BARM AI Cron] ❌ ${label} failed:`, err);
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
    from: `BARM AI Dashboard <${process.env.SMTP_FROM}>`,
    to: toEmail,
    cc: ccEmail || undefined,
    subject: "BARM AI - Monthly Performance Report",
    html: `<p>Monthly report placeholder — generated ${now} IST. Live monthly metrics aren't wired up yet; see the Daily/Weekly reports for real data.</p>`,
  });
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

  const s = readSettings();
  if (!(s.emailAlerts && s.notifEmail && s.amazonAccountId && s.workspaceId)) {
    return res.status(200).json({ skipped: true, reason: "Email alerts not configured — save Settings once to store account context." });
  }

  // ?dryRun=1 — confirms routing, settings, and today's Monday/1st-of-month
  // flags without actually sending any report or email. Useful for verifying
  // the endpoint after a deploy without spamming the configured inbox.
  const dryRun = req.query.dryRun === "1";
  if (dryRun) {
    const now = new Date();
    return res.status(200).json({
      dryRun: true,
      wouldSend: {
        daily: !!s.dailySummary,
        stockout: !!s.inventoryAlerts,
        adWaste: !!s.roasAlerts,
        weekly: now.getUTCDay() === 1 && !!s.weeklySummary,
        monthly: now.getUTCDate() === 1 && !!s.monthlySummary,
      },
    });
  }

  const acct = {
    slot: s.keySlot || "A",
    amazon_account_id: s.amazonAccountId,
    workspace_id: s.workspaceId,
    to: s.notifEmail,
    cc: s.ccEmail || undefined,
    currency: s.currency || "INR",
  };

  const now = new Date();
  const isMonday = now.getUTCDay() === 1;
  const isFirstOfMonth = now.getUTCDate() === 1;

  const results: Record<string, any> = {};

  if (s.dailySummary) {
    results.daily = await callReportEndpoint(req, "/api/daily-report", acct, "Daily report");
  }
  if (s.inventoryAlerts) {
    results.stockout = await callReportEndpoint(req, "/api/stockout-alert", { ...acct, lowStockThreshold: s.lowStockThreshold || 5, lookbackDays: 7 }, "Stockout alert");
  }
  if (s.roasAlerts) {
    results.adWaste = await callReportEndpoint(req, "/api/ad-alerts", { ...acct, acosThreshold: s.acosThreshold || 40, minSpend: 500, lookbackDays: 7 }, "Ad-waste alerts");
  }
  if (isMonday && s.weeklySummary) {
    results.weekly = await callReportEndpoint(req, "/api/weekly-report", acct, "Weekly report");
  }
  if (isFirstOfMonth && s.monthlySummary) {
    try {
      await sendMonthlyPlaceholder(s.notifEmail, s.ccEmail);
      results.monthly = { ok: true };
      console.log(`[BARM AI Cron] ✅ Monthly report sent → ${s.notifEmail}`);
    } catch (err: any) {
      results.monthly = { ok: false, error: err?.message || String(err) };
      console.error("[BARM AI Cron] ❌ Monthly report failed:", err);
    }
  }

  return res.status(200).json({ ranAt: now.toISOString(), isMonday, isFirstOfMonth, results });
}
