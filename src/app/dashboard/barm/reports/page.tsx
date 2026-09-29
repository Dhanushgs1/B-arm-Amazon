"use client";

import { useState, useEffect } from "react";
import { Download, Loader2 } from "lucide-react";
import { useDashboard } from "@/lib/DashboardContext";
import { fetchBarmOnlineOrdersDataInfo } from "@/lib/barmOnlineOrders";
import { exportBarmWeeklySalesReport } from "@/lib/barmWeeklySalesExport";

// Mirrors /dashboard/meesho/reports. BARM = the seller's own website orders, read from the
// barm_online_orders table; the workbook is the Amazon weekly report's layout fed with BARM
// data — see barmWeeklySalesExport.ts and barmSkuPeriodData.ts for the rules.
export default function BarmReportsPage() {
  const { endDate: dashboardEndDate } = useDashboard();
  const [info, setInfo] = useState<Awaited<ReturnType<typeof fetchBarmOnlineOrdersDataInfo>> | null>(null);
  const [generating, setGenerating] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetchBarmOnlineOrdersDataInfo().then(setInfo);
  }, []);

  const handleDownload = async () => {
    setGenerating(true);
    setMsg(null);
    setFailed(false);
    try {
      const res = await exportBarmWeeklySalesReport({ endDate: dashboardEndDate || undefined });
      setMsg(
        `Downloaded ${res.filename} (${res.lastWeek.start} to ${res.thisWeek.end}) — ${res.skuCount} rows.` +
          (res.staleDays > 0 && res.dataThrough
            ? ` ⚠ barm_online_orders only goes up to ${res.dataThrough}, so "this week" covers just ${Math.max(0, 7 - res.staleDays)} of 7 days and every Growth % reads more negative than reality. Set the end date to ${res.dataThrough}, or load newer orders.`
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
        <p className="text-muted-foreground text-sm">BARM (Google) · Download and export analytics reports</p>
      </div>

      <div className="glass rounded-2xl border border-border p-6 shadow-sm">
        <h3 className="font-bold text-sm mb-1">BARM Weekly Sales Report (SKU-wise)</h3>
        <p className="text-xs text-muted-foreground mb-4">
          Same sheets as the Amazon Weekly Sales Report — Growth Summary, Category Breakdown, BARM Sales, Executive
          Dashboard and CEO Decision Center — comparing last week vs this week, from the barm_online_orders table.
          Uses the date selected at the top of the dashboard ({dashboardEndDate || "yesterday"}) as the end of
          &quot;this week&quot;. Sales = Order Total Amount once per order; multi-product orders are one row, not split.
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
        <p className="text-xs text-muted-foreground mt-3">
          {!info
            ? "Checking what's on file…"
            : info.error
            ? `Couldn't check — ${info.error}`
            : info.orderCount
            ? `B-Arm Online Orders: ${info.minDate ?? "?"} to ${info.maxDate ?? "?"} (${info.orderCount.toLocaleString("en-IN")} orders)`
            : "No B-Arm online orders yet"}
        </p>
      </div>
    </div>
  );
}
