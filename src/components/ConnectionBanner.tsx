"use client";

import { useDashboard } from "@/lib/DashboardContext";
import { WifiOff, RefreshCw, Loader2 } from "lucide-react";

// Shown when the SellerMate workspace context failed to load — without it
// every query is disabled and the dashboard would render zeros silently.
export function ConnectionBanner() {
  const { contextError, contextLoading, retryContext } = useDashboard();

  if (contextLoading || !contextError) return null;

  return (
    <div className="mb-6 flex items-center justify-between gap-4 flex-wrap rounded-2xl border border-red-200 dark:border-red-900 bg-red-50/90 dark:bg-red-950/40 px-5 py-4 shadow-sm">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-9 h-9 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center flex-shrink-0">
          <WifiOff className="w-4 h-4 text-red-600 dark:text-red-400" />
        </div>
        <div className="min-w-0">
          <p className="font-extrabold text-sm text-red-700 dark:text-red-400">Live data connection failed</p>
          <p className="text-xs text-red-600/80 dark:text-red-400/70 font-semibold truncate" title={contextError}>
            {contextError} — metrics are showing zero because no data could be loaded.
          </p>
        </div>
      </div>
      <button
        onClick={retryContext}
        className="flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-xl text-xs font-bold transition-colors shadow-sm flex-shrink-0"
      >
        <RefreshCw className="w-3.5 h-3.5" /> Retry Connection
      </button>
    </div>
  );
}
