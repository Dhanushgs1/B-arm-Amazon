// Godown products renamed between uploads (found 2026-10-13). barm_godown_daily keeps the old name on
// 26.07.2026–26.08.2026 (from the 26.08 upload); the 11.10.2026 file uses the new one. Each pair is
// listed only because its Stock Out AND Closing are identical on all 31 days both cover — the same
// product. Applied when reading; the stored rows are never changed.
// 2026-10-15 (user-approved list): the 13.10.2026 file added rows under other spellings. Pairs where
// one side is all 0 over 30 days are merged here (stock and days are summed under the kept name).
// Keys are exact (case matters): "Teething tube combo (Green red yellow)" is a rename, while
// "Teething Tube Combo (Green Red Yellow)" below is a duplicate copy.
export const GODOWN_PRODUCT_ALIASES: Record<string, string> = {
  "Chewy tube (Red)-Bump": "Chewy Tube Red (Bump Type)",
  "Gluco spark (Pack of 200) Strips": "GlucoSpark Strips (Pack of 200)",
  "Pregnancy Kit (1 Early 1 Normal 2 Pee Cup)": "Pregnancy kit(1 early, 1 normal, 2 pee cup)",
  "Teething tube combo (Green red yellow)": "Teething tube combo (Green,red,yellow)",
  "Wearable Lactation massager (Grey)": "Wearable Lactation Massager-Grey",
  "Wearable Lactation massager (purple)": "Wearable Lactation Massager-Purple",
  "Wearable lactation massager (Grey)": "Wearable Lactation Massager-Grey",
  "Wearable lactation massager (Purple)": "Wearable Lactation Massager-Purple",
};

/** Second copies of a product in the godown sheet (2026-10-15, user-approved): Stock Out and Closing
 *  equal the original's on every day, so adding them would double the stock. Left out when reading. */
export const GODOWN_DUPLICATE_COPIES: Record<string, string> = {
  "Teething Tube Combo (Green Red Yellow)": "Teething tube combo (Green,red,yellow)",
  "IR Thermometer GP-100": "IR THERMOMETER- GP 100",
};

// Name lookups (user, 2026-10-16): spaces are collapsed and trimmed, then the exact key is used. A key
// that differs only in case is used unless two known names with that lower-case spelling mean
// different things — the rename "Teething tube combo (Green red yellow)" and the copy "Teething Tube
// Combo (Green Red Yellow)" differ only in case, so those two still need their exact spelling.
const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const lower = (s: string) => s.toLowerCase();
function lookup(map: Record<string, string>): (name: string) => string | undefined {
  const exact = new Map(Object.entries(map).map(([k, v]) => [clean(k), v]));
  // every known spelling → what it means ("rename:<target>" / "copy:<original>"); a lower-case spelling
  // shared by names that mean different things is ambiguous (null) and needs the exact spelling
  const meaning = [
    ...Object.entries(GODOWN_PRODUCT_ALIASES).map(([k, v]) => [clean(k), `rename:${v}`]),
    ...Object.entries(GODOWN_DUPLICATE_COPIES).map(([k, v]) => [clean(k), `copy:${v}`]),
  ];
  const byLower = new Map<string, { key: string; means: string } | null>();
  for (const [k, means] of meaning) {
    const l = lower(k), prev = byLower.get(l);
    byLower.set(l, prev === undefined ? { key: k, means } : prev && prev.means === means ? prev : null);
  }
  return (name) => {
    const n = clean(name);
    if (exact.has(n)) return exact.get(n);
    const hit = byLower.get(lower(n));
    return hit ? exact.get(hit.key) : undefined;
  };
}
const renamedTo = lookup(GODOWN_PRODUCT_ALIASES);
const copyOf = lookup(GODOWN_DUPLICATE_COPIES);

/** The current name for a godown product (unchanged, apart from spacing, when it was never renamed). */
export const currentGodownName = (name: string) => renamedTo(name) ?? clean(name);

/** True for a godown row that only repeats another product's numbers. */
export const isGodownDuplicate = (name: string) => copyOf(name) !== undefined;

/** The original a duplicate copy repeats (under its current name), else null. */
export const duplicateOriginal = (name: string): string | null => { const o = copyOf(name); return o === undefined ? null : currentGodownName(o); };

/** The sheet's name for a product named in another file (the Current stock sheet uses the 13.10.2026
 *  spellings): a duplicate copy's name points at its original, a renamed one at its current name. */
export const keptGodownName = (name: string) => duplicateOriginal(name) ?? currentGodownName(name);

const key = (s: string) => lower(clean(s));

/** Godown stock rows under their current names: renamed rows summed into the kept name (user,
 *  2026-10-15). A duplicate copy is left out only when its original has a stock row too (no double
 *  count); otherwise its stock counts under the original's name — the 14.10.2026 FC Stock sheet
 *  carries "Teething Tube Combo (Green Red Yellow)" and "IR Thermometer GP-100" only under the copy
 *  name, and dropping them showed 0 stock (user, 2026-10-16). The first row's spelling wins when two
 *  rows share a name. */
export function mergeGodownProducts<T extends { product: string; currentStock: number; inboundShipped: number; unfulfillable: number; warehouse: number; qcGodown: number; packingGodown: number; skuRows: number; discontinued: boolean }>(rows: T[]): T[] {
  const originals = new Set(rows.filter((r) => !isGodownDuplicate(r.product)).map((r) => key(currentGodownName(r.product))));
  const by = new Map<string, T>();
  for (const r of rows) {
    const original = duplicateOriginal(r.product);
    if (original !== null && originals.has(key(original))) continue;
    const name = original ?? currentGodownName(r.product);
    const k = key(name), p = by.get(k);
    if (!p) { by.set(k, { ...r, product: name }); continue; }
    p.currentStock += r.currentStock; p.inboundShipped += r.inboundShipped; p.unfulfillable += r.unfulfillable;
    p.warehouse += r.warehouse; p.qcGodown += r.qcGodown; p.packingGodown += r.packingGodown;
    p.skuRows += r.skuRows; p.discontinued = p.discontinued || r.discontinued;
  }
  return [...by.values()];
}

/** Daily godown rows under their current names, by the same rule per date: a duplicate copy's row is
 *  left out only when its original has a row for that date; otherwise it counts under the original —
 *  on 14.10.2026 only the copy names had a row, and that day's Stock Out showed 0 (user, 2026-10-16). */
export function mergeGodownDaily<T extends { date: string; product: string }>(rows: T[]): T[] {
  const has = new Set(rows.filter((r) => !isGodownDuplicate(r.product)).map((r) => `${r.date}|${key(currentGodownName(r.product))}`));
  const out: T[] = [];
  for (const r of rows) {
    const original = duplicateOriginal(r.product);
    if (original !== null && has.has(`${r.date}|${key(original)}`)) continue;
    out.push({ ...r, product: original ?? currentGodownName(r.product) });
  }
  return out;
}

export interface StockMappingIssue { product: string; kind: "unmatched" | "copy_differs"; stock: number; note: string }

/** Only letters and digits, lower case: "IR THERMOMETER- GP 100" and "IR Thermometer GP-100" agree. */
const loose = (s: string) => lower(clean(s)).replace(/[^a-z0-9]/g, "");

/** Checks the merge against the godown file it came from (user, 2026-10-16), so a mismatch is seen
 *  before the sheet is used:
 *    unmatched     a godown row with stock whose name matches a sheet product only after ignoring
 *                  punctuation / case — its stock does not reach that product
 *    copy_differs  a duplicate copy left out because its original has a row, but with other stock
 *  Godown products that are simply not in the Current stock sheet are not listed (they are left off
 *  the sheet on purpose). `shown` = the products the sheet lists, under their godown names. */
export function checkStockMapping(raw: { product: string; currentStock: number }[], shown: { product: string }[]): StockMappingIssue[] {
  const shownKeys = new Set(shown.map((r) => key(r.product)));
  const shownLoose = new Map(shown.map((r) => [loose(r.product), clean(r.product)]));
  const origStock = new Map<string, number>();
  for (const r of raw) if (!isGodownDuplicate(r.product)) { const k = key(currentGodownName(r.product)); origStock.set(k, (origStock.get(k) ?? 0) + r.currentStock); }
  const issues: StockMappingIssue[] = [];
  for (const r of raw) {
    const original = duplicateOriginal(r.product);
    const name = original ?? currentGodownName(r.product);
    if (original !== null && origStock.has(key(original))) {
      if (origStock.get(key(original)) !== r.currentStock) issues.push({ product: clean(r.product), kind: "copy_differs", stock: r.currentStock,
        note: `duplicate copy of "${original}" (${origStock.get(key(original))}); its own ${r.currentStock} is not counted` });
      continue;
    }
    if (r.currentStock > 0 && !shownKeys.has(key(name)) && shownLoose.has(loose(name))) issues.push({ product: clean(r.product), kind: "unmatched", stock: r.currentStock,
      note: `${r.currentStock} in the godown file, but the sheet lists "${shownLoose.get(loose(name))}" — spelled differently, so it shows without this stock` });
  }
  return issues;
}
