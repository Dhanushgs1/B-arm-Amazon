"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Loader2, Upload, X } from "lucide-react";
import { parseRatingUpload, uploadRatingSnapshot, type ParsedUpload } from "@/lib/productRatingMetrics";
import { cn } from "@/lib/utils";
import { useDashboard } from "@/lib/DashboardContext";

function todayIST() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

export function RatingUploadDialog({
  open,
  onClose,
  onUploaded,
  existingDates,
}: {
  open: boolean;
  onClose: () => void;
  onUploaded: () => void;
  existingDates: string[];
}) {
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ParsedUpload | null>(null);
  const [date, setDate] = useState(todayIST);
  const [busy, setBusy] = useState<"parse" | "upload" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ rows: number; date: string } | null>(null);
  const [mailNote, setMailNote] = useState<string | null>(null);
  const { keySlot } = useDashboard();

  if (!open) return null;

  const reset = () => {
    setFile(null);
    setParsed(null);
    setError(null);
    setDone(null);
    setMailNote(null);
  };
  const close = () => {
    reset();
    onClose();
  };

  const pick = async (f: File | undefined) => {
    if (!f) return;
    reset();
    setFile(f);
    setBusy("parse");
    try {
      setParsed(await parseRatingUpload(f));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read this file");
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    if (!parsed?.rows.length) return;
    setBusy("upload");
    setError(null);
    try {
      const res = await uploadRatingSnapshot(parsed.rows, date);
      setDone({ rows: res.rows, date: res.snapshot_date });
      onUploaded();
      // A Monday upload releases that week's "dropped below 4★" email (rating-drop-alert.ts — once per
      // snapshot, recipients from Settings); on other days the next Monday 9 AM run sends it.
      setMailNote("Checking listings that dropped below 4★…");
      fetch("/api/rating-drop-alert", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keySlot }) })
        .then(async (r) => {
          const a = await r.json().catch(() => ({}));
          setMailNote(!r.ok ? `Rating drop email failed: ${a.error || r.status}`
            : a.skipped ? `Rating drop email: ${a.skipped}.`
            : a.emailError ? `Rating drop email not sent: ${a.emailError}`
            : a.emailed ? `Rating drop email sent: ${a.drops} listing${a.drops === 1 ? "" : "s"} below 4★.`
            : "Rating drop email: no listing dropped below 4★ — no email needed.");
        })
        .catch(() => setMailNote("Rating drop email: could not reach the server."));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(null);
    }
  };

  const latest = existingDates[0];
  const replacing = existingDates.includes(date);
  const backDated = latest !== undefined && date < latest;
  const ok = parsed && parsed.missingColumns.length === 0 && parsed.rows.length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={close}>
      <div
        className="w-full max-w-lg rounded-2xl border border-border bg-background p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="rating-upload-title"
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 id="rating-upload-title" className="text-base font-bold text-foreground">
              Upload weekly ratings
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Excel or CSV with Platform, SKU ID, Product Name, Price, Rating, Review Count.
            </p>
          </div>
          <button onClick={close} className="rounded-md p-1 text-muted-foreground hover:bg-muted" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        {done ? (
          <div className="py-6 text-center">
            <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-500" />
            <p className="mt-3 text-sm font-semibold text-foreground">
              {done.rows.toLocaleString("en-IN")} SKUs saved for {done.date}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">The dashboard now compares this week with the previous upload.</p>
            {mailNote && <p className="mt-2 text-xs text-muted-foreground">{mailNote}</p>}
            <button onClick={close} className="mt-5 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700">
              Done
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <label className="block">
              <span className="text-xs font-semibold text-foreground">Snapshot date</span>
              <input
                type="date"
                value={date}
                max={todayIST()}
                onChange={(e) => setDate(e.target.value)}
                className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
              />
              <span className="mt-1 block text-[11px] text-muted-foreground">
                {replacing
                  ? "A snapshot already exists for this date — it will be replaced."
                  : backDated
                    ? `Older than the latest snapshot (${latest}) — saved to history only, current data stays.`
                    : "Becomes the latest snapshot. Previous weeks stay in history."}
              </span>
            </label>

            <label
              className={cn(
                "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border px-4 py-8 text-center hover:bg-muted/50",
                file && "border-indigo-400"
              )}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                pick(e.dataTransfer.files?.[0]);
              }}
            >
              <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
              {busy === "parse" ? (
                <Loader2 className="h-6 w-6 animate-spin text-indigo-500" />
              ) : (
                <FileSpreadsheet className="h-6 w-6 text-muted-foreground" />
              )}
              <span className="text-sm font-medium text-foreground">{file ? file.name : "Drop file here or click to choose"}</span>
              <span className="text-[11px] text-muted-foreground">.xlsx, .xls or .csv · first sheet is read</span>
            </label>

            {parsed && parsed.missingColumns.length > 0 && (
              <div className="flex gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400">
                <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                <span>Missing column(s): {parsed.missingColumns.join(", ")}. Check the header row.</span>
              </div>
            )}

            {ok && (
              <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">SKUs</span>
                  <span className="font-semibold text-foreground">{parsed.rows.length.toLocaleString("en-IN")}</span>
                </div>
                <div className="mt-1 flex justify-between">
                  <span className="text-muted-foreground">With a rating</span>
                  <span className="font-semibold text-foreground">{parsed.rated.toLocaleString("en-IN")}</span>
                </div>
                {parsed.skipped > 0 && (
                  <div className="mt-1 flex justify-between">
                    <span className="text-muted-foreground">Skipped (no platform / name)</span>
                    <span className="font-semibold text-foreground">{parsed.skipped}</span>
                  </div>
                )}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {Object.entries(parsed.platforms)
                    .sort((a, b) => b[1] - a[1])
                    .map(([p, n]) => (
                      <span key={p} className="rounded-full bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
                        {p} · {n}
                      </span>
                    ))}
                </div>
              </div>
            )}

            {error && (
              <div className="flex gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400">
                <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button onClick={close} className="rounded-lg border border-border px-4 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted">
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={!ok || busy !== null || !date}
                className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-40"
              >
                {busy === "upload" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                {replacing ? "Replace snapshot" : "Upload"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
