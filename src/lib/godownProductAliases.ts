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

/** The current name for a godown product (unchanged when it was never renamed). */
export const currentGodownName = (name: string) => GODOWN_PRODUCT_ALIASES[name] ?? name;

/** True for a godown row that only repeats another product's numbers. */
export const isGodownDuplicate = (name: string) => Object.hasOwn(GODOWN_DUPLICATE_COPIES, String(name ?? "").trim());

/** The sheet's name for a product named in another file (the Current stock sheet uses the 13.10.2026
 *  spellings): a duplicate copy's name points at its original, a renamed one at its current name. */
export const keptGodownName = (name: string) => { const n = String(name ?? "").trim(); return GODOWN_DUPLICATE_COPIES[n] ?? currentGodownName(n); };

/** Godown stock rows under their current names: renamed rows summed into the kept name (user,
 *  2026-10-15). A duplicate copy is left out only when its original has a stock row too; otherwise its
 *  stock counts under the original's name — the 14.10.2026 FC Stock sheet carries "Teething Tube Combo
 *  (Green Red Yellow)" and "IR Thermometer GP-100" only under the copy name, and dropping them showed
 *  0 stock (user, 2026-10-16). The first row's spelling wins when two rows share a name. */
export function mergeGodownProducts<T extends { product: string; currentStock: number; inboundShipped: number; unfulfillable: number; warehouse: number; qcGodown: number; packingGodown: number; skuRows: number; discontinued: boolean }>(rows: T[]): T[] {
  const key = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const originals = new Set(rows.filter((r) => !isGodownDuplicate(r.product)).map((r) => key(currentGodownName(r.product.trim()))));
  const by = new Map<string, T>();
  for (const r of rows) {
    let name = currentGodownName(r.product.trim());
    if (isGodownDuplicate(r.product)) {
      const original = GODOWN_DUPLICATE_COPIES[r.product.trim()];
      if (originals.has(key(original))) continue;
      name = original;
    }
    const k = key(name), p = by.get(k);
    if (!p) { by.set(k, { ...r, product: name }); continue; }
    p.currentStock += r.currentStock; p.inboundShipped += r.inboundShipped; p.unfulfillable += r.unfulfillable;
    p.warehouse += r.warehouse; p.qcGodown += r.qcGodown; p.packingGodown += r.packingGodown;
    p.skuRows += r.skuRows; p.discontinued = p.discontinued || r.discontinued;
  }
  return [...by.values()];
}
