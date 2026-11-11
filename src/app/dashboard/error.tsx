"use client"; // Error boundaries must be Client Components

import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

// Catches a render/runtime error in any dashboard page. Sits inside the dashboard layout, so the
// sidebar and header stay usable and the user can move to another page instead of facing a blank
// screen.
export default function DashboardError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error("[dashboard] page error:", error);
  }, [error]);

  return (
    <div role="alert" className="flex min-h-[420px] flex-col items-center justify-center gap-4 glass rounded-2xl border border-red-200 dark:border-red-900 bg-red-50/40 dark:bg-red-950/10 text-center px-6">
      <div className="w-12 h-12 rounded-2xl bg-red-500/10 border border-red-500/25 flex items-center justify-center">
        <AlertTriangle className="w-5 h-5 text-red-500" aria-hidden="true" />
      </div>
      <div>
        <h2 className="font-extrabold text-base text-red-700 dark:text-red-400">This page hit an error</h2>
        <p className="text-sm text-muted-foreground font-medium mt-1 max-w-md">
          Nothing was changed or lost. Try again, or open another page from the menu.
        </p>
        {error?.digest && <p className="text-xs text-muted-foreground mt-2">Reference: {error.digest}</p>}
      </div>
      <button
        onClick={() => unstable_retry()}
        className="flex items-center gap-1.5 bg-red-600 hover:bg-red-700 text-white font-extrabold text-xs px-4 py-2 rounded-lg transition shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600"
      >
        <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /> Try again
      </button>
    </div>
  );
}
