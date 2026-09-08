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
  // Audience/gender and generic component words — same problem as kid/kids/baby/adult above,
  // just missed the first pass. Caught in a real export: "std test kit for women" and "tampons
  // with applicator" both stayed Positive with zero orders purely because this account's own
  // listing titles are keyword-stuffed with "...for women..." and "...long range applicator..."
  // — neither word says anything about THIS product specifically, so on their own they can't be
  // trusted as an own-product relevance signal (same reasoning STOPWORDS already applies to
  // "device"/"combo"/"set" for generic components, and "kid"/"baby"/"adult" for demographics).
  "women", "woman", "men", "man", "applicator", "applicators",
  // Same fanout test applied account-wide: fetched every one of B-ARM's 105 advertised product
  // titles and counted how many DISTINCT, unrelated products each word appears in — a word that
  // shows up across a nebulizer, a suture kit, AND an insemination kit is marketing filler, not a
  // real product signal, exactly the reasoning above but confirmed with real catalogue data
  // instead of guessing one product at a time. Anatomical/mechanism words that only recur within
  // one genuine product family (e.g. "breast"/"nipple"/"lactation", "suture"/"needle"/"thread",
  // "autism"/"speech"/"sensory", "asthma"/"copd"/"respiratory", "insemination"/"ivi") are
  // deliberately NOT included here — those ARE a real relevance signal within their own family.
  "support", "includ", "design", "modes", "digita", "metric", "rechar", "electr", "reusab",
  "durabl", "natura", "free", "each", "instan", "upgrad", "integr", "accura", "improv",
  "holder", "stand", "body", "heat", "coolin", "foam", "mesh", "nylon", "plasti", "tool",
  "cleani", "displa", "medica", "delive", "levels", "relief", "mother",
  // Found running a full real search-term export through classifySearchTerm (500 rows, a
  // sensory/therapressure brush campaign): "brush" alone matched completely unrelated searches
  // as a relevant own-product term purely because the campaign's own title also says "Brush" —
  // "sink cleaner brush", "clothes brush for washing", "sensodyne tooth brush", "clothe brush",
  // "sink brush", "dry body brush for women" all stayed Neutral instead of Negative. Same generic
  // implement-shape problem "holder"/"stand"/"tool" above already cover, just missed for this
  // product family. Genuinely relevant terms ("soft bristle brush", "wilbarger sensory brush")
  // still match correctly through their OTHER distinctive words ("bristle", "sensory",
  // "wilbarger", "occupational", "therapressure"), so this only removes the false positives.
  "brush",
  // Same discovery, same product family: "therapy" alone is a generic medical/wellness word
  // (occupational therapy, light therapy, hair therapy, physical therapy — spans totally
  // unrelated product categories account-wide), not a signal specific to this product. Matched
  // "led face mask light therapy" and "hair therapy comb" as relevant purely because the
  // product title says "...Wilbarger Protocol Therapy...Occupational Therapy...". Terms actually
  // about this product still match through "occupational" or "wilbarger" independently
  // ("occupational therapy kit/equipment/items"), so this only removes the false positives too.
  "therapy",
]);

// Short (<4 char) tokens that are still distinctive enough to trust, unlike most short words.
// "ivi" is literally part of this account's own insemination-kit branding (e.g. "B-Arm Self
// Insemination Kit for Women-17cm| IVI Kit with...") — without allowing it through, a search term
// short enough to use only that acronym ("nora ivi kit") shares no word with the product name at
// all (its only other words are "kit" and generic filler, both stopworded) and falls through to
// the zero-orders negative rule despite being exactly on-topic. Caught in a real export: "nora ivi
// kit" and "nory ivi kit" were flagged Negative while "iui kit- home insemination kit" (same
// campaign, same intent) stayed Positive purely for also spelling out "insemination". "iui" is
// the standard medical synonym (Intrauterine Insemination) for the same product category — kept
// here too so it starts matching as soon as it appears in some product's own title, though it
// won't help a term like "best iui kit for home" until then, since this account's own listings
// currently only spell out "IVI", not "IUI".
const SHORT_TOKEN_ALLOWLIST = new Set(["iui", "ivi"]);

// Crude stem: truncate to a 6-char prefix so "nebulizer"/"nebulization"/"nebuliser" (and other
// plural/-ing/-tion spelling variants) collide onto the same key. Caught a real false positive
// in testing — "ot section for nebulization" was flagged as a mismatch against a totally
// unrelated product because exact-string tokens don't see "nebulization" and "nebulizer" (the
// campaign's own advertised product word) as the same thing.
function stem(token: string): string {
  return token.length > 6 ? token.slice(0, 6) : token;
}

// "iui" (Intrauterine Insemination, the standard medical term) and "ivi" (this account's own
// product-title spelling) name the same real-world product category — canonicalized onto one
// token so a search term spelling it "iui" matches a product title spelling it "ivi", and vice
// versa. Without this, a search term using ONLY the acronym with no other matching word ("iui
// kit" — "kit" is stopworded, nothing else to match on) never finds this account's own "...IVI
// Kit..." titles at all, and stays classified Negative despite being exactly on-topic. Caught in
// a real export: "iui kit" alone was Negative while "iui kit- home insemination kit" (same
// campaign, same intent) stayed Positive purely for also spelling out "insemination".
const ACRONYM_SYNONYMS: Record<string, string> = { iui: "ivi" };

function tokenize(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .replace(/[()\-–/]/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((t) => (t.length >= 4 || SHORT_TOKEN_ALLOWLIST.has(t)) && !STOPWORDS.has(t) && !/^\d+$/.test(t))
    .map(stem)
    .map((t) => ACRONYM_SYNONYMS[t] || t);
}

export interface CatalogEntry {
  name: string;
  // Which live campaign currently advertises this product — undefined for a static catalogue
  // entry with no live campaign attached (e.g. discontinued, or not currently advertised).
  campaignName?: string;
  // The product's actual Amazon ASIN — undefined for a static catalogue entry (categoryMap.ts
  // has no ASINs, only names). SellerMate's search-term data has no per-term ASIN of its own
  // (confirmed: adAsin/asin are silently dropped from every group_by combination tried), so
  // this can't confirm which ASIN a given click landed on — only surface which ASIN the
  // matched product actually is, so a name-based match can be verified against the real listing.
  asin?: string;
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

// A term that shares a distinctive word with the campaign's OWN advertised product(s) is a
// relevant, on-target search — e.g. "smart watch" under a campaign that sells a Smart Watch —
// regardless of what else it might also overlap with elsewhere in the catalogue.
export function matchesOwnProduct(searchTerm: string, campaignProductNames: string[]): boolean {
  const termTokens = tokenize(searchTerm);
  if (termTokens.length === 0) return false;
  const ownTokens = new Set<string>();
  for (const p of campaignProductNames) for (const t of tokenize(p)) ownTokens.add(t);
  return termTokens.some((t) => ownTokens.has(t));
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

  // The term itself uses one of the campaign's own product words — not a mismatch, regardless
  // of what else it might overlap with elsewhere.
  if (matchesOwnProduct(searchTerm, campaignProductNames)) return null;

  if (liveIndex) {
    const liveHit = bestMatch(termTokens, liveIndex, currentCampaignName, 2);
    if (liveHit) return liveHit;
  }
  return bestMatch(termTokens, STATIC_INDEX, undefined, 1);
}

// Standard modern Amazon ASIN shape: 10 characters, starting "B0". Customers sometimes search
// by pasting/typing an exact ASIN rather than words — when that ASIN isn't one of this
// campaign's own products, it's unambiguous proof the customer was looking for a specific
// DIFFERENT product, not a fuzzy word-overlap guess. Real example caught in testing: "b07jnym68y"
// and "b0f9nyrv4b" each converted (orders > 0) under someone else's product search, and were
// staying Positive under the orders-only rule since they technically sold — but the search
// itself was never for this campaign's product, so the click was still a mismatch, sale or not.
const ASIN_PATTERN = /^b0[a-z0-9]{8}$/i;

// Manually-confirmed ASINs (lowercased) that belong to a DIFFERENT seller/listing but are still
// genuinely relevant to B-ARM's own catalogue — competitor or complementary products in the same
// category (fertility/conception, in the cases confirmed so far). Amazon's own auto-targeting
// only ever surfaces a product this closely related as a search term to begin with, so a click
// here is real category interest, not a wrong-product mistake — negating it risks cutting off
// exactly the customers most likely to eventually buy. There's no product-lookup API in this
// codebase to verify an arbitrary foreign ASIN automatically, so this list is curated by hand as
// specific ASINs get checked (e.g. via a manual Amazon lookup) and confirmed relevant — add to it
// as more are found, rather than trying to auto-classify every unknown ASIN.
const KNOWN_RELEVANT_ASINS = new Map<string, { name: string; note?: string }>([
  ["b0dh4xd1j5", { name: "NeoDocs I-Conceive IVI Insemination Kit", note: "competitor insemination kit" }],
  ["b0f8nw1py5", { name: "Easy@Home Ovulation Test Kit (25-pack)", note: "fertility-adjacent" }],
  ["b0dpx67g5t", { name: "Easy@Home Ovulation Test Kit (10-pack)", note: "fertility-adjacent" }],
  ["b0dcbsxjmx", { name: "Premom Urine Cups for Ovulation & Pregnancy Tests", note: "fertility-adjacent" }],
  ["b004rbl5zm", { name: "Pre-Seed Fertility Lubricant", note: "fertility-adjacent" }],
]);

export interface SearchTermClassification {
  negative: boolean;
  // "positive" = real orders (a proven converting term). "neutral" = zero orders but
  // relevant to the campaign's own product (own-product word/ASIN match, or a manually
  // confirmed related ASIN) — worth keeping, just hasn't converted yet, so it shouldn't
  // read the same as a genuine zero-order winner. "negative" = the same `negative` boolean
  // above, kept alongside it as a named status rather than replacing that boolean, since
  // existing call sites already check `.negative` directly.
  status: "positive" | "neutral" | "negative";
  reasons: string[];
  mismatchedProduct: CatalogEntry | null;
  // Deterministic 0-100 "how good is this search term" score — rule-based, not an AI model
  // call, so it's instant and reproducible for however many rows a campaign has (some
  // campaigns run 500+ search terms per drawer/export). See the scoring block in
  // classifySearchTerm below for exactly how each status computes its score.
  score: number;
}

// The rule: a term is negative whenever it has zero orders — regardless of spend or clicks —
// UNLESS it's relevant to the campaign's own advertised product, either by name
// (matchesOwnProduct above: a search for "smart watch" under a campaign selling a Smart Watch),
// by being a literal search for this campaign's own ASIN (isOwnAsin), or by being a manually
// confirmed relevant competitor/category ASIN (KNOWN_RELEVANT_ASINS above) — all three are
// relevant traffic that simply hasn't converted yet, not a wrong-product click, no matter how
// many zero-order times it shows up. A literal ASIN belonging to a DIFFERENT, unconfirmed product
// than this campaign's own is negative regardless of that exemption (see ASIN_PATTERN above; overrides even a real order, since the
// exact wrong-product search means the click was never relevant to begin with — e.g. "ball"
// pulling in some unrelated listing's ASIN). When a term is negative and its words point at a
// different product too, that's called out as a second, more specific reason alongside "No
// orders" — worth knowing even where it isn't what decided negative. Replaces the old "10+
// clicks, no orders", "spend >= 3x price", and "orders===0 AND mismatch" rules, all of which left
// plenty of zero-order/zero-sale rows sitting as Positive — confirmed wrong against a real export
// (211 zero-order rows still Positive). The own-product exemption here is narrower than that old
// mismatch-gate: it only requires positive evidence the term IS about the right product, not that
// mismatch detection could prove it's about a wrong one — so it doesn't reintroduce the same gap.
export function classifySearchTerm(
  term: { searchTerm: string; orders?: number; clicks?: number },
  campaignProductNames: string[],
  liveIndex?: Map<string, CatalogEntry[]> | null,
  currentCampaignName?: string,
  // This campaign's own ASIN(s) — a literal-ASIN search term is only a mismatch when it's NOT
  // one of these (e.g. a customer legitimately searching the exact ASIN they already want).
  campaignAsins?: string[],
  // ASIN (lowercased) -> the product it actually is, account-wide. A literal-ASIN search term
  // has no words to word-match against a product name (findMismatchedProduct can't resolve it),
  // so without this lookup the reason names the ASIN but never says whose product it is —
  // exactly the case that makes the reason useless for deciding what to do about it.
  asinIndex?: Map<string, CatalogEntry> | null
): SearchTermClassification {
  const reasons: string[] = [];
  const orders = term.orders || 0;
  const rawTerm = term.searchTerm.trim();

  const isOwnAsin = (campaignAsins || []).some((a) => a.toLowerCase() === rawTerm.toLowerCase());
  const knownRelevant = KNOWN_RELEVANT_ASINS.get(rawTerm.toLowerCase()) || null;
  const isDifferentAsinSearch = ASIN_PATTERN.test(rawTerm) && !isOwnAsin && !knownRelevant;
  // Own-ASIN search terms have no words to trip matchesOwnProduct's name-based check (an ASIN
  // string shares no tokens with a product title) — check the ASIN directly too, so a customer
  // pasting/typing this campaign's own exact ASIN with zero orders is relevant traffic that
  // hasn't converted yet, same as searching the product by name. A manually-confirmed relevant
  // competitor/category ASIN (knownRelevant) gets the same treatment.
  const relevantToOwnProduct = matchesOwnProduct(rawTerm, campaignProductNames) || isOwnAsin || !!knownRelevant;

  // Word-overlap hit against the wider catalogue, computed up front (not only to explain an
  // already-decided negative) so a hit against ANOTHER of B-ARM's own live campaigns can also
  // exempt a zero-order term below — findMismatchedProduct only ever returns B-ARM's own
  // products (liveIndex is built from this account's own advertised products, STATIC_INDEX from
  // categoryMap.ts, this account's own SKU catalogue — see both files' headers), so a "mismatch"
  // here never means a true external competitor, only "right account, wrong campaign." Only a
  // liveIndex hit (mismatchedProduct.campaignName set) gets the exemption — a STATIC_INDEX-only
  // hit (campaignName undefined, nothing currently advertises it) stays flagged, since that's the
  // genuinely discontinued/unrelated product line this file's header comment says should still be
  // caught. Skipped entirely when already relevantToOwnProduct or orders > 0, matching the only
  // cases where the original code called this (inside the old negative-only branch), so this
  // doesn't add extra findMismatchedProduct calls beyond what already ran per row.
  const ownAccountMismatch =
    !relevantToOwnProduct && orders === 0
      ? findMismatchedProduct(term.searchTerm, campaignProductNames, liveIndex, currentCampaignName)
      : null;
  const relevantToOwnAccount = relevantToOwnProduct || !!ownAccountMismatch?.campaignName;

  const negative = (orders === 0 && !relevantToOwnAccount) || isDifferentAsinSearch;

  let mismatchedProduct: CatalogEntry | null = null;
  if (knownRelevant) {
    reasons.push(`Related product (not a mismatch) — ${knownRelevant.name}${knownRelevant.note ? ` — ${knownRelevant.note}` : ""}`);
  }
  if (negative) {
    if (orders === 0) reasons.push("No orders");

    if (isDifferentAsinSearch) {
      const asinEntry = asinIndex?.get(rawTerm.toLowerCase()) || null;
      if (asinEntry) mismatchedProduct = asinEntry;
      const productPart = asinEntry
        ? asinEntry.campaignName
          ? ` — matches campaign "${asinEntry.campaignName}" ("${asinEntry.name}")`
          : ` — "${asinEntry.name}"`
        : "";
      reasons.push(`Search term is a different product's ASIN (${rawTerm.toUpperCase()})${productPart}`);
    }

    if (!mismatchedProduct) {
      // A STATIC_INDEX-only hit (no live campaign advertises it) never got the exemption above,
      // so ownAccountMismatch — when set here — is exactly that discontinued/unrelated case.
      mismatchedProduct = ownAccountMismatch;
      if (mismatchedProduct) {
        const asinPart = mismatchedProduct.asin ? `, ASIN ${mismatchedProduct.asin}` : "";
        reasons.push(
          mismatchedProduct.campaignName
            ? `Different product — matches campaign "${mismatchedProduct.campaignName}"${asinPart}`
            : `Different product — looks like "${mismatchedProduct.name}"${asinPart}`
        );
      }
    }
  } else if (orders > 0) {
    // Positive with no other note pushed above (the common case — knownRelevant is the only
    // other thing that can add a reason here, and that already says why it's relevant) — say
    // WHY it's positive instead of leaving Reason blank, so every row explains itself.
    if (!reasons.length) reasons.push(`${orders} order${orders === 1 ? "" : "s"} — proven converting term`);
  } else if (ownAccountMismatch?.campaignName) {
    // Neutral via the new account-wide exemption: zero orders, not this campaign's own product,
    // but a live word-overlap match against ANOTHER of B-ARM's own campaigns — relevant to the
    // account, not a wasted click on someone else's listing, just possibly the wrong ad group.
    mismatchedProduct = ownAccountMismatch;
    reasons.push(
      `No orders yet; matches this account's own product under campaign "${ownAccountMismatch.campaignName}" ("${ownAccountMismatch.name}") — relevant, not a mismatch, consider moving budget there`
    );
  } else {
    // Neutral: zero orders, but relevant to this campaign's own product — worth keeping, not
    // a wrong-product click, just hasn't converted yet. isOwnAsin gets its own note since
    // knownRelevant/matchesOwnProduct-by-name already read clearly on their own (knownRelevant
    // pushed its note above; a plain name match needs one here, isOwnAsin has neither).
    if (isOwnAsin) reasons.push("No orders yet; search term is this campaign's own ASIN — relevant, not a mismatch");
    else if (!reasons.length) reasons.push("No orders yet; matches this campaign's own product — relevant search, not a mismatch");
  }

  const status: SearchTermClassification["status"] = negative ? "negative" : orders > 0 ? "positive" : "neutral";

  // Deterministic 0-100 score — no AI model call, so it's instant and identical on every rerun
  // of the same data (500+ rows per campaign export need this to stay fast and reproducible).
  let score: number;
  if (status === "negative") {
    // A CONFIRMED wrong-product match (a specific mismatched product/ASIN found) is worse than
    // a plain "no orders, nothing confirms it's wrong" term — the former is actionable right
    // now, the latter just needs more data. Both get worse the more clicks (= wasted spend)
    // they've racked up without converting.
    const hasConfirmedMismatch = !!mismatchedProduct || isDifferentAsinSearch;
    const base = hasConfirmedMismatch ? 10 : 30;
    score = Math.max(0, base - Math.min(base, Math.round((term.clicks || 0) / 5)));
  } else if (status === "positive") {
    // More real orders is an unambiguous quality signal — scales up from a 65 floor, capped at 100.
    score = Math.min(100, 65 + orders * 7);
  } else {
    // Neutral has no finer signal to grade by (relevance here is binary: matches or doesn't) —
    // a flat mid-range score rather than a fabricated ranking.
    score = 50;
  }

  return { negative, status, reasons, mismatchedProduct, score };
}
