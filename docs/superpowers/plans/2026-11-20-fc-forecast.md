# FC Forecast Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/dashboard/inventory/fc-forecast` page that rebuilds the client's weekly FC forecast sheet (min stock per product) from Supabase data, with xlsx download, unmapped-SKU fixing, and a Seller Flex CSV upload.

**Architecture:** One Supabase migration adds 3 tables (`fc_sku_product_map`, `fc_products`, `barm_sellerflex_shipments`) and 3 SQL functions (`fc_forecast`, `fc_unmapped_skus`, `fc_source_dates`). The page calls those RPCs with react-query. Pure TS helpers (date blocks, min-stock rule, CSV parser, xlsx rows) are unit tested with `node:test`.

**Tech Stack:** Next.js (repo version, read `node_modules/next/dist/docs` first), React, @tanstack/react-query, @supabase/supabase-js, xlsx, papaparse, Postgres (Supabase project `zslujuqitousvywjzqwc`), node:test.

**Spec:** `docs/superpowers/specs/2026-11-20-fc-forecast-design.md`

## Global Constraints

- Branch `feature/fc-forecast` (worktree in scratchpad `fc-forecast`), base bec976b. Deploy to mna.b-arm.org only, and only after the user's go-ahead. Never push to GitHub/Vercel.
- `as_of` default = yesterday in IST. Blocks: B1 = as_of−29…as_of, B2 = as_of−59…as_of−30, B3 = as_of−89…as_of−60.
- `peak = max(B1,B2,B3)`, `last30 = B1`, `max_units = max(peak,last30)`, `min_stock = greatest(round(max_units*1.5), 5)`. Use numeric rounding (half-up): 1.5→2, 2.5→3 (×1.5 of 3 = 4.5 → 5).
- Every channel excludes cancelled. Day = IST calendar day.
- The migration is additive only. Apply it to the live project with the Supabase MCP `apply_migration` (user approved 2026-11-20).
- Theme: emerald (mna branch). `npm run prebuild` theme check must pass.
- Tests: `node --test <file>` (Node 24 strips TS types). Imports use explicit `.ts` extensions, like the existing `*.test.ts`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Client input files (read-only):
  - `C:\Users\B ARM\Downloads\Spreadsheets\FC_forecast_sheet_on 18.11.2026.xlsx`
  - `C:\Users\B ARM\Downloads\Spreadsheets\VSNC-CUSTOMER_SHIPMENTS-ALL-01-Aug-2026-17-Nov-2026-1.csv`

## Review Focus

1. A Seller Flex CSV re-uploaded with an overlapping date range must not double count. Upsert on (shipment_id, sku). A repeated key inside one file keeps the last row. Pinned in Task 3.
2. A SKU differing only by case, spaces or invisible marks (U+200E in `‎B-VD-PLAS-TPE`) must still map. Pinned in Task 2 (SQL check) and Task 3 (`normalizeSku` test).
3. An as_of later than a channel's newest data must say so on the page, not show silent zeros. `fc_source_dates` gives per-channel max dates; the page flags any channel whose max date < as_of. Pinned in Task 4 (`staleChannels` test).
4. A product in the client list with no sales shows min stock 5. Pinned in Task 4 (`minStock(0) === 5`) and Task 2 (SQL check).
5. CSV titles with quoted commas must parse into the right columns. Pinned in Task 3.

---

### Task 1: Seed files + tables migration

**Files:**
- Create: `scripts/fc-forecast-seed.mjs` (reads the forecast xlsx, writes the two JSON seeds)
- Create: `supabase/seed/fc_sku_product_map_2026-11-18.json`, `supabase/seed/fc_products_2026-11-18.json`
- Create: `supabase/migrations/20261120120000_fc_forecast_tables.sql`

**Interfaces:**
- Produces tables:
  - `fc_sku_product_map(sku text primary key, product text not null, source text not null default 'dashboard', updated_at timestamptz default now())`. `sku` is stored normalized: lower, trimmed, with U+200B–U+200F and U+FEFF removed.
  - `fc_products(product text primary key, active boolean not null default true)`
  - `barm_sellerflex_shipments(id bigserial pk, shipment_id text not null, sku text not null, asin text, customer_order_id text, units int not null, status text, shipment_creation_date date not null, channel text, raw jsonb, created_at timestamptz default now(), unique(shipment_id, sku))`
  - SQL helper `fc_norm_sku(text) returns text immutable` (the normalization above), used by Task 2.
- RLS enabled on all three. anon: select on all three; insert/update on `fc_sku_product_map` and `barm_sellerflex_shipments`. Copy the policy style from `supabase/migrations/20261118120000_marketing_360_stage2.sql`.

- [ ] **Step 1:** Write `scripts/fc-forecast-seed.mjs`. Usage: `node scripts/fc-forecast-seed.mjs "<xlsx path>"`. It reads the "SKUID,NAME" tab (columns SKUID, Product; skip blank SKUID), normalizes each sku, and keeps the first product per normalized sku. It reads the "FORECAST SHEET" tab, column "PRODUCT NAME", and writes both JSON arrays (`[{sku,product}]`, `[{product}]`).
- [ ] **Step 2:** Run it. Expected: about 2,36x map rows (fewer after dedupe), 186 products, both files written.
- [ ] **Step 3:** Write the migration. Apply it with `apply_migration` (name `fc_forecast_tables`).
- [ ] **Step 4:** Load the seeds with `execute_sql`, using `insert … select from jsonb_to_recordset('<json>')`; map rows get `source='client_sheet'`. Verify: `select count(*) from fc_sku_product_map` equals the JSON length, and `select count(*) from fc_products` = 186.
- [ ] **Step 5:** Commit script, seeds and migration.

### Task 2: Forecast SQL functions

**Files:**
- Create: `supabase/migrations/20261120130000_fc_forecast_functions.sql`

**Interfaces:**
- Consumes: Task 1 tables and `fc_norm_sku`.
- Produces (all `language sql stable security invoker`, `grant execute … to anon`):
  - `fc_sales_lines(p_from date, p_to date) returns table(day date, channel text, sku text, title text, units numeric)`. `channel` ∈ 'amazon','flipkart','meesho','website','sellerflex'. Sources and filters are exactly the spec's "Data sources" table:
    - Amazon: `amazon_orders` for days ≤ its max purchase day, `barm_daily_am_orders` after.
    - Flipkart: `barm_flipkart_order_report` for days ≤ its max order_date, `barm_daily_fk_orders` after.
    - Woo rules ported from `src/lib/barmOnlineOrderRules.ts`: latest "created at" per (Order Number, SKU); Received; non-empty order number; parseable DD-MM-YYYY; skip "cancelled" tax column and "returned" COD Fee.
  - `fc_forecast(p_as_of date) returns table(product text, block1 numeric, block2 numeric, block3 numeric, peak numeric, last30 numeric, max_units numeric, min_stock int, ch_amazon numeric, ch_flipkart numeric, ch_meesho numeric, ch_website numeric, ch_sellerflex numeric, b1_from date, b1_to date, b2_from date, b2_to date, b3_from date, b3_to date)`.
    - Product = map table by `fc_norm_sku(sku)`, else `master_product_skuid` by `fc_norm_sku("SKU ID")` → trimmed "Product Name".
    - Rows = active `fc_products` ∪ mapped products with sales in the 90 days. The `ch_*` columns are B1 units.
  - `fc_unmapped_skus(p_as_of date) returns table(sku text, channel text, units_90d numeric, sample_title text)`, ordered by units desc.
  - `fc_source_dates() returns table(channel text, source text, max_day date)`, one row per source table.

- [ ] **Step 1:** Write the migration and apply it (`fc_forecast_functions`).
- [ ] **Step 2: SQL check against the client sheet.** Run `select channel, to_char(day,'YYYY-MM') m, sum(units) from fc_sales_lines('2026-08-01','2026-10-31') group by 1,2`. Expected, from the 2026-11-20 reconciliation. Flipkart data starts 12 Aug and Meesho 13 Aug, so their August figures are partial.
  - amazon: Aug 2,344, Sep 2,546, Oct 3,130
  - flipkart: Aug 3,260, Sep 5,411, Oct 5,267
  - meesho: Aug 445, Sep 848, Oct 457
  - sellerflex (after Task 3 has loaded data): Oct 607
- [ ] **Step 3: Rule check.** `select * from fc_forecast('2026-11-19') where product in ('Articulation Spoon','BP monitor without Bluetooth')`.
  - min_stock ≥ 5 on every row.
  - For one product, hand-compute min_stock from B1..B3 and compare.
  - `select count(*) from fc_forecast('2026-11-19')` ≥ 186.
- [ ] **Step 4: Normalization check.** `select fc_norm_sku(E'\u200EB-VD-PLAS-TPE ')` = `'b-vd-plas-tpe'`.
- [ ] **Step 5: Speed check.** `explain analyze select * from fc_forecast('2026-11-19')` must take < 2 s. If not, add an expression index (e.g. on `amazon_orders(left("purchase-date",10))` for Merchant) in the same migration file, then re-apply.
- [ ] **Step 6:** Commit.

### Task 3: Seller Flex CSV parser + upload + initial load

**Files:**
- Create: `src/lib/sellerFlexShipments.ts` (pure parsing, no `@/` imports)
- Create: `src/lib/sellerFlexShipments.test.ts`
- Create: `src/lib/sellerFlexUpload.ts` (`uploadSellerFlexCsv(db, file)`: upsert in 500-row chunks, onConflict `shipment_id,sku`)
- Create: `scripts/fc-sellerflex-load.mjs` (one-off initial load of the VSNC CSV, using the same parser via jiti, like the existing tests)

**Interfaces:**
- Produces:
  - `normalizeSku(s: string): string`. Same rule as SQL `fc_norm_sku`.
  - `parseSellerFlexCsv(text: string): { rows: SellerFlexRow[]; minDate: string | null; maxDate: string | null; skipped: number }`
  - `type SellerFlexRow = { shipment_id: string; sku: string; asin: string; customer_order_id: string; units: number; status: string; shipment_creation_date: string /* YYYY-MM-DD */; channel: string; raw: Record<string,string> }`
  - `sku` = the CSV "MSKU" column (trimmed, original case kept; matching normalizes later).
  - `uploadSellerFlexCsv(db: SupabaseClient, file: File): Promise<{ saved: number; minDate: string|null; maxDate: string|null; skipped: number }>`

- [ ] **Step 1: Write failing tests** in `sellerFlexShipments.test.ts`:
  - `parses the VSNC header and a quoted title with commas`: a 2-row CSV string using the exact header from the spec, row 1 title `"B-Arm Self Insemination Kit, Pack of 5"`. Assert `rows[0].sku === 'B-INSEM-KIT-PK5-3'`, `units === 1`, `status === 'Confirmed'`, `shipment_creation_date === '2026-11-17'`, `shipment_id === 'TVsy7bDps'`.
  - `keeps the last row when a shipment_id+sku repeats in one file`: same key twice with statuses Confirmed then Cancelled → 1 row, status 'Cancelled'.
  - `skips rows without Shipment ID or a parseable date`: `skipped === 1`.
  - `minDate/maxDate span the file`.
  - `normalizeSku strips U+200E, trims and lowercases`.
- [ ] **Step 2:** `node --test src/lib/sellerFlexShipments.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement with papaparse (`header: true`, `skipEmptyLines: true`, trimmed headers). Dates are 'DD-Mon-YYYY'.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Implement `sellerFlexUpload.ts`. Write `scripts/fc-sellerflex-load.mjs` (reads `.env.local` like the reconciliation scripts did, anon key) and run it on the VSNC CSV.
  - Verify: `select count(*), min(shipment_creation_date), max(shipment_creation_date) from barm_sellerflex_shipments` → about 1,560 rows, 2026-08-01 … 2026-11-17.
  - Verify: Oct non-cancelled units = 607.
- [ ] **Step 6:** Commit.

### Task 4: Forecast rules + xlsx export (pure)

**Files:**
- Create: `src/lib/fcForecastRules.ts`
- Create: `src/lib/fcForecastRules.test.ts`
- Create: `src/lib/fcForecastExport.ts` (builds the workbook from RPC rows; triggers the browser download)

**Interfaces:**
- Produces:
  - `type FcRow` = the `fc_forecast` columns (snake_case, numbers).
  - `type FcUnmapped` = the `fc_unmapped_skus` columns.
  - `type FcSourceDate = { channel: string; source: string; max_day: string | null }`
  - `yesterdayIst(now?: Date): string`. Returns YYYY-MM-DD.
  - `blocks(asOf: string): { b1: [string,string]; b2: [string,string]; b3: [string,string] }`
  - `minStock(maxUnits: number): number`. JS mirror of the SQL rule, used for the page's sanity display and tests.
  - `staleChannels(dates: FcSourceDate[], asOf: string): string[]`. Returns channels whose newest source max_day < asOf. For Amazon/Flipkart, use the max over their two sources.
  - `fcFileName(asOf: string): string` → `FC forecast sheet on DD-MM-YYYY.xlsx`
  - `exportFcWorkbook(rows: FcRow[], unmapped: FcUnmapped[], asOf: string): void`. Writes 3 sheets:
    - "FORECAST SHEET": PRODUCT NAME, peak data in 3 months, last 30 days, max, Minimum stock needed
    - "DETAIL": blocks with date-range headers + channel split
    - "UNMAPPED SKUS"

- [ ] **Step 1: Write failing tests:**
  - `yesterdayIst(new Date('2026-11-19T20:00:00Z')) === '2026-11-19'`. 20:00Z is 01:30 IST on 20 Nov, so yesterday is the 19th.
  - `yesterdayIst(new Date('2026-11-19T17:00:00Z')) === '2026-11-18'`. 17:00Z is 22:30 IST on the 19th.
  - `blocks('2026-11-19')` → b1 `['2026-10-21','2026-11-19']`, b2 `['2026-09-21','2026-10-20']`, b3 `['2026-08-22','2026-09-20']`.
  - `minStock(0) === 5`, `minStock(3) === 5`, `minStock(5) === 8` (7.5 → 8), `minStock(9) === 14` (13.5 → 14), `minStock(100) === 150`.
  - `staleChannels([{channel:'sellerflex',source:'barm_sellerflex_shipments',max_day:'2026-11-17'}, {channel:'meesho',source:'barm_daily_ms_barm_orders',max_day:'2026-11-19'}], '2026-11-19')` deep-equals `['sellerflex']`.
  - `fcFileName('2026-11-19') === 'FC forecast sheet on 19-11-2026.xlsx'`.
- [ ] **Step 2:** `node --test src/lib/fcForecastRules.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `fcForecastRules.ts` (UTC date maths on YYYY-MM-DD strings; IST = UTC+5:30).
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Implement `fcForecastExport.ts` with `xlsx` (`XLSX.utils.aoa_to_sheet`, `XLSX.writeFile`).
- [ ] **Step 6:** Commit.

### Task 5: Page, mapping editor, upload card, navigation

**Files:**
- Create: `src/app/dashboard/inventory/fc-forecast/page.tsx`
- Create: `src/lib/fcForecastData.ts` (react-query fetchers: `fetchFcForecast(asOf)`, `fetchFcUnmapped(asOf)`, `fetchFcSourceDates()`, `saveSkuMapping(sku, product)`)
- Modify: `src/components/InventoryTabs.tsx` (add "FC Forecast" tab, `/dashboard/inventory/fc-forecast`)
- Modify: `src/components/Sidebar.tsx` (Catalog group: `{ id: "fc-forecast", label: "FC Forecast", icon: ClipboardList, path: "/dashboard/inventory/fc-forecast" }`, right after Consolidated Stock Sheet)

**Interfaces:**
- Consumes: Task 2 RPCs; Task 3 `uploadSellerFlexCsv`; Task 4 helpers and `exportFcWorkbook`.
- `saveSkuMapping` upserts `{ sku: normalizeSku(sku), product: product.trim(), source: 'dashboard' }` into `fc_sku_product_map`, then invalidates the three queries.
- Supabase client: the same one other dashboard writes use (`supabasePublic` from `@/lib/amazonReportUpload`).

- [ ] **Step 1:** Read the relevant guide in `node_modules/next/dist/docs` for app-router client pages (run `npm ci` in the worktree first if `node_modules` is missing).
- [ ] **Step 2:** Build the page, following `src/app/dashboard/inventory/consolidated/page.tsx` for layout (InventoryTabs on top, KPICard row, QueryErrorState).
  - Header: "As of" date input, default `yesterdayIst()`, max = yesterday.
  - KPI cards: products, total min stock, unmapped SKUs (count + units).
  - Data-up-to line: each channel's date; channels in `staleChannels` are shown in amber with "data only up to …".
  - Main table: Product | B3 | B2 | B1 (last 30 days) | Peak | Max | Min stock | Amazon | Flipkart | Meesho | Website | Seller Flex. Block headers show date ranges. Search box; click-to-sort, default min stock desc.
  - "Download xlsx" button → `exportFcWorkbook`.
  - Unmapped panel: one row per SKU (sku, channel, units, title) with an input + datalist of existing product names and a Save button → `saveSkuMapping`.
  - Seller Flex card: file input (.csv) → `uploadSellerFlexCsv`. Show saved count and the date range, then refetch.
- [ ] **Step 3:** `npm run typecheck`, `npm run lint`, `npm run check:theme`. Expected: no new errors in the touched files.
- [ ] **Step 4:** Commit.

### Task 6: End-to-end verification

- [ ] **Step 1:** Run all new tests: `node --test src/lib/sellerFlexShipments.test.ts src/lib/fcForecastRules.test.ts`. Expected: PASS.
- [ ] **Step 2:** `npx next build --webpack` in the worktree (the mna build command). Expected: success.
- [ ] **Step 3:** Start the dev server from the worktree (add a `.claude/launch.json` entry on a free port; copy `.env.local` from the main checkout). Open the page in the browser pane.
  - If a login is needed, ask the user to sign in.
  - Check: table loads, unmapped list loads, stale Seller Flex flag shows for any as_of after 17 Nov, xlsx downloads, the network shows one RPC per data set. No console errors.
- [ ] **Step 4:** Pick 3 products and compare page values with `select * from fc_forecast(<as_of>)`.
- [ ] **Step 5:** Final commit. Report to the user. Deploy to mna only on their explicit go-ahead.
