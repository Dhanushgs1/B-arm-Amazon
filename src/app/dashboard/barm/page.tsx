"use client";

import { useState, useEffect } from "react";
import { UploadOnlyOverview } from "@/components/marketplace/UploadOnlyOverview";
import { fetchGoogleOrdersDataInfo, type GoogleOrdersDataInfo } from "@/lib/googleOrdersUpload";

export default function BarmOverviewPage() {
  const [info, setInfo] = useState<GoogleOrdersDataInfo | null>(null);

  useEffect(() => {
    fetchGoogleOrdersDataInfo().then(setInfo);
  }, []);

  return (
    <UploadOnlyOverview
      title="BARM Overview"
      subtitle="BARM (Google) · Uploaded data at a glance"
      uploadHref="/dashboard/google/upload"
      downloadHref="/dashboard/barm/reports"
      dataOnFile={[
        {
          label: "B-Arm Orders (Google)",
          value: !info
            ? null
            : info.error
            ? `Couldn't check — ${info.error}`
            : info.rowCount
            ? `${info.minDate ?? "?"} to ${info.maxDate ?? "?"} (${info.rowCount.toLocaleString("en-IN")} rows)`
            : "No data uploaded yet",
        },
      ]}
    />
  );
}
