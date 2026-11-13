// Weekly "rating dropped below 4★" email (src/lib/ratingDropAlert.ts): listings that were 4★+ in
// the previous ratings snapshot and are below 4★ in the latest, at any review count. Each product name
// links to its Amazon (ASIN) or Flipkart (FSN) page. No mail when nothing crossed (user, 2026-10-12).
//
// Sent as soon as a new week's ratings are in Supabase and settled (user, 2026-11-13): the ratings
// collector writes straight to Supabase — there is no dashboard upload — so a snapshot is ready once it
// is at most 7 days old and no row of it was written in the last 60 minutes (isSettled). At most once
// per CHANNEL snapshot (state in barm_alert_state, alert_type "ratingDropWeekly", entity_id =
// "Platform|snapshot date"; plain-date rows are from before 2026-10-25 — see platformsToMail). Callers:
//   - Supabase pg_cron rating_drop_mail_tick(), every 30 minutes, when an unmailed snapshot has settled
//     (supabase/migrations/20261113120000_rating_drop_mail_tick.sql) — the main trigger;
//   - the 9:00 AM IST Monday cron (scheduled-reports.ts) and the Ratings & Reviews "Upload weekly data"
//     dialog (signed-in browser session; account and recipients come from that slot's saved Settings,
//     never from the request) — both simply ask the same question.
//
// POST body (signed server calls): { slot?, amazon_account_id, workspace_id, to, cc?, dryRun?, preview?, force? }
// POST body (browser session):      { keySlot }
//   dryRun: compute and return the rows, send nothing (skips the freshness/once-per-snapshot checks)
//   preview: render the email and return its HTML (send-email preview), send nothing
//   force:   signed server calls only — resend a snapshot already mailed (freshness/settled checks still apply)

import type { NextApiRequest, NextApiResponse } from "next";
import { resolveSellerMateKey } from "@/lib/adAlerts";
import { supabasePublic } from "@/lib/amazonReportUpload";
import { readEmailSettings } from "@/lib/emailSettingsStore";
import { fetchRatingMetrics, groupListings } from "@/lib/productRatingMetrics";
import { findRatingDrops, toRatingDrop, bareSku, platformsToMail, platformSnapshotKey, isSettled, RATING_DROP_LIMIT, RATING_DROP_MIN_REVIEWS, RATING_SNAPSHOT_SETTLE_MINUTES } from "@/lib/ratingDropAlert";
import { internalFetch, internalOrigin } from "@/lib/internalFetch";
import { checkSessionOrInternal, guard, isInternalRequest } from "@/lib/apiAuth";

const SELLERMATE_BASE_URL = "https://api.sellermate.ai/public/v1/tools";
const STATE_TABLE = "barm_alert_state";
const ALERT_TYPE = "ratingDropWeekly";

export const config = { maxDuration: 120 };

const istToday = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

/** SKU → ASIN from the SellerMate catalog. Best-effort: a failure only drops the links. */
async function asinBySku(skus: string[], apiKey: string, base: { amazon_account_id: string; workspace_id: string }) {
  const out = new Map<string, string>();
  if (!skus.length) return out;
  try {
    const r = await fetch(`${SELLERMATE_BASE_URL}/list_product_catalog`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ ...base, skus, include_suppressed: true, limit: 200 }),
    });
    if (!r.ok) throw new Error(await r.text());
    const j = await r.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const p of (j.products || []) as any[]) if (p.sku && p.asin) out.set(String(p.sku), String(p.asin));
  } catch (err) {
    console.error("[Marketplace360] rating-drop ASIN lookup failed:", err instanceof Error ? err.message : err);
  }
  return out;
}

/** SKU → FSN from Flipkart orders (stored as "SKU" or "SKU:SKU"). Best-effort, like asinBySku. */
async function fsnBySku(skus: string[]) {
  const out = new Map<string, string>();
  if (!skus.length) return out;
  const { data, error } = await supabasePublic
    .from("fk_orders").select("sku,fsn").in("sku", [...skus, ...skus.map((s) => `SKU:${s}`)]).neq("fsn", "").limit(1000);
  if (error) { console.error("[Marketplace360] rating-drop FSN lookup failed:", error.message); return out; }
  for (const r of data || []) if (r.fsn) out.set(String(r.sku).replace(/^SKU:/, ""), String(r.fsn));
  return out;
}

/** Channel snapshots already mailed for this slot (state entity_ids). */
async function sentSnapshots(slot: string): Promise<string[]> {
  const { data, error } = await supabasePublic
    .from(STATE_TABLE).select("entity_id").eq("key_slot", slot).eq("alert_type", ALERT_TYPE).limit(1000);
  if (error) throw new Error(`alert state read failed: ${error.message}`);
  return (data || []).map((r) => String(r.entity_id));
}

/** When the newest row of one channel's snapshot was written (null if unknown). */
async function lastWriteAt(platform: string, snapshotDate: string): Promise<string | null> {
  const { data, error } = await supabasePublic
    .from("product_rating_review_history").select("captured_at")
    .eq("platform", platform).eq("snapshot_date", snapshotDate).not("captured_at", "is", null)
    .order("captured_at", { ascending: false }).limit(1);
  if (error) throw new Error(`ratings write-time read failed: ${error.message}`);
  return (data?.[0]?.captured_at as string | undefined) ?? null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!guard(req, res, checkSessionOrInternal)) return;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let params: Record<string, any> = req.body || {};
  if (!isInternalRequest(req.headers)) {
    const slot = params.keySlot === "A" ? "A" : "B";
    const s = await readEmailSettings(slot);
    if (!(s.emailAlerts && (s.ratingDropAlerts ?? slot === "B") && s.notifEmail)) {
      return res.status(200).json({ emailed: false, skipped: "Rating drop email is off in Settings" });
    }
    params = { slot, amazon_account_id: s.amazonAccountId, workspace_id: s.workspaceId, to: s.notifEmail, cc: s.ccEmail || undefined };
  }
  const { slot = "B", amazon_account_id, workspace_id, to, cc, dryRun = false, preview = false, accountName = slot === "A" ? "Lkn" : "B-ARM" } = params;
  if (!amazon_account_id || !workspace_id) {
    return res.status(400).json({ error: "amazon_account_id and workspace_id are required" });
  }
  const sending = !dryRun && !preview;
  const force = isInternalRequest(req.headers) && params.force === true;

  try {
    const m = await fetchRatingMetrics();
    if (!m.snapshotDate || !m.previousDate) {
      return res.status(200).json({ emailed: false, skipped: "need two ratings snapshots to compare" });
    }
    // Channels to mail: each channel's newest snapshot, if taken this week and not mailed before.
    // dryRun / preview show every channel; force ignores what was already mailed.
    const pending = platformsToMail(m.platformDates, force ? [] : await sentSnapshots(slot), istToday());
    if (sending) {
      if (!pending.length) {
        return res.status(200).json({ emailed: false, skipped: `no new ratings data this week to mail (latest is ${m.snapshotDate})` });
      }
      // Wait until every one of them has stopped changing, so one mail carries the whole week.
      const writes = await Promise.all(pending.map((x) => lastWriteAt(x.platform, x.current)));
      const arriving = pending.filter((_, i) => !isSettled(writes[i], Date.now())).map((x) => x.platform);
      if (arriving.length) {
        return res.status(200).json({ emailed: false, skipped: `ratings still arriving for ${arriving.join(", ")} — sends once no new rows for ${RATING_SNAPSHOT_SETTLE_MINUTES} minutes` });
      }
    }
    const mailPlatforms = new Set(pending.map((x) => x.platform));
    const snapshot = sending ? pending.map((x) => x.current).sort().reverse()[0] : m.snapshotDate;
    const previousDate = sending ? pending.map((x) => x.previous).sort().reverse()[0] : m.previousDate;

    const listings = findRatingDrops(groupListings(m.items)).filter((l) => !sending || mailPlatforms.has(l.platform));
    const skusOf = (platform: string) => [...new Set(listings.filter((l) => l.platform === platform).flatMap((l) => l.skus.map((s) => bareSku(s.skuId))).filter(Boolean))];
    const apiKey = resolveSellerMateKey(slot === "B" ? "B" : "A");
    const [asins, fsns] = await Promise.all([
      apiKey ? asinBySku(skusOf("Amazon"), apiKey, { amazon_account_id, workspace_id }) : Promise.resolve(new Map<string, string>()),
      fsnBySku(skusOf("Flipkart")),
    ]);
    const drops = listings.map((l) => toRatingDrop(l, l.platform === "Flipkart" ? fsns : asins));
    const summary = { snapshotDate: snapshot, previousDate, channels: sending ? [...mailPlatforms] : undefined, drops: drops.length };

    if (dryRun) return res.status(200).json({ ...summary, dryRun: true, rows: drops });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let emailResult: any = null;
    if (to && drops.length) {
      const r = await internalFetch(`${internalOrigin()}/api/send-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "ratingDrop", to, cc, preview: preview || undefined,
          subject: `⭐ Marketplace360 - ${drops.length} listing${drops.length === 1 ? "" : "s"} dropped below ${RATING_DROP_LIMIT}★ this week`,
          data: { drops, snapshotDate: snapshot, previousDate, minReviews: RATING_DROP_MIN_REVIEWS, accountName, channel: null },
        }),
      });
      emailResult = await r.json().catch(() => ({}));
      if (!r.ok) emailResult = { error: emailResult?.error || "send-email failed" };
    }
    const emailed = sending && !!(to && drops.length && emailResult && !emailResult.error);
    // Mark each channel snapshot done once mailed, or once checked with nothing below 4★. A failed send is retried.
    if (sending && (emailed || drops.length === 0)) {
      const { error: upErr } = await supabasePublic.from(STATE_TABLE).upsert(
        pending.map((x) => ({ key_slot: slot, alert_type: ALERT_TYPE, entity_id: platformSnapshotKey(x.platform, x.current), severity: 1, last_sent_at: new Date().toISOString(),
          details: { title: `Rating drop ${x.platform} ${x.current} vs ${x.previous}`, drops: drops.filter((d) => d.platform === x.platform).length, emailed } })),
        { onConflict: "key_slot,alert_type,entity_id" },
      );
      if (upErr) console.error("[Marketplace360] rating-drop state write failed:", upErr.message);
    }
    return res.status(200).json({ ...summary, emailed, emailError: emailResult?.error, ...(isInternalRequest(req.headers) ? { emailResult } : {}) });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : "rating-drop-alert failed" });
  }
}
