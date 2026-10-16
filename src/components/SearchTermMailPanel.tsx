"use client";

// Mail tab on the Search Terms page: the monthly Search Terms mail (src/pages/api/search-term-monthly-mail.ts)
// — its schedule, this period, recipients, on/off, Send now / Download, and the send log
// (barm_search_term_mail_log).

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabasePublic } from "@/lib/amazonReportUpload";
import { SHEETS, istToday, periodContaining, latestDuePeriod, dmy } from "@/lib/searchTermMonthly";
import { CalendarClock, Download, Loader2, Mail, Send } from "lucide-react";

const LOG_KEY = ["search_term_mail_log"];

interface LogRow {
  id: number; checked_at: string; key_slot: string; trigger: string; period_label: string;
  period_start: string; period_end: string; partial: boolean; counts: Record<string, number>;
  recipients: string; status: string; error: string | null;
}

const STATUS: Record<string, { text: string; cls: string }> = {
  sent: { text: "Mail sent", cls: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300" },
  failed: { text: "Mail failed", cls: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300" },
  paused: { text: "Not sent — email paused", cls: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200" },
};
const chip = (s: string) => {
  const l = STATUS[s] ?? { text: s, cls: "bg-muted text-muted-foreground" };
  return <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold ${l.cls}`}>{l.text}</span>;
};
const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

type ApiResult = { status?: string; error?: string; counts?: Record<string, number>; filename?: string; content?: string; totalTerms?: number };

async function callMail(keySlot: string, trigger: "manual" | "download", period?: "previous"): Promise<ApiResult> {
  try {
    const r = await fetch("/api/search-term-monthly-mail", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keySlot, trigger, period }),
    });
    const j = await r.json().catch(() => ({}));
    return r.ok ? j : { status: "failed", error: j?.error || `HTTP ${r.status}` };
  } catch (e) {
    return { status: "failed", error: e instanceof Error ? e.message : "request failed" };
  }
}

function saveBase64(filename: string, b64: string) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SearchTermMailPanel({ keySlot }: { keySlot: string }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const today = istToday();
  const current = periodContaining(today);
  const previous = latestDuePeriod(today);
  const daysLeft = Math.round((Date.parse(current.end) - Date.parse(today)) / 86_400_000);

  const settingsKey = ["email_settings", keySlot];
  const { data: settings } = useQuery<Record<string, unknown>>({
    queryKey: settingsKey,
    queryFn: async () => (await fetch(`/api/email-settings?keySlot=${keySlot}`)).json(),
  });
  const enabled = (settings?.searchTermMonthly as boolean | undefined) ?? keySlot === "B";
  const to = (settings?.notifEmail as string) || "";
  const cc = (settings?.ccEmail as string) || "";

  const { data: log, isLoading, error } = useQuery<LogRow[]>({
    queryKey: [...LOG_KEY, keySlot],
    queryFn: async () => {
      const { data, error } = await supabasePublic.from("barm_search_term_mail_log").select("*")
        .eq("key_slot", keySlot).order("checked_at", { ascending: false }).limit(12);
      if (error) throw new Error(error.message);
      return (data ?? []) as LogRow[];
    },
  });
  const lastSent = log?.find((r) => r.status === "sent" && !r.partial && r.period_end === previous.end);

  const toggle = async () => {
    setBusy("toggle");
    await fetch("/api/email-settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keySlot, searchTermMonthly: !enabled }) }).catch(() => {});
    await qc.invalidateQueries({ queryKey: settingsKey });
    setBusy(null);
  };

  const send = async () => {
    if (!confirm(`Mail the ${current.label} search terms (${dmy(current.start)} to ${dmy(today)}) to ${to || "the Settings email"} now?`)) return;
    setBusy("send"); setMsg(null);
    const r = await callMail(keySlot, "manual");
    setMsg(r.status === "sent" ? { ok: true, text: "Mail sent." } : { ok: false, text: r.error || "Mail not sent" });
    await qc.invalidateQueries({ queryKey: [...LOG_KEY, keySlot] });
    setBusy(null);
  };

  const download = async (which: "current" | "previous") => {
    setBusy(which); setMsg(null);
    const r = await callMail(keySlot, "download", which === "previous" ? "previous" : undefined);
    if (r.content && r.filename) {
      saveBase64(r.filename, r.content);
      setMsg({ ok: true, text: `Downloaded ${r.filename} — ${SHEETS.map((s) => `${s.name}: ${r.counts?.[s.key] ?? 0}`).join(" · ")}` });
    } else setMsg({ ok: false, text: r.error || "Download failed" });
    setBusy(null);
  };

  const btn = "flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-bold hover:bg-muted disabled:opacity-60";

  return (
    <div className="space-y-4">
      <div className="glass rounded-2xl border border-border p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-indigo-600" />
            <p className="text-sm font-bold">Monthly Search Terms mail</p>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${enabled ? "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300" : "bg-muted text-muted-foreground"}`}>{enabled ? "On" : "Off"}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={toggle} disabled={!!busy || !settings} className={btn}>{busy === "toggle" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{enabled ? "Turn off" : "Turn on"}</button>
            <button onClick={() => download("current")} disabled={!!busy} className={btn} title="Build this period's workbook so far, without mailing">
              {busy === "current" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} This month so far
            </button>
            <button onClick={() => download("previous")} disabled={!!busy} className={btn} title={`Workbook for ${previous.label} (${dmy(previous.start)} to ${dmy(previous.end)})`}>
              {busy === "previous" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} {previous.label}
            </button>
            <button onClick={send} disabled={!!busy || !to} className={`${btn} border-indigo-300 text-indigo-700 dark:text-indigo-300`}>
              {busy === "send" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Send now
            </button>
          </div>
        </div>

        <p className="mt-2 text-xs text-muted-foreground">
          Goes out on the <b className="text-foreground">30th of every month at 9:00 AM IST</b> (February: its last day) with that month&apos;s
          search terms from the <b className="text-foreground">1st to the 30th</b>. A 31st is counted in the next month&apos;s mail. Sent to{" "}
          <b className="text-foreground">{to || "— (set the notification email in Settings)"}</b>{cc && <> (cc {cc})</>}.
        </p>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-border p-3">
            <p className="text-[11px] font-semibold text-muted-foreground">This period</p>
            <p className="text-sm font-bold">{current.label}: {dmy(current.start)} → {dmy(current.end)}</p>
          </div>
          <div className="rounded-xl border border-border p-3">
            <p className="flex items-center gap-1 text-[11px] font-semibold text-muted-foreground"><CalendarClock className="h-3 w-3" /> Next mail</p>
            <p className="text-sm font-bold">{dmy(current.end)}, 9:00 AM IST {daysLeft === 0 ? "(today)" : `(in ${daysLeft} day${daysLeft === 1 ? "" : "s"})`}</p>
          </div>
          <div className="rounded-xl border border-border p-3">
            <p className="text-[11px] font-semibold text-muted-foreground">Last period ({previous.label})</p>
            <p className="text-sm font-bold">{lastSent ? `Sent ${when(lastSent.checked_at)}` : "No mail sent"}</p>
          </div>
        </div>

        <div className="mt-4">
          <p className="text-xs font-bold">Sheets in the mail</p>
          <ul className="mt-1 grid grid-cols-1 gap-1.5 text-xs sm:grid-cols-2 lg:grid-cols-4">
            {SHEETS.map((s) => (
              <li key={s.key} className="rounded-md bg-muted px-2 py-1 font-semibold">{s.name}
                <span className="block font-normal text-muted-foreground">
                  {s.key === "orders0" ? "Spend with 0 orders" : s.key === "acos50" ? "ACOS > 50%" : s.key === "acos25" ? "25% ≤ ACOS ≤ 50%" : "13% ≤ ACOS < 25%"}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {msg && <p className={`mt-3 text-xs font-semibold ${msg.ok ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}>{msg.text}</p>}
      </div>

      <div className="glass rounded-2xl border border-border p-5">
        <p className="text-sm font-bold">Mail history</p>
        {isLoading ? (
          <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</p>
        ) : error ? (
          <p className="mt-3 text-xs font-semibold text-red-700 dark:text-red-400">Mail history couldn&apos;t load: {(error as Error).message}</p>
        ) : !log?.length ? (
          <p className="mt-3 text-xs text-muted-foreground">No mail yet — the first goes out on {dmy(current.end)}, or press Send now.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-3 font-semibold">When</th><th className="py-1 pr-3 font-semibold">Period</th><th className="py-1 pr-3 font-semibold">By</th>
                  {SHEETS.map((s) => <th key={s.key} className="py-1 pr-3 font-semibold">{s.name}</th>)}
                  <th className="py-1 pr-3 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {log.map((r) => (
                  <tr key={r.id} className="border-t border-border align-top">
                    <td className="py-1.5 pr-3 whitespace-nowrap">{when(r.checked_at)}</td>
                    <td className="py-1.5 pr-3 whitespace-nowrap">{r.period_label} · {dmy(r.period_start)} → {dmy(r.period_end)}{r.partial && <span className="text-muted-foreground"> (so far)</span>}</td>
                    <td className="py-1.5 pr-3">{r.trigger === "cron" ? "Auto" : "Send now"}</td>
                    {SHEETS.map((s) => <td key={s.key} className="py-1.5 pr-3 tabular-nums">{r.counts?.[s.key] ?? "—"}</td>)}
                    <td className="py-1.5 pr-3">{chip(r.status)}{r.error && <span className="block max-w-[260px] text-red-700 dark:text-red-400">{r.error}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
