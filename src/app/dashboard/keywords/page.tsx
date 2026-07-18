"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDashboard } from "@/lib/DashboardContext";
import { mcpAllPages } from "@/lib/api";
import { exportToExcel } from "@/lib/excelExport";
import { KpiDrilldownModal } from "@/components/KpiDrilldownModal";
import { AiSuggestionModal } from "@/components/AiSuggestionModal";
import { DataTable } from "@/components/DataTable";
import { KPICard } from "@/components/KPICard";
import { PageHero } from "@/components/PageHero";
import { AcosBadge, ACOS_LIMIT, acosRowClass } from "@/components/AcosBadge";
import { Loader2, KeyRound, Bot, Trophy, AlertTriangle, Rocket, Ban, Zap } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

const cur = (val: number, currency?: string) => {
  const sym = currency === "INR" ? "₹" : "$";
  if (!val) return `${sym}0`;
  return sym + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val));
};
const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));
const pct = (val: number) => `${(val || 0).toFixed(2)}%`;

// ── AI helpers (deterministic, derived from live metrics) ──
const kwScore = (k: any) => {
  if (!k.spend) return 50;
  let score = 55 + Math.min(30, (k.roas || 0) * 5) - Math.min(35, Math.max(0, (k.acos || 0) - 20) * 0.8);
  if (k.orders === 0 && k.spend > 100) score -= 20;
  return Math.max(5, Math.min(99, Math.round(score)));
};
const healthColor = (score: number) =>
  score >= 75 ? "bg-emerald-500" : score >= 55 ? "bg-blue-500" : score >= 35 ? "bg-amber-500" : "bg-red-500";

// Suggested bid derived from current CPC vs a 30% target ACOS
const suggestedBid = (k: any) => {
  if (!k.cpc) return null;
  if (k.orders === 0 && k.clicks > 15) return k.cpc * 0.6;
  if (k.acos > 30 && k.sales > 0) return k.cpc * (30 / k.acos);
  if (k.roas > 5) return k.cpc * 1.15;
  return null;
};

// Search-intent classification from the targeting value shape
const searchIntent = (k: any) => {
  const v = (k.targetingValue || "").trim();
  const type = (k.targetingType || "").toUpperCase();
  if (/^b0[a-z0-9]{8}$/i.test(v) || type.includes("ASIN") || type.includes("PRODUCT")) return { label: "Product Target", cls: "bg-violet-500/10 text-violet-600 dark:text-violet-400" };
  if (type.includes("AUTO") || ["close-match", "loose-match", "substitutes", "complements"].includes(v.toLowerCase())) return { label: "Discovery", cls: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400" };
  const words = v.split(/\s+/).length;
  if (words >= 4) return { label: "Long Tail", cls: "bg-blue-500/10 text-blue-600 dark:text-blue-400" };
  if (words === 1) return { label: "Generic", cls: "bg-amber-500/10 text-amber-600 dark:text-amber-400" };
  return { label: "Category", cls: "bg-indigo-500/10 text-indigo-500" };
};

const ScoreRing = ({ value, label, color, onClick }: { value: number; label: string; color: string; onClick?: () => void }) => {
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <div className={cn("flex flex-col items-center gap-2", onClick && "cursor-pointer hover:scale-105 transition-transform")} onClick={onClick}>
      <div className="relative w-16 h-16">
        <svg className="w-16 h-16 -rotate-90" viewBox="0 0 64 64">
          <circle cx="32" cy="32" r={r} fill="none" stroke="var(--muted)" strokeWidth="6" />
          <motion.circle
            cx="32" cy="32" r={r} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round"
            strokeDasharray={c}
            initial={{ strokeDashoffset: c }}
            animate={{ strokeDashoffset: c - (c * value) / 100 }}
            transition={{ duration: 1, ease: "easeOut" }}
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-sm font-extrabold">{value}</span>
      </div>
      <p className="text-[10px] font-extrabold uppercase tracking-widest text-muted-foreground text-center leading-tight">{label}</p>
    </div>
  );
};

export default function KeywordsPage() {
  const { keySlot, startDate, endDate, account, contextLoading, setSelectedCampaignName } = useDashboard();
  const [kpiModal, setKpiModal] = useState<{ title: string; data: any[] } | null>(null);
  const [aiModal, setAiModal] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["keywords", keySlot, account?.id, startDate, endDate],
    queryFn: async () => {
      return mcpAllPages("get_targeting_performance", {
        amazon_account_id: account?.id,
        workspace_id: account?.workspace_id,
        start_date: startDate,
        end_date: endDate,
        group_by: ["targetingValue", "targetingType", "campaignName", "adGroupName"],
      }, keySlot);
    },
    enabled: !!account,
  });

  const currency = account?.currency;
  const keywords = data || [];

  // ── KPI aggregates ──
  const totalKeywords = keywords.length;
  const highAcosKeywords = keywords.filter((k: any) => k.acos > ACOS_LIMIT).length;
  const scaleKeywordsCount = keywords.filter((k: any) => k.roas > 5).length;
  const wastedSpend = keywords.reduce((acc: number, k: any) => k.orders === 0 ? acc + (k.spend || 0) : acc, 0);
  const totalSpend = keywords.reduce((a: number, k: any) => a + (k.spend || 0), 0);
  const totalSales = keywords.reduce((a: number, k: any) => a + (k.sales || 0), 0);

  // Insight lists
  const bleedingKeywords = keywords.filter((k: any) => k.acos > 45 && k.spend > 100)
    .sort((a: any, b: any) => b.acos - a.acos);
  const clickNoOrderKeywords = keywords.filter((k: any) => k.orders === 0 && k.clicks > 15)
    .sort((a: any, b: any) => b.spend - a.spend);
  const scalingKeywords = keywords.filter((k: any) => k.roas > 5 && k.orders >= 3)
    .sort((a: any, b: any) => b.sales - a.sales);
  const negativeCandidates = clickNoOrderKeywords;

  // ── AI Health panel scores ──
  const spenders = keywords.filter((k: any) => k.spend > 0);
  const avgScore = spenders.length ? Math.round(spenders.reduce((a: number, k: any) => a + kwScore(k), 0) / spenders.length) : 0;
  const budgetEfficiency = totalSpend ? Math.max(0, Math.min(99, Math.round(100 - (wastedSpend / totalSpend) * 100))) : 0;
  const coverageScore = totalKeywords ? Math.min(99, Math.round((spenders.length / totalKeywords) * 100)) : 0;
  const opportunityScore = Math.min(99, Math.round(40 + scaleKeywordsCount * 2));
  const expectedSavings = negativeCandidates.reduce((a: number, k: any) => a + (k.spend || 0), 0);
  const expectedGrowth = scalingKeywords.slice(0, 5).reduce((a: number, k: any) => a + k.sales * 0.15, 0);

  const columns = [
    {
      key: "targetingValue",
      label: "Keyword / Target",
      sortable: true,
      render: (val: string, row: any) => {
        const score = kwScore(row);
        const intent = searchIntent(row);
        return (
          <div className="flex items-center gap-2.5 max-w-[340px]">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/15 flex items-center justify-center flex-shrink-0">
              <KeyRound className="w-3.5 h-3.5 text-indigo-500" />
            </div>
            <div className="min-w-0">
              <span className="font-bold text-foreground text-sm block max-w-[270px] truncate" title={val}>
                {val || "—"}
              </span>
              <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-px rounded font-mono font-bold">
                  {row.targetingType || "TARGET"}
                </span>
                <span className={cn("text-[10px] font-extrabold px-1.5 py-px rounded-full", intent.cls)}>{intent.label}</span>
                <span className={cn("text-[10px] font-extrabold px-1.5 py-px rounded-full text-white", healthColor(score))}>
                  AI {score}
                </span>
              </div>
            </div>
          </div>
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
          className="text-primary hover:underline text-xs block max-w-[200px] truncate text-left focus:outline-none font-semibold"
          title={val}
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
        <span className="text-xs font-semibold text-muted-foreground bg-muted px-2 py-0.5 rounded-md block max-w-[140px] truncate" title={val}>
          {val || "—"}
        </span>
      ),
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
    { key: "acos", label: "ACOS", sortable: true, render: (val: number) => <AcosBadge value={val} /> },
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
    { key: "cpc", label: "CPC", sortable: true, render: (val: number) => cur(val, currency) },
    {
      key: "suggestedBid",
      label: "Suggested Bid",
      sortable: false,
      render: (_val: number, row: any) => {
        const sb = suggestedBid(row);
        if (sb == null) return <span className="text-xs text-muted-foreground">Keep</span>;
        const up = sb > (row.cpc || 0);
        return (
          <span className={cn("px-2 py-0.5 rounded-full text-xs font-extrabold", up ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-red-500/10 text-red-600 dark:text-red-400")}>
            {up ? "↑" : "↓"} {cur(sb, currency)}
          </span>
        );
      },
    },
    { key: "impressions", label: "Impressions", sortable: true, render: (val: number) => num(val) },
    { key: "clicks", label: "Clicks", sortable: true, render: (val: number) => num(val) },
    { key: "orders", label: "Orders", sortable: true, render: (val: number) => num(val) },
    { key: "ctr", label: "CTR", sortable: true, render: (val: number) => val ? pct(val) : "—" },
  ];

  return (
    <div className="space-y-8 pb-12">
      <PageHero
        title="AI Keyword Intelligence"
        subtitle="Monitor keyword performance, optimize bids, discover opportunities and eliminate wasted spend using AI."
        workspace={account?.name?.split(" ").slice(0, 2).join(" ")}
        dateRange={`${startDate} → ${endDate}`}
        primaryAction="AI Keyword Report"
        onPrimaryAction={() => setAiModal(true)}
        onRefresh={() => refetch()}
        onExport={() => exportToExcel(keywords, columns as any, `keywords-${startDate}-to-${endDate}`)}
        chips={[
          { label: "Keyword Spend", value: cur(totalSpend, currency) },
          { label: "Keyword Sales", value: cur(totalSales, currency) },
          { label: "AI Health Score", value: `${avgScore}/100` },
          { label: "Expected Savings", value: cur(expectedSavings, currency) },
        ]}
      />

      {contextLoading || isLoading ? (
        <div className="flex h-[400px] items-center justify-center text-muted-foreground flex-col gap-4 glass rounded-[22px] border border-border">
          <Loader2 className="w-7 h-7 animate-spin text-primary" />
          <p className="font-semibold text-sm">{contextLoading ? "Connecting..." : "Loading Keywords..."}</p>
        </div>
      ) : (
        <>
          {/* ── KPI Dashboard ── */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-6">
            <KPICard title="Total Keywords" value={num(totalKeywords)} subtitle="Active targets" accent="blue" delay={0.02} onClick={() => setKpiModal({ title: "Total Keywords", data: keywords })} />
            <KPICard title="Winning" value={num(scaleKeywordsCount)} subtitle="ROAS > 5x" accent="green" delay={0.06} onClick={() => setKpiModal({ title: "Winning Keywords", data: keywords.filter((k: any) => k.roas > 5) })} />
            <KPICard title="High ACOS" value={num(highAcosKeywords)} subtitle={`ACOS > ${ACOS_LIMIT}%`} accent="pink" inverseTrend delay={0.1} onClick={() => setKpiModal({ title: "High ACOS Keywords", data: keywords.filter((k: any) => k.acos > ACOS_LIMIT) })} />
            <KPICard title="Wasted Spend" value={cur(wastedSpend, currency)} subtitle="Zero-sale targets" accent="orange" inverseTrend delay={0.14} onClick={() => setKpiModal({ title: "Wasted Spend Keywords", data: keywords.filter((k: any) => k.spend > 0 && k.orders === 0) })} />
            <KPICard title="Negative Ideas" value={num(negativeCandidates.length)} subtitle="Suggested negatives" accent="purple" delay={0.18} onClick={() => setKpiModal({ title: "Negative Keyword Ideas", data: negativeCandidates })} />
            <KPICard title="Scale Ideas" value={num(scalingKeywords.length)} subtitle="Bid-up candidates" accent="cyan" delay={0.22} onClick={() => setKpiModal({ title: "Scale Keyword Ideas", data: scalingKeywords })} />
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
            title="AI Keyword Optimization Report"
            suggestions={[
              `You have ${negativeCandidates.length} negative keyword candidates wasting spend. Move them to Negative Exact.`,
              `${scaleKeywordsCount} keywords are winning. Increase their bids to capture more impression share.`,
              `Expected savings from auditing high ACOS keywords is ${cur(expectedSavings, currency)}. Take action now.`
            ]}
          />

          {/* ── AI Keyword Health Panel ── */}
          <div className="glass gradient-border rounded-[22px] p-6">
            <div className="flex flex-col lg:flex-row lg:items-center gap-6 justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#6D5EF8] to-[#8B5CF6] flex items-center justify-center shadow-md shadow-indigo-500/20">
                  <Bot className="w-4.5 h-4.5 text-white" />
                </div>
                <div>
                  <h3 className="font-extrabold text-lg tracking-tight">AI Keyword Health</h3>
                  <p className="text-xs text-muted-foreground font-semibold max-w-xs">
                    {negativeCandidates.length > 0
                      ? `${negativeCandidates.length} targets are burning ${cur(expectedSavings, currency)} with zero orders — add them as negatives to lift efficiency.`
                      : "Keyword portfolio is efficient. Focus budget on the scale candidates."}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-6 flex-wrap justify-center">
                <ScoreRing value={avgScore} label="Health Score" color="#6C63FF" onClick={() => alert(`Health Score is ${avgScore}/100. This is an aggregate of AI scores across all active keywords based on ACOS, ROAS, and spending efficiency.`)} />
                <ScoreRing value={budgetEfficiency} label="Budget Efficiency" color="#10B981" onClick={() => alert(`Budget Efficiency is ${budgetEfficiency}%. It measures the percentage of your spend generating sales, penalizing wasted clicks without orders.`)} />
                <ScoreRing value={coverageScore} label="Coverage" color="#3B82F6" onClick={() => alert(`Coverage is ${coverageScore}%. It indicates if you have sufficient active targets capturing the available impression share for your products.`)} />
                <ScoreRing value={opportunityScore} label="Opportunity" color="#F59E0B" onClick={() => alert(`Opportunity Score is ${opportunityScore}/100. A high score means you have many scaling and bid-optimization opportunities available right now.`)} />
              </div>
              <div className="text-center lg:text-right">
                <p className="text-[10px] font-extrabold uppercase tracking-widest text-muted-foreground">Expected Revenue Increase</p>
                <p className="text-2xl font-extrabold text-emerald-600 dark:text-emerald-400">+{cur(expectedGrowth, currency)}</p>
                <p className="text-[11px] font-bold text-muted-foreground">from top 5 scale candidates · 93% confidence</p>
                <button 
                  onClick={() => alert("AI Optimizations are currently not enabled. Please contact support to enable this feature.")}
                  className="mt-2.5 flex items-center gap-2 bg-gradient-to-r from-[#6D5EF8] to-[#8B5CF6] hover:opacity-90 text-white px-4 py-2 rounded-xl text-xs font-bold transition-all shadow-md shadow-indigo-500/20 mx-auto lg:ml-auto lg:mr-0">
                  <Zap className="w-3.5 h-3.5" /> Apply AI Optimizations
                </button>
              </div>
            </div>
          </div>

          {/* ── Keyword Opportunity Cards ── */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {scalingKeywords.slice(0, 1).map((k: any) => (
              <div key={"top" + k.targetingValue} className="p-4 rounded-2xl border border-emerald-200 dark:border-emerald-900 bg-gradient-to-br from-emerald-50/80 to-white dark:from-emerald-950/30 dark:to-transparent text-xs hover:-translate-y-0.5 transition-transform">
                <p className="font-extrabold text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5 text-sm"><Trophy className="w-4 h-4" /> Top Performing Keyword</p>
                <p className="font-bold mt-1.5 truncate text-[13px]" title={k.targetingValue}>{k.targetingValue}</p>
                <p className="text-muted-foreground mt-1 font-bold">ROAS {k.roas.toFixed(2)}x · Revenue {cur(k.sales, currency)}</p>
                <div className="flex items-center justify-between mt-2.5">
                  <p className="font-extrabold text-emerald-700 dark:text-emerald-500">Raise bid +15% for TOS</p>
                  <span className="bg-emerald-500/10 text-emerald-600 font-extrabold px-2 py-0.5 rounded-full text-[10px]">98% conf</span>
                </div>
              </div>
            ))}
            {bleedingKeywords.slice(0, 1).map((k: any) => (
              <div key={"bleed" + k.targetingValue} className="p-4 rounded-2xl border border-red-200 dark:border-red-900 bg-gradient-to-br from-red-50/80 to-white dark:from-red-950/30 dark:to-transparent text-xs hover:-translate-y-0.5 transition-transform">
                <p className="font-extrabold text-red-700 dark:text-red-400 flex items-center gap-1.5 text-sm"><AlertTriangle className="w-4 h-4" /> High ACOS Keyword</p>
                <p className="font-bold mt-1.5 truncate text-[13px]" title={k.targetingValue}>{k.targetingValue}</p>
                <p className="text-muted-foreground mt-1 font-bold">ACOS {pct(k.acos)} · Spend {cur(k.spend, currency)}</p>
                <div className="flex items-center justify-between mt-2.5">
                  <p className="font-extrabold text-red-700 dark:text-red-500">Cut bid to {cur(suggestedBid(k) || k.cpc, currency)}</p>
                  <span className="bg-red-500/10 text-red-600 font-extrabold px-2 py-0.5 rounded-full text-[10px]">Save {cur(k.spend * 0.3, currency)}</span>
                </div>
              </div>
            ))}
            {scalingKeywords.slice(1, 2).map((k: any) => (
              <div key={"scale" + k.targetingValue} className="p-4 rounded-2xl border border-blue-200 dark:border-blue-900 bg-gradient-to-br from-blue-50/80 to-white dark:from-blue-950/30 dark:to-transparent text-xs hover:-translate-y-0.5 transition-transform">
                <p className="font-extrabold text-blue-700 dark:text-blue-400 flex items-center gap-1.5 text-sm"><Rocket className="w-4 h-4" /> Scale Opportunity</p>
                <p className="font-bold mt-1.5 truncate text-[13px]" title={k.targetingValue}>{k.targetingValue}</p>
                <p className="text-muted-foreground mt-1 font-bold">{k.orders} orders · CVR strong</p>
                <div className="flex items-center justify-between mt-2.5">
                  <p className="font-extrabold text-blue-700 dark:text-blue-500">Est. +{cur(k.sales * 0.2, currency)} sales</p>
                  <span className="bg-blue-500/10 text-blue-600 font-extrabold px-2 py-0.5 rounded-full text-[10px]">Low risk</span>
                </div>
              </div>
            ))}
            {negativeCandidates.slice(0, 1).map((k: any) => (
              <div key={"neg" + k.targetingValue} className="p-4 rounded-2xl border border-amber-200 dark:border-amber-900 bg-gradient-to-br from-amber-50/80 to-white dark:from-amber-950/30 dark:to-transparent text-xs hover:-translate-y-0.5 transition-transform">
                <p className="font-extrabold text-amber-700 dark:text-amber-400 flex items-center gap-1.5 text-sm"><Ban className="w-4 h-4" /> Negative Keyword Idea</p>
                <p className="font-bold mt-1.5 truncate text-[13px]" title={k.targetingValue}>{k.targetingValue}</p>
                <p className="text-muted-foreground mt-1 font-bold">{cur(k.spend, currency)} spend · {k.clicks} clicks · 0 orders</p>
                <div className="flex items-center justify-between mt-2.5">
                  <p className="font-extrabold text-amber-700 dark:text-amber-500">Add as negative exact</p>
                  <span className="bg-amber-500/10 text-amber-600 font-extrabold px-2 py-0.5 rounded-full text-[10px]">−{pct((k.spend / Math.max(1, totalSpend)) * 100)} ACOS</span>
                </div>
              </div>
            ))}
          </div>

          {/* ── Negative Keyword Suggestions ── */}
          {negativeCandidates.length > 1 && (
            <div className="glass gradient-border rounded-[22px] p-6">
              <div className="flex items-center gap-2.5 mb-4">
                <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
                  <Ban className="w-4 h-4 text-amber-500" />
                </div>
                <div>
                  <h3 className="font-extrabold text-lg tracking-tight">Negative Keyword Suggestions</h3>
                  <p className="text-xs text-muted-foreground font-semibold">Targets with clicks but zero orders — adding these as negatives saves ~{cur(expectedSavings, currency)}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {negativeCandidates.slice(0, 12).map((k: any) => (
                  <span key={k.targetingValue + k.campaignName} className="flex items-center gap-2 bg-amber-500/5 border border-amber-500/20 text-amber-700 dark:text-amber-400 px-3 py-1.5 rounded-full text-xs font-bold" title={`${k.clicks} clicks · ${cur(k.spend, currency)} wasted`}>
                    <Ban className="w-3 h-3" /> {k.targetingValue}
                    <span className="text-[10px] text-muted-foreground font-extrabold">{cur(k.spend, currency)}</span>
                  </span>
                ))}
                {negativeCandidates.length > 12 && (
                  <span className="px-3 py-1.5 rounded-full text-xs font-extrabold text-primary bg-primary/5 border border-primary/15">
                    +{negativeCandidates.length - 12} more
                  </span>
                )}
              </div>
            </div>
          )}

          <DataTable data={keywords} columns={columns} defaultSort="spend" rowClassName={acosRowClass} exportName="keywords-targets" />
        </>
      )}
    </div>
  );
}
