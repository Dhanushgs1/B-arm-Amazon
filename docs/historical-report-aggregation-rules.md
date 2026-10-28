# Historical Analysis report — aggregation rules per metric

Code: `src/lib/historicalAnalysisReportExport.ts` (sheets and wiring) and `src/lib/historicalTotalsRules.ts`
(grand-total maths). Tests: `src/lib/historicalTotalsRules.test.ts`.

## Grain

| Grain | Meaning | Metrics |
|---|---|---|
| Campaign x SKU pair | one row of the Analysis sheet | Spend+Tax, Advertised SKU Units |
| SKU | repeated on each campaign row of that SKU | Total Units, Orders, Returns, Final |

A SKU advertised by N campaigns appears on N rows. SKU-grain figures on those rows are copies, not
separate sales. Summing the Orders column of the Analysis sheet therefore over-counts; the GRAND TOTAL
row is the account figure.

## Rule per metric

| Metric | Row value | GRAND TOTAL / Key Insights | Notes |
|---|---|---|---|
| Spend+Tax | pair spend × GST multiplier | Σ over pair rows | Spend is legitimately additive across campaigns. Includes unmapped SB/SD spend. |
| Pre-tax spend | pair spend | Σ over pair rows | Used by the leaderboard formula. |
| Advertised SKU Units | pair units (SP `units_7d`; SB/SD = 0) | Σ over pair rows | Per-campaign, so additive. |
| Total Units | SKU advertised units, all campaigns | Σ over SKUs shown | Once per SKU. |
| Orders | SKU order units (cancelled and non-standard IDs excluded) | Σ over SKUs shown | Once per SKU. |
| Returns | SKU returns (AM + FBA + SellerFlex, deduped) | Σ over SKUs shown | Once per SKU. |
| Final | Orders − Returns | Orders − Returns | Unclamped at row and grand level. Negative means a return against an earlier order. |
| CPC | Spend+Tax ÷ Advertised Units (Spend+Tax if units = 0) | Total Spend+Tax ÷ Total Advertised Units | Recomputed from totals, never averaged. |
| ACOS | CPC ÷ price | Σ Spend+Tax ÷ Σ(price × Advertised Units) | Aggregate ratio. Zero-unit spend counts in the numerator only. |
| TACOS (Analysis) | SKU Spend+Tax ÷ (price × max(0, Orders − Returns)) | Σ pair Spend+Tax ÷ Σ over SKUs (price × max(0, Orders − Returns)) | Net floored per SKU so one SKU's returns cannot offset another. |
| TACOS (TACOS sheet) | same, per SKU | no grand row | One row per SKU, N/A when net orders ≤ 0. |
| State stock / orders | SKU stock by location; order lines by ship state | Σ over SKU-location and order lines | Order lines are not campaign-keyed, so no repetition. |
| Price | listing / median sale price | not summed | Shown per row. |
| "Sales" | not a column of this report | — | No sales metric exists here, so none is aggregated. |

## Changes in this pass

- Grand-total maths moved into `computeGrandTotals` (pure, tested).
- Grand **Final** was clamped with `Math.max(0, …)` while every row showed it unclamped. It is now
  `Orders − Returns`, so the GRAND TOTAL equals the sum of SKU finals and the negative-Final note stays
  consistent. Per-SKU TACOS flooring is unchanged.

## Open points

- ACOS and TACOS on rows use the rounded display price in the Excel formula but the unrounded price in
  the cached value. Recalculation in Excel can shift the last digits. Not changed in this pass.
- Grand TACOS numerator includes unmapped SB/SD spend, while its denominator is SKU-only. Kept as the
  approved account-level rule; flagged for a decision.
- Live regeneration of the workbook could not complete: the anon-key fetch of
  `barm_amazon_sp_advertised_product` hit a statement timeout on four attempts. The source tables were
  checked directly (see the audit notes in the final report).

## Orders 43,448 vs 10,143 (reproduced 2026-10-28, endDate 2026-10-22)

- Unique Orders (standard IDs, non-cancelled, IST 2026-09-23 to 2026-10-22): **10,143** (source SQL on `amazon_orders`).
- Analysis sheet, Orders column (30-day block, 915 campaign x SKU rows), plain Excel `SUM`: **43,448**.
- GRAND TOTAL Orders cell and Key Insights "Total Orders (units)": **10,143** (value, not a SUM formula).

The 43,448 is a reader's column SUM over campaign rows that repeat each SKU's Orders, not a generated total.
Campaign rows are kept on purpose. Use the GRAND TOTAL row or the TACOS sheet for account figures.
