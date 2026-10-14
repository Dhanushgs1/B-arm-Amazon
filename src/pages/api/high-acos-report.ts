// Daily High ACOS email (src/lib/highAcosTrend.ts, src/lib/highAcosChannels.ts): for Amazon, Flipkart
// and Meesho (B-ARM), every campaign whose 7-day ACOS is above the Settings threshold, with its ACOS
// for each of the 7 days. Read only from the uploaded ads reports, never SellerMate (user, 2026-10-12).
// Sent only when at least one campaign on any channel is above the limit — no empty mails.
//
// Sent only after yesterday's "Last 7 days" combined upload has landed: rows in
// barm_amazon_sp_advertised_product for yesterday's IST date. Flipkart and Meesho come from the same
// workbook; a channel with no rows for yesterday is shown as "not uploaded" rather than as fine.
// Three callers, at most one mail per day between them (state in barm_alert_state, alert_type
// "highAcosDaily", entity_id = that date):
//   - the Upload page, right after the daily combined upload (signed-in browser session; recipients
//     and threshold come from that slot's saved Settings, never from the request);
//   - the 9:00 AM IST cron (scheduled-reports.ts), if the upload was already done;
//   - the 30-minute campaign monitor, from 9:00 IST, in case the upload page's call did not finish.
//
// POST body (signed server calls): { slot?, to, cc?, currency?, threshold?, dryRun?, preview?, accountName? }
// POST body (browser session):      { keySlot }
//   dryRun: compute and return the rows, send nothing (skips the upload/once-a-day checks)
//   preview: render the email and return its HTML (send-email preview), send nothing

import type { NextApiRequest, NextApiResponse } from "next";
import { supabasePublic } from "@/lib/amazonReportUpload";
import { fetchAllRows } from "@/lib/amazonReportShared";
import { readEmailSettings } from "@/lib/emailSettingsStore";
import { buildAcosTrend, lastIstDates, acosTrendCsv, HIGH_ACOS_DEFAULT_THRESHOLD, HIGH_ACOS_DAYS } from "@/lib/highAcosTrend";
import { ACOS_CHANNELS, toPerDay, amazonRows, flipkartRows, meeshoRows, meeshoAvgPrice, type ChannelAdRow } from "@/lib/highAcosChannels";
import { internalFetch, internalOrigin } from "@/lib/internalFetch";
import { checkSessionOrInternal, guard, isInternalRequest } from "@/lib/apiAuth";

const STATE_TABLE = "barm_alert_state";
const ALERT_TYPE = "highAcosDaily";

export const config = { maxDuration: 300 };

/** Has the daily "Last 7 days" upload brought in yesterday's Amazon SP ad rows? */
async function uploadLanded(date: string): Promise<boolean> {
  const { data, error } = await supabasePublic
    .from("barm_amazon_sp_advertised_product").select("report_date").eq("report_date", date).limit(1);
  if (error) throw new Error(`upload check failed: ${error.message}`);
  return (data || []).length > 0;
}

async function alreadySent(slot: string, date: string): Promise<boolean> {
  const { data, error } = await supabasePublic
    .from(STATE_TABLE).select("entity_id").eq("key_slot", slot).eq("alert_type", ALERT_TYPE).eq("entity_id", date).limit(1);
  if (error) throw new Error(`alert state read failed: ${error.message}`);
  return (data || []).length > 0;
}

/** The three channels' uploaded ad rows for the window. A failed read fails the run. */
async function loadChannelRows(start: string, end: string): Promise<Record<string, ChannelAdRow[]>> {
  const range = (dateCol: string) => (q: { gte: (c: string, v: string) => { lte: (c: string, v: string) => unknown } }) => q.gte(dateCol, start).lte(dateCol, end);
  // Meesho prices: the last ~6 weeks of its own orders.
  const priceFrom = new Date(Date.parse(end + "T00:00:00Z") - 42 * 86_400_000).toISOString().slice(0, 10);
  const [am, fk, ms, msOrders] = await Promise.all([
    fetchAllRows("barm_amazon_sp_advertised_product", range("report_date")),
    fetchAllRows("barm_daily_fk_ads", range("report_date")),
    fetchAllRows("barm_daily_ms_barm_ads", range("report_date")),
    fetchAllRows("barm_daily_ms_barm_orders", (q) => q.gte("report_date", priceFrom).lte("report_date", end)),
  ]);
  return { amazon: amazonRows(am), flipkart: flipkartRows(fk), meesho: meeshoRows(ms, meeshoAvgPrice(msOrders)) };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  // Signed server calls (cron, monitor) or the signed-in Upload page.
  if (!guard(req, res, checkSessionOrInternal)) return;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let params: Record<string, any> = req.body || {};
  if (!isInternalRequest(req.headers)) {
    // Browser: everything comes from the slot's saved Settings; only the slot is taken from the body.
    const slot = params.keySlot === "A" ? "A" : "B";
    const s = await readEmailSettings(slot);
    if (!(s.emailAlerts && s.highAcosDaily && s.notifEmail)) {
      return res.status(200).json({ emailed: false, skipped: "High ACOS email is off in Settings" });
    }
    params = {
      slot, to: s.notifEmail, cc: s.ccEmail || undefined,
      currency: s.currency || "INR", threshold: Number(s.highAcosThreshold) || HIGH_ACOS_DEFAULT_THRESHOLD,
    };
  }
  const {
    slot = "B", to, cc, currency = "INR",
    threshold = HIGH_ACOS_DEFAULT_THRESHOLD, dryRun = false, preview = false, accountName = slot === "A" ? "Lkn" : "B-ARM",
  } = params;

  if (!to && !dryRun) return res.status(400).json({ error: "to is required (or dryRun: true)" });

  const limit = Number(threshold) || HIGH_ACOS_DEFAULT_THRESHOLD;
  const dates = lastIstDates(HIGH_ACOS_DAYS);
  const lastDate = dates[dates.length - 1];
  const sending = !dryRun && !preview;

  try {
    if (sending) {
      if (!(await uploadLanded(lastDate))) {
        return res.status(200).json({ emailed: false, skipped: `waiting for the Last 7 days upload (no ${lastDate} ads yet)` });
      }
      if (await alreadySent(slot, lastDate)) {
        return res.status(200).json({ emailed: false, skipped: `already sent for ${lastDate}` });
      }
    }

    const byChannel = await loadChannelRows(dates[0], lastDate);
    const channels = ACOS_CHANNELS.map((ch) => {
      const rows = byChannel[ch.key] || [];
      const perDay = toPerDay(rows, dates);
      const campaigns = buildAcosTrend(perDay, limit, ch.minSpend);
      const totalSpend = perDay.reduce((a, d) => a + d.rows.reduce((b, r) => b + (Number(r.spend) || 0), 0), 0);
      const totalSales = perDay.reduce((a, d) => a + d.rows.reduce((b, r) => b + (Number(r.sales) || 0), 0), 0);
      const flaggedSpend = campaigns.reduce((a, c) => a + c.spend, 0);
      // Yesterday missing for this channel = its sheet was not in the upload, not "nothing above the limit".
      const uploaded = rows.some((r) => r.date === lastDate);
      return { ...ch, campaigns, totalSpend, totalSales, flaggedSpend, uploaded };
    });
    const flagged = channels.reduce((a, c) => a + c.campaigns.length, 0);
    const summary = {
      dates, threshold: limit, campaigns: flagged,
      channels: channels.map((c) => ({ key: c.key, campaigns: c.campaigns.length, totalSpend: c.totalSpend, flaggedSpend: c.flaggedSpend, uploaded: c.uploaded })),
    };

    if (dryRun) return res.status(200).json({ ...summary, dryRun: true, rows: channels.map((c) => ({ key: c.key, campaigns: c.campaigns })) });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let emailResult: any = null;
    if (to && flagged) {
      const attachments = channels.filter((c) => c.campaigns.length).map((c) => ({
        filename: `high-acos-${c.key}-${lastDate}.csv`,
        content: Buffer.from(acosTrendCsv(c.campaigns, dates), "utf8").toString("base64"), encoding: "base64",
      }));
      const r = await internalFetch(`${internalOrigin()}/api/send-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "highAcosTrend", to, cc, preview: preview || undefined,
          data: { channels, dates, threshold: limit, currency, accountName, channel: null },
          attachments,
        }),
      });
      emailResult = await r.json().catch(() => ({}));
      if (!r.ok) emailResult = { error: emailResult?.error || "send-email failed" };
    }
    const emailed = sending && !!(to && flagged && emailResult && !emailResult.error);
    // Mark the day done once it was mailed, or once it was checked with nothing above the limit —
    // either way there is nothing more to send for that date. A failed send is retried.
    if (sending && (emailed || flagged === 0)) {
      const { error: upErr } = await supabasePublic.from(STATE_TABLE).upsert(
        [{ key_slot: slot, alert_type: ALERT_TYPE, entity_id: lastDate, severity: 1, last_sent_at: new Date().toISOString(),
          details: { title: `High ACOS ${lastDate}`, campaigns: flagged, emailed } }],
        { onConflict: "key_slot,alert_type,entity_id" },
      );
      if (upErr) console.error("[Marketplace360] high-acos state write failed:", upErr.message);
    }
    // Browser callers get counts only, never the campaign rows or the rendered email.
    return res.status(200).json({ ...summary, emailed, emailError: emailResult?.error, ...(isInternalRequest(req.headers) ? { emailResult } : {}) });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : "high-acos-report failed" });
  }
}
