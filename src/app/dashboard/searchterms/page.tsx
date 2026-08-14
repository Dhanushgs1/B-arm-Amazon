"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDashboard } from "@/lib/DashboardContext";
import { mcpAllPages } from "@/lib/api";
import { exportToExcel } from "@/lib/excelExport";
import { KpiDrilldownModal } from "@/components/KpiDrilldownModal";
import { AiSuggestionModal } from "@/components/AiSuggestionModal";
import { DataTable } from "@/components/DataTable";
import { KPICard } from "@/components/KPICard";
import { PageHero } from "@/components/PageHero";
import { QueryErrorState } from "@/components/QueryErrorState";
import { AcosBadge, ACOS_LIMIT, acosRowClass } from "@/components/AcosBadge";
import { Loader2, Search, AlertTriangle, Lightbulb, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";

const cur = (val: number, currency?: string) => {
  const sym = currency === "INR" ? "₹" : "$";
  if (!val) return `${sym}0`;
  return sym + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val));
};
const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));
const pct = (val: number) => `${(val || 0).toFixed(2)}%`;

export default function SearchTermsPage() {
  const { keySlot, startDate, endDate, account, contextLoading, setSelectedCampaignName } = useDashboard();
  const [kpiModal, setKpiModal] = useState<{ title: string; data: any[] } | null>(null);
  const [aiModal, setAiModal] = useState(false);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["searchterms", keySlot, account?.id, startDate, endDate],
    queryFn: async () => {
      return mcpAllPages("get_search_term_performance", {
        amazon_account_id: account?.id,
        workspace_id: account?.workspace_id,
        start_date: startDate,
        end_date: endDate,
        group_by: ["searchTerm", "campaignName", "adGroupName"],
      }, keySlot);
    },
    enabled: !!account,
  });

  const currency = account?.currency;

  const searchTerms = data || [];
  
  // Calculate Search Term KPIs
  const totalSearchTerms = searchTerms.length;
  const highAcosCount = searchTerms.filter((st: any) => st.acos > ACOS_LIMIT).length;
  const negativeCandidatesCount = searchTerms.filter((st: any) => st.orders === 0 && st.clicks > 10).length;
  const harvestCandidatesCount = searchTerms.filter((st: any) => st.roas > 4.5 && st.orders >= 2).length;
  const wastedSpend = searchTerms.reduce((acc: number, st: any) => st.orders === 0 ? acc + (st.spend || 0) : acc, 0);

  // Lists for insights
  const negativeKeywords = searchTerms.filter((st: any) => st.orders === 0 && st.clicks > 10)
    .sort((a: any, b: any) => b.clicks - a.clicks);
  const keywordHarvesting = searchTerms.filter((st: any) => st.roas > 4.5 && st.orders >= 2)
    .sort((a: any, b: any) => b.sales - a.sales);

  const columns = [
    {
      key: "searchTerm",
      label: "Search Term",
      sortable: true,
      render: (val: string) => (
        <span className="font-semibold text-foreground text-sm block max-w-[280px] truncate" title={val}>
          {val}
        </span>
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
          disabled={!val}
        >
          {val ? val.split("-").slice(0, 3).join("-") : "—"}
        </button>
      ),
    },
    {
      key: "adGroupName",
      label: "Ad Group",
      sortable: true,
      render: (val: string) => (
        <span className="text-xs font-semibold text-muted-foreground bg-muted px-2 py-0.5 rounded-md block max-w-[200px] whitespace-normal break-words leading-tight" title={val}>
          {val || "—"}
        </span>
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
      render: (val: number) => <AcosBadge value={val} />,
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
      {isError && (
        <QueryErrorState
          compact
          message="Search term data couldn't load — retry, or the numbers you see may be incomplete rather than genuinely zero."
          onRetry={() => refetch()}
        />
      )}

      <PageHero
        title="Search Terms Intelligence"
        subtitle="Analyze exactly what customers are searching for. Harvest winners and negate wasted spend instantly."
        workspace={account?.name?.split(" ").slice(0, 2).join(" ")}
        dateRange={`${startDate} → ${endDate}`}
        primaryAction="AI Search Term Report"
        onPrimaryAction={() => setAiModal(true)}
        onRefresh={() => refetch()}
        onExport={() => exportToExcel(searchTerms, columns as any, `searchterms-${startDate}-to-${endDate}`)}
        chips={[
          { label: "Wasted Spend", value: cur(wastedSpend, currency) },
          { label: "Harvest Opportunities", value: String(harvestCandidatesCount) },
          { label: "Negative Candidates", value: String(negativeCandidatesCount) },
        ]}
      />

      {contextLoading || isLoading ? (
        <div className="flex h-[400px] items-center justify-center text-muted-foreground flex-col gap-4 glass rounded-2xl border border-border">
          <Loader2 className="w-7 h-7 animate-spin text-primary" />
          <p className="font-semibold text-sm">{contextLoading ? "Connecting..." : "Loading Search Terms..."}</p>
        </div>
      ) : (
        <>
          {/* KPI Dashboard */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            <KPICard title="Total Search Terms" value={num(totalSearchTerms)} subtitle="Customer queries analyzed" delay={0.05} onClick={() => setKpiModal({ title: "Total Search Terms", data: searchTerms })} />
            <KPICard title="High ACOS Terms" value={num(highAcosCount)} subtitle={`ACOS > ${ACOS_LIMIT}% (marked red below)`} inverseTrend delay={0.08} onClick={() => setKpiModal({ title: "High ACOS Search Terms", data: searchTerms.filter((st: any) => st.acos > ACOS_LIMIT) })} />
            <KPICard title="Negative Candidates" value={num(negativeCandidatesCount)} subtitle="Clicks > 10 with zero sales" delay={0.1} onClick={() => setKpiModal({ title: "Negative Keyword Candidates", data: negativeKeywords })} />
            <KPICard title="New Keywords Found" value={num(harvestCandidatesCount)} subtitle="ROAS > 4.5x (ready to harvest)" delay={0.15} onClick={() => setKpiModal({ title: "Keyword Harvesting Candidates", data: keywordHarvesting })} />
            <KPICard title="Wasted Search Spend" value={cur(wastedSpend, currency)} subtitle="Spend on non-converting terms" inverseTrend delay={0.2} onClick={() => setKpiModal({ title: "Wasted Spend Terms", data: searchTerms.filter((st: any) => st.spend > 0 && st.orders === 0) })} />
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
            title="AI Search Term Insights"
            suggestions={[
              `Found ${harvestCandidatesCount} highly profitable search terms. Harvest these and launch them as Exact Match.`,
              `Found ${negativeCandidatesCount} negative candidates. Negate these to save ${cur(wastedSpend, currency)} in wasted spend.`,
              `Your clean queries percentage is ${pct((1 - (negativeCandidatesCount / totalSearchTerms)) * 100)}. Sweep negatives weekly to improve this.`
            ]}
          />

          {/* Actionable Alerts & Recommendations */}
          {(negativeKeywords.length > 0 || keywordHarvesting.length > 0) && (
            <div className="glass rounded-2xl border border-border p-5 shadow-sm space-y-3">
              <h3 className="font-bold text-sm flex items-center gap-2">
                <Search className="w-4 h-4 text-primary" /> Search Term Optimization Insights
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {negativeKeywords.slice(0, 2).map((st: any) => (
                  <div key={st.searchTerm + st.campaignName} className="p-3 rounded-xl border border-red-200 dark:border-red-900 bg-red-50/50 dark:bg-red-950/20 text-xs">
                    <p className="font-bold text-red-800 dark:text-red-400 flex items-center gap-1">🛑 Add Negative Exact Candidate</p>
                    <p className="font-semibold mt-1 truncate" title={st.searchTerm}>"{st.searchTerm}"</p>
                    <p className="text-muted-foreground mt-0.5 font-bold">Clicks: {st.clicks} · Spend: {cur(st.spend, currency)}</p>
                    <p className="font-bold text-red-700 dark:text-red-500 mt-1.5">Action: Add as Negative Exact to campaign "{st.campaignName ? st.campaignName.split("-").slice(0, 2).join("-") : ""}" to save spend.</p>
                  </div>
                ))}
                {keywordHarvesting.slice(0, 2).map((st: any) => (
                  <div key={st.searchTerm + st.campaignName} className="p-3 rounded-xl border border-green-200 dark:border-green-900 bg-green-50/50 dark:bg-green-950/20 text-xs">
                    <p className="font-bold text-green-800 dark:text-green-400 flex items-center gap-1">🌱 Keyword Harvesting Opportunity</p>
                    <p className="font-semibold mt-1 truncate" title={st.searchTerm}>"{st.searchTerm}"</p>
                    <p className="text-muted-foreground mt-0.5 font-bold">ROAS: {st.roas.toFixed(2)}x · Orders: {st.orders} · Sales: {cur(st.sales, currency)}</p>
                    <p className="font-bold text-green-700 dark:text-green-500 mt-1.5">Action: Extract search term and launch as Exact Match keyword in target campaign.</p>
                  </div>
                ))}
                {negativeCandidatesCount > 0 && (
                  <div className="p-3 rounded-xl border border-yellow-200 dark:border-yellow-900 bg-yellow-50/50 dark:bg-yellow-950/20 text-xs flex flex-col justify-between">
                    <div>
                      <p className="font-bold text-yellow-800 dark:text-yellow-400 flex items-center gap-1">📊 Search Terms Quality</p>
                      <p className="font-semibold mt-1">{pct((1 - (negativeCandidatesCount / totalSearchTerms)) * 100)} Clean Queries</p>
                      <p className="text-muted-foreground mt-0.5">{negativeCandidatesCount} unqualified terms found.</p>
                    </div>
                    <p className="font-bold text-yellow-700 dark:text-yellow-500 mt-1.5">Action: Run negative keywords sweep weekly.</p>
                  </div>
                )}
              </div>
            </div>
          )}

          <DataTable data={searchTerms} columns={columns} defaultSort="spend" rowClassName={acosRowClass} exportName="search-terms" />
        </>
      )}
    </div>
  );
}
