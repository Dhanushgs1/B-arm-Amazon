// Pure rules for the Upload page's Sponsored Brands / Display campaign → SKU editor.
//
// A campaign's spend is split across its SKUs in proportion to each SKU's stored
// `weight` (relative, not a fraction). The editor keeps one draft row per SKU; this
// module turns those rows into the entries `setCampaignSkus` persists, and checks them
// first so a bad weight is reported instead of being silently dropped.

export interface SkuWeightDraftRow {
  sku: string;
  /** Kept as typed so a blank or half-typed value can be reported, not coerced. */
  weight: string;
}

export interface SkuWeightEntry {
  sku: string;
  weight: number;
}

/** A new, empty mapping row starts at weight 1 — equal split unless the user changes it. */
export const DEFAULT_NEW_WEIGHT = "1";

/** Draft rows for a campaign's stored allocation; an unmapped campaign gets one blank row. */
export function draftRowsFromStored(stored: SkuWeightEntry[]): SkuWeightDraftRow[] {
  if (!stored.length) return [{ sku: "", weight: DEFAULT_NEW_WEIGHT }];
  return stored.map((e) => ({ sku: e.sku, weight: String(e.weight) }));
}

// Plain decimal only: rejects "", "abc", "1e3", "0x10", "Infinity", "-1" and "0".
const POSITIVE_DECIMAL = /^(\d+(\.\d*)?|\.\d+)$/;

export type SkuWeightValidation =
  | { ok: true; entries: SkuWeightEntry[] }
  | { ok: false; error: string };

/**
 * Validate the editor's rows for one campaign. Rows with neither a SKU nor a weight
 * are ignored (a blank trailing row is normal). No usable rows means "clear the
 * mapping", which is a valid save.
 */
export function validateSkuWeightDraft(rows: SkuWeightDraftRow[]): SkuWeightValidation {
  const entries: SkuWeightEntry[] = [];
  const seen = new Set<string>();

  for (const [i, row] of rows.entries()) {
    const sku = row.sku.trim();
    const weightText = row.weight.trim();
    if (!sku && !weightText) continue;
    const label = sku || `row ${i + 1}`;

    if (!sku) return { ok: false, error: `Row ${i + 1}: enter a SKU, or remove the row.` };
    if (!weightText) return { ok: false, error: `${label}: enter a weight (for an equal split, use 1).` };
    if (!POSITIVE_DECIMAL.test(weightText) || !(Number(weightText) > 0) || !Number.isFinite(Number(weightText))) {
      return { ok: false, error: `${label}: weight "${row.weight}" must be a positive number, e.g. 1 or 1.5.` };
    }
    if (seen.has(sku)) return { ok: false, error: `${sku} is listed more than once — combine it into one row.` };

    seen.add(sku);
    entries.push({ sku, weight: Number(weightText) });
  }

  return { ok: true, entries };
}

/** Each SKU's share of a campaign: weight / total weight. Empty when nothing is mapped. */
export function campaignShares(entries: SkuWeightEntry[]): { sku: string; share: number }[] {
  const total = entries.reduce((sum, e) => sum + e.weight, 0);
  if (!(total > 0)) return [];
  return entries.map((e) => ({ sku: e.sku, share: e.weight / total }));
}
