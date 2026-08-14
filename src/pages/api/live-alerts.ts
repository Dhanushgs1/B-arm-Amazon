// Runs the condition-driven detectors (src/lib/liveAlerts.ts), suppresses anything already
// reported, and sends ONE email containing whatever is genuinely new. Sends nothing at all when
// nothing fired — this arrives off-schedule, so an empty one would only teach the reader to skip it.
//
// Dedupe: barm_alert_state holds one row per (key_slot, alert_type, entity_id). An alert is
// re-sent only once its cooldown has passed, or immediately if its severity bucket worsened —
// a product going from "10 days of cover" to "2 days" should interrupt, a product sitting at
// "8 days" for a week should not.
//
// POST body: { slot?, amazon_account_id, workspace_id, to, cc?, currency?, send?,
//              cooldownHours?, types?, dryRun? }
//   types:  optional subset of ["spendSpike","stockoutForecast","buyBoxLoss","conversionDrop"]
//   dryRun: detect and report, but neither email nor record state (safe to call repeatedly)

import type { NextApiRequest, NextApiResponse } from "next";
import { resolveSellerMateKey } from "@/lib/adAlerts";
import { supabasePublic } from "@/lib/amazonReportUpload";
import { findSpendSpikes, findStockoutForecasts, findBuyBoxLosses, findConversionDrops, type LiveAlert, type AlertType } from "@/lib/liveAlerts";
import { internalFetch } from "@/lib/internalFetch";

const ALL_TYPES: AlertType[] = ["spendSpike", "stockoutForecast", "buyBoxLoss", "conversionDrop"];
const STATE_TABLE = "barm_alert_state";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const {
    slot = "B", amazon_account_id, workspace_id, to, cc, currency = "INR",
    send = true, cooldownHours = 24, types, dryRun = false, accountName = "B-ARM",
  } = req.body || {};

  if (!amazon_account_id || !workspace_id) {
    return res.status(400).json({ error: "amazon_account_id and workspace_id are required" });
  }
  const apiKey = resolveSellerMateKey(slot === "B" ? "B" : "A");
  if (!apiKey) return res.status(500).json({ error: `Missing SellerMate API key for slot ${slot}` });

  const wanted: AlertType[] = Array.isArray(types) && types.length ? types.filter((t: AlertType) => ALL_TYPES.includes(t)) : ALL_TYPES;
  const ctx = { apiKey, amazon_account_id, workspace_id, now: new Date() };

  try {
    // allSettled, not all: a detector whose upstream call fails must not take the other three
    // down with it — but its failure is reported rather than passing for "found nothing", which
    // looks identical in the response and is the opposite in meaning.
    const allRunners: { type: AlertType; run: () => Promise<LiveAlert[]> }[] = [
      { type: "spendSpike", run: () => findSpendSpikes(ctx) },
      { type: "stockoutForecast", run: () => findStockoutForecasts(ctx) },
      { type: "buyBoxLoss", run: () => findBuyBoxLosses(ctx) },
      { type: "conversionDrop", run: () => findConversionDrops(ctx) },
    ];
    const runners = allRunners.filter((r) => wanted.includes(r.type));

    const settled = await Promise.allSettled(runners.map((r) => r.run()));
    const found: LiveAlert[] = [];
    const failed: { type: AlertType; error: string }[] = [];
    settled.forEach((s, i) => {
      if (s.status === "fulfilled") found.push(...s.value);
      else {
        const msg = s.reason instanceof Error ? s.reason.message : String(s.reason);
        failed.push({ type: runners[i].type, error: msg.slice(0, 300) });
        console.error(`[Marketplace360] live-alerts detector ${runners[i].type} failed:`, msg);
      }
    });

    // ── Suppress what has already been reported ──
    const { data: stateRows, error: stateErr } = await supabasePublic
      .from(STATE_TABLE)
      .select("alert_type, entity_id, severity, last_sent_at")
      .eq("key_slot", slot);
    if (stateErr) throw new Error(`alert state read failed: ${stateErr.message}`);

    const seen = new Map<string, { severity: number; last_sent_at: string }>();
    (stateRows || []).forEach((r) => seen.set(`${r.alert_type}|${r.entity_id}`, { severity: r.severity, last_sent_at: r.last_sent_at }));

    const cooldownMs = cooldownHours * 3600_000;
    const suppressed: { key: string; why: string }[] = [];
    const fresh = found.filter((a) => {
      const prior = seen.get(`${a.type}|${a.entityId}`);
      if (!prior) return true;
      const age = ctx.now.getTime() - new Date(prior.last_sent_at).getTime();
      if (age >= cooldownMs) return true;
      // Interrupt early only when the situation actually deteriorated.
      if (a.severity > prior.severity) return true;
      suppressed.push({ key: `${a.type}|${a.entityId}`, why: `sent ${Math.round(age / 3600_000)}h ago, severity ${prior.severity}` });
      return false;
    });

    fresh.sort((a, b) => b.severity - a.severity || b.impact - a.impact);

    const summary = {
      found: found.length,
      fresh: fresh.length,
      suppressed: suppressed.length,
      byType: Object.fromEntries(ALL_TYPES.map((t) => [t, fresh.filter((a) => a.type === t).length])),
      // Non-empty means this run's counts are incomplete — those detectors reported nothing
      // because they broke, not because there was nothing to report.
      failedDetectors: failed,
    };

    if (dryRun) {
      return res.status(200).json({ ...summary, dryRun: true, alerts: fresh, suppressedDetail: suppressed });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let emailResult: any = null;
    if (send && to && fresh.length > 0) {
      const proto = (req.headers["x-forwarded-proto"] as string) || "http";
      const host = req.headers.host;
      const r = await internalFetch(`${proto}://${host}/api/send-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "liveAlerts", to, cc,
          data: {
            alerts: fresh, currency, accountName, cooldownHours, channel: "amazon",
            windowNote: "compared against the previous equal-length window",
          },
        }),
      });
      emailResult = await r.json().catch(() => ({}));
      if (!r.ok) emailResult = { error: emailResult?.error || "send-email failed" };
    }

    // Record state only for what actually went out — a failed send must be retried next run,
    // not silently marked as delivered.
    const delivered = !!(send && to && fresh.length > 0 && emailResult && !emailResult.error);
    if (delivered) {
      const rows = fresh.map((a) => ({
        key_slot: slot,
        alert_type: a.type,
        entity_id: a.entityId,
        severity: a.severity,
        details: { title: a.title, impact: Math.round(a.impact) },
        last_sent_at: ctx.now.toISOString(),
      }));
      const { error: upErr } = await supabasePublic.from(STATE_TABLE).upsert(rows, { onConflict: "key_slot,alert_type,entity_id" });
      if (upErr) console.error("[Marketplace360] alert state write failed:", upErr.message);
    }

    return res.status(200).json({ ...summary, emailed: delivered, emailResult, alerts: fresh });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : "live-alerts failed" });
  }
}
