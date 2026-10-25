// Ratings & Reviews data.
//
// Weekly flow (see supabase/migrations/20261006120000_product_rating_review_history.sql):
//   product_rating_review_metrics  — the LATEST snapshot only, one row per SKU per platform.
//   product_rating_review_history  — every snapshot, keyed by snapshot_date. A trigger copies
//                                    each write to the metrics table here, so data loaded any
//                                    way (dashboard upload, Supabase CSV import) is kept.
//   replace_product_rating_metrics — the upload RPC: replaces the latest snapshot for a date.
//
// The dashboard reads history PER CHANNEL (user, 2026-10-16): each channel's newest snapshot is its
// "current" and the one before it its "previous", so a week where only one channel's file was
// uploaded (e.g. Meesho alone on 14 Oct) no longer hides the others. Changes are current minus
// previous for the same SKU. Channels whose latest snapshot has no rated SKU are left out.
//
// Facts about this data the UI relies on:
//   - Only Amazon and Flipkart carry rating data; other channels are listed with nulls.
//   - rating 0 / null means "not rated yet", never a zero-star average.
//   - Variants of one listing share the listing's rating and review count, so summing
//     review_count per SKU double-counts. Totals dedupe by listing.
//   - "Deleted", "Old", "SKU Changed", "No SKU", "Unknown" are status buckets, not channels.

import * as XLSX from "xlsx";
import { supabasePublic } from "@/lib/amazonReportUpload";
import { reviewCountOf } from "@/lib/ratingCount";

const HISTORY = "product_rating_review_history";
const WEEKLY_VIEW = "product_rating_review_weekly";

const STATUS_BUCKETS = new Set(["deleted", "old", "sku changed", "no sku", "unknown"]);

export type Health = "excellent" | "good" | "watch" | "risk" | "critical" | "unrated";

export const HEALTH_META: Record<Health, { label: string; range: string; color: string }> = {
  excellent: { label: "Excellent", range: "4.5★ +", color: "#10b981" },
  good: { label: "Good", range: "4.0 – 4.4★", color: "#22c55e" },
  watch: { label: "Watch", range: "3.5 – 3.9★", color: "#f59e0b" },
  risk: { label: "At risk", range: "3.0 – 3.4★", color: "#f97316" },
  critical: { label: "Critical", range: "below 3★", color: "#ef4444" },
  unrated: { label: "Not rated", range: "no rating yet", color: "#94a3b8" },
};

export const HEALTH_ORDER: Health[] = ["excellent", "good", "watch", "risk", "critical", "unrated"];

export function healthOf(rating: number | null): Health {
  if (rating === null) return "unrated";
  if (rating >= 4.5) return "excellent";
  if (rating >= 4) return "good";
  if (rating >= 3.5) return "watch";
  if (rating >= 3) return "risk";
  return "critical";
}

export interface RatingItem {
  id: number;
  platform: string;
  skuId: string;
  productName: string;
  price: number | null;
  rating: number | null; // null == not rated
  reviews: number;
  health: Health;
  listingKey: string;
  // Previous snapshot for the same SKU; undefined when there is no previous snapshot
  // at all, null fields when the SKU is new this week.
  prev?: { rating: number | null; reviews: number } | null;
  ratingDelta: number | null; // current - previous, both rated
  reviewsDelta: number | null;
}

export interface WeeklyPoint {
  date: string;
  platform: string;
  avgRating: number | null;
  rated: number;
  below4: number;
}

export interface RatingMetricsData {
  items: RatingItem[];
  snapshotDate: string | null;
  previousDate: string | null;
  snapshotDates: string[]; // newest first
  platformDates: Record<string, { current: string; previous: string | null }>; // per channel shown
  platforms: string[]; // channels with at least one row, rated channels first
  ratedPlatforms: string[];
  weekly: WeeklyPoint[];
}

interface HistoryRow {
  id: number;
  snapshot_date: string;
  platform: string;
  sku_key: string;
  sku_id: string | null;
  product_name: string;
  price: number | string | null;
  rating: number | string | null;
  review_count: number | null;
  ratings_count?: number | null;
}

interface WeeklyRow {
  snapshot_date: string;
  platform: string;
  rated_count: number;
  avg_rating: number | string | null;
  below_4: number;
}

function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function cleanRating(v: number | string | null | undefined): number | null {
  const n = num(v);
  return n && n > 0 ? Math.round(n * 10) / 10 : null;
}

/** Variant names differ only in a trailing "(Dark Blue)" style suffix. */
function baseName(name: string) {
  return name.replace(/\([^)]*\)\s*$/g, "").trim().toLowerCase();
}

async function fetchSnapshot(date: string): Promise<HistoryRow[]> {
  const out: HistoryRow[] = [];
  const PAGE = 1000;
  for (let page = 0; page < 50; page++) {
    const { data, error } = await supabasePublic
      .from(HISTORY)
      .select("id,snapshot_date,platform,sku_key,sku_id,product_name,price,rating,review_count,ratings_count")
      .eq("snapshot_date", date)
      .order("id", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`Fetch ${HISTORY} failed: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...(data as HistoryRow[]));
    if (data.length < PAGE) break;
  }
  return out.filter((r) => !STATUS_BUCKETS.has(r.platform.trim().toLowerCase()));
}

export async function fetchRatingMetrics(): Promise<RatingMetricsData> {
  const { data: weeklyRaw, error } = await supabasePublic
    .from(WEEKLY_VIEW)
    .select("snapshot_date,platform,rated_count,avg_rating,below_4")
    .order("snapshot_date", { ascending: true })
    .limit(5000);
  if (error) throw new Error(`Fetch ${WEEKLY_VIEW} failed: ${error.message}`);
  const weeklyRows = (weeklyRaw ?? []) as WeeklyRow[];

  const snapshotDates = Array.from(new Set(weeklyRows.map((w) => w.snapshot_date))).sort().reverse();

  // Each channel's own newest and previous snapshot (status buckets and unrated-only channels left out).
  const datesBy = new Map<string, { date: string; rated: number }[]>();
  for (const w of weeklyRows) {
    if (STATUS_BUCKETS.has(w.platform.trim().toLowerCase())) continue;
    if (!datesBy.has(w.platform)) datesBy.set(w.platform, []);
    datesBy.get(w.platform)!.push({ date: w.snapshot_date, rated: Number(w.rated_count) || 0 });
  }
  const platformDates: RatingMetricsData["platformDates"] = {};
  for (const [p, ds] of datesBy) {
    const sorted = [...new Set(ds.map((d) => d.date))].sort().reverse();
    const latest = ds.filter((d) => d.date === sorted[0]).reduce((a, d) => a + d.rated, 0);
    if (latest > 0) platformDates[p] = { current: sorted[0], previous: sorted[1] ?? null };
  }
  const currents = Object.values(platformDates).map((d) => d.current).sort().reverse();
  const previouses = Object.values(platformDates).map((d) => d.previous).filter((d): d is string => !!d).sort().reverse();
  const snapshotDate = currents[0] ?? null;
  const previousDate = previouses[0] ?? null;

  const needed = [...new Set([...currents, ...previouses])];
  const byDate = new Map(await Promise.all(needed.map(async (d) => [d, await fetchSnapshot(d)] as const)));
  const current = Object.entries(platformDates).flatMap(([p, d]) => (byDate.get(d.current) ?? []).filter((r) => r.platform === p));
  const previous = Object.entries(platformDates).flatMap(([p, d]) => (d.previous ? (byDate.get(d.previous) ?? []).filter((r) => r.platform === p) : []));

  const prevByKey = new Map<string, HistoryRow>();
  for (const p of previous) prevByKey.set(`${p.platform}|${p.sku_key}`, p);

  const items: RatingItem[] = current.map((r) => {
    const rating = cleanRating(r.rating);
    const reviews = num(reviewCountOf(r)) ?? 0;
    const price = num(r.price);
    const productName = r.product_name.trim() || r.sku_id || "Unnamed";
    let prev: RatingItem["prev"];
    if (platformDates[r.platform]?.previous) {
      const p = prevByKey.get(`${r.platform}|${r.sku_key}`);
      prev = p ? { rating: cleanRating(p.rating), reviews: num(reviewCountOf(p)) ?? 0 } : null;
    }
    const ratingDelta =
      prev && prev.rating !== null && rating !== null ? Math.round((rating - prev.rating) * 10) / 10 : null;
    const reviewsDelta = prev && rating !== null ? reviews - prev.reviews : null;
    return {
      id: r.id,
      platform: r.platform,
      skuId: r.sku_id ?? "",
      productName,
      price: price && price > 0 ? price : null,
      rating,
      reviews,
      health: healthOf(rating),
      listingKey: `${r.platform}|${baseName(productName)}|${rating ?? "-"}|${reviews}`,
      prev,
      ratingDelta,
      reviewsDelta,
    };
  });

  const counts = new Map<string, { n: number; rated: number }>();
  for (const i of items) {
    const c = counts.get(i.platform) ?? { n: 0, rated: 0 };
    c.n++;
    if (i.rating !== null) c.rated++;
    counts.set(i.platform, c);
  }
  const platforms = Array.from(counts.entries())
    .sort((a, b) => b[1].rated - a[1].rated || b[1].n - a[1].n)
    .map(([p]) => p);

  return {
    items,
    snapshotDate,
    previousDate,
    snapshotDates,
    platformDates,
    platforms,
    ratedPlatforms: platforms.filter((p) => (counts.get(p)?.rated ?? 0) > 0),
    weekly: weeklyRows
      .filter((w) => w.rated_count > 0)
      .map((w) => ({
        date: w.snapshot_date,
        platform: w.platform,
        avgRating: num(w.avg_rating),
        rated: w.rated_count,
        below4: w.below_4,
      })),
  };
}

export interface RatingSummary {
  skus: number;
  rated: number;
  unrated: number;
  avgRating: number | null; // simple mean across rated SKUs
  weightedRating: number | null; // review-weighted, deduped by listing
  totalReviews: number; // deduped by listing
  below4: number;
  below3: number;
  health: Record<Health, number>;
}

export function summarize(items: RatingItem[]): RatingSummary {
  const health = Object.fromEntries(HEALTH_ORDER.map((h) => [h, 0])) as Record<Health, number>;
  let ratedSum = 0;
  let rated = 0;
  let below4 = 0;
  let below3 = 0;
  const listings = new Map<string, RatingItem>();
  for (const i of items) {
    health[i.health]++;
    if (i.rating === null) continue;
    rated++;
    ratedSum += i.rating;
    if (i.rating < 4) below4++;
    if (i.rating < 3) below3++;
    listings.set(i.listingKey, i);
  }
  let totalReviews = 0;
  let w = 0;
  for (const l of listings.values()) {
    totalReviews += l.reviews;
    w += l.reviews * (l.rating ?? 0);
  }
  return {
    skus: items.length,
    rated,
    unrated: items.length - rated,
    avgRating: rated ? Math.round((ratedSum / rated) * 100) / 100 : null,
    weightedRating: totalReviews ? Math.round((w / totalReviews) * 100) / 100 : null,
    totalReviews,
    below4,
    below3,
    health,
  };
}

/** The same summary for the previous snapshot, rebuilt from each item's `prev`. */
export function summarizePrevious(items: RatingItem[]): RatingSummary | null {
  if (!items.some((i) => i.prev !== undefined)) return null;
  const prevItems: RatingItem[] = [];
  for (const i of items) {
    if (!i.prev) continue;
    prevItems.push({
      ...i,
      rating: i.prev.rating,
      reviews: i.prev.reviews,
      health: healthOf(i.prev.rating),
      listingKey: `${i.platform}|${baseName(i.productName)}|${i.prev.rating ?? "-"}|${i.prev.reviews}`,
    });
  }
  return summarize(prevItems);
}

export interface CrossPlatformRow {
  name: string;
  a: { platform: string; rating: number; reviews: number };
  b: { platform: string; rating: number; reviews: number };
  gap: number; // a - b
}

// ── Listings ─────────────────────────────────────────────────────────────────
// A listing is what the shopper sees: one rating + review count shared by its variant
// SKUs (colours, pack sizes). Analysis runs on listings so one product isn't counted 4×.

/** Below this many reviews a rating is one or two opinions, not a signal. */
export const MIN_REVIEWS = 5;

export interface Listing {
  key: string;
  platform: string;
  name: string;
  rating: number | null;
  reviews: number;
  health: Health;
  priceMin: number | null;
  priceMax: number | null;
  skus: RatingItem[];
  ratingDelta: number | null;
  reviewsDelta: number | null;
  prevRating: number | null;
  isNew: boolean; // every variant is new this snapshot
  lowConfidence: boolean; // rated, but fewer than MIN_REVIEWS reviews
}

function stripVariant(name: string) {
  return name.replace(/\s*\([^)]*\)\s*$/g, "").trim() || name;
}

export function groupListings(items: RatingItem[]): Listing[] {
  const map = new Map<string, RatingItem[]>();
  for (const i of items) {
    const arr = map.get(i.listingKey);
    if (arr) arr.push(i);
    else map.set(i.listingKey, [i]);
  }
  const out: Listing[] = [];
  for (const [key, skus] of map) {
    const first = skus[0];
    const sameName = skus.every((s) => s.productName === first.productName);
    const prices = skus.map((s) => s.price).filter((p): p is number => p !== null);
    out.push({
      key,
      platform: first.platform,
      name: sameName ? first.productName : stripVariant(first.productName),
      rating: first.rating,
      reviews: first.reviews,
      health: first.health,
      priceMin: prices.length ? Math.min(...prices) : null,
      priceMax: prices.length ? Math.max(...prices) : null,
      skus,
      ratingDelta: first.ratingDelta,
      reviewsDelta: first.reviewsDelta,
      prevRating: first.prev?.rating ?? null,
      isNew: skus.every((s) => s.prev === null),
      lowConfidence: first.rating !== null && first.reviews < MIN_REVIEWS,
    });
  }
  return out;
}

/**
 * How much a listing's rating is costing: stars below 4 × reach. Reach is √reviews so a
 * 3.6★ listing seen by 200 reviewers outranks a 2.8★ one with 9, without letting volume
 * alone bury genuinely poor ratings.
 */
export function listingImpact(l: Listing) {
  if (l.rating === null || l.rating >= 4 || l.lowConfidence) return 0;
  return (4 - l.rating) * Math.sqrt(l.reviews);
}

/** Same product rated on two channels with enough reviews on both — biggest gaps first. */
export function crossPlatformListings(listings: Listing[], pa: string, pb: string): CrossPlatformRow[] {
  const pick = (p: string) => {
    const m = new Map<string, Listing>();
    for (const l of listings) {
      if (l.platform !== p || l.rating === null || l.reviews < MIN_REVIEWS) continue;
      const k = l.name.toLowerCase();
      const prev = m.get(k);
      if (!prev || l.reviews > prev.reviews) m.set(k, l);
    }
    return m;
  };
  const A = pick(pa);
  const B = pick(pb);
  const out: CrossPlatformRow[] = [];
  for (const [k, x] of A) {
    const y = B.get(k);
    if (!y) continue;
    out.push({
      name: x.name,
      a: { platform: pa, rating: x.rating!, reviews: x.reviews },
      b: { platform: pb, rating: y.rating!, reviews: y.reviews },
      gap: Math.round((x.rating! - y.rating!) * 10) / 10,
    });
  }
  return out.sort((p, q) => Math.abs(q.gap) - Math.abs(p.gap) || q.a.reviews + q.b.reviews - (p.a.reviews + p.b.reviews));
}

// ── Weekly upload ────────────────────────────────────────────────────────────

export interface UploadRow {
  platform: string;
  sku_id: string | null;
  product_name: string;
  master_product_skuid: string | null;
  price: number | null;
  rating: number | null;
  review_count: number | null;
}

export interface ParsedUpload {
  rows: UploadRow[];
  skipped: number; // rows without platform or product name
  platforms: Record<string, number>;
  rated: number;
  missingColumns: string[];
}

// Header aliases, matched after lower-casing and stripping spaces/underscores/punctuation.
const COLUMN_ALIASES: Record<keyof UploadRow, string[]> = {
  platform: ["platform", "marketplace", "channel"],
  sku_id: ["skuid", "sku"],
  product_name: ["productname", "product", "name", "title"],
  master_product_skuid: ["masterproductskuid", "masterskuid", "mastersku"],
  price: ["price", "sellingprice"],
  rating: ["rating", "ratings", "starrating", "stars", "star"],
  review_count: ["reviewcount", "reviews", "noofreviews", "totalreviews", "ratingcount", "ratingscount"],
};

const REQUIRED: (keyof UploadRow)[] = ["platform", "product_name", "rating", "review_count"];

const normHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[₹,\s]/g, "").replace(/★/g, "");
  if (!s || /^(na|n\/a|nil|-|null)$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export async function parseRatingUpload(file: File): Promise<ParsedUpload> {
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null, raw: true });
  const headers = raw.length ? Object.keys(raw[0]) : [];

  const colFor = {} as Record<keyof UploadRow, string | undefined>;
  for (const key of Object.keys(COLUMN_ALIASES) as (keyof UploadRow)[]) {
    colFor[key] = headers.find((h) => COLUMN_ALIASES[key].includes(normHeader(h)));
  }
  const missingColumns = REQUIRED.filter((k) => !colFor[k]).map((k) => k.replace("_", " "));

  const rows: UploadRow[] = [];
  let skipped = 0;
  const platforms: Record<string, number> = {};
  let rated = 0;
  if (missingColumns.length === 0) {
    for (const r of raw) {
      const get = (k: keyof UploadRow) => (colFor[k] ? r[colFor[k]!] : null);
      const platform = String(get("platform") ?? "").trim();
      const product = String(get("product_name") ?? "").trim();
      if (!platform || !product) {
        skipped++;
        continue;
      }
      const sku = String(get("sku_id") ?? "").trim();
      const master = String(get("master_product_skuid") ?? "").trim();
      const rating = toNumber(get("rating"));
      const reviews = toNumber(get("review_count"));
      rows.push({
        platform,
        sku_id: sku || null,
        product_name: product,
        master_product_skuid: master || null,
        price: toNumber(get("price")),
        rating: rating !== null && rating >= 0 && rating <= 5 ? rating : null,
        review_count: reviews !== null && reviews >= 0 ? Math.round(reviews) : null,
      });
      platforms[platform] = (platforms[platform] ?? 0) + 1;
      if (rating && rating > 0) rated++;
    }
  }
  return { rows, skipped, platforms, rated, missingColumns };
}

export async function uploadRatingSnapshot(rows: UploadRow[], snapshotDate: string) {
  const { data, error } = await supabasePublic.rpc("replace_product_rating_metrics", {
    p_rows: rows,
    p_snapshot_date: snapshotDate,
  });
  if (error) throw new Error(error.message);
  return data as { snapshot_date: string; rows: number };
}
