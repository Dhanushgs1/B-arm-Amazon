// Ratings & Reviews Intelligence — mock data + rule-based "AI" insight layer.
//
// There is no connected reviews/ratings API for either marketplace (SellerMate's
// Ads API doesn't expose product reviews, and Flipkart has no live integration at
// all — see lib/flipkartData.ts). Every number here is deterministic demo data,
// seeded from the marketplace + product + date range so it stays stable while
// browsing a given period instead of re-randomizing on every render. Swap this
// generator out for a real data source with zero UI changes once one exists.
//
// "AI insights" here means rule-based text generation from the computed metrics
// (thresholds → template strings), the same idiom CampaignDetailDrawer already
// uses for its fallback recommendations — not a live LLM call.

export type RRPlatform = "amazon" | "flipkart";

function seedFromString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seedParts: (string | number | undefined)[]) {
  return mulberry32(seedFromString(seedParts.join("|")));
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
function round1(v: number) {
  return Math.round(v * 10) / 10;
}

function fmtDayLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", { month: "short", day: "numeric" });
}

function eachDate(start: string, end: string): string[] {
  const out: string[] = [];
  if (!start || !end) return out;
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  const cur = new Date(sy, sm - 1, sd);
  const last = new Date(ey, em - 1, ed);
  if (last < cur) return out;
  while (cur <= last) {
    const y = cur.getFullYear();
    const m = String(cur.getMonth() + 1).padStart(2, "0");
    const d = String(cur.getDate()).padStart(2, "0");
    out.push(`${y}-${m}-${d}`);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

// Buckets a date range into at most `maxPoints` evenly-spaced labelled points —
// a 90-day range would otherwise plot 90 rating-trend points on one line chart.
function bucketDates(dates: string[], maxPoints = 12): string[] {
  if (dates.length <= maxPoints) return dates;
  const step = Math.ceil(dates.length / maxPoints);
  const out: string[] = [];
  for (let i = 0; i < dates.length; i += step) out.push(dates[i]);
  if (out[out.length - 1] !== dates[dates.length - 1]) out.push(dates[dates.length - 1]);
  return out;
}

// ---------------------------------------------------------------------------
// Product catalog — a fixed pool per platform, categorized. Fabricated but
// thematically consistent with this workspace's real product niches (personal
// care / baby & mom / sensory-therapy / wellness) so the demo reads coherently
// next to the live Amazon Ads data elsewhere in the dashboard.
// ---------------------------------------------------------------------------

interface CatalogEntry {
  name: string;
  category: string;
  platform: RRPlatform;
  brand: string;
}

const CATALOG: CatalogEntry[] = [
  { name: "Ayurvedic Hair Growth Oil", category: "Personal Care", platform: "amazon", brand: "LKN Naturals" },
  { name: "Herbal Face Wash Gel", category: "Personal Care", platform: "amazon", brand: "LKN Naturals" },
  { name: "Anti-Dandruff Scalp Serum", category: "Personal Care", platform: "amazon", brand: "LKN Naturals" },
  { name: "Postpartum Recovery Belt", category: "Baby & Mom Care", platform: "amazon", brand: "LKN Naturals" },
  { name: "Nasal Aspirator for Infants", category: "Baby & Mom Care", platform: "amazon", brand: "LKN Naturals" },
  { name: "Sensory Chew Brush - Therapy Grade", category: "Sensory & Therapy", platform: "amazon", brand: "B-Arm" },
  { name: "Kids Sensory Fidget Pack", category: "Sensory & Therapy", platform: "amazon", brand: "B-Arm" },
  { name: "Multivitamin Gummies (60ct)", category: "Wellness & Nutrition", platform: "amazon", brand: "LKN Naturals" },
  { name: "Copper Water Bottle 1L", category: "Home Essentials", platform: "amazon", brand: "LKN Naturals" },
  { name: "Bamboo Cutlery Travel Set", category: "Home Essentials", platform: "amazon", brand: "LKN Naturals" },
  { name: "Therapressure Brush - Wilbarger Protocol", category: "Sensory & Therapy", platform: "flipkart", brand: "B-Arm" },
  { name: "Silicone Teether Set", category: "Baby & Mom Care", platform: "flipkart", brand: "B-Arm" },
  { name: "Weighted Sensory Blanket", category: "Sensory & Therapy", platform: "flipkart", brand: "B-Arm" },
  { name: "Ovulation Test Kit (30 Strips)", category: "Wellness & Nutrition", platform: "flipkart", brand: "B-Arm" },
  { name: "Digital Basal Body Thermometer", category: "Wellness & Nutrition", platform: "flipkart", brand: "B-Arm" },
  { name: "Herbal Foot Cream", category: "Personal Care", platform: "flipkart", brand: "B-Arm" },
  { name: "Baby Grooming Kit - 8pcs", category: "Baby & Mom Care", platform: "flipkart", brand: "B-Arm" },
  { name: "Reusable Silicone Food Wraps", category: "Home Essentials", platform: "flipkart", brand: "B-Arm" },
  { name: "Argan Hair Repair Mask", category: "Personal Care", platform: "flipkart", brand: "B-Arm" },
  { name: "Stainless Steel Lunch Box", category: "Home Essentials", platform: "flipkart", brand: "B-Arm" },
];

const POSITIVE_KEYWORDS = [
  "Comfortable", "Good Quality", "Easy to Use", "Value for Money", "Fast Acting",
  "Great Packaging", "Authentic", "Long Lasting", "Effective", "Gentle on Skin",
  "Great for Kids", "Highly Recommended",
];

const NEGATIVE_KEYWORDS = [
  "Poor Packaging", "Late Delivery", "Bad Quality", "Size Issue", "Damaged on Arrival",
  "Not as Described", "Strong Smell", "Difficult to Use", "Expired Product",
  "Overpriced", "Leakage Issue", "Color Mismatch",
];

const RETURN_REASONS = ["Damaged", "Poor Quality", "Wrong Product", "Not as Expected", "Size Issue", "Others"];

function pickWeighted<T>(rng: () => number, items: T[], count: number): T[] {
  const pool = [...items];
  const out: T[] = [];
  for (let i = 0; i < count && pool.length; i++) {
    const idx = Math.floor(rng() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

export interface ReviewKeyword {
  text: string;
  count: number;
}

export interface ReturnReasonSlice {
  reason: string;
  pct: number;
}

export interface RatingTrendPoint {
  rawDate: string;
  date: string;
  rating: number;
}

export type HealthStatus = "Excellent" | "Good" | "Needs Attention" | "Critical";
export type RatingStatus = "Excellent" | "Good" | "Watch" | "Critical";

export interface RRProduct {
  id: string;
  name: string;
  sku: string;
  category: string;
  platform: RRPlatform;
  brand: string;
  avgRating: number;
  priorRating: number;
  reviewCount: number;
  ratingDistribution: { star: number; count: number }[];
  positivePct: number;
  negativePct: number;
  neutralPct: number;
  positiveKeywords: ReviewKeyword[];
  negativeKeywords: ReviewKeyword[];
  reviewSummary: string;
  ratingTrend: RatingTrendPoint[];
  sales: number;
  salesChangePct: number;
  ordersChangePct: number;
  returnRate: number;
  totalReturns: number;
  returnReasons: ReturnReasonSlice[];
  estimatedRevenueLost: number;
  aiConfidence: number;
  healthScore: number;
  healthStatus: HealthStatus;
  ratingStatus: RatingStatus;
  actionRequired: string;
  recommendations: string[];
}

export interface CategoryInsight {
  category: string;
  avgRating: number;
  productsBelow4: number;
  negativeReviewPct: number;
  returnPct: number;
  healthScore: number;
}

export interface PlatformSummary {
  platform: RRPlatform;
  label: string;
  productCount: number;
  avgRating: number;
  totalReviews: number;
  totalReturns: number;
  negativeReviewPct: number;
  salesImpact: number;
  healthScore: number;
}

export interface ExecutiveSummary {
  topPerforming: string[];
  needsAction: string[];
  commonComplaints: ReviewKeyword[];
  commonReturnReasons: ReturnReasonSlice[];
  businessRisks: string[];
  revenueImpact: number;
  topRecommendations: { text: string; count: number; priority: "High" | "Medium" | "Low" }[];
}

export interface RatingsReviewsDataset {
  products: RRProduct[];
  ratingTrend: RatingTrendPoint[];
  categories: CategoryInsight[];
  platforms: PlatformSummary[];
  rootCause: string[];
  executiveSummary: ExecutiveSummary;
}

function healthTier(score: number): HealthStatus {
  if (score >= 85) return "Excellent";
  if (score >= 70) return "Good";
  if (score >= 50) return "Needs Attention";
  return "Critical";
}

function ratingTier(avgRating: number): RatingStatus {
  if (avgRating >= 4.5) return "Excellent";
  if (avgRating >= 4.0) return "Good";
  if (avgRating >= 3.0) return "Watch";
  return "Critical";
}

function deriveRecommendations(args: {
  avgRating: number;
  negativePct: number;
  reviewCount: number;
  salesChangePct: number;
  negativeKeywords: ReviewKeyword[];
  returnReasons: ReturnReasonSlice[];
}): string[] {
  const { avgRating, negativePct, reviewCount, salesChangePct, negativeKeywords, returnReasons } = args;
  const negText = new Set(negativeKeywords.map((k) => k.text));
  const topReturnReason = [...returnReasons].sort((a, b) => b.pct - a.pct)[0];
  const recs: string[] = [];

  if (negText.has("Poor Packaging") || negText.has("Damaged on Arrival") || topReturnReason?.reason === "Damaged") {
    recs.push("Improve Packaging");
  }
  if (negText.has("Bad Quality") || avgRating < 3.5 || topReturnReason?.reason === "Poor Quality") {
    recs.push("Improve Product Quality");
  }
  if (negText.has("Not as Described") || negText.has("Color Mismatch")) {
    recs.push("Update Images");
  }
  if (topReturnReason?.reason === "Wrong Product" && topReturnReason.pct > 12) {
    recs.push("Improve Listing Title");
  }
  if (topReturnReason?.reason === "Not as Expected" && topReturnReason.pct > 12) {
    recs.push("Improve Description");
  }
  if (negText.has("Size Issue") || topReturnReason?.reason === "Size Issue") {
    recs.push("Update Size Guide");
  }
  if (negText.has("Late Delivery")) {
    recs.push("Improve Delivery Experience");
  }
  if (negativePct > 25) {
    recs.push("Respond to Negative Reviews");
  }
  if (avgRating >= 4.2 && reviewCount < 300) {
    recs.push("Request Positive Reviews");
  }
  if (reviewCount < 100) {
    recs.push("Launch Review Campaign");
  }
  if (salesChangePct < -10 && avgRating >= 4.0) {
    recs.push("Improve Ad Targeting");
  }

  if (recs.length === 0) recs.push("Maintain Current Quality Standards");
  return Array.from(new Set(recs)).slice(0, 5);
}

function buildProduct(entry: CatalogEntry, startDate: string, endDate: string): RRProduct {
  const rng = makeRng([entry.platform, entry.name, startDate, endDate]);
  const id = `${entry.platform}-${seedFromString(entry.name).toString(36).slice(0, 8)}`;
  const sku = `${entry.platform.slice(0, 2).toUpperCase()}-${seedFromString(entry.name + entry.platform).toString(36).slice(0, 6).toUpperCase()}`;

  const avgRating = round1(clamp(2.5 + rng() * 2.4, 1, 5));
  const reviewCount = Math.round(35 + rng() * 1400);

  // Rating distribution: a bell curve centered on avgRating across the 1-5 star buckets.
  const sigma = 0.85;
  const rawWeights = [1, 2, 3, 4, 5].map((star) => Math.exp(-((star - avgRating) ** 2) / (2 * sigma * sigma)));
  const weightSum = rawWeights.reduce((a, b) => a + b, 0);
  const ratingDistribution = [5, 4, 3, 2, 1].map((star) => ({
    star,
    count: Math.round((rawWeights[star - 1] / weightSum) * reviewCount),
  }));

  const positivePct = round1(clamp(((avgRating - 1) / 4) * 100 + (rng() - 0.5) * 10, 5, 95));
  const neutralPct = round1(clamp(6 + rng() * 10, 4, 20));
  const negativePct = round1(clamp(100 - positivePct - neutralPct, 2, 90));

  const positiveKeywords: ReviewKeyword[] = pickWeighted(rng, POSITIVE_KEYWORDS, 3 + Math.floor(rng() * 3)).map((text) => ({
    text,
    count: Math.round((reviewCount * positivePct) / 100 * (0.15 + rng() * 0.3)),
  })).sort((a, b) => b.count - a.count);

  const negKeywordPool = avgRating < 3.5 ? NEGATIVE_KEYWORDS : pickWeighted(rng, NEGATIVE_KEYWORDS, 7);
  const negativeKeywords: ReviewKeyword[] = pickWeighted(rng, negKeywordPool, 3 + Math.floor(rng() * 3)).map((text) => ({
    text,
    count: Math.round((reviewCount * negativePct) / 100 * (0.15 + rng() * 0.35)),
  })).sort((a, b) => b.count - a.count);

  const topPositive = positiveKeywords[0]?.text || "Good Quality";
  const secondPositive = positiveKeywords[1]?.text || "Easy to Use";
  const topNegative = negativeKeywords[0]?.text || "—";
  const secondNegative = negativeKeywords[1]?.text || "—";

  const reviewSummary = negativeKeywords.length
    ? `${reviewCount.toLocaleString("en-IN")} reviews analyzed: ${positivePct}% positive, ${negativePct}% negative, ${neutralPct}% neutral. Customers most often praise "${topPositive}" and "${secondPositive}", while complaints center on "${topNegative}" and "${secondNegative}".`
    : `${reviewCount.toLocaleString("en-IN")} reviews analyzed: ${positivePct}% positive, ${negativePct}% negative, ${neutralPct}% neutral. Overwhelmingly positive feedback with no significant recurring complaint.`;

  // Sales trend: tied to rating — low-rated products skew toward a sales decline.
  const salesBase = Math.round(8000 + rng() * 60000);
  let salesChangePct: number;
  if (avgRating < 3.5) salesChangePct = round1(-35 + rng() * 30);
  else if (avgRating < 4.2) salesChangePct = round1(-10 + rng() * 20);
  else salesChangePct = round1(-5 + rng() * 35);
  const ordersChangePct = round1(salesChangePct * (0.8 + rng() * 0.4));

  const priorRating = round1(clamp(avgRating + (salesChangePct < 0 ? (Math.abs(salesChangePct) / 100) * 1.3 : -rng() * 0.15), avgRating, 5));

  const returnRate = round1(clamp(25 - avgRating * 4 + rng() * 6, 1.5, 32));
  const totalReturns = Math.round(reviewCount * (returnRate / 100) * (0.6 + rng() * 0.8));

  // Return reason mix: worse products skew toward "Damaged"/"Poor Quality".
  const reasonWeights = RETURN_REASONS.map((reason) => {
    let w = 0.5 + rng();
    if (avgRating < 3.5 && (reason === "Damaged" || reason === "Poor Quality")) w *= 2.2;
    if (reason === "Others") w *= 0.6;
    return w;
  });
  const reasonSum = reasonWeights.reduce((a, b) => a + b, 0);
  const returnReasons: ReturnReasonSlice[] = RETURN_REASONS.map((reason, i) => ({
    reason,
    pct: Math.round((reasonWeights[i] / reasonSum) * 1000) / 10,
  })).sort((a, b) => b.pct - a.pct);
  // Normalize rounding drift back to exactly 100.
  const reasonTotal = returnReasons.reduce((a, r) => a + r.pct, 0);
  returnReasons[0].pct = round1(returnReasons[0].pct + (100 - reasonTotal));

  const estimatedRevenueLost = salesChangePct < 0 ? Math.round((Math.abs(salesChangePct) / 100) * salesBase) : 0;
  const aiConfidence = Math.round(clamp(58 + rng() * 30 + Math.min(reviewCount / 100, 8), 55, 96));

  const healthScore = Math.round(
    clamp(
      (avgRating / 5) * 40 +
        (1 - negativePct / 100) * 25 +
        (1 - clamp(returnRate, 0, 30) / 30) * 20 +
        (salesChangePct >= 0 ? 15 : clamp(15 + salesChangePct * 0.4, 0, 15)),
      0,
      100
    )
  );

  const recommendations = deriveRecommendations({ avgRating, negativePct, reviewCount, salesChangePct, negativeKeywords, returnReasons });
  const actionRequired = recommendations[0];

  return {
    id,
    name: entry.name,
    sku,
    category: entry.category,
    platform: entry.platform,
    brand: entry.brand,
    avgRating,
    priorRating,
    reviewCount,
    ratingDistribution,
    positivePct,
    negativePct,
    neutralPct,
    positiveKeywords,
    negativeKeywords,
    reviewSummary,
    ratingTrend: [],
    sales: salesBase,
    salesChangePct,
    ordersChangePct,
    returnRate,
    totalReturns,
    returnReasons,
    estimatedRevenueLost,
    aiConfidence,
    healthScore,
    healthStatus: healthTier(healthScore),
    ratingStatus: ratingTier(avgRating),
    actionRequired,
    recommendations,
  };
}

function weightedAvg(items: { value: number; weight: number }[]): number {
  const w = items.reduce((a, i) => a + i.weight, 0);
  if (!w) return 0;
  return items.reduce((a, i) => a + i.value * i.weight, 0) / w;
}

function buildCategories(products: RRProduct[]): CategoryInsight[] {
  const byCategory = new Map<string, RRProduct[]>();
  products.forEach((p) => {
    const list = byCategory.get(p.category) || [];
    list.push(p);
    byCategory.set(p.category, list);
  });
  return Array.from(byCategory.entries())
    .map(([category, list]) => ({
      category,
      avgRating: round1(weightedAvg(list.map((p) => ({ value: p.avgRating, weight: p.reviewCount })))),
      productsBelow4: list.filter((p) => p.avgRating < 4).length,
      negativeReviewPct: round1(weightedAvg(list.map((p) => ({ value: p.negativePct, weight: p.reviewCount })))),
      returnPct: round1(weightedAvg(list.map((p) => ({ value: p.returnRate, weight: p.reviewCount })))),
      healthScore: Math.round(list.reduce((a, p) => a + p.healthScore, 0) / list.length),
    }))
    .sort((a, b) => b.healthScore - a.healthScore);
}

function buildPlatforms(products: RRProduct[]): PlatformSummary[] {
  const platforms: RRPlatform[] = ["amazon", "flipkart"];
  return platforms.map((platform) => {
    const list = products.filter((p) => p.platform === platform);
    return {
      platform,
      label: platform === "amazon" ? "Amazon" : "Flipkart",
      productCount: list.length,
      avgRating: round1(weightedAvg(list.map((p) => ({ value: p.avgRating, weight: p.reviewCount })))),
      totalReviews: list.reduce((a, p) => a + p.reviewCount, 0),
      totalReturns: list.reduce((a, p) => a + p.totalReturns, 0),
      negativeReviewPct: round1(weightedAvg(list.map((p) => ({ value: p.negativePct, weight: p.reviewCount })))),
      salesImpact: -list.reduce((a, p) => a + p.estimatedRevenueLost, 0),
      healthScore: list.length ? Math.round(list.reduce((a, p) => a + p.healthScore, 0) / list.length) : 0,
    };
  });
}

function buildRatingTrend(products: RRProduct[], startDate: string, endDate: string): RatingTrendPoint[] {
  const dates = bucketDates(eachDate(startDate, endDate), 12);
  if (dates.length === 0) return [];
  const rng = makeRng(["trend", startDate, endDate]);
  const current = weightedAvg(products.map((p) => ({ value: p.avgRating, weight: p.reviewCount })));
  const prior = weightedAvg(products.map((p) => ({ value: p.priorRating, weight: p.reviewCount })));
  return dates.map((d, i) => {
    const progress = dates.length > 1 ? i / (dates.length - 1) : 1;
    const base = prior + (current - prior) * progress;
    const jitter = (rng() - 0.5) * 0.12;
    return { rawDate: d, date: fmtDayLabel(d), rating: round1(clamp(base + jitter, 1, 5)) };
  });
}

function buildRootCause(products: RRProduct[]): string[] {
  const declining = [...products]
    .filter((p) => p.salesChangePct < -5)
    .sort((a, b) => a.salesChangePct - b.salesChangePct)
    .slice(0, 3);

  if (declining.length === 0) {
    return ["No products show a meaningful sales decline in this date range — ratings and returns are holding steady across the catalog."];
  }

  return declining.map((p) => {
    const topReturnReason = p.returnReasons[0];
    const topNegative = p.negativeKeywords[0]?.text || "quality complaints";
    return `${p.name}: sales dropped ${Math.abs(p.salesChangePct)}% as the average rating slipped from ${p.priorRating}★ to ${p.avgRating}★. ${p.negativePct}% negative sentiment and a ${p.returnRate}% return rate — driven mainly by "${topReturnReason.reason}" returns (${topReturnReason.pct}%) and "${topNegative}" complaints — an estimated ₹${p.estimatedRevenueLost.toLocaleString("en-IN")} revenue impact.`;
  });
}

function buildExecutiveSummary(products: RRProduct[], rootCause: string[]): ExecutiveSummary {
  const byHealth = [...products].sort((a, b) => b.healthScore - a.healthScore);
  const topPerforming = byHealth.slice(0, 3).map((p) => p.name);
  const needsAction = [...products]
    .filter((p) => p.healthScore < 60)
    .sort((a, b) => a.healthScore - b.healthScore)
    .slice(0, 5)
    .map((p) => p.name);

  const complaintCounts = new Map<string, number>();
  products.forEach((p) => p.negativeKeywords.forEach((k) => complaintCounts.set(k.text, (complaintCounts.get(k.text) || 0) + k.count)));
  const commonComplaints = Array.from(complaintCounts.entries())
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const reasonPct = new Map<string, number>();
  products.forEach((p) => p.returnReasons.forEach((r) => reasonPct.set(r.reason, (reasonPct.get(r.reason) || 0) + r.pct * p.totalReturns)));
  const totalReturns = products.reduce((a, p) => a + p.totalReturns, 0) || 1;
  const commonReturnReasons = Array.from(reasonPct.entries())
    .map(([reason, weighted]) => ({ reason, pct: round1(weighted / totalReturns) }))
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 4);

  const revenueImpact = products.reduce((a, p) => a + p.estimatedRevenueLost, 0);
  const criticalCount = products.filter((p) => p.healthStatus === "Critical").length;

  const businessRisks: string[] = [];
  if (criticalCount > 0) businessRisks.push(`${criticalCount} product${criticalCount > 1 ? "s" : ""} in critical health — at risk of suppressed rank / buy-box loss if ratings keep declining.`);
  const highReturn = products.filter((p) => p.returnRate > 18);
  if (highReturn.length > 0) businessRisks.push(`${highReturn.length} product${highReturn.length > 1 ? "s" : ""} with return rate above 18% — margin erosion from reverse logistics and refunds.`);
  const negativeReviewHeavy = products.filter((p) => p.negativePct > 30);
  if (negativeReviewHeavy.length > 0) businessRisks.push(`${negativeReviewHeavy.length} product${negativeReviewHeavy.length > 1 ? "s" : ""} with over 30% negative sentiment — rising risk of algorithmic demotion in search ranking.`);
  if (businessRisks.length === 0) businessRisks.push("No major risk signals detected — catalog health is stable across the selected date range.");

  const recCounts = new Map<string, number>();
  products.forEach((p) => p.recommendations.forEach((r) => recCounts.set(r, (recCounts.get(r) || 0) + 1)));
  const topRecommendations = Array.from(recCounts.entries())
    .map(([text, count]) => ({
      text,
      count,
      priority: (count / products.length > 0.35 ? "High" : count / products.length > 0.15 ? "Medium" : "Low") as "High" | "Medium" | "Low",
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  return { topPerforming, needsAction, commonComplaints, commonReturnReasons, businessRisks, revenueImpact, topRecommendations };
}

// Cache raw per-product builds per (startDate, endDate) — the catalog itself is
// static and identical for every viewer, so callers should still memoize the
// full dataset in React (useMemo) rather than calling this on every render.
export function generateRatingsReviewsDataset(startDate: string, endDate: string): RatingsReviewsDataset {
  const products = CATALOG.map((entry) => {
    const product = buildProduct(entry, startDate, endDate);
    return product;
  });

  const ratingTrend = buildRatingTrend(products, startDate, endDate);
  products.forEach((p) => {
    // Give each product its own lightweight trend for the per-product drawer,
    // derived from the same walk shape but anchored to its own rating.
    p.ratingTrend = ratingTrend.map((pt, i) => {
      const progress = ratingTrend.length > 1 ? i / (ratingTrend.length - 1) : 1;
      return { ...pt, rating: round1(clamp(p.priorRating + (p.avgRating - p.priorRating) * progress, 1, 5)) };
    });
  });

  const categories = buildCategories(products);
  const platforms = buildPlatforms(products);
  const rootCause = buildRootCause(products);
  const executiveSummary = buildExecutiveSummary(products, rootCause);

  return { products, ratingTrend, categories, platforms, rootCause, executiveSummary };
}
