// Product-name matching between the restock files and the sheet (user, 2026-10-23). The Current stock
// sheet, the tool's Stock Purchase Sheet and the Monday snapshot carry no shared product id or SKU per
// product (the purchase upload keeps only the name), so names are the key. Known renames and duplicate
// copies are mapped first by keptGodownName (src/lib/godownProductAliases.ts); this module then makes
// harmless spelling differences match: "Pregnancy kit(1 early 1 normal 2 pee cup)" and
// "Pregnancy Kit (1 Early 1 Normal 2 Pee Cup)" are one product.
//
// No fuzzy matching: every letter and number of the name must agree, in order. Only case, spacing,
// brackets and punctuation are ignored, so pack sizes, quantities and variants never merge. When two
// different products would meet on the same key with different values, the lookup reports "ambiguous"
// and the caller leaves the value empty instead of guessing.

/** Case and spacing only — the same key as productKey in consolidatedStock.ts (kept here so the two
 *  modules do not import each other). */
const productKey = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** Words and numbers of a name, lower case, in order: "IR THERMOMETER- GP 100" → "ir thermometer gp 100".
 *  A decimal stays one number ("10.5" ≠ "105"); "&" counts as "and". */
export function productMatchKey(name: unknown): string {
  const s = String(name ?? "").normalize("NFKC").toLowerCase().replace(/&/g, " and ");
  return (s.match(/\d+(?:\.\d+)*|[a-z]+/g) ?? []).join(" ");
}

export type NameMatch<T> =
  | { status: "exact" | "normalized"; row: T }  // found (its value may still be blank — that is the caller's to read)
  | { status: "missing" }                       // no product of that name
  | { status: "ambiguous"; candidates: string[] }; // several products with different values; none is picked

/** Look-up of `rows` by product name. A name that matches exactly (case / spacing aside) wins over one
 *  that only matches after ignoring punctuation. Rows sharing a name count as one product when
 *  `valueOf` gives the same value for each, else the name is ambiguous. */
export function nameIndex<T>(rows: T[], nameOf: (r: T) => string, valueOf: (r: T) => unknown = (r) => r) {
  const group = (key: (n: string) => string) => {
    const by = new Map<string, T[]>();
    for (const r of rows) {
      const k = key(nameOf(r));
      if (k) by.set(k, [...(by.get(k) ?? []), r]);
    }
    return by;
  };
  const exact = group(productKey), loose = group(productMatchKey);
  const pick = (found: T[] | undefined, status: "exact" | "normalized"): NameMatch<T> => {
    if (!found?.length) return { status: "missing" };
    const values = new Set(found.map((r) => JSON.stringify(valueOf(r) ?? null)));
    return values.size === 1 ? { status, row: found[0] } : { status: "ambiguous", candidates: found.map(nameOf) };
  };
  return {
    find(name: string): NameMatch<T> {
      const hit = pick(exact.get(productKey(name)), "exact");
      return hit.status === "missing" ? pick(loose.get(productMatchKey(name)), "normalized") : hit;
    },
    /** Every set of names that meet on one key with different values. */
    ambiguous(): string[][] {
      return [...loose.values()].filter((g) => new Set(g.map((r) => JSON.stringify(valueOf(r) ?? null))).size > 1).map((g) => g.map(nameOf));
    },
  };
}
