// FBA inventory-based ad status alert (src/lib/fbaWarehouseAlerts.ts): pulls Live Inventory from
// SellerMate and evaluates each SKU over the complete list of eligible ("Yes") FBA FCs. A SKU alerts
// when fewer than 8 eligible FCs have stock, or when 8+ do but any of them holds 20 units or less.
// SKUs whose verdict the data cannot decide (no current rows, or unreported warehouses that could
// change the result) are not evaluated; they are counted as data-quality warnings in this
// endpoint's response (and the dry run) but, by request (2026-10-09), are not part of the email.
//
// Daily mode (daily: true — what the 9:00 AM cron sends since 2026-10-11, sheet "Mail to be
// triggered" row 3 "FBA stock"): mails every run that has at least one SKU failing the rule,
// listing every failing SKU (newly failing ones marked NEW), plus a CSV of every SKU's units in
// each of the 24 eligible FCs. Nothing failing, or no usable data, sends nothing (no empty mails). State is still recorded the same way, so NEW means "not in an earlier mail".
//
// Transition-based (daily: false): emails SKUs that NEWLY failed; sends nothing when nothing new failed. State in
// barm_alert_state, alert_type "fbaSkuCoverage", entity_id = SKU, severity 1 = failing (mailed),
// 0 = seen passing again (re-armed). The very first run has no state, so it mails everything
// currently failing once, as a baseline. (The older per-city rows, alert_type "fbaCityLow", are no longer read.)
// A SellerMate snapshot older than FBA_ALERT_MAX_SNAPSHOT_AGE_DAYS is refused, not evaluated.
//
// POST body: { slot?, amazon_account_id, workspace_id, to, cc?, threshold?, minFcs?, daily?, dryRun? }
//   dryRun: detect and report, but neither email nor record state
//   preview: render the email and return its HTML, send nothing, record no state

import type { NextApiRequest, NextApiResponse } from "next";
import { resolveSellerMateKey } from "@/lib/adAlerts";
import { supabasePublic } from "@/lib/amazonReportUpload";
import { fetchLiveInventory, sellerMateCaller } from "@/lib/sellerMateLiveInventory";
import {
  skuCoverage, findNewFailures, findNewDataGaps, isDataGap, ledgerSnapshot, snapshotAgeDays,
  FBA_ALERT_FCS, FBA_ALERT_MIN_FCS, FBA_ALERT_THRESHOLD, FBA_ALERT_MAX_SNAPSHOT_AGE_DAYS, type SkuCoverage,
} from "@/lib/fbaWarehouseAlerts";
import { resolveProductName } from "@/lib/categoryMap";
import { internalFetch, internalOrigin } from "@/lib/internalFetch";
import { checkInternal, guard } from "@/lib/apiAuth";

const STATE_TABLE = "barm_alert_state";
const ALERT_TYPE = "fbaSkuCoverage";
const GAP_ALERT_TYPE = "fbaSkuNoData"; // read for the response's data-gap counts; no longer written

export const config = { maxDuration: 300 };

// The seller's short master name where the SKU is known, else the clipped Amazon title — a 200-char
// listing title per row would push the first (baseline) email past Gmail's clipping size.
const shortName = (c: SkuCoverage) => {
  const name = resolveProductName(c.title, c.sku) || c.asin;
  return name.length > 48 ? name.slice(0, 48).trimEnd() + "…" : name;
};

/** Every SKU's units per eligible FC — the daily mail's "stock availability in the warehouses"
 *  attachment. Blank = unknown (not reported by SellerMate), 0 = confirmed empty. */
export function buildStockMatrixCsv(current: SkuCoverage[], threshold: number, minFcs: number): string {
  const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const status = (c: SkuCoverage) =>
    c.dataIssue === "noData" ? "No SellerMate data" : c.dataIssue === "undetermined" ? "Cannot decide (warehouses not reported)"
      : c.reason === "fewFcs" ? (c.stocked.length === 0 ? (c.elsewhere.length ? "Not in the eligible warehouses (stock elsewhere)" : "Out of stock") : `Low stock (under ${minFcs} warehouses)`)
      : c.reason === "lowUnits" ? `Very low (a warehouse at ${threshold} or less)` : "OK";
  const rows = [...current].sort((a, b) => a.sku.localeCompare(b.sku)).map((c) => {
    const units = new Map<string, number>([...c.stocked.map((s) => [s.fc, s.units] as [string, number]), ...c.zeroFcs.map((fc) => [fc, 0] as [string, number])]);
    return [c.sku, c.asin, c.title, status(c), c.stocked.length, c.totalUnits, ...FBA_ALERT_FCS.map((f) => (units.has(f.code) ? units.get(f.code) : "")),
      c.elsewhere.map((e) => `${e.fc} ${e.units}`).join("; ")].map(q).join(",");
  });
  const header = ["SKU", "ASIN", "Product", "Status", "Warehouses with stock", "Total units", ...FBA_ALERT_FCS.map((f) => `${f.code} (${f.region})`), "Outside the eligible warehouses (e.g. VSNC)"].map(q).join(",");
  return "﻿" + [header, ...rows].join("\r\n");
}

/** The send-email payload and the full CSV attachment for one run. Exported for the dry-run preview. */
export function buildAlertMail(
  failing: SkuCoverage[],
  meta: { threshold: number; minFcs: number; ledgerDate: string | null; accountName: string; stillFailing: number; firstRun: boolean },
  daily?: { newSkus: ReadonlySet<string>; current: SkuCoverage[]; passing: number },
) {
  const data = {
    products: failing.map((c) => ({
      sku: c.sku, name: shortName(c), reason: c.reason, stockedCount: c.stocked.length, totalUnits: c.totalUnits,
      stocked: c.reason === "fewFcs" ? c.stocked : [], low: c.low, unknownFcs: c.unknownFcs, elsewhere: c.elsewhere,
      isNew: daily ? daily.newSkus.has(c.sku) : undefined,
    })),
    eligibleFcs: FBA_ALERT_FCS.length, channel: "amazon", ...meta,
    ...(daily ? { daily: true, passing: daily.passing, newCount: failing.filter((c) => daily.newSkus.has(c.sku)).length } : {}),
  };
  // Every row of the email, uncapped — the body may stop early to stay under Gmail's clipping size.
  const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const fcl = (xs: { fc: string; units: number }[]) => xs.map((x) => `${x.fc} ${x.units}`).join("; ");
  const lines = [
    ["Type", "SKU", "ASIN", "Product", "Reason", "Warehouses with stock", "Warehouses at <=20 (units)", "Warehouses with stock (units)", "Warehouses with 0", "Unknown warehouses", "Total units", "Outside the eligible warehouses (units)"].map(q).join(","),
    ...failing.map((c) => ["Stock alert", c.sku, c.asin, c.title, c.reason === "fewFcs" ? `Fewer than ${meta.minFcs} warehouses have stock` : `A warehouse with stock has ${meta.threshold} units or less`,
      c.stocked.length, fcl(c.low), fcl(c.stocked), c.zeroFcs.join("; "), c.unknownFcs.join("; "), c.totalUnits, fcl(c.elsewhere)].map(q).join(",")),
  ];
  const csv = "﻿" + lines.join("\r\n");
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  const attachments = [
    ...(failing.length ? [{ filename: `fba-stock-alert-${meta.ledgerDate ?? "latest"}.csv`, content: b64(csv), encoding: "base64" }] : []),
    ...(daily ? [{ filename: `fba-stock-by-warehouse-${meta.ledgerDate ?? "latest"}.csv`, content: b64(buildStockMatrixCsv(daily.current, meta.threshold, meta.minFcs)), encoding: "base64" }] : []),
  ];
  return { data, attachments };
}

async function readState(slot: string, alertType: string) {
  const { data, error } = await supabasePublic
    .from(STATE_TABLE)
    .select("entity_id, severity")
    .eq("key_slot", slot)
    .eq("alert_type", alertType);
  if (error) throw new Error(`alert state read failed: ${error.message}`);
  return new Map<string, boolean>((data || []).map((r) => [r.entity_id, r.severity >= 1]));
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  // Cron/server-only: callable solely via internalFetch (signed with INTERNAL_API_SECRET).
  if (!guard(req, res, checkInternal)) return;

  const {
    slot = "B", amazon_account_id, workspace_id, to, cc,
    threshold = FBA_ALERT_THRESHOLD, minFcs = FBA_ALERT_MIN_FCS, dryRun = false, accountName = "B-ARM", daily = false, preview = false,
  } = req.body || {};
  if (!amazon_account_id || !workspace_id) {
    return res.status(400).json({ error: "amazon_account_id and workspace_id are required" });
  }
  const apiKey = resolveSellerMateKey(slot === "B" ? "B" : "A");
  if (!apiKey) return res.status(500).json({ error: `Missing SellerMate API key for slot ${slot}` });

  try {
    const inv = await fetchLiveInventory(sellerMateCaller(apiKey), { workspace_id, amazon_account_id });
    const snapshot = ledgerSnapshot(inv.products);
    // Stale stock must not drive alerts: refuse an old snapshot loudly rather than evaluate it.
    const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10); // IST date
    const age = snapshotAgeDays(snapshot, today);
    if (age === null) throw new Error("SellerMate returned no dated FBA ledger rows");
    if (age > FBA_ALERT_MAX_SNAPSHOT_AGE_DAYS) {
      throw new Error(`SellerMate snapshot ${snapshot.date} is ${age} days old (limit ${FBA_ALERT_MAX_SNAPSHOT_AGE_DAYS}) — not evaluated`);
    }
    const current = skuCoverage(inv.products, threshold, minFcs, undefined, snapshot);
    const evaluated = current.filter((c) => !isDataGap(c));
    // No evaluable SKU at all is a SellerMate failure, not "every SKU is fine" — and mailing every
    // SKU as a data gap would be noise. Report it instead.
    if (evaluated.length === 0) throw new Error("SellerMate returned no FBA warehouse rows with known units");
    // Every SKU at 0 units is a broken SellerMate feed, not a real network-wide stockout — mailing
    // every SKU as "Out of stock" would be wrong (user, 2026-10-12).
    if (evaluated.every((c) => c.totalUnits === 0)) throw new Error("SellerMate FBA stock is 0 for every SKU — feed looks broken, not evaluated");

    const [prior, priorGaps] = await Promise.all([readState(slot, ALERT_TYPE), readState(slot, GAP_ALERT_TYPE)]);
    const { failing, recovered, stillFailing } = findNewFailures(current, prior);
    const { newGaps, resolved, stillMissing } = findNewDataGaps(current, priorGaps);
    const failingNow = evaluated.filter((c) => c.reason !== null);
    const summary = {
      threshold, minFcs, ledgerDate: snapshot.date, snapshotAgeDays: age, eligibleFcs: FBA_ALERT_FCS.length,
      fcsInSnapshot: FBA_ALERT_FCS.filter((f) => snapshot.fcs.has(f.code)).length,
      checked: current.length, evaluated: evaluated.length, passing: evaluated.length - failingNow.length,
      failingFewFcs: failingNow.filter((c) => c.reason === "fewFcs").length,
      failingLowUnits: failingNow.filter((c) => c.reason === "lowUnits").length,
      noData: current.filter((c) => c.dataIssue === "noData").length,
      undetermined: current.filter((c) => c.dataIssue === "undetermined").length,
      partialData: evaluated.filter((c) => c.dataIssue === "partialData").length,
      newFailures: failing.length, stillFailing, recovered: recovered.length,
      newDataGaps: newGaps.length, stillMissing, dataResolved: resolved.length,
      firstRun: prior.size === 0 && priorGaps.size === 0,
    };

    if (dryRun) return res.status(200).json({ ...summary, dryRun: true, daily, failing, failingNow, recovered, newGaps, resolved });

    // Daily mode mails whenever anything is failing; transition mode only when something newly failed.
    const anything = daily ? failingNow.length > 0 : failing.length > 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let emailResult: any = null;
    if (to && anything) {
      const meta = { threshold, minFcs, ledgerDate: snapshot.date, accountName, stillFailing, firstRun: summary.firstRun };
      // Same order as findNewFailures: fewFcs first, then fewest stocked FCs, then the emptiest.
      const listed = daily
        ? [...failingNow].sort((a, b) => (a.reason === b.reason ? 0 : a.reason === "fewFcs" ? -1 : 1)
          || a.stocked.length - b.stocked.length || a.totalUnits - b.totalUnits || a.sku.localeCompare(b.sku))
        : failing;
      const { data, attachments } = buildAlertMail(listed, meta,
        daily ? { newSkus: new Set(failing.map((c) => c.sku)), current, passing: summary.passing } : undefined);
      const r = await internalFetch(`${internalOrigin()}/api/send-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "fbaWarehouseLow", to, cc, data, attachments, preview: preview || undefined }),
      });
      emailResult = await r.json().catch(() => ({}));
      if (!r.ok) emailResult = { error: emailResult?.error || "send-email failed" };
    }

    // Mark failures as mailed only when the mail actually went; a failed send retries next
    // run. Recoveries are recorded regardless — they send nothing, they only re-arm the SKU.
    const delivered = !preview && !!(to && anything && emailResult && !emailResult.error);
    const now = new Date().toISOString();
    const row = (alertType: string, c: SkuCoverage, severity: number) => ({
      key_slot: slot, alert_type: alertType, entity_id: c.sku, severity, last_sent_at: now,
      details: { title: c.sku, reason: c.reason, dataIssue: c.dataIssue, stockedFcs: c.stocked.length, lowFcs: c.low.length, unknownFcs: c.unknownFcs.length, threshold, minFcs, snapshot: snapshot.date },
    });
    const rows = [
      ...(delivered ? failing.map((c) => row(ALERT_TYPE, c, 1)) : []),
      ...(preview ? [] : recovered.map((c) => row(ALERT_TYPE, c, 0))),
    ];
    if (rows.length) {
      const { error: upErr } = await supabasePublic.from(STATE_TABLE).upsert(rows, { onConflict: "key_slot,alert_type,entity_id" });
      if (upErr) console.error("[Marketplace360] fba warehouse alert state write failed:", upErr.message);
    }

    return res.status(200).json({ ...summary, emailed: delivered, emailResult });
  } catch (err) {
    // No mail when the stock data could not be evaluated (stale/empty SellerMate snapshot) — an
    // email with nothing in it is noise (user, 2026-10-11). The cron log carries the error.
    return res.status(500).json({ error: err instanceof Error ? err.message : "fba-warehouse-alerts failed" });
  }
}
