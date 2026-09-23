// Builds the calculation engine's manual plan (fbaForecastCalc.ts PlanRow)
// from the two stored reference tables: barm_fba_manual_plan (the manual
// sheet's permanent SKU × zone list, in its row order) and
// barm_fba_sku_stock_to_send (the latest saved column X, ONE value per SKU,
// maintained on the FBA page). Each SKU's X applies to all of its zones; a
// SKU with no saved X (or a blank one) sends 0, as in the manual.
import type { PlanRow } from "./fbaForecastCalc.ts";

export interface RawPlanRow { row_order: number; sku: string; zone: string; }
export interface RawSkuStockToSend { sku: string; stock_to_send: number | string | null; }

export function buildPlan(planRaw: RawPlanRow[], xRaw: RawSkuStockToSend[]): PlanRow[] | undefined {
  if (planRaw.length === 0) return undefined;
  const xBySku = new Map<string, number | null>();
  for (const x of xRaw) {
    xBySku.set(x.sku, x.stock_to_send === null || x.stock_to_send === "" ? null : Number(x.stock_to_send));
  }
  return [...planRaw]
    .sort((a, b) => a.row_order - b.row_order)
    .map((p) => ({ sku: p.sku, zone: p.zone, stockToSend: xBySku.get(p.sku) ?? null, order: p.row_order }));
}
