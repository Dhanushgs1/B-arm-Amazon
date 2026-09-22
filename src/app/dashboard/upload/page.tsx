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
  fetchCampaignAllocations,
  setCampaignSkus,
  type CampaignAllocation,
} from "@/lib/amazonReportUpload";
import { maybeAlertHighAcos, ACOS_ALERT_TYPES } from "@/lib/uploadAcosAlert";
import { uploadCombinedWorkbook, fetchDailyTablesDataInfo, type SheetUploadOutcome } from "@/lib/combinedAdSpendUpload";
import { staleness } from "@/lib/dataFreshness";
import { fetchAllMisReportDataInfo, type MisReportDataInfo } from "@/lib/misAdapters";
import { fetchProductMasterNameMap } from "@/lib/productMasterUpload";
import { uploadProductMarketing, fetchProductMarketingDataInfo, type ProductMarketingDataInfo } from "@/lib/productMarketingUpload";
import {
  uploadSocialMediaReportFile,
  fetchSocialMediaReportDataInfo,
  type SocialMediaReportDataInfo,
} from "@/lib/socialMediaReportUpload";
import {
  uploadGoogleOrdersFile,
  fetchGoogleOrdersDataInfo,
  type GoogleOrdersDataInfo,
} from "@/lib/googleOrdersUpload";
import Link from "next/link";

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

function DataOnFileCaption({
  info,
  misInfo,
  staleAfterDays,
}: {
  info: ReportDataInfo | undefined;
  misInfo?: MisReportDataInfo;
  staleAfterDays?: number;
}) {
  // These 4 cards' reports read live from the MIS feed, not this card's own
  // CSV-upload table — show the MIS numbers (what the report actually uses)
  // instead of the upload table's, and say so, so a stale/absent CSV upload
  // doesn't read as "no data" when the report is in fact fine.
  if (misInfo) {
    if (misInfo.error) {
      return (
        <>
          <p className="text-[10px] text-red-600 dark:text-red-400 font-semibold mt-1">&#9888; MIS data unavailable — {misInfo.error}</p>
          <p className="text-[10px] text-primary/70 mt-0.5">Synced live from MIS — reports use this, not the CSV upload below.</p>
        </>
      );
    }
    const stale = staleAfterDays !== undefined ? staleness(misInfo.maxDate, staleAfterDays) : null;
    return (
      <>
        {misInfo.minDate ? (
          <p className="text-[10px] text-muted-foreground mt-1">
            Data: {misInfo.minDate} to {misInfo.maxDate} ({misInfo.rowCount} rows)
          </p>
        ) : (
          <p className="text-[10px] text-muted-foreground mt-1">No data</p>
        )}
        {stale && <p className="text-[10px] text-amber-600 dark:text-amber-400 font-semibold mt-0.5">&#9888; {stale.text}</p>}
        <p className="text-[10px] text-primary/70 mt-0.5">Synced live from MIS — reports use this, not the CSV upload below.</p>
      </>
    );
  }
  if (!info) return null;
  const stale = staleAfterDays !== undefined ? staleness(info.maxDate, staleAfterDays) : null;
  if (info.minDate) {
    return (
      <>
        <p className="text-[10px] text-muted-foreground mt-1">
          Data: {info.minDate} to {info.maxDate} ({info.rowCount} rows)
        </p>
        {stale && <p className="text-[10px] text-amber-600 dark:text-amber-400 font-semibold mt-0.5">&#9888; {stale.text}</p>}
      </>
    );
  }
  if (info.rowCount > 0) {
    return <p className="text-[10px] text-muted-foreground mt-1">{info.rowCount} rows on file</p>;
  }
  return <p className="text-[10px] text-muted-foreground mt-1">No data</p>;
}

// Only sp_advertised_product feeds the Ad Spend Report's Amazon spend total —
// the other Ad/order cards matter for the Historical Analysis Report instead,
// so a staleness warning on those would be noise unrelated to what it's for.
const AD_SPEND_REPORT_TYPE: UploadReportType = "sp_advertised_product";

function UploadCard({
  type,
  state,
  info,
  misInfo,
  onFile,
}: {
  type: UploadReportType;
  state: CardState;
  info: ReportDataInfo | undefined;
  misInfo?: MisReportDataInfo;
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
          <span className="text-[10px] text-muted-foreground uppercase font-black tracking-wider">CSV or XLSX</span>
        </div>
      </div>

      <label
        htmlFor={inputId}
        className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-border rounded-xl py-6 cursor-pointer hover:border-primary/50 transition-colors"
      >
        <UploadCloud size={22} className="text-muted-foreground" />
        <span className="text-xs text-muted-foreground px-2 text-center truncate max-w-full">
          {state.fileName || "Click or drop CSV/XLSX here"}
        </span>
      </label>
      <DataOnFileCaption info={info} misInfo={misInfo} staleAfterDays={type === AD_SPEND_REPORT_TYPE ? 1 : undefined} />
      <input
        id={inputId}
        type="file"
        accept=".csv,.xlsx,.xls"
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

interface CombinedState {
  status: "idle" | "parsing" | "done" | "error";
  fileName?: string;
  results?: SheetUploadOutcome[];
  error?: string;
}

const SHEET_STATUS_STYLE: Record<SheetUploadOutcome["status"], string> = {
  ok: "text-green-600 dark:text-green-400",
  empty: "text-amber-600 dark:text-amber-400",
  missing: "text-muted-foreground",
  error: "text-red-600 dark:text-red-400",
};

function CombinedAdSpendUploadCard({ onUploaded, dataInfo }: { onUploaded: () => void; dataInfo: ReportDataInfo | undefined }) {
  const [state, setState] = useState<CombinedState>({ status: "idle" });
  const [dragOver, setDragOver] = useState(false);

  const handleFile = async (file: File) => {
    setState({ status: "parsing", fileName: file.name });
    try {
      const results = await uploadCombinedWorkbook(file);
      setState({ status: "done", fileName: file.name, results });
      onUploaded();
    } catch (err) {
      setState({ status: "error", fileName: file.name, error: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="glass rounded-2xl border-2 border-primary/30 p-6 shadow-sm">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
          <FileSpreadsheet size={20} />
        </div>
        <div>
          <h3 className="font-bold text-sm text-foreground">Ad Spend Report — one-file upload</h3>
          <span className="text-[10px] text-muted-foreground uppercase font-black tracking-wider">XLSX</span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Drop the client&apos;s combined &quot;Last 7 days&quot; workbook here — this now feeds the{" "}
        <Link href="/dashboard/reports" className="underline hover:text-foreground">Ad Spend Report</Link> directly:
        AM ads / AM ord / FK ads / FK ord / MS BARM ads / MS BARM ord write straight into the real report tables (as
        well as an archived raw copy of every sheet). <b>Sponsored Brands and Sponsored Display are the one thing this
        file never contains</b> — Amazon doesn&apos;t offer those two combined with Sponsored Products, so they still
        need their own upload with the cards below. MS MW ads/ord (Millwright) only get archived, not reported —
        that store isn&apos;t wired into the Ad Spend Report yet.
      </p>

      <label
        htmlFor="combined-ad-spend-upload"
        className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-xl py-8 cursor-pointer transition-colors ${
          dragOver ? "border-primary" : "border-border hover:border-primary/50"
        }`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) handleFile(f);
        }}
      >
        <UploadCloud size={24} className="text-muted-foreground" />
        <span className="text-xs text-muted-foreground px-2 text-center truncate max-w-full">
          {state.fileName || "Click or drop the \"Last 7 days\" .xlsx here"}
        </span>
      </label>
      <DataOnFileCaption info={dataInfo} />
      <input
        id="combined-ad-spend-upload"
        type="file"
        accept=".xlsx,.xls"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          e.target.value = "";
        }}
      />

      <div className="mt-4 text-xs">
        {state.status === "parsing" && (
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading sheets &amp; saving to Supabase…
          </span>
        )}
        {state.status === "error" && (
          <span className="flex items-center gap-1.5 text-red-600 dark:text-red-400 font-semibold">
            <XCircle size={14} /> {state.error}
          </span>
        )}
        {state.status === "done" && state.results && (
          <div className="space-y-1.5">
            {state.results.map((r) => (
              <div key={r.sheet} className={`flex items-start gap-1.5 ${SHEET_STATUS_STYLE[r.status]}`}>
                {r.status === "ok" ? <CheckCircle2 size={14} className="mt-0.5 shrink-0" /> : <XCircle size={14} className="mt-0.5 shrink-0" />}
                <span><span className="font-semibold">{r.label}:</span> {r.detail}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface SocialMediaState {
  status: "idle" | "parsing" | "done" | "error";
  fileName?: string;
  message?: string;
}

// Meta Ads Manager's "Raw Data Report" export — feeds the Ad Spend Report's
// Summary sheet "Social Media" row (spend for whichever product is currently
// running Meta ads, cross-referenced against that product's own Amazon
// orders — see fetchSocialMediaAdSpend in adSpendReportExport.ts). Accepts
// either a single-day export or a multi-day range export; see
// socialMediaReportUpload.ts for how the two coexist without double-counting.
function SocialMediaUploadCard({ onUploaded, dataInfo }: { onUploaded: () => void; dataInfo: SocialMediaReportDataInfo | undefined }) {
  const [state, setState] = useState<SocialMediaState>({ status: "idle" });
  const [dragOver, setDragOver] = useState(false);

  const handleFile = async (file: File) => {
    setState({ status: "parsing", fileName: file.name });
    try {
      const res = await uploadSocialMediaReportFile(file);
      const message = `${res.savedRows} rows saved${res.skippedRows ? `, ${res.skippedRows} skipped` : ""} (of ${res.totalRows})`;
      setState({ status: "done", fileName: file.name, message });
      onUploaded();
    } catch (err) {
      setState({ status: "error", fileName: file.name, message: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="glass rounded-2xl border-2 border-primary/30 p-6 shadow-sm">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
          <FileSpreadsheet size={20} />
        </div>
        <div>
          <h3 className="font-bold text-sm text-foreground">Social Media Ad Spend (Meta)</h3>
          <span className="text-[10px] text-muted-foreground uppercase font-black tracking-wider">XLSX</span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Drop Meta Ads Manager&apos;s &quot;Raw Data Report&quot; export here — a single day&apos;s export or a
        multi-day range both work, this card auto-detects which. Feeds the{" "}
        <Link href="/dashboard/reports" className="underline hover:text-foreground">Ad Spend Report</Link>&apos;s
        Summary sheet &quot;Social Media&quot; row.
      </p>

      <label
        htmlFor="social-media-ad-spend-upload"
        className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-xl py-8 cursor-pointer transition-colors ${
          dragOver ? "border-primary" : "border-border hover:border-primary/50"
        }`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) handleFile(f);
        }}
      >
        <UploadCloud size={24} className="text-muted-foreground" />
        <span className="text-xs text-muted-foreground px-2 text-center truncate max-w-full">
          {state.fileName || "Click or drop the Meta \"Raw Data Report\" .xlsx here"}
        </span>
      </label>
      {dataInfo && (
        <p className="text-[10px] text-muted-foreground mt-1">
          {dataInfo.error ? `Table not ready — ${dataInfo.error}` : dataInfo.minDate ? `Data: ${dataInfo.minDate} to ${dataInfo.maxDate} (${dataInfo.rowCount} rows)` : "No data"}
        </p>
      )}
      <input
        id="social-media-ad-spend-upload"
        type="file"
        accept=".xlsx,.xls"
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
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading sheet &amp; saving to Supabase…
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

interface GoogleOrdersState {
  status: "idle" | "parsing" | "done" | "error";
  fileName?: string;
  message?: string;
}

// The seller's own hand-kept "B-Arm Orders" workbook — direct/Google-driven sales that don't come
// through Amazon, Flipkart or Meesho at all (S no, Invoice, Product, Qty, Price; no date column, no
// ad-spend data of any kind). Feeds the Ad Spend Report's Summary sheet "Google" row and the Ad
// spend report sheet's Google section — see googleOrdersUpload.ts / fetchGoogleOrders in
// adSpendReportExport.ts. Needs scripts/google_orders_table.sql run once in Supabase first.
function GoogleOrdersUploadCard({ onUploaded, dataInfo }: { onUploaded: () => void; dataInfo: GoogleOrdersDataInfo | undefined }) {
  const [state, setState] = useState<GoogleOrdersState>({ status: "idle" });
  const [dragOver, setDragOver] = useState(false);

  const handleFile = async (file: File) => {
    setState({ status: "parsing", fileName: file.name });
    try {
      const res = await uploadGoogleOrdersFile(file);
      const message = `${res.savedRows} rows saved${res.skippedRows ? `, ${res.skippedRows} skipped` : ""} (of ${res.totalRows})`;
      setState({ status: "done", fileName: file.name, message });
      onUploaded();
    } catch (err) {
      setState({ status: "error", fileName: file.name, message: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="glass rounded-2xl border-2 border-primary/30 p-6 shadow-sm">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
          <FileSpreadsheet size={20} />
        </div>
        <div>
          <h3 className="font-bold text-sm text-foreground">Google Orders (B-Arm)</h3>
          <span className="text-[10px] text-muted-foreground uppercase font-black tracking-wider">CSV / XLSX</span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Drop the seller&apos;s own &quot;B-Arm Orders&quot; workbook here (S no, Invoice, Product, Qty, Price — no
        ad spend data for this channel). Feeds the{" "}
        <Link href="/dashboard/reports" className="underline hover:text-foreground">Ad Spend Report</Link>&apos;s
        Summary sheet &quot;Google&quot; row.
      </p>

      <label
        htmlFor="google-orders-upload"
        className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-xl py-8 cursor-pointer transition-colors ${
          dragOver ? "border-primary" : "border-border hover:border-primary/50"
        }`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) handleFile(f);
        }}
      >
        <UploadCloud size={24} className="text-muted-foreground" />
        <span className="text-xs text-muted-foreground px-2 text-center truncate max-w-full">
          {state.fileName || "Click or drop the \"B-Arm Orders\" .xlsx here"}
        </span>
      </label>
      {dataInfo && (
        <p className="text-[10px] text-muted-foreground mt-1">
          {dataInfo.error
            ? `Table not ready — ${dataInfo.error}`
            : dataInfo.rowCount > 0
              ? `Data: ${dataInfo.minDate ?? "?"} to ${dataInfo.maxDate ?? "?"} · ${dataInfo.totalUnits.toLocaleString("en-IN")} units, ₹${dataInfo.totalValue.toLocaleString("en-IN")} (${dataInfo.rowCount} rows)`
              : "No data"}
        </p>
      )}
      <input
        id="google-orders-upload"
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
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading sheet &amp; saving to Supabase…
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

interface ProductMarketingState {
  status: "idle" | "parsing" | "done" | "error";
  fileName?: string;
  message?: string;
}

// Re-upload point for the marketing team's "Master SKU sheet with Category" workbook — the
// freshest, most current product master, checked FIRST by every downloadable report when
// resolving a SKU's display name/category (see src/lib/productMarketingUpload.ts). No date
// column, so each upload fully replaces the previous snapshot (same pattern as the combined
// Ad Spend upload card above).
function ProductMarketingUploadCard({ onUploaded, dataInfo }: { onUploaded: () => void; dataInfo: ProductMarketingDataInfo | undefined }) {
  const [state, setState] = useState<ProductMarketingState>({ status: "idle" });
  const [dragOver, setDragOver] = useState(false);

  const handleFile = async (file: File) => {
    setState({ status: "parsing", fileName: file.name });
    try {
      const res = await uploadProductMarketing(file);
      const message = `${res.savedRows} rows saved${res.skippedRows ? `, ${res.skippedRows} skipped` : ""} (of ${res.totalRows})`;
      setState({ status: "done", fileName: file.name, message });
      onUploaded();
    } catch (err) {
      setState({ status: "error", fileName: file.name, message: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="glass rounded-2xl border-2 border-primary/30 p-6 shadow-sm">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
          <FileSpreadsheet size={20} />
        </div>
        <div>
          <h3 className="font-bold text-sm text-foreground">Master Product Marketing</h3>
          <span className="text-[10px] text-muted-foreground uppercase font-black tracking-wider">XLSX</span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Drop the &quot;Master SKU sheet with Category&quot; workbook here (Product, Product name, SKU ID, Platforms,
        Category) — this is the marketing team&apos;s freshest master, checked first by every downloadable report for
        a product&apos;s display name/category. Re-uploading fully replaces the previous snapshot.
      </p>

      <label
        htmlFor="product-marketing-upload"
        className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-xl py-8 cursor-pointer transition-colors ${
          dragOver ? "border-primary" : "border-border hover:border-primary/50"
        }`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) handleFile(f);
        }}
      >
        <UploadCloud size={24} className="text-muted-foreground" />
        <span className="text-xs text-muted-foreground px-2 text-center truncate max-w-full">
          {state.fileName || "Click or drop the Master SKU sheet .xlsx here"}
        </span>
      </label>
      {dataInfo && (
        <p className="text-[10px] text-muted-foreground mt-1">
          {dataInfo.error ? `Table not ready — ${dataInfo.error}` : `${dataInfo.rowCount} rows on file`}
        </p>
      )}
      <input
        id="product-marketing-upload"
        type="file"
        accept=".xlsx,.xls"
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
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading sheet &amp; saving to Supabase…
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

// Words too generic/common in Amazon campaign names or product titles to mean
// anything on their own — excluded so a match needs actual product words in
// common, not just "auto" or "pack" appearing on both sides.
const CAMPAIGN_MATCH_STOPWORDS = new Set([
  "the", "and", "for", "with", "pack", "of", "combo", "set", "campaign", "broad", "exact", "phrase", "auto",
  "manual", "sb", "sd", "sponsored", "brand", "brands", "display", "ad", "ads", "targeting", "keyword", "product",
  "new", "model", "kit", "b", "arm", "barm", "size",
]);

function campaignMatchTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 2 && !CAMPAIGN_MATCH_STOPWORDS.has(w));
}

/** Best-guess SKU for an unmapped campaign, scored by how many meaningful
 *  words its name shares with a master product name — a starting point to
 *  confirm/edit, not an auto-applied mapping (nothing saves until Save is
 *  clicked). Requires at least 2 overlapping words to avoid noise matches. */
function suggestSkuForCampaign(
  campaignTokens: Set<string>,
  masterIndex: { sku: string; name: string; tokens: string[] }[]
): { sku: string; name: string } | null {
  if (!campaignTokens.size) return null;
  let best: { sku: string; name: string; score: number } | null = null;
  for (const entry of masterIndex) {
    if (!entry.tokens.length) continue;
    const overlap = entry.tokens.filter((t) => campaignTokens.has(t)).length;
    if (overlap < 2) continue;
    const score = overlap / Math.sqrt(entry.tokens.length);
    if (!best || score > best.score) best = { sku: entry.sku, name: entry.name, score };
  }
  return best ? { sku: best.sku, name: best.name } : null;
}

// Sponsored Brands / Display campaigns carry no SKU column in Amazon's own
// export, so their spend has to be routed to SKUs by hand — this is the only
// place in the app that can actually do it (setCampaignSkus/fetchCampaignAllocations
// in amazonReportUpload.ts existed already, just with no UI calling them).
// Typing N SKUs with no custom weight splits that campaign's spend equally
// across all N (see the division-by-total-weight logic in adSpendReportExport.ts).
function CampaignSkuMappingSection() {
  const [allocations, setAllocations] = useState<CampaignAllocation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, "saving" | "done" | "error">>({});
  const [suggestions, setSuggestions] = useState<Record<string, { sku: string; name: string }>>({});

  const refresh = useCallback(() => {
    fetchCampaignAllocations()
      .then((rows) => {
        setAllocations(rows);
        setError(null);
        setDrafts((prev) => {
          const next = { ...prev };
          rows.forEach((r) => {
            if (next[r.campaignName] === undefined) next[r.campaignName] = r.skus.map((s) => s.sku).join(", ");
          });
          return next;
        });
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Suggestions are computed separately from `refresh` (a different data
  // source — the product master, not the campaign allocations) so a
  // Save-triggered refresh doesn't need to redo this every time.
  useEffect(() => {
    if (!allocations) return;
    fetchProductMasterNameMap()
      .then((masterNames) => {
        const masterIndex = [...masterNames.entries()].map(([sku, name]) => ({ sku, name, tokens: campaignMatchTokens(name) }));
        const next: Record<string, { sku: string; name: string }> = {};
        allocations
          .filter((a) => a.skus.length === 0)
          .forEach((a) => {
            const guess = suggestSkuForCampaign(new Set(campaignMatchTokens(a.campaignName)), masterIndex);
            if (guess) next[a.campaignName] = guess;
          });
        setSuggestions(next);
      })
      .catch(() => setSuggestions({}));
  }, [allocations]);

  const handleSave = async (campaignName: string) => {
    setSaving((p) => ({ ...p, [campaignName]: "saving" }));
    try {
      const skus = (drafts[campaignName] || "").split(",").map((s) => s.trim()).filter(Boolean);
      await setCampaignSkus(campaignName, skus.map((sku) => ({ sku, weight: 1 })));
      setSaving((p) => ({ ...p, [campaignName]: "done" }));
      refresh();
    } catch {
      setSaving((p) => ({ ...p, [campaignName]: "error" }));
    }
  };

  const money = (v: number) => `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  const unmapped = (allocations || []).filter((a) => a.skus.length === 0);

  return (
    <div>
      <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground mb-3">
        Amazon Campaign → SKU Mapping (Sponsored Brands / Display)
      </h2>
      <p className="text-xs text-muted-foreground mb-3 -mt-2">
        These campaigns carry no SKU column in Amazon&apos;s own export, so their spend has to be routed to SKUs by
        hand — list the SKU(s) that campaign advertises, comma-separated. Spend splits equally across however many
        SKUs you list (5 SKUs on ₹100 spend → ₹20 each). Until mapped, a campaign&apos;s spend is excluded from every
        product total and shown as &quot;unmapped&quot; in the Ad Spend Report&apos;s Notes sheet instead.
      </p>
      {error && <p className="text-xs text-red-600 dark:text-red-400 mb-3">Couldn&apos;t load campaigns — {error}</p>}
      {!allocations && !error && <p className="text-xs text-muted-foreground">Loading campaigns…</p>}
      {allocations && (
        <>
          {unmapped.length > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400 font-semibold mb-3">
              {money(unmapped.reduce((s, a) => s + a.spend, 0))} of spend across {unmapped.length} campaign
              {unmapped.length === 1 ? "" : "s"} is currently unmapped.
            </p>
          )}
          {!allocations.length ? (
            <p className="text-xs text-muted-foreground">No Sponsored Brands/Display campaigns uploaded yet.</p>
          ) : (
            <div className="glass rounded-2xl border border-border overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-border">
                    <th className="p-3 font-bold">Campaign</th>
                    <th className="p-3 font-bold">Source</th>
                    <th className="p-3 font-bold text-right">Spend</th>
                    <th className="p-3 font-bold">SKUs (comma-separated)</th>
                    <th className="p-3 font-bold"></th>
                  </tr>
                </thead>
                <tbody>
                  {allocations.map((a) => (
                    <tr key={a.campaignName} className={`border-b border-border/50 ${a.skus.length === 0 ? "bg-amber-500/5" : ""}`}>
                      <td className="p-3 max-w-[240px] truncate" title={a.campaignName}>{a.campaignName}</td>
                      <td className="p-3">{a.source}</td>
                      <td className="p-3 text-right tabular-nums whitespace-nowrap">{money(a.spend)}</td>
                      <td className="p-3">
                        <input
                          type="text"
                          value={drafts[a.campaignName] ?? ""}
                          onChange={(e) => setDrafts((p) => ({ ...p, [a.campaignName]: e.target.value }))}
                          placeholder="e.g. A015, B-CT-G-1, A006-2"
                          className="w-full min-w-[220px] bg-transparent border border-border rounded-lg px-2 py-1 text-xs"
                        />
                        {a.skus.length === 0 && suggestions[a.campaignName] && !drafts[a.campaignName] && (
                          <button
                            type="button"
                            onClick={() => setDrafts((p) => ({ ...p, [a.campaignName]: suggestions[a.campaignName].sku }))}
                            className="mt-1 text-[10px] text-amber-700 dark:text-amber-400 hover:underline text-left block truncate max-w-[220px]"
                            title={`Matched from product name: ${suggestions[a.campaignName].name}`}
                          >
                            💡 Suggested: {suggestions[a.campaignName].sku} — click to use
                          </button>
                        )}
                      </td>
                      <td className="p-3 whitespace-nowrap">
                        <button
                          onClick={() => handleSave(a.campaignName)}
                          disabled={saving[a.campaignName] === "saving"}
                          className="text-xs font-bold text-primary hover:underline disabled:opacity-50"
                        >
                          {saving[a.campaignName] === "saving" ? "Saving…" : saving[a.campaignName] === "done" ? "Saved ✓" : "Save"}
                        </button>
                        {saving[a.campaignName] === "error" && <span className="text-red-600 text-[10px] block">Failed</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
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

  const [misDataInfo, setMisDataInfo] = useState<Partial<Record<UploadReportType, MisReportDataInfo>>>({});
  const refreshMisMeta = useCallback(async () => {
    const info = await fetchAllMisReportDataInfo();
    setMisDataInfo(info);
  }, []);

  const [combinedDataInfo, setCombinedDataInfo] = useState<ReportDataInfo | undefined>(undefined);
  const refreshCombinedMeta = useCallback(async () => {
    const info = await fetchDailyTablesDataInfo();
    setCombinedDataInfo(info);
  }, []);

  const [productMarketingDataInfo, setProductMarketingDataInfo] = useState<ProductMarketingDataInfo | undefined>(undefined);
  const refreshProductMarketingMeta = useCallback(async () => {
    const info = await fetchProductMarketingDataInfo();
    setProductMarketingDataInfo(info);
  }, []);

  const [socialMediaDataInfo, setSocialMediaDataInfo] = useState<SocialMediaReportDataInfo | undefined>(undefined);
  const refreshSocialMediaMeta = useCallback(async () => {
    const info = await fetchSocialMediaReportDataInfo();
    setSocialMediaDataInfo(info);
  }, []);

  const [googleDataInfo, setGoogleDataInfo] = useState<GoogleOrdersDataInfo | undefined>(undefined);
  const refreshGoogleMeta = useCallback(async () => {
    const info = await fetchGoogleOrdersDataInfo();
    setGoogleDataInfo(info);
  }, []);

  useEffect(() => {
    refreshMeta();
    refreshCombinedMeta();
    refreshMisMeta();
    refreshProductMarketingMeta();
    refreshSocialMediaMeta();
    refreshGoogleMeta();
  }, [refreshMeta, refreshCombinedMeta, refreshMisMeta, refreshProductMarketingMeta, refreshSocialMediaMeta, refreshGoogleMeta]);

  const handleFile = async (type: UploadReportType, file: File) => {
    setCardState((prev) => ({ ...prev, [type]: { status: "parsing", fileName: file.name } }));
    try {
      const res = await uploadReportFile(type, file);
      const message = `${res.validRows} rows saved${res.skippedRows ? `, ${res.skippedRows} skipped` : ""} (of ${res.totalRows})`;
      setCardState((prev) => ({
        ...prev,
        [type]: { status: "done", fileName: file.name, message },
      }));
      refreshMeta();

      // Weekly ads upload -> check the campaigns that just landed for high
      // ACOS, and if any are over threshold, email an alert (with AI fix
      // suggestions) to whoever's configured in Settings. Runs after the
      // "done" state above so a slow Gemini/email round-trip never blocks
      // the upload UI from showing success.
      if (ACOS_ALERT_TYPES.includes(type) && res.rows?.length) {
        maybeAlertHighAcos(type, res.rows, keySlot)
          .then((alert) => {
            if (alert.highAcosCount === 0) return;
            const suffix = alert.emailed
              ? ` · ⚠ ${alert.highAcosCount} high-ACOS campaign${alert.highAcosCount > 1 ? "s" : ""} emailed to ${alert.to}`
              : ` · ⚠ ${alert.highAcosCount} high-ACOS campaign${alert.highAcosCount > 1 ? "s" : ""} found (${alert.error || "email not sent"})`;
            setCardState((prev) => ({
              ...prev,
              [type]: { status: "done", fileName: file.name, message: `${message}${suffix}` },
            }));
          })
          .catch(() => {});
      }
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

      <CombinedAdSpendUploadCard onUploaded={refreshCombinedMeta} dataInfo={combinedDataInfo} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <GoogleOrdersUploadCard onUploaded={refreshGoogleMeta} dataInfo={googleDataInfo} />
        <SocialMediaUploadCard onUploaded={refreshSocialMediaMeta} dataInfo={socialMediaDataInfo} />
      </div>

      <ProductMarketingUploadCard onUploaded={refreshProductMarketingMeta} dataInfo={productMarketingDataInfo} />

      <div>
        <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground mb-3">
          Ads &amp; orders (required, date-scoped)
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {AD_ORDER_REPORT_TYPES.map((type) => (
            <UploadCard key={type} type={type} state={cardState[type]} info={dataInfo[type]} misInfo={misDataInfo[type]} onFile={(f) => handleFile(type, f)} />
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
            <UploadCard key={type} type={type} state={cardState[type]} info={dataInfo[type]} misInfo={misDataInfo[type]} onFile={(f) => handleFile(type, f)} />
          ))}
        </div>
      </div>

      <CampaignSkuMappingSection />
    </div>
  );
}
