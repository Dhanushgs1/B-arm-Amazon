// Supabase I/O for the FBA page's "X values" panel: column X (stock ready to
// send), one value per SKU in barm_fba_sku_stock_to_send, listed in the
// manual sheet's own SKU order from barm_fba_manual_plan. See
// scripts/fba_sku_stock_to_send.sql and fbaStockToSend.ts for the rules.
import { supabasePublic } from "@/lib/amazonReportUpload";
import { fetchAllRows } from "@/lib/amazonReportShared";
import { fetchProductMarketingMap, buildProductMarketingResolver } from "@/lib/productMarketingUpload";

export interface SkuStockToSendRow {
  sku: string;
  productName: string;
  stockToSend: number | null;
  updatedAt: string | null;
  /** "manual_migration" (copied once from the manual sheet) or "panel". */
  source: string | null;
  /** Migration note kept as history (e.g. why a value was normalized). */
  note: string | null;
}

export interface SkuStockToSendData {
  rows: SkuStockToSendRow[];
  /** Most recent save across all SKUs (the stale-warning anchor), and where it came from. */
  lastSavedAt: string | null;
  lastSavedSource: string | null;
}

export async function fetchSkuStockToSend(): Promise<SkuStockToSendData> {
  const [plan, xRows, marketing] = await Promise.all([
    fetchAllRows("barm_fba_manual_plan", (q) => q, ["row_order", "id"]),
    fetchAllRows("barm_fba_sku_stock_to_send", (q) => q, "sku"),
    fetchProductMarketingMap(),
  ]);
  const resolver = buildProductMarketingResolver(marketing);
  type XRow = { sku: string; stock_to_send: number | string | null; updated_at: string; source?: string | null; note?: string | null };
  const xBySku = new Map<string, XRow>();
  (xRows as XRow[]).forEach((x) => xBySku.set(x.sku, x));

  const seen = new Set<string>();
  const rows: SkuStockToSendRow[] = [];
  for (const p of plan as Array<{ sku: string }>) {
    if (seen.has(p.sku)) continue;
    seen.add(p.sku);
    const x = xBySku.get(p.sku);
    rows.push({
      sku: p.sku,
      productName: resolver.resolveName(p.sku, ""),
      stockToSend: x && x.stock_to_send !== null && x.stock_to_send !== "" ? Number(x.stock_to_send) : null,
      updatedAt: x ? x.updated_at : null,
      source: x?.source ?? null,
      note: x?.note ?? null,
    });
  }
  const latest = [...xBySku.values()].sort((a, b) => a.updated_at.localeCompare(b.updated_at)).pop();
  return { rows, lastSavedAt: latest?.updated_at ?? null, lastSavedSource: latest?.source ?? null };
}

/** Saves changed X values; returns how many SKUs actually changed. */
export async function saveSkuStockToSend(changes: Array<{ sku: string; stock_to_send: number | null }>): Promise<number> {
  if (changes.length === 0) return 0;
  const { data, error } = await supabasePublic.rpc("save_barm_fba_sku_stock_to_send", { rows: changes });
  if (error) throw new Error(`Saving X values failed: ${error.message}`);
  return Number(data) || 0;
}
