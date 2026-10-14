import * as XLSX from "npm:xlsx@0.18.5";
import { supabasePublic } from "./amazonReportUpload.ts";
import { fetchAllRows } from "./amazonReportShared.ts";
import { skuBase } from "./productMasterUpload.ts";
import { normalizeCategory } from "./masterProductSkuid.ts";

// The marketing team's own "Master SKU sheet with Category" workbook — one
// row per SKU *variant* per platform (the same SKU code can repeat across
// several platform rows for one product — e.g. "SCGSB1" used by both
// Flipkart and Amazon). A full snapshot re-uploaded whenever the workbook is
// rebuilt, same truncate-and-replace pattern as barm_product_master (see
// productMasterUpload.ts).
//
// This is the freshest, most current master the marketing team maintains —
// checked FIRST by every report exporter when resolving a product's display
// name/category for a SKU, ahead of master_product_skuid and
// barm_product_master (see buildProductMarketingResolver below).
//
// Run scripts/product_marketing_table.sql once in the Supabase SQL Editor
// before the first upload.

type RawRow = Record<string, unknown>;

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function normalizeHeaderKey(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

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

async function readRows(file: File): Promise<RawRow[]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json<RawRow>(ws, { defval: "", raw: true });
}

interface MappedRow {
  product: string;
  product_name: string;
  sku: string;
  platform: string;
  category: string;
  raw: RawRow;
}

function mapRow(row: RawRow): MappedRow {
  const p = makePicker(row);
  return {
    product: str(p("Product")),
    product_name: str(p("Product name", "Product Name")),
    sku: str(p("SKU ID", "SKU")),
    platform: str(p("Platforms", "Platform")),
    category: normalizeCategory(str(p("Category"))),
    raw: row,
  };
}

const TABLE = "master_product_marketing";

async function truncateAndInsert(rows: Record<string, unknown>[]): Promise<void> {
  // A file with zero usable rows (wrong report, renamed columns) must never wipe the
  // existing snapshot — the delete below would otherwise leave the table empty.
  if (rows.length === 0) throw new Error("No valid rows found in this file — check it is the right report. Existing data was left unchanged.");
  // No natural "this run's rows" filter to delete by (unlike the date-scoped
  // tables) — a snapshot upload always fully replaces the prior one.
  const { error: delErr } = await supabasePublic.from(TABLE).delete().not("id", "is", null);
  if (delErr) throw new Error(`Clearing ${TABLE} failed: ${delErr.message}`);

  const chunkSize = 300;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const { error } = await supabasePublic.from(TABLE).insert(rows.slice(i, i + chunkSize));
    if (error) throw new Error(`Insert into ${TABLE} failed: ${error.message}`);
  }
}

export interface ProductMarketingUploadResult {
  totalRows: number;
  savedRows: number;
  skippedRows: number;
}

export async function uploadProductMarketing(file: File): Promise<ProductMarketingUploadResult> {
  const rawRows = await readRows(file);
  const mapped = rawRows.map(mapRow);
  const valid = mapped.filter((r) => r.sku && r.product_name);

  if (!valid.length) {
    return { totalRows: rawRows.length, savedRows: 0, skippedRows: rawRows.length };
  }

  await truncateAndInsert(valid as unknown as Record<string, unknown>[]);

  return { totalRows: rawRows.length, savedRows: valid.length, skippedRows: rawRows.length - valid.length };
}

export interface ProductMarketingDataInfo {
  rowCount: number;
  error?: string;
}

export async function fetchProductMarketingDataInfo(): Promise<ProductMarketingDataInfo> {
  const { count, error } = await supabasePublic.from(TABLE).select("*", { count: "exact", head: true });
  if (error) return { rowCount: 0, error: error.message };
  return { rowCount: count || 0 };
}

export interface ProductMarketingCatalogRow {
  id: number;
  sku: string;
  name: string;
  category: string;
  platform: string;
}

/** Every row in master_product_marketing, unfiltered and undeduped — one row per SKU *variant*
 *  per platform, for browsing/searching the raw table (the "Master" catalog tab) rather than
 *  resolving a single sku -> entry lookup. Same shape/contract as fetchMasterSkuidCatalog in
 *  masterProductSkuid.ts, which the Master page fetched before this table existed — empty array
 *  (never throws) if the table is missing/empty. */
export async function fetchProductMarketingCatalog(): Promise<ProductMarketingCatalogRow[]> {
  try {
    const data = await fetchAllRows(TABLE, (q) => q);
    return (data as Record<string, unknown>[])
      .map((r) => ({
        id: Number(r.id),
        sku: String(r.sku ?? "").trim(),
        name: String(r.product_name ?? "").trim(),
        category: String(r.category ?? "").trim(),
        platform: String(r.platform ?? "").trim(),
      }))
      .filter((r) => r.sku || r.name);
  } catch {
    return [];
  }
}

export interface ProductMarketingRowEdits {
  product_name: string;
  category: string;
  platform: string;
}

/** Edits a single master_product_marketing row in place (by its stable `id`) — unlike the
 *  snapshot-upload path above, this doesn't touch any other row. */
export async function updateProductMarketingRow(id: number, edits: ProductMarketingRowEdits): Promise<void> {
  const { error } = await supabasePublic.from(TABLE).update(edits).eq("id", id);
  if (error) throw new Error(`Updating ${TABLE} row ${id} failed: ${error.message}`);
}

/** Removes a single master_product_marketing row (by its stable `id`). */
export async function deleteProductMarketingRow(id: number): Promise<void> {
  const { error } = await supabasePublic.from(TABLE).delete().eq("id", id);
  if (error) throw new Error(`Deleting ${TABLE} row ${id} failed: ${error.message}`);
}

export interface ProductMarketingEntry {
  name: string;
  category: string;
}

/** sku -> {name, category}, first row wins per SKU (platform-variant rows of the same SKU share
 *  identical name/category). Empty map (never throws) if the table is missing
 *  (scripts/product_marketing_table.sql not run yet) or empty — a report must still generate,
 *  falling back to master_product_skuid/barm_product_master, same contract as those tables'
 *  own fetchers. */
export async function fetchProductMarketingMap(): Promise<Map<string, ProductMarketingEntry>> {
  try {
    const data = await fetchAllRows(TABLE, (q) => q);
    const map = new Map<string, ProductMarketingEntry>();
    (data as Record<string, unknown>[]).forEach((r) => {
      const sku = String(r.sku ?? "").trim();
      const name = String(r.product_name ?? "").trim();
      if (!sku || !name || map.has(sku)) return;
      map.set(sku, { name, category: String(r.category ?? "").trim() });
    });
    return map;
  } catch {
    return new Map();
  }
}

/** Builds sku -> name/category resolvers from a product-marketing map: exact SKU match first,
 *  then a fall back to the same SKU's "base" spelling (see skuBase in productMasterUpload.ts) for
 *  a platform-variant spelling this table doesn't carry. Only what's actually stored (name
 *  always, category only if non-empty) overrides the fallback. */
export function buildProductMarketingResolver(marketing: Map<string, ProductMarketingEntry>) {
  const byBase = new Map<string, ProductMarketingEntry>();
  marketing.forEach((entry, sku) => {
    const base = skuBase(sku);
    if (!byBase.has(base)) byBase.set(base, entry);
  });
  const lookup = (sku: string): ProductMarketingEntry | undefined => marketing.get(sku) || byBase.get(skuBase(sku));
  return {
    resolveName: (sku: string, fallback: string): string => lookup(sku)?.name || fallback,
    resolveCategory: (sku: string, fallback: string): string => lookup(sku)?.category || fallback,
  };
}
