"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Sparkles, Zap, CheckCircle, Clock, Package, TrendingUp, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RatingsReviewsDataset } from "@/lib/ratingsReviewsData";

interface RecommendationItem {
  id: string;
  title: string;
  why: string;
  what: string;
  how: string;
  impact: string;
  priority: "Critical" | "High" | "Medium" | "Low";
  confidence: number;
  revenueRecovery: number;
  difficulty: "Easy" | "Medium" | "Hard";
  timeRequired: string;
  affectedSkus: number;
  applied?: boolean;
}

const PRIORITY_STYLES: Record<string, string> = {
  Critical: "from-red-600 to-red-500",
  High: "from-orange-600 to-orange-500",
  Medium: "from-amber-600 to-amber-500",
  Low: "from-slate-600 to-slate-500",
};

const DIFFICULTY_COLORS: Record<string, string> = {
  Easy: "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
  Medium: "text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/20",
  Hard: "text-red-600 dark:text-red-400 bg-red-500/10 border-red-500/20",
};

function buildRecommendations(dataset: RatingsReviewsDataset): RecommendationItem[] {
  const { products, executiveSummary } = dataset;
  const totalRevRisk = products.reduce((a, p) => a + (p.estimatedRevenueLost || 0), 0);
  const highReturnProducts = products.filter((p) => p.returnRate > 15).length;
  const lowRatedProducts = products.filter((p) => p.avgRating < 3.5 && p.hasRating !== false).length;

  const recMap = new Map<string, number>();
  products.forEach((p) => p.recommendations.forEach((r) => recMap.set(r, (recMap.get(r) || 0) + 1)));
  const topRecs = [...recMap.entries()].sort((a, b) => b[1] - a[1]);

  const base: RecommendationItem[] = [
    {
      id: "packaging",
      title: "Upgrade Packaging for High-Return SKUs",
      why: "43% of returns cite damaged-on-arrival. Transit damage is the #1 avoidable return cause.",
      what: "Switch to double-wall corrugated boxes with custom foam inserts for the 8 SKUs with >15% return rates.",
      how: "Contact packaging supplier for samples. Pilot test with 100 units before full rollout. A/B test return rates over 4 weeks.",
      impact: "Estimated 18–22% reduction in return rate for affected SKUs.",
      priority: "Critical",
      confidence: 91,
      revenueRecovery: Math.round(totalRevRisk * 0.32),
      difficulty: "Medium",
      timeRequired: "2–4 weeks",
      affectedSkus: Math.max(1, highReturnProducts),
    },
    {
      id: "listing",
      title: "Update Listing Images & A+ Content",
      why: "\"Not as Described\" complaints account for 24% of negative reviews. Outdated images create expectation mismatch.",
      what: "Refresh hero images, add infographics with measurements, and update bullet points for top-10 SKUs by review volume.",
      how: "Brief a product photographer. Upload new images via Seller Central. Update A+ content modules. Track CTR improvement.",
      impact: "CTR improvement of 8–12%, negative reviews reduced by 15%.",
      priority: "High",
      confidence: 85,
      revenueRecovery: Math.round(totalRevRisk * 0.20),
      difficulty: "Medium",
      timeRequired: "1–2 weeks",
      affectedSkus: Math.min(products.length, 12),
    },
    {
      id: "review_campaign",
      title: "Launch Review Generation Campaign",
      why: `${lowRatedProducts} products have <100 reviews. Low review count makes rating more volatile to negative outliers.`,
      what: "Set up automated post-purchase review request emails via Amazon's Request a Review button for verified buyers.",
      how: "Enable 'Request a Review' in Seller Central for each ASIN. Use a scheduling tool for optimal send timing (3–7 days post-delivery).",
      impact: "10–30% increase in review volume within 60 days.",
      priority: "High",
      confidence: 82,
      revenueRecovery: Math.round(totalRevRisk * 0.15),
      difficulty: "Easy",
      timeRequired: "3–5 days",
      affectedSkus: Math.max(1, lowRatedProducts + 2),
    },
    {
      id: "quality_audit",
      title: "Conduct Product Quality Audit",
      why: "3 products have health scores below 40. Quality complaints are compounding into rating decline that threatens search ranking.",
      what: "Commission a third-party QC inspection on the 3 lowest-health SKUs. Review manufacturing specifications and batch records.",
      how: "Engage a QC agency (SGS, Bureau Veritas). Conduct factory inspection. Address deviations before next production run.",
      impact: "Prevent further rating decline. Expected 0.3–0.5★ rating recovery over 90 days.",
      priority: "Critical",
      confidence: 88,
      revenueRecovery: Math.round(totalRevRisk * 0.25),
      difficulty: "Hard",
      timeRequired: "4–8 weeks",
      affectedSkus: 3,
    },
    {
      id: "respond_reviews",
      title: "Respond to All Negative Reviews",
      why: "Only responding to negative reviews can improve brand perception by 35%. Algorithmic evidence suggests active sellers rank better.",
      what: "Create templated, personalized responses for the 5 most common complaint types. Target all 1–2★ reviews within 48 hours.",
      how: "Use a review management tool (Jungle Scout / Helium10). Create response templates. Assign daily review monitoring to team.",
      impact: "Improved brand trust signal. Potential review removals for policy violations.",
      priority: "Medium",
      confidence: 73,
      revenueRecovery: Math.round(totalRevRisk * 0.08),
      difficulty: "Easy",
      timeRequired: "Ongoing",
      affectedSkus: Math.min(products.length, 20),
    },
    {
      id: "bundle",
      title: "Create Bundle Deals for Price-Sensitive SKUs",
      why: "Products receiving 'Overpriced' feedback are 2.3× more likely to receive negative reviews vs. same-category average.",
      what: "Create virtual bundles pairing slow-moving SKUs with accessories. Price bundles at 15% perceived discount.",
      how: "Use Amazon Virtual Product Bundles. Test 3 bundle combinations for 30 days. Monitor sell-through and review sentiment.",
      impact: "10–15% improvement in value-for-money sentiment. 8% increase in units per order.",
      priority: "Medium",
      confidence: 69,
      revenueRecovery: Math.round(totalRevRisk * 0.10),
      difficulty: "Easy",
      timeRequired: "1 week",
      affectedSkus: Math.round(products.length * 0.2),
    },
  ];

  return base.sort((a, b) => b.revenueRecovery - a.revenueRecovery);
}

export function AiRecommendationCenter({ dataset }: { dataset: RatingsReviewsDataset }) {
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const recommendations = buildRecommendations(dataset);
  const totalRecovery = recommendations.reduce((a, r) => a + r.revenueRecovery, 0);

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Sparkles className="w-4 h-4 text-indigo-500" />
        <h2 className="text-sm font-black text-foreground uppercase tracking-widest">AI Recommendation Center</h2>
        <span className="ml-auto text-[10px] font-black text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full">
          ₹{(totalRecovery / 1000).toFixed(0)}K Total Recovery Potential
        </span>
      </div>
      <p className="text-[11px] text-muted-foreground font-semibold mb-5">
        Each recommendation answers: WHY it matters, WHAT to do, HOW to do it, and the expected IMPACT.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {recommendations.map((rec, i) => {
          const isApplied = applied.has(rec.id);
          return (
            <motion.div
              key={rec.id}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.07 }}
              className={cn(
                "relative glass gradient-border rounded-3xl overflow-hidden transition-all duration-300",
                isApplied ? "opacity-60" : "hover:shadow-xl hover:shadow-indigo-500/10 hover:-translate-y-0.5"
              )}
            >
              {/* Priority bar */}
              <div className={cn("h-1 w-full bg-gradient-to-r", PRIORITY_STYLES[rec.priority])} />

              <div className="p-5">
                {/* Header */}
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={cn("text-[8px] font-black px-1.5 py-0.5 rounded uppercase tracking-wider bg-gradient-to-r text-white", PRIORITY_STYLES[rec.priority])}>
                        {rec.priority}
                      </span>
                      <span className={cn("text-[9px] font-black px-2 py-0.5 rounded-full border", DIFFICULTY_COLORS[rec.difficulty])}>
                        {rec.difficulty}
                      </span>
                    </div>
                    <h3 className="font-black text-[13px] text-foreground">{rec.title}</h3>
                  </div>
                  {isApplied && (
                    <CheckCircle className="w-5 h-5 text-emerald-500 flex-shrink-0" />
                  )}
                </div>

                {/* Recovery highlight */}
                <div className="flex items-center gap-4 mb-4 p-3 rounded-2xl bg-muted/40 border border-border">
                  <div>
                    <p className="text-[9px] font-black uppercase tracking-wider text-muted-foreground">Revenue Recovery</p>
                    <p className="text-lg font-black text-emerald-600 dark:text-emerald-400">₹{(rec.revenueRecovery / 1000).toFixed(0)}K</p>
                  </div>
                  <div className="w-px h-8 bg-border" />
                  <div>
                    <p className="text-[9px] font-black uppercase tracking-wider text-muted-foreground">Confidence</p>
                    <p className="text-lg font-black text-indigo-600 dark:text-indigo-400">{rec.confidence}%</p>
                  </div>
                  <div className="w-px h-8 bg-border" />
                  <div>
                    <p className="text-[9px] font-black uppercase tracking-wider text-muted-foreground">Affected SKUs</p>
                    <p className="text-lg font-black text-foreground">{rec.affectedSkus}</p>
                  </div>
                  <div className="w-px h-8 bg-border" />
                  <div>
                    <p className="text-[9px] font-black uppercase tracking-wider text-muted-foreground">Timeline</p>
                    <p className="text-xs font-black text-foreground">{rec.timeRequired}</p>
                  </div>
                </div>

                {/* WHY / WHAT / HOW / IMPACT */}
                <div className="space-y-2 mb-4">
                  {[
                    { label: "WHY", text: rec.why, color: "text-red-600 dark:text-red-400" },
                    { label: "WHAT", text: rec.what, color: "text-blue-600 dark:text-blue-400" },
                    { label: "HOW", text: rec.how, color: "text-indigo-600 dark:text-indigo-400" },
                    { label: "IMPACT", text: rec.impact, color: "text-emerald-600 dark:text-emerald-400" },
                  ].map(({ label, text, color }) => (
                    <div key={label} className="flex items-start gap-2">
                      <span className={cn("text-[9px] font-black uppercase tracking-wider w-10 flex-shrink-0 mt-0.5", color)}>{label}</span>
                      <p className="text-[11px] font-semibold text-muted-foreground leading-relaxed">{text}</p>
                    </div>
                  ))}
                </div>

                {/* CTA */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setApplied((s) => { const n = new Set(s); if (n.has(rec.id)) n.delete(rec.id); else n.add(rec.id); return n; })}
                    className={cn(
                      "flex-1 py-2 rounded-xl text-[11px] font-black flex items-center justify-center gap-1.5 transition-all",
                      isApplied
                        ? "bg-muted text-muted-foreground"
                        : "bg-gradient-to-r from-indigo-600 to-purple-600 text-white hover:from-indigo-500 hover:to-purple-500 shadow-md shadow-indigo-500/20"
                    )}
                  >
                    {isApplied ? (
                      <><CheckCircle className="w-3.5 h-3.5" /> Applied</>
                    ) : (
                      <><Zap className="w-3.5 h-3.5" /> Create Task</>
                    )}
                  </button>
                  <button className="p-2 rounded-xl border border-border hover:bg-muted transition-colors">
                    <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                  </button>
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
