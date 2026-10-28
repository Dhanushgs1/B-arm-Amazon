// Campaign ranking rules for the Key Insights "Best performing" and "Campaigns to optimize" lists.
//
// ACOS = CPC / price, where CPC = Spend+Tax / Advertised SKU Units (historicalAnalysisReportExport.ts).
// That formula returns 0 when the price is missing or zero, so a campaign with no price, or with
// no attributed units, showed "ACOS 0.00%" and was ranked best. A 0% ACOS is only meaningful when
// the campaign has a real price, attributed units and spend. These rules make that explicit.
//
// Ranking criteria:
//   - Rankable: Spend+Tax > 0, Advertised SKU Units > 0, and a positive SKU price.
//   - Best performing: lowest ACOS among rankable campaigns.
//   - Campaigns to optimize: highest ACOS among rankable campaigns.
//   - Campaigns that are not rankable are excluded from both lists, never ranked at 0%.

export interface RankInput {
  spendTax: number;
  advUnits: number;
  price: number;
}

/** True when a campaign has the spend, attributed units and price needed for a meaningful ACOS. */
export function isRankable(r: RankInput): boolean {
  return Number.isFinite(r.spendTax) && r.spendTax > 0
    && Number.isFinite(r.advUnits) && r.advUnits > 0
    && Number.isFinite(r.price) && r.price > 0;
}

/** ACOS for ranking: CPC / price, or null when the campaign is not rankable. */
export function rankableAcos(r: RankInput): number | null {
  if (!isRankable(r)) return null;
  return (r.spendTax / r.advUnits) / r.price;
}

/** Rankable campaigns ordered by ACOS ascending (best first); ties keep their input order. */
export function bestPerforming<T extends RankInput>(items: T[], limit: number): T[] {
  return items
    .map((item) => ({ item, acos: rankableAcos(item) }))
    .filter((x): x is { item: T; acos: number } => x.acos !== null)
    .sort((a, b) => a.acos - b.acos)
    .slice(0, limit)
    .map((x) => x.item);
}

/** Rankable campaigns ordered by ACOS descending (highest first). */
export function worstPerforming<T extends RankInput>(items: T[], limit: number): T[] {
  return items
    .map((item) => ({ item, acos: rankableAcos(item) }))
    .filter((x): x is { item: T; acos: number } => x.acos !== null)
    .sort((a, b) => b.acos - a.acos)
    .slice(0, limit)
    .map((x) => x.item);
}
