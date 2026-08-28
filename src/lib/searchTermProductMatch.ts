// Flags a customer search term as a negative-keyword candidate for the campaign it fired
// under, for two independent reasons:
//   1. Product mismatch — the term's words point at a totally different product than what
//      the campaign actually advertises (e.g. a "nebulizer" search term landing clicks on a
//      "pregnancy kit" campaign). Detected by matching the term's significant words against
//      every other product name in CATEGORY_ENTRIES, then checking it shares nothing with the
//      campaign's own advertised product name(s). This is the strong, spend-independent signal.
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

// keyword -> every product name (from the full catalogue) that contains it. Built once at
// module load — CATEGORY_ENTRIES is a static in-memory list, not a per-request fetch.
const KEYWORD_INDEX: Map<string, Set<string>> = (() => {
  const idx = new Map<string, Set<string>>();
  for (const [name] of CATEGORY_ENTRIES) {
    for (const t of tokenize(name)) {
      if (!idx.has(t)) idx.set(t, new Set());
      idx.get(t)!.add(name);
    }
  }
  return idx;
})();

// Returns the catalogue product name a search term's words most strongly point at, when that
// product is clearly NOT the one(s) the campaign advertises. Null when the term shares no
// distinctive words with the catalogue, or when it does reference the campaign's own product.
export function findMismatchedProduct(searchTerm: string, campaignProductNames: string[]): string | null {
  const termTokens = tokenize(searchTerm);
  if (termTokens.length === 0) return null;

  const ownTokens = new Set<string>();
  for (const p of campaignProductNames) for (const t of tokenize(p)) ownTokens.add(t);

  // The term itself uses one of the campaign's own product words — not a mismatch, regardless
  // of what else it might overlap with in the wider catalogue.
  if (termTokens.some((t) => ownTokens.has(t))) return null;

  const candidateCounts = new Map<string, number>();
  for (const t of termTokens) {
    const products = KEYWORD_INDEX.get(t);
    if (!products) continue;
    for (const p of products) candidateCounts.set(p, (candidateCounts.get(p) || 0) + 1);
  }
  if (candidateCounts.size === 0) return null;

  let best: string | null = null;
  let bestCount = 0;
  for (const [p, c] of candidateCounts) {
    if (c > bestCount) { best = p; bestCount = c; }
  }
  return best;
}

export interface SearchTermClassification {
  negative: boolean;
  reasons: string[];
  mismatchedProduct: string | null;
}

export function classifySearchTerm(
  term: { searchTerm: string; orders?: number; clicks?: number },
  campaignProductNames: string[]
): SearchTermClassification {
  const reasons: string[] = [];
  const orders = term.orders || 0;
  const clicks = term.clicks || 0;

  const mismatchedProduct = findMismatchedProduct(term.searchTerm, campaignProductNames);
  if (mismatchedProduct) reasons.push(`Different product — looks like "${mismatchedProduct}"`);
  if (orders === 0 && clicks > 10) reasons.push("10+ clicks, no orders");

  return { negative: reasons.length > 0, reasons, mismatchedProduct };
}
