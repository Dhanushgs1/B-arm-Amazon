"use client";

import { useState, useEffect, useCallback } from "react";
import { UploadCloud, CheckCircle2, XCircle, Loader2, FileSpreadsheet } from "lucide-react";
import {
  uploadFlipkartReportFile,
  fetchAllFlipkartReportDataInfo,
  FK_REPORT_LABEL,
  FK_REPORT_HINT,
  FK_REPORT_ACCEPT,
  type FlipkartUploadReportType,
  type FlipkartReportDataInfo,
} from "@/lib/flipkartReportUpload";
import { staleness } from "@/lib/dataFreshness";
import { fetchAllMisFlipkartReportDataInfo } from "@/lib/misAdapters";

// Only fsn_report feeds the Ad Spend Report's Flipkart spend total — the
// combined "Last 7 days" one-file upload does NOT (see combinedAdSpendUpload.ts),
// so this is the one card that silently going stale actually breaks that report.
const AD_SPEND_REPORT_TYPE: FlipkartUploadReportType = "fsn_report";

// Mirrors /dashboard/upload (Amazon) card-for-card. The grouping differs only
// because Flipkart's four exports split into "what the report is built from"
// and "operational detail" rather than Amazon's required/optional split.
//
// Earn More's upload card is intentionally hidden (its parser, table, and the
// revenue/price-fallback calculations in flipkartHistoricalReportExport.ts are
// untouched) — this only removes the path to upload new files through this UI.
const CORE_REPORT_TYPES: FlipkartUploadReportType[] = ["fsn_report"];
const DETAIL_REPORT_TYPES: FlipkartUploadReportType[] = ["order_report", "returns"];
// These 2 report types' report-generation call sites (adSpendReportExport.ts,
// flipkartWeeklySalesExport.ts) already read from the MIS feed (fk_orders /
// fk_returns), not the barm_flipkart_order_report / barm_flipkart_returns
// CSV-upload tables — so once the MIS lookup succeeds, refreshMeta below
// overwrites just these two cards' info with the MIS numbers.
const MIS_BACKED_TYPES: FlipkartUploadReportType[] = ["order_report", "returns"];
// Current-moment snapshot (no date column) — mirrors Amazon's "Price & Inventory" group.
const SNAPSHOT_REPORT_TYPES: FlipkartUploadReportType[] = ["listings"];
const REPORT_TYPES: FlipkartUploadReportType[] = [...CORE_REPORT_TYPES, ...DETAIL_REPORT_TYPES, ...SNAPSHOT_REPORT_TYPES];

interface CardState {
  status: "idle" | "parsing" | "done" | "error";
  fileName?: string;
  message?: string;
}

// Always renders something. A blank caption reads as "nothing uploaded", which
// is a different fact from "still loading" and from "couldn't check".
function DataOnFileCaption({ info, staleAfterDays }: { info: FlipkartReportDataInfo | undefined; staleAfterDays?: number }) {
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
  if (info.rowCount > 0) {
    return (
      <p className="text-[10px] text-muted-foreground mt-1">
        {info.rowCount.toLocaleString("en-IN")} rows on file
      </p>
    );
  }
  return <p className="text-[10px] text-muted-foreground mt-1">No data uploaded yet</p>;
}

/** At-a-glance "which dates do I already have", one line per report. */
function CoverageStrip({
  types,
  info,
}: {
  types: FlipkartUploadReportType[];
  info: Partial<Record<FlipkartUploadReportType, FlipkartReportDataInfo>>;
}) {
  return (
    <div className="glass rounded-2xl border border-border p-4 shadow-sm">
      <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground mb-3">Data on file</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {types.map((t) => {
          const i = info[t];
          return (
            <div key={t} className="rounded-xl border border-border px-3 py-2">
              <p className="text-[11px] font-bold text-foreground truncate" title={FK_REPORT_LABEL[t]}>
                {FK_REPORT_LABEL[t]}
              </p>
              {!i ? (
                <p className="text-xs text-muted-foreground mt-0.5">Checking…</p>
              ) : i.error ? (
                <p className="text-xs text-red-600 dark:text-red-400 mt-0.5">Couldn&apos;t check</p>
              ) : i.minDate ? (
                <>
                  <p className="text-xs font-bold text-foreground mt-0.5 tabular-nums">
                    {i.minDate} → {i.maxDate}
                  </p>
                  <p className="text-[10px] text-muted-foreground">{i.rowCount.toLocaleString("en-IN")} rows</p>
                  {t === AD_SPEND_REPORT_TYPE &&
                    (() => {
                      const stale = staleness(i.maxDate, 1);
                      return stale && <p className="text-[10px] text-amber-600 dark:text-amber-400 font-semibold">&#9888; {stale.text}</p>;
                    })()}
                </>
              ) : i.rowCount > 0 ? (
                <p className="text-xs font-bold text-foreground mt-0.5 tabular-nums">
                  {i.rowCount.toLocaleString("en-IN")} rows
                </p>
              ) : (
                <p className="text-xs text-muted-foreground mt-0.5">Nothing uploaded</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function UploadCard({
  type,
  state,
  info,
  misAvailable,
  onFile,
}: {
  type: FlipkartUploadReportType;
  state: CardState;
  info: FlipkartReportDataInfo | undefined;
  misAvailable?: boolean;
  onFile: (file: File) => void;
}) {
  const inputId = `fk-upload-${type}`;
  const [dragOver, setDragOver] = useState(false);
  const accept = FK_REPORT_ACCEPT[type];
  const misBacked = misAvailable && MIS_BACKED_TYPES.includes(type);

  return (
    <div
      className={`glass rounded-2xl border p-5 shadow-sm transition-colors ${dragOver ? "border-primary" : "border-border"}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
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
          <h3 className="font-bold text-sm text-foreground">{FK_REPORT_LABEL[type]}</h3>
          <span className="text-[10px] text-muted-foreground uppercase font-black tracking-wider">
            {accept.replace(/\./g, "").toUpperCase().replace(/,/g, " / ")}
          </span>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground mb-3 leading-snug">{FK_REPORT_HINT[type]}</p>

      <label
        htmlFor={inputId}
        className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-border rounded-xl py-6 cursor-pointer hover:border-primary/50 transition-colors"
      >
        <UploadCloud size={22} className="text-muted-foreground" />
        <span className="text-xs text-muted-foreground px-2 text-center truncate max-w-full">
          {state.fileName || `Click or drop ${accept.includes("csv") ? "CSV" : "XLSX"} here`}
        </span>
      </label>
      <DataOnFileCaption info={info} staleAfterDays={type === AD_SPEND_REPORT_TYPE ? 1 : undefined} />
      {misBacked && (
        <p className="text-[10px] text-primary/70 mt-0.5">Synced live from MIS — reports use this, not the upload above.</p>
      )}
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

export default function FlipkartUploadReportsPage() {
  const [cardState, setCardState] = useState<Record<FlipkartUploadReportType, CardState>>(
    Object.fromEntries(REPORT_TYPES.map((t) => [t, { status: "idle" }])) as Record<FlipkartUploadReportType, CardState>
  );
  const [dataInfo, setDataInfo] = useState<Partial<Record<FlipkartUploadReportType, FlipkartReportDataInfo>>>({});
  const [metaError, setMetaError] = useState<string | null>(null);
  // Only true once the MIS lookup itself succeeds — gates the "synced live
  // from MIS" note so it's never shown next to numbers that are actually
  // still the barm_* CSV-upload fallback (MIS table unreachable, etc.).
  const [misAvailable, setMisAvailable] = useState(false);

  // A failure here must not blank the page — the upload cards still work. But it
  // must not be silent either: without it, an unreachable Supabase looks exactly
  // like "no data uploaded yet", and the seller re-uploads files that were never
  // going to save.
  const refreshMeta = useCallback(async () => {
    try {
      const info = await fetchAllFlipkartReportDataInfo();
      // Per-table failures come back on each entry rather than as a rejection;
      // surface one banner if every table failed the same way (Supabase down or
      // misconfigured) so it isn't repeated four times.
      const errors = Object.values(info).map((i) => i?.error).filter(Boolean);
      setMetaError(errors.length === Object.keys(info).length ? errors[0]! : null);

      try {
        const misInfo = await fetchAllMisFlipkartReportDataInfo();
        setDataInfo({ ...info, order_report: { ...misInfo.order_report }, returns: { ...misInfo.returns } });
        setMisAvailable(true);
      } catch {
        setDataInfo(info);
        setMisAvailable(false);
      }
    } catch (err) {
      setMetaError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    refreshMeta();
  }, [refreshMeta]);

  const handleFile = async (type: FlipkartUploadReportType, file: File) => {
    setCardState((prev) => ({ ...prev, [type]: { status: "parsing", fileName: file.name } }));
    try {
      const res = await uploadFlipkartReportFile(type, file);
      const span = res.minDate ? ` · ${res.minDate}${res.maxDate !== res.minDate ? ` to ${res.maxDate}` : ""}` : "";
      const droppedWarning = res.droppedWithSpend
        ? ` ⚠ ${res.droppedWithSpend.count} row${res.droppedWithSpend.count === 1 ? "" : "s"} with ₹${res.droppedWithSpend.totalSpend.toFixed(2)} of spend couldn't be saved (bad/missing date or ID) —check the source file`
        : "";
      setCardState((prev) => ({
        ...prev,
        [type]: {
          status: "done",
          fileName: file.name,
          message:
            `${res.savedRows.toLocaleString("en-IN")} rows saved` +
            (res.skippedRows ? `, ${res.skippedRows} skipped` : "") +
            ` (of ${res.totalRows.toLocaleString("en-IN")})${span}` +
            (res.mirrored ? ` · ${res.mirrored}` : "") +
            droppedWarning,
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
        <h1 className="text-2xl font-bold tracking-tight mb-0.5">Flipkart — Upload Reports</h1>
        <p className="text-muted-foreground text-sm">
          Upload these raw Flipkart exports (daily for the FSN report, weekly or whenever you have new data for the
          rest) to build a true SKU-wise historical Analysis Report — the same 30-day vs 7-day layout as the Amazon
          one. Re-uploading a period you already uploaded replaces those rows, so nothing gets duplicated. Head to
          the Download page once your data is uploaded to generate the report.
        </p>
      </div>

      {metaError && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/5 px-4 py-3 text-xs text-red-600 dark:text-red-400">
          <b>Couldn&apos;t read what&apos;s already uploaded.</b> No dates will show below until this clears, and an upload
          will likely fail the same way — {metaError}
        </div>
      )}

      <CoverageStrip types={REPORT_TYPES} info={dataInfo} />

      <div>
        <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground mb-3">
          Ads &amp; sales (required — the report is built from this)
        </h2>
        <p className="text-xs text-muted-foreground mb-3 -mt-2">
          Uploading this also refreshes the live Flipkart dashboard pages (Overview, Campaigns, Sales, Products), so
          you don&apos;t have to upload the same file again on the Upload Data tab.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {CORE_REPORT_TYPES.map((type) => (
            <UploadCard key={type} type={type} state={cardState[type]} info={dataInfo[type]} onFile={(f) => handleFile(type, f)} />
          ))}
        </div>
      </div>

      <div>
        <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground mb-3">
          Orders &amp; returns (optional — adds operational detail)
        </h2>
        <p className="text-xs text-muted-foreground mb-3 -mt-2">
          The order report adds order-item detail (statuses, SLA breaches, return reasons); the returns report tracks
          a return through in-transit/completed even before the order report&apos;s own status catches up.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {DETAIL_REPORT_TYPES.map((type) => (
            <UploadCard
              key={type}
              type={type}
              state={cardState[type]}
              info={dataInfo[type]}
              misAvailable={misAvailable}
              onFile={(f) => handleFile(type, f)}
            />
          ))}
        </div>
      </div>

      <div>
        <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground mb-3">
          Price &amp; stock (optional — improves accuracy for older date ranges)
        </h2>
        <p className="text-xs text-muted-foreground mb-3 -mt-2">
          Current-moment snapshot (no date column), so each upload fully replaces the previous one. Without it, the
          report falls back to the window&apos;s realised ASP for price and shows stock as blank.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {SNAPSHOT_REPORT_TYPES.map((type) => (
            <UploadCard key={type} type={type} state={cardState[type]} info={dataInfo[type]} onFile={(f) => handleFile(type, f)} />
          ))}
        </div>
      </div>
    </div>
  );
}
