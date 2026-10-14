// Global email kill switch. With EMAIL_SENDING_PAUSED=true in the environment, the two routes every
// outbound email passes through — /api/send-email (all templates: crons, upload alerts, Reports
// page) and /api/send-ad-spend-email (which hands off to the send-ad-spend-email Edge Function) —
// refuse to send. Everything else (report generation, campaign-history snapshots, alert detection)
// keeps running; callers see a failed send, so transition-based alerts don't record anything as
// mailed and resume normally once the switch is removed.
// Turned on 2026-10-09 at the user's request ("no mail from tomorrow"). To resume: remove the
// variable in Vercel (or set it to false) and redeploy.
//
// EMAIL_SENDING_PAUSED_UNTIL=YYYY-MM-DD pauses the same way until that date begins in IST, then lets
// mail through with no redeploy — used 2026-10-11 so the daily emails start on 2026-10-12, not the
// day they were deployed.

export function emailSendingPaused(env: Record<string, string | undefined> = process.env, now = new Date()): boolean {
  if (/^(1|true|yes|on)$/i.test((env.EMAIL_SENDING_PAUSED ?? "").trim())) return true;
  const until = (env.EMAIL_SENDING_PAUSED_UNTIL ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(until)) {
    const istToday = new Date(now.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
    return istToday < until;
  }
  return false;
}

export const EMAIL_PAUSED_ERROR = "Email sending is paused (EMAIL_SENDING_PAUSED / EMAIL_SENDING_PAUSED_UNTIL) — nothing was sent";
