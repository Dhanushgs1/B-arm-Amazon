"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDashboard } from "@/lib/DashboardContext";
import { mcp } from "@/lib/api";
import { exportToExcel } from "@/lib/excelExport";
import { KpiDrilldownModal } from "@/components/KpiDrilldownModal";
import { AiSuggestionModal } from "@/components/AiSuggestionModal";
import { DataTable } from "@/components/DataTable";
import { KPICard } from "@/components/KPICard";
import { PageHero } from "@/components/PageHero";
import { QueryErrorState } from "@/components/QueryErrorState";
import { Loader2, Bot, LayoutGrid, Rocket, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

const cur = (val: number, currency?: string) => {
  const sym = currency === "INR" ? "₹" : "$";
  if (!val) return `${sym}0`;
  return sym + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val));
};
const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));
const pct = (val: number) => `${(val || 0).toFixed(2)}%`;

// Heuristic: detect Manual vs Automatic targeting from campaign naming
const targetingType = (name: string) =>
  /auto/i.test(name || "") ? "Automatic" : "Manual";

const agScore = (r: any) => {
  if (!r.spend) return 50;
  let score = 55 + Math.min(30, (r.roas || 0) * 5) - Math.min(35, Math.max(0, (r.acos || 0) - 20) * 0.8);
  if (r.orders === 0 && r.spend > 100) score -= 20;
  return Math.max(5, Math.min(99, Math.round(score)));
};
const healthColor = (score: number) =>
  score >= 75 ? "bg-emerald-500" : score >= 55 ? "bg-blue-500" : score >= 35 ? "bg-amber-500" : "bg-red-500";

export default function AdGroupsPage() {
  const { keySlot, startDate, endDate, account, contextLoading, setSelectedCampaignName } = useDashboard();
  const [kpiModal, setKpiModal] = useState<{ title: string; data: any[] } | null>(null);
  const [aiModal, setAiModal] = useState(false);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["adgroups", keySlot, account?.id, startDate, endDate],
    queryFn: async () => {
      const res = await mcp("get_campaign_performance", {
        amazon_account_id: account?.id,
        workspace_id: account?.workspace_id,
        start_date: startDate,
        end_date: endDate,
        page_size: 2000,
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

  const { data: catalogData } = useQuery({
    queryKey: ["catalog_adgroups", keySlot, account?.id],
    queryFn: async () => {
      const res = await mcp("list_product_catalog", {
        amazon_account_id: account?.id,
        workspace_id: account?.workspace_id,
        limit: 200,
      }, keySlot);
      return res.products || [];
    },
    enabled: !!account,
  });

  const currency = account?.currency;
  const rows: any[] = data || [];

  const campaignToSkus = useMemo(() => {
    const map: Record<string, string[]> = {};
    const prods = catalogData || [];
    
    // Keyword helper
    const categorizeTitle = (title: string) => {
      const t = (title || "").toLowerCase();
      if (/insemination|gynec|foley|cervical|fertility|pregnancy|ovulation|iui|ivi/i.test(t)) return "Gynaecology";
      if (/nebulizer|oxygen|resp|asthma|copd|breathe|breathing/i.test(t)) return "Pulmonology";
      if (/chewy|speech|tongue|autism|sensory|fidget|chew/i.test(t)) return "Occupational Therapy";
      return "General";
    };

    const getCampaignCategory = (cName: string) => {
      const n = (cName || "").toLowerCase();
      if (/insemination|gynec|foley|cervical|fertility|pregnancy|ovulation|iui|ivi/i.test(n)) return "Gynaecology";
      if (/nebulizer|oxygen|resp|asthma|copd|breathe|breathing/i.test(n)) return "Pulmonology";
      if (/chewy|speech|tongue|autism|sensory|fidget|chew/i.test(n)) return "Occupational Therapy";
      return "General";
    };

    for (const c of rows) {
      const cName = c.campaignName || c.name || "";
      if (!cName || map[cName]) continue;

      const cNameLower = cName.toLowerCase();
      const keywords = cNameLower
        .replace(/[-_]/g, " ")
        .split(/\s+/)
        .filter((k: string) => k.length > 2 && !["new", "ads", "auto", "fixed", "brand", "manual", "test", "kit", "pack"].includes(k));

      const matched = prods.filter((p: any) => {
        const itemName = (p.itemName || "").toLowerCase();
        const sku = (p.sku || "").toLowerCase();
        return keywords.some((k: string) => itemName.includes(k) || sku.includes(k));
      });

      const skus: string[] = [];
      if (matched.length > 0) {
        matched.forEach((p: any) => {
          if (p.sku && !skus.includes(p.sku)) skus.push(p.sku);
        });
      } else {
        const category = getCampaignCategory(cName);
        prods.filter((p: any) => categorizeTitle(p.itemName) === category)
          .slice(0, 1)
          .forEach((p: any) => {
            if (p.sku) skus.push(p.sku);
          });
      }

      map[cName] = skus.slice(0, 2);
    }

    return map;
  }, [catalogData, rows]);

  // KPI aggregates
  const activeCount = rows.filter((r) => r.spend > 0).length;
  const highRoas = rows.filter((r) => r.roas > 5).length;
  const highAcos = rows.filter((r) => r.acos > 40 && r.spend > 100).length;
  const totalSpend = rows.reduce((a, r) => a + (r.spend || 0), 0);
  const totalClicks = rows.reduce((a, r) => a + (r.clicks || 0), 0);
  const totalImpr = rows.reduce((a, r) => a + (r.impressions || 0), 0);
  const avgCpc = totalClicks ? totalSpend / totalClicks : 0;
  const avgCtr = totalImpr ? (totalClicks / totalImpr) * 100 : 0;
  const avgScore = rows.length ? Math.round(rows.filter((r) => r.spend > 0).reduce((a, r) => a + agScore(r), 0) / Math.max(1, activeCount)) : 0;

  const winners = rows.filter((r) => r.roas > 5 && r.orders >= 3).sort((a, b) => b.sales - a.sales);
  const bleeders = rows.filter((r) => r.acos > 50 && r.spend > 100).sort((a, b) => b.spend - a.spend);

  const columns = [
    {
      key: "adGroupName",
      label: "Ad Group",
      sortable: true,
      exportValue: (val: any, row: any) => {
        const skus = campaignToSkus[row.campaignName] || [];
        return row.campaignName + (skus.length ? ` [SKUs: ${skus.join(", ")}]` : "");
      },
      render: (val: string, row: any) => {
        const score = agScore(row);
        const type = targetingType(row.campaignName);
        return (
          <div className="flex items-center gap-2.5 max-w-[320px]">
            <div className="w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/15 flex items-center justify-center flex-shrink-0">
              <LayoutGrid className="w-3.5 h-3.5 text-blue-500" />
            </div>
            <div className="min-w-0">
              <button
                onClick={() => setSelectedCampaignName(row.campaignName)}
                className="font-bold text-foreground hover:text-primary hover:underline text-sm block max-w-[250px] truncate text-left focus:outline-none"
                title={row.campaignName}
              >
                {row.campaignName}
              </button>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className={cn(
                  "text-[10px] font-extrabold px-1.5 py-px rounded-full",
                  type === "Automatic" ? "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400" : "bg-indigo-500/10 text-indigo-500"
                )}>
                  {type}
                </span>
                <span className={cn("text-[10px] font-extrabold px-1.5 py-px rounded-full text-white", healthColor(score))}>
                  AI {score}
                </span>
                {(() => {
                  const skus = campaignToSkus[row.campaignName] || [];
                  if (!skus.length) return <span className="text-[10px] text-muted-foreground/60">SKU: —</span>;
                  return (
                    <span className="text-[10px] font-black bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 px-1.5 py-0.5 rounded whitespace-nowrap" title={skus.join(", ")}>
                      SKU: {skus.join(", ")}
                    </span>
                  );
                })()}
              </div>
            </div>
          </div>
        );
      },
    },
    {
      key: "spend",
      label: "Spend",
      sortable: true,
      render: (val: number) => <span className="font-bold text-foreground">{cur(val, currency)}</span>,
    },
    {
      key: "sales",
      label: "Sales",
      sortable: true,
      render: (val: number) => <span className="text-emerald-600 dark:text-emerald-400 font-extrabold">{cur(val, currency)}</span>,
    },
    {
      key: "acos",
      label: "ACOS",
      sortable: true,
      render: (val: number) => (
        <span className={cn("px-2 py-0.5 rounded-full text-xs font-extrabold", val && val < 20 ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : val && val > 40 ? "bg-red-500/10 text-red-700 dark:text-red-400" : "bg-amber-500/10 text-amber-700 dark:text-amber-400")}>
          {val ? pct(val) : "—"}
        </span>
      ),
    },
    {
      key: "roas",
      label: "ROAS",
      sortable: true,
      render: (val: number) => (
        <span className={cn(
          "px-2 py-0.5 rounded-full text-xs font-extrabold",
          val > 5 ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : val > 3 ? "bg-blue-500/10 text-blue-600 dark:text-blue-400" : val > 0 ? "bg-amber-500/10 text-amber-600 dark:text-amber-400" : "text-muted-foreground"
        )}>
          {val ? `${val.toFixed(2)}x` : "—"}
        </span>
      ),
    },
    { key: "impressions", label: "Impressions", sortable: true, render: (val: number) => num(val) },
    { key: "clicks", label: "Clicks", sortable: true, render: (val: number) => num(val) },
    { key: "orders", label: "Orders", sortable: true, render: (val: number) => num(val) },
    { key: "ctr", label: "CTR", sortable: true, render: (val: number) => val ? pct(val) : "—" },
    { key: "cpc", label: "CPC", sortable: true, render: (val: number) => cur(val, currency) },
  ];

  return (
    <div className="space-y-8 pb-12">
      {isError && (
        <QueryErrorState
          compact
          message="Ad group data couldn't load — retry, or the numbers you see may be incomplete rather than genuinely zero."
          onRetry={() => refetch()}
        />
      )}

      <PageHero
        title="Ad Groups Performance"
        subtitle="Monitor every ad group, optimize bids, improve ROAS and maximize sales using AI."
        workspace={account?.name?.split(" ").slice(0, 2).join(" ")}
        dateRange={`${startDate} → ${endDate}`}
        primaryAction="Generate AI Analysis"
        onPrimaryAction={() => setAiModal(true)}
        onRefresh={() => refetch()}
        onExport={() => exportToExcel(rows, columns as any, `adgroups-${startDate}-to-${endDate}`)}
        chips={[
          { label: "AI Optimization Score", value: `${avgScore}/100` },
          { label: "Active Ad Groups", value: num(activeCount) },
          { label: "Avg CPC", value: cur(avgCpc, currency) },
          { label: "Avg CTR", value: pct(avgCtr) },
        ]}
      />

      {contextLoading || isLoading ? (
        <div className="flex h-[400px] items-center justify-center text-muted-foreground flex-col gap-4 glass rounded-[22px] border border-border">
          <Loader2 className="w-7 h-7 animate-spin text-primary" />
          <p className="font-semibold text-sm">{contextLoading ? "Connecting..." : "Loading Ad Groups..."}</p>
        </div>
      ) : (
        <>
          {/* KPI Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            <KPICard title="Active Ad Groups" value={num(activeCount)} subtitle="With spend in range" accent="blue" delay={0.05} onClick={() => setKpiModal({ title: "Active Ad Groups", data: rows.filter((r: any) => r.spend > 0) })} />
            <KPICard title="High ROAS" value={num(highRoas)} subtitle="ROAS > 5x — scale candidates" accent="green" delay={0.1} onClick={() => setKpiModal({ title: "High ROAS Ad Groups", data: rows.filter((r: any) => r.roas > 5) })} />
            <KPICard title="High ACOS" value={num(highAcos)} subtitle="ACOS > 40% — needs attention" accent="pink" inverseTrend delay={0.15} onClick={() => setKpiModal({ title: "High ACOS Ad Groups", data: rows.filter((r: any) => r.acos > 40 && r.spend > 100) })} />
            <KPICard title="Average CPC" value={cur(avgCpc, currency)} subtitle="Across all ad groups" accent="purple" delay={0.2} />
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
            title="AI Ad Group Analysis"
            suggestions={[
              `We found ${highRoas} ad groups with ROAS > 5x. Consider increasing their default bids by 15% to scale.`,
              `${highAcos} ad groups are bleeding (ACOS > 40%). Reduce bids or pause entirely.`,
              `Your average CPC is ${cur(avgCpc, currency)}. Optimizing bids on low-converting ad groups can lower this average significantly.`
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
                  <h3 className="font-extrabold text-lg tracking-tight">AI Ad Group Insights</h3>
                  <p className="text-xs text-muted-foreground font-semibold">Bid & budget opportunities detected from live data</p>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {winners.slice(0, 3).map((r: any) => (
                  <div key={r.adGroupId} className="p-4 rounded-2xl border border-emerald-200 dark:border-emerald-900 bg-gradient-to-br from-emerald-50/80 to-white dark:from-emerald-950/30 dark:to-transparent text-xs hover:-translate-y-0.5 transition-transform">
                    <p className="font-extrabold text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5 text-sm"><Rocket className="w-4 h-4" /> Winning Ad Group</p>
                    <p className="font-bold mt-1.5 truncate text-[13px]" title={r.campaignName}>{r.campaignName}</p>
                    <p className="text-muted-foreground mt-1 font-bold">ROAS {r.roas.toFixed(2)}x · Sales {cur(r.sales, currency)}</p>
                    <p className="font-extrabold text-emerald-700 dark:text-emerald-500 mt-2">Raise bids +10–15% to capture volume</p>
                  </div>
                ))}
                {bleeders.slice(0, 3).map((r: any) => (
                  <div key={r.adGroupId} className="p-4 rounded-2xl border border-red-200 dark:border-red-900 bg-gradient-to-br from-red-50/80 to-white dark:from-red-950/30 dark:to-transparent text-xs hover:-translate-y-0.5 transition-transform">
                    <p className="font-extrabold text-red-700 dark:text-red-400 flex items-center gap-1.5 text-sm"><AlertTriangle className="w-4 h-4" /> High ACOS</p>
                    <p className="font-bold mt-1.5 truncate text-[13px]" title={r.campaignName}>{r.campaignName}</p>
                    <p className="text-muted-foreground mt-1 font-bold">ACOS {pct(r.acos)} · Spend {cur(r.spend, currency)}</p>
                    <p className="font-extrabold text-red-700 dark:text-red-500 mt-2">Reduce bids & review search terms for negatives</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <DataTable data={rows} columns={columns} defaultSort="spend" exportName="adgroups" />
        </>
      )}
    </div>
  );
}
