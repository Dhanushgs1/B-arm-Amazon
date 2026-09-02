import { fetchAllRows } from "@/lib/amazonReportShared";
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

// Exported so other master tables (e.g. master_product_marketing in
// productMarketingUpload.ts) normalize the same "Gynecology"/"Gynaecology"
// spelling the same way, instead of drifting with a second copy of this rule.
export function normalizeCategory(raw: string): string {
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
    // fetchAllRows, not a single .select() — this table has 1700+ rows, well
    // past PostgREST's 1000-row default page cap. An unpaginated select here
    // silently dropped every SKU past row 1000 (in whatever order Postgres
    // happened to return), which meant a large, arbitrary slice of products
    // always fell back to the 18% GST default and their raw SKU as a name,
    // with no error anywhere to reveal it.
    const data = await fetchAllRows(TABLE, (q) => q);
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

/** normalized product name -> Platform -> every SKU ID the master lists for that
 *  product on that platform, in stored order. Distinct from fetchMasterSkuidMap
 *  above, which is keyed by SKU and only keeps one entry per SKU — this is the
 *  reverse direction (name -> its full SKU set), for a "SKU(s)" column that
 *  should show the master's complete, stable list for a product rather than
 *  whichever SKU spellings happened to have activity in one report's window
 *  (a product can be actively sold under only 2 of its 5 known SKU variants on
 *  a given day, and a window-derived list would silently drop the other 3).
 *  Empty map (never throws) on a missing table or transient error, same
 *  contract as fetchMasterSkuidMap. */
export async function fetchMasterSkuidsByName(): Promise<Map<string, Map<string, string[]>>> {
  try {
    const data = await fetchAllRows(TABLE, (q) => q);
    const out = new Map<string, Map<string, string[]>>();
    (data as Record<string, unknown>[]).forEach((r) => {
      const sku = String(r["SKU ID"] ?? "").trim();
      const name = String(r["Product Name"] ?? "").trim();
      const platform = String(r["Platform"] ?? "").trim();
      if (!sku || !name || !platform) return;
      const key = name.toLowerCase();
      let byPlatform = out.get(key);
      if (!byPlatform) { byPlatform = new Map(); out.set(key, byPlatform); }
      const list = byPlatform.get(platform) || [];
      if (!list.includes(sku)) list.push(sku);
      byPlatform.set(platform, list);
    });
    return out;
  } catch {
    return new Map();
  }
}

export interface MasterSkuidCatalogEntry {
  sku: string;
  name: string;
  category: string;
}

/** Every distinct Amazon-platform SKU in master_product_skuid — for seeding a report with a row
 *  for every known product, even ones with zero orders in the report's window, so the seller can
 *  see what *isn't* selling and not just what is. Platform-scoped on purpose: a SKU spelling that
 *  only exists on Flipkart/Meesho/the Barm website must never show up as a "zero-sale Amazon
 *  product" it never actually was. Empty array (never throws) if the table is missing/empty. */
export async function fetchMasterSkuidAmazonCatalog(): Promise<MasterSkuidCatalogEntry[]> {
  try {
    const data = await fetchAllRows(TABLE, (q) => q.eq("Platform", "Amazon"));
    const seen = new Set<string>();
    const out: MasterSkuidCatalogEntry[] = [];
    (data as Record<string, unknown>[]).forEach((r) => {
      const sku = String(r["SKU ID"] ?? "").trim();
      const name = String(r["Product Name"] ?? "").trim();
      if (!sku || !name || seen.has(sku)) return;
      seen.add(sku);
      out.push({ sku, name, category: normalizeCategory(String(r["Category"] ?? "")) });
    });
    return out;
  } catch {
    return [];
  }
}

export interface MasterSkuidRow {
  sku: string;
  name: string;
  category: string;
  platform: string;
}

/** Every row in master_product_skuid, unfiltered and undeduped — one row per SKU *variant* per
 *  platform, for browsing/searching the raw table (the "Master" catalog tab) rather than
 *  resolving a single sku -> entry lookup. Empty array (never throws) if the table is
 *  missing/empty, same contract as the other fetchers in this file. */
export async function fetchMasterSkuidCatalog(): Promise<MasterSkuidRow[]> {
  try {
    const data = await fetchAllRows(TABLE, (q) => q);
    return (data as Record<string, unknown>[])
      .map((r) => ({
        sku: String(r["SKU ID"] ?? "").trim(),
        name: String(r["Product Name"] ?? "").trim(),
        category: normalizeCategory(String(r["Category"] ?? "")),
        platform: String(r["Platform"] ?? "").trim(),
      }))
      .filter((r) => r.sku || r.name);
  } catch {
    return [];
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

// Every report used a single flat 18% GST assumption for every product before per-product tax
// was wired in — kept as the fallback for a SKU with nothing in master_product_skuid's Tax
// column (or the 2 rows observed with it NULL), so an unresolved SKU's Spend(with tax) doesn't
// silently drop to a 0% assumption it was never verified against.
export const DEFAULT_GST_MULTIPLIER = 1.18;

// Every report used to apply each SKU's own real GST rate from master_product_skuid's Tax
// column (5% for most health devices, 18% for a few) instead of a flat 18% for everyone — more
// accurate to the actual invoiced tax, but it made every report disagree with the seller's own
// manual "Ad spend report" workbook, which has always assumed a flat 18% across every product.
// Per the seller's explicit choice (reconciling Ad_Spend_Report_2026-08-31 (3).xlsx against
// their manual file on 2026-09-02), every report now matches the manual file's flat-18%
// assumption instead — the `tax` argument is intentionally ignored so this only has to change
// in one place if that decision is ever revisited; the resolveTax plumbing that feeds it is left
// in place rather than ripped out everywhere it's called.
export function gstMultiplierFromTax(_tax: number | null | undefined): number {
  return DEFAULT_GST_MULTIPLIER;
}
