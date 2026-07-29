"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { FlaskConical, Star, MessageSquareText, ThumbsDown, RotateCcw, TrendingDown, Sparkles } from "lucide-react";
import { useDashboard } from "@/lib/DashboardContext";
import { PageHero } from "@/components/PageHero";
import { KPICard } from "@/components/KPICard";
import { MARKETPLACE_META, type MarketplaceId } from "@/lib/marketplace";
import { generateRatingsReviewsDataset } from "@/lib/ratingsReviewsData";
import type { RRProduct } from "@/lib/ratingsReviewsData";
import { RatingsFilterBar, DEFAULT_FILTERS, applyRatingsFilters, type RatingsFilters } from "@/components/ratings/RatingsFilterBar";
import { RatingByProductChart, RatingByCategoryChart, RatingTrendChart, RatingDistributionChart } from "@/components/ratings/RatingsOverviewCharts";
import { LowRatedProductsTable, SalesImpactTable, CategoryInsightsTable } from "@/components/ratings/ProductTables";
import { ProductInsightDrawer } from "@/components/ratings/ProductInsightDrawer";
import { AiRootCauseSummary, AiRecommendationEngine, ExecutiveSummaryPanel, PlatformComparisonPanel } from "@/components/ratings/AiInsightsPanels";
import { exportRatingsReviewsExcel, exportRatingsReviewsPDF } from "@/lib/ratingsReviewsExport";

function weightedAvg(items: { value: number; weight: number }[]): number {
  const w = items.reduce((a, i) => a + i.weight, 0);
  if (!w) return 0;
  return items.reduce((a, i) => a + i.value * i.weight, 0) / w;
}

export function RatingsReviewsIntelligence({ marketplace }: { marketplace: MarketplaceId }) {
  const { account, startDate, endDate } = useDashboard();
  const meta = MARKETPLACE_META[marketplace];
  const currency = marketplace === "amazon" ? account?.currency : "INR";

  const dataset = useMemo(() => generateRatingsReviewsDataset(startDate, endDate), [startDate, endDate]);

  const [filters, setFilters] = useState<RatingsFilters>(DEFAULT_FILTERS);
  const [selectedProduct, setSelectedProduct] = useState<RRProduct | null>(null);

  const filteredProducts = useMemo(() => applyRatingsFilters(dataset.products, filters), [dataset.products, filters]);

  const kpis = useMemo(() => {
    const products = filteredProducts;
    const totalReviews = products.reduce((a, p) => a + p.reviewCount, 0);
    return {
      totalProducts: products.length,
      avgRating: round1(weightedAvg(products.map((p) => ({ value: p.avgRating, weight: p.reviewCount })))),
      below4: products.filter((p) => p.avgRating < 4).length,
      below3: products.filter((p) => p.avgRating < 3).length,
      totalReviews,
      negativePct: round1(weightedAvg(products.map((p) => ({ value: p.negativePct, weight: p.reviewCount })))),
      returnRate: round1(weightedAvg(products.map((p) => ({ value: p.returnRate, weight: p.reviewCount })))),
      affectingSales: products.filter((p) => p.salesChangePct < -5).length,
      healthScore: products.length ? Math.round(products.reduce((a, p) => a + p.healthScore, 0) / products.length) : 0,
    };
  }, [filteredProducts]);

  function round1(v: number) {
    return Math.round(v * 10) / 10;
  }

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }} className="space-y-6 pb-12">
      <PageHero
        title="⭐ Ratings & Reviews Intelligence"
        subtitle={`AI-powered analysis of ratings, reviews and returns for ${meta.label} — surfaces which products are losing sales to poor feedback and what to do about it.`}
        badge="AI Insights"
        workspace={marketplace === "amazon" ? account?.name : "B-Arm"}
      />

      {/* Demo data disclosure — this module has no connected reviews/ratings API on
          either marketplace, so every figure here is illustrative, not live. */}
      <div
        className="flex items-center gap-3 rounded-2xl border px-5 py-3.5 shadow-sm"
        style={{ borderColor: `${meta.color}40`, background: `${meta.color}0d` }}
      >
        <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: `${meta.color}1a`, border: `1px solid ${meta.color}40` }}>
          <FlaskConical className="w-4 h-4" style={{ color: meta.color }} />
        </div>
        <div className="min-w-0">
          <p className="font-extrabold text-sm" style={{ color: meta.color }}>Showing illustrative demo data</p>
          <p className="text-xs text-slate-500 dark:text-slate-400 font-semibold">
            No reviews/ratings API is connected for {meta.label} or the other marketplace yet — these numbers are generated for demonstration, not pulled from real customer reviews.
          </p>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <KPICard title="Total Products" value={kpis.totalProducts} accent="blue" delay={0.02} />
        <KPICard title="Average Rating" value={`${kpis.avgRating.toFixed(1)}★`} accent="purple" delay={0.04} />
        <KPICard title="Products Below 4★" value={kpis.below4} accent="orange" delay={0.06} />
        <KPICard title="Products Below 3★" value={kpis.below3} accent="pink" delay={0.08} />
        <KPICard title="Total Reviews" value={kpis.totalReviews.toLocaleString("en-IN")} accent="cyan" delay={0.1} />
        <KPICard title="Negative Reviews %" value={`${kpis.negativePct.toFixed(1)}%`} accent="pink" delay={0.12} />
        <KPICard title="Return Rate" value={`${kpis.returnRate.toFixed(1)}%`} accent="orange" delay={0.14} />
        <KPICard title="Products Affecting Sales" value={kpis.affectingSales} accent="orange" delay={0.16} />
        <KPICard title="AI Health Score" value={`${kpis.healthScore}/100`} accent="green" delay={0.18} />
      </div>

      <RatingsFilterBar
        products={dataset.products}
        filters={filters}
        onChange={setFilters}
        onExportExcel={() => exportRatingsReviewsExcel({ ...dataset, products: filteredProducts }, `ratings_reviews_${marketplace}`)}
        onExportPDF={() => exportRatingsReviewsPDF({ ...dataset, products: filteredProducts }, `ratings_reviews_${marketplace}`)}
      />

      {/* Ratings Overview */}
      <div>
        <h2 className="text-sm font-extrabold uppercase tracking-widest text-muted-foreground mb-3 flex items-center gap-2">
          <Star className="w-3.5 h-3.5" /> Ratings Overview
        </h2>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <RatingByProductChart products={filteredProducts} />
          <RatingByCategoryChart categories={dataset.categories} />
          <RatingTrendChart trend={dataset.ratingTrend} />
          <RatingDistributionChart products={filteredProducts} />
        </div>
      </div>

      {/* Low Rated Products */}
      <div>
        <h2 className="text-sm font-extrabold uppercase tracking-widest text-muted-foreground mb-3 flex items-center gap-2">
          <MessageSquareText className="w-3.5 h-3.5" /> Low Rated Products
        </h2>
        <LowRatedProductsTable products={filteredProducts} currency={currency} onRowClick={setSelectedProduct} />
      </div>

      {/* AI Root Cause + Recommendations */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <AiRootCauseSummary rootCause={dataset.rootCause} />
        <AiRecommendationEngine recommendations={dataset.executiveSummary.topRecommendations} />
      </div>

      {/* Sales Impact */}
      <div>
        <h2 className="text-sm font-extrabold uppercase tracking-widest text-muted-foreground mb-3 flex items-center gap-2">
          <TrendingDown className="w-3.5 h-3.5" /> Sales Impact Analysis
        </h2>
        <SalesImpactTable products={filteredProducts} currency={currency} />
      </div>

      {/* Category Insights */}
      <div>
        <h2 className="text-sm font-extrabold uppercase tracking-widest text-muted-foreground mb-3 flex items-center gap-2">
          <ThumbsDown className="w-3.5 h-3.5" /> Category Insights
        </h2>
        <CategoryInsightsTable categories={dataset.categories} />
      </div>

      {/* Platform Comparison + Executive Summary */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <PlatformComparisonPanel platforms={dataset.platforms} />
        <div className="glass gradient-border rounded-[22px] p-6 flex flex-col justify-center gap-3">
          <h3 className="text-base font-extrabold flex items-center gap-2 tracking-tight"><Sparkles className="w-4 h-4 text-indigo-500" /> Why Platform Comparison Matters</h3>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Ratings and reviews behave differently by marketplace — a return-reason spike on one platform often points to a packaging or fulfillment issue specific to that channel, while a shared complaint across both usually points to the product itself. Use this to decide whether a fix belongs in the listing, the fulfillment process, or the product.
          </p>
        </div>
      </div>

      <ExecutiveSummaryPanel summary={dataset.executiveSummary} currency={currency} />

      {selectedProduct && (
        <ProductInsightDrawer product={selectedProduct} currency={currency} onClose={() => setSelectedProduct(null)} />
      )}
    </motion.div>
  );
}
