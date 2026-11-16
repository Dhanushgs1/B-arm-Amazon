"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useQueries } from "@tanstack/react-query";
import { Database, X } from "lucide-react";
import { fetchTableLastDate, lastDateKey } from "@/lib/tableLastDates";
import type { SourceBoxData } from "@/lib/dataSources";
import { cn } from "@/lib/utils";

const dot = (iso: string) => (iso ? iso.split("-").reverse().join(".") : "");

/** The "where is this number from" box: source, tables and how it is worked out, per part. */
export function SourceBox({ data, onClose }: { data: SourceBoxData | null; onClose: () => void }) {
  useEffect(() => {
    if (!data) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [data, onClose]);

  // Last day of data on file for each table in the open box (tableLastDates.ts); read once and kept
  // for five minutes. A table with no lookup, or whose read fails, simply shows no date.
  const keys = [...new Set((data?.parts ?? []).flatMap((p) => p.info.tables.map((t) => lastDateKey(t, p.channel)).filter((k): k is string => !!k)))];
  const lastQ = useQueries({
    queries: keys.map((k) => ({ queryKey: ["table-last-date", k], queryFn: () => fetchTableLastDate(k), staleTime: 5 * 60_000, retry: 1 })),
  });
  const lastOf = (key: string | null) => (key ? lastQ[keys.indexOf(key)] : undefined);

  if (!data || typeof document === "undefined") return null;
  const single = data.parts.length === 1;

  return createPortal(
    // Clicks inside a portal still bubble through React to the card that opened it (a link on the
    // platform cards), so they are stopped here.
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={(e) => e.stopPropagation()}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label={`Where ${data.title} comes from`} className="relative w-full max-w-xl max-h-[85vh] bg-background border border-border rounded-2xl shadow-2xl flex flex-col overflow-hidden text-foreground">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-border bg-muted/30">
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-300 flex items-center gap-1.5">
              <Database className="w-3 h-3" /> Where this number comes from
            </p>
            <h2 className="text-base font-black mt-1">{data.title}</h2>
            <p className="text-2xl font-black tracking-tight">{data.value}</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">Dates: {dot(data.start)} – {dot(data.end)}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4 space-y-3">
          {data.formula && (
            <p className="text-xs rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-2">
              <span className="font-black">How it is worked out: </span>{data.formula}
            </p>
          )}
          {data.parts.map((p) => {
            const stale = !!p.dataThrough && p.dataThrough < data.end;
            return (
              <div key={p.label} className="rounded-xl border border-border p-3 space-y-1.5">
                {!single && (
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm font-black">{p.label}</span>
                    {p.value !== undefined && <span className="text-sm font-black">{p.value}</span>}
                  </div>
                )}
                <dl className="grid grid-cols-[72px_1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-muted-foreground font-bold">Source</dt>
                  <dd>{p.info.source}</dd>
                  <dt className="text-muted-foreground font-bold">{p.info.tables.length === 1 ? "Table" : "Tables"}</dt>
                  <dd className="space-y-1">
                    {p.info.tables.length === 0 ? "—" : p.info.tables.map((t) => {
                      const q = lastOf(lastDateKey(t, p.channel));
                      const late = !!q?.data && q.data < data.end;
                      return (
                        <div key={t} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          <code className="px-1.5 py-0.5 rounded-md bg-muted text-[11px] font-mono">{t}</code>
                          {q?.isLoading && <span className="text-[11px] text-muted-foreground">checking last date…</span>}
                          {q?.data && <span className={cn("text-[11px]", late ? "text-amber-600 dark:text-amber-400 font-bold" : "text-muted-foreground")}>data up to {dot(q.data)}</span>}
                          {q && q.isSuccess && !q.data && <span className="text-[11px] text-muted-foreground">no data on file</span>}
                        </div>
                      );
                    })}
                  </dd>
                  <dt className="text-muted-foreground font-bold">How</dt>
                  <dd>{p.info.how}</dd>
                  {p.note && (
                    <>
                      <dt className="text-muted-foreground font-bold">These dates</dt>
                      <dd>{p.note}</dd>
                    </>
                  )}
                  {p.dataThrough && (
                    <>
                      <dt className="text-muted-foreground font-bold">Data up to</dt>
                      <dd className={cn(stale && "text-amber-600 dark:text-amber-400 font-bold")}>
                        {dot(p.dataThrough)}{stale ? " — stops before the end of the selected dates" : ""}
                      </dd>
                    </>
                  )}
                </dl>
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** A number that opens the source box when clicked. Safe inside a link: the click does not follow it. */
export function SourceValue({ data, children, className }: { data: SourceBoxData | null; children: React.ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  if (!data) return <>{children}</>;
  const show = (e: React.SyntheticEvent) => { e.preventDefault(); e.stopPropagation(); setOpen(true); };
  return (
    <>
      <span
        role="button"
        tabIndex={0}
        title="Click to see where this number comes from"
        onClick={show}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") show(e); }}
        className={cn("cursor-pointer underline decoration-dotted decoration-muted-foreground/60 underline-offset-4 hover:decoration-emerald-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 rounded-sm", className)}
      >
        {children}
      </span>
      <SourceBox data={open ? data : null} onClose={() => setOpen(false)} />
    </>
  );
}
