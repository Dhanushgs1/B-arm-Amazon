import * as XLSX from "xlsx";
import { supabasePublic } from "@/lib/amazonReportUpload";

// The seller's own hand-curated product master workbook — a full snapshot of
// every SKU -> canonical product name, re-uploaded whenever the workbook is
// rebuilt. No date column, so each upload truncates and replaces the whole
// table rather than merging (same pattern as Amazon's Price/FBA Inventory
// snapshots — see amazonReportUpload.ts's FULL_REPLACE_TYPES).
//
// Two file shapes have been seen, both supported by the header picker below:
//   - "Master SKU sheet with Category.xlsx": Product, Product name, SKU ID,
//     Platforms, Category — one row per SKU *variant* (a product advertised
//     on 3 platforms under 3 different SKU spellings gets 3 rows, all
//     pointing to the same Product name). This is the preferred shape — it
//     resolves exact variant spellings ("B-CRACKNIP-SPRAY-100ML-1") that the
//     other shape's single canonical SKU per product can't match directly.
//   - "Product_Master_REBUILT_Aug2026_Update.xlsx": Master SKU ID, Approved
//     Product Name, Category — one row per canonical product.
//
// adSpendReportExport.ts checks this table FIRST when resolving a product's
// display name for a SKU — ahead of the order-report/price-listing derived
// name and the old hand-maintained SKU_NAME_MAP in categoryMap.ts — since
// this is the one the seller's team actually curates and approves.
//
// Run scripts/product_master_table.sql once in the Supabase SQL Editor
// before the first upload.

type RawRow = Record<string, unknown>;

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function normalizeHeaderKey(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Header lookup tolerant of trailing spaces / case, same approach as the
 *  other *ReportUpload.ts modules' makePicker. */
function makePicker(row: RawRow) {
  const normalized = new Map<string, string>();
  Object.keys(row).forEach((k) => normalized.set(normalizeHeaderKey(k), k));
  return (...candidates: string[]): unknown => {
    for (const cand of candidates) {
      const hit = normalized.get(normalizeHeaderKey(cand));
      if (hit !== undefined) return row[hit];
    }
    return "";
  };
}

function findSheet(wb: XLSX.WorkBook, name: string): XLSX.WorkSheet {
  const hit = wb.SheetNames.find((n) => normalizeHeaderKey(n) === normalizeHeaderKey(name));
  return wb.Sheets[hit ?? wb.SheetNames[0]];
}

async function readRows(file: File): Promise<RawRow[]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const ws = findSheet(wb, "Product Master");
  return XLSX.utils.sheet_to_json<RawRow>(ws, { defval: "", raw: true });
}

// Placeholder tokens some rows use for "no SKU assigned yet" — must never be
// treated as a real SKU, or every product using that placeholder collides on
// the same primary key and only one survives.
const SKU_PLACEHOLDERS = new Set(["nil", "na", "n/a", "-", "tbd", "none"]);

function mapRow(row: RawRow): { sku: string; product_name: string; category: string; approval_status: string; raw: RawRow } {
  const p = makePicker(row);
  let sku = str(p("SKU ID", "Master SKU ID", "SKU"));
  if (SKU_PLACEHOLDERS.has(sku.toLowerCase())) sku = "";
  return {
    sku,
    product_name: str(p("Product name", "Approved Product Name", "Master Product", "Product Name", "Product")),
    category: str(p("Category")),
    approval_status: str(p("Approval Status")),
    raw: row,
  };
}

const TABLE = "barm_product_master";

async function truncateAndInsert(rows: Record<string, unknown>[]): Promise<void> {
  // No natural "this run's rows" filter to delete by (unlike the date-scoped
  // tables) — a snapshot upload always fully replaces the prior one.
  const { error: delErr } = await supabasePublic.from(TABLE).delete().not("sku", "is", null);
  if (delErr) throw new Error(`Clearing ${TABLE} failed: ${delErr.message}`);

  const chunkSize = 300;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const { error } = await supabasePublic.from(TABLE).insert(rows.slice(i, i + chunkSize));
    if (error) throw new Error(`Insert into ${TABLE} failed: ${error.message}`);
  }
}

export interface ProductMasterUploadResult {
  totalRows: number;
  savedRows: number;
  skippedRows: number;
}

export async function uploadProductMaster(file: File): Promise<ProductMasterUploadResult> {
  const rawRows = await readRows(file);
  const mapped = rawRows.map(mapRow);
  const valid = mapped.filter((r) => r.sku && r.product_name);

  if (!valid.length) {
    return { totalRows: rawRows.length, savedRows: 0, skippedRows: rawRows.length };
  }

  // Two rows sharing a SKU would otherwise collide on the primary key mid-insert.
  const seen = new Set<string>();
  const deduped = valid.filter((r) => (seen.has(r.sku) ? false : (seen.add(r.sku), true)));

  await truncateAndInsert(deduped);

  return { totalRows: rawRows.length, savedRows: deduped.length, skippedRows: rawRows.length - deduped.length };
}

export interface ProductMasterDataInfo {
  rowCount: number;
  error?: string;
}

export async function fetchProductMasterDataInfo(): Promise<ProductMasterDataInfo> {
  const { count, error } = await supabasePublic.from(TABLE).select("*", { count: "exact", head: true });
  if (error) return { rowCount: 0, error: error.message };
  return { rowCount: count || 0 };
}

/** sku -> approved product name. Empty map (never throws) if the table is
 *  missing (scripts/product_master_table.sql not run yet) or empty — a
 *  seller who hasn't uploaded a master yet must fall back cleanly to the
 *  order-report/price-listing name, not break report generation. */
export async function fetchProductMasterNameMap(): Promise<Map<string, string>> {
  try {
    const { data, error } = await supabasePublic.from(TABLE).select("sku, product_name");
    if (error || !data) return new Map();
    const map = new Map<string, string>();
    (data as { sku: string; product_name: string }[]).forEach((r) => {
      if (r.sku && r.product_name) map.set(r.sku, r.product_name);
    });
    return map;
  } catch {
    return new Map();
  }
}

export interface ProductMasterEntry {
  name: string;
  category: string;
}

/** sku -> { name, category }. Same empty-map-never-throws contract as
 *  fetchProductMasterNameMap above, for callers that also need category
 *  (currently only the Amazon Sales report — the other exporters have no
 *  category column). */
export async function fetchProductMasterMap(): Promise<Map<string, ProductMasterEntry>> {
  try {
    const { data, error } = await supabasePublic.from(TABLE).select("sku, product_name, category");
    if (error || !data) return new Map();
    const map = new Map<string, ProductMasterEntry>();
    (data as { sku: string; product_name: string; category: string }[]).forEach((r) => {
      if (r.sku && r.product_name) map.set(r.sku, { name: r.product_name, category: r.category || "" });
    });
    return map;
  } catch {
    return new Map();
  }
}

// Platform order/ad exports carry whatever variant spelling of a SKU that platform used (e.g. a
// trailing "-1", a "-S" (a listing/campaign variant with no row of its own in any master table),
// or a "(FK)"/"(AM)"/"(MS)" tag), while the master lists one canonical spelling per product — so
// an exact match misses these. Strip the variant/platform suffix before comparing. Shared by every
// report exporter that resolves against the product master, so the matching rule stays identical
// everywhere it's used — this is also why a SKU ending in "-S" (e.g. "B-INSEM-KIT-PK5-S", "A015-S")
// used to resolve to the wrong (fallback) product name and print as its own incomplete report row:
// it never matched anything by base SKU, since only the numeric-suffix strip existed here.
export function skuBase(sku: string): string {
  return sku.trim().toUpperCase().replace(/\((AM|FK|MS)\)$/i, "").replace(/-\d+$/, "").replace(/-S$/i, "").replace(/[\s_]+/g, "");
}

/** Builds sku -> name/category resolvers from a product-master map: exact SKU match first, then
 *  a fall back to the same SKU's "base" spelling (see skuBase), then the caller's fallback value.
 *  Only what's actually stored (name always, category only if non-empty) overrides the fallback —
 *  this only changes which name/category gets displayed, every spend/order figure stays keyed on
 *  the platform's own exact SKU string. */
export function buildProductMasterResolver(master: Map<string, ProductMasterEntry>) {
  const byBase = new Map<string, ProductMasterEntry>();
  master.forEach((entry, sku) => {
    const base = skuBase(sku);
    if (!byBase.has(base)) byBase.set(base, entry);
  });
  const lookup = (sku: string): ProductMasterEntry | undefined => master.get(sku) || byBase.get(skuBase(sku));
  return {
    resolveName: (sku: string, fallback: string): string => lookup(sku)?.name || fallback,
    resolveCategory: (sku: string, fallback: string): string => lookup(sku)?.category || fallback,
  };
}
