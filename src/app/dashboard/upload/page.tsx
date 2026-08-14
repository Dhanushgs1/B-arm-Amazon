"use client";

import { useState, useEffect, useCallback } from "react";
import { useDashboard } from "@/lib/DashboardContext";
import { UploadCloud, CheckCircle2, XCircle, Loader2, FileSpreadsheet } from "lucide-react";
import {
  uploadReportFile,
  type UploadReportType,
  type ReportDataInfo,
  REPORT_LABEL,
  fetchAllReportDataInfo,
} from "@/lib/amazonReportUpload";

const AD_ORDER_REPORT_TYPES: UploadReportType[] = [
  "sp_advertised_product",
  "sb_campaign",
  "sd_campaign",
  "am_orders",
  "am_returns",
  "fba_returns",
];

// Price/inventory are current-moment snapshots (no date column) — optional,
// but uploading them lets the historical report use the price/stock that was
// actually in effect instead of falling back to today's live catalog.
const CATALOG_REPORT_TYPES: UploadReportType[] = ["price_listing", "fba_inventory", "inventory_ledger"];

// SellerFlex (seller-fulfilled) returns — only relevant to sellers on that
// program, so it's optional and kept out of the required Ads & orders group.
const RETURNS_EXTRA_REPORT_TYPES: UploadReportType[] = ["sf_return"];

const REPORT_TYPES: UploadReportType[] = [...AD_ORDER_REPORT_TYPES, ...CATALOG_REPORT_TYPES, ...RETURNS_EXTRA_REPORT_TYPES];

interface CardState {
  status: "idle" | "parsing" | "done" | "error";
  fileName?: string;
  message?: string;
}

function DataOnFileCaption({ info }: { info: ReportDataInfo | undefined }) {
  if (!info) return null;
  if (info.minDate) {
    return (
      <p className="text-[10px] text-muted-foreground mt-1">
        Data: {info.minDate} to {info.maxDate} ({info.rowCount} rows)
      </p>
    );
  }
  if (info.rowCount > 0) {
    return <p className="text-[10px] text-muted-foreground mt-1">{info.rowCount} rows on file</p>;
  }
  return <p className="text-[10px] text-muted-foreground mt-1">No data</p>;
}

function UploadCard({
  type,
  state,
  info,
  onFile,
}: {
  type: UploadReportType;
  state: CardState;
  info: ReportDataInfo | undefined;
  onFile: (file: File) => void;
}) {
  const inputId = `upload-${type}`;
  const [dragOver, setDragOver] = useState(false);

  return (
    <div
      className={`glass rounded-2xl border p-5 shadow-sm transition-colors ${
        dragOver ? "border-primary" : "border-border"
      }`}
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
        <div>
          <h3 className="font-bold text-sm text-foreground">{REPORT_LABEL[type]}</h3>
          <span className="text-[10px] text-muted-foreground uppercase font-black tracking-wider">CSV</span>
        </div>
      </div>

      <label
        htmlFor={inputId}
        className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-border rounded-xl py-6 cursor-pointer hover:border-primary/50 transition-colors"
      >
        <UploadCloud size={22} className="text-muted-foreground" />
        <span className="text-xs text-muted-foreground px-2 text-center truncate max-w-full">
          {state.fileName || "Click or drop CSV here"}
        </span>
      </label>
      <DataOnFileCaption info={info} />
      <input
        id={inputId}
        type="file"
        accept=".csv"
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
          <span className="flex items-center gap-1.5 text-green-600 dark:text-green-400 font-semibold">
            <CheckCircle2 size={14} /> {state.message}
          </span>
        )}
        {state.status === "error" && (
          <span className="flex items-center gap-1.5 text-red-600 dark:text-red-400 font-semibold">
            <XCircle size={14} /> {state.message}
          </span>
        )}
      </div>
    </div>
  );
}

export default function UploadReportsPage() {
  const { account, keySlot } = useDashboard();

  const [cardState, setCardState] = useState<Record<UploadReportType, CardState>>(
    Object.fromEntries(REPORT_TYPES.map((t) => [t, { status: "idle" }])) as Record<UploadReportType, CardState>
  );
  const [dataInfo, setDataInfo] = useState<Partial<Record<UploadReportType, ReportDataInfo>>>({});
  const refreshMeta = useCallback(async () => {
    const info = await fetchAllReportDataInfo();
    setDataInfo(info);
  }, []);

  useEffect(() => {
    refreshMeta();
  }, [refreshMeta]);

  const handleFile = async (type: UploadReportType, file: File) => {
    setCardState((prev) => ({ ...prev, [type]: { status: "parsing", fileName: file.name } }));
    try {
      const res = await uploadReportFile(type, file);
      setCardState((prev) => ({
        ...prev,
        [type]: {
          status: "done",
          fileName: file.name,
          message: `${res.validRows} rows saved${res.skippedRows ? `, ${res.skippedRows} skipped` : ""} (of ${res.totalRows})`,
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
        <h1 className="text-2xl font-bold tracking-tight mb-0.5">Upload</h1>
        <p className="text-muted-foreground text-sm">
          Upload these raw Amazon exports (weekly, or whenever you have new data) to build a true SKU-wise
          historical Analysis Report — the live dashboard reports only cover a trailing 30/7-day window and are
          per-ASIN. Re-uploading an overlapping date range just updates those rows, so nothing gets duplicated.
        </p>
      </div>

      <div>
        <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground mb-3">
          Ads &amp; orders (required, date-scoped)
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {AD_ORDER_REPORT_TYPES.map((type) => (
            <UploadCard key={type} type={type} state={cardState[type]} info={dataInfo[type]} onFile={(f) => handleFile(type, f)} />
          ))}
        </div>
      </div>

      <div>
        <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground mb-3">
          Price &amp; inventory (optional — improves accuracy for older date ranges)
        </h2>
        <p className="text-xs text-muted-foreground mb-3 -mt-2">
          These are current-moment snapshots (no date column), so each upload fully replaces the previous one.
          Without them, the report falls back to today&apos;s live catalog/inventory for price and stock.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {CATALOG_REPORT_TYPES.map((type) => (
            <UploadCard key={type} type={type} state={cardState[type]} info={dataInfo[type]} onFile={(f) => handleFile(type, f)} />
          ))}
        </div>
      </div>

      <div>
        <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground mb-3">
          Returns — SellerFlex (optional)
        </h2>
        <p className="text-xs text-muted-foreground mb-3 -mt-2">
          Only relevant if you fulfill orders yourself through Amazon&apos;s SellerFlex program — adds an SF Returns
          sheet to the report. Skip this if you&apos;re FBA/MFN only.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {RETURNS_EXTRA_REPORT_TYPES.map((type) => (
            <UploadCard key={type} type={type} state={cardState[type]} info={dataInfo[type]} onFile={(f) => handleFile(type, f)} />
          ))}
        </div>
      </div>
    </div>
  );
}
