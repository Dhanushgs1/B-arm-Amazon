"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDashboard } from "@/lib/DashboardContext";
import { mcp, mcpAllPages, fetchSkuMap } from "@/lib/api";
import { fetchMissingCampaignHistory, injectMissingCampaignsAsPaused } from "@/lib/campaignPersistence";
import { exportToExcel } from "@/lib/excelExport";
import { KpiDrilldownModal } from "@/components/KpiDrilldownModal";
import { AiSuggestionModal } from "@/components/AiSuggestionModal";
import { DataTable } from "@/components/DataTable";
import { KPICard } from "@/components/KPICard";
import { PageHero } from "@/components/PageHero";
import { QueryErrorState } from "@/components/QueryErrorState";
import { AcosBadge, ACOS_LIMIT, acosRowClass } from "@/components/AcosBadge";
import { Loader2, Megaphone, Bot, Rocket, AlertTriangle, TrendingDown, Trophy, Zap, Plus, X, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

const cur = (val: number, currency?: string) => {
  const sym = currency === "INR" ? "₹" : "$";
  if (!val) return `${sym}0`;
  return sym + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val));
};
const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));
const pct = (val: number) => `${(val || 0).toFixed(2)}%`;

// Deterministic AI score per campaign from live metrics
const aiScore = (c: any) => {
  if (!c.spend) return 50;
  let score = 55;
  score += Math.min(30, (c.roas || 0) * 5);
  score -= Math.min(35, Math.max(0, (c.acos || 0) - 20) * 0.8);
  if (c.orders === 0 && c.spend > 100) score -= 20;
  return Math.max(5, Math.min(99, Math.round(score)));
};

const healthColor = (score: number) =>
  score >= 75 ? "bg-emerald-500" : score >= 55 ? "bg-blue-500" : score >= 35 ? "bg-amber-500" : "bg-red-500";

export default function CampaignsPage() {
  const { keySlot, startDate, endDate, account, contextLoading, setSelectedCampaignName } = useDashboard();

  const [customSkus, setCustomSkus] = useState<Record<string, string[]>>({});
  const [kpiModal, setKpiModal] = useState<{ title: string; data: any[] } | null>(null);
  const [aiModal, setAiModal] = useState(false);

  const handleAddSku = (campaignName: string) => {
    const sku = prompt(`Enter SKU ID to add to campaign "${campaignName}":`);
    if (sku && sku.trim()) {
      const trimmed = sku.trim();
      setCustomSkus(prev => {
        const currentList = prev[campaignName] || [];
        if (currentList.includes(trimmed)) return prev;
        return {
          ...prev,
          [campaignName]: [...currentList, trimmed]
        };
      });
    }
  };

  const [aiBreakdown, setAiBreakdown] = useState<any>(null);

  // Paused-campaign "why paused + reactivation estimate" AI insight. Lazily
  // pulls a 90-day performance snapshot (the paused campaign's own current-period
  // metrics are 0, so there's nothing to reason from without looking back further)
  // the first time any paused row is asked for an insight, then reuses it for
  // every other paused row clicked afterward instead of re-fetching per row.
  const [pausedAiModal, setPausedAiModal] = useState<{ title: string; suggestions: string[] } | null>(null);
  const [pausedInsightLoading, setPausedInsightLoading] = useState<string | null>(null);
  const [history90, setHistory90] = useState<any[] | null>(null);

  const fetchHistory90 = async (): Promise<any[]> => {
    if (history90) return history90;
    const end = endDate || new Date().toISOString().slice(0, 10);
    const start = new Date(end);
    start.setDate(start.getDate() - 90);
    const res = await mcp("get_campaign_performance", {
      amazon_account_id: account?.id,
      workspace_id: account?.workspace_id,
      start_date: start.toISOString().slice(0, 10),
      end_date: end,
      page_size: 2000,
    }, keySlot);
    const data = res.data || [];
    setHistory90(data);
    return data;
  };

  const handlePausedAiInsight = async (row: any) => {
    setPausedInsightLoading(row.campaignId);
    const sym = currency === "INR" ? "₹" : "$";
    try {
      const hist = await fetchHistory90();
      const h = hist.find((p: any) => p.campaignId === row.campaignId);
      const histSpend = Math.round(h?.spend || 0);
      const histSales = Math.round(h?.sales || 0);
      const histAcos = Math.round(h?.acos || 0);
      const histRoas = h?.roas || 0;
      const histOrders = h?.orders || 0;
      const histClicks = h?.clicks || 0;

      if (!histSpend) {
        setPausedAiModal({
          title: `${row.campaignName} — Paused`,
          suggestions: [
            "No spend recorded for this campaign in the last 90 days either — it's likely been paused a long time or never ran meaningfully. Reactivating it would be starting fresh, with no recent performance to estimate from.",
          ],
        });
        return;
      }

      const weeks = 90 / 7;
      const weeklySpend = Math.round(histSpend / weeks);
      const weeklySales = Math.round(histSales / weeks);

      let reason = "";
      let estimate = "";
      try {
        const prompt =
          `You are an Amazon Ads PPC analyst. A seller is deciding whether to reactivate a PAUSED campaign. ` +
          `Here is its last known performance from the trailing 90 days before today, while it was still running:\n` +
          `Campaign "${row.campaignName}": spend ${sym}${histSpend}, sales ${sym}${histSales}, ACOS ${histAcos}%, ROAS ${histRoas.toFixed(2)}x, ${histOrders} orders, ${histClicks} clicks over ~90 days (~${sym}${weeklySpend}/week spend, ~${sym}${weeklySales}/week sales run-rate).\n\n` +
          `Return ONLY a JSON object, no markdown fences, of this exact shape:\n` +
          `{"reason":"<1-2 sentences on the most likely reason this campaign was paused, inferred from the numbers above. Say 'likely' since the real reason isn't recorded anywhere.>",` +
          `"estimate":"<1-2 sentences estimating weekly spend/sales if reactivated at the same level, based on the historical run-rate above. Hedge it as an estimate, not a guarantee.>"}`;
        const r = await fetch("/api/gemini-insights", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt }),
        });
        if (r.ok) {
          const j = await r.json();
          if (j.text) {
            const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(j.text as string);
            const parsed = JSON.parse(fenced ? fenced[1] : j.text);
            reason = parsed?.reason || "";
            estimate = parsed?.estimate || "";
          }
        }
      } catch {
        // fall through to the rule-based lines below
      }

      if (!reason) {
        reason =
          histOrders === 0 && histSpend > 100
            ? `Likely paused for wasted spend — ${sym}${histSpend} spent over ~90 days with zero orders.`
            : histAcos >= 60
            ? `Likely paused for high ACOS — ${histAcos}% is well above a healthy range and was eating into margin.`
            : `Paused for a reason not recorded in the data — its last known numbers (${histAcos}% ACOS, ${histOrders} orders) don't show an obvious red flag.`;
      }
      if (!estimate) {
        estimate = `Based on its ~90-day run-rate, reactivating at the same spend could bring back roughly ${sym}${weeklySpend}/week in spend and ${sym}${weeklySales}/week in sales — a rough estimate, not a guarantee, since conditions may have changed since it ran.`;
      }

      setPausedAiModal({ title: `${row.campaignName} — Reactivation Insight`, suggestions: [reason, estimate] });
    } catch (err) {
      setPausedAiModal({
        title: `${row.campaignName} — Reactivation Insight`,
        suggestions: [`Couldn't generate an insight: ${err instanceof Error ? err.message : String(err)}`],
      });
    } finally {
      setPausedInsightLoading(null);
    }
  };

  const handleOpenBreakdown = (row: any) => {
    const name = row.campaignName;
    const score = aiScore(row);
    const spend = row.spend || 0;
    const roas = row.roas || 0;
    const acos = row.acos || 0;
    const orders = row.orders || 0;

    if (!spend) {
      setAiBreakdown({
        name,
        score: 50,
        base: 50,
        roas: 0,
        roasBonus: 0,
        acos: 0,
        acosPenalty: 0,
        wastedPenalty: 0,
      });
      return;
    }

    const base = 55;
    const roasBonus = Math.min(30, roas * 5);
    const acosPenalty = Math.min(35, Math.max(0, acos - 20) * 0.8);
    const wastedPenalty = (orders === 0 && spend > 100) ? 20 : 0;

    setAiBreakdown({
      name,
      score,
      base,
      roas,
      roasBonus,
      acos,
      acosPenalty,
      wastedPenalty,
    });
  };

  const { data: performanceData, isLoading: perfLoading, isError: perfError, refetch } = useQuery({
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

  const { data: campaignList, isLoading: listLoading, isError: listError, refetch: refetchCampaignList } = useQuery({
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

  // Map each campaign to the SKUs it advertises: advertised-product report gives
  // campaign -> ASINs, and the product catalog gives ASIN -> SKUs.
  const { data: campaignSkus } = useQuery({
    queryKey: ["campaigns_skus", keySlot, account?.id, startDate, endDate],
    queryFn: async () => {
      const baseArgs = {
        amazon_account_id: account?.id,
        workspace_id: account?.workspace_id,
      };
      const [adProducts, skuMap] = await Promise.all([
        mcpAllPages("get_advertised_product_performance", {
          ...baseArgs,
          start_date: startDate,
          end_date: endDate,
          group_by: ["campaignName", "adAsin"],
        }, keySlot),
        fetchSkuMap(baseArgs, keySlot),
      ]);
      const byCampaign: Record<string, string[]> = {};
      for (const row of adProducts) {
        if (!row.campaignName || !row.adAsin) continue;
        const labels = skuMap[row.adAsin]?.length ? skuMap[row.adAsin] : [row.adAsin];
        if (!byCampaign[row.campaignName]) byCampaign[row.campaignName] = [];
        for (const label of labels) {
          if (!byCampaign[row.campaignName].includes(label)) byCampaign[row.campaignName].push(label);
        }
      }
      return byCampaign;
    },
    enabled: !!account,
  });

  // Campaigns absent from today's live list_campaigns pull but present in prior daily
  // snapshots — re-added as Paused so a transient API gap (or a genuine pause) never just
  // drops the campaign off the dashboard. See campaignPersistence.ts / campaignStateTracker.ts.
  const { data: missingHistory } = useQuery({
    queryKey: ["campaigns_missing_history", keySlot],
    queryFn: () => fetchMissingCampaignHistory(keySlot),
    enabled: !!account,
    staleTime: 5 * 60 * 1000,
  });

  const isLoading = perfLoading || listLoading;
  const currency = account?.currency;

  const liveList = Array.isArray(campaignList) ? campaignList : (campaignList as any)?.campaigns || [];
  const rawList = injectMissingCampaignsAsPaused(liveList, missingHistory || []);

  const campaigns = (rawList || []).map((meta: any) => {
    const perf = (performanceData || []).find((p: any) => p.campaignId === meta.campaignId);
    const name = meta.name || meta.campaignName || perf?.campaignName || "Unnamed Campaign";
    const fetched = campaignSkus?.[name] || [];
    const custom = customSkus[name] || [];
    const combined = Array.from(new Set([...fetched, ...custom]));
    return {
      campaignId: meta.campaignId,
      campaignName: name,
      skuList: combined.join(", "),
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
  const highAcosCount = campaigns.filter((c: any) => c.state?.toUpperCase() === "ENABLED" && c.acos > ACOS_LIMIT).length;
  const topRoasCount = campaigns.filter((c: any) => c.state?.toUpperCase() === "ENABLED" && c.roas > 5).length;
  const wastedSpend = campaigns.reduce((acc: number, c: any) => c.orders === 0 ? acc + (c.spend || 0) : acc, 0);
  const totalSpend = campaigns.reduce((acc: number, c: any) => acc + (c.spend || 0), 0);
  const totalSales = campaigns.reduce((acc: number, c: any) => acc + (c.sales || 0), 0);

  // Aggregate optimization score
  const avgAiScore = campaigns.length
    ? Math.round(campaigns.filter((c: any) => c.spend > 0).reduce((a: number, c: any) => a + aiScore(c), 0) / Math.max(1, campaigns.filter((c: any) => c.spend > 0).length))
    : 0;

  // Lists for insights
  const bleedingCampaigns = campaigns.filter((c: any) => c.state?.toUpperCase() === "ENABLED" && c.acos > 50 && c.spend > 100);
  const zeroOrderWasted = campaigns.filter((c: any) => c.state?.toUpperCase() === "ENABLED" && c.orders === 0 && c.spend > 100)
    .sort((a: any, b: any) => b.spend - a.spend);
  const scaleCampaigns = campaigns.filter((c: any) => c.state?.toUpperCase() === "ENABLED" && c.roas > 5 && c.orders >= 5)
    .sort((a: any, b: any) => b.sales - a.sales);

  const expectedRevenueIncrease = scaleCampaigns.slice(0, 3).reduce((a: number, c: any) => a + c.sales * 0.18, 0);

  const [statusFilter, setStatusFilter] = useState<"ALL" | "ENABLED" | "PAUSED">("ALL");

  const filteredCampaigns = campaigns.filter((c: any) => {
    if (statusFilter === "ALL") return true;
    return c.state?.toUpperCase() === statusFilter;
  });

  const columns = [
    {
      key: "campaignName",
      label: "Campaign",
      sortable: true,
      render: (val: string, row: any) => {
        const score = aiScore(row);
        return (
          <div className="flex items-center gap-2.5 max-w-[300px]">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/15 flex items-center justify-center flex-shrink-0">
              <Megaphone className="w-3.5 h-3.5 text-indigo-500" />
            </div>
            <div className="min-w-0">
              <button
                onClick={() => setSelectedCampaignName(val)}
                className="font-bold text-primary hover:underline text-left truncate text-sm block max-w-[240px] focus:outline-none"
                title={val}
              >
                {val}
              </button>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className={cn("w-1.5 h-1.5 rounded-full flex-shrink-0", row.state?.toUpperCase() === "ENABLED" ? "bg-emerald-500" : "bg-amber-500")} />
                <span className="text-[10px] font-bold text-muted-foreground uppercase">{row.state?.toLowerCase()}</span>
                {row.state?.toUpperCase() === "PAUSED" ? (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handlePausedAiInsight(row);
                    }}
                    disabled={pausedInsightLoading === row.campaignId}
                    className="text-[10px] font-extrabold pl-1.5 pr-2 py-px rounded-full text-white flex-shrink-0 transition-all active:scale-95 hover:brightness-110 focus:outline-none cursor-pointer bg-indigo-500 flex items-center gap-1 disabled:opacity-60"
                    title="AI: why this was likely paused + reactivation estimate"
                  >
                    {pausedInsightLoading === row.campaignId ? (
                      <Loader2 className="w-2.5 h-2.5 animate-spin" />
                    ) : (
                      <Sparkles className="w-2.5 h-2.5" />
                    )}
                    AI Insight
                  </button>
                ) : (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleOpenBreakdown(row);
                    }}
                    className={cn(
                      "text-[10px] font-extrabold px-1.5 py-px rounded-full text-white flex-shrink-0 transition-all active:scale-95 hover:brightness-110 focus:outline-none cursor-pointer",
                      healthColor(score)
                    )}
                    title="Click to view AI score breakdown"
                  >
                    AI {score}
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      },
    },
    {
      key: "skuList",
      label: "Products (SKU)",
      sortable: true,
      render: (val: string, row: any) => {
        const skus = val ? val.split(", ").filter(Boolean) : [];
        return (
          <div className="flex flex-wrap items-center gap-1.5 max-w-[340px]">
            {skus.map((sku) => (
              <span key={sku} className="inline-flex items-center gap-1.5 font-mono text-[11px] font-extrabold bg-slate-800/90 border border-slate-700 px-2.5 py-0.5 rounded-full text-slate-100 shadow-sm whitespace-nowrap">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0 animate-pulse" />
                {sku}
              </span>
            ))}
            <button
              onClick={() => handleAddSku(row.campaignName)}
              className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-500/10 border border-indigo-500/20 hover:bg-indigo-500/20 hover:border-indigo-500/30 text-indigo-400 hover:text-indigo-300 transition-colors focus:outline-none flex-shrink-0"
              title="Add SKU to campaign"
            >
              <Plus className="w-3 h-3" />
            </button>
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
      render: (val: number) => <AcosBadge value={val} />,
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
      {(perfError || listError) && (
        <QueryErrorState
          compact
          message="Campaign performance or campaign list data couldn't load — retry, or the metrics/campaigns you see may be incomplete rather than genuinely empty."
          onRetry={() => { refetch(); refetchCampaignList(); }}
        />
      )}

      <PageHero
        title="Campaign Performance"
        subtitle="Manage every campaign, spot wasted spend, and scale winners with AI-powered recommendations."
        workspace={account?.name?.split(" ").slice(0, 2).join(" ")}
        dateRange={`${startDate} → ${endDate}`}
        primaryAction="Generate AI Report"
        onPrimaryAction={() => setAiModal(true)}
        onRefresh={() => refetch()}
        onExport={() => exportToExcel(campaigns, columns as any, `campaigns-${startDate}-to-${endDate}`)}
        chips={[
          { label: "AI Optimization Score", value: `${avgAiScore}/100` },
          { label: "Campaign Health", value: `${activeCampaigns - highAcosCount}/${activeCampaigns} healthy` },
          { label: "Ad Spend", value: cur(totalSpend, currency) },
          { label: "Revenue", value: cur(totalSales, currency) },
        ]}
      />

      {contextLoading || isLoading ? (
        <div className="flex h-[400px] items-center justify-center text-muted-foreground flex-col gap-4 glass rounded-[22px] border border-border">
          <Loader2 className="w-7 h-7 animate-spin text-primary" />
          <p className="font-semibold text-sm">{contextLoading ? "Connecting..." : "Loading Campaigns..."}</p>
        </div>
      ) : (
        <>
          {/* KPI Dashboard */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            <KPICard title="Active Campaigns" value={num(activeCampaigns)} subtitle="Currently running" accent="blue" delay={0.05} onClick={() => setKpiModal({ title: "Active Campaigns", data: campaigns.filter((c: any) => c.state?.toUpperCase() === 'ENABLED') })} />
            <KPICard title="High ACOS" value={num(highAcosCount)} subtitle={`ACOS > ${ACOS_LIMIT}% — needs attention`} accent="pink" inverseTrend delay={0.1} onClick={() => setKpiModal({ title: "High ACOS Campaigns", data: campaigns.filter((c: any) => (c.acos || 0) > ACOS_LIMIT) })} />
            <KPICard title="High ROAS" value={num(topRoasCount)} subtitle="ROAS > 5x — ready to scale" accent="green" delay={0.15} onClick={() => setKpiModal({ title: "High ROAS Campaigns", data: campaigns.filter((c: any) => (c.roas || 0) > 5) })} />
            <KPICard title="Wasted Spend" value={cur(wastedSpend, currency)} subtitle="Spend with zero orders" accent="orange" inverseTrend delay={0.2} onClick={() => setKpiModal({ title: "Wasted Spend Campaigns", data: campaigns.filter((c: any) => (c.spend || 0) > 0 && (c.orders || 0) === 0) })} />
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
            title="AI Campaign Suggestions"
            suggestions={[
              `You have ${highAcosCount} campaigns with high ACOS. We recommend pausing keywords with ACOS > 50% in these campaigns.`,
              `There is ${cur(wastedSpend, currency)} in wasted spend. Consider adding negative exact matches for non-converting search terms.`,
              `Your AI Optimization Score is ${avgAiScore}/100. Lowering bids on bleeding ad groups will improve this instantly.`
            ]}
          />

          <AiSuggestionModal
            isOpen={!!pausedAiModal}
            onClose={() => setPausedAiModal(null)}
            title={pausedAiModal?.title || ""}
            suggestions={pausedAiModal?.suggestions || []}
          />

          {/* AI Campaign Intelligence */}
          <div className="glass gradient-border rounded-[22px] p-6 space-y-5">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#6D5EF8] to-[#8B5CF6] flex items-center justify-center shadow-md shadow-indigo-500/20">
                  <Bot className="w-4.5 h-4.5 text-white" />
                </div>
                <div>
                  <h3 className="font-extrabold text-lg tracking-tight">AI Campaign Intelligence</h3>
                  <p className="text-xs text-muted-foreground font-semibold">Live analysis of {campaigns.length} campaigns</p>
                </div>
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <div className="text-right">
                  <p className="text-[10px] font-extrabold uppercase tracking-widest text-muted-foreground">Expected Revenue Increase</p>
                  <p className="text-lg font-extrabold text-emerald-600 dark:text-emerald-400">+{cur(expectedRevenueIncrease, currency)} <span className="text-[11px] text-muted-foreground font-bold">· 92% confidence</span></p>
                </div>
                <button onClick={() => alert("One-Click Optimize is currently not enabled in this demo environment.")} className="flex items-center gap-2 bg-gradient-to-r from-[#6D5EF8] to-[#8B5CF6] hover:opacity-90 text-white px-4 py-2.5 rounded-xl text-sm font-bold transition-all shadow-md shadow-indigo-500/20">
                  <Zap className="w-4 h-4" /> One-Click Optimize
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {scaleCampaigns.slice(0, 2).map((c: any) => (
                <div key={c.campaignId} className="p-4 rounded-2xl border border-emerald-200 dark:border-emerald-900 bg-gradient-to-br from-emerald-50/80 to-white dark:from-emerald-950/30 dark:to-transparent text-xs hover:-translate-y-0.5 transition-transform">
                  <p className="font-extrabold text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5 text-sm"><Rocket className="w-4 h-4" /> Scale Opportunity</p>
                  <p className="font-bold mt-1.5 truncate text-[13px]" title={c.campaignName}>{c.campaignName}</p>
                  <p className="text-muted-foreground mt-1 font-bold">ROAS {c.roas.toFixed(2)}x · Sales {cur(c.sales, currency)}</p>
                  <div className="flex items-center justify-between mt-2.5">
                    <p className="font-extrabold text-emerald-700 dark:text-emerald-500">Increase daily budget +25%</p>
                    <span className="bg-emerald-500/10 text-emerald-600 font-extrabold px-2 py-0.5 rounded-full text-[10px]">98% conf</span>
                  </div>
                </div>
              ))}
              {bleedingCampaigns.slice(0, 2).map((c: any) => (
                <div key={c.campaignId} className="p-4 rounded-2xl border border-red-200 dark:border-red-900 bg-gradient-to-br from-red-50/80 to-white dark:from-red-950/30 dark:to-transparent text-xs hover:-translate-y-0.5 transition-transform">
                  <p className="font-extrabold text-red-700 dark:text-red-400 flex items-center gap-1.5 text-sm"><TrendingDown className="w-4 h-4" /> High ACOS Bleeder</p>
                  <p className="font-bold mt-1.5 truncate text-[13px]" title={c.campaignName}>{c.campaignName}</p>
                  <p className="text-muted-foreground mt-1 font-bold">ACOS {pct(c.acos)} · Spend {cur(c.spend, currency)}</p>
                  <div className="flex items-center justify-between mt-2.5">
                    <p className="font-extrabold text-red-700 dark:text-red-500">Lower bids & add negatives</p>
                    <span className="bg-red-500/10 text-red-600 font-extrabold px-2 py-0.5 rounded-full text-[10px]">High risk</span>
                  </div>
                </div>
              ))}
              {zeroOrderWasted.slice(0, 2).map((c: any) => (
                <div key={c.campaignId} className="p-4 rounded-2xl border border-amber-200 dark:border-amber-900 bg-gradient-to-br from-amber-50/80 to-white dark:from-amber-950/30 dark:to-transparent text-xs hover:-translate-y-0.5 transition-transform">
                  <p className="font-extrabold text-amber-700 dark:text-amber-400 flex items-center gap-1.5 text-sm"><AlertTriangle className="w-4 h-4" /> Budget Warning</p>
                  <p className="font-bold mt-1.5 truncate text-[13px]" title={c.campaignName}>{c.campaignName}</p>
                  <p className="text-muted-foreground mt-1 font-bold">Spend {cur(c.spend, currency)} · {c.clicks} clicks · 0 orders</p>
                  <div className="flex items-center justify-between mt-2.5">
                    <p className="font-extrabold text-amber-700 dark:text-amber-500">Check listing conversion or pause</p>
                    <span className="bg-amber-500/10 text-amber-600 font-extrabold px-2 py-0.5 rounded-full text-[10px]">Save {cur(c.spend, currency)}</span>
                  </div>
                </div>
              ))}
              {scaleCampaigns.length === 0 && bleedingCampaigns.length === 0 && zeroOrderWasted.length === 0 && (
                <div className="p-4 rounded-2xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50/50 dark:bg-emerald-950/20 text-xs col-span-full">
                  <p className="font-extrabold text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5 text-sm"><Trophy className="w-4 h-4" /> All campaigns look healthy</p>
                  <p className="text-muted-foreground mt-1 font-bold">No urgent optimizations detected in this date range. Keep monitoring weekly.</p>
                </div>
              )}
            </div>
          </div>

          {/* Sticky Filter Bar */}
          <div className="sticky top-0 z-20 glass rounded-2xl border border-border px-4 py-3 flex items-center gap-2 flex-wrap backdrop-blur-xl">
            <span className="text-[10px] font-extrabold uppercase tracking-widest text-muted-foreground mr-1">Status</span>
            {([
              ["ALL", `All (${campaigns.length})`],
              ["ENABLED", `Active (${campaigns.filter((c: any) => c.state?.toUpperCase() === "ENABLED").length})`],
              ["PAUSED", `Paused (${campaigns.filter((c: any) => c.state?.toUpperCase() === "PAUSED").length})`],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setStatusFilter(key)}
                className={cn(
                  "px-3.5 py-1.5 rounded-full text-xs font-bold transition-all border",
                  statusFilter === key
                    ? key === "ENABLED"
                      ? "bg-emerald-600 text-white border-emerald-600 shadow-sm shadow-emerald-600/25"
                      : key === "PAUSED"
                        ? "bg-amber-500 text-white border-amber-500 shadow-sm shadow-amber-500/25"
                        : "bg-gradient-to-r from-[#6D5EF8] to-[#8B5CF6] text-white border-transparent shadow-sm shadow-indigo-500/25"
                    : "bg-card border-border hover:border-primary/50 text-foreground"
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <DataTable data={filteredCampaigns} columns={columns} defaultSort="spend" rowClassName={acosRowClass} exportName="campaigns" />
        </>
      )}

      {aiBreakdown && (
        <div className="fixed inset-0 bg-[#070B17]/85 backdrop-blur-md flex items-center justify-center z-50 p-4">
          <div className="bg-[#0e1526] border border-white/10 rounded-[28px] max-w-md w-full p-6 shadow-2xl space-y-5 relative">
            <button 
              onClick={() => setAiBreakdown(null)}
              className="absolute top-4 right-4 text-slate-400 hover:text-white transition-colors focus:outline-none"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="space-y-1.5">
              <span className="text-[10px] font-black text-indigo-400 uppercase tracking-widest block">AI Score Analysis</span>
              <h3 className="text-lg font-extrabold text-white truncate max-w-[340px]">{aiBreakdown.name}</h3>
            </div>

            <div className="flex items-center justify-between bg-white/[0.02] border border-white/5 p-4 rounded-2xl">
              <div className="space-y-1">
                <span className="text-xs text-slate-400 font-bold">Optimization Score</span>
                <span className="text-xs text-muted-foreground block font-medium">Out of 100 points</span>
              </div>
              <div className={cn("text-3xl font-black px-4 py-1.5 rounded-2xl text-white shadow-inner", healthColor(aiBreakdown.score))}>
                {aiBreakdown.score}
              </div>
            </div>

            <div className="space-y-3.5 pt-2">
              <h4 className="text-xs font-black text-slate-400 uppercase tracking-wider">Metric Breakdown</h4>
              <div className="space-y-3">
                {/* Base Score */}
                <div className="space-y-1">
                  <div className="flex justify-between text-xs font-bold text-slate-300">
                    <span>Base Active Score</span>
                    <span className="text-indigo-400">+{aiBreakdown.base}</span>
                  </div>
                  <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                    <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${(aiBreakdown.base / 99) * 100}%` }} />
                  </div>
                </div>

                {/* ROAS Bonus */}
                <div className="space-y-1">
                  <div className="flex justify-between text-xs font-bold text-slate-300">
                    <span>ROAS Performance Bonus ({aiBreakdown.roas.toFixed(2)}x)</span>
                    <span className="text-emerald-400">+{Math.round(aiBreakdown.roasBonus)}</span>
                  </div>
                  <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                    <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${(aiBreakdown.roasBonus / 30) * 100}%` }} />
                  </div>
                </div>

                {/* ACOS Penalty */}
                <div className="space-y-1">
                  <div className="flex justify-between text-xs font-bold text-slate-300">
                    <span>ACOS Penalty ({aiBreakdown.acos.toFixed(2)}%)</span>
                    <span className="text-rose-400">-{Math.round(aiBreakdown.acosPenalty)}</span>
                  </div>
                  <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                    <div className="h-full bg-rose-500 rounded-full" style={{ width: `${(aiBreakdown.acosPenalty / 35) * 100}%` }} />
                  </div>
                </div>

                {/* Wasted Penalty */}
                {aiBreakdown.wastedPenalty > 0 && (
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs font-bold text-slate-300">
                      <span>Zero-Order Wasted Spend Penalty</span>
                      <span className="text-amber-500">-{aiBreakdown.wastedPenalty}</span>
                    </div>
                    <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                      <div className="h-full bg-amber-500 rounded-full" style={{ width: "100%" }} />
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="border-t border-white/5 pt-4 mt-2">
              <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-1">Recommendation</span>
              <p className="text-xs text-slate-300 font-bold leading-relaxed">
                {aiBreakdown.score >= 75 
                  ? "This campaign has strong efficiency. Consider increasing budget to scale sales volume." 
                  : aiBreakdown.score >= 55 
                  ? "Campaign is performing stable. Optimize low-performing keywords to improve efficiency." 
                  : "Critical efficiency issues. Lower bids on high-ACOS search terms and add negatives to prevent bleeding."}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
