"use client";

import Link from "next/link";
import { PlugZap } from "lucide-react";
import { useDashboard } from "@/lib/DashboardContext";

// Shown in place of a screen whose only data source was SellerMate, while that integration is
// switched off (see src/lib/sellerMate.ts). Says plainly that there is no data source, so the
// screen can never read as "zero sales / zero spend".
export function DataSourceNotice() {
  const { loggedInUser } = useDashboard();
  const isBarm = loggedInUser === "Barm";
  return (
    <div className="flex min-h-[420px] flex-col items-center justify-center text-center px-6 glass rounded-2xl border border-border">
      <div className="w-12 h-12 rounded-2xl bg-muted border border-border flex items-center justify-center mb-4">
        <PlugZap className="w-5 h-5 text-muted-foreground" aria-hidden="true" />
      </div>
      <h1 className="text-lg font-extrabold text-foreground">No data source connected for this page</h1>
      <p className="text-sm text-muted-foreground mt-2 max-w-md">
        This page was fed by the SellerMate connection, which is switched off for the dashboard.
        Nothing is shown here rather than showing zeros.
        {isBarm ? " Amazon sales, orders and ad spend from your uploaded reports are on the Overview and Daily Ad Spend pages." : ""}
      </p>
      <div className="flex flex-wrap justify-center gap-3 mt-5">
        {isBarm && (
          <Link href="/dashboard" className="bg-primary text-primary-foreground font-extrabold text-xs px-4 py-2 rounded-lg transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
            Amazon Overview
          </Link>
        )}
        <Link href="/dashboard/compare" className="border border-border text-foreground font-extrabold text-xs px-4 py-2 rounded-lg transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
          Overall dashboard
        </Link>
      </div>
    </div>
  );
}
