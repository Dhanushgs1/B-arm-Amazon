"use client";

import { useState, useEffect } from "react";
import { PendingReportCard } from "@/components/marketplace/PendingReportCard";
import { fetchBarmOnlineOrdersDataInfo } from "@/lib/barmOnlineOrders";

// Mirrors /dashboard/flipkart/reports. BARM = the seller's own website orders,
// read from the barm_online_orders table (see barmOnlineOrders.ts). The BARM Weekly
// Sales Report's formulas haven't been specified yet, so the button stays
// disabled.
export default function BarmReportsPage() {
  const [info, setInfo] = useState<Awaited<ReturnType<typeof fetchBarmOnlineOrdersDataInfo>> | null>(null);

  useEffect(() => {
    fetchBarmOnlineOrdersDataInfo().then(setInfo);
  }, []);

  const caption = !info
    ? "Checking what's on file…"
    : info.error
    ? `Couldn't check — ${info.error}`
    : info.orderCount
    ? `B-Arm Online Orders: ${info.minDate ?? "?"} to ${info.maxDate ?? "?"} (${info.orderCount.toLocaleString("en-IN")} orders)`
    : "No B-Arm online orders yet";

  return (
    <div className="space-y-8 pb-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight mb-0.5">Download</h1>
        <p className="text-muted-foreground text-sm">BARM (Google) · Download and export analytics reports</p>
      </div>

      <PendingReportCard
        title="BARM Weekly Sales Report (SKU-wise)"
        description={
          <>Week-by-week BARM report built from the barm_online_orders table in Supabase.</>
        }
        dataCaption={caption}
      />
    </div>
  );
}
