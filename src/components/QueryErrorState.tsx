"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";

interface QueryErrorStateProps {
  message?: string;
  onRetry?: () => void;
  compact?: boolean;
}

// Shown whenever a page's data fetch actually failed (isError), so a broken API
// connection reads as "something went wrong, retry" instead of looking exactly
// like a genuinely-empty account — the failure mode found across nearly every
// page in the dashboard audit.
export function QueryErrorState({ message, onRetry, compact = false }: QueryErrorStateProps) {
  return (
    <div
      className={
        compact
          ? "flex items-center justify-between gap-4 flex-wrap rounded-2xl border border-red-200 dark:border-red-900 bg-red-50/50 dark:bg-red-950/20 px-5 py-3.5"
          : "flex h-[300px] flex-col items-center justify-center gap-3 glass rounded-2xl border border-red-200 dark:border-red-900 bg-red-50/40 dark:bg-red-950/10 text-center px-6"
      }
    >
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-9 h-9 rounded-xl bg-red-500/10 border border-red-500/25 flex items-center justify-center flex-shrink-0">
          <AlertTriangle className="w-4 h-4 text-red-500" />
        </div>
        <div className="min-w-0 text-left">
          <p className="font-extrabold text-sm text-red-700 dark:text-red-400">Couldn't load this data</p>
          <p className="text-xs text-muted-foreground font-semibold">
            {message || "The request to the data service failed. This isn't an empty account — something went wrong."}
          </p>
        </div>
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="flex items-center gap-1.5 bg-red-600 hover:bg-red-700 text-white font-extrabold text-xs px-4 py-2 rounded-lg transition shadow-md flex-shrink-0"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Retry
        </button>
      )}
    </div>
  );
}
