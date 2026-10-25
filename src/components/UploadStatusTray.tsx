"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { CheckCircle2, XCircle, AlertTriangle, Loader2, X, ChevronDown, ChevronUp, UploadCloud } from "lucide-react";
import { getJobs, subscribe, dismissJob, dismissFinished, latestJob, isAnyRunning, type UploadJob } from "@/lib/uploadTracker";
import { cn } from "@/lib/utils";

const NONE: UploadJob[] = [];

/** Every tracked upload, newest first — re-renders when one starts, moves or finishes. */
export function useUploadJobs(): UploadJob[] {
  return useSyncExternalStore(subscribe, getJobs, () => NONE);
}

/** The latest upload a card started (by its key), for showing it again when you come back. */
export function useUploadJob(key: string): UploadJob | undefined {
  useUploadJobs();
  return latestJob(key);
}

const elapsed = (from: number, to: number) => {
  const s = Math.max(0, Math.round((to - from) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

const ICON = {
  running: <Loader2 className="w-4 h-4 animate-spin text-indigo-500 shrink-0" />,
  done: <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />,
  warning: <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />,
  error: <XCircle className="w-4 h-4 text-red-500 shrink-0" />,
};
const STATUS_TEXT = { running: "Uploading", done: "Uploaded", warning: "Uploaded with warnings", error: "Failed" };

function JobRow({ j, now }: { j: UploadJob; now: number }) {
  const pct = j.progress && j.progress.total > 0 ? Math.round((j.progress.done / j.progress.total) * 100) : null;
  return (
    <div className="px-3 py-2.5 border-b border-border/60 last:border-0 space-y-1.5">
      <div className="flex items-start gap-2">
        {ICON[j.status]}
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold truncate">{j.label}</p>
          <p className="text-[10px] text-muted-foreground truncate" title={j.fileName}>{j.fileName}</p>
        </div>
        <span className="text-[10px] text-muted-foreground whitespace-nowrap">{elapsed(j.startedAt, j.finishedAt ?? now)}</span>
        {j.status !== "running" && (
          <button type="button" onClick={() => dismissJob(j.id)} aria-label="Dismiss" className="p-0.5 rounded hover:bg-muted text-muted-foreground">
            <X className="w-3 h-3" />
          </button>
        )}
      </div>
      {j.status === "running" && (
        <div className="space-y-1">
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            {pct === null ? (
              <div className="h-full w-1/3 rounded-full bg-indigo-500 animate-pulse" />
            ) : (
              <div className="h-full rounded-full bg-indigo-500 transition-all" style={{ width: `${Math.max(4, pct)}%` }} />
            )}
          </div>
          <p className="text-[10px] text-muted-foreground">
            {pct === null ? "Working… you can open other pages, it keeps going." : `${pct}% · ${j.progress!.done} of ${j.progress!.total}${j.progress!.step ? ` · ${j.progress!.step}` : ""}`}
          </p>
        </div>
      )}
      {j.status !== "running" && (
        <p className={cn("text-[10px] leading-snug", j.status === "error" ? "text-red-600 dark:text-red-400" : j.status === "warning" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground")}>
          <b>{STATUS_TEXT[j.status]}.</b> {j.message}{" "}
          <Link href={j.href} className="font-bold text-indigo-600 dark:text-indigo-400 hover:underline">Details</Link>
        </p>
      )}
    </div>
  );
}

/** Bottom-right panel on every dashboard page: each upload's progress, then done / failed. */
export function UploadStatusTray() {
  const jobs = useUploadJobs();
  const [open, setOpen] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const running = jobs.filter((j) => j.status === "running").length;

  // tick the timers while something is running
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  // A reload or closed tab would cut a running upload off — ask first.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (!isAnyRunning()) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  if (!jobs.length) return null;
  const failed = jobs.filter((j) => j.status === "error").length;

  return (
    <div className="fixed bottom-4 right-4 z-50 w-[min(340px,calc(100vw-32px))] rounded-2xl border border-border bg-background shadow-2xl overflow-hidden">
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-2 px-3 py-2.5 bg-muted/50 text-left">
        {running ? <Loader2 className="w-4 h-4 animate-spin text-indigo-500" /> : failed ? <XCircle className="w-4 h-4 text-red-500" /> : <UploadCloud className="w-4 h-4 text-emerald-500" />}
        <span className="text-xs font-black flex-1">
          {running ? `Uploading ${running} file${running === 1 ? "" : "s"}…` : failed ? `${failed} upload${failed === 1 ? "" : "s"} failed` : "Uploads finished"}
        </span>
        {open ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronUp className="w-4 h-4 text-muted-foreground" />}
      </button>
      {open && (
        <>
          <div className="max-h-[50vh] overflow-y-auto">
            {jobs.map((j) => <JobRow key={j.id} j={j} now={now} />)}
          </div>
          {jobs.length > running && (
            <button type="button" onClick={dismissFinished} className="w-full px-3 py-1.5 text-[10px] font-bold text-muted-foreground hover:bg-muted border-t border-border">
              Clear finished
            </button>
          )}
        </>
      )}
    </div>
  );
}
