// "Name in the Current stock sheet but not in the FC sheet" mail (src/lib/fcNameCheck.ts).
// Called by the Consolidated Stock Sheet right after a godown or restock upload, and by its
// "Check now" button. Compares the latest Current stock sheet with the latest godown snapshot, mails
// the missing names to FC_ALERT_TO, and logs every check in barm_fc_name_alerts (the page's status).
// The same missing names for the same two files are mailed once; "Check now" (force) mails again.
//
// POST body: { trigger?: "restock" | "godown" | "manual", force?: boolean }

import type { NextApiRequest, NextApiResponse } from "next";
import { supabasePublic } from "@/lib/amazonReportUpload";
import { fetchAllRows } from "@/lib/amazonReportShared";
import { internalFetch, internalOrigin } from "@/lib/internalFetch";
import { checkSessionOrInternal, guard } from "@/lib/apiAuth";
import { emailSendingPaused, EMAIL_PAUSED_ERROR } from "@/lib/emailPause";
import { FC_ALERT_TO, missingFromFc, sameNames, fcAlertSubject, fcAlertHtml, type FcAlertStatus } from "@/lib/fcNameCheck";

const LOG = "barm_fc_name_alerts";

async function latestDate(table: string): Promise<string | null> {
  const { data, error } = await supabasePublic.from(table).select("snapshot_date").order("snapshot_date", { ascending: false }).limit(1);
  if (error) throw new Error(`${table}: ${error.message}`);
  return (data?.[0]?.snapshot_date as string | undefined) ?? null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!guard(req, res, checkSessionOrInternal)) return;
  const { trigger = "manual", force = false } = req.body || {};
  const recipients = FC_ALERT_TO.join(", ");

  const log = async (status: FcAlertStatus, restockDate: string | null, godownDate: string | null, missing: string[], error: string | null = null) => {
    const { error: e } = await supabasePublic.from(LOG).insert({
      trigger: String(trigger), restock_date: restockDate, godown_date: godownDate, missing, recipients, status, error,
    });
    if (e) console.error("[Marketplace360] fc-name-alert log failed:", e.message);
    return { status, restockDate, godownDate, missing, recipients, error };
  };

  try {
    const [restockDate, godownDate] = await Promise.all([latestDate("barm_restock_transit_inputs"), latestDate("barm_godown_stock")]);
    if (!restockDate || !godownDate) {
      return res.status(200).json({ status: "skipped", error: "Needs both a Current stock sheet and a godown sheet uploaded." });
    }
    const [restock, godown] = await Promise.all([
      fetchAllRows("barm_restock_transit_inputs", (q) => q.eq("snapshot_date", restockDate), "product"),
      fetchAllRows("barm_godown_stock", (q) => q.eq("snapshot_date", godownDate), "product"),
    ]);
    const missing = missingFromFc(restock.map((r) => String(r.product)), godown.map((g) => String(g.product)));
    if (!missing.length) return res.status(200).json(await log("nothing_missing", restockDate, godownDate, missing));

    if (!force) {
      const { data: prev } = await supabasePublic.from(LOG).select("missing").eq("status", "sent")
        .eq("restock_date", restockDate).eq("godown_date", godownDate).order("checked_at", { ascending: false }).limit(1);
      if (prev?.[0] && sameNames(prev[0].missing as string[], missing)) {
        return res.status(200).json(await log("already_sent", restockDate, godownDate, missing));
      }
    }
    if (emailSendingPaused()) return res.status(200).json(await log("paused", restockDate, godownDate, missing, EMAIL_PAUSED_ERROR));

    const r = await internalFetch(`${internalOrigin()}/api/send-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "custom", to: recipients, subject: fcAlertSubject(missing, restockDate),
        data: { html: fcAlertHtml(missing, restockDate, godownDate), channel: null },
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(200).json(await log("failed", restockDate, godownDate, missing, j?.error || `send-email ${r.status}`));
    return res.status(200).json(await log("sent", restockDate, godownDate, missing));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Marketplace360] fc-name-alert failed:", message);
    return res.status(500).json({ status: "failed", error: message });
  }
}
