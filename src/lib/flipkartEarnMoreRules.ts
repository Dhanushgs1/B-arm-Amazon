// Pure helpers for the Earn More source table (barm_flipkart_earn_more) used by
// the Flipkart Historical Analysis Report. Kept free of Supabase imports so the
// window and coverage rules can be unit-tested directly.

export const EARN_MORE_MISSING_LABEL = "Earn More data missing";
/** Shown in place of a price, ACOS or TACOS that cannot be computed without one. */
export const PRICE_MISSING_LABEL = "Price missing";

export type EarnMoreCoverage = {
  /** Records whose order_date falls inside the window, both ends inclusive. */
  rowCount: number;
  /** False when the window has no Earn More records at all. */
  hasRecords: boolean;
  /** Earliest and latest order_date among the in-window records, or null. */
  dataFrom: string | null;
  dataThrough: string | null;
};

/** Order dates are stored as YYYY-MM-DD; compare on that prefix only. */
function dayOf(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 10) : "";
}

/** Earn More rows whose order_date sits in [start, end], both inclusive. */
export function earnMoreRowsInWindow<T extends { order_date?: unknown }>(
  rows: readonly T[],
  start: string,
  end: string
): T[] {
  return rows.filter((r) => {
    const d = dayOf(r.order_date);
    return d !== "" && d >= start && d <= end;
  });
}

/** Whether the window has any Earn More records, and what dates they cover. */
export function earnMoreCoverage<T extends { order_date?: unknown }>(
  rows: readonly T[],
  start: string,
  end: string
): EarnMoreCoverage {
  const inWindow = earnMoreRowsInWindow(rows, start, end);
  const days = inWindow.map((r) => dayOf(r.order_date)).sort();
  return {
    rowCount: inWindow.length,
    hasRecords: inWindow.length > 0,
    dataFrom: days[0] ?? null,
    dataThrough: days[days.length - 1] ?? null,
  };
}

/**
 * Days strictly between the first and last record date (inside the window) that
 * have no Earn More record at all. These cannot be told apart from days with no
 * sales, so callers report them as a limitation, not as missing data.
 */
export function earnMoreDaysWithoutRecords<T extends { order_date?: unknown }>(
  rows: readonly T[],
  start: string,
  end: string
): string[] {
  const coverage = earnMoreCoverage(rows, start, end);
  if (!coverage.hasRecords) return [];
  const present = new Set(earnMoreRowsInWindow(rows, start, end).map((r) => dayOf(r.order_date)));
  const gaps: string[] = [];
  const stepMs = 86_400_000;
  for (let t = Date.parse(`${coverage.dataFrom}T00:00:00Z`); t <= Date.parse(`${coverage.dataThrough}T00:00:00Z`); t += stepMs) {
    const day = new Date(t).toISOString().slice(0, 10);
    if (!present.has(day)) gaps.push(day);
  }
  return gaps;
}

/**
 * True when the window has Earn More records, but they do not reach both ends of
 * the window — a total built from them is partial and must say so.
 */
export function earnMoreIsPartial(coverage: EarnMoreCoverage, start: string, end: string): boolean {
  return coverage.hasRecords && (coverage.dataFrom! > start || coverage.dataThrough! < end);
}

/**
 * Excel formula for a ratio that shows `label` instead of a number whenever the
 * price cell is not a positive number. A text price ("Price missing") never reaches
 * the division, and a zero price never produces a 0%.
 */
export function ratioFormula(numerator: string, priceRef: string, label: string): string {
  return `IF(ISNUMBER(${priceRef}),IF(${priceRef}>0,${numerator}/${priceRef},"${label}"),"${label}")`;
}

/**
 * Realised average selling price per SKU: final sale amount / final sale units,
 * over the rows given. Falls back to GMV and gross units when the final-sale
 * columns are empty. A SKU with no units has no entry — no estimate is made.
 */
export function realisedAspBySku<
  T extends { sku_id?: unknown; final_sale_amount?: unknown; gmv?: unknown; final_sale_units?: unknown; gross_units?: unknown }
>(rows: readonly T[]): Map<string, number> {
  const acc = new Map<string, { amount: number; units: number }>();
  for (const r of rows) {
    if (typeof r.sku_id !== "string" || r.sku_id === "") continue;
    const a = acc.get(r.sku_id) ?? { amount: 0, units: 0 };
    a.amount += Number(r.final_sale_amount) || Number(r.gmv) || 0;
    a.units += Number(r.final_sale_units) || Number(r.gross_units) || 0;
    acc.set(r.sku_id, a);
  }
  const asp = new Map<string, number>();
  for (const [sku, a] of acc) {
    if (a.units > 0) asp.set(sku, a.amount / a.units);
  }
  return asp;
}

/**
 * The price used for ACOS/TACOS: the listed selling price when present, else the
 * realised ASP, else 0. Zero means "unknown" — callers must print PRICE_MISSING_LABEL
 * rather than a ratio built on it.
 */
export function resolvePrice(listingPrice: number, aspPrice: number | undefined): number {
  if (listingPrice > 0) return listingPrice;
  return aspPrice !== undefined && aspPrice > 0 ? aspPrice : 0;
}

/**
 * Final sale amount summed per SKU over the rows given. Rows should already be
 * window-filtered; no estimate is made when a SKU or the window has no rows.
 */
export function finalSaleAmountBySku<
  T extends { sku_id?: unknown; final_sale_amount?: unknown }
>(rows: readonly T[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const r of rows) {
    if (typeof r.sku_id !== "string" || r.sku_id === "") continue;
    const amount = Number(r.final_sale_amount) || 0;
    totals.set(r.sku_id, (totals.get(r.sku_id) ?? 0) + amount);
  }
  return totals;
}

/** Shown for an average whose denominator is zero — never a division by 1. */
export const NA_LABEL = "N/A";

/** The Analysis-sheet price cell: the rounded price when it is a positive number, else the label. */
export function priceCellValue(price: unknown): number | string {
  return typeof price === "number" && Number.isFinite(price) && price > 0 ? Math.round(price) : PRICE_MISSING_LABEL;
}

/** numerator / denominator, or N/A when the denominator is not positive. */
export function ratioOrNA(numerator: number, denominator: number): number | string {
  return denominator > 0 ? numerator / denominator : NA_LABEL;
}

export type AcosPair = { sku: string; price: number; adUnits: number; spendTax: number };

/**
 * Average ACOS over priced campaign-SKU pairs only. Numerator and denominator use the
 * same eligible population; an unpriced pair's spend is reported as excluded, not
 * added to the numerator.
 */
export function acosPopulation(pairs: readonly AcosPair[]) {
  let numerator = 0;
  let denominator = 0;
  let excludedSpend = 0;
  const excludedSkus = new Set<string>();
  for (const p of pairs) {
    if (p.price > 0) {
      numerator += p.spendTax;
      denominator += p.price * p.adUnits;
    } else {
      excludedSpend += p.spendTax;
      if (p.spendTax > 0) excludedSkus.add(p.sku);
    }
  }
  return {
    numerator,
    denominator,
    excludedSpend,
    excludedSkuCount: excludedSkus.size,
    value: ratioOrNA(numerator, denominator),
  };
}

export type TacosSku = { sku: string; price: number; netUnits: number };

/**
 * Average TACOS: total spend across all SKUs over total sales across all SKUs.
 * An unpriced SKU with net units has sales that cannot be valued; it is counted and
 * disclosed, never estimated.
 */
export function tacosPopulation(totalSpend: number, skus: readonly TacosSku[]) {
  let denominator = 0;
  const unpricedWithSales = new Set<string>();
  for (const s of skus) {
    if (s.price > 0) denominator += s.price * s.netUnits;
    else if (s.netUnits > 0) unpricedWithSales.add(s.sku);
  }
  return {
    numerator: totalSpend,
    denominator,
    unpricedSkuWithSalesCount: unpricedWithSales.size,
    value: ratioOrNA(totalSpend, denominator),
  };
}
