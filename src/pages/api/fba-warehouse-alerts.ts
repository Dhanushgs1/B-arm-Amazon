// FBA warehouse low-stock alert (src/lib/fbaWarehouseAlerts.ts): pulls Live Inventory from
// SellerMate, rolls SKU stock up to the eight major FBA cities, and emails the SKU × city pairs
// that have NEWLY dropped below the threshold. Sends nothing when nothing new dropped.
//
// State: barm_alert_state rows with alert_type "fbaCityLow", entity_id "<city>|<sku>",
// severity 1 = low (already mailed), 0 = seen back at/above the threshold (re-armed).
// The very first run has no state, so it mails everything currently low once, as a baseline.
//
// POST body: { slot?, amazon_account_id, workspace_id, to, cc?, threshold?, dryRun? }
//   dryRun: detect and report, but neither email nor record state

import type { NextApiRequest, NextApiResponse } from "next";
import { resolveSellerMateKey } from "@/lib/adAlerts";
import { supabasePublic } from "@/lib/amazonReportUpload";
import { fetchLiveInventory, sellerMateCaller } from "@/lib/sellerMateLiveInventory";
import { cityStock, findNewDrops, FBA_ALERT_CITIES, type CityStock } from "@/lib/fbaWarehouseAlerts";
import { resolveProductName } from "@/lib/categoryMap";
import { internalFetch, internalOrigin } from "@/lib/internalFetch";
import { checkInternal, guard } from "@/lib/apiAuth";

const STATE_TABLE = "barm_alert_state";
const ALERT_TYPE = "fbaCityLow";

export const config = { maxDuration: 300 };

// The seller's short master name where the SKU is known, else the clipped Amazon title — a 200-char
// listing title per row would push the first (baseline) email past Gmail's clipping size.
const forEmail = (d: CityStock) => {
  const name = resolveProductName(d.title, d.sku) || d.asin;
  return { city: d.city, sku: d.sku, units: d.units, fcs: d.fcs, name: name.length > 40 ? name.slice(0, 40).trimEnd() + "…" : name };
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  // Cron/server-only: callable solely via internalFetch (signed with INTERNAL_API_SECRET).
  if (!guard(req, res, checkInternal)) return;

  const { slot = "B", amazon_account_id, workspace_id, to, cc, threshold = 20, dryRun = false, accountName = "B-ARM" } = req.body || {};
  if (!amazon_account_id || !workspace_id) {
    return res.status(400).json({ error: "amazon_account_id and workspace_id are required" });
  }
  const apiKey = resolveSellerMateKey(slot === "B" ? "B" : "A");
  if (!apiKey) return res.status(500).json({ error: `Missing SellerMate API key for slot ${slot}` });

  try {
    const inv = await fetchLiveInventory(sellerMateCaller(apiKey), { workspace_id, amazon_account_id });
    const current = cityStock(inv.products);
    // An empty pull is a SellerMate failure, not "every warehouse is fine" — and recording it would
    // re-arm nothing but would also hide the problem. Report it instead.
    if (current.length === 0) throw new Error("SellerMate returned no warehouse rows for the alert cities");

    const { data: stateRows, error: stateErr } = await supabasePublic
      .from(STATE_TABLE)
      .select("entity_id, severity")
      .eq("key_slot", slot)
      .eq("alert_type", ALERT_TYPE);
    if (stateErr) throw new Error(`alert state read failed: ${stateErr.message}`);
    const prior = new Map<string, boolean>((stateRows || []).map((r) => [r.entity_id, r.severity >= 1]));

    const { drops, recovered, stillLow } = findNewDrops(current, prior, threshold);
    const ledgerDate = inv.ledgerDates.at(-1) ?? null;
    const summary = {
      threshold, ledgerDate, cities: FBA_ALERT_CITIES.map((c) => c.city),
      checked: current.length, newDrops: drops.length, stillLow, recovered: recovered.length,
      firstRun: prior.size === 0,
    };

    if (dryRun) return res.status(200).json({ ...summary, dryRun: true, drops, recovered });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let emailResult: any = null;
    if (to && drops.length > 0) {
      const r = await internalFetch(`${internalOrigin()}/api/send-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "fbaWarehouseLow", to, cc,
          data: { drops: drops.map(forEmail), threshold, ledgerDate, accountName, stillLow, firstRun: summary.firstRun, channel: "amazon" },
        }),
      });
      emailResult = await r.json().catch(() => ({}));
      if (!r.ok) emailResult = { error: emailResult?.error || "send-email failed" };
    }

    // Mark drops as mailed only when the mail actually went; a failed send retries next run.
    // Recoveries are recorded regardless — they send nothing, they only re-arm the pair.
    const delivered = !!(to && drops.length > 0 && emailResult && !emailResult.error);
    const now = new Date().toISOString();
    const rows = [
      ...(delivered ? drops.map((d) => ({ d, severity: 1 })) : []),
      ...recovered.map((d) => ({ d, severity: 0 })),
    ].map(({ d, severity }) => ({
      key_slot: slot,
      alert_type: ALERT_TYPE,
      entity_id: d.key,
      severity,
      details: { title: `${d.city} · ${d.sku}`, units: d.units, threshold },
      last_sent_at: now,
    }));
    if (rows.length) {
      const { error: upErr } = await supabasePublic.from(STATE_TABLE).upsert(rows, { onConflict: "key_slot,alert_type,entity_id" });
      if (upErr) console.error("[Marketplace360] fba warehouse alert state write failed:", upErr.message);
    }

    return res.status(200).json({ ...summary, emailed: delivered, emailResult });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : "fba-warehouse-alerts failed" });
  }
}
