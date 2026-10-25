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
      title="B-ARM Website Overview"
      subtitle={`B-ARM website orders before the move to Shopify (WooCommerce export${info?.maxDate ? `, up to ${info.maxDate}` : ""}) · newer website orders are on the Shopify tab`}
      downloadHref="/dashboard/barm/reports"
      summary={<ChannelSummaryStrip channel="B-ARM Website" fetcher={fetchBarmSummary} />}
      dataOnFile={[
        {
          label: "B-ARM Website orders — WooCommerce (barm_online_orders)",
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
