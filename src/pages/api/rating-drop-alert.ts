// Weekly "rating dropped below 4★" email (src/lib/ratingDropAlert.ts): listings that were 4★+ in
// the previous ratings snapshot and are below 4★ in the latest, at any review count. Each product name
// links to its Amazon (ASIN) or Flipkart (FSN) page. No mail when nothing crossed (user, 2026-10-12).
//
// Monday mail, sent only once that week's ratings upload is in (snapshot ≤ 6 days old), at most once
// per snapshot (state in barm_alert_state, alert_type "ratingDropWeekly", entity_id = snapshot date):
//   - the 9:00 AM IST Monday cron (scheduled-reports.ts), if the upload was already done;
//   - the Ratings & Reviews page, right after "Upload weekly data" (signed-in browser session;
//     account and recipients come from that slot's saved Settings, never from the request).
//
// POST body (signed server calls): { slot?, amazon_account_id, workspace_id, to, cc?, dryRun?, preview?, force? }
// POST body (browser session):      { keySlot }
//   dryRun: compute and return the rows, send nothing (skips the freshness/once-per-snapshot checks)
//   preview: render the email and return its HTML (send-email preview), send nothing
//   force:   signed server calls only — resend a snapshot already mailed (Monday/freshness checks still apply)

import type { NextApiRequest, NextApiResponse } from "next";
import { resolveSellerMateKey } from "@/lib/adAlerts";
import { supabasePublic } from "@/lib/amazonReportUpload";
import { readEmailSettings } from "@/lib/emailSettingsStore";
import { fetchRatingMetrics, groupListings } from "@/lib/productRatingMetrics";
import { findRatingDrops, toRatingDrop, bareSku, isThisWeeksSnapshot, RATING_DROP_LIMIT, RATING_DROP_MIN_REVIEWS } from "@/lib/ratingDropAlert";
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

async function alreadySent(slot: string, snapshot: string): Promise<boolean> {
  const { data, error } = await supabasePublic
    .from(STATE_TABLE).select("entity_id").eq("key_slot", slot).eq("alert_type", ALERT_TYPE).eq("entity_id", snapshot).limit(1);
  if (error) throw new Error(`alert state read failed: ${error.message}`);
  return (data || []).length > 0;
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
    const snapshot = m.snapshotDate;
    if (sending) {
      // Mondays only (user, 2026-10-12): an upload on another day is mailed by the next Monday's 9 AM run.
      if (new Date(istToday() + "T00:00:00Z").getUTCDay() !== 1) {
        return res.status(200).json({ emailed: false, skipped: "goes out on Monday — the next Monday 9 AM run will send it" });
      }
      if (!isThisWeeksSnapshot(snapshot, istToday())) {
        return res.status(200).json({ emailed: false, skipped: `waiting for this week's ratings upload (latest is ${snapshot})` });
      }
      if (!force && await alreadySent(slot, snapshot)) {
        return res.status(200).json({ emailed: false, skipped: `already sent for ${snapshot}` });
      }
    }

    const listings = findRatingDrops(groupListings(m.items));
    const skusOf = (platform: string) => [...new Set(listings.filter((l) => l.platform === platform).flatMap((l) => l.skus.map((s) => bareSku(s.skuId))).filter(Boolean))];
    const apiKey = resolveSellerMateKey(slot === "B" ? "B" : "A");
    const [asins, fsns] = await Promise.all([
      apiKey ? asinBySku(skusOf("Amazon"), apiKey, { amazon_account_id, workspace_id }) : Promise.resolve(new Map<string, string>()),
      fsnBySku(skusOf("Flipkart")),
    ]);
    const drops = listings.map((l) => toRatingDrop(l, l.platform === "Flipkart" ? fsns : asins));
    const summary = { snapshotDate: snapshot, previousDate: m.previousDate, drops: drops.length };

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
          data: { drops, snapshotDate: snapshot, previousDate: m.previousDate, minReviews: RATING_DROP_MIN_REVIEWS, accountName, channel: null },
        }),
      });
      emailResult = await r.json().catch(() => ({}));
      if (!r.ok) emailResult = { error: emailResult?.error || "send-email failed" };
    }
    const emailed = sending && !!(to && drops.length && emailResult && !emailResult.error);
    // Mark the snapshot done once mailed, or once checked with nothing below 4★. A failed send is retried.
    if (sending && (emailed || drops.length === 0)) {
      const { error: upErr } = await supabasePublic.from(STATE_TABLE).upsert(
        [{ key_slot: slot, alert_type: ALERT_TYPE, entity_id: snapshot, severity: 1, last_sent_at: new Date().toISOString(),
          details: { title: `Rating drop ${snapshot}`, drops: drops.length, emailed } }],
        { onConflict: "key_slot,alert_type,entity_id" },
      );
      if (upErr) console.error("[Marketplace360] rating-drop state write failed:", upErr.message);
    }
    return res.status(200).json({ ...summary, emailed, emailError: emailResult?.error, ...(isInternalRequest(req.headers) ? { emailResult } : {}) });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : "rating-drop-alert failed" });
  }
}
