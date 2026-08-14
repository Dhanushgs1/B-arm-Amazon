"use client";

import { Loader2 } from "lucide-react";

// Shown for the brief window before DashboardContext resolves a date range
// (and while server-rendering, before hydration) — without this, the
// marketplace pages render nothing at all for that frame instead of a
// visible loading state, unlike the rest of the dashboard.
export function MarketplaceLoading() {
  return (
    <div className="flex h-[60vh] items-center justify-center flex-col gap-4 text-muted-foreground">
      <Loader2 className="w-8 h-8 animate-spin text-primary" />
      <p className="font-semibold text-sm">Loading marketplace data...</p>
    </div>
  );
}
