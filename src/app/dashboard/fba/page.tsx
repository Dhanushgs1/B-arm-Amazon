"use client";

// FBA Forecast page: upload the 3 raw FBA reports (preview-then-confirm),
// then generate + download the computed FBA Analysis workbook. Every step
// on this page is anchored on the DASHBOARD'S SELECTED DATE (`endDate` from
// useDashboard()) — never the browser's/server's real "today". That single
// value flows through: upload validation windows (30-day sales window,
// stock snapshot anchor date, FBA & FBF Details month-sheet selection),
// the active_date stamped on barm_fba_recently_act rows, and the
// report_date used for job tracking + the generated workbook itself. See
// docs/superpowers/specs/2026-09-22-fba-forecast-refresh-design.md and
// docs/superpowers/plans/2026-09-22-fba-forecast-report.md for the full
// design/plan this implements.
import { useState, useEffect, useCallback } from "react";
import { useDashboard } from "@/lib/DashboardContext";
import { UploadCloud, CheckCircle2, XCircle, Loader2, FileSpreadsheet, AlertTriangle, ClipboardList, Download, RotateCcw } from "lucide-react";
import {
  parseAndCleanFbaSales30d,
  commitFbaSales30d,
  parseAndCleanFbaStockSnapshot,
  commitFbaStockSnapshot,
  parseAndCleanFbaFbfDetails,
  commitFbaFbfDetails,
  fetchFbaDailySalesInfo,
  fetchFbaStockSnapshotInfo,
  fetchFbaFbfDetailsInfo,
  fetchRecentUploadHistory,
  type FbaDataInfo,
  type FbaFbfDetailsInfo,
  type ParseCleanResult,
  type FbaDailySalesCleanedRow,
  type FbaStockSnapshotCleanedRow,
  type ParsedFbfDetails,
  type UploadHistoryRow,
} from "@/lib/fbaForecastUpload";
import { fetchFbaForecastReportBlob } from "@/lib/fbaForecastJobs";
import type { BatchedUploadProgress } from "@/lib/batchedUpload";
import { fetchSkuStockToSend, saveSkuStockToSend, type SkuStockToSendData, type SkuStockToSendRow } from "@/lib/fbaStockToSendStore";
import { parseStockToSendInput, changedStockToSend, staleSkuSummary, staleXMessage, lastUpdatedLabel, reviewNote } from "@/lib/fbaStockToSend";

interface PreviewState<T> {
  status: "idle" | "parsing" | "preview" | "committing" | "done" | "error";
  fileName?: string;
  parsed?: T;
  message?: string;
  error?: string;
}

function RejectionBreakdown({ reasons }: { reasons: Record<string, number> }) {
  const entries = Object.entries(reasons);
  if (entries.length === 0) return null;
  return (
    <ul className="text-[11px] text-muted-foreground space-y-0.5">
      {entries.map(([reason, count]) => (
        <li key={reason} className="flex items-center gap-1">
          <AlertTriangle size={11} className="text-amber-500" /> {reason.replace(/_/g, " ")}: {count}
        </li>
      ))}
    </ul>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/40 p-3">
      <span className="flex items-center gap-1.5 text-red-600 dark:text-red-400 font-semibold text-xs">
        <XCircle size={14} className="flex-shrink-0" /> {message}
      </span>
    </div>
  );
}

// ── 1. Amazon Sales Report (barm_fba_daily_sales) ───────────────────────

function FbaDailySalesCard({
  reportDate,
  onCommitted,
  dataInfo,
}: {
  reportDate: string;
  onCommitted: () => void;
  dataInfo: FbaDataInfo | undefined;
}) {
  const [state, setState] = useState<PreviewState<ParseCleanResult<FbaDailySalesCleanedRow>>>({ status: "idle" });
  const [progress, setProgress] = useState<BatchedUploadProgress | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const disabled = !reportDate;

  const handleFile = async (file: File) => {
    setState({ status: "parsing", fileName: file.name });
    try {
      const parsed = await parseAndCleanFbaSales30d(file, reportDate);
      setState({ status: "preview", fileName: file.name, parsed });
    } catch (err) {
      setState({ status: "error", fileName: file.name, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const confirm = async () => {
    if (state.status !== "preview" || !state.parsed || !state.fileName) return;
    setState((prev) => ({ ...prev, status: "committing" }));
    setProgress(null);
    try {
      const res = await commitFbaSales30d(state.fileName, state.parsed.cleanedRows, state.parsed.totalRows, state.parsed.rejectionReasons, setProgress);
      setState({ status: "done", fileName: state.fileName, message: `${res.rowsAccepted} rows saved (of ${state.parsed.totalRows}) — row count verified` });
      onCommitted();
    } catch (err) {
      setState({ status: "error", fileName: state.fileName, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="glass rounded-2xl border-2 border-primary/30 p-6 shadow-sm">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
          <FileSpreadsheet size={20} />
        </div>
        <div>
          <h3 className="font-bold text-sm text-foreground">1. Amazon Sales Report</h3>
          <span className="text-[10px] text-muted-foreground uppercase font-black tracking-wider">CSV / TXT · barm_fba_daily_sales</span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Reports → Fulfillment → All Orders. Cleaned to a genuine trailing 30-day window ending at the report date
        below — drops S-prefixed order IDs, rows dated the report date itself, Cancelled orders, and
        Merchant-fulfilled rows.
      </p>

      {(state.status === "idle" || state.status === "parsing" || state.status === "error") && (
        <>
          <label
            htmlFor="fba-daily-sales-upload"
            className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-xl py-8 transition-colors ${
              disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
            } ${dragOver ? "border-primary" : "border-border hover:border-primary/50"}`}
            onDragOver={(e) => { if (disabled) return; e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); if (disabled) return; const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); }}
          >
            <UploadCloud size={24} className="text-muted-foreground" />
            <span className="text-xs text-muted-foreground px-2 text-center truncate max-w-full">
              {disabled ? "Pick a date at the top of the dashboard first" : state.fileName || "Click or drop the All Orders .csv/.txt here"}
            </span>
          </label>
          <input
            id="fba-daily-sales-upload"
            type="file"
            accept=".csv,.txt"
            className="hidden"
            disabled={disabled}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }}
          />
        </>
      )}

      {dataInfo && (
        <p className="text-[10px] text-muted-foreground mt-1">
          {dataInfo.maxDate ? `On file: data through ${dataInfo.maxDate} (${dataInfo.rowCount} rows)` : "No data on file yet"}
        </p>
      )}

      <div className="mt-3 text-xs min-h-[1.25rem] space-y-2">
        {state.status === "parsing" && (
          <span className="flex items-center gap-1.5 text-muted-foreground"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading &amp; validating…</span>
        )}
        {state.status === "preview" && state.parsed && (
          <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1.5">
            <p className="font-semibold text-foreground">{state.parsed.cleanedRows.length} of {state.parsed.totalRows} rows will be kept</p>
            <RejectionBreakdown reasons={state.parsed.rejectionReasons} />
            <div className="flex gap-2 pt-1">
              <button onClick={confirm} className="px-3 py-1.5 bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-bold rounded-lg">Confirm Upload</button>
              <button onClick={() => setState({ status: "idle" })} className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-border hover:bg-muted/50">Cancel</button>
            </div>
          </div>
        )}
        {state.status === "committing" && (
          <div className="space-y-1.5">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {!progress
                ? "Saving to Supabase…"
                : progress.phase === "committing"
                  ? `Verifying & committing ${progress.totalRows.toLocaleString("en-US")} rows…`
                  : `Uploading ${progress.batchesDone}/${progress.totalBatches} — ${progress.rowsDone.toLocaleString("en-US")} / ${progress.totalRows.toLocaleString("en-US")} rows`}
            </span>
            {progress && progress.totalRows > 0 && (
              <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                <div className="h-full bg-primary transition-all" style={{ width: `${(progress.rowsDone / progress.totalRows) * 100}%` }} />
              </div>
            )}
          </div>
        )}
        {state.status === "done" && (
          <span className="flex items-center gap-1.5 text-green-600 dark:text-green-400 font-semibold"><CheckCircle2 size={14} /> {state.message}</span>
        )}
        {state.status === "error" && state.error && <ErrorBanner message={state.error} />}
      </div>
    </div>
  );
}

// ── 2. FBA Stock Report (barm_fba_stock_snapshot) ───────────────────────

function FbaStockSnapshotCard({
  reportDate,
  onCommitted,
  dataInfo,
}: {
  reportDate: string;
  onCommitted: () => void;
  dataInfo: FbaDataInfo | undefined;
}) {
  const [state, setState] = useState<PreviewState<ParseCleanResult<FbaStockSnapshotCleanedRow>>>({ status: "idle" });
  const [dragOver, setDragOver] = useState(false);
  const disabled = !reportDate;

  const handleFile = async (file: File) => {
    setState({ status: "parsing", fileName: file.name });
    try {
      const parsed = await parseAndCleanFbaStockSnapshot(file, reportDate);
      setState({ status: "preview", fileName: file.name, parsed });
    } catch (err) {
      setState({ status: "error", fileName: file.name, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const confirm = async () => {
    if (state.status !== "preview" || !state.parsed || !state.fileName) return;
    setState((prev) => ({ ...prev, status: "committing" }));
    try {
      const res = await commitFbaStockSnapshot(state.fileName, state.parsed.cleanedRows, state.parsed.totalRows, state.parsed.rejectionReasons);
      setState({ status: "done", fileName: state.fileName, message: `${res.rowsAccepted} rows saved (of ${state.parsed.totalRows})` });
      onCommitted();
    } catch (err) {
      setState({ status: "error", fileName: state.fileName, error: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="glass rounded-2xl border-2 border-primary/30 p-6 shadow-sm">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
          <FileSpreadsheet size={20} />
        </div>
        <div>
          <h3 className="font-bold text-sm text-foreground">2. FBA Stock Report</h3>
          <span className="text-[10px] text-muted-foreground uppercase font-black tracking-wider">CSV · barm_fba_stock_snapshot</span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Reports → Fulfillment → Custom Report Builder: Date, FNSKU, Fulfillment Center, ASIN, MSKU, Disposition,
        Ending Warehouse Balance. Keeps only the latest date on file that is on or before the report date below
        (never a later date the file happens to include), drops Fulfillment Center = VSNC, and keeps only
        Disposition = SELLABLE.
      </p>

      {(state.status === "idle" || state.status === "parsing" || state.status === "error") && (
        <>
          <label
            htmlFor="fba-stock-snapshot-upload"
            className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-xl py-8 transition-colors ${
              disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
            } ${dragOver ? "border-primary" : "border-border hover:border-primary/50"}`}
            onDragOver={(e) => { if (disabled) return; e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); if (disabled) return; const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); }}
          >
            <UploadCloud size={24} className="text-muted-foreground" />
            <span className="text-xs text-muted-foreground px-2 text-center truncate max-w-full">
              {disabled ? "Pick a date at the top of the dashboard first" : state.fileName || "Click or drop the FBA stock .csv here"}
            </span>
          </label>
          <input
            id="fba-stock-snapshot-upload"
            type="file"
            accept=".csv,.txt"
            className="hidden"
            disabled={disabled}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }}
          />
        </>
      )}

      {dataInfo && (
        <p className="text-[10px] text-muted-foreground mt-1">
          {dataInfo.maxDate ? `On file: anchor date ${dataInfo.maxDate} (${dataInfo.rowCount} rows)` : "No data on file yet"}
        </p>
      )}

      <div className="mt-3 text-xs min-h-[1.25rem] space-y-2">
        {state.status === "parsing" && (
          <span className="flex items-center gap-1.5 text-muted-foreground"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading &amp; validating…</span>
        )}
        {state.status === "preview" && state.parsed && (
          <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1.5">
            <p className="font-semibold text-foreground">{state.parsed.cleanedRows.length} of {state.parsed.totalRows} rows will be kept</p>
            <RejectionBreakdown reasons={state.parsed.rejectionReasons} />
            <div className="flex gap-2 pt-1">
              <button onClick={confirm} className="px-3 py-1.5 bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-bold rounded-lg">Confirm Upload</button>
              <button onClick={() => setState({ status: "idle" })} className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-border hover:bg-muted/50">Cancel</button>
            </div>
          </div>
        )}
        {state.status === "committing" && (
          <span className="flex items-center gap-1.5 text-muted-foreground"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving to Supabase…</span>
        )}
        {state.status === "done" && (
          <span className="flex items-center gap-1.5 text-green-600 dark:text-green-400 font-semibold"><CheckCircle2 size={14} /> {state.message}</span>
        )}
        {state.status === "error" && state.error && <ErrorBanner message={state.error} />}
      </div>
    </div>
  );
}

// ── 3. FBA & FBF Details workbook (barm_fba_booked/intransit/recently_act) ─

function FbaFbfDetailsCard({
  reportDate,
  onCommitted,
  dataInfo,
}: {
  reportDate: string;
  onCommitted: () => void;
  dataInfo: FbaFbfDetailsInfo | undefined;
}) {
  const [state, setState] = useState<PreviewState<ParsedFbfDetails>>({ status: "idle" });
  const [dragOver, setDragOver] = useState(false);
  const disabled = !reportDate;

  const handleFile = async (file: File) => {
    setState({ status: "parsing", fileName: file.name });
    try {
      const parsed = await parseAndCleanFbaFbfDetails(file, reportDate);
      setState({ status: "preview", fileName: file.name, parsed });
    } catch (err) {
      setState({ status: "error", fileName: file.name, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const confirm = async () => {
    if (state.status !== "preview" || !state.parsed || !state.fileName) return;
    setState((prev) => ({ ...prev, status: "committing" }));
    try {
      const res = await commitFbaFbfDetails(state.fileName, state.parsed);
      setState({
        status: "done",
        fileName: state.fileName,
        message: `${res.rowsAccepted} rows saved across months: ${state.parsed.monthsFound.join(", ")}`,
      });
      onCommitted();
    } catch (err) {
      setState({ status: "error", fileName: state.fileName, error: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="glass rounded-2xl border-2 border-primary/30 p-6 shadow-sm">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
          <FileSpreadsheet size={20} />
        </div>
        <div>
          <h3 className="font-bold text-sm text-foreground">3. FBA &amp; FBF Details</h3>
          <span className="text-[10px] text-muted-foreground uppercase font-black tracking-wider">XLSX · booked / intransit / recently_act</span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Upload the whole multi-month &quot;FBA &amp; FBF Details-Updated&quot; workbook as-is — the 3 sheets nearest
        the report date below (current month + previous 2) are auto-detected, and each row is routed to Booked /
        Intransit / Active by its first STATUS column, de-duped across the 3 sheets by (SKU, FC, quantity, booked
        date, pickup date).
      </p>

      {(state.status === "idle" || state.status === "parsing" || state.status === "error") && (
        <>
          <label
            htmlFor="fba-fbf-details-upload"
            className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-xl py-8 transition-colors ${
              disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
            } ${dragOver ? "border-primary" : "border-border hover:border-primary/50"}`}
            onDragOver={(e) => { if (disabled) return; e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); if (disabled) return; const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); }}
          >
            <UploadCloud size={24} className="text-muted-foreground" />
            <span className="text-xs text-muted-foreground px-2 text-center truncate max-w-full">
              {disabled ? "Pick a date at the top of the dashboard first" : state.fileName || "Click or drop the FBA & FBF Details-Updated .xlsx here"}
            </span>
          </label>
          <input
            id="fba-fbf-details-upload"
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            disabled={disabled}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }}
          />
        </>
      )}

      {dataInfo && (
        <p className="text-[10px] text-muted-foreground mt-1">
          {dataInfo.monthsOnFile.length ? `On file: ${dataInfo.monthsOnFile.join(", ")} (${dataInfo.rowCount} rows)` : "No data on file yet"}
        </p>
      )}

      <div className="mt-3 text-xs min-h-[1.25rem] space-y-2">
        {state.status === "parsing" && (
          <span className="flex items-center gap-1.5 text-muted-foreground"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading sheets &amp; validating…</span>
        )}
        {state.status === "preview" && state.parsed && (
          <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1.5">
            <p className="font-semibold text-foreground">Month sheets detected: {state.parsed.monthsFound.join(", ") || "none"}</p>
            <p className="text-foreground">
              Booked: {state.parsed.booked.length} · Intransit: {state.parsed.intransit.length} · Active: {state.parsed.recentlyAct.length}
              {" "}(of {state.parsed.totalRows} rows across those sheets)
            </p>
            <RejectionBreakdown reasons={state.parsed.rejectionReasons} />
            <div className="flex gap-2 pt-1">
              <button onClick={confirm} className="px-3 py-1.5 bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-bold rounded-lg">Confirm Upload</button>
              <button onClick={() => setState({ status: "idle" })} className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-border hover:bg-muted/50">Cancel</button>
            </div>
          </div>
        )}
        {state.status === "committing" && (
          <span className="flex items-center gap-1.5 text-muted-foreground"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving to Supabase…</span>
        )}
        {state.status === "done" && (
          <span className="flex items-center gap-1.5 text-green-600 dark:text-green-400 font-semibold"><CheckCircle2 size={14} /> {state.message}</span>
        )}
        {state.status === "error" && state.error && <ErrorBanner message={state.error} />}
      </div>
    </div>
  );
}

// ── 5. Generate & Download ──────────────────────────────────────────────

// ── 4. X values: stock ready to send, one per SKU ───────────────────────

function StaleXWarning({ rows }: { rows: SkuStockToSendRow[] }) {
  const warning = staleXMessage(staleSkuSummary(rows));
  if (!warning) return null;
  return (
    <p className="text-[11px] text-amber-600 dark:text-amber-400 font-semibold mb-3 flex items-center gap-1">
      <AlertTriangle size={12} />
      {rows.length === 0 ? warning : `${warning} Update them in section 4 if your stock has changed.`}
    </p>
  );
}

function FbaStockToSendPanel({ data, onSaved }: { data: SkuStockToSendData | undefined; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [edits, setEdits] = useState<Map<string, string>>(new Map());
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const rows = data?.rows || [];
  const saved = new Map(rows.map((r) => [r.sku, r.stockToSend]));
  const textFor = (sku: string) => edits.get(sku) ?? (saved.get(sku) === null || saved.get(sku) === undefined ? "" : String(saved.get(sku)));
  const invalid = [...edits.entries()].filter(([, t]) => !parseStockToSendInput(t).ok).map(([sku]) => sku);
  const parsedEdits = new Map<string, number | null>();
  for (const [sku, t] of edits) {
    const p = parseStockToSendInput(t);
    if (p.ok) parsedEdits.set(sku, p.value);
  }
  const changes = changedStockToSend(saved, parsedEdits);
  const q = search.trim().toLowerCase();
  const visible = q ? rows.filter((r) => r.sku.toLowerCase().includes(q) || r.productName.toLowerCase().includes(q)) : rows;

  const save = async () => {
    if (invalid.length || changes.length === 0) return;
    setSaving(true);
    setMsg(null);
    try {
      const n = await saveSkuStockToSend(changes);
      setEdits(new Map());
      setMsg({ ok: true, text: `Saved ${n} SKU${n === 1 ? "" : "s"}.` });
      onSaved();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="glass rounded-2xl border border-border p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-bold text-sm text-foreground">4. X values — stock ready to send</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Your manual sheet&apos;s column X, one number per SKU, applied to all 14 of its zones. Blank = 0 to send.
            Only needed when your ready-to-send stock changes. {data ? `${rows.length} SKUs · last updated ${lastUpdatedLabel(data.lastSavedAt, data.lastSavedSource)}` : "Loading…"}
          </p>
        </div>
        <button onClick={() => setOpen((o) => !o)} className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-border hover:bg-muted/50">
          {open ? "Hide X values" : "Edit X values"}
        </button>
      </div>

      {open && (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search SKU or product"
              className="px-3 py-1.5 text-xs rounded-lg border border-border bg-transparent w-64 max-w-full"
            />
            <button
              onClick={save}
              disabled={saving || invalid.length > 0 || changes.length === 0}
              className="px-3 py-1.5 bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-bold rounded-lg disabled:opacity-50"
            >
              {saving ? "Saving…" : `Save${changes.length ? ` ${changes.length} change${changes.length === 1 ? "" : "s"}` : ""}`}
            </button>
            {edits.size > 0 && (
              <button onClick={() => setEdits(new Map())} className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-border hover:bg-muted/50">Discard</button>
            )}
            {invalid.length > 0 && <span className="text-[11px] text-red-600 dark:text-red-400 font-semibold">Fix {invalid.length} invalid value{invalid.length === 1 ? "" : "s"} (whole numbers only)</span>}
            {msg && <span className={`text-[11px] font-semibold ${msg.ok ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>{msg.text}</span>}
          </div>
          <div className="max-h-[28rem] overflow-auto rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted text-muted-foreground">
                <tr>
                  <th className="text-left px-3 py-2 font-semibold">SKU</th>
                  <th className="text-left px-3 py-2 font-semibold">Product</th>
                  <th className="text-left px-3 py-2 font-semibold w-32">X (stock to send)</th>
                  <th className="text-left px-3 py-2 font-semibold">Last updated</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const text = textFor(r.sku);
                  const bad = edits.has(r.sku) && !parseStockToSendInput(text).ok;
                  const note = reviewNote(r);
                  return (
                    <tr key={r.sku} className="border-t border-border">
                      <td className="px-3 py-1.5 font-semibold text-foreground whitespace-nowrap align-top">
                        {r.sku}
                        {note && (
                          <span className="mt-0.5 flex items-start gap-1 whitespace-normal text-[10px] font-semibold text-amber-600 dark:text-amber-400 max-w-xs">
                            <AlertTriangle size={11} className="flex-shrink-0 mt-px" /> {note}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground">{r.productName}</td>
                      <td className="px-3 py-1">
                        <input
                          value={text}
                          inputMode="numeric"
                          onChange={(e) => setEdits((m) => new Map(m).set(r.sku, e.target.value))}
                          className={`w-28 px-2 py-1 rounded border bg-transparent ${bad ? "border-red-500" : edits.has(r.sku) ? "border-primary" : "border-border"}`}
                          aria-label={`X for ${r.sku}`}
                        />
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground whitespace-nowrap">{lastUpdatedLabel(r.updatedAt, r.source)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function FbaGenerateDownloadSection({ reportDate, readyToGenerate, xRows }: { reportDate: string; readyToGenerate: boolean; xRows: SkuStockToSendRow[] | undefined }) {
  const [jobStatus, setJobStatus] = useState<string | null>(null);
  const [jobErrorMessage, setJobErrorMessage] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [completedAt, setCompletedAt] = useState<string | null>(null);

  const pollStatus = useCallback(async (date: string) => {
    const qs = new URLSearchParams({ reportDate: date });
    const r = await fetch(`/api/fba-forecast-report-status?${qs.toString()}`);
    const j = await r.json();
    return j.job as { status: string; error_message: string | null } | null;
  }, []);

  // Re-sync with the server whenever the selected report date changes — a
  // fresh date has its own job row (or none yet), never inherits the
  // previous date's status.
  useEffect(() => {
    setJobStatus(null);
    setJobErrorMessage(null);
    setMsg(null);
    setCompletedAt(null);
    if (!reportDate) return;
    let cancelled = false;
    pollStatus(reportDate)
      .then((job) => { if (!cancelled) { setJobStatus(job?.status ?? null); setJobErrorMessage(job?.error_message ?? null); } })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [reportDate, pollStatus]);

  const handleGenerate = async (force = false) => {
    if (!reportDate) return;
    // Never silently use stale ready-to-send stock: ask first.
    if (xRows !== undefined) {
      const warning = staleXMessage(staleSkuSummary(xRows));
      if (warning && !window.confirm(`${warning} Generate with these values anyway?`)) return;
    }
    setGenerating(true);
    setMsg(null);
    try {
      const r = await fetch("/api/generate-fba-forecast-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportDate, force }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Failed to start report generation");
      setJobStatus(j.status);
      setMsg(j.status === "completed" ? "Report already generated for this date." : "Generating…");

      const poll = async () => {
        try {
          const job = await pollStatus(reportDate);
          if (!job) { setMsg("Lost track of the report's status — try Generate again."); setGenerating(false); return; }
          setJobStatus(job.status);
          setJobErrorMessage(job.error_message);
          if (job.status === "completed") { setMsg("Completed."); setCompletedAt(new Date().toLocaleString()); setGenerating(false); return; }
          if (job.status === "failed") { setMsg(`Failed: ${job.error_message || "unknown error"} — Retry`); setGenerating(false); return; }
          setTimeout(poll, 5000);
        } catch (err) {
          setMsg("Failed to check report status: " + (err instanceof Error ? err.message : String(err)));
          setGenerating(false);
        }
      };
      setTimeout(poll, 5000);
    } catch (err) {
      setMsg("Failed: " + (err instanceof Error ? err.message : String(err)));
      setGenerating(false);
    }
  };

  const handleDownload = async () => {
    if (!reportDate) return;
    setDownloading(true);
    setMsg(null);
    try {
      const blob = await fetchFbaForecastReportBlob(reportDate);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.setAttribute("href", url);
      link.setAttribute("download", `FBA_Forecast_Report_${reportDate}.xlsx`);
      link.style.visibility = "hidden";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      setMsg("Download failed: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="glass rounded-2xl border border-border p-6 shadow-sm">
      <h3 className="font-bold text-sm mb-1">5. Generate &amp; Download</h3>
      <p className="text-xs text-muted-foreground mb-4">
        Runs the full forecast (zone assignment, 120-day forecast, stock needed, days-to-stockout) server-side in a
        Supabase Edge Function, for report date{" "}
        <span className="font-semibold text-foreground">{reportDate || "—"}</span>, then makes the workbook
        available to download.
      </p>
      {!readyToGenerate && reportDate && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400 font-semibold mb-3 flex items-center gap-1">
          <AlertTriangle size={12} /> Confirm all 3 uploads above at least once before generating.
        </p>
      )}
      {xRows !== undefined && <StaleXWarning rows={xRows} />}
      <div className="flex flex-wrap gap-2 items-center">
        <button
          onClick={() => handleGenerate(jobStatus === "failed" || jobStatus === "completed")}
          disabled={generating || !reportDate || !readyToGenerate}
          className="px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-bold rounded-lg transition-colors flex items-center gap-2 shadow-md disabled:opacity-50"
        >
          {generating ? (
            <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Generating…</>
          ) : (
            <><RotateCcw size={14} /> {jobStatus === "completed" ? "Regenerate FBA Forecast" : jobStatus === "failed" ? "Retry" : "Generate FBA Forecast"}</>
          )}
        </button>
        <button
          onClick={handleDownload}
          disabled={downloading || jobStatus !== "completed"}
          className="px-4 py-2 bg-white dark:bg-white/10 border border-border hover:border-primary/50 text-foreground text-xs font-bold rounded-lg transition-colors flex items-center gap-2 shadow-sm disabled:opacity-50"
        >
          {downloading ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Downloading…</> : <><Download size={14} /> Download</>}
        </button>
        {jobStatus && (
          <span
            className={`text-[10px] font-black uppercase tracking-wide rounded-full px-2 py-1 border ${
              jobStatus === "completed"
                ? "text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800"
                : jobStatus === "failed"
                  ? "text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-800"
                  : "text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800"
            }`}
          >
            {jobStatus}
          </span>
        )}
      </div>
      {msg && <p className="text-xs mt-3 font-semibold">{msg}</p>}
      {jobStatus === "failed" && jobErrorMessage && <p className="text-xs mt-1 text-red-600 dark:text-red-400">{jobErrorMessage}</p>}
      {completedAt && <p className="text-[10px] text-muted-foreground mt-1">Last completed (this session): {completedAt}</p>}
    </div>
  );
}

// ── Recent uploads audit panel ───────────────────────────────────────────

function FbaRecentUploadsPanel({ refreshKey }: { refreshKey: number }) {
  const [rows, setRows] = useState<UploadHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchRecentUploadHistory(10)
      .then((r) => { if (!cancelled) setRows(r); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  return (
    <div className="glass rounded-2xl border border-border p-6 shadow-sm">
      <h3 className="font-bold text-sm text-foreground mb-1 flex items-center gap-2"><ClipboardList size={16} /> Recent FBA Uploads</h3>
      <p className="text-xs text-muted-foreground mb-4">Last 10 upload attempts across all 5 FBA tables — the audit trail behind each upload&apos;s row counts.</p>
      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No uploads yet.</p>
      ) : (
        <div className="rounded-xl border border-border overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="p-2">File</th>
                <th className="p-2">Table</th>
                <th className="p-2">Uploaded</th>
                <th className="p-2">Accepted</th>
                <th className="p-2">Rejected</th>
                <th className="p-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.upload_id} className="border-t border-border">
                  <td className="p-2 truncate max-w-[160px]" title={r.file_name}>{r.file_name}</td>
                  <td className="p-2">{r.target_table}</td>
                  <td className="p-2">{new Date(r.uploaded_at).toLocaleString()}</td>
                  <td className="p-2">{r.rows_accepted}</td>
                  <td className="p-2">{r.rows_rejected}</td>
                  <td className="p-2">
                    <span
                      className={
                        r.status === "success"
                          ? "text-green-600 dark:text-green-400 font-semibold"
                          : r.status === "failed"
                            ? "text-red-600 dark:text-red-400 font-semibold"
                            : "text-amber-600 dark:text-amber-400 font-semibold"
                      }
                    >
                      {r.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function FbaPage() {
  const { endDate } = useDashboard();

  const [dailySalesInfo, setDailySalesInfo] = useState<FbaDataInfo | undefined>(undefined);
  const [stockInfo, setStockInfo] = useState<FbaDataInfo | undefined>(undefined);
  const [fbfInfo, setFbfInfo] = useState<FbaFbfDetailsInfo | undefined>(undefined);
  const [xData, setXData] = useState<SkuStockToSendData | undefined>(undefined);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);

  const refreshDailySalesInfo = useCallback(async () => setDailySalesInfo(await fetchFbaDailySalesInfo()), []);
  const refreshStockInfo = useCallback(async () => setStockInfo(await fetchFbaStockSnapshotInfo()), []);
  const refreshFbfInfo = useCallback(async () => setFbfInfo(await fetchFbaFbfDetailsInfo()), []);
  const refreshXData = useCallback(async () => {
    try { setXData(await fetchSkuStockToSend()); } catch { setXData({ rows: [], lastSavedAt: null, lastSavedSource: null }); }
  }, []);

  useEffect(() => {
    refreshDailySalesInfo();
    refreshStockInfo();
    refreshFbfInfo();
    refreshXData();
  }, [refreshDailySalesInfo, refreshStockInfo, refreshFbfInfo, refreshXData]);

  const bumpHistory = () => setHistoryRefreshKey((k) => k + 1);

  const readyToGenerate = !!(
    dailySalesInfo && dailySalesInfo.rowCount > 0 &&
    stockInfo && stockInfo.rowCount > 0 &&
    fbfInfo && fbfInfo.rowCount > 0
  );

  return (
    <div className="space-y-6 pb-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight mb-0.5">FBA Forecast</h1>
        <p className="text-muted-foreground text-sm">
          Upload the 3 raw FBA reports, then generate a fresh FBA Analysis workbook (zone assignment, 120-day
          forecast, stock needed, days-to-stockout) — computed server-side, never in this browser tab.
        </p>
        <div
          className={`mt-3 inline-flex items-center gap-2 rounded-xl px-3 py-1.5 text-xs font-bold ${
            endDate
              ? "bg-primary/10 text-primary border border-primary/30"
              : "bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-800"
          }`}
        >
          {endDate ? <>Processing for report date: {endDate}</> : <><AlertTriangle size={14} /> Pick a date at the top of the dashboard to begin</>}
        </div>
      </div>

      <FbaDailySalesCard reportDate={endDate} onCommitted={() => { refreshDailySalesInfo(); bumpHistory(); }} dataInfo={dailySalesInfo} />
      <FbaStockSnapshotCard reportDate={endDate} onCommitted={() => { refreshStockInfo(); bumpHistory(); }} dataInfo={stockInfo} />
      <FbaFbfDetailsCard reportDate={endDate} onCommitted={() => { refreshFbfInfo(); bumpHistory(); }} dataInfo={fbfInfo} />

      <FbaStockToSendPanel data={xData} onSaved={refreshXData} />

      <FbaGenerateDownloadSection reportDate={endDate} readyToGenerate={readyToGenerate} xRows={xData?.rows} />

      <FbaRecentUploadsPanel refreshKey={historyRefreshKey} />
    </div>
  );
}
