# Historical Analysis Report — methodology reference

Read this when you need more than the invariants in SKILL.md: where each figure comes from, what
every sheet is, and how the dashboard-generated workbook differs from the one the seller builds
by hand.

## Contents

- [Data sources](#data-sources)
- [Window semantics](#window-semantics)
- [SB/SD spend attribution](#sbsd-spend-attribution)
- [Sheet inventory](#sheet-inventory)
- [Generated vs hand-built](#generated-vs-hand-built)
- [Reference figures](#reference-figures)

## Data sources

Everything except three fields comes from files uploaded through the dashboard's Upload page into
Supabase — never the live API. That is deliberate: it is what lets both trailing windows be
recomputed from a fixed historical upload rather than only "as of today". The live SellerMate API
is consulted **only** as a per-field fallback for Price, FBA/MFN channel, and FBA availability,
and never for spend, orders, or returns.

| Figure | Supabase table | Date column |
|---|---|---|
| Sponsored Products spend, advertised units | `barm_amazon_sp_advertised_product` | `report_date` |
| Sponsored Brands spend | `barm_amazon_sb_campaign` | `report_date` |
| Sponsored Display spend | `barm_amazon_sd_campaign` | `report_date` |
| Orders (units) | `barm_amazon_am_orders` | `purchase_datetime` (IST day window) |
| AM returns | `barm_amazon_am_returns` | `return_request_date` |
| FBA returns | `barm_amazon_fba_returns` | `return_date` (IST window) |
| SellerFlex returns | `barm_amazon_sf_return` | — |
| Price, FBA/MFN channel | `barm_amazon_price_listing` | snapshot, not windowed |
| Inbound-shipped quantity | `barm_amazon_fba_inventory` | snapshot |
| Per-state FBA balances | `barm_amazon_inventory_ledger` | `ledger_date ≤ endDate`, `disposition = SELLABLE` |
| Campaign → SKU weights | `barm_amazon_campaign_sku_map` | none (`["campaign_name","sku"]` is its key) |

The ledger is a point-in-time snapshot per `(SKU, location)`, so the *latest* row up to `endDate`
is that location's balance — not a per-day history. Filtering it to dates inside the report window
returns nothing (the last upload is usually dated after the window), which previously made every
FBA SKU read as 0 units and flagged healthy SKUs as "low stock".

## Window semantics

Both windows end on the **same** date — the one selected in the dashboard, used verbatim and never
silently moved. "Last 30 days" is that date and the 29 before it; "Last 7 days" is that date and
the 6 before it. There is a single 30-day fetch and the 7-day block is filtered from it in memory,
so the two can never disagree and there is no second round-trip.

An earlier version pulled the end date back to the latest date that actually had data. That was
well-meant but meant the period the seller asked for was not the period they got, making the
workbook impossible to reconcile against their own pivot. The latest date with data is still
looked up, but only to warn (`dataThrough` / `staleDays`) — never to move the window.

This matters when auditing: if the tail of the window is empty, that is reported, not hidden.

## SB/SD spend attribution

Sponsored Brands and Display exports carry no SKU column — Amazon only reports those at campaign
grain. Each such campaign's spend is split across the SKUs mapped to it on the Upload page, in
proportion to each SKU's **weight**. Weights are relative, so `{2,1,1}` and `{50,25,25}` split
identically and adding a SKU never forces the existing rows to be rebalanced.

Campaigns with no mapping are pooled into a single `⚠ Unmapped SB/SD campaigns` row rather than
dropped, so their spend still reaches the GRAND TOTAL. This is the right trade — losing the spend
entirely would quietly understate total cost — but it means the row should be driven to zero by
mapping campaigns, and its value is worth surfacing every time.

The Adspend sheet also carries one synthesized row per (SB/SD campaign × mapped SKU) holding that
SKU's weighted share, with blank Ad Group Name and Advertised ASIN because neither exists at
campaign grain. That is what makes the sheet reconcile against the Analysis report.

## Sheet inventory

**Computed** — Analysis report (campaign × SKU) · TACOS (per SKU) · Price · FBA status (per-state
pivot, snapshot not windowed) · Orders/returns/adspend · Key Insights · Notes

**Verbatim dumps** of the uploads, every original column kept — AM orders · Adspend · AM returns ·
FBA returns · SF returns · FBA inventory · Inventory ledger

A few columns in the dump sheets are derived rather than from Amazon: `IST with Time` and `Date`
on AM orders (from the UTC purchase date), `return-time` on FBA returns (split out of
`return-date`), `Area` on Inventory ledger (from Location), and on Adspend the Start/End Date pair
plus the `Campaign Name*Advertised SKU` pivot key.

`Orders, returns, adspend` is **four independent top-N lists side by side** — Adspend by campaign ×
SKU, Adspend by SKU, Orders by SKU, Returns by SKU. A given row is not a joined record: the SKU in
the Orders columns has no relation to whatever SKU sits in the Returns columns of that same row.
Reading across a row is the most common misinterpretation of this sheet.

The `Notes` sheet in a generated workbook self-documents its own methodology, including which
fallbacks were used for that specific run (e.g. whether FBA availability came from an uploaded
ledger or the live feed). Read it first when auditing an unfamiliar file — it states what the data
actually was, not just what it should be.

## Generated vs hand-built

Structurally near-identical — same columns, same two-window layout, same sheet set. Real
differences:

| | Hand-built | Generated |
|---|---|---|
| GRAND TOTAL row | absent | present, distinct-SKU for Orders/Returns/Total Units |
| Analysis report TACOS | per-SKU | per-SKU (was per-row before 2026-08-18) |
| `Final = 0` → TACOS, Analysis report | `0` | `0` (was `Spend+Tax ÷ Price` before 2026-08-18) |
| `Final = 0` → TACOS, TACOS sheet | `Spend+Tax ÷ Price` | `Spend+Tax ÷ Price` |
| 7-day Spend+Tax | **not re-scoped** — copied from 30-day | correctly filtered |
| `Available` state string | `"ODISHA PUNJAB"` (missing comma), trailing comma, includes `UNKNOWN` | comma-normalised |
| Key Insights / Notes | absent | present |
| Working pivots | `Sheet1` (Sum of quantity per SKU) left in | computed internally |

`Sheet1` in the hand-built file is scratch work — a `Sum of quantity` pivot per SKU with a
duplicated helper column, grand total 9,143 units. It is an intermediate, not a deliverable, which
is why the generated workbook has no equivalent.

The hand-built FBA status sheet uses city-grained labels (`BANGALORE`, `HYDERABAD`, `JAIPUR`,
`LUCKNOW`, `UNKNOWN`, `VSNC`) as columns. The generated report reproduces that **on purpose** via
`FC_AREA_MAP_MANUAL`, so the FBA status sheet stays 1:1 with the seller's pivot. The defect is not
those labels — it is `fcToState` reusing city names where a join against `ship_state` needs real
state names. Fix `fcToState`; leave `FC_AREA_MAP_MANUAL` alone.

## Reference figures

From `Historical_Analysis_Report_2026-07-15_to_2026-08-13.xlsx` (generated **before** the per-SKU
TACOS change, so its Analysis-report TACOS is per-row), useful as a sanity baseline when checking
whether a refactor moved anything:

- 142 campaign × SKU rows over 127 distinct SKUs (15 repeat-SKU rows)
- GRAND TOTAL: Spend+Tax ₹703,027.37 · Advertised Units 2,298 · Orders 5,827 · Returns 214 ·
  Final 5,613
- Plain `SUM()` of the same columns would wrongly give Total Units 2,514 / Orders 6,143 /
  Returns 229
- TACOS sheet: 446 per-SKU rows
- Unmapped SB/SD: 8 rows, ₹58,112.20
- Average ACOS 45.60%, average TACOS 12.34%

From `Amazon ad performance 12.07 - 10.08.xlsx` (hand-built):

- 165 campaign × SKU rows over 146 distinct SKUs
- All 152 rows with spend have 7-day Spend+Tax identical to 30-day — the defect described in
  SKILL.md
- 110 SKUs where the Analysis report's 7-day spend disagrees with that file's own TACOS sheet
- 30-day TACOS: 146 rows per-SKU convention, 19 rows using the `Final = 0 → 0` variant, zero
  unexplained
