"use client";

import { useState, useEffect } from "react";
import { Download, Loader2 } from "lucide-react";
import { useDashboard } from "@/lib/DashboardContext";
import {
  fetchAllMeeshoReportDataInfo,
  MS_REPORT_LABEL,
  type MeeshoUploadReportType,
  type MeeshoReportDataInfo,
} from "@/lib/meeshoReportUpload";
import { exportMeeshoWeeklySalesReport } from "@/lib/meeshoWeeklySalesExport";

// Mirrors /dashboard/flipkart/reports' Weekly Sales Report card. The workbook is
// the Amazon weekly report's layout fed with Meesho data — see
// meeshoWeeklySalesExport.ts and meeshoSkuPeriodData.ts for the rules.
export default function MeeshoReportsPage() {
  const { endDate: dashboardEndDate } = useDashboard();
  const [info, setInfo] = useState<Record<MeeshoUploadReportType, MeeshoReportDataInfo> | null>(null);
  const [generating, setGenerating] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetchAllMeeshoReportDataInfo().then(setInfo);
  }, []);

  const handleDownload = async () => {
    setGenerating(true);
    setMsg(null);
    setFailed(false);
    try {
      const res = await exportMeeshoWeeklySalesReport({ endDate: dashboardEndDate || undefined });
      setMsg(
        `Downloaded ${res.filename} (${res.lastWeek.start} to ${res.thisWeek.end}) — ${res.skuCount} SKUs.` +
          (res.staleDays > 0 && res.dataThrough
            ? ` ⚠ meesho_barm_ord only goes up to ${res.dataThrough}, so "this week" covers just ${Math.max(0, 7 - res.staleDays)} of 7 days and every Growth % reads more negative than reality. Set the end date to ${res.dataThrough}, or load newer orders.`
            : "")
      );
    } catch (err) {
      setFailed(true);
      setMsg("Failed: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="space-y-8 pb-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight mb-0.5">Download</h1>
        <p className="text-muted-foreground text-sm">Meesho · Download and export analytics reports</p>
      </div>

      <div className="glass rounded-2xl border border-border p-6 shadow-sm">
        <h3 className="font-bold text-sm mb-1">Meesho Weekly Sales Report (SKU-wise)</h3>
        <p className="text-xs text-muted-foreground mb-4">
          Same sheets and formulas as the Amazon Weekly Sales Report — Growth Summary, Category Breakdown, Meesho
          Sales (Orders, All Returns, Customer Returns, Total Orders, Price, Total Sales, Growth %), Executive
          Dashboard and CEO Decision Center — comparing last week vs this week. Uses the date selected at the top of
          the dashboard ({dashboardEndDate || "yesterday"}) as the end of &quot;this week&quot;.
        </p>
        <button
          onClick={handleDownload}
          disabled={generating}
          className="px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-bold rounded-lg transition-colors flex items-center gap-2 shadow-md disabled:opacity-50"
        >
          {generating ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Generating…
            </>
          ) : (
            <>
              <Download size={14} /> Download Weekly Report
            </>
          )}
        </button>
        {msg && <p className={`text-xs mt-3 font-semibold ${failed ? "text-red-600 dark:text-red-400" : ""}`}>{msg}</p>}
        <div className="text-xs text-muted-foreground mt-3">
          {info
            ? (Object.keys(info) as MeeshoUploadReportType[]).map((t) => (
                <p key={t}>
                  {MS_REPORT_LABEL[t]}:{" "}
                  {info[t].error
                    ? `couldn't check — ${info[t].error}`
                    : info[t].minDate
                    ? `${info[t].minDate} to ${info[t].maxDate} (${info[t].rowCount.toLocaleString("en-IN")} rows)`
                    : "no data yet"}
                </p>
              ))
            : "Checking what's on file…"}
        </div>
      </div>
    </div>
  );
}
