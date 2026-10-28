// Pure grand-total rules for the Historical Analysis report (Analysis report GRAND TOTAL row and the
// Key Insights aggregates). Kept free of XLSX / Supabase imports so the regression tests can exercise
// the same code the workbook uses (see historicalTotalsRules.test.ts).
//
// Grain rules — each metric is summed at the grain where it is a true account total:
//   Spend+Tax, Advertised SKU Units — per campaign x SKU pair. Each pair's spend and units are its own,
//     so summing the pair rows gives the account total with no repetition.
//   Total Units, Orders, Returns — per SKU. Amazon reports them per SKU, so a SKU advertised by two
//     campaigns repeats them on both rows. They are summed once per SKU, never once per row.
//   Final — Orders − Returns, unclamped (a return can belong to an earlier order; see negativeFinalNote).
//   ACOS — total Spend+Tax ÷ Σ(price × advertised units): an aggregate ratio, not an average of rows.
//   TACOS — total Spend+Tax ÷ Σ(price × max(0, Orders − Returns)) per SKU: each SKU's net order
//     volume is floored at zero before it enters the denominator, so a SKU with returns above its
//     orders cannot pull the account TACOS negative.

export interface GrandPairInput {
  sku: string;
  /** Price used for the ACOS denominator (the SKU's price, not the campaign's). */
  price: number;
  /** This campaign x SKU pair's own Spend+Tax. */
  spendTax: number;
  /** This campaign x SKU pair's own Advertised SKU Units. */
  advUnits: number;
}

export interface GrandSkuInput {
  sku: string;
  price: number;
  /** SKU-grain "Total Units (#)" — counted once per SKU. */
  totalUnits: number;
  /** SKU-grain Orders (units) — counted once per SKU. */
  orderUnits: number;
  /** SKU-grain Returns — counted once per SKU. */
  returns: number;
}

export interface GrandTotals {
  spendTax: number;
  advUnits: number;
  totalUnits: number;
  orderUnits: number;
  returns: number;
  final: number;
  cpc: number;
  acos: number;
  tacos: number;
  /** Σ(price × advUnits) over pairs — the ACOS denominator. */
  acosDenom: number;
  /** Σ(price × max(0, Orders − Returns)) over SKUs — the TACOS denominator. */
  tacosDenom: number;
}

/**
 * Account grand totals. `pairs` must hold every campaign x SKU row that is shown on the sheet;
 * `skus` must hold the SKU-grain figures for the SKUs that are shown (one entry per SKU).
 */
export function computeGrandTotals(pairs: GrandPairInput[], skus: GrandSkuInput[]): GrandTotals {
  let spendTax = 0, advUnits = 0, acosDenom = 0;
  for (const p of pairs) {
    spendTax += p.spendTax;
    advUnits += p.advUnits;
    acosDenom += p.price * p.advUnits;
  }
  let totalUnits = 0, orderUnits = 0, returns = 0, tacosDenom = 0;
  for (const s of skus) {
    totalUnits += s.totalUnits;
    orderUnits += s.orderUnits;
    returns += s.returns;
    tacosDenom += s.price * Math.max(0, s.orderUnits - s.returns);
  }
  return {
    spendTax,
    advUnits,
    totalUnits,
    orderUnits,
    returns,
    final: orderUnits - returns,
    cpc: advUnits > 0 ? spendTax / advUnits : spendTax,
    acos: acosDenom > 0 ? spendTax / acosDenom : 0,
    tacos: tacosDenom > 0 ? spendTax / tacosDenom : 0,
    acosDenom,
    tacosDenom,
  };
}
