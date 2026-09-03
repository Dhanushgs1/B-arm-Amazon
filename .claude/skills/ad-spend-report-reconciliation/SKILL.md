---
name: ad-spend-report-reconciliation
description: >
  Reconcile the Daily Ad Spend Report (SKU-wise) — the Marketplace360 ppc-dashboard's
  Amazon + Flipkart + Meesho cross-platform Summary / "Ad spend report" workbook — against
  the raw per-platform "Last 7 days"-type source file it was built from (per-platform ad
  campaign sheets like AM ads/FK ads/MS ads and order sheets like AM ord/FK ord/MS ord). Use
  this whenever the user asks to check, verify, reconcile, or cross-check an Ad Spend Report
  against raw data; whenever they say the QTS/Quantity, Value, or Spend numbers "don't match",
  "look off", or "romba miss match"; whenever they upload both a raw source workbook and a
  generated Ad Spend Report and want to know if the report is correct; whenever a report's
  date-range label needs checking against the actual data it was built from; and before
  shipping changes to adSpendReportExport.ts, since it's the fastest way to prove a change
  didn't move the numbers. Not for the Historical Analysis Report (Analysis/TACOS/FBA status
  sheets) — that's amazon-ad-report-audit's job.
---

# Reconciling the Ad Spend Report (SKU-wise)

This report is reconciled against the seller's own raw platform exports, so "correct" means
**a straight, unfiltered SUM() of the raw sheet's own columns for the report's date window** —
not a textbook definition, and specifically not whatever the ad-spend side of the report is
doing (Overall sales has nothing to do with ad data at all).

## Run the script

```bash
cd Marketplace360/ppc-dashboard
node .claude/skills/ad-spend-report-reconciliation/scripts/reconcile_report.js "<raw source .xlsx>" "<generated report .xlsx>"
```

Needs the `xlsx` package (already a dependency of `ppc-dashboard`). Resolves every sheet and
column by name/header text, not position — a raw file's sheet-naming convention varies (seller
tool version, whether it's a native per-report export or a hand-consolidated tracker workbook),
so missing sheets/columns are reported as WARN/INFO rather than crashing. Exit code is 1 if
anything FAILs.

Read the output the same way as `amazon-ad-report-audit`:

- **FAIL** — a real defect. Don't publish/send the report until it's fixed.
- **WARN** — expected variance (order-status drift between pulls, a 1-day platform reporting
  lag) or something worth a judgement call, not an error.
- **INFO** — context (sheet inventory, the report's own labeled window).

## The five checks, and what "correct" means for each

**1. Date range.** Raw MIN/MAX per platform's ads/order sheets vs the report's own printed
labels (Summary's day + "X to Y" range). A report's newest day showing ₹0 ad spend, or the raw
data ending exactly one day short of the label, is the platform's normal reporting lag (Amazon
Ads especially — today's spend isn't downloadable until tomorrow), not a bug — the report's own
Notes sheet should say so explicitly ("no ad-spend rows for `<date>`"). Only flag a gap bigger
than one day.

**2. Structure.** The `Ad spend report` sheet must keep its `SKU(s)` column. Without it, rows
group by product name alone — harmless if every duplicate name really is the same product's
several SKU variants (the report already merges those on purpose, see `groupProductsByName` in
`adSpendReportExport.ts`), a real bug if it's hiding two genuinely different products/prices
under one name.

**3. Total reconciliation.** `raw ads sheet SUM(Spend) x 1.18 (GST)` must equal the `Ad spend
report` sheet's own per-SKU rollup, for both the single day and the 7-day range — and the
Summary sheet's platform-level "Ad spend (with tax)" cell is the **day** total only (there's no
separate range total printed at the platform level; the rollup IS the range total). A rollup
**higher** than raw is the double-counting signature (check #2's failure mode); **lower** means
rows are being silently dropped (a status filter, or unmapped SB/SD campaign spend not reaching
any SKU — see the Notes sheet's own "unmapped spend" line).

**4. Overall sales (QTS / Value).** This is a plain `SUM()` off each platform's own **order
report** sheet, scoped to the **single reporting day** (the Summary sheet's own `Overall sales
(<dayLabel>)` header — NOT the 7-day range printed just to its left) — nothing to do with ad
spend, and **no order-status filter** (every status counts, including cancelled/pending; those
net out on their own once the order settles, exactly like the seller's own manual workbook does,
which also tracks this figure daily rather than as a weekly rollup):

| Platform | QTS column | Value column |
|---|---|---|
| Amazon | `quantity` | `item-price` |
| Flipkart | `Quantity` | `Invoice Amount` |
| Meesho | `Quantity` | `Supplier Listed Price (Incl. GST + Commission)`, but see exception below |

**Meesho exception (since 2026-09-03):** unlike Amazon/Flipkart, Meesho's Value is Orders x
each SKU's `meesho_price_marketing` live scraped listing price (falling back to this order
sheet's own Supplier Listed/Discounted Price only for a SKU not in that table yet) — confirmed
against the seller's own manual reference workbook, whose Meesho orders sheet carries a separate
per-product "Quantity x Price = Sales" side table using that same live-price method, not a
straight per-order-row sum. `meesho_price_marketing` lives in Supabase, not the xlsx, so
`reconcile_report.js` can't verify Meesho's Value independently — it reports any gap from the
raw Supplier Listed/Discounted Price sum as INFO, not FAIL. **QTS is unaffected** (it never
depended on price) and still must match the raw sheet exactly like the other two platforms.

A few percent of drift between a live recomputation and a previously-generated report is
**expected** (orders/cancellations/returns change between the raw file's download moment and
the report's generation moment) — report it as normal drift, not a failure, unless it's large
or doesn't shrink when the date window is nudged by a day (which points at a boundary bug
instead). See "Known defects" below for the one case this genuinely was a bug.

**5. Output.** Pass/fail per platform per check, both sides' numbers, the ₹ and % gap, and the
likely cause — never silently averaged away. The script already does this; when writing it up
for the person, keep the same shape (see the worked example this skill was built from, in
`references/session-example.md`, for the tone/format to match).

## Known defects this catches

**Overall sales written as the 7-day range instead of the single reporting day.** Fixed
2026-08-27 in `adSpendReportExport.ts`'s Summary-sheet write site (search "Overall sales QTS/Value
is the SINGLE reporting day's total"): the Summary sheet's `Overall sales (<dayLabel>)` header and
its P/Q cells were briefly writing `overallRange.units`/`overallRange.value` (the 7-day total)
instead of `overallDay.units`/`overallDay.value` — inflating QTS/Value roughly in proportion to
how many of the 7 days had real orders (a full week of steady volume reads ~4-7x too high).
Symptom: Overall sales QTS/Value several times larger than the seller's own daily-tracked
reference number, while every other check (structure, ad-spend totals) still passes — because the
bug was isolated to this one write site, not the underlying `overallDay`/`overallRange`
aggregation (both were already computed correctly; only the wrong one was being written to the
cell). If a workbook still shows Overall sales roughly a week's multiple of the expected daily
figure, and the Summary header reads `Overall sales (<dd-mm-yyyy to dd-mm-yyyy>)` instead of a
single date, it was generated before this fix; regenerate rather than patching the file.

**Overall sales still filtering by order status, or Flipkart's Value sourced from the wrong
report.** Fixed 2026-08-27 in `adSpendReportExport.ts`'s `fetchAmazonProducts` /
`fetchFlipkartProducts` / `fetchMeeshoProducts`: the Overall sales QTS/Value accumulation used
to reuse the same `isCancelledOrder`/`CANCEL`-status filter as the per-SKU ad-attribution
numbers, and Flipkart's Value came from the separate Earn More report (`final_sale_amount`)
with a units×price fallback, instead of a straight SUM of the order sheet's own Invoice Amount.
Symptom: Flipkart QTS read a few units low, Value a few percent low, and — because the fix
matters even where the raw numbers happen to be close — this is the kind of gap that looks small
in aggregate but is still a real formula defect, not drift, until it's this specific accumulation
that's fixed. If a workbook still shows this pattern, the report was generated before that fix;
regenerate rather than patching the file.

**Invoice Amount isn't a structured column.** `barm_flipkart_order_report` doesn't parse a
dedicated Invoice Amount field — every original upload column survives in that row's own `raw`
JSONB instead, so the fix reads `r.raw["Invoice Amount"]`. If Flipkart Value stops reconciling
again later, check the raw upload's actual column header text matches — Flipkart's native
"Download orders" export column is very likely literal "Invoice Amount", but a hand-relabeled
tracker workbook (like the one this skill was built against) isn't a reliable proxy for what
the real upload's header text is; confirm against an actual Flipkart export before trusting a
header-based fix.

**Sheet-naming conventions vary.** The raw file used to build/test this skill named its sheets
`AM ads` / `AM ord` / `FK ads` / `FK ord` / `MS BARM ads` / `MS BARM ord` (plus empty `MS MW
ads/ord` sibling sheets for a second, inactive Meesho storefront, and several `SheetN`-named
PivotTable tabs the seller keeps for their own cross-checking). None of that is guaranteed —
confirm actual sheet/column names against whatever file you're given; the script's `SHEET_PATTERNS`
already tries several common variants and reports what it couldn't find rather than
silently mis-locating a sheet.

**`reconcile_report.js` itself read the wrong Summary columns for QTS/Value.** Fixed
2026-09-03: the script hardcoded `row[15]`/`row[16]` as "the last two columns of the 17-col
Summary layout" for every platform's QTS/Value — stale the moment the Summary sheet grew columns
(an "Orders x Price = Total Sales" column was added to both the day and range blocks, pushing
QTS/Value to indices 17/18 of a 19-col layout). Symptom: every platform's Overall sales Value
read as a near-zero garbage number (e.g. Rs 0.37, Rs 0.12) while QTS read some unrelated ACOS/CPC
figure instead — not a real report bug, just the script misreading cells, and a violation of this
same script's own stated principle ("never hardcoded positions"). Fixed by locating the `QTS` and
`Value` header cells by text instead. If Overall sales Value ever again reads suspiciously tiny
or clearly-wrong-column numbers while everything else passes, suspect this script's own column
lookup before suspecting the report.

**Don't assume the reconciliation skill's documented rule is still current — check the seller's
own reference workbook's actual formulas.** On 2026-09-03, this skill's own documented Meesho
Value rule (straight sum of Supplier Listed/Discounted Price, no other source) led to reverting
a legitimate improvement (Meesho pricing from `meesho_price_marketing`) as a "regression," because
that rule predated the seller's manual workbook growing its own live-price side table for Meesho.
Opening the manual reference file with `cellFormula: true` (not just reading values) and reading
its actual `SUM()` formulas — not just trusting this document's prose — showed the true, current
method. Skills describe the last-known-correct state, not an unchangeable spec; when the seller's
own reference file disagrees with this skill's text, the reference file wins and this file should
be updated to match (as the Meesho exception above now does).

## Where the code lives

| Concern | File |
|---|---|
| Report builder (Summary, Ad spend report, Ad Status, Low Spend, Notes sheets) | `src/lib/adSpendReportExport.ts` |
| Download button / "Generate & Download" | `src/app/dashboard/reports/page.tsx` (`handleGenerateAdSpend`) |
| Emailed copy of the same report | `src/pages/api/send-ad-spend-email.ts` |
| Flipkart order upload/parsing (`raw` JSONB, dedup, the order-item-id gotcha) | `src/lib/flipkartReportUpload.ts` |
| Paginated table reads | `src/lib/amazonReportShared.ts` (`fetchAllRows`) |
