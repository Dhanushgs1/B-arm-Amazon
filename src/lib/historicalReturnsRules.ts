// Seller Returns Rule for the Historical Analysis report — the rule the seller's own workbook follows.
//
// Per SKU, for the report window:
//   1. If the SKU has any Amazon Merchant (AM) return rows in the window, count AM returns only.
//   2. Otherwise count FBA returns plus SellerFlex returns.
//
// SellerFlex rows are deduplicated on (order, shipment, mSKU) before this function is called (see
// dedupeSellerFlexReturns), so a re-uploaded return counts once. Final is Orders − Returns, computed once
// by the caller. SellerFlex is never subtracted a second time.
//
// Each counted return line is still capped at the units ordered on its order line (capReturnsAtOrderedQuantity),
// the rule from 27 Oct 2026. Kept separate so the reconciliation can show what the cap alone changes.
//
// Kept free of XLSX / Supabase imports so the regression tests can exercise the same code the workbook uses.

import { capReturnsAtOrderedQuantity, type ReturnLine, type CappedReturn } from "@/lib/historicalReportRules";

export interface SellerReturnsInput {
  /** Amazon Merchant return rows (one per return record), already filtered to the window. */
  am: ReturnLine[];
  /** FBA return rows, already filtered to the window. */
  fba: ReturnLine[];
  /** SellerFlex return rows, already deduplicated on (order, shipment, mSKU). */
  sf: ReturnLine[];
  /** Ordered units per "orderId|sku", used by the 27 Oct cap. */
  orderedByLine: Map<string, number>;
}

export interface SellerReturnsResult {
  /** Counted returns per SKU for the window. */
  bySku: Map<string, number>;
  /** SKUs that counted AM returns (rule 1). */
  amSkus: Set<string>;
  /** SKUs that fell back to FBA + SellerFlex (rule 2). */
  fallbackSkus: Set<string>;
  /** Lines reduced by the ordered-quantity cap. */
  capped: CappedReturn[];
}

export function sellerReturnsBySku(input: SellerReturnsInput): SellerReturnsResult {
  const amSkus = new Set(input.am.filter((l) => l.sku).map((l) => l.sku));
  const chosen: ReturnLine[] = [];
  const fallbackSkus = new Set<string>();
  for (const l of input.am) if (l.sku) chosen.push(l);
  for (const l of [...input.fba, ...input.sf]) {
    if (!l.sku) continue;
    if (amSkus.has(l.sku)) continue;
    fallbackSkus.add(l.sku);
    chosen.push(l);
  }
  const { bySku, capped } = capReturnsAtOrderedQuantity(chosen, input.orderedByLine);
  return { bySku, amSkus, fallbackSkus, capped };
}
