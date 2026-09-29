"use client";

import { useState, useEffect } from "react";
import { UploadOnlyOverview } from "@/components/marketplace/UploadOnlyOverview";
import { ChannelSummaryStrip } from "@/components/marketplace/ChannelSummaryStrip";
import { fetchMeeshoSummary } from "@/lib/channelSummary";
import {
  fetchAllMeeshoReportDataInfo,
  MS_REPORT_LABEL,
  type MeeshoUploadReportType,
  type MeeshoReportDataInfo,
} from "@/lib/meeshoReportUpload";

const TYPES: MeeshoUploadReportType[] = ["orders"];

export default function MeeshoOverviewPage() {
  const [info, setInfo] = useState<Record<MeeshoUploadReportType, MeeshoReportDataInfo> | null>(null);

  useEffect(() => {
    fetchAllMeeshoReportDataInfo().then(setInfo);
  }, []);

  return (
    <UploadOnlyOverview
      title="Meesho Overview"
      subtitle="Meesho · Data on file at a glance"
      downloadHref="/dashboard/meesho/reports"
      summary={<ChannelSummaryStrip channel="Meesho" fetcher={fetchMeeshoSummary} />}
      dataOnFile={TYPES.map((t) => {
        const i = info?.[t];
        return {
          label: MS_REPORT_LABEL[t],
          value: !i
            ? null
            : i.error
            ? `Couldn't check — ${i.error}`
            : i.minDate
            ? `${i.minDate} to ${i.maxDate} (${i.rowCount.toLocaleString("en-IN")} rows)`
            : "No data uploaded yet",
        };
      })}
    />
  );
}
