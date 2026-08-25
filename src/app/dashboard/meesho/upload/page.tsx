"use client";

import { useState, useEffect, useCallback } from "react";
import { UploadCloud, CheckCircle2, XCircle, Loader2, FileSpreadsheet } from "lucide-react";
import {
  uploadMeeshoReportFile,
  fetchAllMeeshoReportDataInfo,
  MS_REPORT_LABEL,
  MS_REPORT_HINT,
  MS_REPORT_ACCEPT,
  type MeeshoUploadReportType,
  type MeeshoReportDataInfo,
} from "@/lib/meeshoReportUpload";
import { staleness } from "@/lib/dataFreshness";

// Only "ads" feeds the Ad Spend Report's Meesho spend total — the combined
// "Last 7 days" one-file upload does NOT (see combinedAdSpendUpload.ts).
const AD_SPEND_REPORT_TYPE: MeeshoUploadReportType = "ads";

// Mirrors /dashboard/flipkart/upload card-for-card, at Meesho's smaller scale —
// just the two reports the Ad Spend Report needs (ads spend, orders). There's
// no full Meesho analytics section (Campaigns/Ad Groups/etc. like Flipkart
// has) — this page only exists to get data into the Ad Spend Report on the
// Download page.
const REPORT_TYPES: MeeshoUploadReportType[] = ["ads", "orders"];

interface CardState {
  status: "idle" | "parsing" | "done" | "error";
  fileName?: string;
  message?: string;
}

function DataOnFileCaption({ info, staleAfterDays }: { info: MeeshoReportDataInfo | undefined; staleAfterDays?: number }) {
  if (!info) return <p className="text-[10px] text-muted-foreground mt-1">Checking what&apos;s on file…</p>;
  if (info.error) {
    return <p className="text-[10px] text-red-600 dark:text-red-400 mt-1">Couldn&apos;t check — {info.error}</p>;
  }
  if (info.minDate) {
    const stale = staleAfterDays !== undefined ? staleness(info.maxDate, staleAfterDays) : null;
    return (
      <>
        <p className="text-[10px] text-muted-foreground mt-1">
          Data: <b className="text-foreground">{info.minDate}</b> to <b className="text-foreground">{info.maxDate}</b> (
          {info.rowCount.toLocaleString("en-IN")} rows)
        </p>
        {stale && <p className="text-[10px] text-amber-600 dark:text-amber-400 font-semibold mt-0.5">&#9888; {stale.text}</p>}
      </>
    );
  }
  return <p className="text-[10px] text-muted-foreground mt-1">No data uploaded yet</p>;
}

function UploadCard({
  type,
  state,
  info,
  onFile,
}: {
  type: MeeshoUploadReportType;
  state: CardState;
  info: MeeshoReportDataInfo | undefined;
  onFile: (file: File) => void;
}) {
  const inputId = `ms-upload-${type}`;
  const [dragOver, setDragOver] = useState(false);
  const accept = MS_REPORT_ACCEPT[type];

  return (
    <div
      className={`glass rounded-2xl border p-5 shadow-sm transition-colors ${dragOver ? "border-primary" : "border-border"}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
    >
      <div className="flex items-center gap-3 mb-3">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
          <FileSpreadsheet size={18} />
        </div>
        <div className="min-w-0">
          <h3 className="font-bold text-sm text-foreground">{MS_REPORT_LABEL[type]}</h3>
          <span className="text-[10px] text-muted-foreground uppercase font-black tracking-wider">CSV / XLSX</span>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground mb-3 leading-snug">{MS_REPORT_HINT[type]}</p>

      <label
        htmlFor={inputId}
        className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-border rounded-xl py-6 cursor-pointer hover:border-primary/50 transition-colors"
      >
        <UploadCloud size={22} className="text-muted-foreground" />
        <span className="text-xs text-muted-foreground px-2 text-center truncate max-w-full">
          {state.fileName || "Click or drop CSV/XLSX here"}
        </span>
      </label>
      <DataOnFileCaption info={info} staleAfterDays={type === AD_SPEND_REPORT_TYPE ? 1 : undefined} />
      <input
        id={inputId}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
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
          <span className="flex items-start gap-1.5 text-green-600 dark:text-green-400 font-semibold">
            <CheckCircle2 size={14} className="mt-0.5 flex-shrink-0" /> {state.message}
          </span>
        )}
        {state.status === "error" && (
          <span className="flex items-start gap-1.5 text-red-600 dark:text-red-400 font-semibold">
            <XCircle size={14} className="mt-0.5 flex-shrink-0" /> {state.message}
          </span>
        )}
      </div>
    </div>
  );
}

export default function MeeshoUploadReportsPage() {
  const [cardState, setCardState] = useState<Record<MeeshoUploadReportType, CardState>>(
    Object.fromEntries(REPORT_TYPES.map((t) => [t, { status: "idle" }])) as Record<MeeshoUploadReportType, CardState>
  );
  const [dataInfo, setDataInfo] = useState<Partial<Record<MeeshoUploadReportType, MeeshoReportDataInfo>>>({});
  const [metaError, setMetaError] = useState<string | null>(null);

  const refreshMeta = useCallback(async () => {
    try {
      const info = await fetchAllMeeshoReportDataInfo();
      setDataInfo(info);
      const errors = Object.values(info).map((i) => i?.error).filter(Boolean);
      setMetaError(
        errors.length === Object.keys(info).length
          ? `${errors[0]} — have you run scripts/meesho_tables.sql in the Supabase SQL Editor yet?`
          : null
      );
    } catch (err) {
      setMetaError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    refreshMeta();
  }, [refreshMeta]);

  const handleFile = async (type: MeeshoUploadReportType, file: File) => {
    setCardState((prev) => ({ ...prev, [type]: { status: "parsing", fileName: file.name } }));
    try {
      const res = await uploadMeeshoReportFile(type, file);
      const span = res.minDate ? ` · ${res.minDate}${res.maxDate !== res.minDate ? ` to ${res.maxDate}` : ""}` : "";
      setCardState((prev) => ({
        ...prev,
        [type]: {
          status: "done",
          fileName: file.name,
          message:
            `${res.savedRows.toLocaleString("en-IN")} rows saved` +
            (res.skippedRows ? `, ${res.skippedRows} skipped` : "") +
            ` (of ${res.totalRows.toLocaleString("en-IN")})${span}`,
        },
      }));
      refreshMeta();
    } catch (err) {
      setCardState((prev) => ({
        ...prev,
        [type]: { status: "error", fileName: file.name, message: err instanceof Error ? err.message : "Upload failed" },
      }));
    }
  };

  return (
    <div className="space-y-8 pb-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight mb-0.5">Meesho — Upload Reports</h1>
        <p className="text-muted-foreground text-sm">
          Upload your Meesho Ads and Orders exports here to bring Meesho into the Ad Spend Report on the{" "}
          <a href="/dashboard/reports" className="underline hover:text-foreground">Download page</a>. Re-uploading a
          period you already uploaded overwrites those rows, so nothing gets duplicated.
        </p>
      </div>

      {metaError && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/5 px-4 py-3 text-xs text-red-600 dark:text-red-400">
          <b>Couldn&apos;t read what&apos;s already uploaded.</b> {metaError}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {REPORT_TYPES.map((type) => (
          <UploadCard key={type} type={type} state={cardState[type]} info={dataInfo[type]} onFile={(f) => handleFile(type, f)} />
        ))}
      </div>
    </div>
  );
}
