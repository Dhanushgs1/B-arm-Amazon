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
import { uploadProductMaster, fetchProductMasterDataInfo } from "@/lib/productMasterUpload";
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

function DataOnFileCaption({ info, staleAfterDays }: { info: ReportDataInfo | undefined; staleAfterDays?: number }) {
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
      <DataOnFileCaption info={info} staleAfterDays={type === AD_SPEND_REPORT_TYPE ? 1 : undefined} />
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
        Drop the client&apos;s combined &quot;Last 7 days&quot; workbook here — it reads the AM ads / AM ord / FK ads
        / FK ord / MS BARM ads / MS BARM ord / MS MW ads / MS MW ord sheets and archives each one, raw, into its own
        barm_daily_* table. It does not feed the report tables below — to generate the{" "}
        <Link href="/dashboard/reports" className="underline hover:text-foreground">Ad Spend Report</Link>, still
        upload each report with its own card below.
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

interface ProductMasterState {
  status: "idle" | "parsing" | "done" | "error";
  fileName?: string;
  message?: string;
}

function ProductMasterUploadCard({ onUploaded, rowCount }: { onUploaded: () => void; rowCount: number | undefined }) {
  const [state, setState] = useState<ProductMasterState>({ status: "idle" });
  const [dragOver, setDragOver] = useState(false);

  const handleFile = async (file: File) => {
    setState({ status: "parsing", fileName: file.name });
    try {
      const res = await uploadProductMaster(file);
      setState({
        status: "done",
        fileName: file.name,
        message: `${res.savedRows.toLocaleString("en-IN")} SKUs saved${res.skippedRows ? `, ${res.skippedRows} skipped` : ""} (of ${res.totalRows.toLocaleString("en-IN")})`,
      });
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
          <h3 className="font-bold text-sm text-foreground">Product Master — SKU to name</h3>
          <span className="text-[10px] text-muted-foreground uppercase font-black tracking-wider">XLSX</span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Drop the &quot;Product Master&quot; workbook here (its own &quot;Product Master&quot; sheet — Master SKU ID,
        Approved Product Name, Category). A full snapshot: each upload replaces the previous one. Every report — Amazon,
        Flipkart, and Meesho — checks this first for a SKU&apos;s display name before falling back to whatever name
        shows up on an order or price-listing row.
      </p>

      <label
        htmlFor="product-master-upload"
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
          {state.fileName || "Click or drop the Product Master .xlsx here"}
        </span>
      </label>
      {rowCount !== undefined && (
        <p className="text-[10px] text-muted-foreground mt-1">
          {rowCount > 0 ? `${rowCount.toLocaleString("en-IN")} SKUs on file` : "No product master uploaded yet"}
        </p>
      )}
      <input
        id="product-master-upload"
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
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading &amp; replacing…
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

  const [combinedDataInfo, setCombinedDataInfo] = useState<ReportDataInfo | undefined>(undefined);
  const refreshCombinedMeta = useCallback(async () => {
    const info = await fetchDailyTablesDataInfo();
    setCombinedDataInfo(info);
  }, []);

  const [productMasterRowCount, setProductMasterRowCount] = useState<number | undefined>(undefined);
  const refreshProductMasterMeta = useCallback(async () => {
    const info = await fetchProductMasterDataInfo();
    setProductMasterRowCount(info.rowCount);
  }, []);

  useEffect(() => {
    refreshMeta();
    refreshCombinedMeta();
    refreshProductMasterMeta();
  }, [refreshMeta, refreshCombinedMeta, refreshProductMasterMeta]);

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
      <ProductMasterUploadCard onUploaded={refreshProductMasterMeta} rowCount={productMasterRowCount} />

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

      <CampaignSkuMappingSection />
    </div>
  );
}
