# FBA Forecast Report — Dashboard-native Design

Date: 2026-09-22
Status: Approved by user ("yes build this"). Proceeding to implementation plan.

## Problem

B-Arm manually refreshes an FBA Forecast Sheet (30 days) Excel workbook every
few days by hand: downloading an Amazon "All Orders" report, an FBA stock
report, and pulling booked/picked-up/active rows out of a separate "FBA & FBF
Details-Updated" workbook, then pasting all of it into a pivot-heavy Excel
template and hitting Refresh All. This is the process documented in the
user's own SOP PDF ("FBA Forecasting Sheet — updation process followed") and
in the `barm-fba-forecast-refresh` skill (which automates the paste step via
surgical XML editing of the existing template, preserving its Excel pivot
caches).

The user wants this as a dashboard feature instead: a new "FBA" upload
section where the three raw reports get uploaded, and a downloadable forecast
report — with the actual calculation (zone assignment, 120-day forecast,
stock-needed, days-to-stockout, etc.) run in Supabase, not in browser/client
code. Excel pivot tables are an Excel-only technique (pivot caches can't be
computed by Postgres), so this is necessarily a **fresh, computed-values
report**, not an edit of the original template — confirmed with the user.

## Source-of-truth calculation (reverse-engineered from the user's real workbook)

The user supplied their actual `FBA_forecast sheet(30 days).xlsx` and `FBA &
FBF Details-Updated (1).xlsx`. Inspecting the raw XML (not just the SOP,
which only documents the 5 raw-input sheets) gave the exact formulas behind
the `FBA analysis` sheet — the actual forecast output the SOP never
describes. This section is the ground truth for the Edge Function's
calculation; column letters refer to the original `FBA analysis` sheet for
traceability.

Grain: one row per **(SKU, zone)** pair. `id+zone` = `skuid ++ zone` is the
join key used throughout the original sheet (Excel's `CONCAT`).

### Zone mapping

Two different mappings, confirmed from live formulas / the skill:

**Ship-state → zone** (used for 30-day sales; from `30_days_sales!G2`'s
nested IF formula, state names upper-cased/trimmed before matching):

| Zone | States |
|---|---|
| `Tamilnadu_zone` | Tamil Nadu, TN, Palghat, Andaman & Nicobar Islands, Andaman Islands, AN, Puducherry |
| `Karnataka_zone` | Karnataka, KA, Goa, GA, Lakshadweep, Kerala, KL |
| `Telangana_zone` | Telangana, TG, Andhra Pradesh, AP |
| `Maharashtra_zone` | Maharashtra, MH, Dadra and Nagar Haveli and Daman and Diu, Daman & Diu, Dadra and Nagar Haveli |
| `gujarat_zone` | Gujarat, GJ |
| `Nagpur_zone` | Madhya Pradesh, MP, Chhattisgarh, CG |
| `Rajasthan_zone` | Rajasthan, RJ |
| `Uttarpradesh_zone` | Uttar Pradesh, UP |
| `bihar_zone` | Bihar, BR, Jharkhand, JH |
| `Delhi_zone` | Delhi, New Delhi, DL, Uttarakhand, UK, Haryana, HR |
| `WestBengal_zone` | West Bengal, WB |
| `Odisha_zone` | Odisha, Orissa, OR |
| `Assam_zone` | Assam, AS, Arunachal Pradesh, AR, Manipur, MN, Meghalaya, ML, Mizoram, MZ, Nagaland, NL, Sikkim, SK, Tripura, TR |
| `Punjab_zone` | Punjab, PB, Himachal Pradesh, HP, Jammu & Kashmir, JK, Ladakh, LA, Chandigarh |
| `Unknown` | anything else |

**Fulfillment-center → zone** (used for stock/booked/intransit/active; from
the skill, matches `LEFT(FC,3)` or exact FC codes):

| Zone | FC codes |
|---|---|
| `Karnataka_zone` | BLR |
| `WestBengal_zone` | CCX |
| `Assam_zone` | GAX |
| `Tamilnadu_zone` | CJB1, MAA4 |
| `Delhi_zone` | DED, DEL |
| `Rajasthan_zone` | JPX |
| `Maharashtra_zone` | BOM5, BOM7, ISK3, PNQ3 |
| `Uttarpradesh_zone` | LKO1 |
| `Nagpur_zone` | NAX1 |
| `Telangana_zone` | HYD3, HYD8 |
| `Punjab_zone` | ATX1, LDX1 |
| `Odisha_zone` | BBX |
| `bihar_zone` | PAX |
| `gujarat_zone` | AMD |
| `VSNC` | dropped entirely (not sellable inventory — excluded at ingestion, per SOP step 6) |
| `Unknown` | anything else |

### Per-(SKU, zone) columns

- **30-day sales** = `SUM(quantity)` from `barm_fba_sales_30d` where `sku` and
  `zone` match. *(sheet: `G`, via `PIVOT_30`)*
- **Daily rate** = 30-day sales / 30. *(`H`)*
- **120-day forecast (zone)** = `IF(30-day sales = 0, 5, daily rate * 120)` —
  a floor of 5 units is forecast even for a zone with zero sales. *(`I`)*
- **Current stock (zone)** = `SUM(ending_warehouse_balance)` from
  `barm_fba_stock` where `sku` and `zone` match. *(`O`, via `PIVOT_fba`)*
- **Booked (zone)** = `SUM(quantity)` from `barm_fba_status_events` where
  `status_category = 'booked'`, `sku`/`zone` match, restricted to the current
  + previous 2 months. *(`R`, via `Pivot_booked`)*
- **Intransit (zone)** = same, `status_category = 'picked_up'`. *(`S`, via
  `pivot_intansit`)*
- **Booked + intransit** = booked + intransit. *(`T`)*
- **Stock needed (zone)** = 120-day forecast (zone) − current stock (zone).
  *(`Q`)*
- **Stock needed after inbound (zone)** = `MAX(0, stock needed − booked+intransit)`.
  *(`U`)*
- **Active (zone, accumulated)** = `SUM(quantity)` from
  `barm_fba_status_events` where `status_category = 'active'`, `sku`/`zone`
  match, **accumulated across the current + previous 2 months** (a SKU that
  went active in an earlier of those 3 months stays counted — this is the
  skill's documented "active accumulates" rule). *(replaces the original
  sheet's per-refresh-date columns `AB`/`AC`/`AD` with one accumulated total —
  see Simplifications.)*
- **Shipment cap (zone) — REMOVED.** The original sheet's one manual
  non-formula input column (`X`, a per-batch shipment/send limit ops typed
  in) has no equivalent in this dashboard-native version — confirmed with
  the user there is no manual per-(SKU, zone) input anywhere in this
  feature. `barm_fba_shipment_caps` does not exist; there is no UI for it.
- **To be sent (zone)** = `stock needed after inbound (zone)` — the zone's
  own already-computed need, surfaced directly. *(`Y` in the original
  sheet; simplified from `ROUND(MIN(stock needed after inbound (zone) /
  SKU-total stock needed after inbound * shipment cap (zone), stock needed
  after inbound (zone)), 0)` now that there is no cap to ratio against —
  with no batch-size constraint, "how much to send" is simply "however
  much is actually needed".)*
- **Stock to be ordered (zone)** = SKU-total stock needed after inbound —
  surfaced directly (same value as "Total stock needed after inbound
  (SKU)" below). *(`Z` in the original sheet; simplified from SKU-total
  stock needed after inbound − shipment cap (zone) for the same reason.)*
- **Days until stockout (zone)** = `ROUND((current stock (zone) + booked +
  intransit (zone)) / daily rate (zone), 0)`, or `"--"` if daily rate is 0.
  *(`AA`)*

### Per-SKU rollups (sum/max across that SKU's zone rows)

- **Total 30-day orders (SKU)** = sum of 30-day sales across zones. *(`J`)*
- **Total 120-day forecast (SKU)** = sum of 120-day forecast (zone) across
  zones. *(`K`)*
- **Max forecast per product name (SKU)** = `MAX(total 120-day forecast)`
  across every SKU sharing the same resolved product name — dedups multiple
  SKU codes mapped to one physical product by taking the larger forecast.
  *(`L`)*
- **Total stock (SKU)** = sum of current stock (zone) across zones. *(`P`)*
- **Total stock needed after inbound (SKU)** = sum of stock needed after
  inbound (zone) across zones — this is the denominator used in "To be sent
  (zone)" above. *(`V`; the original header text calls this "total of R (all
  region)" but the live formula sums `U`, not `R` — the formula is the
  source of truth here, not the stale header label.)*

Product name is resolved the same way the rest of this dashboard already
does it: `master_product_marketing` first (per the
`ppc-dashboard-master-product-marketing-table` convention), falling back to
the SKU as-is if unmapped.

## Architecture

Same pattern as the existing Daily Ad Spend Report pipeline
(`supabase/functions/generate-ad-spend-report/`): uploads only move raw data
into Supabase; a Supabase Edge Function does all calculation server-side and
writes the deliverable; the dashboard is a thin client that triggers a job
and downloads the result once ready.

```
Upload (FBA tab, client-side parse only — no math)
  → barm_fba_daily_sales / barm_fba_stock_snapshot / barm_fba_booked /
    barm_fba_intransit / barm_fba_recently_act (raw insert, via atomic
    replace_* RPC functions — see the implementation-status note at the
    top of the plan doc)

Download (FBA tab) — click "Generate"
  → upsert report_generation_jobs (report_type = 'fba_forecast')
  → invoke Edge Function generate-fba-forecast-report
      → reads the 5 tables above (no shipment-caps table — removed, see below)
      → computes zone assignment, all per-(SKU,zone) and per-SKU columns above
      → builds a fresh .xlsx (exceljs or xlsx-js-style — plain computed
        values, no formulas/pivots)
      → uploads xlsx to Supabase Storage bucket `fba-forecast-reports`
      → upserts a `fba_forecast_reports` row (result summary + storage path)
      → marks the job completed/failed
  → dashboard polls report_generation_jobs, shows Download once completed
```

### New Supabase tables

- **`barm_fba_sales_30d`** — `purchase_date, fulfillment_channel,
  product_name, sku, quantity, ship_state`. Cleaning rules applied at
  ingestion (per SOP Section A): drop `amazon-order-id` starting with "S",
  drop rows dated today, drop `order-status = Cancelled`, drop
  `fulfillment-channel = Merchant`. Whole-table replace per upload (the
  source report is always "last 30 days" in full — no natural key to
  upsert against, matches how orders/returns tables already handle this
  per `amazonReportUpload.ts`).
- **`barm_fba_stock`** — `report_date, fnsku, fulfillment_center, asin, msku,
  disposition, ending_warehouse_balance`. Cleaning rules at ingestion (SOP
  Section B): keep only the most recent date in the report, drop
  `Fulfillment Center = VSNC`, keep only `Disposition = SELLABLE`.
  Whole-table replace per upload.
- **`barm_fba_status_events`** — `source_month` (e.g. `2026-09`), `product,
  sku, quantity, fc, status_raw, status_category, booked_date, pickup_date`.
  `status_category` is derived at ingestion from `status_raw` (case-
  insensitive, trimmed): `booked` → `'booked'`, `picked up` → `'picked_up'`,
  `active` → `'active'`, anything else excluded (not inserted). Ingested
  as a **per-source_month replace**: each upload deletes existing rows for
  only the `source_month`s present in that upload, then inserts the fresh
  rows for those months — idempotent for re-uploads without depending on a
  fragile multi-column key (booked_date/pickup_date are frequently blank,
  which would make a null-inclusive unique key unreliable). Months not
  present in the current upload are left untouched. Only the current +
  previous 2 `source_month`s are read by the report, so older months
  simply age out of the query window rather than needing cleanup, and
  "active" naturally accumulates within that 3-month window exactly as
  the SOP describes.
- **`barm_fba_shipment_caps` — REMOVED.** No manual per-(SKU, zone) input
  exists anywhere in this feature (see the "Shipment cap (zone) — REMOVED"
  note above); this table is never created and the FBA page has no grid
  for it.
- Actual table names differ from the 3 above (`barm_fba_sales_30d` /
  `barm_fba_stock` / `barm_fba_status_events`) — see the implementation-
  status note at the top of `docs/superpowers/plans/2026-09-22-fba-
  forecast-report.md` for the real names
  (`barm_fba_daily_sales`/`barm_fba_stock_snapshot`/`barm_fba_booked`+
  `barm_fba_intransit`+`barm_fba_recently_act`) and ingestion mechanics
  (atomic RPC replace, not per-source_month delete).

### Report job plumbing (reusing the existing async infrastructure)

- `report_generation_jobs.report_type = 'fba_forecast'` — same table/status
  machine (`pending → processing → completed/failed`) already used for the
  Ad Spend Report, per `src/lib/adSpendJobs.ts`'s `findOrCreateJob` pattern.
- New `fba_forecast_reports` table mirroring `daily_ad_spend_reports`:
  `job_id, generated_at, result_json (summary: SKU count, zone count, low-
  stock-alert count), xlsx_storage_path`.
- New Storage bucket `fba-forecast-reports`.

## Upload flow (dashboard side)

New "FBA" section, following the existing `UploadReportType` pattern in
`src/lib/amazonReportUpload.ts` (add 3 new report types + a
`REPORT_TABLE`/`REPORT_LABEL` entry each, reusing the existing `UploadCard`
component):

1. **Amazon All Orders report** (CSV) → cleaned per SOP Section A rules
   above → `barm_fba_sales_30d`.
2. **FBA Stock report** (CSV, Custom Report Builder export) → cleaned per
   SOP Section B rules above → `barm_fba_stock`.
3. **FBA & FBF Details-Updated workbook** (.xlsx, multi-sheet) — parsed
   client-side with the `xlsx` package already in `package.json`:
   - Sheet names matched by pattern `FBA <MONTH><YY>` (e.g. `FBA SEPT26`);
     the 3 sheets nearest to (and not after) the current calendar month are
     used — confirmed against the real file, which has `FBA JUL26`, `FBA
     AUG26`, `FBA SEPT26` as its 3 most recent sheets as of today (2026-09-22).
   - Columns located **by header name, never fixed letter** (per the skill's
     warning — the "ATS/NON-ATS" column shifts everything after it).
     `headers.indexOf('STATUS')` (first occurrence only — sheets have two
     columns literally named "STATUS"; the second is a tracking-text blob
     and is ignored).
   - Column mapping: Product → `A`-named column, SKU → `SKU ID`, Quantity →
     `Final shipped quantity`, FC → `FC`, Status → first `STATUS` column.
   - Each row's `status_raw` classified into `status_category` as described
     above; excluded rows (cancelled, "Didn't send to FBA", etc.) are not
     inserted at all.
There is no 4th "shipment cap grid" input — that manual per-(SKU, zone)
value was removed entirely (see the "Shipment cap (zone) — REMOVED" note
above); "To be sent" and "Stock to be ordered" are computed directly with
no editable input anywhere in this feature.

All 3 upload cards report row-count deltas (kept/dropped and why), matching
the existing `UploadCard` convention already used elsewhere on this page.

## Simplifications from the original Excel sheet (explicit, not silent)

1. **No live Excel pivot tables or formulas** in the output — every value is
   pre-computed by the Edge Function, matching every other report this
   dashboard already generates (Ad Spend, Weekly Sales, Historical
   Analysis). Confirmed with the user.
2. **"Active" is one accumulated total per (SKU, zone)** instead of the
   original sheet's ad hoc "new column per exact refresh calendar-date"
   scheme (`AB`/`AC`/`AD` in the live sheet, each a snapshot pulled from
   `pivot_act` on the day it was refreshed). The accumulated total is the
   behavior the skill documents as intended; the per-date columns were an
   artifact of repeated manual refreshes, not a deliberate design.
3. **Dropping the Excel-only self-consistency "CHECK" columns** (e.g.
   `30_days_sales!K` = `I2=J2`, `FBA analysis` has none of these directly
   but its source raw sheets do) — those verified that Excel's cached pivot
   agreed with a live `SUMIF` recompute, which only matters because Excel
   pivot caches can silently go stale. A single SQL/Edge-Function
   calculation has one source of truth, so there is nothing to
   cross-check.
4. **Dropping columns A ("S.No"), F ("Total peak orders (30d) in last 14
   months"), W ("Current Stock present per SKU ID for FBA")** — confirmed
   blank/unused in the user's live workbook (no formula, no data in any
   inspected row).

## Output workbook

Sheets (all plain values, generated fresh with the Excel library already
used by other reports):
- **FBA Analysis** — one row per (SKU, zone): all the per-(SKU,zone) and
  per-SKU columns above, in the same left-to-right order as the original
  sheet (minus the dropped/simplified columns).
- **30-Day Sales**, **FBA Stock**, **Booked**, **Intransit**, **Active** —
  the cleaned raw rows (zone-tagged), for transparency/spot-checking,
  mirroring the original sheet names.

## Error handling

- Upload cards: reject files missing a required column (matched by header
  name); surface row-count deltas and drop reasons, matching existing
  `UploadCard` behavior.
- FBA & FBF Details upload: if fewer than 3 recognizable month sheets are
  found, warn but proceed with what's found (so an early-month upload still
  works before 3 months of history exist).
- Edge Function: identical job-status machine to the Ad Spend Report
  (`pending/processing/completed/failed` with `error_message`), surfaced in
  the dashboard the same way `reports/page.tsx` already does for that
  report.

## Testing

- Unit tests for the two zone-mapping functions against the exact tables
  above (ship-state list and FC list), including trim/uppercase edge cases.
- Golden-row reconciliation against the user's real uploaded files: SKU
  `B-SENBR-1` / `Karnataka_zone` must compute 30-day sales = 108, 120-day
  forecast (zone) = 432, current stock (zone) = 168, stock needed after
  inbound (zone) = 264, days until stockout = 47 — the live values already
  present in the user's real `FBA analysis!row 2`.
- Ingestion tests for the FBA & FBF Details workbook parser: month-sheet
  auto-detection, duplicate-"STATUS"-column handling, and the
  ATS/NON-ATS column-shift case (present in the real `FBA SEPT26` sheet).
