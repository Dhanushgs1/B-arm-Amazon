"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDashboard } from "@/lib/DashboardContext";
import { mcp } from "@/lib/api";
import { exportToExcel } from "@/lib/excelExport";
import { DataTable } from "@/components/DataTable";
import { PageHero } from "@/components/PageHero";
import { KPICard } from "@/components/KPICard";
import { KpiDrilldownModal } from "@/components/KpiDrilldownModal";
import { AiSuggestionModal } from "@/components/AiSuggestionModal";
import { QueryErrorState } from "@/components/QueryErrorState";
import { Loader2, Bot, Rocket, AlertTriangle, Target } from "lucide-react";
import { cn } from "@/lib/utils";

const cur = (val: number, currency?: string) => {
  const sym = currency === "INR" ? "₹" : "$";
  if (!val) return `${sym}0`;
  return sym + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val));
};
const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));
const pct = (val: number) => `${(val || 0).toFixed(2)}%`;

export default function PlacementsPage() {
  const { keySlot, startDate, endDate, account, contextLoading, setSelectedCampaignName } = useDashboard();
  const [kpiModal, setKpiModal] = useState<{ title: string; data: any[] } | null>(null);
  const [aiModal, setAiModal] = useState(false);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["placements", keySlot, account?.id, startDate, endDate],
    queryFn: async () => {
      const res = await mcp("get_placement_performance", {
        amazon_account_id: account?.id,
        workspace_id: account?.workspace_id,
        start_date: startDate,
        end_date: endDate,
        page_size: 2000,
      }, keySlot);
      return res.placements || res.data || [];
    },
    enabled: !!account,
  });

  const currency = account?.currency;
  const rows = data || [];

  const columns = [
    {
      key: "placementClassification",
      label: "Placement Type",
      sortable: true,
      exportValue: (val: string, row: any) => val || row.placement || "—",
      render: (val: string, row: any) => {
        const type = val || row.placement || "—";
        let color = "text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800";
        if (type.toLowerCase().includes("top")) color = "text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/30";
        if (type.toLowerCase().includes("rest")) color = "text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/30";
        if (type.toLowerCase().includes("product")) color = "text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/30";
        
        return (
          <span className={cn("px-2 py-1 rounded-md text-xs font-bold whitespace-nowrap", color)}>
            {type}
          </span>
        );
      },
    },
    {
      key: "campaignName",
      label: "Campaign",
      sortable: true,
      render: (val: string) => (
        <button
          onClick={() => setSelectedCampaignName(val)}
          className="text-primary hover:underline text-xs block max-w-[280px] truncate text-left focus:outline-none font-semibold"
          title={val}
        >
          {val}
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
      render: (val: number) => <span className="font-semibold">{val ? val.toFixed(2) + 'x' : "—"}</span>,
    },
    { key: "impressions", label: "Impressions", sortable: true, render: (val: number) => num(val) },
    { key: "clicks", label: "Clicks", sortable: true, render: (val: number) => num(val) },
    { key: "orders", label: "Orders", sortable: true, render: (val: number) => num(val) },
    { key: "ctr", label: "CTR", sortable: true, render: (val: number) => val ? pct(val) : "—" },
    { key: "cpc", label: "CPC", sortable: true, render: (val: number) => cur(val, currency) },
  ];

  // Aggregates for KPI Cards
  const getAggregates = (placementStr: string) => {
    const filtered = rows.filter((r: any) => (r.placementClassification || r.placement || "").toLowerCase().includes(placementStr));
    const spend = filtered.reduce((a: number, b: any) => a + (b.spend || 0), 0);
    const sales = filtered.reduce((a: number, b: any) => a + (b.sales || 0), 0);
    const roas = spend > 0 ? (sales / spend) : 0;
    const acos = sales > 0 ? (spend / sales) * 100 : 0;
    return { spend, sales, roas, acos, rows: filtered };
  };

  const topSearch = getAggregates("top");
  const restSearch = getAggregates("rest");
  const productPages = getAggregates("product");
  
  const totalSpend = rows.reduce((a: number, b: any) => a + (b.spend || 0), 0);
  const topSpendShare = totalSpend > 0 ? (topSearch.spend / totalSpend) * 100 : 0;

  // AI Insights Winners & Bleeders
  const activePlacements = rows.filter((r: any) => r.spend > 0);
  const winners = activePlacements.filter((r: any) => r.roas > 4 && r.orders >= 2).sort((a: any, b: any) => b.sales - a.sales);
  const bleeders = activePlacements.filter((r: any) => r.acos > 40 && r.spend > 50).sort((a: any, b: any) => b.spend - a.spend);

  return (
    <div className="space-y-8 pb-12">
      {isError && (
        <QueryErrorState
          compact
          message="Placement data couldn't load — retry, or the numbers you see may be incomplete rather than genuinely zero."
          onRetry={() => refetch()}
        />
      )}

      <PageHero
        title="Placements Performance"
        subtitle="Analyze where your ads are showing, optimize bids for Top of Search, and improve ROAS using AI."
        workspace={account?.name?.split(" ").slice(0, 2).join(" ")}
        dateRange={`${startDate} → ${endDate}`}
        primaryAction="Generate AI Analysis"
        onPrimaryAction={() => setAiModal(true)}
        onRefresh={() => refetch()}
        onExport={() => exportToExcel(rows, columns as any, `placements-${startDate}-to-${endDate}`)}
        chips={[
          { label: "Tracked Placements", value: num(activePlacements.length) },
          { label: "Top Search Spend %", value: pct(topSpendShare) },
        ]}
      />

      {contextLoading || isLoading ? (
        <div className="flex h-[400px] items-center justify-center text-muted-foreground flex-col gap-4 glass rounded-[22px] border border-border">
          <Loader2 className="w-7 h-7 animate-spin text-primary" />
          <p className="font-semibold text-sm">{contextLoading ? "Connecting..." : "Loading Placements..."}</p>
        </div>
      ) : (
        <>
          {/* KPI Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            <KPICard 
              title="Top of Search" 
              value={`${topSearch.roas.toFixed(2)}x ROAS`} 
              subtitle={`ACOS: ${pct(topSearch.acos)} · Sales: ${cur(topSearch.sales, currency)}`} 
              accent="purple" 
              delay={0.05} 
              onClick={() => setKpiModal({ title: "Top of Search Performance", data: topSearch.rows })} 
            />
            <KPICard 
              title="Rest of Search" 
              value={`${restSearch.roas.toFixed(2)}x ROAS`} 
              subtitle={`ACOS: ${pct(restSearch.acos)} · Sales: ${cur(restSearch.sales, currency)}`} 
              accent="green" 
              delay={0.1} 
              onClick={() => setKpiModal({ title: "Rest of Search Performance", data: restSearch.rows })} 
            />
            <KPICard 
              title="Product Pages" 
              value={`${productPages.roas.toFixed(2)}x ROAS`} 
              subtitle={`ACOS: ${pct(productPages.acos)} · Sales: ${cur(productPages.sales, currency)}`} 
              accent="orange" 
              delay={0.15} 
              onClick={() => setKpiModal({ title: "Product Pages Performance", data: productPages.rows })} 
            />
          </div>

          <KpiDrilldownModal 
            isOpen={!!kpiModal} 
            onClose={() => setKpiModal(null)} 
            title={kpiModal?.title || ""} 
            data={kpiModal?.data || []} 
            columns={columns} 
          />

          <AiSuggestionModal
            isOpen={aiModal}
            onClose={() => setAiModal(false)}
            title="AI Placement Analysis"
            suggestions={[
              `Top of Search is driving ${pct(topSearch.sales / (topSearch.sales + restSearch.sales + productPages.sales || 1) * 100)} of your total placement sales.`,
              `${winners.length} specific placements have ROAS > 4x. Consider increasing bid modifiers (Top of Search / Product Pages) for these campaigns.`,
              `${bleeders.length} placements are bleeding with ACOS > 40%. Consider reducing placement modifiers or pausing underlying keywords.`
            ]}
          />

          {/* AI Insights */}
          {(winners.length > 0 || bleeders.length > 0) && (
            <div className="glass gradient-border rounded-[22px] p-6 space-y-4">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#6D5EF8] to-[#8B5CF6] flex items-center justify-center shadow-md shadow-indigo-500/20">
                  <Bot className="w-4.5 h-4.5 text-white" />
                </div>
                <div>
                  <h3 className="font-extrabold text-lg tracking-tight">AI Placement Insights</h3>
                  <p className="text-xs text-muted-foreground font-semibold">Bid modifier & budget opportunities detected from live data</p>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {winners.slice(0, 3).map((r: any, idx: number) => (
                  <div key={`win-${idx}`} className="p-4 rounded-2xl border border-emerald-200 dark:border-emerald-900 bg-gradient-to-br from-emerald-50/80 to-white dark:from-emerald-950/30 dark:to-transparent text-xs hover:-translate-y-0.5 transition-transform">
                    <p className="font-extrabold text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5 text-sm"><Rocket className="w-4 h-4" /> Winning {r.placementClassification || r.placement}</p>
                    <p className="font-bold mt-1.5 truncate text-[13px]" title={r.campaignName}>{r.campaignName}</p>
                    <p className="text-muted-foreground mt-1 font-bold">ROAS {r.roas.toFixed(2)}x · Sales {cur(r.sales, currency)}</p>
                    <p className="font-extrabold text-emerald-700 dark:text-emerald-500 mt-2">Increase {r.placementClassification || r.placement} modifier by +10–20%</p>
                  </div>
                ))}
                {bleeders.slice(0, 3).map((r: any, idx: number) => (
                  <div key={`bleed-${idx}`} className="p-4 rounded-2xl border border-red-200 dark:border-red-900 bg-gradient-to-br from-red-50/80 to-white dark:from-red-950/30 dark:to-transparent text-xs hover:-translate-y-0.5 transition-transform">
                    <p className="font-extrabold text-red-700 dark:text-red-400 flex items-center gap-1.5 text-sm"><AlertTriangle className="w-4 h-4" /> High ACOS on {r.placementClassification || r.placement}</p>
                    <p className="font-bold mt-1.5 truncate text-[13px]" title={r.campaignName}>{r.campaignName}</p>
                    <p className="text-muted-foreground mt-1 font-bold">ACOS {pct(r.acos)} · Spend {cur(r.spend, currency)}</p>
                    <p className="font-extrabold text-red-700 dark:text-red-500 mt-2">Reduce placement modifier or adjust base bids</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <DataTable data={rows} columns={columns} defaultSort="spend" exportName="placements" />
        </>
      )}
    </div>
  );
}
