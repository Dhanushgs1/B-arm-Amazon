"use client";

import { useState, useEffect, useCallback } from "react";
import { useDashboard } from "@/lib/DashboardContext";
import { UploadCloud, CheckCircle2, XCircle, Loader2, FileSpreadsheet, AlertTriangle } from "lucide-react";
import {
  uploadReportFile,
  type UploadReportType,
  type ReportDataInfo,
  REPORT_LABEL,
  fetchAllReportDataInfo,
} from "@/lib/amazonReportUpload";
import { maybeAlertHighAcos, ACOS_ALERT_TYPES } from "@/lib/uploadAcosAlert";
import { uploadCombinedWorkbook, fetchDailyTablesDataInfo, type SheetUploadOutcome } from "@/lib/combinedAdSpendUpload";
import { staleness } from "@/lib/dataFreshness";
import { fetchAllMisReportDataInfo, type MisReportDataInfo } from "@/lib/misAdapters";
import { uploadProductMarketing, fetchProductMarketingDataInfo, type ProductMarketingDataInfo } from "@/lib/productMarketingUpload";
import {
  uploadSocialMediaReportFile,
  fetchSocialMediaReportDataInfo,
  type SocialMediaReportDataInfo,
} from "@/lib/socialMediaReportUpload";
import {
  uploadGoogleFile,
  fetchGoogleOrdersDataInfo,
  fetchGoogleAdSpendDataInfo,
  type GoogleOrdersDataInfo,
  type GoogleAdSpendDataInfo,
} from "@/lib/googleOrdersUpload";
import Link from "next/link";
import { trackUpload, type UploadJob } from "@/lib/uploadTracker";
import { useUploadJob } from "@/components/UploadStatusTray";

const UPLOAD_HREF = "/dashboard/upload";

/** A card's last upload when you come back to the page (the card's own state starts empty again):
 *  still running with its progress, or how it finished. Same job the corner tray shows. */
function TrackedJobNote({ job }: { job: UploadJob | undefined }) {
  if (!job) return null;
  if (job.status === "running") {
    const p = job.progress;
    return (
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Still uploading {job.fileName}
        {p && p.total > 0 ? ` — ${Math.round((p.done / p.total) * 100)}%${p.step ? ` (${p.step})` : ""}` : "…"}
      </span>
    );
  }
  const when = new Date(job.finishedAt ?? job.startedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  const cls = job.status === "error" ? "text-red-600 dark:text-red-400" : job.status === "warning" ? "text-amber-600 dark:text-amber-400" : "text-green-600 dark:text-green-400";
  return (
    <span className={`flex items-start gap-1.5 font-semibold ${cls}`}>
      {job.status === "error" ? <XCircle size={14} className="mt-0.5 shrink-0" /> : job.status === "warning" ? <AlertTriangle size={14} className="mt-0.5 shrink-0" /> : <CheckCircle2 size={14} className="mt-0.5 shrink-0" />}
      <span>{job.fileName} at {when}: {job.message}</span>
    </span>
  );
}

/** One line for the tray from the combined workbook's per-sheet results. */
function combinedSummary(results: SheetUploadOutcome[]): { status: "done" | "warning" | "error"; message: string } {
  const ok = results.filter((r) => r.status === "ok");
  const failed = results.filter((r) => r.status === "error");
  const warnings = results.reduce((n, r) => n + (r.warnings?.length ?? 0), 0);
  const parts = [`${ok.length} sheet${ok.length === 1 ? "" : "s"} saved`];
  if (failed.length) parts.push(`failed: ${failed.map((r) => r.label).join(", ")}`);
  if (warnings) parts.push(`${warnings} warning${warnings === 1 ? "" : "s"}`);
  return { status: failed.length && !ok.length ? "error" : failed.length || warnings ? "warning" : "done", message: parts.join(" · ") };
}

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
  const job = useUploadJob(`amazon:report:${type}`);

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
        {state.status === "idle" && <TrackedJobNote job={job} />}
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
  /** High ACOS alert outcome for the "AM ads" sheet — filled in after the upload finishes. */
  acosNote?: { ok: boolean; text: string };
}

const SHEET_STATUS_STYLE: Record<SheetUploadOutcome["status"], string> = {
  ok: "text-green-600 dark:text-green-400",
  empty: "text-amber-600 dark:text-amber-400",
  missing: "text-muted-foreground",
  error: "text-red-600 dark:text-red-400",
};

function CombinedAdSpendUploadCard({ onUploaded, dataInfo, keySlot }: { onUploaded: () => void; dataInfo: ReportDataInfo | undefined; keySlot: string }) {
  const [state, setState] = useState<CombinedState>({ status: "idle" });
  const [dragOver, setDragOver] = useState(false);
  const job = useUploadJob("amazon:combined");

  const handleFile = async (file: File) => {
    setState({ status: "parsing", fileName: file.name });
    try {
      const { results, spAdsRows } = await trackUpload(
        { key: "amazon:combined", label: "Ad Spend Report (Last 7 days)", fileName: file.name, href: UPLOAD_HREF },
        (progress) => uploadCombinedWorkbook(file, progress),
        (r) => combinedSummary(r.results),
      );
      setState({ status: "done", fileName: file.name, results });
      onUploaded();
      // This is the daily "Last 7 days" upload, which is what releases the daily High ACOS email (7-day
      // ACOS per campaign, src/pages/api/high-acos-report.ts — at most one per day, recipients and
      // threshold from Settings). Runs after "done" so the email round-trip never holds up the result.
      if (spAdsRows.length) {
        setState((prev) => ({ ...prev, acosNote: { ok: true, text: "Checking high-ACOS campaigns…" } }));
        fetch("/api/high-acos-report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keySlot }) })
          .then(async (r) => {
            const a = await r.json().catch(() => ({}));
            const n = `${a.campaigns ?? 0} campaign${a.campaigns === 1 ? "" : "s"} above ${a.threshold ?? 14}% ACOS`;
            const acosNote = !r.ok ? { ok: false, text: `High ACOS email failed: ${a.error || r.status}` }
              : a.skipped ? { ok: true, text: `High ACOS email: ${a.skipped}.` }
              : a.emailError ? { ok: false, text: `High ACOS email: ${n}, not sent — ${a.emailError}` }
              : a.emailed ? { ok: true, text: `High ACOS email sent: ${n} (last 7 days).` }
              : { ok: true, text: `High ACOS email: ${n} — no email needed.` };
            setState((prev) => ({ ...prev, acosNote }));
          })
          .catch((e) => setState((prev) => ({ ...prev, acosNote: { ok: false, text: `High ACOS email failed: ${e instanceof Error ? e.message : String(e)}` } })));
      }
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
        AM ads / AM ord / FK ads / FK ord / MS BARM ads write straight into the real report tables (as
        well as an archived raw copy of every sheet). Sponsored Brands / Display rows in AM ads that aren&apos;t split per
        SKU (no Advertised SKU) are saved per campaign and spread over the SKUs already mapped to that campaign — any
        such spend with no mapping is flagged in amber after the upload. MS BARM ord is only archived, since Meesho orders now come from
        the meesho_barm_ord table. MS MW ads/ord (Millwright) are also only archived — that store isn&apos;t wired into
        the Ad Spend Report yet.
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
        {state.status === "idle" && <TrackedJobNote job={job} />}
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
              <div key={r.sheet}>
                <div className={`flex items-start gap-1.5 ${SHEET_STATUS_STYLE[r.status]}`}>
                  {r.status === "ok" ? <CheckCircle2 size={14} className="mt-0.5 shrink-0" /> : <XCircle size={14} className="mt-0.5 shrink-0" />}
                  <span><span className="font-semibold">{r.label}:</span> {r.detail}</span>
                </div>
                {r.warnings?.map((w) => (
                  <div key={w} className="flex items-start gap-1.5 mt-1 ml-5 text-amber-600 dark:text-amber-400 font-semibold">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                    <span>{w}</span>
                  </div>
                ))}
              </div>
            ))}
            {state.acosNote && (
              <div className={`flex items-start gap-1.5 ${state.acosNote.ok ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
                {state.acosNote.ok ? <CheckCircle2 size={14} className="mt-0.5 shrink-0" /> : <XCircle size={14} className="mt-0.5 shrink-0" />}
                <span className="font-semibold">{state.acosNote.text}</span>
              </div>
            )}
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
  const job = useUploadJob("amazon:social-media");

  const handleFile = async (file: File) => {
    setState({ status: "parsing", fileName: file.name });
    try {
      const res = await trackUpload(
        { key: "amazon:social-media", label: "Social Media Ad Spend (Meta)", fileName: file.name, href: UPLOAD_HREF },
        () => uploadSocialMediaReportFile(file),
        (r) => (r.savedRows ? { status: "done", message: `${r.savedRows} rows saved` } : { status: "warning", message: "Nothing saved — no campaign rows with reporting dates" }),
      );
      // List every window saved, so a workbook with a single-day sheet and a 7-day sheet shows both.
      const windows = res.windows
        .map((w) => `${w.start === w.end ? w.start : `${w.start} → ${w.end}`} (${w.days === 1 ? "1 day" : `${w.days} days`}) ₹${w.spend.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`)
        .join(" · ");
      const message = res.savedRows
        ? `Saved ${windows}${res.skippedRows ? ` — ${res.skippedRows} total/blank rows skipped` : ""}`
        : `Nothing saved — no row had a Campaign name with Reporting starts/ends (${res.totalRows} rows read)`;
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
        multi-day range both work, this card auto-detects which. One workbook can carry both — e.g. a
        &quot;oct 15&quot; sheet and an &quot;oct 9-15&quot; sheet — and every sheet is saved. Feeds the{" "}
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
        {state.status === "idle" && <TrackedJobNote job={job} />}
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
  status: "idle" | "parsing" | "done" | "warning" | "error";
  fileName?: string;
  message?: string;
}

// The seller's own hand-kept "B-Arm Orders" workbook — direct/Google-driven sales that don't come
// through Amazon, Flipkart or Meesho at all (S no, Invoice, Product, Qty, Price; no date column, no
// ad-spend data of any kind). Feeds the Ad Spend Report's Summary sheet "Google" row and the Ad
// spend report sheet's Google section — see googleOrdersUpload.ts / fetchGoogleOrders in
// adSpendReportExport.ts. Needs scripts/google_orders_table.sql run once in Supabase first.
// The same card also takes Google Ads' "Campaign report" export (ad spend) — each sheet is detected
// and saved to its own table (see uploadGoogleFile in googleOrdersUpload.ts).
function GoogleOrdersUploadCard({ onUploaded, dataInfo, spendInfo }: { onUploaded: () => void; dataInfo: GoogleOrdersDataInfo | undefined; spendInfo: GoogleAdSpendDataInfo | undefined }) {
  const [state, setState] = useState<GoogleOrdersState>({ status: "idle" });
  const [dragOver, setDragOver] = useState(false);
  const job = useUploadJob("amazon:google");

  const handleFile = async (file: File) => {
    setState({ status: "parsing", fileName: file.name });
    try {
      const { orders: res, spend } = await trackUpload(
        { key: "amazon:google", label: "Google Orders / Ad Spend", fileName: file.name, href: UPLOAD_HREF },
        () => uploadGoogleFile(file),
        (r) => ({
          status: r.orders?.rowsWithoutPrice || r.orders?.skippedRows ? "warning" : "done",
          message: [r.spend && "ad spend saved", r.orders && `${r.orders.savedRows} order rows saved`].filter(Boolean).join(" · ") || "saved",
        }),
      );
      const problems: string[] = [];
      const parts: string[] = [];
      if (spend) {
        const windows = spend.windows
          .map((w) => `${w.start === w.end ? w.start : `${w.start} → ${w.end}`} (${w.days === 1 ? "1 day" : `${w.days} days`}) ₹${w.spend.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`)
          .join(" · ");
        parts.push(`Ad spend saved: ${windows}`);
      }
      if (res) {
        if (res.rowsWithoutPrice) {
          problems.push(`Price missing on ${res.rowsWithoutPrice} row${res.rowsWithoutPrice === 1 ? "" : "s"} (line ${res.linesWithoutPrice.join(", ")}) — Sales for them stays blank; fill the Price and upload again`);
        }
        if (res.skippedRows) problems.push(`${res.skippedRows} row${res.skippedRows === 1 ? "" : "s"} skipped (no Date, SKU or Qty)`);
        parts.push(`Orders: ${res.savedRows} rows saved (of ${res.totalRows})`);
      }
      const message = `${parts.join(" · ")}${problems.length ? ` — ${problems.join("; ")}` : ""}`;
      setState({ status: problems.length ? "warning" : "done", fileName: file.name, message });
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
        Drop Shopify&apos;s &quot;Total sales by product&quot; export for orders (saved as the day before its file-name date —
        &quot;B-arm order 24_10_2026.xlsx&quot; = 23 Oct orders) — or the older &quot;B-Arm Orders&quot; workbook — and Google
        Ads&apos; &quot;Campaign report&quot; export for ad spend (the 1-day and the 7-day file, one at a time), or the daily
        &quot;Google_Ads_Spend_2026-10-25.xlsx&quot; (file-name date = the previous day: its &quot;Previous Day&quot; sheet is
        saved as 25 Oct, its &quot;Last 7 Days&quot; sheet as 19–25 Oct). Each sheet is detected and saved to its own table. Feeds the{" "}
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
          {state.fileName || "Click or drop the Shopify orders or Google Ads \"Campaign report\" .xlsx here"}
        </span>
      </label>
      {dataInfo && (
        <p className="text-[10px] text-muted-foreground mt-1">
          {dataInfo.error
            ? `Table not ready — ${dataInfo.error}`
            : dataInfo.rowCount > 0
              ? `Orders: ${dataInfo.minDate ?? "?"} to ${dataInfo.maxDate ?? "?"} · ${dataInfo.totalUnits.toLocaleString("en-IN")} units, ₹${dataInfo.totalValue.toLocaleString("en-IN")} (${dataInfo.rowCount} rows)`
              : "Orders: no data"}
        </p>
      )}
      {spendInfo && (
        <p className="text-[10px] text-muted-foreground mt-0.5">
          {spendInfo.error
            ? `Ad spend table not ready — ${spendInfo.error}`
            : spendInfo.rowCount > 0
              ? `Ad spend: ${spendInfo.minDate} to ${spendInfo.maxDate} (${spendInfo.rowCount} rows)`
              : "Ad spend: no data"}
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
        {state.status === "idle" && <TrackedJobNote job={job} />}
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
        {state.status === "warning" && (
          <span className="flex items-start gap-1.5 text-amber-600 dark:text-amber-400 font-semibold">
            <span aria-hidden>&#9888;</span> {state.message}
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
  const job = useUploadJob("amazon:product-marketing");

  const handleFile = async (file: File) => {
    setState({ status: "parsing", fileName: file.name });
    try {
      const res = await trackUpload(
        { key: "amazon:product-marketing", label: "Master Product Marketing", fileName: file.name, href: UPLOAD_HREF },
        () => uploadProductMarketing(file),
        (r) => ({ status: r.skippedRows ? "warning" : "done", message: `${r.savedRows} rows saved${r.skippedRows ? `, ${r.skippedRows} skipped` : ""}` }),
      );
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
        {state.status === "idle" && <TrackedJobNote job={job} />}
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
  const [googleSpendInfo, setGoogleSpendInfo] = useState<GoogleAdSpendDataInfo | undefined>(undefined);
  const refreshGoogleMeta = useCallback(async () => {
    const [info, spendInfo] = await Promise.all([fetchGoogleOrdersDataInfo(), fetchGoogleAdSpendDataInfo()]);
    setGoogleDataInfo(info);
    setGoogleSpendInfo(spendInfo);
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
      const res = await trackUpload(
        { key: `amazon:report:${type}`, label: REPORT_LABEL[type], fileName: file.name, href: UPLOAD_HREF },
        () => uploadReportFile(type, file),
        (r) => ({ status: r.skippedRows ? "warning" : "done", message: `${r.validRows} rows saved${r.skippedRows ? `, ${r.skippedRows} skipped` : ""} (of ${r.totalRows})` }),
      );
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

      <CombinedAdSpendUploadCard onUploaded={refreshCombinedMeta} dataInfo={combinedDataInfo} keySlot={keySlot} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <GoogleOrdersUploadCard onUploaded={refreshGoogleMeta} dataInfo={googleDataInfo} spendInfo={googleSpendInfo} />
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

    </div>
  );
}
