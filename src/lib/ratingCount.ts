// Dependency-free so it can be unit tested (productRatingMetrics.ts reads Supabase).

/** The count shown next to a listing's stars. Amazon shows "N ratings": the weekly collector writes it
 *  to ratings_count since 19 Oct 2026 and leaves review_count empty or 0, while older sheet uploads put
 *  the same number in review_count. Other channels keep review_count (Flipkart's ratings_count is its
 *  much larger star-only count). */
export function reviewCountOf(r: { platform: string; review_count: number | null; ratings_count?: number | null }): number | null {
  const ratings = r.ratings_count === null || r.ratings_count === undefined ? null : Number(r.ratings_count);
  if (/^amazon$/i.test(r.platform.trim()) && ratings !== null && Number.isFinite(ratings)) return ratings;
  return r.review_count;
}
