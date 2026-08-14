"use client";

import { AlertTriangle, Sparkles, Trophy, ShieldAlert, TrendingDown, FileBarChart } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ExecutiveSummary, PlatformSummary } from "@/lib/ratingsReviewsData";

const cur = (val: number, currency = "INR") => {
  const sym = currency === "INR" ? "₹" : "$";
  const sign = val < 0 ? "-" : "";
  return sign + sym + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(Math.abs(val)));
};

export function AiRootCauseSummary({ rootCause }: { rootCause: string[] }) {
  return (
    <div className="glass gradient-border rounded-[22px] p-6">
      <h3 className="text-base font-extrabold mb-4 flex items-center gap-2 tracking-tight">
        <TrendingDown className="w-4 h-4 text-red-500" /> AI Root Cause Analysis
      </h3>
      <div className="space-y-3">
        {rootCause.map((line, i) => (
          <div key={i} className="flex items-start gap-3 p-3.5 rounded-xl border border-red-200 dark:border-red-900 bg-red-50/40 dark:bg-red-950/10">
            <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-foreground/90 leading-relaxed">{line}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AiRecommendationEngine({ recommendations }: { recommendations: ExecutiveSummary["topRecommendations"] }) {
  const priorityStyle: Record<string, string> = {
    High: "border-red-200 dark:border-red-900 bg-red-50/40 dark:bg-red-950/10 text-red-700 dark:text-red-400",
    Medium: "border-amber-200 dark:border-amber-900 bg-amber-50/40 dark:bg-amber-950/10 text-amber-700 dark:text-amber-400",
    Low: "border-blue-200 dark:border-blue-900 bg-blue-50/40 dark:bg-blue-950/10 text-blue-700 dark:text-blue-400",
  };

  return (
    <div className="glass gradient-border rounded-[22px] p-6">
      <h3 className="text-base font-extrabold mb-4 flex items-center gap-2 tracking-tight">
        <Sparkles className="w-4 h-4 text-indigo-500" /> AI Recommendation Engine
      </h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {recommendations.map((r) => (
          <div key={r.text} className={cn("flex items-center justify-between gap-3 p-3.5 rounded-xl border", priorityStyle[r.priority])}>
            <span className="text-xs font-bold">{r.text}</span>
            <span className="text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full bg-white/60 dark:bg-black/20 flex-shrink-0">
              {r.priority} · {r.count} SKU{r.count > 1 ? "s" : ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ExecutiveSummaryPanel({ summary, currency }: { summary: ExecutiveSummary; currency?: string }) {
  return (
    <div className="glass gradient-border rounded-[22px] p-6">
      <h3 className="text-base font-extrabold mb-4 flex items-center gap-2 tracking-tight">
        <FileBarChart className="w-4 h-4 text-indigo-500" /> AI Executive Summary
      </h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
        <div>
          <p className="font-bold text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5 mb-1.5"><Trophy className="w-3.5 h-3.5" /> Top Performing Products</p>
          <ul className="space-y-1 text-muted-foreground">
            {summary.topPerforming.map((p) => <li key={p}>• {p}</li>)}
          </ul>
        </div>
        <div>
          <p className="font-bold text-red-600 dark:text-red-400 flex items-center gap-1.5 mb-1.5"><AlertTriangle className="w-3.5 h-3.5" /> Needs Immediate Action</p>
          <ul className="space-y-1 text-muted-foreground">
            {summary.needsAction.length ? summary.needsAction.map((p) => <li key={p}>• {p}</li>) : <li>None — no critical products right now.</li>}
          </ul>
        </div>
        <div>
          <p className="font-bold text-foreground mb-1.5">Common Customer Complaints</p>
          <div className="flex flex-wrap gap-1.5">
            {summary.commonComplaints.map((c) => (
              <span key={c.text} className="px-2 py-0.5 rounded-full bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-400 border border-red-200 dark:border-red-900 font-bold text-[10px]">{c.text}</span>
            ))}
          </div>
        </div>
        <div>
          <p className="font-bold text-foreground mb-1.5">Common Return Reasons</p>
          <div className="flex flex-wrap gap-1.5">
            {summary.commonReturnReasons.map((r) => (
              <span key={r.reason} className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-400 border border-amber-200 dark:border-amber-900 font-bold text-[10px]">{r.reason} · {r.pct}%</span>
            ))}
          </div>
        </div>
        <div className="md:col-span-2">
          <p className="font-bold text-foreground flex items-center gap-1.5 mb-1.5"><ShieldAlert className="w-3.5 h-3.5 text-amber-500" /> Business Risks</p>
          <ul className="space-y-1 text-muted-foreground">
            {summary.businessRisks.map((r, i) => <li key={i}>• {r}</li>)}
          </ul>
        </div>
        <div>
          <p className="font-bold text-foreground mb-1.5">Estimated Revenue Impact</p>
          <p className="text-lg font-black text-red-500">-{cur(summary.revenueImpact, currency)}</p>
        </div>
        <div>
          <p className="font-bold text-foreground mb-1.5">Top Recommendations</p>
          <ul className="space-y-1 text-muted-foreground">
            {summary.topRecommendations.slice(0, 4).map((r) => <li key={r.text}>• {r.text}</li>)}
          </ul>
        </div>
      </div>
    </div>
  );
}

export function PlatformComparisonPanel({ platforms }: { platforms: PlatformSummary[] }) {
  return (
    <div className="glass gradient-border rounded-[22px] p-6">
      <h3 className="text-base font-extrabold mb-4 tracking-tight">Platform Comparison</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs whitespace-nowrap">
          <thead className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
            <tr>
              <th className="py-2 pr-4 font-extrabold">Metric</th>
              {platforms.map((p) => <th key={p.platform} className="py-2 pr-4 font-extrabold">{p.label}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            <tr><td className="py-2.5 pr-4 font-semibold text-muted-foreground">Average Rating</td>{platforms.map((p) => <td key={p.platform} className="py-2.5 pr-4 font-bold">{p.avgRating.toFixed(1)}★</td>)}</tr>
            <tr><td className="py-2.5 pr-4 font-semibold text-muted-foreground">Reviews</td>{platforms.map((p) => <td key={p.platform} className="py-2.5 pr-4 font-bold">{p.totalReviews.toLocaleString("en-IN")}</td>)}</tr>
            <tr><td className="py-2.5 pr-4 font-semibold text-muted-foreground">Returns</td>{platforms.map((p) => <td key={p.platform} className="py-2.5 pr-4 font-bold">{p.totalReturns.toLocaleString("en-IN")}</td>)}</tr>
            <tr><td className="py-2.5 pr-4 font-semibold text-muted-foreground">Negative Reviews</td>{platforms.map((p) => <td key={p.platform} className="py-2.5 pr-4 font-bold">{p.negativeReviewPct.toFixed(1)}%</td>)}</tr>
            <tr><td className="py-2.5 pr-4 font-semibold text-muted-foreground">Sales Impact</td>{platforms.map((p) => <td key={p.platform} className={cn("py-2.5 pr-4 font-bold", p.salesImpact < 0 ? "text-red-500" : "text-emerald-500")}>{cur(p.salesImpact)}</td>)}</tr>
            <tr><td className="py-2.5 pr-4 font-semibold text-muted-foreground">Health Score</td>{platforms.map((p) => <td key={p.platform} className="py-2.5 pr-4 font-bold">{p.healthScore}/100</td>)}</tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
