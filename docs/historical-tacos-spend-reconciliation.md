# TACOS sheet scope and spend reconciliation — 23 Sep to 22 Oct 2026

Scope: `Amazon ad performance 23.09 - 22.10 (1).xlsx` (seller workbook) against the rebuilt Historical report.
All figures are Spend + Tax (18% GST) unless marked pre-tax. Nothing here hardcodes an adjustment.

## 1. TACOS sheet rows (implemented)

Rule (`src/lib/historicalTacosRules.ts`, `tacosSheetRowIncluded`): a SKU appears on the TACOS sheet when it has
spend, orders or returns in the 30-day window. Zero-spend catalogue-only SKUs are left out. The UNMAPPED placeholder
never appears.

| | Rows | Spend+Tax | Orders | Returns |
|---|---|---|---|---|
| Before | 906 | 576,964.17 | 10,143 | 478 |
| After | 391 | 576,964.17 | 10,143 | 478 |

- 355 SKUs with orders or returns, plus 36 spend-only SKUs.
- 515 zero-activity catalogue rows removed.
- Totals are unchanged, as expected: the removed rows carry no spend, orders or returns.
- Against the seller TACOS sheet (352 SKUs): all 352 are kept. The other 39 are the 36 spend-only SKUs and 3
  return-only SKUs (`B-IR-THERMO-BK`, `BMN132-1`, `B-NCD-L2202-A`), which are kept as requested.

N/A handling:
- CPC and TACOS are `N/A` when Final orders ≤ 0 or price is 0. Spend is always shown.
- The Excel formulas mirror this (`cpcFormula`, `tacosFormula`).
- Before this change, the shopify-ui TACOS sheet showed CPC = spend and TACOS = 0 when Final was 0. That is removed.
- Check on the rebuilt workbook: 148 TACOS cells show 0, and every one has spend 0 with Final > 0. No zero TACOS
  appears where there is spend without sales.
- 49 cells show N/A, all with Final ≤ 0 or price 0.

## 2. Chewy Tube brand campaign (no change)

`B-CT-G-8` and `B-CT-G-9` stay at the database weight of 1.0 until the campaign owner confirms the seller's 1.5.

- Campaign total (Sponsored Brands, 23 Sep–22 Oct): ₹7,755.88 pre-tax.
- At weight 1.0 each: 969.49 pre-tax, ₹1,143.99 incl. GST, for all eight SKUs.
- At 1.5 on G-8 and G-9: G-8 and G-9 are 1,292.65 pre-tax (₹1,525.32), the other six are 861.76 (₹1,016.88).
- The seller's values match the 1.5 scenario exactly.
- The 1.5 weights are inferred from the seller workbook, not confirmed by any database record. They are not authoritative.
- The redistribution nets to zero across the campaign.

## 3. Flat Teether SD attribution (proposal only, not implemented)

Campaign: `B-arm-Flat Teether-B0GM5V3J33-SD-Remarketing`, 22 Oct 2026.

Evidence:
- The Sponsored Display campaign table holds one row of ₹158.75 for the day.
- The combined daily upload (`barm_daily_am_ads`) holds two SKU rows for the same campaign and day:
  `B-SPEECH-COMBO-3HEADS-1` ₹125.23 and `B-SPEECH-COMBO-3HEADS` ₹33.52. Together they equal ₹158.75.
- The report uses only the campaign-level row, allocated with the map weights 65 and 35 (₹103.19 and ₹55.56 pre-tax).
- The seller uses the SKU rows (125.23 and 33.52).
- Current behaviour does not double count. The SKU rows come from the combined upload, which the card-only rule
  (27 Oct) excludes, so only the campaign row is counted.

Overlap across the window:
- 321 campaign-days appear in both the SB/SD campaign tables and the combined SKU rows.
- 270 match to the cent.
- 51 differ. In the differing days the combined file often has only one SKU row covering part of the campaign.
  Example: `Insemination kit-Brand ads` on 6 Oct, campaign ₹816.21, SKU row ₹136.04.

Proposed deterministic precedence rule, per campaign-day:
1. If SKU-level rows exist for that campaign-day and their sum equals the campaign-day total (within ₹0.05), allocate
   by those SKU rows.
2. Otherwise allocate the campaign-day total with the map weights.
3. Never add both. The campaign total is preserved in every case, because rule 2 always sums to the full total.

Open points:
- Rule 1 uses the combined upload, which conflicts with the card-only rule (27 Oct). Adopting it needs an explicit
  decision.
- Adopting it would change SKU attribution on up to 270 campaign-days. Campaign totals stay the same. I have not
  quantified the SKU-level effect.

## 4. Spend residual (report − seller)

Pre-tax variance: −39.07. Incl. 18% GST: −46.10.

| Bucket | Pre-tax | Incl. GST | Status |
|---|---|---|---|
| Source version: seller matches combined daily upload, report uses card rows (`B-CH-PS-B-2` −15.00, `B-IR-LP-200-1` −4.97, `B-A005-1` −3.52, `B-BT-B1-1` −2.15) | −25.64 | −30.26 | Explained by source choice |
| Unexplained seller-side differences (`B-SENFDT-5` −9.00, `B-BT-B1-1` Branded-Phrase(1) −7.48, `B-SENFDT-1` +5.66, `B-A006-2` −4.99, `B-BULB-10.5-INSEM-PK5-1` Kit-PT −1.30) | −17.11 | −20.19 | Not traced to a source. Kept as is. |
| SD-Retargeting allocation the seller doesn't have (`B-Arm_SP_B0FT3MK3WD_Self Insemination Kit_SD-Retargeting`, 1 Oct, ₹3.68 SD row mapped to `B-BULB-10.5-INSEM-PK5-1`) | +3.68 | +4.34 | Seller shows 0. Source of the seller's omission not identified. |
| Flat Teether split (SD map 65/35 vs seller SKU rows) | 0.00 | 0.00 | Net zero within the campaign-day. Attribution only. |

Chewy Tube (8 SKUs) nets to zero. Its spend is covered by section 2.

Rounding: seller values are paisa-rounded per SKU. Our per-SKU values are not, so the totals can differ by ₹0.01.

## 5. Reconciliation

| Component | Incl. GST |
|---|---|
| Seller TACOS sheet | 565,035.43 |
| Spend-bearing SKUs missing from seller TACOS (at seller values, 40 SKUs) | +11,974.85 |
| Chewy Tube redistribution (8 SKUs) | 0.00 |
| Residual, 10 non-Chewy SKUs (buckets above) | −46.10 |
| Expected report total | 576,964.17 |

Arithmetic: 565,035.43 + 11,974.85 − 46.10 = 576,964.18, which is 0.01 off from 576,964.17 due to rounding.

Status: the total reconciles arithmetically. Source-level reconciliation is not complete: the −17.11 pre-tax
seller-side bucket and the +3.68 SD-Retargeting allocation are not traced to a source record.

## 6. Open decisions
1. Confirm the Chewy Tube weights (1.5 or 1.0) with the campaign owner.
2. Decide whether SKU-level combined-upload rows may take precedence over the campaign-level allocation (conflicts
   with the card-only rule).
3. Obtain the seller's raw inputs for the −17.11 and +3.68 items to trace them.

## 7. Follow-up evidence (read-only, no code or data changed)

### Flat Teether override: quantified impact
- Eligible campaign-days (combined SKU rows, excluding blank-SKU rows, that sum to the campaign-day total within ₹0.05): 225.
  The earlier count of 270 included blank-SKU rows, which carry no SKU and so cannot override anything.
- Applying SKU-level rows on those 225 days changes spend on 2 SKUs only:
  `B-SPEECH-COMBO-3HEADS` −₹22.04 and `B-SPEECH-COMBO-3HEADS-1` +₹22.04, pre-tax.
- Net change across the workbook: ₹0.00. Campaign totals are unchanged.
- On every other eligible day, the current map-weight allocation already equals the SKU-row split.
- The override is blocked by the card-only rule (27 Oct), which allows only the dedicated cards for reports.
  It needs an explicit decision before implementation.

### Residual −₹17.11 (seller-side): stored sources
Source: `barm_ad_spend_history_30d`, Amazon, window 23 Sep–22 Oct (spend_tax, incl. GST):

| SKU | Seller | Report | Stored history | Stored history matches |
|---|---|---|---|---|
| `B-SENFDT-5` | 847.03 | 836.41 | 836.41 | Report |
| `B-SENFDT-1` | 5,957.37 | 5,964.05 | 5,964.05 | Report |
| `B-BULB-10.5-INSEM-PK5-1` | 62,439.16 | 62,441.97 | 62,441.97 | Report |
| `B-CH-PS-B-2` | 14,529.19 | 14,511.49 | 14,529.19 | Seller |
| `B-A005-1` | 7,930.82 | 7,926.66 | 7,930.82 | Seller |
| `B-SPEECH-COMBO-3HEADS(-1)` | 39.55 / 233.29 | 65.56 / 207.28 | 39.55 / 233.29 | Seller |
| `B-A006-2` | 10,124.21 | 10,118.32 | 10,125.52 | Neither |
| `B-BT-B1-1` | 5,195.99 | 5,184.63 | 5,187.16 | Neither |
| `B-IR-LP-200-1` | 6,488.00 | 6,482.14 | 6,491.35 | Neither |

- No single stored source reproduces the seller workbook. The residual is not yet traced to a source record.
- The stored history supports the report on the `B-BULB-10.5-INSEM-PK5-1` total, which includes the +₹3.68 SD row.
  So the seller workbook, not the report, appears to be the outlier on that item.
- The history table's generator is not documented in the repository, so its authority is not confirmed.

### +₹3.68 SD-Retargeting row
- Source: SD table, campaign `B-Arm_SP_B0FT3MK3WD_Self Insemination Kit_SD-Retargeting`, 1 Oct 2026, ₹3.68 pre-tax.
- The map assigns the campaign to `B-BULB-10.5-INSEM-PK5-1` with weight 1.
- It is part of the stored 30-day history total for that SKU (see table above), so the report and the history agree.
  The seller workbook shows ₹0.
