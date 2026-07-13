"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDashboard } from "@/lib/DashboardContext";
import { mcp } from "@/lib/api";
import { DataTable } from "@/components/DataTable";
import { KPICard } from "@/components/KPICard";
import { Loader2, AlertTriangle, TrendingUp, HelpCircle, CheckCircle, Megaphone } from "lucide-react";
import { cn } from "@/lib/utils";

const cur = (val: number, currency?: string) => {
  const sym = currency === "INR" ? "₹" : "$";
  if (!val) return `${sym}0`;
  return sym + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val));
};
const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));
const pct = (val: number) => `${(val || 0).toFixed(2)}%`;

export default function CampaignsPage() {
  const { keySlot, startDate, endDate, account, contextLoading, setSelectedCampaignName } = useDashboard();

  const { data: performanceData, isLoading: perfLoading } = useQuery({
    queryKey: ["campaigns_performance", keySlot, account?.id, startDate, endDate],
    queryFn: async () => {
      const res = await mcp("get_campaign_performance", {
        amazon_account_id: account?.id,
        workspace_id: account?.workspace_id,
        start_date: startDate,
        end_date: endDate,
        page_size: 2000,
      }, keySlot);
      return res.data || [];
    },
    enabled: !!account,
  });

  const { data: campaignList, isLoading: listLoading } = useQuery({
    queryKey: ["campaigns_metadata_list", keySlot, account?.id],
    queryFn: async () => {
      const res = await mcp("list_campaigns", {
        amazon_account_id: account?.id,
        workspace_id: account?.workspace_id,
        page_size: 2000,
      }, keySlot);
      return res.campaigns || [];
    },
    enabled: !!account,
  });

  const isLoading = perfLoading || listLoading;
  const currency = account?.currency;

  const rawList = Array.isArray(campaignList) ? campaignList : (campaignList as any)?.campaigns || [];

  const campaigns = (rawList || []).map((meta: any) => {
    const perf = (performanceData || []).find((p: any) => p.campaignId === meta.campaignId);
    return {
      campaignId: meta.campaignId,
      campaignName: meta.name || meta.campaignName || perf?.campaignName || "Unnamed Campaign",
      state: meta.state || "ENABLED",
      spend: perf?.spend || 0,
      sales: perf?.sales || 0,
      acos: perf?.acos || 0,
      roas: perf?.roas || 0,
      impressions: perf?.impressions || 0,
      clicks: perf?.clicks || 0,
      orders: perf?.orders || 0,
      ctr: perf?.ctr || 0,
      cpc: perf?.cpc || 0,
    };
  });

  // Calculate Campaign KPIs
  const activeCampaigns = campaigns.filter((c: any) => c.state?.toUpperCase() === "ENABLED").length;
  const highAcosCount = campaigns.filter((c: any) => c.state?.toUpperCase() === "ENABLED" && c.acos > 40).length;
  const topRoasCount = campaigns.filter((c: any) => c.state?.toUpperCase() === "ENABLED" && c.roas > 5).length;
  const wastedSpend = campaigns.reduce((acc: number, c: any) => c.orders === 0 ? acc + (c.spend || 0) : acc, 0);

  // Lists for insights
  const bleedingCampaigns = campaigns.filter((c: any) => c.state?.toUpperCase() === "ENABLED" && c.acos > 50 && c.spend > 100);
  const zeroOrderWasted = campaigns.filter((c: any) => c.state?.toUpperCase() === "ENABLED" && c.orders === 0 && c.spend > 100)
    .sort((a: any, b: any) => b.spend - a.spend);
  const scaleCampaigns = campaigns.filter((c: any) => c.state?.toUpperCase() === "ENABLED" && c.roas > 5 && c.orders >= 5)
    .sort((a: any, b: any) => b.sales - a.sales);

  const [statusFilter, setStatusFilter] = useState<"ALL" | "ENABLED" | "PAUSED">("ALL");

  const filteredCampaigns = campaigns.filter((c: any) => {
    if (statusFilter === "ALL") return true;
    return c.state?.toUpperCase() === statusFilter;
  });

  const columns = [
    {
      key: "campaignName",
      label: "Campaign Name",
      sortable: true,
      render: (val: string, row: any) => (
        <div className="flex items-center gap-2 max-w-[260px]">
          <div className={cn("w-2 h-2 flex-shrink-0 rounded-full", row.state === "ENABLED" ? "bg-green-500" : "bg-yellow-500")} />
          <button
            onClick={() => setSelectedCampaignName(val)}
            className="font-semibold text-primary hover:underline text-left truncate text-sm focus:outline-none"
            title={val}
          >
            {val}
          </button>
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
        <h1 className="text-2xl font-bold tracking-tight mb-0.5">Campaigns</h1>
        <p className="text-muted-foreground text-sm">
          {account?.name} · {startDate} → {endDate}
        </p>
      </div>

      {contextLoading || isLoading ? (
        <div className="flex h-[400px] items-center justify-center text-muted-foreground flex-col gap-4 glass rounded-2xl border border-border">
          <Loader2 className="w-7 h-7 animate-spin text-primary" />
          <p className="font-semibold text-sm">{contextLoading ? "Connecting..." : "Loading Campaigns..."}</p>
        </div>
      ) : (
        <>
          {/* KPI Dashboard */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <KPICard title="Active Campaigns" value={num(activeCampaigns)} subtitle="Running ad groups" delay={0.05} />
            <KPICard title="High ACOS Campaigns" value={num(highAcosCount)} subtitle="ACOS > 40% (need optimization)" delay={0.1} />
            <KPICard title="High ROAS Campaigns" value={num(topRoasCount)} subtitle="ROAS > 5x (ready to scale)" delay={0.15} />
            <KPICard title="Wasted Ad Spend" value={cur(wastedSpend, currency)} subtitle="Spent with zero sales" inverseTrend delay={0.2} />
          </div>

          {/* Actionable Alerts & Recommendations */}
          {(bleedingCampaigns.length > 0 || zeroOrderWasted.length > 0 || scaleCampaigns.length > 0) && (
            <div className="glass rounded-2xl border border-border p-5 shadow-sm space-y-3">
              <h3 className="font-bold text-sm flex items-center gap-2">
                <Megaphone className="w-4 h-4 text-primary" /> Campaign Performance Insights
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {bleedingCampaigns.slice(0, 2).map((c: any) => (
                  <div key={c.campaignId} className="p-3 rounded-xl border border-red-200 dark:border-red-900 bg-red-50/50 dark:bg-red-950/20 text-xs">
                    <p className="font-bold text-red-800 dark:text-red-400 flex items-center gap-1">⚠️ High-ACOS Bleeder</p>
                    <p className="font-semibold mt-1 truncate" title={c.campaignName}>{c.campaignName}</p>
                    <p className="text-muted-foreground mt-0.5 font-bold">ACOS: {pct(c.acos)} · Spend: {cur(c.spend, currency)}</p>
                    <p className="font-bold text-red-700 dark:text-red-500 mt-1.5">Action: Lower keyword bids & add negative match keywords.</p>
                  </div>
                ))}
                {zeroOrderWasted.slice(0, 2).map((c: any) => (
                  <div key={c.campaignId} className="p-3 rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50/50 dark:bg-amber-950/20 text-xs">
                    <p className="font-bold text-amber-800 dark:text-amber-400 flex items-center gap-1">💸 Wasted Spend Alert</p>
                    <p className="font-semibold mt-1 truncate" title={c.campaignName}>{c.campaignName}</p>
                    <p className="text-muted-foreground mt-0.5 font-bold">Spend: {cur(c.spend, currency)} · Clicks: {c.clicks} · Orders: 0</p>
                    <p className="font-bold text-amber-700 dark:text-amber-500 mt-1.5">Action: Check product page conversion or pause this campaign.</p>
                  </div>
                ))}
                {scaleCampaigns.slice(0, 2).map((c: any) => (
                  <div key={c.campaignId} className="p-3 rounded-xl border border-green-200 dark:border-green-900 bg-green-50/50 dark:bg-green-950/20 text-xs">
                    <p className="font-bold text-green-800 dark:text-green-400 flex items-center gap-1">🚀 High-ROI Scaler</p>
                    <p className="font-semibold mt-1 truncate" title={c.campaignName}>{c.campaignName}</p>
                    <p className="text-muted-foreground mt-0.5 font-bold">ROAS: {c.roas.toFixed(2)}x · Sales: {cur(c.sales, currency)}</p>
                    <p className="font-bold text-green-700 dark:text-green-500 mt-1.5">Action: Increase campaign daily budget to capture more volume.</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Status Filters */}
          <div className="flex gap-2">
            <button
              onClick={() => setStatusFilter("ALL")}
              className={cn(
                "px-3 py-1.5 rounded-xl text-xs font-bold transition-all border",
                statusFilter === "ALL"
                  ? "bg-primary text-white border-primary shadow-sm shadow-primary/20"
                  : "bg-card border-border hover:border-primary/50 text-foreground"
              )}
            >
              All Campaigns ({campaigns.length})
            </button>
            <button
              onClick={() => setStatusFilter("ENABLED")}
              className={cn(
                "px-3 py-1.5 rounded-xl text-xs font-bold transition-all border",
                statusFilter === "ENABLED"
                  ? "bg-green-600 text-white border-green-600 shadow-sm shadow-green-600/20"
                  : "bg-card border-border hover:border-green-600/50 text-foreground"
              )}
            >
              Active ({campaigns.filter((c: any) => c.state?.toUpperCase() === "ENABLED").length})
            </button>
            <button
              onClick={() => setStatusFilter("PAUSED")}
              className={cn(
                "px-3 py-1.5 rounded-xl text-xs font-bold transition-all border",
                statusFilter === "PAUSED"
                  ? "bg-yellow-600 text-white border-yellow-600 shadow-sm shadow-yellow-600/20"
                  : "bg-card border-border hover:border-yellow-600/50 text-foreground"
              )}
            >
              Paused ({campaigns.filter((c: any) => c.state?.toUpperCase() === "PAUSED").length})
            </button>
          </div>

          <DataTable data={filteredCampaigns} columns={columns} defaultSort="spend" />
        </>
      )}
    </div>
  );
}
