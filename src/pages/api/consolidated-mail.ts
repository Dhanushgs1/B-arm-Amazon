// Consolidated Stock Sheet "Send mail" (user, 2026-10-16). The page builds each file in the browser
// (consolidatedMailFiles) and posts it here one kind at a time; recipients are fixed per kind
// (src/lib/consolidatedMail.ts), never taken from the request.
//
// POST body: { kind: "nosales" | "runningout" | "consolidated", filename, content (base64 .xlsx), date, rows, tables }
// tables (user, 2026-11-18): the attached sheets' rows, shown as tables in the mail body too.

import type { NextApiRequest, NextApiResponse } from "next";
import { internalFetch, internalOrigin } from "@/lib/internalFetch";
import { checkSessionOrInternal, guard } from "@/lib/apiAuth";
import { emailSendingPaused, EMAIL_PAUSED_ERROR } from "@/lib/emailPause";
import { CONSOLIDATED_MAIL_RECIPIENTS } from "@/lib/consolidatedMail";
import type { ConsolidatedMailKind } from "@/lib/consolidatedStockExport";
import { cleanTables, consolidatedMailHtml } from "@/lib/consolidatedMailHtml";

export const config = { api: { bodyParser: { sizeLimit: "8mb" } }, maxDuration: 120 };

const TITLE: Record<ConsolidatedMailKind, string> = {
  nosales: "No sales & Sales dropped products",
  runningout: "Products running out of stock",
  consolidated: "Consolidate sheet",
};
const WHAT: Record<ConsolidatedMailKind, string> = {
  nosales: "the <b>No Sales products</b> (nothing shipped in the last 10 godown days, stock 5+) and <b>Sales dropped products</b> (Day 3 &gt; Day 2 &gt; Day 1) sheets",
  runningout: "the <b>Products running out of stock</b> sheet (under 30 days of stock left at the current rate)",
  consolidated: "the <b>Consolidated</b> sheet (the table below shows its key columns; every column is in the attachment)",
};


export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!guard(req, res, checkSessionOrInternal)) return;
  const { kind, filename, content, date = "", rows, tables } = req.body || {};
  const r = CONSOLIDATED_MAIL_RECIPIENTS[kind as ConsolidatedMailKind];
  if (!r) return res.status(400).json({ error: "unknown kind" });
  if (typeof content !== "string" || !content || typeof filename !== "string" || !/\.xlsx$/i.test(filename)) {
    return res.status(400).json({ error: "filename (.xlsx) and content (base64) are required" });
  }
  if (emailSendingPaused()) return res.status(503).json({ error: EMAIL_PAUSED_ERROR, paused: true });
  const k = kind as ConsolidatedMailKind;
  const html = consolidatedMailHtml(TITLE[k], WHAT[k], String(date), Number.isFinite(Number(rows)) ? Number(rows) : null, cleanTables(tables));
  try {
    const sent = await internalFetch(`${internalOrigin()}/api/send-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "custom", to: r.to.join(", "), cc: r.cc.join(", "), subject: `${TITLE[k]} — ${String(date)}`,
        data: { html, channel: null },
        attachments: [{ filename: filename.replace(/[\\/:*?"<>|]/g, "-"), content, encoding: "base64" }],
      }),
    });
    const j = await sent.json().catch(() => ({}));
    if (!sent.ok) return res.status(502).json({ error: j?.error || `send-email ${sent.status}` });
    return res.status(200).json({ sent: true, to: r.to, cc: r.cc });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
