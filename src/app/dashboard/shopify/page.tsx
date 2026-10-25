"use client";

import { useState, useEffect } from "react";
import { UploadOnlyOverview } from "@/components/marketplace/UploadOnlyOverview";
import { ShopifyOrdersSummary } from "@/components/marketplace/ShopifyOrdersSummary";
import { fetchShopifyOrdersDataInfo } from "@/lib/shopifyOrders";

export default function ShopifyOverviewPage() {
  const [info, setInfo] = useState<Awaited<ReturnType<typeof fetchShopifyOrdersDataInfo>> | null>(null);

  useEffect(() => {
    fetchShopifyOrdersDataInfo().then(setInfo);
  }, []);

  return (
    <UploadOnlyOverview
      title="Shopify Overview"
      subtitle="Shopify · Website orders by webhook"
      downloadHref="/dashboard/shopify/reports"
      summary={<ShopifyOrdersSummary />}
      dataOnFile={[
        {
          label: "Shopify Orders (barm_shopify_orders_v2, test orders excluded)",
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
