import { supabasePublic } from "@/lib/amazonReportUpload";
import { skuBase } from "@/lib/productMasterUpload";

// A second, richer product-master table — Product Name, SKU ID, Platform, Type, Components in
// it, Cost Price, Tax, Category — that predates/parallels barm_product_master but wasn't wired
// into any report until now. One row per SKU *variant* per platform (a product sold on Amazon
// and Flipkart under two different SKU spellings gets two rows, both pointing to the same
// Product Name), same shape as "Master SKU sheet with Category.xlsx" plus Cost Price and Tax.
// This is the table the seller's team calls "master_product_skuid" and has asked every report to
// resolve SKU/name/category (and eventually tax) from — it takes priority over both
// barm_product_master and categoryMap.ts's hardcoded maps, since it's the one with the fullest,
// most current data (confirmed to have all 8 Gynaecology SKUs that were missing from the Amazon
// Sales report, which neither of the other two sources had every entry for either).
const TABLE = "master_product_skuid";

// Its Category column spells this department "Gynecology" (no 'a'); every other category system
// in this app (categoryMap.ts, CATEGORY_COLORS, EXCLUDED_CATEGORIES, every report's Category
// Breakdown sheet) spells it "Gynaecology". Normalized on read so a SKU resolved from this table
// lands in the same department bucket as everywhere else, instead of silently creating a second,
// misspelled "Gynecology" category that fragments the Category Breakdown sheet into two rows for
// what is really one department.
const CATEGORY_ALIASES: Record<string, string> = {
  gynecology: "Gynaecology",
};

function normalizeCategory(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return CATEGORY_ALIASES[trimmed.toLowerCase()] || trimmed;
}

function toNullableNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export interface MasterSkuidEntry {
  name: string;
  category: string;
  tax: number | null; // fraction, e.g. 0.05 = 5% GST — as stored in the sheet, not a percentage
  costPrice: number | null;
}

/** sku -> {name, category, tax, costPrice}. Empty map (never throws) if the table is missing
 *  (not created/populated yet) or a transient Supabase error occurs — a report must still
 *  generate, falling back to whatever the other sources (barm_product_master, categoryMap.ts)
 *  produce, same contract as fetchProductMasterMap in productMasterUpload.ts. */
export async function fetchMasterSkuidMap(): Promise<Map<string, MasterSkuidEntry>> {
  try {
    const { data, error } = await supabasePublic
      .from(TABLE)
      .select('"SKU ID","Product Name","Category","Tax","Cost Price"');
    if (error || !data) return new Map();
    const map = new Map<string, MasterSkuidEntry>();
    (data as Record<string, unknown>[]).forEach((r) => {
      const sku = String(r["SKU ID"] ?? "").trim();
      const name = String(r["Product Name"] ?? "").trim();
      if (!sku || !name || map.has(sku)) return; // first row wins — platform variants of the same SKU share identical name/category/tax/cost
      map.set(sku, {
        name,
        category: normalizeCategory(String(r["Category"] ?? "")),
        tax: toNullableNumber(r["Tax"]),
        costPrice: toNullableNumber(r["Cost Price"]),
      });
    });
    return map;
  } catch {
    return new Map();
  }
}

/** Builds sku -> name/category/tax/costPrice resolvers: exact SKU match first, then the same
 *  SKU's "base" spelling (see skuBase in productMasterUpload.ts) for a platform-variant spelling
 *  this exact table doesn't carry. Only what's actually stored (name always; category/tax/cost
 *  only when present) overrides the caller's fallback. */
export function buildMasterSkuidResolver(master: Map<string, MasterSkuidEntry>) {
  const byBase = new Map<string, MasterSkuidEntry>();
  master.forEach((entry, sku) => {
    const base = skuBase(sku);
    if (!byBase.has(base)) byBase.set(base, entry);
  });
  const lookup = (sku: string): MasterSkuidEntry | undefined => master.get(sku) || byBase.get(skuBase(sku));
  return {
    resolveName: (sku: string, fallback: string): string => lookup(sku)?.name || fallback,
    resolveCategory: (sku: string, fallback: string): string => lookup(sku)?.category || fallback,
    resolveTax: (sku: string): number | null => lookup(sku)?.tax ?? null,
    resolveCostPrice: (sku: string): number | null => lookup(sku)?.costPrice ?? null,
  };
}
