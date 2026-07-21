// Next.js instrumentation — runs once when the server starts
// Sets up cron jobs for scheduled email reports

import { SITE_URL } from "@/lib/siteUrl";
import { readEmailSettings } from "@/lib/emailSettingsStore";

// Two accounts share this dashboard — "A" (Lkn) and "B" (Barm) — each with its
// own settings row in Supabase. Every cron job below loops over both instead
// of assuming a single shared config, so one account's schedule/recipient
// never bleeds into the other's (see the Barm/Lkn mixup this replaced).
const KEY_SLOTS = ["A", "B"] as const;

export async function register() {
  // Only run in Node.js runtime (not Edge)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const cron = (await import("node-cron")).default;
    const nodemailer = (await import("nodemailer")).default;

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.SMTP_FROM,
        pass: process.env.SMTP_PASS,
      },
    });

    function buildSummaryHtml(period: string, metrics: Record<string, any>, toEmail: string) {
      const now = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
      return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>BARM AI Report</title></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f7;padding:32px 16px;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
      <tr>
        <td style="background:linear-gradient(135deg,#6D5EF8 0%,#8B5CF6 100%);padding:28px 32px;">
          <p style="margin:0;color:#fff;font-size:22px;font-weight:800;">&#128202; BARM AI &mdash; ${period} Report</p>
          <p style="margin:6px 0 0;color:rgba(255,255,255,0.75);font-size:13px;">${now} IST</p>
        </td>
      </tr>
      <tr>
        <td style="padding:28px 32px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td width="48%" style="padding:6px 6px 6px 0;">
                <table width="100%" cellpadding="16" cellspacing="0" border="0" style="background:#f0fdf4;border-radius:12px;">
                  <tr><td>
                    <p style="margin:0;color:#6b7280;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.05em;">Total Sales</p>
                    <p style="margin:6px 0 0;color:#059669;font-size:26px;font-weight:900;">&#8377;${(metrics.sales || 0).toLocaleString("en-IN")}</p>
                  </td></tr>
                </table>
              </td>
              <td width="4%"></td>
              <td width="48%" style="padding:6px 0 6px 6px;">
                <table width="100%" cellpadding="16" cellspacing="0" border="0" style="background:#fef2f2;border-radius:12px;">
                  <tr><td>
                    <p style="margin:0;color:#6b7280;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.05em;">Total Spend</p>
                    <p style="margin:6px 0 0;color:#dc2626;font-size:26px;font-weight:900;">&#8377;${(metrics.spend || 0).toLocaleString("en-IN")}</p>
                  </td></tr>
                </table>
              </td>
            </tr>
            <tr><td colspan="3" style="padding:3px 0;"></td></tr>
            <tr>
              <td width="48%" style="padding:6px 6px 6px 0;">
                <table width="100%" cellpadding="16" cellspacing="0" border="0" style="background:#f5f3ff;border-radius:12px;">
                  <tr><td>
                    <p style="margin:0;color:#6b7280;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.05em;">ROAS</p>
                    <p style="margin:6px 0 0;color:#6D5EF8;font-size:26px;font-weight:900;">${metrics.roas || 0}x</p>
                  </td></tr>
                </table>
              </td>
              <td width="4%"></td>
              <td width="48%" style="padding:6px 0 6px 6px;">
                <table width="100%" cellpadding="16" cellspacing="0" border="0" style="background:#fffbeb;border-radius:12px;">
                  <tr><td>
                    <p style="margin:0;color:#6b7280;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.05em;">ACOS</p>
                    <p style="margin:6px 0 0;color:#d97706;font-size:26px;font-weight:900;">${metrics.acos || 0}%</p>
                  </td></tr>
                </table>
              </td>
            </tr>
            <tr><td colspan="3" style="padding:3px 0;"></td></tr>
            <tr>
              <td width="48%" style="padding:6px 6px 6px 0;">
                <table width="100%" cellpadding="16" cellspacing="0" border="0" style="background:#f0f9ff;border-radius:12px;">
                  <tr><td>
                    <p style="margin:0;color:#6b7280;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.05em;">Orders</p>
                    <p style="margin:6px 0 0;color:#0891b2;font-size:26px;font-weight:900;">${(metrics.orders || 0).toLocaleString()}</p>
                  </td></tr>
                </table>
              </td>
              <td width="4%"></td>
              <td width="48%" style="padding:6px 0 6px 6px;">
                <table width="100%" cellpadding="16" cellspacing="0" border="0" style="background:#fdf4ff;border-radius:12px;">
                  <tr><td>
                    <p style="margin:0;color:#6b7280;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.05em;">Impressions</p>
                    <p style="margin:6px 0 0;color:#7c3aed;font-size:26px;font-weight:900;">${(metrics.impressions || 0).toLocaleString()}</p>
                  </td></tr>
                </table>
              </td>
            </tr>
          </table>
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;">
            <tr>
              <td align="center">
                <a href="${SITE_URL}/dashboard" style="background:#6D5EF8;color:#fff;padding:13px 32px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:800;display:inline-block;">Open Dashboard &#8594;</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:16px 32px;border-top:1px solid #f0f0f0;text-align:center;">
          <p style="margin:0;color:#9ca3af;font-size:12px;">BARM AI Dashboard &nbsp;&#183;&nbsp; Automated ${period} Report &nbsp;&#183;&nbsp; <a href="${SITE_URL}/dashboard/settings" style="color:#6D5EF8;text-decoration:none;">Manage alerts</a></p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body></html>`;
    }

    async function sendReport(period: string, toEmail: string, ccEmail?: string) {
      // Use placeholder metrics for now — will be replaced with live API data
      const metrics = {
        sales: 0, spend: 0, roas: 0, acos: 0, orders: 0, impressions: 0,
      };

      const subjects: Record<string, string> = {
        Daily: "BARM AI - Daily Performance Report",
        Weekly: "BARM AI - Weekly Performance Report",
        Monthly: "BARM AI - Monthly Performance Report",
      };

      try {
        await transporter.sendMail({
          from: `BARM AI Dashboard <${process.env.SMTP_FROM}>`,
          to: toEmail,
          cc: ccEmail || undefined,
          subject: subjects[period] || "BARM AI Report",
          html: buildSummaryHtml(period, metrics, toEmail),
        });
        console.log(`[BARM AI] ✅ ${period} report sent → ${toEmail}`);
      } catch (err) {
        console.error(`[BARM AI] ❌ Failed to send ${period} report:`, err);
      }
    }

    // ── Daily ad-waste alerts: hit the alert endpoints, which pull live data,
    //    correlate, and email each finding. Requires account context saved in
    //    settings (keySlot / amazonAccountId / workspaceId from the Settings page). ──
    async function runAlertEndpoint(pathname: string, body: Record<string, any>, label: string) {
      try {
        const port = process.env.PORT || 3000;
        const r = await fetch(`http://localhost:${port}${pathname}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = await r.json().catch(() => ({}));
        console.log(`[BARM AI] ${r.ok ? "✅" : "❌"} ${label}:`, JSON.stringify(j).slice(0, 300));
      } catch (err) {
        console.error(`[BARM AI] ❌ ${label} failed:`, err);
      }
    }

    // ── Daily Report + ad-waste alerts — every day at 10:00 AM IST (4:30 AM UTC) ──
    cron.schedule("30 4 * * *", async () => {
      for (const slot of KEY_SLOTS) {
        const s = await readEmailSettings(slot);
        if (!(s.emailAlerts && s.notifEmail)) continue;

        const acct = { slot, amazon_account_id: s.amazonAccountId, workspace_id: s.workspaceId, to: s.notifEmail, cc: s.ccEmail || undefined, currency: s.currency || "INR" };
        if (!s.amazonAccountId || !s.workspaceId) {
          console.log(`[BARM AI] [${slot}] Daily report + alerts skipped — save Settings once to store account context.`);
          continue;
        }

        if (s.dailySummary) {
          console.log(`[BARM AI] [${slot}] Sending daily report (live data)...`);
          await runAlertEndpoint("/api/daily-report", { ...acct }, `[${slot}] Daily report`); // date omitted → yesterday
        }
        if (s.inventoryAlerts) {
          console.log(`[BARM AI] [${slot}] Running stockout + ad-spend alert...`);
          await runAlertEndpoint("/api/stockout-alert", { ...acct, lowStockThreshold: 5, lookbackDays: 7 }, `[${slot}] Stockout alert`);
        }
        if (s.roasAlerts) {
          console.log(`[BARM AI] [${slot}] Running bleeding-campaigns + wasted-search-terms alerts...`);
          await runAlertEndpoint("/api/ad-alerts", { ...acct, acosThreshold: s.acosThreshold || 40, minSpend: 500, lookbackDays: 7 }, `[${slot}] Ad-waste alerts`);
        }
      }
    }, { timezone: "UTC" });

    // ── Weekly Report (this week vs last week) — every Monday at 9:00 AM IST ──
    cron.schedule("30 3 * * 1", async () => {
      for (const slot of KEY_SLOTS) {
        const s = await readEmailSettings(slot);
        if (!(s.emailAlerts && s.weeklySummary && s.notifEmail && s.amazonAccountId && s.workspaceId)) continue;
        const acct = { slot, amazon_account_id: s.amazonAccountId, workspace_id: s.workspaceId, to: s.notifEmail, cc: s.ccEmail || undefined, currency: s.currency || "INR" };
        console.log(`[BARM AI] [${slot}] Sending weekly report (live WoW comparison)...`);
        await runAlertEndpoint("/api/weekly-report", { ...acct }, `[${slot}] Weekly report`); // endDate omitted → yesterday
      }
    }, { timezone: "UTC" });

    // ── Monthly Report — 1st of every month at 9:00 AM IST ──
    cron.schedule("30 3 1 * *", async () => {
      for (const slot of KEY_SLOTS) {
        const s = await readEmailSettings(slot);
        if (s.emailAlerts && s.monthlySummary && s.notifEmail) {
          console.log(`[BARM AI] [${slot}] Sending monthly report...`);
          await sendReport("Monthly", s.notifEmail, s.ccEmail);
        }
      }
    }, { timezone: "UTC" });

    console.log("[BARM AI] ✅ Email scheduler started — Daily 10AM / Weekly Monday / Monthly 1st");
  }
}
