"use client";

import { useState, useEffect } from "react";
import { PendingReportCard } from "@/components/marketplace/PendingReportCard";
import {
  fetchAllMeeshoReportDataInfo,
  MS_REPORT_LABEL,
  type MeeshoUploadReportType,
  type MeeshoReportDataInfo,
} from "@/lib/meeshoReportUpload";

// Mirrors /dashboard/flipkart/reports. The Meesho Weekly Sales Report's
// formulas haven't been specified yet, so the card only shows what's been
// uploaded on /dashboard/meesho/upload and keeps its button disabled.
export default function MeeshoReportsPage() {
  const [info, setInfo] = useState<Record<MeeshoUploadReportType, MeeshoReportDataInfo> | null>(null);

  useEffect(() => {
    fetchAllMeeshoReportDataInfo().then(setInfo);
  }, []);

  const caption = info
    ? (Object.keys(info) as MeeshoUploadReportType[]).map((t) => (
        <p key={t}>
          {MS_REPORT_LABEL[t]}:{" "}
          {info[t].error
            ? `couldn't check — ${info[t].error}`
            : info[t].minDate
            ? `${info[t].minDate} to ${info[t].maxDate} (${info[t].rowCount.toLocaleString("en-IN")} rows)`
            : "no data uploaded yet"}
        </p>
      ))
    : "Checking what's on file…";

  return (
    <div className="space-y-8 pb-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight mb-0.5">Download</h1>
        <p className="text-muted-foreground text-sm">Meesho · Download and export analytics reports</p>
      </div>

      <PendingReportCard
        title="Meesho Weekly Sales Report (SKU-wise)"
        description={
          <>
            Week-by-week Meesho report built from the Ads and Orders reports uploaded on the{" "}
            <a href="/dashboard/meesho/upload" className="underline hover:text-foreground">Meesho Upload</a> page.
          </>
        }
        dataCaption={caption}
      />
    </div>
  );
}
