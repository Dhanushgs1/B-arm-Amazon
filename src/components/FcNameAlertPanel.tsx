"use client";

// Mail status for "name in the Current stock sheet but not in the FC sheet" (src/lib/fcNameCheck.ts):
// the latest check, its missing names, who it was mailed to, and the earlier checks.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabasePublic } from "@/lib/amazonReportUpload";
import { FC_ALERT_TO, type FcAlertRow, type FcAlertStatus } from "@/lib/fcNameCheck";
import { Loader2, Mail, RefreshCw } from "lucide-react";

export const FC_ALERTS_KEY = ["fc_name_alerts"];

/** Runs the check (and sends the mail when names are missing). Never throws: returns the API's answer. */
export async function runFcCheck(trigger: "restock" | "godown" | "manual", force = false): Promise<{ status: string; missing?: string[]; error?: string | null }> {
  try {
    const r = await fetch("/api/fc-name-alert", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trigger, force }) });
    const j = await r.json().catch(() => ({}));
    return r.ok ? j : { status: "failed", error: j?.error || `HTTP ${r.status}` };
  } catch (e) {
    return { status: "failed", error: e instanceof Error ? e.message : "request failed" };
  }
}

const LABEL: Record<FcAlertStatus, { text: string; cls: string }> = {
  sent: { text: "Mail sent", cls: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300" },
  failed: { text: "Mail failed", cls: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300" },
  nothing_missing: { text: "All names in FC sheet — no mail", cls: "bg-muted text-muted-foreground" },
  already_sent: { text: "Already mailed — not sent again", cls: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300" },
  paused: { text: "Not sent — email paused", cls: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200" },
};
const chip = (s: FcAlertStatus) => {
  const l = LABEL[s] ?? { text: s, cls: "bg-muted text-muted-foreground" };
  return <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold ${l.cls}`}>{l.text}</span>;
};
const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const dmy = (iso: string | null) => (iso ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : "—");

export function FcNameAlertPanel() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery<FcAlertRow[]>({
    queryKey: FC_ALERTS_KEY,
    queryFn: async () => {
      const { data, error } = await supabasePublic.from("barm_fc_name_alerts").select("*").order("checked_at", { ascending: false }).limit(6);
      if (error) throw new Error(error.message);
      return (data ?? []) as FcAlertRow[];
    },
  });
  const latest = data?.[0];

  const checkNow = async () => {
    setBusy(true);
    setErr(null);
    const r = await runFcCheck("manual", true);
    if (r.status === "failed" || r.status === "skipped") setErr(r.error ?? "Check failed");
    await qc.invalidateQueries({ queryKey: FC_ALERTS_KEY });
    setBusy(false);
  };

  return (
    <div className="glass rounded-2xl border border-border p-4" id="fc-name-alert">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Mail className="h-4 w-4 text-indigo-600" />
          <p className="text-sm font-bold">FC sheet name check — mail status</p>
          {latest && chip(latest.status)}
        </div>
        <button onClick={checkNow} disabled={busy} title="Check the latest Current stock sheet against the latest FC sheet and mail the missing names now" className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-bold hover:bg-muted disabled:opacity-60">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Check &amp; send now
        </button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        After each upload, product names in the Current stock sheet that are not in the FC Stock sheet are mailed to <b className="text-foreground">{FC_ALERT_TO.join(", ")}</b>.
      </p>
      {err && <p className="mt-2 text-xs font-semibold text-red-700 dark:text-red-400">{err}</p>}
      {isLoading ? (
        <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</p>
      ) : error ? (
        <p className="mt-3 text-xs font-semibold text-red-700 dark:text-red-400">Mail status couldn&apos;t load: {(error as Error).message}</p>
      ) : !latest ? (
        <p className="mt-3 text-xs text-muted-foreground">No check yet — it runs on the next upload, or press Check &amp; send now.</p>
      ) : (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-muted-foreground">
            Last check {when(latest.checked_at)} IST · Current stock sheet of <b className="text-foreground">{dmy(latest.restock_date)}</b> vs FC sheet as on <b className="text-foreground">{dmy(latest.godown_date)}</b>
            {latest.error && <span className="text-red-700 dark:text-red-400"> · {latest.error}</span>}
          </p>
          {latest.missing.length > 0 && (
            <div>
              <p className="text-xs font-bold">Not in the FC sheet ({latest.missing.length})</p>
              <ul className="mt-1 flex flex-wrap gap-1.5">
                {latest.missing.map((n) => <li key={n} className="rounded-md bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-800 dark:bg-red-950/60 dark:text-red-300">{n}</li>)}
              </ul>
            </div>
          )}
          {data!.length > 1 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="text-left text-muted-foreground"><th className="py-1 pr-3 font-semibold">Checked</th><th className="py-1 pr-3 font-semibold">After</th><th className="py-1 pr-3 font-semibold">Missing</th><th className="py-1 font-semibold">Status</th></tr></thead>
                <tbody>
                  {data!.slice(1).map((r) => (
                    <tr key={r.id} className="border-t border-border">
                      <td className="py-1 pr-3 whitespace-nowrap">{when(r.checked_at)}</td>
                      <td className="py-1 pr-3 capitalize">{r.trigger}</td>
                      <td className="py-1 pr-3 tabular-nums">{r.missing.length}</td>
                      <td className="py-1">{chip(r.status)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
