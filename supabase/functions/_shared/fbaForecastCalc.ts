// Pure calculation engine for the FBA Analysis report — no I/O, no
// Supabase, no XLSX. Takes already-zoned rows (zone assignment is
// fbaZones.ts's job) and a product-name resolver, and reproduces every
// formula from the user's real "FBA analysis" sheet (see docs/superpowers/
// specs/2026-09-22-fba-forecast-refresh-design.md for the column-by-column
// derivation). Grain: one output row per (sku, zone). Do NOT modify these
// formulas — they are reverse-engineered from the user's live workbook, not
// guessed, and this feature's brief explicitly forbids changing them. The
// optional manual plan (the sheet's own SKU × zone list and column X) was
// verified by feeding the manual workbook's own raw sheets through this
// function: every G–AA cell matched except where the manual itself errors
// (a text "-" in X) or drops an unmapped-zone sale.

export interface SalesRow { sku: string; zone: string; quantity: number; }
export interface StockRow { sku: string; zone: string; quantity: number; }
export type StatusCategory = "booked" | "picked_up" | "active";
export interface StatusRow { sku: string; zone: string; quantity: number; category: StatusCategory; }
/** One row of the seller's own manual "FBA analysis" sheet: its typed-in
 *  SKU × zone list (column B/D) and column X "Stock present per SKU ID for
 *  FBA - booked" (null when blank), in the sheet's row order. */
export interface PlanRow { sku: string; zone: string; stockToSend: number | null; order: number; }

export interface FbaAnalysisRow {
  sku: string;
  zone: string;
  productName: string;
  sales30d: number;
  dailyRate: number;
  forecast120dZone: number;
  totalOrders30dSku: number;
  totalForecast120dSku: number;
  maxForecastPerProduct: number;
  minStockNeededZone: number;
  salesPctRegion: number | "NO SALES";
  currentStockZone: number;
  totalStockSku: number;
  stockNeededZone: number;
  bookedZone: number;
  intransitZone: number;
  bookedPlusIntransitZone: number;
  stockNeededAfterInboundZone: number;
  totalStockNeededAfterInboundSku: number;
  /** Manual column X for this row, or null (no plan, or blank in the plan). */
  stockToSendSku: number | null;
  /** Position in the manual plan, or null for a row the plan doesn't list. */
  planOrder: number | null;
  activeZoneAccumulated: number;
  toBeSentZone: number;
  stockToBeOrderedZone: number;
  daysUntilStockout: number | "--";
}

function sumBy<T>(rows: T[], keyOf: (r: T) => string, valueOf: (r: T) => number): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const key = keyOf(r);
    out.set(key, (out.get(key) || 0) + valueOf(r));
  }
  return out;
}

const rowKey = (sku: string, zone: string) => `${sku} ${zone}`;

// Excel's ROUND(x, 0): halves round away from zero (JS Math.round rounds
// -2.5 to -2, Excel to -3).
const excelRound = (x: number) => Math.sign(x) * Math.round(Math.abs(x));

/**
 * `plan` (optional) is the seller's manual FBA analysis sheet. Without it,
 * rows exist only where there is data and "to be sent" is the full need.
 * With it — exactly like the manual — every plan row is listed (in plan
 * order, empty zones flooring at a forecast of 5), then any data rows the
 * plan doesn't list, and:
 *   to be sent          Y = IFERROR(ROUND(MIN(U/V*X, U), 0), 0)
 *   stock to be ordered Z = V - X
 * where X is the plan's typed-in stock for that row (blank = 0).
 */
export function computeFbaAnalysis(
  salesRows: SalesRow[],
  stockRows: StockRow[],
  statusRows: StatusRow[],
  resolveProductName: (sku: string) => string,
  plan?: PlanRow[]
): FbaAnalysisRow[] {
  const salesByKey = sumBy(salesRows, (r) => rowKey(r.sku, r.zone), (r) => r.quantity);
  const stockByKey = sumBy(stockRows, (r) => rowKey(r.sku, r.zone), (r) => r.quantity);
  const bookedByKey = sumBy(statusRows.filter((r) => r.category === "booked"), (r) => rowKey(r.sku, r.zone), (r) => r.quantity);
  const intransitByKey = sumBy(statusRows.filter((r) => r.category === "picked_up"), (r) => rowKey(r.sku, r.zone), (r) => r.quantity);
  const activeByKey = sumBy(statusRows.filter((r) => r.category === "active"), (r) => rowKey(r.sku, r.zone), (r) => r.quantity);

  // Every (sku, zone) pair that appears in ANY of the three quantity-bearing
  // inputs is a row — a SKU can have stock/booked/intransit in a zone with
  // zero sales, or sales in a zone with zero stock, and both must still
  // appear (this exactly matches PIVOT_30/PIVOT_fba/etc. each being keyed
  // off the union of "id + zone" values encountered anywhere in the sheet).
  // With a manual plan, its rows come first in its own order (Set keeps
  // insertion order), then data rows it doesn't list.
  const planByKey = new Map<string, PlanRow>();
  for (const p of [...(plan || [])].sort((a, b) => a.order - b.order)) {
    const key = rowKey(p.sku, p.zone);
    if (!planByKey.has(key)) planByKey.set(key, p);
  }
  const allKeys = new Set<string>([...planByKey.keys(), ...salesByKey.keys(), ...stockByKey.keys(), ...bookedByKey.keys(), ...intransitByKey.keys(), ...activeByKey.keys()]);

  interface Zoned { sku: string; zone: string; sales30d: number; forecast120dZone: number; currentStockZone: number; bookedZone: number; intransitZone: number; }
  const zoned: Zoned[] = [];
  for (const key of allKeys) {
    const [sku, zone] = key.split(" ");
    const sales30d = salesByKey.get(key) || 0;
    const dailyRate = sales30d / 30;
    const forecast120dZone = sales30d === 0 ? 5 : dailyRate * 120;
    zoned.push({
      sku, zone, sales30d,
      forecast120dZone,
      currentStockZone: stockByKey.get(key) || 0,
      bookedZone: bookedByKey.get(key) || 0,
      intransitZone: intransitByKey.get(key) || 0,
    });
  }

  // SKU-level rollups (sum across every zone that SKU appears in).
  const skuTotalOrders30d = sumBy(zoned, (r) => r.sku, (r) => r.sales30d);
  const skuTotalForecast120d = sumBy(zoned, (r) => r.sku, (r) => r.forecast120dZone);
  const skuTotalStock = sumBy(zoned, (r) => r.sku, (r) => r.currentStockZone);

  // "Stock needed after inbound" is computed per zone first (it depends on
  // that zone's own forecast/stock/booked/intransit), THEN rolled up per
  // SKU — matches the original sheet's own V formula, which sums the U
  // column (not R).
  const stockNeededAfterInboundZone = new Map<string, number>();
  for (const r of zoned) {
    const stockNeededZone = r.forecast120dZone - r.currentStockZone;
    const afterInbound = Math.max(0, stockNeededZone - (r.bookedZone + r.intransitZone));
    stockNeededAfterInboundZone.set(rowKey(r.sku, r.zone), afterInbound);
  }
  const skuTotalStockNeededAfterInbound = new Map<string, number>();
  for (const r of zoned) {
    const key = rowKey(r.sku, r.zone);
    const v = stockNeededAfterInboundZone.get(key) || 0;
    skuTotalStockNeededAfterInbound.set(r.sku, (skuTotalStockNeededAfterInbound.get(r.sku) || 0) + v);
  }

  // "Max forecast per product name" dedups multiple SKU codes mapped to the
  // same physical product by taking the larger of their SKU-level forecasts.
  const productNameBySku = new Map<string, string>();
  const maxForecastByProduct = new Map<string, number>();
  for (const sku of skuTotalForecast120d.keys()) {
    const name = resolveProductName(sku);
    productNameBySku.set(sku, name);
    const forecast = skuTotalForecast120d.get(sku) || 0;
    maxForecastByProduct.set(name, Math.max(maxForecastByProduct.get(name) || 0, forecast));
  }

  const out: FbaAnalysisRow[] = [];
  for (const r of zoned) {
    const key = rowKey(r.sku, r.zone);
    const totalOrders30dSku = skuTotalOrders30d.get(r.sku) || 0;
    const totalForecast120dSku = skuTotalForecast120d.get(r.sku) || 0;
    const totalStockSku = skuTotalStock.get(r.sku) || 0;
    const totalStockNeededAfterInboundSku = skuTotalStockNeededAfterInbound.get(r.sku) || 0;
    const stockNeededZone = r.forecast120dZone - r.currentStockZone;
    const stockNeededAfterInbound = stockNeededAfterInboundZone.get(key) || 0;
    // Without a plan: "however much is actually needed", surfaced directly.
    // With a plan: the manual's own Y/Z formulas against its column X.
    const planRow = planByKey.get(key);
    const stockToSendSku = planRow ? planRow.stockToSend : null;
    let toBeSentZone = stockNeededAfterInbound;
    let stockToBeOrderedZone = totalStockNeededAfterInboundSku;
    if (plan) {
      const x = stockToSendSku ?? 0;
      toBeSentZone = totalStockNeededAfterInboundSku === 0
        ? 0
        : excelRound(Math.min((stockNeededAfterInbound / totalStockNeededAfterInboundSku) * x, stockNeededAfterInbound));
      stockToBeOrderedZone = totalStockNeededAfterInboundSku - x;
    }
    const daysUntilStockout: number | "--" = r.sales30d === 0
      ? "--"
      : Math.round((r.currentStockZone + r.bookedZone + r.intransitZone) / (r.sales30d / 30));

    out.push({
      sku: r.sku,
      zone: r.zone,
      productName: productNameBySku.get(r.sku) || r.sku,
      sales30d: r.sales30d,
      dailyRate: r.sales30d / 30,
      forecast120dZone: r.forecast120dZone,
      totalOrders30dSku,
      totalForecast120dSku,
      maxForecastPerProduct: maxForecastByProduct.get(productNameBySku.get(r.sku) || r.sku) || 0,
      minStockNeededZone: r.forecast120dZone,
      salesPctRegion: r.forecast120dZone === 0 ? "NO SALES" : r.forecast120dZone / totalForecast120dSku,
      currentStockZone: r.currentStockZone,
      totalStockSku,
      stockNeededZone,
      bookedZone: r.bookedZone,
      intransitZone: r.intransitZone,
      bookedPlusIntransitZone: r.bookedZone + r.intransitZone,
      stockNeededAfterInboundZone: stockNeededAfterInbound,
      totalStockNeededAfterInboundSku,
      stockToSendSku,
      planOrder: planRow ? planRow.order : null,
      activeZoneAccumulated: activeByKey.get(key) || 0,
      toBeSentZone,
      stockToBeOrderedZone,
      daysUntilStockout,
    });
  }
  return out;
}
