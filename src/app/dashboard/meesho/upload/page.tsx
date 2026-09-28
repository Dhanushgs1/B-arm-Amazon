"use client";

import { useState, useEffect, useCallback } from "react";
import { UploadCloud, CheckCircle2, XCircle, Loader2, FileSpreadsheet } from "lucide-react";
import {
  uploadMeeshoFile,
  fetchAllMeeshoReportDataInfo,
  fetchMeeshoReturnsDataInfo,
  type MeeshoFileKind,
  type MeeshoFilePartSummary,
  type MeeshoReportDataInfo,
} from "@/lib/meeshoReportUpload";
import { staleness } from "@/lib/dataFreshness";

// ONE card for every Meesho file: the raw workbook (Orders + Returns In Transit / Delivered / OFD
// sheets), the Ads export, or a single Orders / Returns CSV. uploadMeeshoFile splits the file sheet
// by sheet, by its headers, into barm_meesho_ads / barm_meesho_orders / barm_meesho_returns.

const KIND_LABEL: Record<MeeshoFileKind, string> = { ads: "Ads", orders: "Orders", returns: "Returns" };

interface CardState {
  status: "idle" | "parsing" | "done" | "error";
  fileName?: string;
  message?: string;
  parts?: MeeshoFilePartSummary[];
}

function DataOnFileCaption({ info, staleAfterDays, label }: { info: MeeshoReportDataInfo | undefined; staleAfterDays?: number; label: string }) {
  if (!info) return <p className="text-[10px] text-muted-foreground mt-1">{label}: checking what&apos;s on file…</p>;
  if (info.error) {
    return <p className="text-[10px] text-red-600 dark:text-red-400 mt-1">{label}: couldn&apos;t check — {info.error}</p>;
  }
  if (info.minDate) {
    const stale = staleAfterDays !== undefined ? staleness(info.maxDate, staleAfterDays) : null;
    return (
      <>
        <p className="text-[10px] text-muted-foreground mt-1">
          {label}: <b className="text-foreground">{info.minDate}</b> to <b className="text-foreground">{info.maxDate}</b> (
          {info.rowCount.toLocaleString("en-IN")} rows)
        </p>
        {stale && <p className="text-[10px] text-amber-600 dark:text-amber-400 font-semibold mt-0.5">&#9888; {stale.text}</p>}
      </>
    );
  }
  return <p className="text-[10px] text-muted-foreground mt-1">{label}: no data uploaded yet</p>;
}

function partLine(p: MeeshoFilePartSummary): string {
  const span = p.minDate ? ` · ${p.minDate}${p.maxDate !== p.minDate ? ` to ${p.maxDate}` : ""}` : "";
  const from = Object.entries(p.sheets)
    .map(([sheet, n]) => `${sheet} ${n.toLocaleString("en-IN")}`)
    .join(", ");
  return (
    `${KIND_LABEL[p.kind]}: ${p.savedRows.toLocaleString("en-IN")} saved` +
    (p.duplicateRows ? `, ${p.duplicateRows} repeated in the file (saved once)` : "") +
    (p.skippedRows ? `, ${p.skippedRows} skipped` : "") +
    ` (from ${from})${span}`
  );
}

export default function MeeshoUploadReportsPage() {
  const [state, setState] = useState<CardState>({ status: "idle" });
  const [dataInfo, setDataInfo] = useState<Partial<Record<MeeshoFileKind, MeeshoReportDataInfo>>>({});
  const [metaError, setMetaError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // State is only set in the promise callbacks — same shape as the Meesho Overview page's loader.
  const refreshMeta = useCallback(
    () =>
      Promise.all([fetchAllMeeshoReportDataInfo(), fetchMeeshoReturnsDataInfo()])
        .then(([info, returnsRaw]) => {
          const returns = returnsRaw.error
            ? { ...returnsRaw, error: `${returnsRaw.error} — run scripts/meesho_returns_table.sql in the Supabase SQL Editor` }
            : returnsRaw;
          setDataInfo({ ...info, returns });
          const errors = Object.values(info).map((i) => i?.error).filter(Boolean);
          setMetaError(
            errors.length === Object.keys(info).length
              ? `${errors[0]} — have you run scripts/meesho_tables.sql in the Supabase SQL Editor yet?`
              : null
          );
        })
        .catch((err) => setMetaError(err instanceof Error ? err.message : String(err))),
    []
  );

  useEffect(() => {
    refreshMeta();
  }, [refreshMeta]);

  const handleFile = async (file: File) => {
    setState({ status: "parsing", fileName: file.name });
    try {
      const res = await uploadMeeshoFile(file);
      setState({
        status: "done",
        fileName: file.name,
        parts: res.parts,
        message: res.ignoredSheets.length ? `Not Meesho data, left out: ${res.ignoredSheets.join(", ")}` : undefined,
      });
      refreshMeta();
    } catch (err) {
      setState({ status: "error", fileName: file.name, message: err instanceof Error ? err.message : "Upload failed" });
    }
  };

  return (
    <div className="space-y-8 pb-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight mb-0.5">Meesho — Upload Reports</h1>
        <p className="text-muted-foreground text-sm">
          Drop any Meesho file here — the raw workbook (Orders + Returns sheets) or the Ads export. Each sheet is saved
          to its own table and feeds the Ad Spend Report on the{" "}
          <a href="/dashboard/reports" className="underline hover:text-foreground">Download page</a>. Re-uploading a
          period you already uploaded overwrites those rows, so nothing gets duplicated.
        </p>
      </div>

      {metaError && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/5 px-4 py-3 text-xs text-red-600 dark:text-red-400">
          <b>Couldn&apos;t read what&apos;s already uploaded.</b> {metaError}
        </div>
      )}

      <div
        className={`glass rounded-2xl border p-5 shadow-sm transition-colors max-w-2xl ${dragOver ? "border-primary" : "border-border"}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) handleFile(f);
        }}
      >
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
            <FileSpreadsheet size={18} />
          </div>
          <div className="min-w-0">
            <h3 className="font-bold text-sm text-foreground">Meesho file</h3>
            <span className="text-[10px] text-muted-foreground uppercase font-black tracking-wider">CSV / XLSX</span>
          </div>
        </div>

        <p className="text-[11px] text-muted-foreground mb-3 leading-snug">
          Raw workbook: <b>Orders</b> sheet → Orders, <b>Returns In Transit / Delivered / OFD</b> sheets → Returns. Ads
          Manager export (Date, Campaign name, SKU ID, Spend, Views, Clicks, Orders by ad) → Ads. Sheets are recognised by
          their columns, so sheet order doesn&apos;t matter.
        </p>

        <label
          htmlFor="ms-upload-file"
          className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-border rounded-xl py-6 cursor-pointer hover:border-primary/50 transition-colors"
        >
          <UploadCloud size={22} className="text-muted-foreground" />
          <span className="text-xs text-muted-foreground px-2 text-center truncate max-w-full">
            {state.fileName || "Click or drop CSV/XLSX here"}
          </span>
        </label>
        {/* The Ad Spend Report needs Ads every day, so only Ads carries a staleness warning. */}
        <DataOnFileCaption label="Ads" info={dataInfo.ads} staleAfterDays={1} />
        <DataOnFileCaption label="Orders" info={dataInfo.orders} />
        <DataOnFileCaption label="Returns" info={dataInfo.returns} />
        <input
          id="ms-upload-file"
          type="file"
          accept=".csv,.xlsx,.xls"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
            e.target.value = "";
          }}
        />

        <div className="mt-3 text-xs min-h-[1.25rem]">
          {state.status === "parsing" && (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Parsing &amp; saving…
            </span>
          )}
          {state.status === "done" && (
            <div className="space-y-0.5">
              {state.parts?.map((p) => (
                <span key={p.kind} className="flex items-start gap-1.5 text-green-600 dark:text-green-400 font-semibold">
                  <CheckCircle2 size={14} className="mt-0.5 flex-shrink-0" /> {partLine(p)}
                </span>
              ))}
              {state.message && <p className="text-[11px] text-muted-foreground pl-5">{state.message}</p>}
            </div>
          )}
          {state.status === "error" && (
            <span className="flex items-start gap-1.5 text-red-600 dark:text-red-400 font-semibold">
              <XCircle size={14} className="mt-0.5 flex-shrink-0" /> {state.message}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
