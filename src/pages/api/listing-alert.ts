// Listing Team mail: products of the latest Current stock sheet whose every Amazon SKU is inactive or
// no longer on Amazon (src/lib/listingCheck.ts). Called by the Consolidated Stock Sheet after a restock
// upload and by its "Check & send now" button. Logs every check in barm_listing_alerts. The same
// products for the same sheet are mailed once; force (the button) mails again.
//
// POST body: { trigger?: "restock" | "manual", force?: boolean }

import type { NextApiRequest, NextApiResponse } from "next";
import { supabasePublic } from "@/lib/amazonReportUpload";
import { fetchAllRows } from "@/lib/amazonReportShared";
import { resolveSellerMateKey } from "@/lib/adAlerts";
import { readEmailSettings } from "@/lib/emailSettingsStore";
import { internalFetch, internalOrigin } from "@/lib/internalFetch";
import { checkSessionOrInternal, guard } from "@/lib/apiAuth";
import { emailSendingPaused, EMAIL_PAUSED_ERROR } from "@/lib/emailPause";
import { sameNames, type FcAlertStatus } from "@/lib/fcNameCheck";
import { LISTING_ALERT_TO, LISTING_ALERT_CC, listingProblems, listingAlertSubject, listingAlertHtml, type ListingProblem } from "@/lib/listingCheck";

const LOG = "barm_listing_alerts";
const SELLERMATE_BASE_URL = "https://api.sellermate.ai/public/v1/tools";

export const config = { maxDuration: 120 };

/** Every SKU on the B-ARM Amazon account (inactive / suppressed included) → its status. Throws unless
 *  the whole catalog was read, so a partial read never reports live SKUs as deleted. */
async function amazonCatalog(): Promise<Map<string, unknown>> {
  const apiKey = resolveSellerMateKey("B");
  const s = await readEmailSettings("B");
  if (!apiKey || !s.amazonAccountId || !s.workspaceId) throw new Error("SellerMate key or B-ARM account is not set up (Settings)");
  const out = new Map<string, unknown>();
  let offset = 0, total = Infinity;
  for (let i = 0; i < 50 && offset < total; i++) {
    const r = await fetch(`${SELLERMATE_BASE_URL}/list_product_catalog`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ amazon_account_id: s.amazonAccountId, workspace_id: s.workspaceId, include_suppressed: true, limit: 200, offset }),
    });
    if (!r.ok) throw new Error(`SellerMate catalog: ${await r.text()}`);
    const j = await r.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const page = (j.products || []) as any[];
    for (const p of page) if (p.sku) out.set(String(p.sku).trim(), p.status ?? p.statuses ?? null);
    total = Number(j.total ?? j.pagination?.total ?? (page.length < 200 ? offset + page.length : Infinity));
    offset += page.length;
    if (!page.length) break;
  }
  if (!out.size || offset < total) throw new Error(`SellerMate catalog read incompletely (${offset} of ${total})`);
  return out;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!guard(req, res, checkSessionOrInternal)) return;
  const { trigger = "manual", force = false } = req.body || {};
  const to = LISTING_ALERT_TO.join(", "), cc = LISTING_ALERT_CC.join(", ");
  const recipients = `to: ${to} | cc: ${cc}`;

  const log = async (status: FcAlertStatus, restockDate: string | null, problems: ListingProblem[], error: string | null = null) => {
    const { error: e } = await supabasePublic.from(LOG).insert({
      trigger: String(trigger), restock_date: restockDate, missing: problems.map((p) => p.product), details: problems, recipients, status, error,
    });
    if (e) console.error("[Marketplace360] listing-alert log failed:", e.message);
    return { status, restockDate, missing: problems.map((p) => p.product), details: problems, recipients, error };
  };

  let restockDate: string | null = null;
  try {
    const { data: d, error: dErr } = await supabasePublic.from("barm_restock_transit_inputs").select("snapshot_date").order("snapshot_date", { ascending: false }).limit(1);
    if (dErr) throw new Error(dErr.message);
    restockDate = (d?.[0]?.snapshot_date as string | undefined) ?? null;
    if (!restockDate) return res.status(200).json({ status: "skipped", error: "No Current stock sheet uploaded yet." });
    const [restock, master, catalog] = await Promise.all([
      fetchAllRows("barm_restock_transit_inputs", (q) => q.eq("snapshot_date", restockDate), "product"),
      fetchAllRows("master_product_skuid", (q) => q, "id"),
      amazonCatalog(),
    ]);
    const { problems } = listingProblems(
      restock.map((r) => String(r.product)),
      master.map((m) => ({ product: String(m["Product Name"] ?? ""), sku: String(m["SKU ID"] ?? ""), platform: String(m["Platform"] ?? "") })),
      catalog,
    );
    if (!problems.length) return res.status(200).json(await log("nothing_missing", restockDate, problems));

    if (!force) {
      const { data: prev } = await supabasePublic.from(LOG).select("missing").eq("status", "sent").eq("restock_date", restockDate)
        .order("checked_at", { ascending: false }).limit(1);
      if (prev?.[0] && sameNames(prev[0].missing as string[], problems.map((p) => p.product))) {
        return res.status(200).json(await log("already_sent", restockDate, problems));
      }
    }
    if (emailSendingPaused()) return res.status(200).json(await log("paused", restockDate, problems, EMAIL_PAUSED_ERROR));

    const r = await internalFetch(`${internalOrigin()}/api/send-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "custom", to, cc, subject: listingAlertSubject(problems, restockDate), data: { html: listingAlertHtml(problems, restockDate), channel: "amazon" } }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(200).json(await log("failed", restockDate, problems, j?.error || `send-email ${r.status}`));
    return res.status(200).json(await log("sent", restockDate, problems));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Marketplace360] listing-alert failed:", message);
    return res.status(200).json(await log("failed", restockDate, [], message));
  }
}
