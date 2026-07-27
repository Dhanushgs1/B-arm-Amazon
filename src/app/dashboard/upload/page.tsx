"use client";

import { useState, useEffect, useCallback } from "react";
import { useDashboard } from "@/lib/DashboardContext";
import { UploadCloud, CheckCircle2, XCircle, Loader2, Download, FileSpreadsheet } from "lucide-react";
import {
  uploadReportFile,
  type UploadReportType,
  type ReportDataInfo,
  REPORT_LABEL,
  fetchUploadedDateRange,
  fetchUnmappedCampaigns,
  fetchAllReportDataInfo,
  setCampaignSku,
} from "@/lib/amazonReportUpload";
import { exportHistoricalAnalysisReport } from "@/lib/historicalAnalysisReportExport";
import { exportWeeklySalesReport } from "@/lib/weeklySalesExport";

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
  const { account, keySlot, endDate: dashboardEndDate } = useDashboard();

  const [cardState, setCardState] = useState<Record<UploadReportType, CardState>>(
    Object.fromEntries(REPORT_TYPES.map((t) => [t, { status: "idle" }])) as Record<UploadReportType, CardState>
  );
  const [unmapped, setUnmapped] = useState<string[]>([]);
  const [skuDrafts, setSkuDrafts] = useState<Record<string, string>>({});
  const [mappingBusy, setMappingBusy] = useState<string | null>(null);
  const [range, setRange] = useState<{ min: string | null; max: string | null }>({ min: null, max: null });
  const [dataInfo, setDataInfo] = useState<Partial<Record<UploadReportType, ReportDataInfo>>>({});
  const [reportEnd, setReportEnd] = useState("");
  const [generating, setGenerating] = useState(false);
  const [reportMsg, setReportMsg] = useState<string | null>(null);
  const [weeklyGenerating, setWeeklyGenerating] = useState(false);
  const [weeklyMsg, setWeeklyMsg] = useState<string | null>(null);

  const refreshMeta = useCallback(async () => {
    const [r, um, info] = await Promise.all([fetchUploadedDateRange(), fetchUnmappedCampaigns(), fetchAllReportDataInfo()]);
    setRange(r);
    setUnmapped(um);
    setDataInfo(info);
    setReportEnd((prev: string) => prev || r.max || "");
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

  const handleSaveSku = async (campaign: string) => {
    const sku = (skuDrafts[campaign] || "").trim();
    if (!sku) return;
    setMappingBusy(campaign);
    try {
      await setCampaignSku(campaign, sku);
      setUnmapped((prev) => prev.filter((c) => c !== campaign));
    } catch (err) {
      alert("Failed to save mapping: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setMappingBusy(null);
    }
  };

  const handleGenerate = async () => {
    if (!reportEnd) {
      alert("Pick an end date first.");
      return;
    }
    setGenerating(true);
    setReportMsg(null);
    try {
      // Only endDate: the report is built from a trailing 30-day and 7-day window that both end
      // there, so it has no use for a caller-supplied start date. The UI used to collect one and
      // pass it here, which never affected the output and broke the build.
      const res = await exportHistoricalAnalysisReport({ endDate: reportEnd, account, keySlot });
      setReportMsg(
        `Downloaded ${res.filename} — ${res.skuCount} SKUs` +
          (res.unmappedCampaignSpend ? `, ₹${res.unmappedCampaignSpend.toFixed(0)} spend still unmapped to a SKU` : "") +
          "."
      );
    } catch (err) {
      setReportMsg("Failed: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setGenerating(false);
    }
  };

  const handleWeeklyDownload = async () => {
    setWeeklyGenerating(true);
    setWeeklyMsg(null);
    try {
      const res = await exportWeeklySalesReport({ endDate: dashboardEndDate || undefined });
      setWeeklyMsg(`Downloaded ${res.filename} (${res.lastWeek.start} to ${res.thisWeek.end}).`);
    } catch (err) {
      setWeeklyMsg("Failed: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setWeeklyGenerating(false);
    }
  };

  return (
    <div className="space-y-8 pb-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight mb-0.5">Upload Reports</h1>
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

      {unmapped.length > 0 && (
        <div className="glass rounded-2xl border border-amber-500/40 p-6 shadow-sm">
          <h3 className="font-bold text-sm mb-1">Campaigns needing a SKU ({unmapped.length})</h3>
          <p className="text-xs text-muted-foreground mb-4">
            Sponsored Brands and Sponsored Display exports don&apos;t include a SKU column — assign the SKU each
            campaign advertises so its spend is counted in the SKU-wise report instead of landing in
            &quot;Unmapped&quot;.
          </p>
          <div className="space-y-2">
            {unmapped.map((c) => (
              <div key={c} className="flex items-center gap-2 text-xs">
                <span className="flex-1 truncate" title={c}>
                  {c}
                </span>
                <input
                  type="text"
                  placeholder="SKU"
                  value={skuDrafts[c] || ""}
                  onChange={(e) => setSkuDrafts((prev) => ({ ...prev, [c]: e.target.value }))}
                  className="w-40 px-2 py-1 rounded-md border border-border bg-background text-xs"
                />
                <button
                  onClick={() => handleSaveSku(c)}
                  disabled={mappingBusy === c || !(skuDrafts[c] || "").trim()}
                  className="px-3 py-1 bg-primary text-primary-foreground rounded-md text-xs font-bold disabled:opacity-50"
                >
                  {mappingBusy === c ? <Loader2 className="w-3 h-3 animate-spin" /> : "Save"}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="glass rounded-2xl border border-border p-6 shadow-sm">
        <h3 className="font-bold text-sm mb-1">Amazon Weekly Sales Report (SKU-wise)</h3>
        <p className="text-xs text-muted-foreground mb-4">
          Week-by-week Orders, Returns, Price, Total Sales, and Growth % per SKU, comparing last week vs this week —
          the same report the Weekly Summary email attaches, sourced from the data uploaded above. Uses the date
          selected at the top of the dashboard ({dashboardEndDate || "yesterday"}) as the end of &quot;this week&quot;.
        </p>
        <button
          onClick={handleWeeklyDownload}
          disabled={weeklyGenerating}
          className="px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-bold rounded-lg transition-colors flex items-center gap-2 shadow-md disabled:opacity-50"
        >
          {weeklyGenerating ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Generating…
            </>
          ) : (
            <>
              <Download size={14} /> Download Weekly Report
            </>
          )}
        </button>
        {weeklyMsg && <p className="text-xs mt-3 font-semibold">{weeklyMsg}</p>}
      </div>

      <div className="glass rounded-2xl border border-border p-6 shadow-sm">
        <h3 className="font-bold text-sm mb-1">Generate Historical Analysis Report</h3>
        <p className="text-xs text-muted-foreground mb-4">
          Builds the same Analysis Report layout (Price, Spend+Tax, Units, Orders, Returns, CPC, ACOS, TACOS) from
          the data uploaded above — one row per SKU. The report compares a trailing 30-day window against a
          trailing 7-day one, both ending on the date you pick, so only the end date is yours to choose.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-[10px] uppercase font-black tracking-wider text-muted-foreground mb-1">
              End date
            </label>
            <input
              type="date"
              value={reportEnd}
              onChange={(e) => setReportEnd(e.target.value)}
              className="px-2 py-1.5 rounded-md border border-border bg-background text-xs"
            />
          </div>
          <button
            onClick={handleGenerate}
            disabled={generating || !reportEnd}
            className="px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-bold rounded-lg transition-colors flex items-center gap-2 shadow-md disabled:opacity-50"
          >
            {generating ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Generating…
              </>
            ) : (
              <>
                <Download size={14} /> Generate &amp; Download
              </>
            )}
          </button>
        </div>
        {range.min && range.max && (
          <p className="text-[10px] text-muted-foreground mt-3">
            Uploaded data currently covers {range.min} to {range.max}.
          </p>
        )}
        {reportMsg && <p className="text-xs mt-3 font-semibold">{reportMsg}</p>}
      </div>
    </div>
  );
}
