// Real ratings/reviews data, loaded from public.barm_rating_review — the weekly
// "AM & FK Rating and Review sheet" tracker, imported from its "Overall" tab.
//
// WHAT THIS SOURCE ACTUALLY CONTAINS, and why half the Ratings & Reviews UI stays
// hidden when it is in use:
//
//   live  — star rating per SKU per week, rating counts, text-review counts,
//           order units, return units, latched-seller notes, 118 weekly snapshots
//           per SKU from 2024-04-05 onward across 12 sales channels.
//   NOT   — per-star (1★..5★) distribution, review sentiment, review keywords,
//           return *reasons*, and revenue. The tracker records the aggregate star
//           value and counts only; it never captured review text, a star
//           histogram, or per-order value. `price` exists but is populated on
//           under 1% of rows, so no revenue figure can be derived from it.
//
// Those absent fields are returned as zeros/empty arrays and listed in
// `source.unavailable`, and RatingsReviewsIntelligence hides the panels that
// depend on them. They are deliberately NOT back-filled with generated numbers:
// the mock generator in ratingsReviewsData.ts exists for the demo path, and
// mixing its output into a real dataset would present fabricated sentiment as
// measured fact.
//
// star_value = 0 in the sheet means "no rating yet", not a zero-star average, so
// it is treated as absent everywhere an average is computed. Including the zeros
// drags the catalog average from ~4.24★ down to ~1.62★.

import { supabasePublic } from "@/lib/amazonReportUpload";
import {
  healthTier,
  ratingTier,
  type CategoryInsight,
  type PlatformSummary,
  type RatingsReviewsDataset,
  type RatingTrendPoint,
  type RRPlatform,
  type RRProduct,
} from "@/lib/ratingsReviewsData";

const TABLE = "barm_rating_review";
const SNAPSHOT_VIEW = "barm_rating_review_snapshots";
const WEEKLY_VIEW = "barm_rating_review_weekly";

/** Metrics this source cannot supply, surfaced to the UI so it can hide them. */
export const SHEET_UNAVAILABLE = [
  "Review sentiment (positive / negative / neutral split)",
  "Review keywords and complaint themes",
  "Per-star (1★–5★) rating distribution",
  "Return reasons",
  "Revenue and revenue-at-risk",
] as const;

export const CHANNEL_LABEL: Record<string, string> = {
  amazon: "Amazon",
  amazon_ca: "Amazon CA",
  amazon_us: "Amazon US",
  flipkart: "Flipkart",
  shopsy: "Shopsy",
  meesho: "Meesho",
  jiomart: "JioMart",
  blinkit: "Blinkit",
  barm: "B-Arm (own)",
  sbi: "SBI",
  "1mg": "1mg",
};

export function channelLabel(mkt: string | null | undefined): string {
  if (!mkt) return "Unmapped";
  return CHANNEL_LABEL[mkt] ?? mkt;
}

interface RawRow {
  product: string | null;
  sku_id: string | null;
  asin_fsn: string | null;
  marketplace: string | null;
  snapshot_date: string;
  star_value: number | string | null;
  ratings_count: number | null;
  reviews_count: number | null;
  latch_on_seller: string | null;
  orders: number | null;
  returns_count: number | null;
}

interface WeeklyRow {
  snapshot_date: string;
  marketplace: string | null;
  sku_count: number;
  rated_sku_count: number;
  wavg_star: number | string | null;
  avg_star: number | string | null;
  total_ratings: number | string | null;
  total_reviews: number | string | null;
  total_orders: number | string | null;
  total_returns: number | string | null;
  below_4: number;
  below_3: number;
}

function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** star_value 0 == "not rated yet" in the tracker. */
function star(v: number | string | null | undefined): number | null {
  const n = num(v);
  return n && n > 0 ? n : null;
}

function round1(v: number) {
  return Math.round(v * 10) / 10;
}

function pctChange(now: number | null, before: number | null): number {
  if (now === null || before === null || before === 0) return 0;
  return round1(((now - before) / before) * 100);
}

function fmtDayLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", { month: "short", day: "numeric" });
}

function weightedAvg(items: { value: number; weight: number }[]): number {
  const w = items.reduce((a, i) => a + i.weight, 0);
  if (!w) return items.length ? items.reduce((a, i) => a + i.value, 0) / items.length : 0;
  return items.reduce((a, i) => a + i.value * i.weight, 0) / w;
}

// Paged read — a single snapshot is ~2.3k SKUs, over PostgREST's default 1000-row cap.
async function fetchPaged<T>(
  table: string,
  apply: (q: ReturnType<typeof supabasePublic.from>) => unknown
): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  for (let page = 0; page < 400; page++) {
    const q = apply(supabasePublic.from(table)) as {
      range: (a: number, b: number) => Promise<{ data: T[] | null; error: { message: string } | null }>;
    };
    const { data, error } = await q.range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`Fetch ${table} failed: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

export interface SheetSourceInfo {
  kind: "sheet";
  currentDate: string;
  priorDate: string | null;
  snapshotCount: number;
  snapshotsInRange: number;
  rangeFellBack: boolean;
  unavailable: readonly string[];
}

/**
 * Picks which weekly snapshots to compare for a dashboard date range.
 *
 * The tracker is weekly and ends at a fixed date, so an arbitrary dashboard range
 * often contains 0 or 1 snapshots. Rather than render an empty tab, fall back to
 * the newest snapshot at/before `endDate` (or the newest overall) and report
 * `rangeFellBack` so the UI can say which week it is actually showing.
 */
function pickSnapshots(all: string[], startDate: string, endDate: string) {
  const inRange = all.filter((d) => (!startDate || d >= startDate) && (!endDate || d <= endDate));
  if (inRange.length >= 2) {
    return { current: inRange[inRange.length - 1], prior: inRange[0], inRange: inRange.length, fellBack: false };
  }
  if (inRange.length === 1) {
    const idx = all.indexOf(inRange[0]);
    return { current: inRange[0], prior: idx > 0 ? all[idx - 1] : null, inRange: 1, fellBack: false };
  }
  const atOrBefore = all.filter((d) => !endDate || d <= endDate);
  const pool = atOrBefore.length ? atOrBefore : all;
  const current = pool[pool.length - 1];
  const idx = all.indexOf(current);
  return { current, prior: idx > 0 ? all[idx - 1] : null, inRange: 0, fellBack: true };
}

function buildProduct(cur: RawRow, prev: RawRow | undefined): RRProduct {
  const avgRating = star(cur.star_value);
  const priorRating = star(prev?.star_value);
  const ratingsCount = num(cur.ratings_count) ?? 0;
  const textReviewCount = num(cur.reviews_count) ?? 0;
  const ordersCount = num(cur.orders) ?? 0;
  const priorOrders = num(prev?.orders);
  const totalReturns = num(cur.returns_count) ?? 0;

  const returnRate = ordersCount > 0 ? round1((totalReturns / ordersCount) * 100) : 0;
  const ordersChangePct = pctChange(ordersCount || null, priorOrders);

  const platform = (cur.marketplace ?? "other") as RRPlatform;
  const rating = avgRating ?? 0;

  // Health score from the three signals this source genuinely has: rating level,
  // rating movement, and return rate. The mock's version also folds in sentiment
  // and revenue, which are absent here, so the weights are redistributed rather
  // than defaulted — a product with no rating yet scores 0 and sorts as unknown.
  const healthScore = avgRating === null
    ? 0
    : Math.round(
        Math.max(0, Math.min(100,
          (rating / 5) * 60 +
          (1 - Math.min(returnRate, 30) / 30) * 25 +
          (priorRating === null ? 15 : rating >= priorRating ? 15 : Math.max(0, 15 + (rating - priorRating) * 30))
        ))
      );

  const recommendations: string[] = [];
  if (avgRating !== null && rating < 3.5) recommendations.push("Investigate Product Quality");
  if (avgRating !== null && priorRating !== null && rating < priorRating - 0.05) recommendations.push("Rating Declining — Review Recent Feedback");
  if (returnRate > 18) recommendations.push("High Return Rate — Check Packaging & Listing Accuracy");
  if (avgRating !== null && rating >= 4.2 && ratingsCount < 300) recommendations.push("Request Positive Reviews");
  if (ratingsCount < 50) recommendations.push("Launch Review Campaign");
  if (cur.latch_on_seller) recommendations.push("Latched Seller Detected — Verify Buy Box");
  if (recommendations.length === 0) recommendations.push("Maintain Current Quality Standards");

  return {
    id: `${platform}-${cur.sku_id ?? cur.asin_fsn ?? "unknown"}`,
    name: cur.product?.trim() || cur.sku_id || cur.asin_fsn || "Unnamed product",
    sku: cur.sku_id ?? cur.asin_fsn ?? "—",
    category: "Uncategorised",
    platform,
    brand: "B-Arm",
    avgRating: avgRating ?? 0,
    priorRating: priorRating ?? avgRating ?? 0,
    reviewCount: ratingsCount,
    // Absent from this source — see SHEET_UNAVAILABLE.
    ratingDistribution: [],
    positivePct: 0,
    negativePct: 0,
    neutralPct: 0,
    positiveKeywords: [],
    negativeKeywords: [],
    reviewSummary:
      avgRating === null
        ? "No rating recorded for this SKU in the selected week."
        : `${rating.toFixed(1)}★ from ${ratingsCount.toLocaleString("en-IN")} ratings` +
          (textReviewCount ? ` and ${textReviewCount.toLocaleString("en-IN")} written reviews` : "") +
          `. This tracker records the aggregate star value only — it holds no review text, so sentiment and keyword themes are not available.`,
    ratingTrend: [],
    sales: 0,
    salesChangePct: ordersChangePct,
    ordersChangePct,
    returnRate,
    totalReturns,
    returnReasons: [],
    estimatedRevenueLost: 0,
    aiConfidence: 0,
    healthScore,
    healthStatus: healthTier(healthScore),
    ratingStatus: ratingTier(rating),
    actionRequired: recommendations[0],
    recommendations: recommendations.slice(0, 5),

    // Real extras this source does have.
    ratingsCount,
    textReviewCount,
    ordersCount,
    priorOrdersCount: priorOrders ?? undefined,
    latchOnSeller: cur.latch_on_seller ?? undefined,
    asin: cur.asin_fsn ?? undefined,
    hasRating: avgRating !== null,
  };
}

function buildPlatforms(products: RRProduct[]): PlatformSummary[] {
  const byPlatform = new Map<string, RRProduct[]>();
  products.forEach((p) => {
    const list = byPlatform.get(p.platform) || [];
    list.push(p);
    byPlatform.set(p.platform, list);
  });
  return Array.from(byPlatform.entries())
    .map(([platform, list]) => {
      const rated = list.filter((p) => p.hasRating);
      return {
        platform: platform as RRPlatform,
        label: channelLabel(platform),
        productCount: list.length,
        avgRating: round1(weightedAvg(rated.map((p) => ({ value: p.avgRating, weight: p.reviewCount })))),
        totalReviews: list.reduce((a, p) => a + p.reviewCount, 0),
        totalReturns: list.reduce((a, p) => a + p.totalReturns, 0),
        negativeReviewPct: 0,
        salesImpact: 0,
        healthScore: rated.length ? Math.round(rated.reduce((a, p) => a + p.healthScore, 0) / rated.length) : 0,
      };
    })
    .sort((a, b) => b.totalReviews - a.totalReviews);
}

function buildRootCause(products: RRProduct[], currentDate: string, priorDate: string | null): string[] {
  const declining = products
    .filter((p) => p.hasRating && p.priorRating > 0 && p.avgRating < p.priorRating - 0.05)
    .sort((a, b) => (a.avgRating - a.priorRating) - (b.avgRating - b.priorRating))
    .slice(0, 5);

  const out: string[] = [];
  if (!priorDate) {
    out.push(`Only one weekly snapshot (${currentDate}) falls in this range, so week-on-week rating movement cannot be computed. Widen the date range to compare weeks.`);
  } else if (declining.length === 0) {
    out.push(`No SKU lost rating between ${priorDate} and ${currentDate} — star values held steady or improved across the rated catalog.`);
  } else {
    declining.forEach((p) => {
      const delta = round1(p.avgRating - p.priorRating);
      const bits = [`${p.name} (${p.sku}, ${channelLabel(p.platform)}): rating fell ${Math.abs(delta)}★ from ${p.priorRating.toFixed(1)}★ to ${p.avgRating.toFixed(1)}★ on ${p.reviewCount.toLocaleString("en-IN")} ratings`];
      if (p.returnRate > 0) bits.push(`${p.returnRate}% return rate (${p.totalReturns} of ${p.ordersCount ?? 0} orders)`);
      if (p.latchOnSeller) bits.push(`latched seller noted: ${p.latchOnSeller}`);
      out.push(bits.join("; ") + ".");
    });
  }

  const highReturn = products.filter((p) => p.returnRate > 18 && (p.ordersCount ?? 0) >= 10);
  if (highReturn.length) {
    out.push(`${highReturn.length} SKU${highReturn.length > 1 ? "s" : ""} with 10+ orders show a return rate above 18% — the tracker records return counts but not return reasons, so the cause needs checking in the marketplace returns report.`);
  }
  return out;
}

export interface BarmRatingsReviewsDataset extends RatingsReviewsDataset {
  source: SheetSourceInfo;
}

/**
 * Loads the real dataset for a dashboard date range. Returns the same shape the
 * mock generator does, so the UI needs no structural change — but with
 * `source.unavailable` populated so it can hide what this source cannot back.
 */
export async function fetchBarmRatingsReviewsDataset(
  startDate: string,
  endDate: string
): Promise<BarmRatingsReviewsDataset> {
  const snapshots = await fetchPaged<{ snapshot_date: string }>(SNAPSHOT_VIEW, (q) =>
    (q as unknown as { select: (s: string) => { order: (c: string, o: { ascending: boolean }) => unknown } })
      .select("snapshot_date")
      .order("snapshot_date", { ascending: true })
  );
  const allDates = snapshots.map((s) => s.snapshot_date);
  if (allDates.length === 0) {
    throw new Error(
      `No rows in ${TABLE} yet — import the "AM & FK Rating and Review sheet" before using this tab.`
    );
  }

  const { current, prior, inRange, fellBack } = pickSnapshots(allDates, startDate, endDate);
  const wanted = prior ? [prior, current] : [current];

  const [rows, weekly] = await Promise.all([
    fetchPaged<RawRow>(TABLE, (q) =>
      (q as unknown as { select: (s: string) => { in: (c: string, v: string[]) => unknown } })
        .select("product,sku_id,asin_fsn,marketplace,snapshot_date,star_value,ratings_count,reviews_count,latch_on_seller,orders,returns_count")
        .in("snapshot_date", wanted)
    ),
    fetchPaged<WeeklyRow>(WEEKLY_VIEW, (q) =>
      (q as unknown as { select: (s: string) => { order: (c: string, o: { ascending: boolean }) => unknown } })
        .select("snapshot_date,marketplace,sku_count,rated_sku_count,wavg_star,avg_star,total_ratings,total_reviews,total_orders,total_returns,below_4,below_3")
        .order("snapshot_date", { ascending: true })
    ),
  ]);

  const keyOf = (r: RawRow) => `${r.sku_id ?? ""}|${r.asin_fsn ?? ""}`;
  const curRows = rows.filter((r) => r.snapshot_date === current);
  const prevByKey = new Map<string, RawRow>();
  if (prior) rows.filter((r) => r.snapshot_date === prior).forEach((r) => prevByKey.set(keyOf(r), r));

  const products = curRows.map((r) => buildProduct(r, prevByKey.get(keyOf(r))));

  // Rating trend from the weekly rollup: one ratings-weighted point per week
  // across all channels. This is real history — 118 weeks from 2024-04-05.
  const byDate = new Map<string, WeeklyRow[]>();
  weekly.forEach((w) => {
    const list = byDate.get(w.snapshot_date) || [];
    list.push(w);
    byDate.set(w.snapshot_date, list);
  });
  const ratingTrend: RatingTrendPoint[] = Array.from(byDate.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, list]) => {
      const pts = list
        .map((w) => ({ value: num(w.wavg_star) ?? num(w.avg_star), weight: num(w.total_ratings) ?? 0 }))
        .filter((p): p is { value: number; weight: number } => p.value !== null);
      return { rawDate: date, date: fmtDayLabel(date), rating: round1(weightedAvg(pts)) };
    })
    .filter((p) => p.rating > 0);

  // Per-product trend across every week the SKU appears would need the full
  // 156k-row table client-side; the drawer instead gets the two weeks compared.
  products.forEach((p) => {
    p.ratingTrend = [
      ...(prior && p.priorRating > 0
        ? [{ rawDate: prior, date: fmtDayLabel(prior), rating: p.priorRating }]
        : []),
      ...(p.hasRating ? [{ rawDate: current, date: fmtDayLabel(current), rating: p.avgRating }] : []),
    ];
  });

  const categories: CategoryInsight[] = [];
  const platforms = buildPlatforms(products);
  const rootCause = buildRootCause(products, current, prior);

  const rated = products.filter((p) => p.hasRating);
  const needsAction = [...rated]
    .filter((p) => p.avgRating < 4)
    .sort((a, b) => a.avgRating - b.avgRating)
    .slice(0, 5)
    .map((p) => `${p.name} (${p.sku}) — ${p.avgRating.toFixed(1)}★`);
  const topPerforming = [...rated]
    .filter((p) => p.reviewCount >= 20)
    .sort((a, b) => b.avgRating - a.avgRating || b.reviewCount - a.reviewCount)
    .slice(0, 3)
    .map((p) => `${p.name} (${p.sku}) — ${p.avgRating.toFixed(1)}★`);

  const businessRisks: string[] = [];
  const below3 = rated.filter((p) => p.avgRating < 3).length;
  if (below3) businessRisks.push(`${below3} rated SKU${below3 > 1 ? "s" : ""} below 3★ — at risk of suppressed rank and buy-box loss.`);
  const highReturn = products.filter((p) => p.returnRate > 18 && (p.ordersCount ?? 0) >= 10).length;
  if (highReturn) businessRisks.push(`${highReturn} SKU${highReturn > 1 ? "s" : ""} with 10+ orders returning above 18%.`);
  const unrated = products.length - rated.length;
  if (unrated) businessRisks.push(`${unrated} of ${products.length} SKUs carry no rating in this week — no review signal to act on yet.`);
  if (businessRisks.length === 0) businessRisks.push("No major risk signals in this week's snapshot.");

  const recCounts = new Map<string, number>();
  products.forEach((p) => p.recommendations.forEach((r) => recCounts.set(r, (recCounts.get(r) || 0) + 1)));
  const topRecommendations = Array.from(recCounts.entries())
    .map(([text, count]) => ({
      text,
      count,
      priority: (count / Math.max(products.length, 1) > 0.35 ? "High" : count / Math.max(products.length, 1) > 0.15 ? "Medium" : "Low") as "High" | "Medium" | "Low",
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  return {
    products,
    ratingTrend,
    categories,
    platforms,
    rootCause,
    executiveSummary: {
      topPerforming,
      needsAction,
      commonComplaints: [],
      commonReturnReasons: [],
      businessRisks,
      revenueImpact: 0,
      topRecommendations,
    },
    source: {
      kind: "sheet",
      currentDate: current,
      priorDate: prior,
      snapshotCount: allDates.length,
      snapshotsInRange: inRange,
      rangeFellBack: fellBack,
      unavailable: SHEET_UNAVAILABLE,
    },
  };
}
