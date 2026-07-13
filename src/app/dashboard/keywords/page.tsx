"use client";

import { useQuery } from "@tanstack/react-query";
import { useDashboard } from "@/lib/DashboardContext";
import { mcp } from "@/lib/api";
import { DataTable } from "@/components/DataTable";
import { KPICard } from "@/components/KPICard";
import { Loader2, KeyRound, AlertTriangle, TrendingUp, HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";

const cur = (val: number, currency?: string) => {
  const sym = currency === "INR" ? "₹" : "$";
  if (!val) return `${sym}0`;
  return sym + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val));
};
const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));
const pct = (val: number) => `${(val || 0).toFixed(2)}%`;

export default function KeywordsPage() {
  const { keySlot, startDate, endDate, account, contextLoading, setSelectedCampaignName } = useDashboard();

  const { data, isLoading } = useQuery({
    queryKey: ["keywords", keySlot, account?.id, startDate, endDate],
    queryFn: async () => {
      const res = await mcp("get_targeting_performance", {
        amazon_account_id: account?.id,
        workspace_id: account?.workspace_id,
        start_date: startDate,
        end_date: endDate,
        page_size: 2000,
      }, keySlot);
      return res.data || res.keywords || [];
    },
    enabled: !!account,
  });

  const currency = account?.currency;

  const keywords = data || [];
  
  // Calculate Keyword KPIs
  const totalKeywords = keywords.length;
  const highAcosKeywords = keywords.filter((k: any) => k.acos > 40).length;
  const scaleKeywordsCount = keywords.filter((k: any) => k.roas > 5).length;
  const wastedSpend = keywords.reduce((acc: number, k: any) => k.orders === 0 ? acc + (k.spend || 0) : acc, 0);

  // Lists for insights
  const bleedingKeywords = keywords.filter((k: any) => k.acos > 45 && k.spend > 100)
    .sort((a: any, b: any) => b.acos - a.acos);
  const clickNoOrderKeywords = keywords.filter((k: any) => k.orders === 0 && k.clicks > 15)
    .sort((a: any, b: any) => b.spend - a.spend);
  const scalingKeywords = keywords.filter((k: any) => k.roas > 5 && k.orders >= 3)
    .sort((a: any, b: any) => b.sales - a.sales);

  const columns = [
    {
      key: "targetingValue",
      label: "Keyword / Target",
      sortable: true,
      render: (val: string, row: any) => (
        <div>
          <span className="font-semibold text-foreground text-sm block max-w-[280px] truncate" title={val}>
            {val || "—"}
          </span>
          <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded font-mono">
            {row.targetingType || "TARGET"}
          </span>
        </div>
      ),
    },
    {
      key: "campaignName",
      label: "Campaign",
      sortable: true,
      render: (val: string) => (
        <button
          onClick={() => setSelectedCampaignName(val)}
          className="text-primary hover:underline text-xs block max-w-[200px] truncate text-left focus:outline-none font-semibold"
          title={val}
        >
          {val ? val.split("-").slice(0, 3).join("-") : "—"}
        </button>
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
        <h1 className="text-2xl font-bold tracking-tight mb-0.5">Keywords & Targets</h1>
        <p className="text-muted-foreground text-sm">
          {account?.name} · {startDate} → {endDate}
        </p>
      </div>

      {contextLoading || isLoading ? (
        <div className="flex h-[400px] items-center justify-center text-muted-foreground flex-col gap-4 glass rounded-2xl border border-border">
          <Loader2 className="w-7 h-7 animate-spin text-primary" />
          <p className="font-semibold text-sm">{contextLoading ? "Connecting..." : "Loading Keywords..."}</p>
        </div>
      ) : (
        <>
          {/* KPI Dashboard */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <KPICard title="Total Targets" value={num(totalKeywords)} subtitle="Active targeting keywords" delay={0.05} />
            <KPICard title="High ACOS Targets" value={num(highAcosKeywords)} subtitle="ACOS > 40% (need optimization)" delay={0.1} />
            <KPICard title="High ROAS Targets" value={num(scaleKeywordsCount)} subtitle="ROAS > 5x (ready to scale)" delay={0.15} />
            <KPICard title="Wasted Target Spend" value={cur(wastedSpend, currency)} subtitle="Spend on targets with 0 sales" inverseTrend delay={0.2} />
          </div>

          {/* Actionable Alerts & Recommendations */}
          {(bleedingKeywords.length > 0 || clickNoOrderKeywords.length > 0 || scalingKeywords.length > 0) && (
            <div className="glass rounded-2xl border border-border p-5 shadow-sm space-y-3">
              <h3 className="font-bold text-sm flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-primary" /> Keyword & Target Performance Insights
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {bleedingKeywords.slice(0, 2).map((k: any) => (
                  <div key={k.targetingValue + k.campaignName} className="p-3 rounded-xl border border-red-200 dark:border-red-900 bg-red-50/50 dark:bg-red-950/20 text-xs">
                    <p className="font-bold text-red-800 dark:text-red-400 flex items-center gap-1">⚠️ High-ACOS Target</p>
                    <p className="font-semibold mt-1 truncate" title={k.targetingValue}>{k.targetingValue}</p>
                    <p className="text-muted-foreground mt-0.5 font-bold">ACOS: {pct(k.acos)} · Campaign: {k.campaignName ? k.campaignName.split("-").slice(0, 2).join("-") : "—"}</p>
                    <p className="font-bold text-red-700 dark:text-red-500 mt-1.5">Action: Lower keyword bid by 15% to increase profit margin.</p>
                  </div>
                ))}
                {clickNoOrderKeywords.slice(0, 2).map((k: any) => (
                  <div key={k.targetingValue + k.campaignName} className="p-3 rounded-xl border border-yellow-200 dark:border-yellow-900 bg-yellow-50/50 dark:bg-yellow-950/20 text-xs">
                    <p className="font-bold text-yellow-800 dark:text-yellow-400 flex items-center gap-1">❌ Zero Conversion Bleeder</p>
                    <p className="font-semibold mt-1 truncate" title={k.targetingValue}>{k.targetingValue}</p>
                    <p className="text-muted-foreground mt-0.5 font-bold">Spend: {cur(k.spend, currency)} · Clicks: {k.clicks} · Orders: 0</p>
                    <p className="font-bold text-yellow-700 dark:text-yellow-500 mt-1.5">Action: Pause target or add negative exact keywords to stop bleeding.</p>
                  </div>
                ))}
                {scalingKeywords.slice(0, 2).map((k: any) => (
                  <div key={k.targetingValue + k.campaignName} className="p-3 rounded-xl border border-green-200 dark:border-green-900 bg-green-50/50 dark:bg-green-950/20 text-xs">
                    <p className="font-bold text-green-800 dark:text-green-400 flex items-center gap-1">🚀 High-Converting Scaler</p>
                    <p className="font-semibold mt-1 truncate" title={k.targetingValue}>{k.targetingValue}</p>
                    <p className="text-muted-foreground mt-0.5 font-bold">ROAS: {k.roas.toFixed(2)}x · Sales: {cur(k.sales, currency)}</p>
                    <p className="font-bold text-green-700 dark:text-green-500 mt-1.5">Action: Increase keyword bid by 10-15% to secure more top-of-search impressions.</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <DataTable data={keywords} columns={columns} defaultSort="spend" />
        </>
      )}
    </div>
  );
}
