// Flags a customer search term as a negative-keyword candidate for the campaign it fired
// under, for two independent reasons:
//   1. Product mismatch — the term's words point at a product the campaign doesn't advertise.
//      Checked first against every OTHER live campaign's actually-advertised products (pulled
//      from SellerMate's get_advertised_product_performance for the whole account, the same
//      source this dashboard already reads everywhere else) — that's the actionable case: "this
//      click belongs to campaign X instead." Falls back to the static product catalogue
//      (categoryMap.ts) only when no live campaign currently advertises anything matching, so a
//      totally unrelated/discontinued product line still gets flagged.
//   2. No conversions — the existing "clicked a lot, never converted" heuristic used elsewhere
//      in the dashboard (orders === 0 && clicks > 10).
//
// Deliberately a plain word-overlap heuristic rather than a real NLP/embedding match — good
// enough to catch "wrong product" search terms without a model call per term, since this runs
// client-side over up to 500 rows per campaign drawer open.

import { CATEGORY_ENTRIES } from "./categoryMap";

// Descriptive words (colors, sizes, generic modifiers, units) that appear across many unrelated
// product names — indexing on these would match nearly everything and drown out real signal.
const STOPWORDS = new Set([
  "pack", "of", "with", "without", "and", "the", "for", "new", "old", "model", "type", "kit",
  "device", "combo", "set", "box", "spiral", "blue", "pink", "green", "yellow", "red", "grey",
  "gray", "white", "black", "purple", "violet", "brown", "ivory", "peach", "small", "large",
  "big", "mini", "normal", "regular", "standard", "inhouse", "fba", "supplier", "pcs", "pc",
  "piece", "pieces", "bump", "bare", "dark", "colour", "color", "size", "sided", "double",
  "single", "left", "right", "adult", "kids", "kid", "baby", "professional", "basic", "grams",
  "gram", "strips", "strip", "lancets", "lancet",
  // Live listing titles (not the clean static catalogue) are noisy marketing copy — caught a
  // real false match in testing where a "cold steamer" search term under a nebulizer campaign
  // got flagged as belonging to a totally unrelated "C-Section Recovery Kit", purely because
  // that product's title happens to mention a "Hot & Cold Therapy Belt".
  "hot", "cold", "must", "have", "haves", "home", "best", "easy", "great", "perfect", "ideal",
  "quality", "premium", "portable", "your", "moms", "mom", "safe", "soft", "comfort", "gift",
]);

// Crude stem: truncate to a 6-char prefix so "nebulizer"/"nebulization"/"nebuliser" (and other
// plural/-ing/-tion spelling variants) collide onto the same key. Caught a real false positive
// in testing — "ot section for nebulization" was flagged as a mismatch against a totally
// unrelated product because exact-string tokens don't see "nebulization" and "nebulizer" (the
// campaign's own advertised product word) as the same thing.
function stem(token: string): string {
  return token.length > 6 ? token.slice(0, 6) : token;
}

function tokenize(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .replace(/[()\-–/]/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t) && !/^\d+$/.test(t))
    .map(stem);
}

export interface CatalogEntry {
  name: string;
  // Which live campaign currently advertises this product — undefined for a static catalogue
  // entry with no live campaign attached (e.g. discontinued, or not currently advertised).
  campaignName?: string;
}

export function buildProductIndex(entries: CatalogEntry[]): Map<string, CatalogEntry[]> {
  const idx = new Map<string, CatalogEntry[]>();
  for (const entry of entries) {
    // A raw listing title can repeat the same word (e.g. "...Rechargeable Nose Cleaner |
    // ...nose relief...") — dedupe per entry so one repeated word can't masquerade as two
    // separate overlapping words and slip past the minOverlap check in bestMatch below.
    for (const t of new Set(tokenize(entry.name))) {
      if (!idx.has(t)) idx.set(t, []);
      idx.get(t)!.push(entry);
    }
  }
  return idx;
}

// Static fallback catalogue — no campaignName, so a match here only ever produces a generic
// "looks like <product>" reason, never a specific "belongs to campaign X" one. Built once at
// module load since CATEGORY_ENTRIES is a static in-memory list, not a per-request fetch.
const STATIC_INDEX = buildProductIndex(CATEGORY_ENTRIES.map(([name]) => ({ name })));

// A token that shows up across this many distinct products isn't distinguishing — it's
// generic marketing filler (raw Amazon listing titles are noisy: "hot", "must", "home", brand
// name repeated on every product, etc.), so it can't be trusted to identify any one of them.
// A real product-family word normally only recurs across that product's own few SKU variants.
const MAX_TOKEN_FANOUT = 4;

function bestMatch(
  termTokens: string[],
  index: Map<string, CatalogEntry[]>,
  excludeCampaignName?: string,
  // Raw live listing titles are long, noisy marketing copy — a SINGLE shared word ("nose",
  // "travel", "pump") is too easy to hit by coincidence (caught two in testing: "portable
  // oxygen cylinder for travel" matched an "IQ Puzzle" only because its title says "Travel
  // Puzzle Game"). The short, curated static catalogue doesn't have that problem, so it can
  // still trust a single distinctive word — only the noisy live index needs 2+.
  minOverlap: number = 1
): CatalogEntry | null {
  const counts = new Map<string, { entry: CatalogEntry; count: number }>();
  for (const t of termTokens) {
    const matches = index.get(t);
    if (!matches || matches.length > MAX_TOKEN_FANOUT) continue;
    for (const entry of matches) {
      if (excludeCampaignName && entry.campaignName === excludeCampaignName) continue;
      const key = `${entry.name}|${entry.campaignName || ""}`;
      const existing = counts.get(key);
      if (existing) existing.count++;
      else counts.set(key, { entry, count: 1 });
    }
  }
  let best: { entry: CatalogEntry; count: number } | null = null;
  for (const c of counts.values()) if (!best || c.count > best.count) best = c;
  if (best && best.count < minOverlap) return null;
  return best?.entry ?? null;
}

// Returns the product (and, when known live, the campaign that actually advertises it) a search
// term's words most strongly point at, when that product is clearly NOT one the campaign itself
// advertises. Null when the term shares no distinctive words with anything, or when it does
// reference the campaign's own product.
export function findMismatchedProduct(
  searchTerm: string,
  campaignProductNames: string[],
  liveIndex?: Map<string, CatalogEntry[]> | null,
  currentCampaignName?: string
): CatalogEntry | null {
  // Deduped for the same reason buildProductIndex dedupes a product's own tokens — a search
  // term repeating a word ("cold cold pack") must not count as two overlapping words either.
  const termTokens = Array.from(new Set(tokenize(searchTerm)));
  if (termTokens.length === 0) return null;

  const ownTokens = new Set<string>();
  for (const p of campaignProductNames) for (const t of tokenize(p)) ownTokens.add(t);

  // The term itself uses one of the campaign's own product words — not a mismatch, regardless
  // of what else it might overlap with elsewhere.
  if (termTokens.some((t) => ownTokens.has(t))) return null;

  if (liveIndex) {
    const liveHit = bestMatch(termTokens, liveIndex, currentCampaignName, 2);
    if (liveHit) return liveHit;
  }
  return bestMatch(termTokens, STATIC_INDEX, undefined, 1);
}

export interface SearchTermClassification {
  negative: boolean;
  reasons: string[];
  mismatchedProduct: CatalogEntry | null;
}

export function classifySearchTerm(
  term: { searchTerm: string; orders?: number; clicks?: number },
  campaignProductNames: string[],
  liveIndex?: Map<string, CatalogEntry[]> | null,
  currentCampaignName?: string
): SearchTermClassification {
  const reasons: string[] = [];
  const orders = term.orders || 0;
  const clicks = term.clicks || 0;

  const mismatchedProduct = findMismatchedProduct(term.searchTerm, campaignProductNames, liveIndex, currentCampaignName);
  if (mismatchedProduct) {
    reasons.push(
      mismatchedProduct.campaignName
        ? `Different product — matches campaign "${mismatchedProduct.campaignName}"`
        : `Different product — looks like "${mismatchedProduct.name}"`
    );
  }
  if (orders === 0 && clicks > 10) reasons.push("10+ clicks, no orders");

  return { negative: reasons.length > 0, reasons, mismatchedProduct };
}
