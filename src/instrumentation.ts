// Next.js instrumentation — runs once when the server starts
// Sets up cron jobs for scheduled email reports

import { readEmailSettings } from "@/lib/emailSettingsStore";

// Two accounts share this dashboard — "A" (Lkn) and "B" (Barm) — each with its
// own settings row in Supabase. Every cron job below loops over both instead
// of assuming a single shared config, so one account's schedule/recipient
// never bleeds into the other's (see the Barm/Lkn mixup this replaced).
const KEY_SLOTS = ["A", "B"] as const;

export async function register() {
  // Only run in Node.js runtime (not Edge), and only on a real production host.
  // `next dev` also sets NEXT_RUNTIME === "nodejs" and keeps this process alive
  // continuously just like a deployed server would, so without the NODE_ENV
  // check below, leaving `npm run dev` running past a schedule below (e.g. past
  // 10:00 AM IST) fires these node-cron jobs for real — hitting the same live
  // Supabase settings and recipient list as production. `next dev` always runs
  // with NODE_ENV=development, `next start`/a deployed host runs with
  // NODE_ENV=production, so this guard is what actually separates "testing
  // locally" from "running on the host" (see the incident this guard fixed:
  // a local dev server sent a real Daily Digest + Live Alerts email).
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV === "production") {
    const cron = (await import("node-cron")).default;

    // Only "Monthly" is ever actually called below (Daily/Weekly are handled by the real
    // /api/daily-digest, /api/live-alerts and /api/weekly-report routes via runAlertEndpoint) — no
    // live monthly metrics are wired up yet, so this stays a placeholder. Routed through
    // /api/send-email (Resend) rather than its own direct nodemailer/Gmail SMTP call — see
    // send-email.ts's own comment on why, and scheduled-reports.ts's identical Monthly placeholder.
    async function sendReport(period: string, toEmail: string, ccEmail?: string) {
      const now = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
      const subjects: Record<string, string> = {
        Daily: "Marketplace360 - Daily Performance Report",
        Weekly: "Marketplace360 - Weekly Performance Report",
        Monthly: "Marketplace360 - Monthly Performance Report",
      };
      try {
        // internalFetch signs the request — send-email rejects unsigned "custom" sends.
        const { internalFetch, internalOrigin } = await import("@/lib/internalFetch");
        const r = await internalFetch(`${internalOrigin()}/api/send-email`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "custom",
            to: toEmail,
            cc: ccEmail || undefined,
            subject: subjects[period] || "Marketplace360 Report",
            data: {
              html: `<p>${period} report placeholder — generated ${now} IST. Live ${period.toLowerCase()} metrics aren't wired up yet; see the Daily/Weekly reports for real data.</p>`,
            },
          }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j?.error || "send failed");
        console.log(`[Marketplace360] ✅ ${period} report sent → ${toEmail}`);
      } catch (err) {
        console.error(`[Marketplace360] ❌ Failed to send ${period} report:`, err);
      }
    }

    // ── Daily ad-waste alerts: hit the alert endpoints, which pull live data,
    //    correlate, and email each finding. Requires account context saved in
    //    settings (keySlot / amazonAccountId / workspaceId from the Settings page). ──
    async function runAlertEndpoint(pathname: string, body: Record<string, any>, label: string) {
      try {
        // Signed: the alert/report endpoints reject unsigned calls.
        const { internalFetch, internalOrigin } = await import("@/lib/internalFetch");
        const r = await internalFetch(`${internalOrigin()}${pathname}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = await r.json().catch(() => ({}));
        console.log(`[Marketplace360] ${r.ok ? "✅" : "❌"} ${label}:`, JSON.stringify(j).slice(0, 300));
      } catch (err) {
        console.error(`[Marketplace360] ❌ ${label} failed:`, err);
      }
    }

    // ── Daily Report + ad-waste alerts — every day at 10:00 AM IST (4:30 AM UTC) ──
    cron.schedule("30 4 * * *", async () => {
      for (const slot of KEY_SLOTS) {
        const s = await readEmailSettings(slot);
        if (!(s.emailAlerts && s.notifEmail)) continue;

        const acct = { slot, amazon_account_id: s.amazonAccountId, workspace_id: s.workspaceId, to: s.notifEmail, cc: s.ccEmail || undefined, currency: s.currency || "INR" };
        if (!s.amazonAccountId || !s.workspaceId) {
          console.log(`[Marketplace360] [${slot}] Daily report + alerts skipped — save Settings once to store account context.`);
          continue;
        }

        // Mirrors src/pages/api/cron/scheduled-reports.ts, which is what actually runs in
        // production — keep the two in step, or local testing proves nothing about the deploy.
        if (s.dailySummary) {
          console.log(`[Marketplace360] [${slot}] Sending daily digest (combined)...`);
          await runAlertEndpoint(
            "/api/daily-digest",
            { ...acct, acosThreshold: s.acosThreshold || 40, minSpend: 500, lookbackDays: 7, lowStockThreshold: s.lowStockThreshold || 5 },
            `[${slot}] Daily digest`
          );
        }
        if (s.liveAlerts) {
          console.log(`[Marketplace360] [${slot}] Running live alerts...`);
          await runAlertEndpoint("/api/live-alerts", { ...acct }, `[${slot}] Live alerts`);
        }
        if (s.fbaWarehouseAlerts ?? slot === "B") {
          await runAlertEndpoint("/api/fba-warehouse-alerts", { ...acct }, `[${slot}] FBA warehouse low stock`);
        }
      }
    }, { timezone: "UTC" });

    // ── Weekly Report (this week vs last week) — every Monday at 9:00 AM IST ──
    cron.schedule("30 3 * * 1", async () => {
      for (const slot of KEY_SLOTS) {
        const s = await readEmailSettings(slot);
        if (!(s.emailAlerts && s.weeklySummary && s.notifEmail && s.amazonAccountId && s.workspaceId)) continue;
        const acct = { slot, amazon_account_id: s.amazonAccountId, workspace_id: s.workspaceId, to: s.notifEmail, cc: s.ccEmail || undefined, currency: s.currency || "INR" };
        console.log(`[Marketplace360] [${slot}] Sending weekly report (live WoW comparison)...`);
        await runAlertEndpoint("/api/weekly-report", { ...acct }, `[${slot}] Weekly report`); // endDate omitted → yesterday
      }
    }, { timezone: "UTC" });

    // ── Historical 7/30 Day Analysis Report — every Monday at 9:30 AM IST. Mailed
    //    straight to the fixed distribution list (send-historical-email.ts), not
    //    per-account Settings — same always-on design as the Daily Ad Spend Report
    //    below, since this report isn't scoped to one Amazon/Flipkart account.
    //    Production (src/pages/api/cron/scheduled-reports.ts) has no separate 9:30
    //    slot to give this — Vercel Cron only has the two entries vercel.json
    //    already uses — so there it piggybacks on the 9:00 AM route instead; this
    //    separate local timer only exists so `next dev` testing doesn't have to
    //    wait for/trigger the whole Monday bundle to see this fire on its own. ──
    cron.schedule("0 4 * * 1", async () => {
      console.log("[Marketplace360] Sending Historical 7/30 Day Analysis Report...");
      await runAlertEndpoint("/api/send-historical-email", {}, "Historical report"); // endDate omitted → yesterday
    }, { timezone: "UTC" });

    // ── Monthly Report — 1st of every month at 9:00 AM IST ──
    cron.schedule("30 3 1 * *", async () => {
      for (const slot of KEY_SLOTS) {
        const s = await readEmailSettings(slot);
        if (s.emailAlerts && s.monthlySummary && s.notifEmail) {
          console.log(`[Marketplace360] [${slot}] Sending monthly report...`);
          await sendReport("Monthly", s.notifEmail, s.ccEmail);
        }
      }
    }, { timezone: "UTC" });

    // ── Daily Ad Spend Report (SKU-wise) — every day at 9:00 AM IST. Mailed straight
    //    to the fixed distribution list (send-ad-spend-email.ts), not per-account
    //    Settings, for the same reason as the Historical report above. Production
    //    piggybacks this on scheduled-reports.ts's own 9:00 AM route too — see that
    //    file's handler() — this separate local timer is dev-testing-only. ──
    cron.schedule("30 3 * * *", async () => {
      console.log("[Marketplace360] Sending Daily Ad Spend Report (SKU-wise)...");
      await runAlertEndpoint("/api/send-ad-spend-email", {}, "Daily ad spend report"); // endDate omitted → yesterday
    }, { timezone: "UTC" });

    // ── Campaign pause monitor — every 30 minutes, independent of the daily
    //    report/alert schedule above. Mirrors src/pages/api/cron/campaign-monitor.ts,
    //    which is what actually runs on Vercel — keep the two in step. No email; this
    //    only shrinks how stale barm_campaign_pause_log can get (see that file's
    //    header comment for what it still can't catch: a pause-and-resume that both
    //    happen inside the same 30-minute gap). ──
    cron.schedule("*/30 * * * *", async () => {
      for (const slot of KEY_SLOTS) {
        const s = await readEmailSettings(slot);
        if (!(s.amazonAccountId && s.workspaceId)) continue;
        await runAlertEndpoint(
          "/api/campaign-state-check",
          { slot, amazon_account_id: s.amazonAccountId, workspace_id: s.workspaceId },
          `[${slot}] Campaign monitor (30min)`
        );
      }
    }, { timezone: "UTC" });

    console.log("[Marketplace360] ✅ Email scheduler started — Daily 10AM / Weekly Monday / Monthly 1st / Ad Spend Daily 8:30AM / Historical Report Monday 9:30AM / Campaign monitor every 30min");
  }
}
