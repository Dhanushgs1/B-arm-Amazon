"use client";

import { useState, useEffect } from "react";
import { PendingReportCard } from "@/components/marketplace/PendingReportCard";
import { fetchGoogleOrdersDataInfo, type GoogleOrdersDataInfo } from "@/lib/googleOrdersUpload";

// Mirrors /dashboard/flipkart/reports. BARM = the seller's own Google Orders
// (B-Arm) channel, uploaded on /dashboard/google/upload. The BARM Weekly
// Sales Report's formulas haven't been specified yet, so the button stays
// disabled.
export default function BarmReportsPage() {
  const [info, setInfo] = useState<GoogleOrdersDataInfo | null>(null);

  useEffect(() => {
    fetchGoogleOrdersDataInfo().then(setInfo);
  }, []);

  const caption = !info
    ? "Checking what's on file…"
    : info.error
    ? `Couldn't check — ${info.error}`
    : info.rowCount
    ? `Uploaded B-Arm Orders: ${info.minDate ?? "?"} to ${info.maxDate ?? "?"} (${info.rowCount.toLocaleString("en-IN")} rows)`
    : "No B-Arm Orders uploaded yet";

  return (
    <div className="space-y-8 pb-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight mb-0.5">Download</h1>
        <p className="text-muted-foreground text-sm">BARM (Google) · Download and export analytics reports</p>
      </div>

      <PendingReportCard
        title="BARM Weekly Sales Report (SKU-wise)"
        description={
          <>
            Week-by-week BARM report built from the B-Arm Orders workbook uploaded on the{" "}
            <a href="/dashboard/google/upload" className="underline hover:text-foreground">BARM Upload</a> page.
          </>
        }
        dataCaption={caption}
      />
    </div>
  );
}
