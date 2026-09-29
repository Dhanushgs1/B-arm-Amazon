"use client";

import { useState, useEffect } from "react";
import { UploadOnlyOverview } from "@/components/marketplace/UploadOnlyOverview";
import { ChannelSummaryStrip } from "@/components/marketplace/ChannelSummaryStrip";
import { fetchBarmSummary } from "@/lib/channelSummary";
import { fetchBarmOnlineOrdersDataInfo } from "@/lib/barmOnlineOrders";

export default function BarmOverviewPage() {
  const [info, setInfo] = useState<Awaited<ReturnType<typeof fetchBarmOnlineOrdersDataInfo>> | null>(null);

  useEffect(() => {
    fetchBarmOnlineOrdersDataInfo().then(setInfo);
  }, []);

  return (
    <UploadOnlyOverview
      title="BARM Overview"
      subtitle="BARM (Google) · Data on file at a glance"
      downloadHref="/dashboard/barm/reports"
      summary={<ChannelSummaryStrip channel="BARM" fetcher={fetchBarmSummary} />}
      dataOnFile={[
        {
          label: "B-Arm Online Orders (barm_online_orders)",
          value: !info
            ? null
            : info.error
            ? `Couldn't check — ${info.error}`
            : info.orderCount
            ? `${info.minDate ?? "?"} to ${info.maxDate ?? "?"} (${info.orderCount.toLocaleString("en-IN")} orders)`
            : "No data yet",
        },
      ]}
    />
  );
}
