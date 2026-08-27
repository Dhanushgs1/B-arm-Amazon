# Worked example (the session this skill was built from)

Raw source: a hand-consolidated "Last 7 days" tracker workbook (sheets `AM ads`/`AM ord`/`FK
ads`/`FK ord`/`MS BARM ads`/`MS BARM ord`, plus the seller's own PivotTable cross-check tabs).
Report: `Ad_Spend_Report_2026-08-25.xlsx`, window 19–25 Aug 2026 (range) / 25 Aug (day).

## 1. Date range — PASS
Raw MIN/MAX on every ads/order sheet: 19-08 to 25-08. Report labels: "25-08-2026" (day),
"19-08-2026 to 25-08-2026" (range). Exact match, no lag — every platform's day-of column had
real nonzero spend. (Contrast: a sibling report for 26-08-2026, checked earlier in the same
session, correctly showed ₹0 day-of spend for all three platforms and its own Notes sheet said
so explicitly — the platform's normal 1-day reporting lag, not an error.)

## 2. Structure — PASS
`Ad spend report` kept its `SKU(s)` column. Checked every platform block for duplicate product
names (the double-counting signature): 0 duplicates across Amazon (71 names), Flipkart (74),
Meesho (12).

## 3. Total reconciliation — PASS, exact to the rupee
| Platform | Raw SUM(Spend), range | Rollup (range, with tax) | Raw × 1.18 |
|---|---|---|---|
| Amazon | 1,11,485.59 | 1,31,553.00 | 1,31,552.996 |
| Flipkart | 36,445.66 | 43,005.88 | 43,005.879 |
| Meesho | 3,394.14 | 4,005.09 | 4,005.085 |

Day-level Summary sheet totals (B/C columns) also matched raw exactly for all three platforms.

## 4. Overall sales (QTS/Value) — FAIL, root-caused, fixed
| Platform | Raw QTS | Report QTS | Raw Value | Report Value | Cause |
|---|---|---|---|---|---|
| Amazon | 1,907 | 1,907 ✅ | 12,24,769.80 | 12,34,875.80 (+0.8%) | qty×price fallback on 11 zero-item_price rows |
| Flipkart | 984 | 977 (−0.7%) | 4,51,446 | 4,49,231 (−0.5%) | CANCEL-status filter + Value pulled from Earn More instead of Invoice Amount |
| Meesho | 176 | 180 (+2.3%) | 49,388 | 50,621 (+2.5%) | direction (report *higher* than raw) rules out a status filter — genuine order-status drift between the raw pull and report generation, left as normal drift, not "fixed" |

Fixed in `adSpendReportExport.ts` (see the "Known defects" section of `SKILL.md`) — Overall
sales now sums each platform's own order-report Quantity/price column unconditionally, no
status filter, Flipkart reading Invoice Amount straight from the order sheet.

## Takeaway
Checks 1–3 were clean and exact — the report's ad-spend-side math was never wrong. The only real
defect was check 4, isolated to one specific accumulation (Overall sales), and didn't require
touching anything else in the file. This is the shape a good reconciliation run should have:
most checks passing exactly, one narrow, well-evidenced root cause for the one that doesn't —
not a vague "the numbers seem off everywhere."
