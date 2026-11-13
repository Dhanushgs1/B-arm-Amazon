// Daily digest from the uploaded data (src/lib/uploadDigestRules.ts; user, 2026-11-13): one mail with
// yesterday's Amazon, Flipkart, Meesho, Shopify, Google Ads and Meta Ads numbers — a sales and ads
// table, what is going well / needs attention, and the best and losing campaigns. Read only from the
// uploaded reports and the Shopify orders table, never SellerMate; the same loaders and rules as the
// Overall page, for one day. It replaces the 9 AM SellerMate digest (/api/daily-digest).
//
// Sent once yesterday's data is in from all three daily uploads — the "Last 7 days" workbook
// (barm_daily_am_ads), the Google Ads files (barm_daily_google_ad_spend) and the Meta ads file
// (barm_daily_social_media). Until then every caller is told what it is still waiting for. At most
// one mail per day (barm_alert_state, alert_type "uploadDigest", entity_id = that date). Callers:
//   - the Upload page, right after each of those three uploads (signed-in browser session;
//     recipients come from that slot's saved Settings, never from the request);
//   - the 30-minute campaign monitor and the 9:00 AM IST cron, as a backup. These wait until no
//     upload row was written in the last 10 minutes, so they never read a half-written upload.
//
// POST body (signed server calls): { slot?, to, cc?, date?, dryRun?, preview?, force?, accountName? }
// POST body (browser session):      { keySlot }
//   dryRun:  build and return the digest, send nothing (skips the upload / once-a-day checks)
//   preview: render the email and return its HTML, send nothing
//   date:    dryRun / preview only — build the digest for that day instead of yesterday
//   force:   signed server calls only — send again for a day already mailed

import type { NextApiRequest, NextApiResponse } from "next";
import { supabasePublic } from "@/lib/amazonReportUpload";
import { readEmailSettings } from "@/lib/emailSettingsStore";
import { fetchAmazonSummary, fetchFlipkartAllSummary, fetchMeeshoSummary, type ChannelSummary } from "@/lib/channelSummary";
import { fetchShopifyAllSummary, fetchShopifyOrders } from "@/lib/shopifyOrders";
import { loadMarketplaceAds, loadSpendWindows } from "@/lib/overallData";
import { resolveDailySpend } from "@/lib/adSpendDailyRules";
import { fetchAllRows } from "@/lib/amazonReportShared";
import { amazonRows, type ChannelAdRow } from "@/lib/highAcosChannels";
import { shopifySourceDetail } from "@/lib/shopifySourceRules";
import { addDays, buildDigest, channelDay, digestDay, digestWaitingFor, DIGEST_SETTLE_MINUTES, type MarketKey, type PaidKey } from "@/lib/uploadDigestRules";
import { internalFetch, internalOrigin } from "@/lib/internalFetch";
import { checkSessionOrInternal, guard, isInternalRequest } from "@/lib/apiAuth";

const STATE_TABLE = "barm_alert_state";
const ALERT_TYPE = "uploadDigest";
const CLAIM_STALE_MS = 15 * 60_000;

export const config = { maxDuration: 300 };

const MARKETS: { key: MarketKey; label: string; orders: string; ads: string; fetcher: (s: string, e: string) => Promise<ChannelSummary> }[] = [
  { key: "amazon", label: "Amazon", orders: "barm_daily_am_orders", ads: "barm_daily_am_ads", fetcher: fetchAmazonSummary },
  { key: "flipkart", label: "Flipkart", orders: "barm_daily_fk_orders", ads: "barm_daily_fk_ads", fetcher: fetchFlipkartAllSummary },
  { key: "meesho", label: "Meesho", orders: "barm_daily_ms_barm_orders", ads: "barm_daily_ms_barm_ads", fetcher: fetchMeeshoSummary },
];
const PAID: { key: PaidKey; label: string; source: string; table: string }[] = [
  { key: "google", label: "Google Ads", source: "google_ads", table: "barm_daily_google_ad_spend" },
  { key: "meta", label: "Meta Ads", source: "meta_ads", table: "barm_daily_social_media" },
];

/** Newest report_date, up to `day`, in a daily upload table. */
async function lastDay(table: string, day: string): Promise<string | null> {
  const { data, error } = await supabasePublic.from(table).select("report_date").lte("report_date", day).order("report_date", { ascending: false }).limit(1);
  if (error) throw new Error(`${table}: ${error.message}`);
  return (data?.[0] as { report_date?: string } | undefined)?.report_date?.slice(0, 10) ?? null;
}

/** Has each of the three daily uploads brought `day`'s data? */
async function uploadsLanded(day: string) {
  const has = async (table: string, q: (x: any) => any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const { data, error } = await q(supabasePublic.from(table).select("created_at")).limit(1);
    if (error) throw new Error(`upload check failed (${table}): ${error.message}`);
    return (data || []).length > 0;
  };
  const covers = (q: any) => q.lte("report_start", day).gte("report_end", day); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [workbook, google, meta] = await Promise.all([
    has("barm_daily_am_ads", (q) => q.eq("report_date", day)),
    has("barm_daily_google_ad_spend", covers),
    has("barm_daily_social_media", covers),
  ]);
  return { workbook, google, meta };
}

/** Was any row of the daily uploads written in the last DIGEST_SETTLE_MINUTES? */
async function uploadRunning(): Promise<boolean> {
  const since = new Date(Date.now() - DIGEST_SETTLE_MINUTES * 60_000).toISOString();
  const tables = [...MARKETS.flatMap((m) => [m.orders, m.ads]), ...PAID.map((p) => p.table)];
  const hits = await Promise.all(tables.map(async (t) => {
    // Newest row by id (indexed): created_at has no index, and filtering on it scanned the whole
    // table and hit the database's statement timeout on the first live send (13 Nov 2026).
    const { data, error } = await supabasePublic.from(t).select("created_at").order("id", { ascending: false }).limit(1);
    if (error) throw new Error(`upload check failed (${t}): ${error.message}`);
    const last = (data?.[0] as { created_at?: string } | undefined)?.created_at;
    return !!last && last > since;
  }));
  return hits.some(Boolean);
}

/** Take the day: only the caller that gets it sends. A claim left "sending" for 15 minutes (a run
 *  that died) can be taken over. */
async function claimDay(slot: string, day: string): Promise<{ claimed: boolean; reason?: string }> {
  const key = { key_slot: slot, alert_type: ALERT_TYPE, entity_id: day };
  const nowIso = new Date().toISOString();
  const { error } = await supabasePublic.from(STATE_TABLE).insert({ ...key, severity: 0, last_sent_at: nowIso, details: { status: "sending" } });
  if (!error) return { claimed: true };
  if (error.code !== "23505") throw new Error(`alert state write failed: ${error.message}`);
  const { data, error: readErr } = await supabasePublic.from(STATE_TABLE).select("last_sent_at,details").match(key).limit(1);
  if (readErr) throw new Error(`alert state read failed: ${readErr.message}`);
  const row = data?.[0] as { last_sent_at: string; details?: { status?: string } } | undefined;
  if (!row) return { claimed: false, reason: "another run is sending it" };
  if (row.details?.status !== "sending") return { claimed: false, reason: "already sent" };
  if (Date.now() - Date.parse(row.last_sent_at) < CLAIM_STALE_MS) return { claimed: false, reason: "another run is sending it" };
  const { data: took, error: takeErr } = await supabasePublic.from(STATE_TABLE)
    .update({ last_sent_at: nowIso }).match(key).eq("last_sent_at", row.last_sent_at).select("entity_id");
  if (takeErr) throw new Error(`alert state write failed: ${takeErr.message}`);
  return took?.length ? { claimed: true } : { claimed: false, reason: "another run is sending it" };
}

/** A marketplace's uploaded ad rows. Amazon comes from the daily workbook's own "AM ads" copy
 *  (barm_daily_am_ads — Sponsored Products lines per SKU plus the Sponsored Brands campaign lines),
 *  the upload this digest waits for; loadMarketplaceAds reads Amazon from the separate SP report card,
 *  which is uploaded weekly and has no rows for yesterday. Flipkart and Meesho are the daily tables. */
async function marketAds(key: MarketKey, start: string, end: string): Promise<ChannelAdRow[]> {
  if (key !== "amazon") return loadMarketplaceAds(key, start, end);
  return amazonRows(await fetchAllRows("barm_daily_am_ads", (q) => q.gte("report_date", start).lte("report_date", end)));
}

async function loadDigest(day: string) {
  const prev = addDays(day, -1);
  const [lastOrders, lastAds] = await Promise.all([
    Promise.all(MARKETS.map((m) => lastDay(m.orders, day))),
    Promise.all(MARKETS.map((m) => lastDay(m.ads, day))),
  ]);
  const days = MARKETS.map((_, i) => channelDay(day, lastOrders[i], lastAds[i]));
  const [shopify, orders, windows] = await Promise.all([
    fetchShopifyAllSummary(day, day),
    fetchShopifyOrders(),
    Promise.all(PAID.map((p) => loadSpendWindows(p.key, prev, day))),
  ]);
  // One marketplace at a time: each reads whole order tables, and the database is small.
  const markets = [];
  for (const [i, m] of MARKETS.entries()) {
    const d = days[i];
    const summary = d ? await m.fetcher(d, d) : null;
    const ordersIn = !!d && lastOrders[i] !== null && lastOrders[i]! >= d;
    // The day has order rows, so a summary of no orders and no sales means a read inside it failed
    // quietly (the summaries fall back to empty on a database timeout) — not that nothing sold. Stop
    // rather than mail zeros: the claim is released and the next 30-minute check or upload tries
    // again. A day whose orders are simply not uploaded yet (ordersIn false) is shown as 0 on purpose.
    if (summary && ordersIn && !summary.current.orders && !(summary.current.sales ?? 0)) {
      throw new Error(`${m.label}: order rows exist for ${d} but the summary read zero — not mailing zeros, will retry`);
    }
    markets.push({ key: m.key, label: m.label, day: d, ordersIn, summary, ads: d ? await marketAds(m.key, addDays(d, -1), d) : [] });
  }
  const paid = PAID.map((p, i) => {
    const now = resolveDailySpend(windows[i], day, day);
    const before = resolveDailySpend(windows[i], prev, prev);
    return { key: p.key, label: p.label, now, before, detail: shopifySourceDetail(orders, p.source, now, day, day), prevDetail: shopifySourceDetail(orders, p.source, before, prev, prev) };
  });
  return buildDigest({ day, markets, shopify, paid });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  // Signed server calls (cron, monitor) or the signed-in Upload page.
  if (!guard(req, res, checkSessionOrInternal)) return;

  const internal = isInternalRequest(req.headers);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let params: Record<string, any> = req.body || {};
  if (!internal) {
    // Browser: everything comes from the slot's saved Settings; only the slot is taken from the body.
    const slot = params.keySlot === "A" ? "A" : "B";
    const s = await readEmailSettings(slot);
    if (!(s.emailAlerts && s.dailySummary && s.notifEmail)) {
      return res.status(200).json({ emailed: false, skipped: "Daily digest email is off in Settings" });
    }
    params = { slot, to: s.notifEmail, cc: s.ccEmail || undefined };
  }
  const { slot = "B", to, cc, dryRun = false, preview = false, accountName = "B-ARM" } = params;
  // The uploads are B-ARM's; there is no second account's data to build a digest from.
  if (slot !== "B") return res.status(200).json({ emailed: false, skipped: "the upload digest is for B-ARM (slot B) only" });
  if (!to && !dryRun) return res.status(400).json({ error: "to is required (or dryRun: true)" });

  const sending = !dryRun && !preview;
  const force = internal && params.force === true;
  const day = !sending && /^\d{4}-\d{2}-\d{2}$/.test(String(params.date || "")) ? String(params.date) : digestDay();
  let claimed = false;
  const release = () => supabasePublic.from(STATE_TABLE).delete().match({ key_slot: slot, alert_type: ALERT_TYPE, entity_id: day })
    .then(({ error }) => { if (error) console.error("[Marketplace360] upload-digest claim release failed:", error.message); });

  try {
    if (sending) {
      const waiting = digestWaitingFor(await uploadsLanded(day));
      if (waiting.length) {
        return res.status(200).json({ emailed: false, day, waitingFor: waiting, skipped: `waiting for ${waiting.join(", ")} (no ${day} data yet)` });
      }
      // The Upload page calls after its own upload has finished; the cron and monitor cannot know.
      if (internal && (await uploadRunning())) {
        return res.status(200).json({ emailed: false, day, skipped: `an upload is still being saved — sends once nothing was written for ${DIGEST_SETTLE_MINUTES} minutes` });
      }
      if (force) await release();
      const claim = await claimDay(slot, day);
      if (!claim.claimed) return res.status(200).json({ emailed: false, day, skipped: `${claim.reason} for ${day}` });
      claimed = true;
    }

    const digest = await loadDigest(day);
    if (dryRun) return res.status(200).json({ dryRun: true, ...digest });

    const r = await internalFetch(`${internalOrigin()}/api/send-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "uploadDigest", to, cc, preview: preview || undefined,
        subject: `📊 Marketplace360 - Daily Digest · ${new Date(day + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}`,
        data: { ...digest, accountName, channel: null },
      }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let emailResult: any = await r.json().catch(() => ({}));
    if (!r.ok) emailResult = { error: emailResult?.error || "send-email failed" };
    const emailed = sending && !emailResult.error;

    if (sending && emailed) {
      const { error } = await supabasePublic.from(STATE_TABLE).update({
        severity: 1, last_sent_at: new Date().toISOString(),
        details: { title: `Daily digest ${day}`, emailed: true, sales: Math.round(digest.total.sales), adSpend: Math.round(digest.total.adSpend) },
      }).match({ key_slot: slot, alert_type: ALERT_TYPE, entity_id: day });
      if (error) console.error("[Marketplace360] upload-digest state write failed:", error.message);
    } else if (sending) {
      await release(); // not sent: free the day so the next caller retries
    }
    // Browser callers get the outcome only, never the figures or the rendered email.
    return res.status(200).json({ day, emailed, emailError: emailResult?.error, ...(internal ? { emailResult, total: digest.total, lateNotes: digest.lateNotes } : {}) });
  } catch (err) {
    if (claimed) await release();
    return res.status(500).json({ error: err instanceof Error ? err.message : "upload-digest failed" });
  }
}
