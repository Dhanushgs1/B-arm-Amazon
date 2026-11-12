"use client";

import { useRouter } from "next/navigation";
import { ArrowRight, RefreshCw } from "lucide-react";
import { useDashboard } from "@/lib/DashboardContext";
import { ChannelSummaryStrip } from "@/components/marketplace/ChannelSummaryStrip";
import { FlipkartAdvertising } from "@/components/marketplace/FlipkartAdvertising";
import { FlipkartBreakdowns } from "@/components/marketplace/FlipkartBreakdowns";
import { fetchFlipkartOrderSummary } from "@/lib/channelSummary";

// The Flipkart Overview, laid out like the Amazon one (user, 12 Nov 2026): sales, orders and returns,
// then advertising (KPIs, the daily trend and campaigns), then the order breakdowns. The old lower
// block (Gross / Net / Organic Sales from the "Earn more" upload, the campaign-performance KPIs,
// quick stats and top lists) is gone: it read ₹0 without that upload and stopped on 10 Sep 2026.
export function FlipkartOverview() {
  const router = useRouter();
  const { loggedInUser } = useDashboard();
  const accountLabel = loggedInUser === "Barm" ? "Barm" : "Lkn";

  return (
    <div className="space-y-6 pb-12">
      {/* Page Header — mirrors the Amazon overview page (TopNav already provides dates and theme). */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-200/50 dark:border-slate-800/50 pb-4">
        <div className="space-y-1">
          <h1 className="text-3xl font-black tracking-tight text-slate-900 dark:text-white">Flipkart Overview</h1>
          <p className="text-slate-500 dark:text-slate-400 text-xs">
            Business Intelligence Dashboard · {accountLabel} Flipkart Store
          </p>
        </div>
        <button
          onClick={() => router.refresh()}
          className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-full text-xs font-bold transition-all shadow-md shadow-indigo-600/20 self-start md:self-auto"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>

      <ChannelSummaryStrip channel="Flipkart" fetcher={fetchFlipkartOrderSummary} title="Sales, Orders & Returns" />

      <FlipkartAdvertising />

      <FlipkartBreakdowns />

      <div className="flex justify-end">
        <button
          onClick={() => router.push("/dashboard/flipkart/reports")}
          className="flex items-center gap-1.5 text-xs font-bold text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300 transition-colors py-1.5 px-3 rounded-lg hover:bg-indigo-50 dark:hover:bg-indigo-950/30"
        >
          View Full Reports <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
