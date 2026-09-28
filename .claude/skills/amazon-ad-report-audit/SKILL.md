---
name: amazon-ad-report-audit
description: >
  Audit and explain the Amazon Historical Analysis Report / "Amazon ad performance" workbook
  (Analysis report, TACOS, FBA status, Key Insights sheets) produced by the Marketplace360
  ppc-dashboard or built by hand in Excel. Verifies Spend+Tax, CPC, ACOS, TACOS, Final,
  GRAND TOTAL and the 30-day/7-day window split against the definitions the seller's own
  workbook uses, and catches the specific ways these reports go wrong. Use this whenever the
  user asks to check, verify, audit, reconcile or debug an ad-performance / Historical Analysis
  Report workbook; whenever they say the TACOS / ACOS / CPC / spend / orders / returns numbers
  "look wrong", "don't match", "don't tie back", or disagree between two files or two sheets;
  whenever a GRAND TOTAL doesn't equal a SUM() of its column; whenever they compare a manual
  Excel workbook against a dashboard-generated one; and whenever they ask how any figure in
  these reports is calculated. Also use it before shipping changes to
  historicalAnalysisReportExport.ts or flipkartHistoricalReportExport.ts, since it is the
  fastest way to prove a refactor didn't move the numbers.
---

# Auditing the Amazon ad-performance report

This report is reconciled against a workbook the seller builds by hand, so "correct" means
**matches their definitions**, not "matches a textbook". Several of its rules look wrong until
you know why they exist — the GRAND TOTAL deliberately disagrees with `SUM()`, and CPC means
two different things on two sheets. Check against the definitions below, not against intuition.

## Start by running the script

```bash
cd Marketplace360/ppc-dashboard
node .claude/skills/amazon-ad-report-audit/scripts/audit_report.js "<path to .xlsx>"
```

It needs the `xlsx` package, which is why it runs from `ppc-dashboard` (already a dependency
there). It resolves columns by **header text**, not fixed positions, so an inserted column
won't silently shift every check. Exit code is 1 if anything FAILs, so it can gate a release.

Read the output as:

- **FAIL** — arithmetic or grain is broken. The numbers are wrong; don't ship or send it.
- **WARN** — real data or an accepted variant, but a reader will likely misinterpret it.
  Judgement call: say what it means rather than silently passing it on.
- **INFO** — context (row counts, grain) that makes the rest readable.

Then explain the findings in business terms. "8 rows hold ₹58,112 of spend attributed to no
SKU" lands; "unmapped_sb_sd assertion tripped" doesn't.

## The definitions the checks enforce

```
Spend+Tax = raw ad spend × 1.18          (18% GST, applied once after summing)
Final     = Orders − Returns             (left unclamped, so it can go negative)
CPC       = Spend+Tax ÷ Advertised SKU Units     ← Analysis report
ACOS      = CPC ÷ Price
TACOS     = Spend+Tax ÷ (Price × Final)
```

**Orders means units, not order records** — the sum of order quantity, with cancelled orders
excluded (they never became revenue, so counting them would inflate Orders and flatter
ACOS/TACOS).

**Returns is AM + FBA + SellerFlex, summed** (seller's decision, 24 Sep 2026 — the same "All
Returns" the Weekly Sales Report subtracts). The three sources share no orders (AM returns belong to
merchant-fulfilled orders, FBA/SF returns to Amazon-fulfilled ones), so adding them never
double-counts. Each SellerFlex return counts once per (Customer Order ID, Shipment ID, mSKU) — the
MIS table stores ~4 copies of each from repeat uploads. Workbooks generated before this change used
"AM if the SKU has any, else FBA + SF", which dropped real FBA/SF returns.

**Spend is a plain sum of every Sponsored Products-table row** — no orphan-campaign divisor. That
table also carries the seller's own per-SKU split of Brand/Display spend (each campaign-day's first
split row is named, the rest have a blank campaign and ad group; all have 0 impressions/clicks/units),
and that split is how Brand/Display spend is counted. An SB/SD campaign-day already split this way is
NOT added again from the SB/SD tables. Blank-campaign rows are these split rows, not deleted SP
campaigns.

**Advertised SKU Units is always 0 on Sponsored Brands / Display rows.** Amazon attributes those
units to the campaign, never to a SKU. Apportioning them by spend weight would invent
fractional units (a third of a sale) and then divide spend by them in CPC. Only Sponsored
Products units are genuinely per-SKU.

**CPC means something different on the TACOS sheet:** there it is `Spend+Tax ÷ Final orders` —
cost per net order, not cost per advertised unit. Both are intentional, and TACOS lands
identically either way because `(S/Final)/Price` equals `S/(Price×Final)`.

## Grain — the thing that trips everyone

One row per **campaign × SKU**, but the columns live at two grains:

| Grain | Columns | Behaviour |
|---|---|---|
| campaign × SKU | Spend+Tax, Advertised SKU Units | genuinely differ between two rows of the same SKU |
| SKU | Total Units, Orders, Returns | **the same value repeats on every campaign row of that SKU** |

So a plain `SUM()` of Orders double-counts every multi-campaign SKU. The GRAND TOTAL sums those
three over **distinct SKUs** instead, while Spend+Tax and Advertised Units sum plainly. A real
example: plain sums give 6,143 Orders / 2,514 Total Units / 229 Returns; the correct
distinct-SKU totals are 5,827 / 2,298 / 214. **The GRAND TOTAL not matching `SUM()` is the
report working correctly** — if someone "fixes" it to match, they have broken it.

## TACOS has two valid conventions — identify before judging

Only a SKU advertised by several campaigns can tell them apart; for a single-campaign SKU they
are the same number.

- **per-SKU** — that SKU's *total* spend across all campaigns ÷ (Price × Final), the same value
  repeated on each of its rows. Answers *"is this SKU's advertising paying for itself"*. This is
  what the hand-built workbook does, and it agrees with the TACOS sheet's own per-SKU definition.
- **per-row** — only this campaign's spend ÷ (Price × Final); the rows of one SKU then sum to the
  per-SKU figure. Answers *"which campaign is eating the margin"*.

**Both reports now use per-SKU**, matching the hand-built workbook — `computeTacos` in
`historicalAnalysisReportExport.ts` and `flipkartHistoricalReportExport.ts` divides the SKU's
total Spend+Tax. They previously used per-row on the Analysis report while the TACOS sheet was
per-SKU, so the same SKU carried different TACOS on the two sheets. **Workbooks generated before
that change are per-row**, which is the usual reason an older file won't reconcile against a new
one — the script reports which convention each file uses, so check that before hunting for a
data problem.

`Final = 0` makes TACOS undefined (spend, but no net orders). The Analysis report prints `0`
there, matching the manual. The TACOS sheet instead falls back to a denominator of 1, yielding
`Spend+Tax ÷ Price` — also matching the manual, which does the same on its TACOS sheet. Neither
is meaningful as a percentage, so describe it as undefined rather than quoting the number.

## Known defects this catches

**The 7-day window not actually re-scoped.** The headline failure, and it is invisible to
eyeballing. A hand-built pivot copies the 30-day spend column into the 7-day block without
re-filtering the dates; every 7-day CPC/ACOS/TACOS then divides ~30 days of spend by ~7 days of
units and inflates several-fold. In `Amazon ad performance 12.07 - 10.08.xlsx` **all 152 rows
with spend** had identical 30-day and 7-day Spend+Tax, and the same SKU disagreed with that
file's own TACOS sheet — e.g. `A006-2` reads ₹23,079 on the Analysis report but ₹5,419 on the
TACOS sheet, and the TACOS sheet is the correct one. Two independent signals catch this: 7-day
spend can never exceed 30-day spend (it is a subset), and it being *identical on every spending
row* is not something real data does.

**Formula columns dropped on write.** `xlsx-js-style` silently discards a cell written as
`{t, f}` with no cached `v`, so a whole column can vanish from the file — header present, every
data cell missing. It reads as a data problem and isn't. This blanked the FBA status sheet's
`Available` / `Number of FBA Not Available` / `All FBA` columns (0 of 193 rows) and the
`Orders, returns, adspend` leaderboard's Spend+Tax column in every export until 2026-08-18. Fix by
writing a computed `v` alongside the `f` — never by rewriting the formula, which was correct all
along. Keeping both means the sheet still recalculates in Excel like the seller's own workbook.
When adding any new formula cell to these builders, supply the value too.

**Stock and orders bucketed differently in Key Insights.** Stock is keyed by FBA
fulfilment-centre label, orders by customer ship-to state — and `FC_STATE_MAP` maps
`BLR4→"BANGALORE"`, `HYD3→"HYDERABAD"`, `LKO1→"LUCKNOW"`, `JPX1→"JAIPUR"`: city names where the
join needs state names. The result is a mirror-image lie — the FC city reads "Overstocked, no
orders" while its own state reads "Stockout risk, no stock". Measured impact: 3,329 units
stranded and 2,797 order units falsely flagged, plus `VSNC` (1,405 units) absent from the map
entirely. Everything downstream — the verdicts, "REPLENISH FIRST", "Priority 2" — is false. Fix
by mapping those FCs to real states (`KARNATAKA`, `TELANGANA`, `UTTAR PRADESH`, `RAJASTHAN`) in
`fcToState`, keeping `FC_AREA_MAP_MANUAL` city-grained since the FBA status sheet must stay 1:1
with the seller's pivot.

**Unnormalised `ship_state`.** `TN` / `TAMILNADU` / `TAMIL NADU`, `WB` / `WESTBENGAL`, `UP` /
`U.P.`, plus misspellings (`HARAYANA`, `CHATTISGARH`, `TELENGANA`) each get their own row,
fragmenting demand into slivers that then read as separate stockouts.

**Negative Final.** Returns are dated by *request*, so a return can belong to an order placed
before the window and legitimately outnumber in-window orders — `B-SENFDT-1`: 40 orders, 51
returns, Final −11, TACOS displayed as 2091%. The data is real; the percentage is an artifact of
the clamp-then-substitute-1 fallback. Report it as undefined.

**Unmapped SB/SD spend.** SB/SD campaign-days with neither a seller split in the SP table nor a
campaign→SKU mapping pool into a single `⚠ Unmapped` row — their spend still reaches the totals but is
attributed to nothing. Always surface the rupee figure. (Before 24 Sep 2026 this row also held SB/SD
spend that the split rows already counted — ₹58k–60k per 30 days — i.e. a double count.)

## Where the code lives

| Concern | File |
|---|---|
| Amazon report builder | `src/lib/historicalAnalysisReportExport.ts` |
| Flipkart equivalent | `src/lib/flipkartHistoricalReportExport.ts` |
| `fcToState`, `FC_AREA_MAP_MANUAL` | `src/lib/analysisReportExport.ts` |
| Paginated table reads | `src/lib/amazonReportShared.ts` (`fetchAllRows`) |

`fetchAllRows` orders by `id` for stable pagination, so any table without an `id` column needs
its natural key passed explicitly — `barm_amazon_campaign_sku_map` needs
`["campaign_name", "sku"]`. Getting this wrong fails the whole export at runtime, not at compile
time.

For data sources, the full sheet inventory, and how the generated workbook differs from the
hand-built one, read `references/methodology.md`.
