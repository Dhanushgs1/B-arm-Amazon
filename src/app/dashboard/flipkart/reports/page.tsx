"use client";

import { useState, useEffect, useCallback } from "react";
import { useDashboard } from "@/lib/DashboardContext";
import { Download, Loader2 } from "lucide-react";
import { exportFlipkartHistoricalReport } from "@/lib/flipkartHistoricalReportExport";
import { fetchAllFlipkartReportDataInfo, flipkartUploadedDateRange } from "@/lib/flipkartReportUpload";

// Mirrors /dashboard/reports (Amazon): a "Generate & Download" card driven by
// whatever's been uploaded on /dashboard/flipkart/upload. Flipkart exposes no
// ads API, so unlike Amazon's Download page there are no live-API report
// cards here — the historical report is the one real export Flipkart has.
export default function FlipkartReportsPage() {
  const { endDate: dashboardEndDate } = useDashboard();
  const [generating, setGenerating] = useState(false);
  const [reportMsg, setReportMsg] = useState<string | null>(null);
  const [reportFailed, setReportFailed] = useState(false);
  const [range, setRange] = useState<{ min: string | null; max: string | null }>({ min: null, max: null });

  const refreshRange = useCallback(async () => {
    const info = await fetchAllFlipkartReportDataInfo();
    setRange(flipkartUploadedDateRange(info));
  }, []);

  useEffect(() => {
    refreshRange();
  }, [refreshRange]);

  const handleGenerate = async () => {
    if (!dashboardEndDate) {
      alert("Pick a date at the top of the dashboard first.");
      return;
    }
    setGenerating(true);
    setReportMsg(null);
    setReportFailed(false);
    try {
      const res = await exportFlipkartHistoricalReport({ endDate: dashboardEndDate });
      setReportMsg(
        `Downloaded ${res.filename} — ${res.skuCount} SKUs across ${res.pairCount} campaign × SKU rows` +
          (res.wastedSpend30 > 0 ? `, ₹${Math.round(res.wastedSpend30).toLocaleString("en-IN")} spend with zero attributed units` : "") +
          (res.missingSources.length ? `. Not uploaded for this window: ${res.missingSources.join(", ")}.` : ".") +
          (res.staleDays > 0
            ? ` ⚠️ Windows end on ${dashboardEndDate} as selected, but the newest uploaded row is from ${res.dataThrough} — the last ${res.staleDays} day(s) are empty. Upload the newer files, or pick ${res.dataThrough} as the end date.`
            : "")
      );
      refreshRange();
    } catch (err) {
      setReportFailed(true);
      setReportMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="space-y-8 pb-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight mb-0.5">Download</h1>
        <p className="text-muted-foreground text-sm">Flipkart · Download and export analytics reports</p>
      </div>

      <div className="glass rounded-2xl border border-border p-6 shadow-sm">
        <h3 className="font-bold text-sm mb-1">Generate Flipkart Historical Analysis Report</h3>
        <p className="text-xs text-muted-foreground mb-4">
          Builds the Analysis Report layout (Price, Spend+Tax, Ad Units, Ad Revenue, Orders, Returns, CPC, ACOS, TACOS)
          from the data uploaded on the Upload page — one row per campaign × SKU, plus per-SKU TACOS, settled P&amp;L,
          leaderboards and verbatim dumps of every uploaded file. Compares a trailing 30-day window against a
          trailing 7-day one, both ending on the date selected at the top of the dashboard (
          {dashboardEndDate || "yesterday"}).
        </p>
        <button
          onClick={handleGenerate}
          disabled={generating || !dashboardEndDate}
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
        {range.min && range.max && (
          <p className="text-[10px] text-muted-foreground mt-3">
            Uploaded Flipkart data currently covers {range.min} to {range.max}.
          </p>
        )}
        {reportMsg && (
          <p className={`text-xs mt-3 font-semibold ${reportFailed ? "text-red-600 dark:text-red-400" : ""}`}>{reportMsg}</p>
        )}
      </div>
    </div>
  );
}
