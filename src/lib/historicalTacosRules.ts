// Row selection and undefined-ratio rules for the Historical report's TACOS sheet. Pure (no XLSX or Supabase
// imports) so the regression tests can exercise the same functions the workbook uses.
//
// A SKU appears on the TACOS sheet when it has spend, orders or returns in the 30-day window. A SKU with none of
// those is a zero-spend catalogue row and is left out. A SKU whose spend has no net orders stays listed: its
// CPC and TACOS are undefined, so they read "N/A" and never zero or a number that divides by 1.

export const NOT_APPLICABLE = "N/A";

export interface ActivityWindow {
  spendTax: number;
  orderUnits: number;
  returns: number;
}

/** True when the SKU had any spend, orders or returns in the window. */
export function hasWindowActivity(w: ActivityWindow): boolean {
  return w.spendTax > 0 || w.orderUnits > 0 || w.returns > 0;
}

/** Whether a SKU row appears on the TACOS sheet. The UNMAPPED placeholder never does. */
export function tacosSheetRowIncluded(w: ActivityWindow, isUnmapped: boolean): boolean {
  return !isUnmapped && hasWindowActivity(w);
}

/** CPC per net order (Spend+Tax ÷ Final orders), or N/A when there are no net orders. */
export function cpcPerNetOrder(spendTax: number, finalOrders: number): number | typeof NOT_APPLICABLE {
  return finalOrders > 0 ? spendTax / finalOrders : NOT_APPLICABLE;
}

/** TACOS (CPC ÷ price), or N/A when net orders or price are zero. */
export function tacosValue(spendTax: number, finalOrders: number, price: number): number | typeof NOT_APPLICABLE {
  const cpc = cpcPerNetOrder(spendTax, finalOrders);
  return typeof cpc === "number" && price > 0 ? cpc / price : NOT_APPLICABLE;
}

/**
 * Excel formulas for the TACOS sheet's CPC and TACOS cells. They mirror cpcPerNetOrder and tacosValue, so the live
 * sheet shows the same N/A as the cached value when Final orders or price are zero.
 */
export function cpcFormula(spendCell: string, finalCell: string): string {
  return `IF(${finalCell}>0,${spendCell}/${finalCell},"${NOT_APPLICABLE}")`;
}
export function tacosFormula(cpcCell: string, priceCell: string): string {
  return `IF(AND(ISNUMBER(${cpcCell}),${priceCell}>0),${cpcCell}/${priceCell},"${NOT_APPLICABLE}")`;
}
