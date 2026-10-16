// Monthly Search Terms mail (src/lib/searchTermMonthly.ts): the account's Amazon search terms for the
// period (1st – 30th; a 31st rolls into the next month) in four sheets — Orders 0, ACOS above 50%,
// ACOS 25–50%, ACOS 13–25% — mailed on the period's last day to the slot's Settings recipients.
// Search terms come live from SellerMate (get_search_term_performance), grouped like the Search Terms
// page (search term × campaign × ad group). Every send is logged in barm_search_term_mail_log, which
// the Search Terms page's Mail tab shows.
//
// Callers:
//   - the daily 9:00 AM IST cron (scheduled-reports.ts), trigger "cron": sends only on the period's
//     last day, once per slot and period;
//   - the Mail tab: "Send now" (trigger "manual") mails the current period so far, and "Download"
//     (download: true) returns the workbook without mailing.
//
// POST body (signed server calls): { slot, amazon_account_id, workspace_id, to, cc?, trigger: "cron" }
// POST body (browser session):      { keySlot, trigger: "manual" | "download", period?: "previous" }

import type { NextApiRequest, NextApiResponse } from "next";
import * as XLSX from "xlsx-js-style";
import { supabasePublic } from "@/lib/amazonReportUpload";
import { resolveSellerMateKey } from "@/lib/adAlerts";
import { readEmailSettings } from "@/lib/emailSettingsStore";
import { internalFetch, internalOrigin } from "@/lib/internalFetch";
import { checkSessionOrInternal, guard, isInternalRequest } from "@/lib/apiAuth";
import { emailSendingPaused, EMAIL_PAUSED_ERROR } from "@/lib/emailPause";
import { escapeHtml } from "@/lib/htmlEscape";
import {
  SHEETS, bucketRows, toRow, istToday, periodContaining, periodDueOn, latestDuePeriod, dmy,
  type MonthlyPeriod, type SearchTermRow,
} from "@/lib/searchTermMonthly";

const LOG = "barm_search_term_mail_log";
const SELLERMATE_BASE_URL = "https://api.sellermate.ai/public/v1/tools";
const PAGE_SIZE = 500;
const MAX_PAGES = 60;
const CONCURRENCY = 2;
const MAX_RETRIES = 5;

export const config = { maxDuration: 300 };

/** Every search term row for the window. Throws on any failed page, so a partial pull is never mailed. */
async function fetchSearchTerms(apiKey: string, accountId: string, workspaceId: string, start: string, end: string): Promise<SearchTermRow[]> {
  // SellerMate limits requests in flight at once (429 "Too many concurrent requests"), so pages are
  // fetched two at a time and a 429 waits (Retry-After, else 2s, 4s, 8s …) and tries again.
  const call = async (page: number) => {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(`${SELLERMATE_BASE_URL}/get_search_term_performance`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
        body: JSON.stringify({
          amazon_account_id: accountId, workspace_id: workspaceId, start_date: start, end_date: end,
          group_by: ["searchTerm", "campaignName", "adGroupName"], page, page_size: PAGE_SIZE,
        }),
      });
      if (r.status === 429 && attempt < MAX_RETRIES) {
        const after = Number(r.headers.get("retry-after"));
        await new Promise((ok) => setTimeout(ok, after > 0 ? Math.min(after, 30) * 1000 : 2000 * 2 ** attempt));
        continue;
      }
      if (!r.ok) throw new Error(`SellerMate search terms (page ${page}): ${await r.text()}`);
      return r.json();
    }
  };
  const first = await call(0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: any[] = [...(first.data || [])];
  const totalPages = Number(first.pagination?.totalPages) || 1;
  if (totalPages > MAX_PAGES) throw new Error(`Too many search term pages (${totalPages})`);
  for (let p = 1; p < totalPages; p += CONCURRENCY) {
    const batch = Array.from({ length: Math.min(CONCURRENCY, totalPages - p) }, (_, i) => call(p + i));
    for (const res of await Promise.all(batch)) all.push(...(res.data || []));
  }
  return all.map(toRow).filter((r) => r.searchTerm);
}

const COLS: { key: keyof SearchTermRow; label: string; width: number; fmt?: string }[] = [
  { key: "searchTerm", label: "Search Term", width: 40 },
  { key: "campaignName", label: "Campaign", width: 40 },
  { key: "adGroupName", label: "Ad Group", width: 28 },
  { key: "spend", label: "Spend", width: 12, fmt: "#,##0.00" },
  { key: "sales", label: "Sales", width: 12, fmt: "#,##0.00" },
  { key: "acos", label: "ACOS %", width: 10, fmt: "0.00" },
  { key: "orders", label: "Orders", width: 9, fmt: "0" },
  { key: "clicks", label: "Clicks", width: 9, fmt: "0" },
  { key: "impressions", label: "Impressions", width: 12, fmt: "#,##0" },
  { key: "cpc", label: "CPC", width: 9, fmt: "0.00" },
  { key: "ctr", label: "CTR %", width: 9, fmt: "0.00" },
];

function buildWorkbook(buckets: Record<string, SearchTermRow[]>, period: { start: string; end: string }) {
  const wb = XLSX.utils.book_new();
  const head = { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "4F46E5" } }, alignment: { vertical: "center" } };
  for (const s of SHEETS) {
    const rows = buckets[s.key];
    const aoa = [
      [`${s.title} — search terms ${dmy(period.start)} to ${dmy(period.end)} (${rows.length})`],
      COLS.map((c) => c.label),
      ...rows.map((r) => COLS.map((c) => (c.key === "acos" ? (r.acos == null ? "" : r.acos) : r[c.key]))),
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["A1"].s = { font: { bold: true, sz: 12 } };
    COLS.forEach((c, ci) => {
      const h = ws[XLSX.utils.encode_cell({ r: 1, c: ci })];
      if (h) h.s = head;
      if (c.fmt) for (let ri = 2; ri < aoa.length; ri++) {
        const cell = ws[XLSX.utils.encode_cell({ r: ri, c: ci })];
        if (cell && cell.t === "n") cell.z = c.fmt;
      }
    });
    ws["!cols"] = COLS.map((c) => ({ wch: c.width }));
    ws["!autofilter"] = { ref: XLSX.utils.encode_range({ r: 1, c: 0 }, { r: Math.max(1, aoa.length - 1), c: COLS.length - 1 }) };
    XLSX.utils.book_append_sheet(wb, ws, s.name);
  }
  return wb;
}

const money = (v: number, currency: string) => `${currency === "INR" ? "₹" : "$"}${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(v))}`;

function mailHtml(buckets: Record<string, SearchTermRow[]>, period: { start: string; end: string }, label: string, accountName: string, currency: string, partial: boolean) {
  const rows = SHEETS.map((s) => {
    const list = buckets[s.key];
    const spend = list.reduce((a, r) => a + r.spend, 0);
    const top = list.slice(0, 5).map((r) => escapeHtml(r.searchTerm)).join(", ");
    return `<tr><td style="padding:6px 10px;border:1px solid #e5e7eb;font-weight:600">${escapeHtml(s.title)}</td>`
      + `<td style="padding:6px 10px;border:1px solid #e5e7eb;text-align:right">${list.length}</td>`
      + `<td style="padding:6px 10px;border:1px solid #e5e7eb;text-align:right">${money(spend, currency)}</td>`
      + `<td style="padding:6px 10px;border:1px solid #e5e7eb;color:#6b7280">${top || "—"}</td></tr>`;
  }).join("");
  return `<div style="font-family:Arial,sans-serif;font-size:13px;color:#111827">`
    + `<p>Hi team,</p>`
    + `<p>${escapeHtml(accountName)} Amazon search terms for <b>${escapeHtml(label)}</b> — <b>${dmy(period.start)} to ${dmy(period.end)}</b>${partial ? " (so far)" : ""}. The attached workbook has one sheet per group below.</p>`
    + `<table style="border-collapse:collapse;margin:10px 0"><tr style="background:#eef2ff">`
    + `<th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:left">Sheet</th><th style="padding:6px 10px;border:1px solid #e5e7eb">Search terms</th>`
    + `<th style="padding:6px 10px;border:1px solid #e5e7eb">Spend</th><th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:left">Top by spend</th></tr>${rows}</table>`
    + `<p style="color:#6b7280;font-size:12px">Each month runs to the 30th; a 31st is counted in the next month's mail. Orders 0 = spend with no order. ACOS bands: above 50%, 25%–50%, 13% to under 25%.</p>`
    + `</div>`;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!guard(req, res, checkSessionOrInternal)) return;

  const internal = isInternalRequest(req.headers);
  const body = req.body || {};
  const slot = (internal ? body.slot : body.keySlot) === "A" ? "A" : "B";
  const trigger: "cron" | "manual" | "download" = internal ? "cron" : body.trigger === "download" ? "download" : "manual";

  // Account and recipients: the signed cron passes them; a browser always gets the slot's saved Settings.
  const s = await readEmailSettings(slot);
  const accountId = internal ? body.amazon_account_id : s.amazonAccountId;
  const workspaceId = internal ? body.workspace_id : s.workspaceId;
  const to: string | undefined = internal ? body.to : s.notifEmail;
  const cc: string | undefined = (internal ? body.cc : s.ccEmail) || undefined;
  const currency = s.currency || "INR";
  const accountName = slot === "A" ? "Lkn" : "B-ARM";
  const apiKey = resolveSellerMateKey(slot);

  const today = istToday();
  let period: MonthlyPeriod & { partial: boolean };
  if (trigger === "cron") {
    const due = periodDueOn(today);
    if (!due) return res.status(200).json({ emailed: false, skipped: `not due — the ${periodContaining(today).label} mail goes on ${periodContaining(today).end}` });
    period = { ...due, partial: false };
  } else if (body.period === "previous") {
    period = { ...latestDuePeriod(today), partial: false };
  } else {
    // The current period so far: its start to today (the whole period on its last day).
    const cur = periodContaining(today);
    period = { ...cur, end: today, partial: cur.end > today };
  }
  const recipients = to ? `to: ${to}${cc ? ` | cc: ${cc}` : ""}` : "";

  const log = async (status: string, counts: Record<string, number> | null, error: string | null = null) => {
    if (trigger === "download") return;
    const { error: e } = await supabasePublic.from(LOG).insert({
      key_slot: slot, trigger, period_label: period.label, period_start: period.start, period_end: period.end,
      partial: period.partial, counts: counts ?? {}, recipients, status, error,
    });
    if (e) console.error("[Marketplace360] search-term mail log failed:", e.message);
  };

  try {
    if (!apiKey || !accountId || !workspaceId) throw new Error("SellerMate key or account is not set up — save Settings once for this account.");
    if (trigger !== "download" && !to) throw new Error("No recipient — set the notification email in Settings.");

    if (trigger === "cron") {
      const { data: prev, error: pErr } = await supabasePublic.from(LOG).select("id")
        .eq("key_slot", slot).eq("period_end", period.end).eq("partial", false).eq("status", "sent").limit(1);
      if (pErr) throw new Error(`mail log read failed: ${pErr.message}`);
      if (prev?.length) return res.status(200).json({ emailed: false, skipped: `already sent for ${period.label}` });
    }

    const rows = await fetchSearchTerms(apiKey, accountId, workspaceId, period.start, period.end);
    const buckets = bucketRows(rows);
    const counts = Object.fromEntries(SHEETS.map((x) => [x.key, buckets[x.key].length]));
    const wb = buildWorkbook(buckets, period);
    const content = (XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: true }) as Buffer).toString("base64");
    const filename = `${accountName}_Search_Terms_${period.start}_to_${period.end}.xlsx`;

    if (trigger === "download") return res.status(200).json({ period, counts, totalTerms: rows.length, filename, content });

    if (emailSendingPaused()) {
      await log("paused", counts, EMAIL_PAUSED_ERROR);
      return res.status(200).json({ emailed: false, status: "paused", period, counts, error: EMAIL_PAUSED_ERROR });
    }
    const r = await internalFetch(`${internalOrigin()}/api/send-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "custom", to, cc,
        subject: `${accountName} Search Terms — ${period.label} (${dmy(period.start)} to ${dmy(period.end)}${period.partial ? ", so far" : ""})`,
        data: { html: mailHtml(buckets, period, period.label, accountName, currency, period.partial), channel: "amazon" },
        attachments: [{ filename, content, encoding: "base64" }],
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const error = j?.error || `send-email ${r.status}`;
      await log("failed", counts, error);
      return res.status(200).json({ emailed: false, status: "failed", period, counts, error });
    }
    await log("sent", counts);
    return res.status(200).json({ emailed: true, status: "sent", period, counts, recipients });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Marketplace360] search-term monthly mail failed:", message);
    await log("failed", null, message);
    return res.status(trigger === "download" ? 500 : 200).json({ emailed: false, status: "failed", period, error: message });
  }
}
