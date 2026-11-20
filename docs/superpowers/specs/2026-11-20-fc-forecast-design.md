# FC Forecast tab — design

Date: 2026-11-20. Branch `feature/fc-forecast`, cut from `mna-vps-20261119-adspend` (= what mna.b-arm.org runs, bec976b). Deploy target: mna.b-arm.org only, after the user approves.

## Intent

Every week the team builds `FC_forecast_sheet_on <date>.xlsx` by hand. They paste three months of sales from five channels, map SKUs to product names, refresh two pivots, and mail the result. The sheet says how much stock each product needs in B-ARM's own warehouse (FC). That warehouse ships every order that is not FBA/FBF. The manual job is slow and error-prone (the 18.11 file only had data to 31 Oct). This tab produces the same sheet straight from data already in Supabase.

Success: open the tab and see the forecast for "as of yesterday", with numbers that follow the sheet's rules. Download it as an xlsx in the sheet's layout, with no pasting.

## The rule (from the sheet's own "HOW TO DO" tab)

Per product:
- `peak` = highest sale in the last 3 months
- `last30` = sale in the last 30 days
- `max` = MAX(peak, last30)
- `min_stock` = MAX(ROUND(max × 1.5, 0), 5)

**Windows (user decision 2026-11-20: rolling, up to yesterday).** `as_of` = yesterday (IST).
- Block 1 = as_of−29 … as_of. This is `last30`.
- Block 2 = as_of−59 … as_of−30.
- Block 3 = as_of−89 … as_of−60.
- `peak` = MAX(block1, block2, block3).

`max` therefore always equals `peak`. Keep the formula anyway so it reads like the sheet. ROUND is half-up, as in Excel (`round()` on numeric in Postgres; not float banker's rounding).

## Goals

1. Page `/dashboard/inventory/fc-forecast` under Catalog in the sidebar, next to "Consolidated Stock Sheet". Label "FC Forecast".
2. One table, one row per product: Product, Block 3, Block 2, Block 1 (= last 30 days), Peak, Max, Min stock. Plus a per-channel split of the last 30 days (Amazon, Flipkart, Meesho, Website, Seller Flex) to explain the number. Each block header shows its date range. Sortable; search box.
3. "As of" date picker, default yesterday. Any past date works, so last week's sheet can be redone.
4. Download xlsx. Sheet 1 "FORECAST SHEET" has the client's columns: PRODUCT NAME, peak data in 3 months, last 30 days, max, Minimum stock needed. Sheet 2 has the per-channel and per-block detail. Sheet 3 lists unmapped SKUs. File name `FC forecast sheet on DD-MM-YYYY.xlsx`.
5. Unmapped SKUs panel: SKUs sold in the 90 days that map to no product, with channel and units. Each row has a product picker (existing product names, or type a new one). Saving writes the mapping and recomputes.
6. Seller Flex upload card on the same page. It takes the Amazon "VSNC-CUSTOMER_SHIPMENTS-ALL-<from>-<to>.csv" export and shows the stored date range ("data up to …").
7. A "data up to" line per channel, so a stale source is visible. Example: "Seller Flex: up to 17 Nov".

## Non-goals

- No weekly email now. Emails are paused on mna. The function is built so a mail can reuse it later.
- No comparison with current FC/godown stock ("how much to send"). That's a natural next step; not in this build.
- No change to the Consolidated Stock Sheet, the FC name-check mail, or any other page.
- No Shopify #1018–#1052 backfill. Known gap: Sep 22 – Oct 12 website units read low until it's filled.

## Anti-goals

- Numbers must never silently drop a sale. Every unit sold in the window shows up either under a product or in the Unmapped list.
- Must not add timeout risk to the dashboard. One small RPC per page load, not tens of thousands of rows to the browser. The anon role has a 10 s statement timeout and the DB is on Micro compute.
- Must not write to Vercel or touch production crons.

## Approaches considered

- **A. Browser calculation** (fetch 90 days of rows from 5 tables, ~35k rows, sum client-side). Matches existing pages, but needs many paged queries. Recent "statement timeout" incidents on this DB make it risky.
- **B. Postgres function returning the finished table (CHOSEN by user).** One RPC returns ~200 rows. Fast, one source of truth, reusable for a future weekly mail. Costs a migration; the logic lives in SQL.
- **C. Next.js API route with server cache.** Still pulls the big rows over the wire to the server; adds cache upkeep.

## Data sources (verified against the client's Aug–Oct sheet on 2026-11-19/20)

Day = IST calendar day. Units = quantity. Every channel excludes cancelled orders.

| Channel | Source | Filter | Date |
|---|---|---|---|
| Amazon self-ship | `amazon_orders` for days ≤ its max purchase day; `barm_daily_am_orders` for later days | `fulfillment-channel` = 'Merchant' (daily: `raw->>'fulfillment-channel'`), status not like 'Cancel%' | `left("purchase-date",10)` (already IST); daily: `report_date` |
| Flipkart self-ship | `barm_flipkart_order_report` for days ≤ its max `order_date`; `barm_daily_fk_orders` after | `coalesce(fulfilment_type, raw->>'fulfilment_type')` ≠ 'FBF', status not ilike 'cancel%' | `order_date` / `report_date` |
| Meesho (B Arm account) | `barm_daily_ms_barm_orders` | `order_status` not ilike 'cancel%' | `report_date` |
| Website | `barm_shopify_orders_v2` (`is_test` false, `cancelled_at` null, use `current_quantity` if not null else `quantity`) + `barm_online_orders` (Woo history: `"Order Status"`='Received', non-empty `"Order Number"`) | as stated | Shopify `order_created_at AT TIME ZONE 'Asia/Kolkata'`; Woo `"Order Date"` is 'DD-MM-YYYY HH:MM:SS' |
| Seller Flex | new table `barm_sellerflex_shipments` | `status` ≠ 'Cancelled' | `shipment_creation_date` |

Reconciliation result (Aug–Oct): Amazon, Flipkart and Meesho match the sheet exactly. Website and Seller Flex differ slightly by design:
- Website: the sheet uses the accounts invoice list; this uses order data.
- Seller Flex: the sheet counted cancelled shipments; this excludes them, like every other channel.

**Builder call to confirm:** whether `barm_daily_fk_orders` is needed at all. As of 20 Nov the report table already runs to 18 Nov. Use the "report table up to its max date, daily table after" rule for both Amazon and Flipkart. Never count a day from both tables.

### Website (Woo) rules — builder call

Don't use the simple filter in the table above. Port the existing rules in `src/lib/barmOnlineOrderRules.ts` into SQL, so website units agree with the B-ARM Website page:
- latest load per (Order Number, SKU)
- "Received" only
- skip rows whose shifted "Order Total Tax Amount" says cancelled, or whose "COD Fee" says RETURNED

Woo matters only for days up to 21 Sep 2026, when the site moved to Shopify.

### Client files (inputs on the user's PC)

- Forecast workbook: `C:\Users\B ARM\Downloads\Spreadsheets\FC_forecast_sheet_on 18.11.2026.xlsx`
  - "SKUID,NAME" tab, columns SKUID, Product: the mapping seed.
  - "FORECAST SHEET" tab, column A "PRODUCT NAME" (186 rows): the product-list seed.
  - "ALL IN ONE" tab: the Aug–Oct check data.
- Generate `supabase/seed/fc_sku_product_map_2026-11-18.json` and `supabase/seed/fc_products_2026-11-18.json` from it with a small script, and commit both.
- Seller Flex sample: `C:\Users\B ARM\Downloads\Spreadsheets\VSNC-CUSTOMER_SHIPMENTS-ALL-01-Aug-2026-17-Nov-2026-1.csv` (1,560 rows). Load it once as the initial Seller Flex data, so the first forecast isn't missing the channel.

### Seller Flex table (new)

CSV header, exact:

`Shipment Creation Date, Shipment ID, shipment Type, SKU, MSKU, ASIN, Custom ID, Title, Shipment Tracking ID, Customer Order ID, Units, Status, Order Value, ExSD, Assigned to picklist, Packed, Actual Shipout Date, Hazmat, Serial Number, Expiry, Gift Msg, Gift Wrap, Is Fast Track, Channel`

- Status values seen: Confirmed, Manifested, Cancelled.
- Dates look like '17-Nov-2026'.
- `channel` = the CSV "Channel" column (value seen: FBA). Stored, not filtered on.
- `shipment_id` = "Shipment ID"; `customer_order_id` = "Customer Order ID"; `sku` = "MSKU".

`barm_sellerflex_shipments`:
- `shipment_id`, `sku` (the MSKU column; the CSV's "SKU" column is Amazon's internal id), `asin`, `customer_order_id`, `units` int, `status`, `shipment_creation_date` date, `channel`, `raw` jsonb, `created_at`.
- Unique key (`shipment_id`, `sku`).

Upload = upsert on that key, so re-uploading an overlapping date range updates statuses and never duplicates. Parse with PapaParse (titles contain commas; quoted). Date format is 'DD-Mon-YYYY'. RLS on, with the same anon policies as the other upload tables in this project.

## SKU → product mapping

- New table `fc_sku_product_map` (`sku` text primary key, compared case-insensitively and trimmed, `product` text, `source` text 'client_sheet' | 'dashboard', `updated_at`). Seeded once from the client sheet's "SKUID,NAME" tab: 2,369 rows, 466 product names. Seed file kept in repo `supabase/seed/fc_sku_product_map_2026-11-18.json`.
- Lookup order: `fc_sku_product_map`, then `master_product_skuid."SKU ID"` → `"Product Name"`, then Unmapped.
- Checked 20 Nov: of 507 SKUs sold Aug–Oct, the client map covers 504. The master table covers 493, and 25 of those have a different name (e.g. B-MRD-WT: client "MRD white", master "MRD Grey"). The client map wins because its names are the ones the team works with.
- Strip invisible characters (e.g. a leading U+200E seen in `‎B-VD-PLAS-TPE`) before matching.

## Product list

Rows = every product named in the seeded client forecast list (186 products, stored as `fc_products(product, active)`), plus any other mapped product with a sale in the 90 days. A product with no sales still shows, with min stock 5, as the sheet does. `active=false` hides a product (no UI for that in this build; SQL only).

## Database objects (one migration)

- Tables `fc_sku_product_map`, `fc_products`, `barm_sellerflex_shipments`.
- `fc_forecast(p_as_of date)` returns one row per product with these columns: `block1..3`, `peak`, `last30`, `max_units`, `min_stock`, `ch_amazon/flipkart/meesho/website/sellerflex` (block-1 units), and the block date ranges.
- `fc_unmapped_skus(p_as_of date)` returns `sku`, `channel`, `units_90d`, `sample_title`.
- `fc_source_dates()` returns the max date per channel source.
- Functions are SECURITY INVOKER and readable by anon, like the other RPCs here. Check the plan with EXPLAIN on a cold cache: it must finish well under the 10 s anon limit. Add an expression index if one of the scans needs it.
- Writes to `fc_sku_product_map` from the page go through the anon key, like other dashboard writes. Confirm the policy allows it; `amazon_orders` and `barm_online_orders` deny anon writes, so check rather than assume.

### Migration timing (needs the user's OK)

mna.b-arm.org and Vercel share one Supabase project. The migration is additive only: 3 new tables and 3 new functions, nothing existing changed. Plan: apply it to the live project during the build, so `fc_forecast` can be checked and EXPLAINed on real data. Nothing in the app calls it until the page is deployed to mna. Rollback = drop the new objects.

## Front end

- Next.js page in this repo's own style (check `node_modules/next/dist/docs` per AGENTS.md; this Next version has breaking changes). Reuse the Consolidated Stock Sheet page's layout, table and upload-card components where they fit.
- xlsx built in the browser with the `xlsx` package already in the repo.
- Theme: the mna branch uses emerald, not indigo.

## Tests

- Unit tests (existing test runner in repo) for the pure parts: Seller Flex CSV parsing, block/date maths, the min-stock rule including ROUND half-up and the floor of 5.
- SQL check: run `fc_forecast` for as_of = 2026-10-31 with 30-day blocks Oct/Sep/Aug-ish. Compare against the client's sheet per product for the three channels that reconcile (Amazon, Flipkart, Meesho). Blocks won't line up exactly with calendar months, so for the check temporarily compute calendar-month sums with the same filters and require exact equality there.

## Left to the builder

Component structure, file names, sorting defaults, loading states, how the product picker is built, chunking of the upload, exact SQL shape.
