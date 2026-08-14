"use client";

import { Filter, FileSpreadsheet, FileText, RotateCcw } from "lucide-react";
import type { RRProduct, RRPlatform } from "@/lib/ratingsReviewsData";
import { channelLabel } from "@/lib/barmRatingReviewData";

export interface RatingsFilters {
  platform: "all" | RRPlatform;
  category: string;
  brand: string;
  product: string;
  minRating: number;
  reviewType: "all" | "positive" | "negative" | "neutral";
  returnReason: string;
  sortBy: "lowestRating" | "highestReturns" | "highestNegative" | "largestSalesDrop";
}

export const DEFAULT_FILTERS: RatingsFilters = {
  platform: "all",
  category: "all",
  brand: "all",
  product: "all",
  minRating: 0,
  reviewType: "all",
  returnReason: "all",
  sortBy: "lowestRating",
};

const selectClass =
  "bg-background border border-border text-foreground px-3 py-2 rounded-xl text-xs font-bold focus:border-primary focus:outline-none cursor-pointer";

export function RatingsFilterBar({
  products,
  filters,
  onChange,
  onExportExcel,
  onExportPDF,
  // The sheet-backed source has no review text, so sentiment and return-reason
  // filters would silently match nothing — hide them rather than offer dead controls.
  hideSentimentFilters = false,
}: {
  products: RRProduct[];
  filters: RatingsFilters;
  onChange: (next: RatingsFilters) => void;
  onExportExcel: () => void;
  onExportPDF: () => void;
  hideSentimentFilters?: boolean;
}) {
  const categories = Array.from(new Set(products.map((p) => p.category))).sort();
  const brands = Array.from(new Set(products.map((p) => p.brand))).sort();
  const productNames = Array.from(new Set(products.map((p) => p.name))).sort();
  const platforms = Array.from(new Set(products.map((p) => p.platform))).sort();

  const set = <K extends keyof RatingsFilters>(key: K, value: RatingsFilters[K]) => onChange({ ...filters, [key]: value });

  return (
    <div className="glass gradient-border rounded-[22px] p-4 flex flex-wrap items-center gap-2.5">
      <div className="flex items-center gap-1.5 text-xs font-extrabold text-muted-foreground pr-1">
        <Filter className="w-3.5 h-3.5" /> Filters
      </div>

      <select className={selectClass} value={filters.platform} onChange={(e) => set("platform", e.target.value as RatingsFilters["platform"])}>
        <option value="all">All Platforms</option>
        {platforms.map((p) => (
          <option key={p} value={p}>{channelLabel(p)}</option>
        ))}
      </select>

      <select className={selectClass} value={filters.category} onChange={(e) => set("category", e.target.value)}>
        <option value="all">All Categories</option>
        {categories.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>

      <select className={selectClass} value={filters.brand} onChange={(e) => set("brand", e.target.value)}>
        <option value="all">All Brands</option>
        {brands.map((b) => (
          <option key={b} value={b}>{b}</option>
        ))}
      </select>

      <select className={selectClass} value={filters.product} onChange={(e) => set("product", e.target.value)}>
        <option value="all">All Products</option>
        {productNames.map((n) => (
          <option key={n} value={n}>{n}</option>
        ))}
      </select>

      <select className={selectClass} value={filters.minRating} onChange={(e) => set("minRating", Number(e.target.value))}>
        <option value={0}>Any Rating</option>
        <option value={4}>Below 4★</option>
        <option value={3}>Below 3★</option>
      </select>

      {!hideSentimentFilters && (
        <>
          <select className={selectClass} value={filters.reviewType} onChange={(e) => set("reviewType", e.target.value as RatingsFilters["reviewType"])}>
            <option value="all">Any Review Type</option>
            <option value="negative">Mostly Negative</option>
            <option value="positive">Mostly Positive</option>
            <option value="neutral">High Neutral</option>
          </select>

          <select className={selectClass} value={filters.returnReason} onChange={(e) => set("returnReason", e.target.value)}>
            <option value="all">Any Return Reason</option>
            {["Damaged", "Poor Quality", "Wrong Product", "Not as Expected", "Size Issue", "Others"].map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </>
      )}

      <select className={selectClass} value={filters.sortBy} onChange={(e) => set("sortBy", e.target.value as RatingsFilters["sortBy"])}>
        <option value="lowestRating">Sort: Lowest Rating</option>
        <option value="highestReturns">Sort: Highest Returns</option>
        {!hideSentimentFilters && <option value="highestNegative">Sort: Highest Negative Reviews</option>}
        <option value="largestSalesDrop">{hideSentimentFilters ? "Sort: Largest Orders Drop" : "Sort: Largest Sales Drop"}</option>
      </select>

      <button
        onClick={() => onChange(DEFAULT_FILTERS)}
        className="flex items-center gap-1.5 bg-background border border-border px-3 py-2 rounded-xl text-xs font-bold hover:border-primary transition-colors"
      >
        <RotateCcw className="w-3.5 h-3.5" /> Reset
      </button>

      <div className="flex-1" />

      <button onClick={onExportExcel} className="flex items-center gap-2 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white border border-emerald-500/50 px-3 py-2 rounded-xl text-xs font-bold hover:shadow-md hover:-translate-y-0.5 transition-all">
        <FileSpreadsheet className="w-4 h-4" /> Export Excel
      </button>
      <button onClick={onExportPDF} className="flex items-center gap-2 bg-gradient-to-r from-rose-500 to-red-600 text-white border border-red-500/50 px-3 py-2 rounded-xl text-xs font-bold hover:shadow-md hover:-translate-y-0.5 transition-all">
        <FileText className="w-4 h-4" /> Export PDF
      </button>
    </div>
  );
}

export function applyRatingsFilters(products: RRProduct[], filters: RatingsFilters): RRProduct[] {
  let out = products;
  if (filters.platform !== "all") out = out.filter((p) => p.platform === filters.platform);
  if (filters.category !== "all") out = out.filter((p) => p.category === filters.category);
  if (filters.brand !== "all") out = out.filter((p) => p.brand === filters.brand);
  if (filters.product !== "all") out = out.filter((p) => p.name === filters.product);
  if (filters.minRating > 0) out = out.filter((p) => p.avgRating < filters.minRating);
  if (filters.reviewType === "negative") out = out.filter((p) => p.negativePct > 30);
  if (filters.reviewType === "positive") out = out.filter((p) => p.positivePct > 60);
  if (filters.reviewType === "neutral") out = out.filter((p) => p.neutralPct > 12);
  if (filters.returnReason !== "all") out = out.filter((p) => p.returnReasons.some((r) => r.reason === filters.returnReason && r.pct >= 15));

  const sorted = [...out];
  switch (filters.sortBy) {
    case "lowestRating":
      sorted.sort((a, b) => a.avgRating - b.avgRating);
      break;
    case "highestReturns":
      sorted.sort((a, b) => b.returnRate - a.returnRate);
      break;
    case "highestNegative":
      sorted.sort((a, b) => b.negativePct - a.negativePct);
      break;
    case "largestSalesDrop":
      sorted.sort((a, b) => a.salesChangePct - b.salesChangePct);
      break;
  }
  return sorted;
}
