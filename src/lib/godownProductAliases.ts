// Godown products renamed between uploads (found 2026-10-13). barm_godown_daily keeps the old name on
// 26.07.2026–26.08.2026 (from the 26.08 upload); the 11.10.2026 file uses the new one. Each pair is
// listed only because its Stock Out AND Closing are identical on all 31 days both cover — the same
// product. Applied when reading; the stored rows are never changed.
export const GODOWN_PRODUCT_ALIASES: Record<string, string> = {
  "Chewy tube (Red)-Bump": "Chewy Tube Red (Bump Type)",
  "Gluco spark (Pack of 200) Strips": "GlucoSpark Strips (Pack of 200)",
  "Pregnancy Kit (1 Early 1 Normal 2 Pee Cup)": "Pregnancy kit(1 early, 1 normal, 2 pee cup)",
  "Teething tube combo (Green red yellow)": "Teething tube combo (Green,red,yellow)",
  "Wearable Lactation massager (Grey)": "Wearable Lactation Massager-Grey",
  "Wearable Lactation massager (purple)": "Wearable Lactation Massager-Purple",
};

/** The current name for a godown product (unchanged when it was never renamed). */
export const currentGodownName = (name: string) => GODOWN_PRODUCT_ALIASES[name] ?? name;
