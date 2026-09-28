"use client";

import { useMemo, useState, useRef } from "react";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useDashboard } from "@/lib/DashboardContext";
import { MARKETPLACE_META, type MarketplaceId } from "@/lib/marketplace";
import { fetchBarmRatingsReviewsDataset } from "@/lib/barmRatingReviewData";
import { generateRatingsReviewsDataset } from "@/lib/ratingsReviewsData";
import type { RRProduct } from "@/lib/ratingsReviewsData";

// New enterprise components
import { RatingsHero } from "@/components/ratings/RatingsHero";
import { ExecutiveKPIStrip } from "@/components/ratings/ExecutiveKPIStrip";
import { InteractiveAnalyticsGrid } from "@/components/ratings/InteractiveAnalyticsGrid";
import { AiReviewIntelligence } from "@/components/ratings/AiReviewIntelligence";
import { ProductReputationTable } from "@/components/ratings/ProductReputationTable";
import { ProductDetailDrawerV2 } from "@/components/ratings/ProductDetailDrawerV2";
import { AiRootCauseCenter } from "@/components/ratings/AiRootCauseCenter";
import { AiRecommendationCenter } from "@/components/ratings/AiRecommendationCenter";
import { ReturnsIntelligenceDashboard } from "@/components/ratings/ReturnsIntelligenceDashboard";
import { MarketplaceComparisonCards } from "@/components/ratings/MarketplaceComparisonCards";
import { RiskCenter } from "@/components/ratings/RiskCenter";
import { AiInsightsFeed } from "@/components/ratings/AiInsightsFeed";
import { SkuRatingsChart } from "@/components/ratings/SkuRatingsChart";

// Import filter bar + export from existing (preserved)
import { RatingsFilterBar, DEFAULT_FILTERS, applyRatingsFilters, type RatingsFilters } from "@/components/ratings/RatingsFilterBar";
import { exportRatingsReviewsExcel, exportRatingsReviewsPDF } from "@/lib/ratingsReviewsExport";
import { ratingsDatasetForDisplay } from "@/lib/ratingsExportRules";

import { Loader2, Database, Info, Download, FileSpreadsheet, FileText } from "lucide-react";
import { cn } from "@/lib/utils";

// Section navigation
const NAV_SECTIONS = [
  { id: "hero", label: "Overview" },
  { id: "kpis", label: "KPIs" },
  { id: "skus", label: "SKUs" },
  { id: "analytics", label: "Analytics" },
  { id: "ai-review", label: "AI Reviews" },
  { id: "products", label: "Products" },
  { id: "root-cause", label: "Root Cause" },
  { id: "recommendations", label: "Recommendations" },
  { id: "returns", label: "Returns" },
  { id: "marketplace", label: "Marketplaces" },
  { id: "risk", label: "Risk" },
  { id: "feed", label: "Feed" },
] as const;

function SectionAnchor({ id }: { id: string }) {
  return <div id={id} className="scroll-mt-20" />;
}

function SectionDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <div className="flex-1 h-px bg-gradient-to-r from-transparent via-border to-transparent" />
      <span className="text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/50">{label}</span>
      <div className="flex-1 h-px bg-gradient-to-r from-border to-transparent" />
    </div>
  );
}

export function RatingsReviewsIntelligence({ marketplace }: { marketplace: MarketplaceId }) {
  const { account, startDate, endDate } = useDashboard();
  const meta = MARKETPLACE_META[marketplace];
  const currency = marketplace === "amazon" ? account?.currency : "INR";

  // Fetch real data from sheet
  const { data: barmDataset, isLoading: barmLoading, isError, refetch } = useQuery({
    queryKey: ["barm-ratings-reviews", startDate, endDate],
    queryFn: () => fetchBarmRatingsReviewsDataset(startDate, endDate),
    staleTime: 5 * 60 * 1000,
  });

  // Always generate the demo dataset (for rich fields the sheet doesn't have)
  const demoDataset = useMemo(
    () => generateRatingsReviewsDataset(startDate, endDate),
    [startDate, endDate]
  );

  // Real data is shown exactly as the source provides it — never padded with demo values (the source
  // has no sales/revenue/return-reason/sentiment data, and filling those from the demo generator put
  // fabricated figures into the Excel/PDF exports). Demo data appears only when no real dataset loaded.
  const dataset = useMemo(() => ratingsDatasetForDisplay(barmDataset, demoDataset), [barmDataset, demoDataset]);

  const [filters, setFilters] = useState<RatingsFilters>(DEFAULT_FILTERS);
  const [selectedProduct, setSelectedProduct] = useState<RRProduct | null>(null);
  const [activeSection, setActiveSection] = useState("hero");

  const filteredProducts = useMemo(
    () => applyRatingsFilters(dataset.products, filters),
    [dataset.products, filters]
  );

  const scrollToSection = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveSection(id);
  };

  if (barmLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] gap-4">
        <div className="relative">
          <div className="w-16 h-16 rounded-full border-4 border-indigo-200 dark:border-indigo-900 animate-spin border-t-indigo-600" />
          <div className="absolute inset-0 flex items-center justify-center">
            <Database className="w-5 h-5 text-indigo-500" />
          </div>
        </div>
        <p className="text-sm font-black text-muted-foreground">Loading Rating Intelligence…</p>
        <p className="text-[11px] text-muted-foreground/60 font-semibold">Analyzing {meta.label} catalog</p>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
      className="space-y-10 pb-20"
    >
      {/* Sticky Section Navigation */}
      <div className="sticky top-0 z-30 bg-background/80 backdrop-blur-xl border-b border-border/50 -mx-4 px-4 lg:-mx-6 lg:px-6">
        <div className="flex items-center gap-1 overflow-x-auto py-2 custom-scrollbar">
          {NAV_SECTIONS.map((section) => (
            <button
              key={section.id}
              onClick={() => scrollToSection(section.id)}
              className={cn(
                "text-[10px] font-black px-3 py-1.5 rounded-lg whitespace-nowrap transition-all flex-shrink-0",
                activeSection === section.id
                  ? "bg-indigo-600 text-white shadow-md shadow-indigo-500/20"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              {section.label}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() => exportRatingsReviewsExcel({ ...dataset, products: filteredProducts }, `ratings_${marketplace}`)}
              className="flex items-center gap-1.5 text-[10px] font-black px-3 py-1.5 rounded-lg border border-border hover:bg-muted transition-all text-muted-foreground"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" /> Excel
            </button>
            <button
              onClick={() => exportRatingsReviewsPDF({ ...dataset, products: filteredProducts }, `ratings_${marketplace}`)}
              className="flex items-center gap-1.5 text-[10px] font-black px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-all shadow-md shadow-indigo-500/20"
            >
              <FileText className="w-3.5 h-3.5" /> PDF
            </button>
          </div>
        </div>
      </div>

      {/* Source Disclosure (compact) */}
      {barmDataset?.source && (
        <div className="flex items-start gap-2.5 px-4 py-2.5 rounded-xl border border-indigo-200 dark:border-indigo-900 bg-indigo-50/50 dark:bg-indigo-950/20 text-[11px]">
          <Info className="w-3.5 h-3.5 text-indigo-500 flex-shrink-0 mt-0.5" />
          <p className="font-semibold text-indigo-700 dark:text-indigo-400">
            <span className="font-black">Live:</span> Showing tracker data for week of {barmDataset.source.currentDate}.{" "}
            This tracker has no review text, sales or return-reason data, so those sections stay empty rather than showing sample figures.
          </p>
        </div>
      )}

      {/* ── HERO ── */}
      <SectionAnchor id="hero" />
      <RatingsHero dataset={dataset} isLoading={barmLoading} onRefresh={refetch} />

      <SectionDivider label="Executive Intelligence" />

      {/* ── KPIs ── */}
      <SectionAnchor id="kpis" />
      <ExecutiveKPIStrip dataset={dataset} />

      {/* ── SKU CHART ── */}
      <SectionAnchor id="skus" />
      <SkuRatingsChart products={filteredProducts.length > 0 ? filteredProducts : dataset.products} />

      {/* ── SMART FILTERS ── */}
      <RatingsFilterBar
        products={dataset.products}
        filters={filters}
        onChange={setFilters}
        hideSentimentFilters
        onExportExcel={() => exportRatingsReviewsExcel({ ...dataset, products: filteredProducts }, `ratings_${marketplace}`)}
        onExportPDF={() => exportRatingsReviewsPDF({ ...dataset, products: filteredProducts }, `ratings_${marketplace}`)}
      />

      <SectionDivider label="Visual Analytics" />

      {/* ── ANALYTICS ── */}
      <SectionAnchor id="analytics" />
      <InteractiveAnalyticsGrid dataset={{ ...dataset, products: filteredProducts }} />

      <SectionDivider label="AI Intelligence" />

      {/* ── AI REVIEW INTELLIGENCE ── */}
      <SectionAnchor id="ai-review" />
      <AiReviewIntelligence dataset={{ ...dataset, products: filteredProducts }} />

      <SectionDivider label="Product Intelligence" />

      {/* ── PRODUCT TABLE ── */}
      <SectionAnchor id="products" />
      <ProductReputationTable
        products={filteredProducts}
        currency={currency}
        onProductClick={setSelectedProduct}
      />

      <SectionDivider label="Root Cause & Actions" />

      {/* ── ROOT CAUSE ── */}
      <SectionAnchor id="root-cause" />
      <AiRootCauseCenter dataset={{ ...dataset, products: filteredProducts }} />

      {/* ── RECOMMENDATIONS ── */}
      <SectionAnchor id="recommendations" />
      <AiRecommendationCenter dataset={{ ...dataset, products: filteredProducts }} />

      <SectionDivider label="Returns & Risk" />

      {/* ── RETURNS ── */}
      <SectionAnchor id="returns" />
      <ReturnsIntelligenceDashboard dataset={{ ...dataset, products: filteredProducts }} />

      <SectionDivider label="Marketplace & Risk" />

      {/* ── MARKETPLACE COMPARISON ── */}
      <SectionAnchor id="marketplace" />
      <MarketplaceComparisonCards platforms={dataset.platforms} />

      {/* ── RISK CENTER ── */}
      <SectionAnchor id="risk" />
      <RiskCenter dataset={{ ...dataset, products: filteredProducts }} />

      <SectionDivider label="Intelligence Feed" />

      {/* ── AI INSIGHTS FEED ── */}
      <SectionAnchor id="feed" />
      <AiInsightsFeed dataset={{ ...dataset, products: filteredProducts }} />

      {/* Product Detail Drawer */}
      {selectedProduct && (
        <ProductDetailDrawerV2
          product={selectedProduct}
          currency={currency}
          onClose={() => setSelectedProduct(null)}
        />
      )}
    </motion.div>
  );
}
