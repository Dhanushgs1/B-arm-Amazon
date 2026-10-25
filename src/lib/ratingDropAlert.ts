// Weekly "rating dropped below 4★" email (user, 2026-10-12): listings rated 4★ or higher in the
// previous weekly ratings snapshot and below 4★ in the latest one, at any review count (the 5-review
// floor was dropped on 2026-10-12 so a Flipkart listing with 1 review still shows). Sent on Mondays once that week's ratings upload is in — see
// src/pages/api/rating-drop-alert.ts. Pure helpers only; the route does the I/O.

import type { Listing } from "@/lib/productRatingMetrics";

export const RATING_DROP_LIMIT = 4;
/** Any rated listing counts — user, 2026-10-12: "Flange Finder Kit" (1 review) must be included. */
export const RATING_DROP_MIN_REVIEWS = 1;

/** A snapshot older than this is last week's data, not "this week's ratings came in". */
// 7 days, not 6: an upload made last Monday AFTER that day's 9 AM run (19 Oct 2026) goes out the next
// Monday instead of being skipped. Already-mailed channel snapshots are never re-sent (platformsToMail).
export const RATING_SNAPSHOT_MAX_AGE_DAYS = 7;

export interface RatingDrop {
  platform: string;
  name: string;
  skus: string[];
  prevRating: number;
  rating: number;
  prevReviews: number | null;
  reviews: number;
  url: string | null;
}

/** Listings that crossed from ≥4★ to <4★, lowest rating first, then most reviews. */
export function findRatingDrops(listings: Listing[], minReviews = RATING_DROP_MIN_REVIEWS): Listing[] {
  return listings
    .filter((l) => l.prevRating !== null && l.prevRating >= RATING_DROP_LIMIT
      && l.rating !== null && l.rating < RATING_DROP_LIMIT && l.reviews >= minReviews)
    .sort((a, b) => (a.rating as number) - (b.rating as number) || b.reviews - a.reviews || a.name.localeCompare(b.name));
}

/** "B-INST-BW-Bl-2(AM)" → "B-INST-BW-Bl-2": the ratings sheet tags each SKU with its channel. */
export function bareSku(skuId: string): string {
  return skuId.replace(/\s*\((AM|FK|[A-Z]{1,4})\)\s*$/, "").trim();
}

/** Product page for a listing: Amazon by ASIN, Flipkart by FSN. Null when the id is unknown. */
export function productUrl(platform: string, id: string | null | undefined): string | null {
  if (!id) return null;
  if (/^amazon$/i.test(platform)) return `https://www.amazon.in/dp/${encodeURIComponent(id)}`;
  if (/^flipkart$/i.test(platform)) return `https://www.flipkart.com/product/p/itme?pid=${encodeURIComponent(id)}`;
  return null;
}

/** Whole days between two YYYY-MM-DD dates (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
}

/** Is the snapshot ready to mail? Ratings reach Supabase from the weekly collection, which is dated the
 *  Monday it starts and fills in over the next days (19 Oct 2026: collected 19–21 Oct) — so a snapshot
 *  dated today may still be half-collected and is left for next Monday's run. Ready = 1 to
 *  RATING_SNAPSHOT_MAX_AGE_DAYS days old (IST). */
export function isThisWeeksSnapshot(snapshotDate: string, todayIst: string): boolean {
  const age = daysBetween(snapshotDate, todayIst);
  return age >= 1 && age <= RATING_SNAPSHOT_MAX_AGE_DAYS;
}

export function toRatingDrop(l: Listing, idBySku: Map<string, string>): RatingDrop {
  const skus = l.skus.map((s) => s.skuId).filter(Boolean);
  const id = skus.map((s) => idBySku.get(bareSku(s))).find(Boolean) ?? null;
  const prevReviews = l.reviewsDelta === null ? null : l.reviews - l.reviewsDelta;
  return {
    platform: l.platform, name: l.name, skus,
    prevRating: l.prevRating as number, rating: l.rating as number,
    prevReviews, reviews: l.reviews, url: productUrl(l.platform, id),
  };
}

/** State entity for one channel's snapshot, e.g. "Amazon|2026-10-19". */
export const platformSnapshotKey = (platform: string, date: string) => `${platform}|${date}`;

/** Channels whose newest snapshot still needs mailing: taken this week, and not mailed before.
 *  Each channel uploads on its own day, so one mail per channel snapshot — otherwise a later upload
 *  of one channel (Meesho 14 Oct) re-sent another channel's already-mailed drops (Amazon 12 Oct),
 *  which is what happened on 19 Oct 2026. `sent` holds the state entity_ids already recorded:
 *  "Platform|date", or (before this fix) a plain date meaning every channel snapshot up to it. */
export function platformsToMail(
  platformDates: Record<string, { current: string; previous: string | null }>,
  sent: string[],
  todayIst: string,
): { platform: string; current: string; previous: string }[] {
  const sentSet = new Set(sent);
  const legacy = sent.filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)).sort();
  const lastLegacy = legacy[legacy.length - 1] ?? "";
  return Object.entries(platformDates)
    .filter((e): e is [string, { current: string; previous: string }] => !!e[1].previous)
    .filter(([p, d]) => isThisWeeksSnapshot(d.current, todayIst) && !sentSet.has(platformSnapshotKey(p, d.current)) && d.current > lastLegacy)
    .map(([platform, d]) => ({ platform, current: d.current, previous: d.previous }));
}
