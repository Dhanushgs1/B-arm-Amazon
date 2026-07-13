"use client";

import { useQuery } from "@tanstack/react-query";
import { useDashboard } from "@/lib/DashboardContext";
import { mcp } from "@/lib/api";
import { DataTable } from "@/components/DataTable";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const cur = (val: number, currency?: string) => {
  const sym = currency === "INR" ? "₹" : "$";
  if (!val) return `${sym}0`;
  return sym + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val));
};
const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));
const pct = (val: number) => `${(val || 0).toFixed(2)}%`;

export default function AdGroupsPage() {
  const { keySlot, startDate, endDate, account, contextLoading } = useDashboard();

  const { data, isLoading } = useQuery({
    queryKey: ["adgroups", keySlot, account?.id, startDate, endDate],
    queryFn: async () => {
      const res = await mcp("get_campaign_performance", {
        amazon_account_id: account?.id,
        workspace_id: account?.workspace_id,
        start_date: startDate,
        end_date: endDate,
        page_size: 500,
      }, keySlot);
      
      const campaigns = res.data || [];
      
      const getAdGroupName = (campaignName: string) => {
        if (!campaignName) return "Default Ad Group";
        // Clean timestamps (e.g., " 18/06/2026 ...")
        let cleanName = campaignName.replace(/\s+\d{1,2}\/\d{1,2}\/\d{4}.*$/, "").trim();
        let parts = cleanName.split(/\s*-\s*/);
        if (parts.length >= 2) {
          const lastPart = parts[parts.length - 1];
          // If the last part is too generic or short (e.g. "New", "KT"), combine it with the previous part
          if (parts.length >= 3 && (lastPart.toLowerCase() === "new" || lastPart.toLowerCase() === "test" || lastPart.length <= 3)) {
            return parts.slice(parts.length - 2).join(" - ");
          }
          return lastPart;
        }
        return cleanName;
      };

      // Generate ad groups from campaign names to align with SellerMate dashboard structure
      return campaigns.map((c: any) => {
        return {
          ...c,
          adGroupName: getAdGroupName(c.campaignName),
          adGroupId: c.campaignId + "-ag",
        };
      });
    },
    enabled: !!account,
  });

  const currency = account?.currency;

  const columns = [
    {
      key: "adGroupName",
      label: "Ad Group Name",
      sortable: true,
      render: (val: string, row: any) => (
        <div>
          <span className="font-semibold text-foreground text-sm block max-w-[240px] truncate" title={val}>
            {val}
          </span>
          <span className="text-[10px] text-muted-foreground block max-w-[200px] truncate" title={row.campaignName}>
            Campaign: {row.campaignName?.split("-").slice(0, 3).join("-")}
          </span>
        </div>
      ),
    },
    {
      key: "spend",
      label: "Spend",
      sortable: true,
      render: (val: number) => <span className="font-medium text-foreground">{cur(val, currency)}</span>,
    },
    {
      key: "sales",
      label: "Sales",
      sortable: true,
      render: (val: number) => <span className="text-green-600 dark:text-green-400 font-bold">{cur(val, currency)}</span>,
    },
    {
      key: "acos",
      label: "ACOS",
      sortable: true,
      render: (val: number) => (
        <span className={cn("px-2 py-0.5 rounded-full text-xs font-bold", val && val < 20 ? "bg-green-500/10 text-green-700 dark:text-green-400" : val && val > 40 ? "bg-red-500/10 text-red-700 dark:text-red-400" : "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400")}>
          {val ? pct(val) : "—"}
        </span>
      ),
    },
    {
      key: "roas",
      label: "ROAS",
      sortable: true,
      render: (val: number) => <span className="font-semibold">{val ? val.toFixed(2) : "—"}</span>,
    },
    {
      key: "impressions",
      label: "Impressions",
      sortable: true,
      render: (val: number) => num(val),
    },
    {
      key: "clicks",
      label: "Clicks",
      sortable: true,
      render: (val: number) => num(val),
    },
    {
      key: "orders",
      label: "Orders",
      sortable: true,
      render: (val: number) => num(val),
    },
    {
      key: "ctr",
      label: "CTR",
      sortable: true,
      render: (val: number) => val ? pct(val) : "—",
    },
    {
      key: "cpc",
      label: "CPC",
      sortable: true,
      render: (val: number) => cur(val, currency),
    },
  ];

  return (
    <div className="space-y-6 pb-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight mb-0.5">Ad Groups</h1>
        <p className="text-muted-foreground text-sm">
          {account?.name} · {startDate} → {endDate}
        </p>
      </div>

      {contextLoading || isLoading ? (
        <div className="flex h-[400px] items-center justify-center text-muted-foreground flex-col gap-4 glass rounded-2xl border border-border">
          <Loader2 className="w-7 h-7 animate-spin text-primary" />
          <p className="font-semibold text-sm">{contextLoading ? "Connecting..." : "Loading Ad Groups..."}</p>
        </div>
      ) : (
        <DataTable data={data || []} columns={columns} defaultSort="spend" />
      )}
    </div>
  );
}
