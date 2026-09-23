# FBA Forecast Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **IMPLEMENTATION STATUS (2026-09-22): Built, superseding several details below.**
> Everything in this plan has been implemented, on a single page
> (`src/app/dashboard/fba/page.tsx`, linked from a new "FBA" sidebar entry)
> rather than split across the Upload/Download pages as originally
> sketched. The pieces below are unchanged in spirit but differ from this
> doc's original code samples in three ways — read these before trusting
> any code block further down as current:
>
> 1. **Table names changed** (confirmed by the user after this plan was
>    first drafted). The raw ingestion tables are `barm_fba_daily_sales`
>    (not `barm_fba_sales_30d`), `barm_fba_stock_snapshot` (not
>    `barm_fba_stock`), and `barm_fba_booked` / `barm_fba_intransit` /
>    `barm_fba_recently_act` — three separate tables, split by STATUS at
>    ingestion — instead of one `barm_fba_status_events` table with a
>    `status_category` column. An additional `upload_history` table (not
>    `barm_fba_`-prefixed) logs every upload attempt across all 5 tables.
>    Actual schema: `scripts/fba_forecast_tables.sql` (the 5 ingestion
>    tables + `upload_history` + 3 atomic `replace_*` RPC functions) and
>    `scripts/fba_forecast_report_tables.sql` (`barm_fba_shipment_caps` +
>    `fba_forecast_reports` + the `fba-forecast-reports` Storage bucket).
>    Neither has been run in Supabase yet — both are pasted-and-run-by-hand
>    SQL Editor scripts, same as every other `scripts/*.sql` file here.
> 2. **Ingestion is RPC-based, not per-row upsert/delete**, per an explicit
>    "prefer a transaction or staging approach" requirement: the client
>    calls `supabase.rpc('replace_barm_fba_daily_sales', ...)` /
>    `replace_barm_fba_stock_snapshot` / `replace_fba_fbf_details` once per
>    upload, and each Postgres function body deletes + re-inserts inside
>    one implicit transaction, so a bad row rolls back the whole upload
>    instead of partially committing.
> 3. **Every date in this feature is the dashboard's own selected date**
>    (`endDate` from `useDashboard()`), never the server/browser's real
>    "today" — this includes the 30-day sales window, the stock snapshot's
>    anchor date, the FBA & FBF Details month-sheet selection, the
>    `active_date` stamped on `barm_fba_recently_act` rows, and the
>    generated report's `report_date`. See Tasks 4/5/9 below for the actual
>    function signatures (`reportDate: string` parameters throughout).
>
> Tasks 2, 3, 6, 7, 8 (zone mapping, calc engine, report export, Edge
> Function, job API routes) were implemented essentially as originally
> planned below — same files, same formulas, same job-status pattern reused
> from the Daily Ad Spend Report — with only the raw-table names/shapes in
> Task 6 updated to match point 1 above. Tasks 1, 4, 5, 9 changed more
> substantially and are corrected in place below.

**Goal:** Add a dashboard-native FBA Forecast Report — upload the 3 raw FBA reports, have Supabase compute the full forecast (zone assignment, 120-day forecast, stock needed, days-to-stockout), and download a fresh `.xlsx`.

**Architecture:** Same async job pipeline the Daily Ad Spend Report already uses: uploads only move raw rows into Supabase (no math client-side); a Supabase Edge Function does all calculation and writes the workbook to Storage; the dashboard triggers a job, polls it, and downloads the result once ready.

**Tech Stack:** Next.js (Pages Router API routes + App Router pages), Supabase (Postgres tables, Storage, Deno Edge Functions), `xlsx` / `xlsx-js-style` for parsing and workbook generation, `papaparse` for CSV, Node's built-in `node:test` for client-side pure-function tests, `Deno.test` for Edge-Function-side pure-function tests.

**Spec:** [docs/superpowers/specs/2026-09-22-fba-forecast-refresh-design.md](../specs/2026-09-22-fba-forecast-refresh-design.md) — read this first; it has the full column-by-column formula derivation this plan implements, the zone-mapping tables, and the explicit list of simplifications from the original Excel sheet.

## Global Constraints

- **No client-side duplicate of the forecast calculation.** Every formula in the spec's "Source-of-truth calculation" section runs ONLY in the Supabase Edge Function (`supabase/functions/_shared/fbaForecastCalc.ts` + `fbaForecastReportExport.ts`). The dashboard's upload code only parses/cleans/classifies raw rows for storage — it must never compute a zone, a forecast, a stock-needed figure, or any other derived column. This is a direct, explicit user requirement (Tamil/English: "calculation nadakanum Supabase la, not dashboard").
- **No live Excel pivot tables or formulas in the output** — every value in the generated `.xlsx` is a plain pre-computed number/string.
- **Reuse `report_generation_jobs`** (already exists — `scripts/report_generation_jobs_table.sql`) for job tracking; do not create a parallel job-status table.
- **Match the existing `barm_*` table conventions exactly**: RLS disabled + full grant to `anon` (see `scripts/fix_rls_all_tables.sql`'s pattern, reproduced in every table script below) — this app has no auth session and talks to Supabase entirely with the anon key.
- **Zone-mapping and formula values must match the spec's derivation exactly** — those were reverse-engineered from the user's real live workbook (`FBA_forecast sheet(30 days).xlsx`), not guessed.
- **Follow this codebase's existing test conventions**: pure, dependency-free logic gets a `node:test` file (client-side, relative imports, e.g. `mergeByConflictKey.ts`) or a `Deno.test` file (Edge-Function-side, e.g. `adSpendReportExport.regression.test.ts`) — I/O-heavy wrapper code (Supabase calls, API routes) is not unit-tested in this codebase, and this plan doesn't invent that pattern.

---

## Task 1: Supabase table schema

> **SUPERSEDED — as actually built:** split into two files.
> `scripts/fba_forecast_tables.sql` holds the 5 raw ingestion tables
> (`barm_fba_daily_sales`, `barm_fba_stock_snapshot`, `barm_fba_booked`,
> `barm_fba_intransit`, `barm_fba_recently_act`) plus the un-prefixed
> `upload_history` audit table and 3 atomic `replace_*` RPC functions
> (`replace_barm_fba_daily_sales`, `replace_barm_fba_stock_snapshot`,
> `replace_fba_fbf_details`) — see that file for the exact column list,
> including the `booked_date`/`pickup_date`/`status_raw` columns on all 3
> booked/intransit/recently_act tables and `active_date` on
> `barm_fba_recently_act` only. `scripts/fba_forecast_report_tables.sql`
> holds `barm_fba_shipment_caps`, `fba_forecast_reports`, and the
> `fba-forecast-reports` Storage bucket — split out because it belongs to
> the Generate/Download flow, not ingestion. Neither has been run in
> Supabase yet (both are manual SQL-Editor scripts). The code block below
> is the OLD draft (`barm_fba_sales_30d` / `barm_fba_stock` /
> `barm_fba_status_events`, no `upload_history`, no RPC functions) — do not
> run it; read the actual `.sql` files in `scripts/` instead.

**Files:**
- Create: `scripts/fba_forecast_tables.sql`

**Interfaces:**
- Produces: tables `barm_fba_sales_30d`, `barm_fba_stock`, `barm_fba_status_events`, `barm_fba_shipment_caps`, `fba_forecast_reports`; storage bucket `fba-forecast-reports`. Every later task's SQL column names must match this file exactly.

- [ ] **Step 1: Write the SQL file**

```sql
-- scripts/fba_forecast_tables.sql
-- Tables for the FBA Forecast Report feature (see docs/superpowers/specs/
-- 2026-09-22-fba-forecast-refresh-design.md). Run once in the Supabase SQL
-- Editor before the first FBA upload/generate.

-- Raw 30-day sales (SOP Section A / skill Section A). Whole-table replace on
-- every upload — the source Amazon report is always "last 30 days" in full,
-- same FULL_REPLACE_TYPES convention as price_listing/fba_inventory in
-- amazonReportUpload.ts.
create table if not exists public.barm_fba_sales_30d (
  id bigint generated by default as identity primary key,
  purchase_date date not null,
  fulfillment_channel text not null,
  product_name text not null,
  sku text not null,
  quantity integer not null,
  ship_state text not null,
  created_at timestamptz not null default now()
);
create index if not exists barm_fba_sales_30d_sku_idx on public.barm_fba_sales_30d (sku);

-- Raw FBA stock (SOP Section B / skill Section B). Whole-table replace on
-- every upload; the upload function itself filters to the most-recent date,
-- non-VSNC, SELLABLE only, per the SOP.
create table if not exists public.barm_fba_stock (
  id bigint generated by default as identity primary key,
  report_date date not null,
  fnsku text not null,
  fulfillment_center text not null,
  asin text not null,
  msku text not null,
  disposition text not null,
  ending_warehouse_balance integer not null,
  created_at timestamptz not null default now()
);
create index if not exists barm_fba_stock_msku_idx on public.barm_fba_stock (msku);

-- Raw booked/picked-up/active rows from the "FBA & FBF Details-Updated"
-- workbook (SOP Section C / skill Section C). Ingested as a per-source_month
-- replace: each upload deletes only the source_months it covers, then
-- inserts fresh rows for those months — older months are left untouched, so
-- "active" naturally accumulates across the trailing 3-month window the
-- report reads (see the design doc's Simplifications section).
create table if not exists public.barm_fba_status_events (
  id bigint generated by default as identity primary key,
  source_month text not null, -- 'YYYY-MM'
  product text not null,
  sku text not null,
  quantity integer not null,
  fc text not null,
  status_raw text not null,
  status_category text not null check (status_category in ('booked', 'picked_up', 'active')),
  created_at timestamptz not null default now()
);
create index if not exists barm_fba_status_events_month_idx on public.barm_fba_status_events (source_month);
create index if not exists barm_fba_status_events_sku_idx on public.barm_fba_status_events (sku);

-- Manual per-(SKU, zone) shipment/send-limit number — column X in the user's
-- original "FBA analysis" sheet, the one non-formula input column. Ops
-- judgment, never computed; edited directly in the FBA upload tab.
create table if not exists public.barm_fba_shipment_caps (
  sku text not null,
  zone text not null,
  cap_quantity integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (sku, zone)
);

-- One row per generated report (report_date = the date it was generated,
-- not a data window — this report has no per-date data scope). result_json
-- mirrors FbaForecastReportResult minus its non-serializable `wb` field. The
-- actual .xlsx lives in Supabase Storage (xlsx_storage_path), not inline.
create table if not exists public.fba_forecast_reports (
  id bigint generated by default as identity primary key,
  report_date date not null,
  job_id bigint references public.report_generation_jobs(id),
  result_json jsonb not null,
  xlsx_storage_path text,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (report_date)
);

-- Same RLS-disabled + anon-full-grant pattern every other table in this app
-- uses (see scripts/fix_rls_all_tables.sql) — the app has no auth session
-- and talks to Supabase entirely with the anon key.
alter table public.barm_fba_sales_30d disable row level security;
grant select, insert, update, delete on public.barm_fba_sales_30d to anon;
alter table public.barm_fba_stock disable row level security;
grant select, insert, update, delete on public.barm_fba_stock to anon;
alter table public.barm_fba_status_events disable row level security;
grant select, insert, update, delete on public.barm_fba_status_events to anon;
alter table public.barm_fba_shipment_caps disable row level security;
grant select, insert, update, delete on public.barm_fba_shipment_caps to anon;
alter table public.fba_forecast_reports disable row level security;
grant select, insert, update, delete on public.fba_forecast_reports to anon;

-- Private bucket for the generated .xlsx workbooks — same pattern as
-- scripts/daily_ad_spend_reports_table.sql's "ad-spend-reports" bucket.
insert into storage.buckets (id, name, public)
values ('fba-forecast-reports', 'fba-forecast-reports', false)
on conflict (id) do nothing;

drop policy if exists "fba-forecast-reports anon read" on storage.objects;
create policy "fba-forecast-reports anon read"
  on storage.objects for select
  using (bucket_id = 'fba-forecast-reports');

drop policy if exists "fba-forecast-reports anon write" on storage.objects;
create policy "fba-forecast-reports anon write"
  on storage.objects for insert
  with check (bucket_id = 'fba-forecast-reports');

drop policy if exists "fba-forecast-reports anon update" on storage.objects;
create policy "fba-forecast-reports anon update"
  on storage.objects for update
  using (bucket_id = 'fba-forecast-reports');
```

- [ ] **Step 2: Run it in the Supabase SQL Editor**

Paste the file into the project's Supabase SQL Editor and run it (same manual
step as every other `scripts/*.sql` file in this repo — there is no
migration runner). Confirm success with:

```sql
select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('barm_fba_sales_30d', 'barm_fba_stock', 'barm_fba_status_events', 'barm_fba_shipment_caps', 'fba_forecast_reports');
```

Expected: all 5 table names returned.

- [ ] **Step 3: Commit**

```bash
git add scripts/fba_forecast_tables.sql
git commit -m "Add FBA Forecast Report Supabase tables"
```

---

## Task 2: Zone-mapping module (Edge Function side)

**Files:**
- Create: `supabase/functions/_shared/fbaZones.ts`
- Test: `supabase/functions/_shared/fbaZones.test.ts`

**Interfaces:**
- Produces: `shipStateToZone(state: string): string`, `fcToZone(fc: string): string` — both pure, no I/O. Consumed by Task 5 (`fbaForecastReportExport.ts`).

- [ ] **Step 1: Write the failing tests**

```ts
// supabase/functions/_shared/fbaZones.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/testing/asserts.ts";
import { shipStateToZone, fcToZone } from "./fbaZones.ts";

Deno.test("shipStateToZone matches known states case/whitespace-insensitively", () => {
  assertEquals(shipStateToZone("Maharashtra"), "Maharashtra_zone");
  assertEquals(shipStateToZone("  tn "), "Tamilnadu_zone");
  assertEquals(shipStateToZone("KARNATAKA"), "Karnataka_zone");
  assertEquals(shipStateToZone("Chhattisgarh"), "Nagpur_zone");
  assertEquals(shipStateToZone("Jammu & Kashmir"), "Punjab_zone");
});

Deno.test("shipStateToZone falls back to Unknown for an unrecognized state", () => {
  assertEquals(shipStateToZone("Atlantis"), "Unknown");
  assertEquals(shipStateToZone(""), "Unknown");
});

Deno.test("fcToZone matches known fulfillment-center codes", () => {
  assertEquals(fcToZone("BLR"), "Karnataka_zone");
  assertEquals(fcToZone("hyd3"), "Telangana_zone");
  assertEquals(fcToZone("BOM7"), "Maharashtra_zone");
  assertEquals(fcToZone("PAX"), "bihar_zone");
});

Deno.test("fcToZone falls back to VSNC for an unrecognized code", () => {
  assertEquals(fcToZone("ZZZ9"), "VSNC");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `deno test supabase/functions/_shared/fbaZones.test.ts`
Expected: FAIL — `fbaZones.ts` does not exist yet.

- [ ] **Step 3: Write the implementation**

```ts
// supabase/functions/_shared/fbaZones.ts
// Zone-mapping lookups reverse-engineered from the live formulas in the
// user's real "FBA_forecast sheet(30 days).xlsx": ship-state -> zone (from
// 30_days_sales!G2's nested IF formula) and FC -> zone (from the
// barm-fba-forecast-refresh skill, matching FBA_stock!H2's IFS formula).
// Two independent mappings because sales rows carry a ship-state and
// stock/booked/intransit/active rows carry a fulfillment-center code
// instead. See docs/superpowers/specs/2026-09-22-fba-forecast-refresh-
// design.md for the full source tables.

const SHIP_STATE_ZONES: Array<{ zone: string; states: string[] }> = [
  { zone: "Tamilnadu_zone", states: ["TAMILNADU", "TAMIL NADU", "TN", "PALGHAT", "ANDAMAN & NICOBAR ISLANDS", "ANDAMAN ISLANDS", "AN", "PUDUCHERRY"] },
  { zone: "Karnataka_zone", states: ["KARNATAKA", "KA", "GOA", "GA", "LAKSHWADEEP", "LAKSHADWEEP", "KERALA", "KL"] },
  { zone: "Telangana_zone", states: ["TELANGANA", "TELENGANA", "TG", "ANDHRA PRADESH", "ANDHRAPRADESH", "AP", "ANDHARA PRADESH"] },
  { zone: "Maharashtra_zone", states: ["MAHARASHTRA", "MAHARASTRA", "MH", "DADRA AND NAGAR HAVELI AND DAMAN AND DIU", "DAMAN & DIU", "DADRA AND NAGAR HAVELI"] },
  { zone: "gujarat_zone", states: ["GUJARAT", "GUJRAT", "GJ"] },
  { zone: "Nagpur_zone", states: ["MADHYA PRADESH", "MADHYAPRADESH", "MP", "CHHATTISGARH", "CHATTISGARH", "CG"] },
  { zone: "Rajasthan_zone", states: ["RAJASTHAN", "RJ"] },
  { zone: "Uttarpradesh_zone", states: ["UTTAR PRADESH", "UTTARPRADESH", "UTARPRADESH", "UP"] },
  { zone: "bihar_zone", states: ["BIHAR", "BR", "JHARKHAND", "JH"] },
  { zone: "Delhi_zone", states: ["DELHI", "NEW DELHI", "DL", "UTTARAKHAND", "UK", "UTTRAKHAND", "HARYANA", "HARAYANA", "HR"] },
  { zone: "WestBengal_zone", states: ["WEST BENGAL", "WESTBENGAL", "WB"] },
  { zone: "Odisha_zone", states: ["ODISHA", "ORISSA", "OR"] },
  { zone: "Assam_zone", states: ["ASSAM", "AS", "ARUNACHAL PRADESH", "AR", "MANIPUR", "MN", "MEGHALAYA", "ML", "MIZORAM", "MZ", "NAGALAND", "NL", "SIKKIM", "SK", "TRIPURA", "TR"] },
  { zone: "Punjab_zone", states: ["PUNJAB", "PB", "HIMACHAL PRADESH", "HIMACHALPRADESH", "HP", "JAMMU & KASHMIR", "JAMMU AND KASHMIR", "JAMMU KASHMIR", "JK", "LADAKH", "LA", "CHANDIGARH"] },
];

/** Ship-state (e.g. "Maharashtra", "TN") -> zone. Matches the exact
 *  nested-IF formula in the user's live 30_days_sales!G column: upper-cased
 *  and trimmed before matching. Returns "Unknown" for anything unrecognized,
 *  same as the formula's final else-branch. */
export function shipStateToZone(state: string): string {
  const normalized = state.trim().toUpperCase();
  for (const { zone, states } of SHIP_STATE_ZONES) {
    if (states.includes(normalized)) return zone;
  }
  return "Unknown";
}

const FC_ZONES: Array<{ zone: string; codes: string[] }> = [
  { zone: "Karnataka_zone", codes: ["BLR"] },
  { zone: "WestBengal_zone", codes: ["CCX"] },
  { zone: "Assam_zone", codes: ["GAX"] },
  { zone: "Tamilnadu_zone", codes: ["CJB1", "MAA4"] },
  { zone: "Delhi_zone", codes: ["DED", "DEL"] },
  { zone: "Rajasthan_zone", codes: ["JPX"] },
  { zone: "Maharashtra_zone", codes: ["BOM5", "BOM7", "ISK3", "PNQ3"] },
  { zone: "Uttarpradesh_zone", codes: ["LKO1"] },
  { zone: "Nagpur_zone", codes: ["NAX1"] },
  { zone: "Telangana_zone", codes: ["HYD3", "HYD8"] },
  { zone: "Punjab_zone", codes: ["ATX1", "LDX1"] },
  { zone: "Odisha_zone", codes: ["BBX"] },
  { zone: "bihar_zone", codes: ["PAX"] },
  { zone: "gujarat_zone", codes: ["AMD"] },
];

/** Fulfillment-center code (e.g. "BLR", "HYD3") -> zone. Matches the
 *  FC->zone IFS formula documented in the barm-fba-forecast-refresh skill
 *  (the same formula the live FBA_stock!H column and the booked/intranit/
 *  recently_act "zone" columns all use). The literal fallback for an
 *  unrecognized code is "VSNC" — that IS the formula's own final
 *  else-branch output, not a typo; it's unrelated to the separate SOP rule
 *  (applied at ingestion, not here — see Task 5) that drops stock rows
 *  where the FC *itself* is literally "VSNC". */
export function fcToZone(fc: string): string {
  const normalized = fc.trim().toUpperCase();
  for (const { zone, codes } of FC_ZONES) {
    if (codes.includes(normalized)) return zone;
  }
  return "VSNC";
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `deno test supabase/functions/_shared/fbaZones.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/fbaZones.ts supabase/functions/_shared/fbaZones.test.ts
git commit -m "Add FBA ship-state and fulfillment-center zone mapping"
```

---

## Task 3: Calculation engine (Edge Function side)

> **SUPERSEDED — shipment caps removed (later user decision).** There is
> no manual shipment-cap input anywhere in this feature. `computeFbaAnalysis`
> takes `(salesRows, stockRows, statusRows, resolveProductName)` — no
> `shipmentCaps` parameter, no `ShipmentCap` type, no `shipmentCapZone`
> field on `FbaAnalysisRow`. The two formulas that used to divide by a
> manual cap are now direct pass-throughs of values the engine already
> computes:
> - `toBeSentZone = stockNeededAfterInboundZone` (that row's own already-
>   computed need, un-ratio'd against any cap).
> - `stockToBeOrderedZone = totalStockNeededAfterInboundSku` (the SKU-level
>   total already-computed need).
>
> Everything upstream (30-day sales → 120-day forecast → zones → current
> stock → booked/intransit → stock-needed-after-inbound → days-until-
> stockout) is exactly as this task originally specified — unchanged.

**Files:**
- Create: `supabase/functions/_shared/fbaForecastCalc.ts`
- Test: `supabase/functions/_shared/fbaForecastCalc.test.ts`

**Interfaces:**
- Consumes: nothing (pure, takes plain arrays).
- Produces: `computeFbaAnalysis(salesRows, stockRows, statusRows, shipmentCaps, resolveProductName): FbaAnalysisRow[]`, and the types `SalesRow`, `StockRow`, `StatusRow`, `StatusCategory`, `ShipmentCap`, `FbaAnalysisRow`. Consumed by Task 5 (`fbaForecastReportExport.ts`), which supplies already-zoned rows (zone assignment is Task 2's job, not this file's).

- [ ] **Step 1: Write the failing tests**

```ts
// supabase/functions/_shared/fbaForecastCalc.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/testing/asserts.ts";
import { computeFbaAnalysis, type SalesRow, type StockRow, type StatusRow, type ShipmentCap } from "./fbaForecastCalc.ts";

// Two SKUs ("A", "B") sharing one product name ("Widget"), across two zones
// (Z1, Z2) — enough to exercise every column's formula, including the SKU-
// level rollups and the cross-SKU max-forecast-per-product dedup. Expected
// values hand-computed against the exact formulas in docs/superpowers/
// specs/2026-09-22-fba-forecast-refresh-design.md.
const names: Record<string, string> = { A: "Widget", B: "Widget" };
const resolveProductName = (sku: string) => names[sku] || sku;

const salesRows: SalesRow[] = [
  { sku: "A", zone: "Z1", quantity: 60 },
  { sku: "A", zone: "Z2", quantity: 30 },
  { sku: "B", zone: "Z1", quantity: 150 },
];
const stockRows: StockRow[] = [
  { sku: "A", zone: "Z1", quantity: 50 },
  { sku: "A", zone: "Z2", quantity: 10 },
  { sku: "B", zone: "Z1", quantity: 20 },
];
const statusRows: StatusRow[] = [
  { sku: "A", zone: "Z1", quantity: 5, category: "booked" },
  { sku: "A", zone: "Z1", quantity: 5, category: "picked_up" },
  { sku: "A", zone: "Z2", quantity: 2, category: "picked_up" },
  { sku: "B", zone: "Z1", quantity: 40, category: "active" },
];
const shipmentCaps: ShipmentCap[] = [
  { sku: "A", zone: "Z1", capQuantity: 100 },
  { sku: "A", zone: "Z2", capQuantity: 20 },
  { sku: "B", zone: "Z1", capQuantity: 50 },
];

function rowFor(rows: ReturnType<typeof computeFbaAnalysis>, sku: string, zone: string) {
  const row = rows.find((r) => r.sku === sku && r.zone === zone);
  if (!row) throw new Error(`no row for ${sku}/${zone}`);
  return row;
}

Deno.test("computeFbaAnalysis: per-zone forecast/stock/inbound math", () => {
  const rows = computeFbaAnalysis(salesRows, stockRows, statusRows, shipmentCaps, resolveProductName);
  const az1 = rowFor(rows, "A", "Z1");
  assertEquals(az1.sales30d, 60);
  assertEquals(az1.dailyRate, 2);
  assertEquals(az1.forecast120dZone, 240);
  assertEquals(az1.currentStockZone, 50);
  assertEquals(az1.bookedZone, 5);
  assertEquals(az1.intransitZone, 5);
  assertEquals(az1.stockNeededZone, 190);
  assertEquals(az1.stockNeededAfterInboundZone, 180);
  assertEquals(az1.daysUntilStockout, 30);

  const az2 = rowFor(rows, "A", "Z2");
  assertEquals(az2.forecast120dZone, 120);
  assertEquals(az2.stockNeededAfterInboundZone, 108);
  assertEquals(az2.daysUntilStockout, 12);
});

Deno.test("computeFbaAnalysis: SKU-level rollups sum across that SKU's zones", () => {
  const rows = computeFbaAnalysis(salesRows, stockRows, statusRows, shipmentCaps, resolveProductName);
  const az1 = rowFor(rows, "A", "Z1");
  const az2 = rowFor(rows, "A", "Z2");
  assertEquals(az1.totalOrders30dSku, 90);
  assertEquals(az1.totalForecast120dSku, 360);
  assertEquals(az1.totalStockSku, 60);
  assertEquals(az1.totalStockNeededAfterInboundSku, 288);
  // Same SKU-level total on every one of that SKU's zone rows.
  assertEquals(az2.totalStockNeededAfterInboundSku, 288);
});

Deno.test("computeFbaAnalysis: max-forecast-per-product dedups SKUs sharing a product name", () => {
  const rows = computeFbaAnalysis(salesRows, stockRows, statusRows, shipmentCaps, resolveProductName);
  // SKU B's own 120-day forecast (600) exceeds SKU A's (360) — both SKUs'
  // rows report B's larger figure since they share the "Widget" product name.
  assertEquals(rowFor(rows, "A", "Z1").maxForecastPerProduct, 600);
  assertEquals(rowFor(rows, "B", "Z1").maxForecastPerProduct, 600);
});

Deno.test("computeFbaAnalysis: shipment cap drives to-be-sent and stock-to-be-ordered", () => {
  const rows = computeFbaAnalysis(salesRows, stockRows, statusRows, shipmentCaps, resolveProductName);
  const az1 = rowFor(rows, "A", "Z1");
  const az2 = rowFor(rows, "A", "Z2");
  const bz1 = rowFor(rows, "B", "Z1");
  assertEquals(az1.toBeSentZone, 63);
  assertEquals(az1.stockToBeOrderedZone, 188);
  assertEquals(az2.toBeSentZone, 8);
  assertEquals(az2.stockToBeOrderedZone, 268);
  assertEquals(bz1.toBeSentZone, 50);
  assertEquals(bz1.stockToBeOrderedZone, 530);
});

Deno.test("computeFbaAnalysis: active quantity accumulates per (sku, zone), independent of booked/intransit", () => {
  const rows = computeFbaAnalysis(salesRows, stockRows, statusRows, shipmentCaps, resolveProductName);
  assertEquals(rowFor(rows, "B", "Z1").activeZoneAccumulated, 40);
  assertEquals(rowFor(rows, "A", "Z1").activeZoneAccumulated, 0);
});

Deno.test("computeFbaAnalysis: sales-% region is this zone's share of the SKU's total forecast", () => {
  const rows = computeFbaAnalysis(salesRows, stockRows, statusRows, shipmentCaps, resolveProductName);
  assertEquals(rowFor(rows, "A", "Z1").salesPctRegion, 240 / 360);
  assertEquals(rowFor(rows, "B", "Z1").salesPctRegion, 1);
});

Deno.test("computeFbaAnalysis: zero 30-day sales floors the forecast at 5 and blanks days-until-stockout", () => {
  const rows = computeFbaAnalysis(
    [], // no sales rows at all for C — absence, not a quantity:0 row
    [{ sku: "C", zone: "Z1", quantity: 9 }],
    [],
    [],
    () => "Zero Sales Product"
  );
  const c = rowFor(rows, "C", "Z1");
  assertEquals(c.forecast120dZone, 5);
  assertEquals(c.daysUntilStockout, "--");
});

Deno.test("computeFbaAnalysis: a (sku, zone) with no shipment cap configured defaults to 0, not an error", () => {
  const rows = computeFbaAnalysis(
    [{ sku: "D", zone: "Z1", quantity: 30 }],
    [{ sku: "D", zone: "Z1", quantity: 0 }],
    [],
    [], // no cap row for D/Z1
    () => "No Cap Product"
  );
  const d = rowFor(rows, "D", "Z1");
  assertEquals(d.shipmentCapZone, 0);
  assertEquals(d.toBeSentZone, 0);
  assertEquals(d.stockToBeOrderedZone, d.totalStockNeededAfterInboundSku);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `deno test supabase/functions/_shared/fbaForecastCalc.test.ts`
Expected: FAIL — `fbaForecastCalc.ts` does not exist yet.

- [ ] **Step 3: Write the implementation**

```ts
// supabase/functions/_shared/fbaForecastCalc.ts
// Pure calculation engine for the FBA Analysis report — no I/O, no
// Supabase, no XLSX. Takes already-zoned rows (zone assignment is
// fbaZones.ts's job) and a product-name resolver, and reproduces every
// formula from the user's real "FBA analysis" sheet (see docs/superpowers/
// specs/2026-09-22-fba-forecast-refresh-design.md for the column-by-column
// derivation). Grain: one output row per (sku, zone).

export interface SalesRow { sku: string; zone: string; quantity: number; }
export interface StockRow { sku: string; zone: string; quantity: number; }
export type StatusCategory = "booked" | "picked_up" | "active";
export interface StatusRow { sku: string; zone: string; quantity: number; category: StatusCategory; }
export interface ShipmentCap { sku: string; zone: string; capQuantity: number; }

export interface FbaAnalysisRow {
  sku: string;
  zone: string;
  productName: string;
  sales30d: number;
  dailyRate: number;
  forecast120dZone: number;
  totalOrders30dSku: number;
  totalForecast120dSku: number;
  maxForecastPerProduct: number;
  minStockNeededZone: number;
  salesPctRegion: number | "NO SALES";
  currentStockZone: number;
  totalStockSku: number;
  stockNeededZone: number;
  bookedZone: number;
  intransitZone: number;
  bookedPlusIntransitZone: number;
  stockNeededAfterInboundZone: number;
  totalStockNeededAfterInboundSku: number;
  activeZoneAccumulated: number;
  shipmentCapZone: number;
  toBeSentZone: number;
  stockToBeOrderedZone: number;
  daysUntilStockout: number | "--";
}

function sumBy<T>(rows: T[], keyOf: (r: T) => string, valueOf: (r: T) => number): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const key = keyOf(r);
    out.set(key, (out.get(key) || 0) + valueOf(r));
  }
  return out;
}

const rowKey = (sku: string, zone: string) => `${sku} ${zone}`;

export function computeFbaAnalysis(
  salesRows: SalesRow[],
  stockRows: StockRow[],
  statusRows: StatusRow[],
  shipmentCaps: ShipmentCap[],
  resolveProductName: (sku: string) => string
): FbaAnalysisRow[] {
  const salesByKey = sumBy(salesRows, (r) => rowKey(r.sku, r.zone), (r) => r.quantity);
  const stockByKey = sumBy(stockRows, (r) => rowKey(r.sku, r.zone), (r) => r.quantity);
  const bookedByKey = sumBy(statusRows.filter((r) => r.category === "booked"), (r) => rowKey(r.sku, r.zone), (r) => r.quantity);
  const intransitByKey = sumBy(statusRows.filter((r) => r.category === "picked_up"), (r) => rowKey(r.sku, r.zone), (r) => r.quantity);
  const activeByKey = sumBy(statusRows.filter((r) => r.category === "active"), (r) => rowKey(r.sku, r.zone), (r) => r.quantity);
  const capByKey = new Map(shipmentCaps.map((c) => [rowKey(c.sku, c.zone), c.capQuantity]));

  // Every (sku, zone) pair that appears in ANY of the three quantity-bearing
  // inputs is a row — a SKU can have stock/booked/intransit in a zone with
  // zero sales, or sales in a zone with zero stock, and both must still
  // appear (this exactly matches PIVOT_30/PIVOT_fba/etc. each being keyed
  // off the union of "id + zone" values encountered anywhere in the sheet).
  const allKeys = new Set<string>([...salesByKey.keys(), ...stockByKey.keys(), ...bookedByKey.keys(), ...intransitByKey.keys(), ...activeByKey.keys()]);

  interface Zoned { sku: string; zone: string; sales30d: number; forecast120dZone: number; currentStockZone: number; bookedZone: number; intransitZone: number; }
  const zoned: Zoned[] = [];
  for (const key of allKeys) {
    const [sku, zone] = key.split(" ");
    const sales30d = salesByKey.get(key) || 0;
    const dailyRate = sales30d / 30;
    const forecast120dZone = sales30d === 0 ? 5 : dailyRate * 120;
    zoned.push({
      sku, zone, sales30d,
      forecast120dZone,
      currentStockZone: stockByKey.get(key) || 0,
      bookedZone: bookedByKey.get(key) || 0,
      intransitZone: intransitByKey.get(key) || 0,
    });
  }

  // SKU-level rollups (sum across every zone that SKU appears in).
  const skuTotalOrders30d = sumBy(zoned, (r) => r.sku, (r) => r.sales30d);
  const skuTotalForecast120d = sumBy(zoned, (r) => r.sku, (r) => r.forecast120dZone);
  const skuTotalStock = sumBy(zoned, (r) => r.sku, (r) => r.currentStockZone);

  // "Stock needed after inbound" is computed per zone first (it depends on
  // that zone's own forecast/stock/booked/intransit), THEN rolled up per
  // SKU for the shipment-cap ratio below — matches the original sheet's own
  // V formula, which sums the U column (not R).
  const stockNeededAfterInboundZone = new Map<string, number>();
  for (const r of zoned) {
    const stockNeededZone = r.forecast120dZone - r.currentStockZone;
    const afterInbound = Math.max(0, stockNeededZone - (r.bookedZone + r.intransitZone));
    stockNeededAfterInboundZone.set(rowKey(r.sku, r.zone), afterInbound);
  }
  const skuTotalStockNeededAfterInbound = new Map<string, number>();
  for (const r of zoned) {
    const key = rowKey(r.sku, r.zone);
    const v = stockNeededAfterInboundZone.get(key) || 0;
    skuTotalStockNeededAfterInbound.set(r.sku, (skuTotalStockNeededAfterInbound.get(r.sku) || 0) + v);
  }

  // "Max forecast per product name" dedups multiple SKU codes mapped to the
  // same physical product by taking the larger of their SKU-level forecasts.
  const productNameBySku = new Map<string, string>();
  const maxForecastByProduct = new Map<string, number>();
  for (const sku of skuTotalForecast120d.keys()) {
    const name = resolveProductName(sku);
    productNameBySku.set(sku, name);
    const forecast = skuTotalForecast120d.get(sku) || 0;
    maxForecastByProduct.set(name, Math.max(maxForecastByProduct.get(name) || 0, forecast));
  }

  const out: FbaAnalysisRow[] = [];
  for (const r of zoned) {
    const key = rowKey(r.sku, r.zone);
    const totalOrders30dSku = skuTotalOrders30d.get(r.sku) || 0;
    const totalForecast120dSku = skuTotalForecast120d.get(r.sku) || 0;
    const totalStockSku = skuTotalStock.get(r.sku) || 0;
    const totalStockNeededAfterInboundSku = skuTotalStockNeededAfterInbound.get(r.sku) || 0;
    const stockNeededZone = r.forecast120dZone - r.currentStockZone;
    const stockNeededAfterInbound = stockNeededAfterInboundZone.get(key) || 0;
    const shipmentCapZone = capByKey.get(key) || 0;
    const toBeSentZone = totalStockNeededAfterInboundSku === 0
      ? 0
      : Math.round(Math.min((stockNeededAfterInbound / totalStockNeededAfterInboundSku) * shipmentCapZone, stockNeededAfterInbound));
    const daysUntilStockout: number | "--" = r.sales30d === 0
      ? "--"
      : Math.round((r.currentStockZone + r.bookedZone + r.intransitZone) / (r.sales30d / 30));

    out.push({
      sku: r.sku,
      zone: r.zone,
      productName: productNameBySku.get(r.sku) || r.sku,
      sales30d: r.sales30d,
      dailyRate: r.sales30d / 30,
      forecast120dZone: r.forecast120dZone,
      totalOrders30dSku,
      totalForecast120dSku,
      maxForecastPerProduct: maxForecastByProduct.get(productNameBySku.get(r.sku) || r.sku) || 0,
      minStockNeededZone: r.forecast120dZone,
      salesPctRegion: r.forecast120dZone === 0 ? "NO SALES" : r.forecast120dZone / totalForecast120dSku,
      currentStockZone: r.currentStockZone,
      totalStockSku,
      stockNeededZone,
      bookedZone: r.bookedZone,
      intransitZone: r.intransitZone,
      bookedPlusIntransitZone: r.bookedZone + r.intransitZone,
      stockNeededAfterInboundZone: stockNeededAfterInbound,
      totalStockNeededAfterInboundSku,
      activeZoneAccumulated: activeByKey.get(key) || 0,
      shipmentCapZone,
      toBeSentZone,
      stockToBeOrderedZone: totalStockNeededAfterInboundSku - shipmentCapZone,
      daysUntilStockout,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `deno test supabase/functions/_shared/fbaForecastCalc.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/fbaForecastCalc.ts supabase/functions/_shared/fbaForecastCalc.test.ts
git commit -m "Add FBA forecast calculation engine"
```

---

## Task 4: Upload parsing/classification rules (client side, pure)

> **SUPERSEDED — as actually built:** `src/lib/fbaForecastRules.ts` has a
> substantially larger surface than the code block below, all still pure/
> dependency-free and covered by `node:test`. Beyond `classifyStatus`,
> `parseMonthSheetName`, `detectMonthSheets`, `parseMonthSheetGrid`, it also
> has:
> - `dedupeByIdentityKey<T>(rows, keyOf)` + `fbfIdentityKey(r)` — the
>   `(sku, fc, quantity, booked_date, pickup_date)` de-dupe key applied to
>   booked/intransit/active rows combined across the 3 month sheets (a
>   shipment left unresolved gets re-listed unchanged in the next month's
>   sheet; this collapses that re-listing). Documented, accepted
>   limitation: two genuinely distinct shipments sharing sku+fc+quantity
>   with both dates blank do collapse into one row — there's no better key
>   in the source data.
> - `cleanDailySalesRow(row, reportDate)` / `cleanStockSnapshotRow(row,
>   anchorDate)` — return `{ keep, reason? }` so the caller can tally a
>   rejection-reason breakdown for `upload_history.rejection_reasons`
>   (reasons: `s_prefix_order` / `today_order` / `outside_window` /
>   `cancelled` / `merchant` for daily sales; `older_stock_date` / `vsnc` /
>   `non_sellable` for stock).
> - `isWithinTrailingWindow(dateIso, reportDate, days)` — enforces a
>   genuine trailing 30-day sales window ending at `reportDate` (not just
>   whatever date range the uploaded file happens to contain).
> - `selectStockSnapshotDate(dates, reportDate)` — picks the LATEST date on
>   file that is `<=` `reportDate`, never blindly the file's max date.
> - `parseUsSlashDate(raw)` — the FBA stock report's "Date" column is
>   `MM/DD/YYYY` (confirmed against the real `172544020718.csv`), distinct
>   from `normalizeSheetDate` (private helper) which reads the FBA & FBF
>   Details workbook's Booked/Pickup date columns as `DD/MM/YYYY`.
>
> **Every date-anchored function takes an explicit `reportDate: string`
> parameter — none of them read the real clock.** `reportDate` must always
> be the dashboard's own selected date, threaded in from
> `src/app/dashboard/fba/page.tsx`'s `useDashboard().endDate`.

**Files:**
- Create: `src/lib/fbaForecastRules.ts`
- Test: `src/lib/fbaForecastRules.test.ts`

**Interfaces:**
- Produces: `classifyStatus(rawStatus: string): StatusCategory | null`, `parseMonthSheetName(name: string): { year: number; month: number } | null`, `detectMonthSheets(sheetNames: string[], asOf?: Date): MonthSheet[]`, `parseMonthSheetGrid(grid: unknown[][]): FbfRawRow[]`, and types `StatusCategory`, `MonthSheet`, `FbfRawRow`. Consumed by Task 5 (`fbaForecastUpload.ts`).
- No `@/lib/...` or package imports in this file — must stay resolvable by plain `node --test` on a relative path, same as `mergeByConflictKey.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/fbaForecastRules.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { classifyStatus, parseMonthSheetName, detectMonthSheets, parseMonthSheetGrid } from "./fbaForecastRules.ts";

test("classifyStatus maps the three routed statuses, case/whitespace-insensitively", () => {
  assert.equal(classifyStatus("Booked"), "booked");
  assert.equal(classifyStatus(" picked up "), "picked_up");
  assert.equal(classifyStatus("ACTIVE"), "active");
});

test("classifyStatus excludes anything else", () => {
  assert.equal(classifyStatus("cancelled before 24hrs of pickup"), null);
  assert.equal(classifyStatus("Didn't send to FBA"), null);
  assert.equal(classifyStatus(""), null);
});

test("parseMonthSheetName reads a 2-digit-year sheet name", () => {
  assert.deepEqual(parseMonthSheetName("FBA SEPT26"), { year: 2026, month: 9 });
  assert.deepEqual(parseMonthSheetName("FBA JUL26"), { year: 2026, month: 7 });
});

test("parseMonthSheetName returns null for a sheet name with no year suffix", () => {
  assert.equal(parseMonthSheetName("FBA JULY"), null);
});

test("detectMonthSheets picks the current month plus the previous 2, ignoring non-month sheets", () => {
  const sheetNames = ["FBA SKU IDs", "FBA MAY26", "FBA JUN26", "FBA JUL26", "FBA AUG26", "FBA SEPT26", "Pivot Table 1"];
  const asOf = new Date("2026-09-22T00:00:00Z");
  const result = detectMonthSheets(sheetNames, asOf);
  assert.deepEqual(result.map((r) => r.sourceMonth), ["2026-09", "2026-08", "2026-07"]);
});

test("detectMonthSheets excludes sheets dated after asOf", () => {
  const sheetNames = ["FBA AUG26", "FBA SEPT26", "FBA OCT26"];
  const asOf = new Date("2026-09-22T00:00:00Z");
  const result = detectMonthSheets(sheetNames, asOf);
  assert.deepEqual(result.map((r) => r.sourceMonth), ["2026-09", "2026-08"]);
});

test("parseMonthSheetGrid locates columns by header name and takes only the first STATUS column", () => {
  const grid = [
    ["Product", "SKU ID", "Initial booked quantity", "Final shipped quantity", "FC", "Booked date", "Pickup Date", "ATS/NON-ATS", "MRP", "FNSKU IDS", "BOX", "ASIN", "STATUS", "COMMENTS", "STATUS", "FBA Tracking Number"],
    ["Widget", "SKU-1", 10, 8, "BLR", "01/09/2026", "", "ATS", 199, "X1", "B1", "A1", "Booked", "", "FBA STA (01/09/2026 06:16)-LKO1", "TRK1"],
  ];
  const rows = parseMonthSheetGrid(grid);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sku, "SKU-1");
  assert.equal(rows[0].quantity, 8);
  assert.equal(rows[0].fc, "BLR");
  assert.equal(rows[0].statusRaw, "Booked"); // not the tracking-blob second STATUS column
});

test("parseMonthSheetGrid throws when a required column is missing", () => {
  const grid = [["Product", "SKU ID"], ["Widget", "SKU-1"]];
  assert.throws(() => parseMonthSheetGrid(grid));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test src/lib/fbaForecastRules.test.ts`
Expected: FAIL — `fbaForecastRules.ts` does not exist yet.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/fbaForecastRules.ts
// Pure parsing/classification rules for the FBA Forecast Report feature —
// no Supabase, no XLSX/Papaparse imports — so these can be unit tested
// directly (see fbaForecastRules.test.ts) the same way mergeByConflictKey.ts
// is. The I/O-heavy upload functions in fbaForecastUpload.ts import these.

export type StatusCategory = "booked" | "picked_up" | "active";

/** Classifies the FBA & FBF Details workbook's first "STATUS" column value
 *  (case-insensitive, trimmed) per the barm-fba-forecast-refresh skill's
 *  routing rule. Anything not one of these three exact values (e.g.
 *  "cancelled before 24hrs of pickup", "Didn't send to FBA") is excluded
 *  from the report entirely — return null, don't guess. */
export function classifyStatus(rawStatus: string): StatusCategory | null {
  switch (rawStatus.trim().toLowerCase()) {
    case "booked": return "booked";
    case "picked up": return "picked_up";
    case "active": return "active";
    default: return null;
  }
}

const MONTH_ALIASES: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, APRIL: 4, MAY: 5, JUN: 6, JUNE: 6,
  JUL: 7, JULY: 7, AUG: 8, SEP: 9, SEPT: 9, SEPTEMBER: 9, OCT: 10, NOV: 11, DEC: 12,
};

/** Parses a "FBA <MONTHNAME><YY>" sheet name (e.g. "FBA SEPT26") into a
 *  comparable (year, month). Sheets with no 2-digit year suffix — an older
 *  naming convention this workbook used before the "YY" suffix started —
 *  can't be reliably dated and return null rather than being guessed at. */
export function parseMonthSheetName(name: string): { year: number; month: number } | null {
  const m = name.trim().toUpperCase().match(/^FBA\s+([A-Z]+)(\d{2})$/);
  if (!m) return null;
  const month = MONTH_ALIASES[m[1]];
  if (!month) return null;
  return { year: 2000 + parseInt(m[2], 10), month };
}

export interface MonthSheet { sheetName: string; sourceMonth: string; year: number; month: number; }

/** Picks the current calendar month's sheet plus the previous 2 (by name),
 *  matching the SOP's "current month + previous 2 months only" rule.
 *  `asOf` defaults to real "today" in production, passed explicitly in
 *  tests. Sheets dated after `asOf` (shouldn't normally occur, but a
 *  workbook could contain a stray future-dated sheet) are excluded. */
export function detectMonthSheets(sheetNames: string[], asOf: Date = new Date()): MonthSheet[] {
  const parsed = sheetNames
    .map((sheetName) => ({ sheetName, parsed: parseMonthSheetName(sheetName) }))
    .filter((s): s is { sheetName: string; parsed: { year: number; month: number } } => s.parsed !== null);

  const currentKey = asOf.getUTCFullYear() * 12 + (asOf.getUTCMonth() + 1);
  return parsed
    .map((s) => ({ ...s, key: s.parsed.year * 12 + s.parsed.month }))
    .filter((s) => s.key <= currentKey)
    .sort((a, b) => b.key - a.key)
    .slice(0, 3)
    .map((s) => ({
      sheetName: s.sheetName,
      sourceMonth: `${s.parsed.year}-${String(s.parsed.month).padStart(2, "0")}`,
      year: s.parsed.year,
      month: s.parsed.month,
    }));
}

export interface FbfRawRow { product: string; sku: string; quantity: number; fc: string; statusRaw: string; }

/** Maps a "FBA & FBF Details-Updated" month sheet's raw grid (row 0 =
 *  headers, as produced by `XLSX.utils.sheet_to_json(ws, { header: 1 })`)
 *  into rows, locating every column BY HEADER NAME rather than a fixed
 *  letter — the skill warns the "ATS/NON-ATS" column shifts every later
 *  column by one position on sheets that have it. `headers.indexOf
 *  ("STATUS")` deliberately finds only the FIRST "STATUS" column — every
 *  month sheet has a second, later column also named "STATUS" that holds a
 *  shipment-tracking text blob and must never be read as the actual
 *  status. */
export function parseMonthSheetGrid(grid: unknown[][]): FbfRawRow[] {
  if (grid.length === 0) return [];
  const headers = (grid[0] as unknown[]).map((h) => String(h ?? "").trim());
  const col = (name: string) => headers.indexOf(name);
  const productCol = col("Product");
  const skuCol = col("SKU ID");
  const qtyCol = col("Final shipped quantity");
  const fcCol = col("FC");
  const statusCol = col("STATUS");
  if ([productCol, skuCol, qtyCol, fcCol, statusCol].some((i) => i === -1)) {
    throw new Error("Sheet is missing a required column (Product / SKU ID / Final shipped quantity / FC / STATUS)");
  }
  return grid.slice(1)
    .filter((row) => row.length > 0 && String(row[skuCol] ?? "").trim() !== "")
    .map((row) => ({
      product: String(row[productCol] ?? "").trim(),
      sku: String(row[skuCol] ?? "").trim(),
      quantity: Number(row[qtyCol]) || 0,
      fc: String(row[fcCol] ?? "").trim(),
      statusRaw: String(row[statusCol] ?? "").trim(),
    }));
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test src/lib/fbaForecastRules.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/fbaForecastRules.ts src/lib/fbaForecastRules.test.ts
git commit -m "Add FBA upload parsing/classification rules"
```

---

## Task 5: Client upload library

> **SUPERSEDED — as actually built:** `src/lib/fbaForecastUpload.ts` is a
> two-phase (`parseAndClean*` then `commit*`) API, not a single
> `upload*(file)` call, so the FBA page can show a preview before anything
> reaches Supabase:
> - `parseAndCleanFbaSales30d(file, reportDate)` /
>   `commitFbaSales30d(fileName, cleanedRows, totalRows, rejectionReasons)`
> - `parseAndCleanFbaStockSnapshot(file, reportDate)` /
>   `commitFbaStockSnapshot(fileName, cleanedRows, totalRows, rejectionReasons)`
> - `parseAndCleanFbaFbfDetails(file, reportDate)` /
>   `commitFbaFbfDetails(fileName, parsed, reportDate)`
> - `fetchShipmentCaps()` / `setShipmentCap(sku, zone, capQuantity)`
> - `fetchFbaDailySalesInfo()` / `fetchFbaStockSnapshotInfo()` /
>   `fetchFbaFbfDetailsInfo()` — "data on file" summaries for the cards.
> - `fetchRecentUploadHistory(limit)` — the last N `upload_history` rows
>   for the page's audit panel.
>
> Every `commit*` calls its table's `replace_*` RPC function ONCE (see
> Task 1's note — atomic delete+insert server-side) instead of a
> client-side delete-then-insert-in-chunks sequence, and writes one (or 3,
> for the FBF Details workbook) `upload_history` row recording
> `rows_received`/`rows_accepted`/`rows_rejected`/`rejection_reasons`, with
> `status: 'failed'` + `error_message` on an RPC error (still recording the
> attempt) before rethrowing.
>
> `reportDate` is required on every `parseAndClean*`/`commit*` call — it is
> NOT computed internally from `new Date()`. It flows in from
> `src/app/dashboard/fba/page.tsx`'s `useDashboard().endDate`. This is also
> where `active_date` on `barm_fba_recently_act` rows comes from (stamped
> identically across the batch as `reportDate`, not read from the file and
> not `new Date().toISOString()`).
>
> CSV parsing auto-detects delimiter (no explicit `delimiter` option) since
> the Amazon "All Orders" export is TAB-delimited while the FBA stock
> export is comma-delimited; `transformHeader` also strips a leading UTF-8
> BOM, since the real stock export's header row starts with one.

**Files:**
- Create: `src/lib/fbaForecastUpload.ts`

**Interfaces:**
- Consumes: `classifyStatus`, `detectMonthSheets`, `parseMonthSheetGrid`, types `StatusCategory`, `FbfRawRow`, `MonthSheet` from `./fbaForecastRules` (Task 4); `supabasePublic` from `@/lib/amazonReportUpload`.
- Produces: `uploadFbaSales30d(file): Promise<FbaUploadResult>`, `uploadFbaStock(file): Promise<FbaUploadResult>`, `uploadFbaFbfDetails(file): Promise<FbfUploadResult>`, `fetchShipmentCaps(): Promise<ShipmentCapRow[]>`, `setShipmentCap(sku, zone, capQuantity): Promise<void>`, `fetchFbaSales30dInfo(): Promise<FbaDataInfo>`, `fetchFbaStockInfo(): Promise<FbaDataInfo>`, `fetchFbaStatusEventsInfo(): Promise<{ rowCount: number; monthsOnFile: string[] }>`. Consumed by Task 9 (Upload page UI).
- This file does I/O only — no calculation (see Global Constraints). It is not unit-tested directly, matching this codebase's convention for I/O-wrapper files (e.g. `productMarketingUpload.ts` has no test file; its testable logic already lives in Task 4's pure module).

- [ ] **Step 1: Write the implementation**

```ts
// src/lib/fbaForecastUpload.ts
// Client-side upload functions for the FBA Forecast Report feature: parse
// and clean the 3 raw report types per the SOP/skill rules, and write raw
// rows to Supabase. NO forecast calculation happens here — that is the
// Edge Function's job exclusively (see Global Constraints in the plan and
// docs/superpowers/specs/2026-09-22-fba-forecast-refresh-design.md).
import * as XLSX from "xlsx";
import Papa from "papaparse";
import { supabasePublic } from "@/lib/amazonReportUpload";
import { classifyStatus, detectMonthSheets, parseMonthSheetGrid, type StatusCategory, type FbfRawRow } from "./fbaForecastRules";

async function truncateAndInsert(table: string, rows: Record<string, unknown>[]): Promise<void> {
  const { error: delErr } = await supabasePublic.from(table).delete().not("id", "is", null);
  if (delErr) throw new Error(`Clearing ${table} failed: ${delErr.message}`);
  await insertInChunks(table, rows);
}

async function insertInChunks(table: string, rows: Record<string, unknown>[], chunkSize = 300): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const { error } = await supabasePublic.from(table).insert(rows.slice(i, i + chunkSize));
    if (error) throw new Error(`Insert into ${table} failed: ${error.message}`);
  }
}

async function parseCsv<T>(file: File): Promise<T[]> {
  const text = await file.text();
  const result = Papa.parse<T>(text, { header: true, skipEmptyLines: true });
  return result.data;
}

export interface FbaUploadResult { totalRows: number; keptRows: number; droppedRows: number; }

// ── 30-day sales (SOP Section A) ────────────────────────────────────────────

interface RawSalesCsvRow {
  "amazon-order-id"?: string;
  "purchase-date"?: string;
  "order-status"?: string;
  "fulfillment-channel"?: string;
  "product-name"?: string;
  sku?: string;
  quantity?: string;
  "ship-state"?: string;
}

export async function uploadFbaSales30d(file: File): Promise<FbaUploadResult> {
  const rawRows = await parseCsv<RawSalesCsvRow>(file);
  const today = new Date().toISOString().slice(0, 10);
  const kept = rawRows.filter((r) => {
    const orderId = (r["amazon-order-id"] || "").trim();
    const purchaseDate = (r["purchase-date"] || "").slice(0, 10);
    const status = (r["order-status"] || "").trim().toLowerCase();
    const channel = (r["fulfillment-channel"] || "").trim().toLowerCase();
    if (orderId.startsWith("S")) return false;
    if (purchaseDate === today) return false;
    if (status === "cancelled") return false;
    if (channel === "merchant") return false;
    return true;
  }).map((r) => ({
    purchase_date: (r["purchase-date"] || "").slice(0, 10),
    fulfillment_channel: r["fulfillment-channel"] || "",
    product_name: r["product-name"] || "",
    sku: r.sku || "",
    quantity: Number(r.quantity) || 0,
    ship_state: r["ship-state"] || "",
  })).filter((r) => r.sku && r.purchase_date);

  await truncateAndInsert("barm_fba_sales_30d", kept);
  return { totalRows: rawRows.length, keptRows: kept.length, droppedRows: rawRows.length - kept.length };
}

// ── FBA stock (SOP Section B) ───────────────────────────────────────────────

interface RawStockCsvRow {
  Date?: string;
  FNSKU?: string;
  "Fulfillment Center"?: string;
  ASIN?: string;
  MSKU?: string;
  Disposition?: string;
  "Ending Warehouse Balance"?: string;
}

export async function uploadFbaStock(file: File): Promise<FbaUploadResult> {
  const rawRows = await parseCsv<RawStockCsvRow>(file);
  const dates = rawRows.map((r) => (r.Date || "").slice(0, 10)).filter(Boolean).sort();
  const mostRecentDate = dates[dates.length - 1];
  const kept = rawRows.filter((r) => {
    const date = (r.Date || "").slice(0, 10);
    const fc = (r["Fulfillment Center"] || "").trim().toUpperCase();
    const disposition = (r.Disposition || "").trim().toUpperCase();
    if (date !== mostRecentDate) return false;
    if (fc === "VSNC") return false;
    if (disposition !== "SELLABLE") return false;
    return true;
  }).map((r) => ({
    report_date: (r.Date || "").slice(0, 10),
    fnsku: r.FNSKU || "",
    fulfillment_center: r["Fulfillment Center"] || "",
    asin: r.ASIN || "",
    msku: r.MSKU || "",
    disposition: r.Disposition || "",
    ending_warehouse_balance: Number(r["Ending Warehouse Balance"]) || 0,
  })).filter((r) => r.msku);

  await truncateAndInsert("barm_fba_stock", kept);
  return { totalRows: rawRows.length, keptRows: kept.length, droppedRows: rawRows.length - kept.length };
}

// ── FBA & FBF Details-Updated workbook (SOP Section C) ─────────────────────

export interface FbfUploadResult extends FbaUploadResult {
  monthsFound: string[];
}

export async function uploadFbaFbfDetails(file: File): Promise<FbfUploadResult> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const monthSheets = detectMonthSheets(wb.SheetNames);
  if (monthSheets.length === 0) {
    throw new Error('No "FBA <MONTH><YY>" sheets found in this workbook.');
  }

  let totalRows = 0;
  let keptRows = 0;
  for (const { sheetName, sourceMonth } of monthSheets) {
    const ws = wb.Sheets[sheetName];
    const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "", raw: true });
    const rawRows = parseMonthSheetGrid(grid);
    totalRows += rawRows.length;

    const classified = rawRows
      .map((r) => ({ ...r, category: classifyStatus(r.statusRaw) }))
      .filter((r): r is FbfRawRow & { category: StatusCategory } => r.category !== null);
    keptRows += classified.length;

    const { error: delErr } = await supabasePublic.from("barm_fba_status_events").delete().eq("source_month", sourceMonth);
    if (delErr) throw new Error(`Clearing barm_fba_status_events for ${sourceMonth} failed: ${delErr.message}`);
    await insertInChunks("barm_fba_status_events", classified.map((r) => ({
      source_month: sourceMonth,
      product: r.product,
      sku: r.sku,
      quantity: r.quantity,
      fc: r.fc,
      status_raw: r.statusRaw,
      status_category: r.category,
    })));
  }

  return { totalRows, keptRows, droppedRows: totalRows - keptRows, monthsFound: monthSheets.map((m) => m.sourceMonth) };
}

// ── Shipment caps (manual, per SKU + zone) ──────────────────────────────────

export interface ShipmentCapRow { sku: string; zone: string; cap_quantity: number; updated_at: string; }

export async function fetchShipmentCaps(): Promise<ShipmentCapRow[]> {
  const { data, error } = await supabasePublic.from("barm_fba_shipment_caps").select("*").order("sku");
  if (error) throw new Error(`Fetching shipment caps failed: ${error.message}`);
  return (data || []) as ShipmentCapRow[];
}

export async function setShipmentCap(sku: string, zone: string, capQuantity: number): Promise<void> {
  const { error } = await supabasePublic.from("barm_fba_shipment_caps").upsert(
    { sku, zone, cap_quantity: capQuantity, updated_at: new Date().toISOString() },
    { onConflict: "sku,zone" }
  );
  if (error) throw new Error(`Saving shipment cap for ${sku}/${zone} failed: ${error.message}`);
}

// ── "data on file" info for the upload cards ────────────────────────────────

export interface FbaDataInfo { rowCount: number; maxDate: string | null; }

async function fetchDataInfo(table: string, dateCol: string): Promise<FbaDataInfo> {
  const { count, error: countErr } = await supabasePublic.from(table).select("*", { count: "exact", head: true });
  if (countErr) return { rowCount: 0, maxDate: null };
  const { data, error: maxErr } = await supabasePublic.from(table).select(dateCol).order(dateCol, { ascending: false }).limit(1);
  const maxDate = !maxErr && data && data.length > 0 ? String((data[0] as Record<string, unknown>)[dateCol]) : null;
  return { rowCount: count || 0, maxDate };
}

export async function fetchFbaSales30dInfo(): Promise<FbaDataInfo> { return fetchDataInfo("barm_fba_sales_30d", "purchase_date"); }
export async function fetchFbaStockInfo(): Promise<FbaDataInfo> { return fetchDataInfo("barm_fba_stock", "report_date"); }
export async function fetchFbaStatusEventsInfo(): Promise<{ rowCount: number; monthsOnFile: string[] }> {
  const { count } = await supabasePublic.from("barm_fba_status_events").select("*", { count: "exact", head: true });
  const { data } = await supabasePublic.from("barm_fba_status_events").select("source_month");
  const months = Array.from(new Set((data || []).map((r) => (r as Record<string, unknown>).source_month as string))).sort();
  return { rowCount: count || 0, monthsOnFile: months };
}
```

- [ ] **Step 2: Type-check**

Run: `npm run typecheck`
Expected: no new errors from `src/lib/fbaForecastUpload.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/fbaForecastUpload.ts
git commit -m "Add FBA raw-report upload functions"
```

---

## Task 6: Report export orchestration (Edge Function side)

> **SUPERSEDED — as actually built:** reads `barm_fba_daily_sales`,
> `barm_fba_stock_snapshot`, and the 3 separate
> `barm_fba_booked`/`barm_fba_intransit`/`barm_fba_recently_act` tables
> (tagging each with its `StatusCategory` locally) instead of one
> `barm_fba_sales_30d`/`barm_fba_stock`/`barm_fba_status_events` set. It
> also does NOT read a shipment-caps table at all — that manual input was
> removed; `computeFbaAnalysis` no longer takes a `shipmentCaps` parameter
> (see Task 3's note below). The "FBA Analysis" sheet no longer has a
> "Shipment Cap (Zone)" column.

**Files:**
- Create: `supabase/functions/_shared/fbaForecastReportExport.ts`

**Interfaces:**
- Consumes: `shipStateToZone`, `fcToZone` (Task 2); `computeFbaAnalysis` + types (Task 3); `fetchAllRows` from `./deps/amazonReportShared.ts`; `fetchProductMarketingMap`, `buildProductMarketingResolver` from `./deps/productMarketingUpload.ts` (both already exist in this repo).
- Produces: `buildFbaForecastReportWorkbook(): Promise<FbaForecastReportResult>` where `FbaForecastReportResult = { wb: XLSX.WorkBook; skuCount: number; zoneCount: number; lowStockAlertCount: number }`. Consumed by Task 7 (Edge Function entrypoint).
- I/O-heavy (Supabase reads) — not unit-tested directly, same convention as `adSpendReportExport.ts`'s top-level `buildAdSpendReportWorkbook`. Correctness is verified in Task 11's end-to-end check against the real uploaded files.

- [ ] **Step 1: Write the implementation**

```ts
// supabase/functions/_shared/fbaForecastReportExport.ts
// Orchestrates the FBA Forecast Report: reads the 4 raw Supabase tables,
// assigns zones, runs the pure calculation engine, and builds a fresh
// .xlsx workbook — the Edge Function equivalent of adSpendReportExport.ts's
// buildAdSpendReportWorkbook. See docs/superpowers/specs/2026-09-22-fba-
// forecast-refresh-design.md for the full design.
import XLSX from "npm:xlsx-js-style@1.2.0";
import { fetchAllRows } from "./deps/amazonReportShared.ts";
import { fetchProductMarketingMap, buildProductMarketingResolver } from "./deps/productMarketingUpload.ts";
import { shipStateToZone, fcToZone } from "./fbaZones.ts";
import { computeFbaAnalysis, type SalesRow, type StockRow, type StatusRow, type ShipmentCap, type FbaAnalysisRow } from "./fbaForecastCalc.ts";

interface RawSalesRow { purchase_date: string; product_name: string; sku: string; quantity: number; ship_state: string; }
interface RawStockRow { report_date: string; msku: string; ending_warehouse_balance: number; fulfillment_center: string; }
interface RawStatusRow { sku: string; quantity: number; fc: string; status_category: "booked" | "picked_up" | "active"; source_month: string; }
interface RawShipmentCap { sku: string; zone: string; cap_quantity: number; }

async function fetchRawData() {
  const [salesRaw, stockRaw, statusRaw, capsRaw] = await Promise.all([
    fetchAllRows("barm_fba_sales_30d", (q) => q) as Promise<RawSalesRow[]>,
    fetchAllRows("barm_fba_stock", (q) => q) as Promise<RawStockRow[]>,
    fetchAllRows("barm_fba_status_events", (q) => q) as Promise<RawStatusRow[]>,
    fetchAllRows("barm_fba_shipment_caps", (q) => q) as Promise<RawShipmentCap[]>,
  ]);
  return { salesRaw, stockRaw, statusRaw, capsRaw };
}

export interface FbaForecastReportResult {
  wb: XLSX.WorkBook;
  skuCount: number;
  zoneCount: number;
  lowStockAlertCount: number;
}

export async function buildFbaForecastReportWorkbook(): Promise<FbaForecastReportResult> {
  const { salesRaw, stockRaw, statusRaw, capsRaw } = await fetchRawData();

  const salesRows: SalesRow[] = salesRaw.map((r) => ({ sku: r.sku, zone: shipStateToZone(r.ship_state), quantity: r.quantity }));
  const stockRows: StockRow[] = stockRaw.map((r) => ({ sku: r.msku, zone: fcToZone(r.fulfillment_center), quantity: r.ending_warehouse_balance }));
  const statusRows: StatusRow[] = statusRaw.map((r) => ({ sku: r.sku, zone: fcToZone(r.fc), quantity: r.quantity, category: r.status_category }));
  const shipmentCaps: ShipmentCap[] = capsRaw.map((r) => ({ sku: r.sku, zone: r.zone, capQuantity: r.cap_quantity }));

  // master_product_marketing first, per the app-wide convention (see
  // ppc-dashboard-master-product-marketing-table); falling back to the
  // product name captured on the SKU's own sales rows, then the SKU itself.
  const productNameBySku = new Map<string, string>();
  salesRaw.forEach((r) => { if (r.sku && r.product_name && !productNameBySku.has(r.sku)) productNameBySku.set(r.sku, r.product_name); });
  const marketingMap = await fetchProductMarketingMap();
  const marketingResolver = buildProductMarketingResolver(marketingMap);
  const resolveProductName = (sku: string) => marketingResolver.resolveName(sku, productNameBySku.get(sku) || sku);

  const rows = computeFbaAnalysis(salesRows, stockRows, statusRows, shipmentCaps, resolveProductName);

  const wb = XLSX.utils.book_new();
  addFbaAnalysisSheet(wb, rows);
  addRawSheet(wb, "30-Day Sales", ["Purchase Date", "Product Name", "SKU", "Quantity", "Ship State", "Zone"],
    salesRaw.map((r) => [r.purchase_date, r.product_name, r.sku, r.quantity, r.ship_state, shipStateToZone(r.ship_state)]));
  addRawSheet(wb, "FBA Stock", ["Report Date", "MSKU", "Fulfillment Center", "Zone", "Ending Warehouse Balance"],
    stockRaw.map((r) => [r.report_date, r.msku, r.fulfillment_center, fcToZone(r.fulfillment_center), r.ending_warehouse_balance]));
  for (const [label, category] of [["Booked", "booked"], ["Intransit", "picked_up"], ["Active", "active"]] as const) {
    addRawSheet(wb, label, ["SKU", "FC", "Zone", "Quantity", "Source Month"],
      statusRaw.filter((r) => r.status_category === category).map((r) => [r.sku, r.fc, fcToZone(r.fc), r.quantity, r.source_month]));
  }

  const skuCount = new Set(rows.map((r) => r.sku)).size;
  const zoneCount = new Set(rows.map((r) => r.zone)).size;
  const lowStockAlertCount = rows.filter((r) => r.daysUntilStockout !== "--" && r.daysUntilStockout <= 14).length;

  return { wb, skuCount, zoneCount, lowStockAlertCount };
}

const FBA_ANALYSIS_HEADERS: Array<[keyof FbaAnalysisRow, string]> = [
  ["sku", "SKU ID"], ["productName", "Product Name"], ["zone", "Zone"],
  ["sales30d", "30-Day Sales (Zone)"], ["dailyRate", "Daily Rate (Zone)"], ["forecast120dZone", "120-Day Forecast (Zone)"],
  ["totalOrders30dSku", "30-Day Orders (SKU Total)"], ["totalForecast120dSku", "120-Day Forecast (SKU Total)"],
  ["maxForecastPerProduct", "Max Forecast Per Product"], ["minStockNeededZone", "Minimum Stock Needed (Zone)"],
  ["salesPctRegion", "Sales % (Region)"], ["currentStockZone", "Current Stock (Zone)"], ["totalStockSku", "Current Stock (SKU Total)"],
  ["stockNeededZone", "Stock Needed (Zone)"], ["bookedZone", "Booked (Zone)"], ["intransitZone", "Intransit (Zone)"],
  ["bookedPlusIntransitZone", "Booked + Intransit (Zone)"], ["stockNeededAfterInboundZone", "Stock Needed After Inbound (Zone)"],
  ["totalStockNeededAfterInboundSku", "Stock Needed After Inbound (SKU Total)"], ["activeZoneAccumulated", "Active, Last 3 Months (Zone)"],
  ["shipmentCapZone", "Shipment Cap (Zone)"], ["toBeSentZone", "To Be Sent (Zone)"], ["stockToBeOrderedZone", "Stock To Be Ordered (SKU)"],
  ["daysUntilStockout", "Days Until Stockout (Zone)"],
];

function addFbaAnalysisSheet(wb: XLSX.WorkBook, rows: FbaAnalysisRow[]): void {
  const header = FBA_ANALYSIS_HEADERS.map(([, label]) => label);
  const body = rows.map((r) => FBA_ANALYSIS_HEADERS.map(([key]) => r[key]));
  const ws = XLSX.utils.aoa_to_sheet([header, ...body]);
  XLSX.utils.book_append_sheet(wb, ws, "FBA Analysis");
}

function addRawSheet(wb: XLSX.WorkBook, name: string, header: string[], body: unknown[][]): void {
  const ws = XLSX.utils.aoa_to_sheet([header, ...body]);
  XLSX.utils.book_append_sheet(wb, ws, name);
}
```

- [ ] **Step 2: Type-check**

Run: `deno check supabase/functions/_shared/fbaForecastReportExport.ts`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/_shared/fbaForecastReportExport.ts
git commit -m "Add FBA forecast report export orchestration"
```

---

## Task 7: Edge Function entrypoint

**Files:**
- Create: `supabase/functions/generate-fba-forecast-report/index.ts`

**Interfaces:**
- Consumes: `buildFbaForecastReportWorkbook` (Task 6). Request body: `{ job_id: number; report_date: string }`.
- Produces: an HTTP endpoint `generate-fba-forecast-report` that acks fast and continues via `EdgeRuntime.waitUntil`, writing to `report_generation_jobs`, `fba_forecast_reports`, and the `fba-forecast-reports` Storage bucket (all from Task 1). Consumed by Task 8 (Vercel API route).

- [ ] **Step 1: Write the implementation**

```ts
// supabase/functions/generate-fba-forecast-report/index.ts
// Runs the full FBA Forecast Report calculation — the slow part that must
// never run inside a Vercel request. Responds fast, then keeps working via
// EdgeRuntime.waitUntil so the caller (a Vercel route) never waits on it.
// Mirrors ../generate-ad-spend-report/index.ts exactly.
import { createClient } from "npm:@supabase/supabase-js@2.110.8";
import XLSX from "npm:xlsx-js-style@1.2.0";
import { buildFbaForecastReportWorkbook } from "../_shared/fbaForecastReportExport.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  const body = await req.json().catch(() => ({}));
  const { job_id, report_date } = body as { job_id?: number; report_date?: string };
  if (!job_id || !report_date) return jsonResponse({ error: "job_id and report_date are required" }, 400);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);

  const run = async () => {
    try {
      const { error: statusError } = await supabase.from("report_generation_jobs").update({
        status: "processing", started_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq("id", job_id);
      if (statusError) throw new Error(`Failed to mark job as processing: ${statusError.message}`);

      const result = await buildFbaForecastReportWorkbook();

      // See the matching comment in ../generate-ad-spend-report/index.ts:
      // type: "buffer" correctly returns a real Uint8Array under Deno's npm
      // compatibility layer; type: "array" does not.
      const xlsxBytes = XLSX.write(result.wb, { type: "buffer", bookType: "xlsx" }) as Uint8Array;
      const storagePath = `${report_date}/fba-forecast-report.xlsx`;
      const { error: uploadError } = await supabase.storage
        .from("fba-forecast-reports")
        .upload(storagePath, xlsxBytes, {
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          upsert: true,
        });
      if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

      const { wb: _wb, ...resultJson } = result;
      const { error: upsertError } = await supabase.from("fba_forecast_reports").upsert({
        report_date, job_id, result_json: resultJson, xlsx_storage_path: storagePath,
        generated_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }, { onConflict: "report_date" });
      if (upsertError) throw new Error(`fba_forecast_reports upsert failed: ${upsertError.message}`);

      await supabase.from("report_generation_jobs").update({
        status: "completed", completed_at: new Date().toISOString(), updated_at: new Date().toISOString(), error_message: null,
      }).eq("id", job_id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await supabase.from("report_generation_jobs").update({
        status: "failed", completed_at: new Date().toISOString(), updated_at: new Date().toISOString(), error_message: message,
      }).eq("id", job_id);
    }
  };

  // deno-lint-ignore no-explicit-any
  const edgeRuntime = (globalThis as any).EdgeRuntime;
  if (edgeRuntime?.waitUntil) {
    edgeRuntime.waitUntil(run());
  } else {
    run();
  }
  return jsonResponse({ success: true, job_id, status: "processing" });
});
```

- [ ] **Step 2: Type-check**

Run: `deno check supabase/functions/generate-fba-forecast-report/index.ts`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/generate-fba-forecast-report/index.ts
git commit -m "Add generate-fba-forecast-report Edge Function"
```

- [ ] **Step 4: Deploy (manual — outside this repo's automated steps)**

Run: `supabase functions deploy generate-fba-forecast-report`

This step needs the Supabase CLI logged into the linked project; it is the
same manual deploy step every other Edge Function in this repo needs after
a code change (there is no CI auto-deploy configured).

---

## Task 8: Job trigger/poll + Vercel API routes

**Files:**
- Create: `src/lib/fbaForecastJobs.ts`
- Create: `src/pages/api/generate-fba-forecast-report.ts`
- Create: `src/pages/api/fba-forecast-report-status.ts`

**Interfaces:**
- Consumes: `supabase` from `@/lib/supabaseClient` (anon-keyed, safe for both server routes and direct browser import).
- Produces: `findFbaForecastJob(reportDate)`, `findOrCreateFbaForecastJob(reportDate, force)`, `fetchFbaForecastReportBlob(reportDate): Promise<Blob>` (all from `fbaForecastJobs.ts`); `POST /api/generate-fba-forecast-report` and `GET /api/fba-forecast-report-status`. Consumed by Task 10 (Download page UI).

- [ ] **Step 1: Write `src/lib/fbaForecastJobs.ts`**

```ts
// src/lib/fbaForecastJobs.ts
// Job-row lookup/dedupe for the FBA Forecast Report pipeline — same pattern
// as adSpendJobs.ts's findOrCreateJob, but report_type = 'fba_forecast' and
// keyed on report_date alone (no account_name dimension for this report).
import { supabase } from "@/lib/supabaseClient";

export const FBA_FORECAST_REPORT_TYPE = "fba_forecast";

export interface FbaForecastJobRow {
  id: number;
  report_date: string;
  status: "pending" | "processing" | "completed" | "failed";
  error_message: string | null;
}

export async function findFbaForecastJob(reportDate: string): Promise<FbaForecastJobRow | null> {
  const { data, error } = await supabase
    .from("report_generation_jobs")
    .select("id, report_date, status, error_message")
    .eq("report_date", reportDate)
    .eq("report_type", FBA_FORECAST_REPORT_TYPE)
    .eq("account_name", "")
    .maybeSingle();
  if (error) throw new Error(`Job lookup failed: ${error.message}`);
  return (data as FbaForecastJobRow) || null;
}

export async function findOrCreateFbaForecastJob(
  reportDate: string,
  force: boolean
): Promise<{ job: FbaForecastJobRow; created: boolean }> {
  const existing = await findFbaForecastJob(reportDate);
  if (existing && (existing.status === "processing" || (existing.status !== "failed" && !force))) {
    return { job: existing, created: false };
  }
  const { data, error } = await supabase
    .from("report_generation_jobs")
    .upsert(
      { report_date: reportDate, report_type: FBA_FORECAST_REPORT_TYPE, account_name: "", status: "pending", error_message: null, updated_at: new Date().toISOString() },
      { onConflict: "report_date,report_type,account_name" }
    )
    .select("id, report_date, status, error_message")
    .single();
  if (error) throw new Error(`Job creation failed: ${error.message}`);
  return { job: data as FbaForecastJobRow, created: true };
}

/** Downloads the completed report's .xlsx bytes from Supabase Storage,
 *  looking up its storage path from fba_forecast_reports for this
 *  report_date. Safe to call directly from the browser — `supabase` uses
 *  the public anon key, and the "fba-forecast-reports" bucket's storage
 *  policy (scripts/fba_forecast_tables.sql) grants anon read. */
export async function fetchFbaForecastReportBlob(reportDate: string): Promise<Blob> {
  const { data: reportRow, error: rowErr } = await supabase
    .from("fba_forecast_reports")
    .select("xlsx_storage_path")
    .eq("report_date", reportDate)
    .maybeSingle();
  if (rowErr) throw new Error(`Looking up report failed: ${rowErr.message}`);
  if (!reportRow?.xlsx_storage_path) throw new Error("Report has no stored file yet.");
  const { data: blob, error: dlErr } = await supabase.storage.from("fba-forecast-reports").download(reportRow.xlsx_storage_path);
  if (dlErr) throw new Error(`Downloading report failed: ${dlErr.message}`);
  return blob;
}
```

- [ ] **Step 2: Write `src/pages/api/generate-fba-forecast-report.ts`**

```ts
// src/pages/api/generate-fba-forecast-report.ts
// Lightweight "Generate" endpoint: creates/looks up a report_generation_jobs
// row (report_type='fba_forecast') and invokes the generate-fba-forecast-
// report Edge Function, awaiting only its fast ack. Mirrors
// generate-ad-spend-report.ts exactly. See docs/superpowers/specs/
// 2026-09-22-fba-forecast-refresh-design.md.
import type { NextApiRequest, NextApiResponse } from "next";
import { findOrCreateFbaForecastJob } from "@/lib/fbaForecastJobs";
import { supabase } from "@/lib/supabaseClient";

async function markJobFailedIfStillPending(jobId: number, message: string): Promise<void> {
  await supabase.from("report_generation_jobs").update({
    status: "failed", error_message: message, completed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq("id", jobId).eq("status", "pending");
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const { reportDate, force } = req.body || {};
  if (!reportDate) return res.status(400).json({ error: "reportDate is required" });

  try {
    const { job, created } = await findOrCreateFbaForecastJob(reportDate, !!force);
    if (!created) {
      return res.status(200).json({ success: true, job_id: job.id, status: job.status, error_message: job.error_message });
    }

    const edgeBaseUrl = process.env.SUPABASE_EDGE_URL;
    if (!edgeBaseUrl) {
      await markJobFailedIfStillPending(job.id, "SUPABASE_EDGE_URL is not configured");
      return res.status(500).json({ error: "SUPABASE_EDGE_URL is not configured" });
    }

    const ackController = new AbortController();
    const ackTimeout = setTimeout(() => ackController.abort(), 8000);
    try {
      const edgeRes = await fetch(`${edgeBaseUrl}/generate-fba-forecast-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: job.id, report_date: reportDate }),
        signal: ackController.signal,
      });
      clearTimeout(ackTimeout);
      if (!edgeRes.ok) {
        const errBody = await edgeRes.json().catch(() => ({}));
        const message = errBody?.error || "Edge Function invocation failed";
        await markJobFailedIfStillPending(job.id, message);
        return res.status(502).json({ error: message });
      }
    } catch (fetchErr) {
      clearTimeout(ackTimeout);
      const isAckTimeout = fetchErr instanceof Error && fetchErr.name === "AbortError";
      const message = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      if (isAckTimeout) {
        return res.status(202).json({
          success: false, job_id: job.id, status: "pending",
          message: "Report generation was triggered but did not acknowledge within 8s — it may still be starting. Check back shortly.",
        });
      }
      await markJobFailedIfStillPending(job.id, `Edge Function invocation failed: ${message}`);
      return res.status(502).json({ error: `Edge Function invocation failed: ${message}` });
    }

    return res.status(200).json({ success: true, job_id: job.id, status: "processing" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message });
  }
}
```

- [ ] **Step 3: Write `src/pages/api/fba-forecast-report-status.ts`**

```ts
// src/pages/api/fba-forecast-report-status.ts
// GET-only status check for the dashboard's polling — separate from the
// generate route so polling never accidentally re-triggers it.
import type { NextApiRequest, NextApiResponse } from "next";
import { findFbaForecastJob } from "@/lib/fbaForecastJobs";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const { reportDate } = req.query;
  if (!reportDate || typeof reportDate !== "string") return res.status(400).json({ error: "reportDate is required" });
  try {
    const job = await findFbaForecastJob(reportDate);
    return res.status(200).json({ job });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
```

- [ ] **Step 4: Type-check**

Run: `npm run typecheck`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/fbaForecastJobs.ts src/pages/api/generate-fba-forecast-report.ts src/pages/api/fba-forecast-report-status.ts
git commit -m "Add FBA forecast report job trigger/poll API routes"
```

---

## Task 9: Upload page UI

> **SUPERSEDED — as actually built:** this landed as a brand-new page,
> `src/app/dashboard/fba/page.tsx`, linked from a new "FBA" entry in
> `src/components/Sidebar.tsx`'s `NAV_SECTIONS` (Workspace section) — NOT
> as additions to `src/app/dashboard/upload/page.tsx` (the user asked for
> this after seeing the dashboard live: one dedicated FBA page, not cards
> bolted onto the general Upload page). The page also folds in the
> Generate/Download flow (Tasks 8/10's UI), since it made no sense to split
> "upload the 3 FBA reports" from "generate the FBA report" across two
> different pages for this one feature.
>
> Layout, top to bottom:
> 1. A "Processing for report date: {endDate}" banner (or a warning to pick
>    a date, if none is selected) — every upload/generate action below is
>    gated on this.
> 2. **Amazon Sales Report** card (`parseAndCleanFbaSales30d` /
>    `commitFbaSales30d`) — preview-then-confirm, shows rows kept vs.
>    rejection-reason breakdown, with the thrown validation `Error` (e.g. a
>    missing required column) surfaced as a visible red banner, not just
>    logged to console.
> 3. **FBA Stock Report** card — same pattern.
> 4. **FBA & FBF Details** card — same pattern, plus which month sheets it
>    auto-detected and the booked/intransit/active split.
> 5. **Generate & Download** — `POST /api/generate-fba-forecast-report` /
>    `GET /api/fba-forecast-report-status` (Task 8), gated on `!endDate`
>    and on all 3 uploads having data on file at least once; a Download
>    button once the job status is `completed`.
> 6. A "Recent FBA Uploads" panel below everything — the last 10
>    `upload_history` rows across all 5 tables.
>
> **There is no shipment-cap UI on this page** — an earlier version had a
> "Shipment Caps (per SKU + Zone)" panel between the upload cards and
> Generate/Download; the user removed that requirement entirely (see the
> spec doc's "Shipment cap (zone)"/"To be sent (zone)"/"Stock to be
> ordered (zone)" bullets for the replacement uncapped formulas). Nothing
> on this page requires a shipment cap to exist before generating.
>
> Every upload card takes `reportDate` as a prop (from this page's
> `useDashboard().endDate`) and threads it into its `parseAndClean*` call —
> none of the code below (which still shows the old single-phase
> `uploadFbaSales30d(file)`-style calls with no `reportDate` argument) is
> current; see Tasks 4/5's superseded notes for the real signatures.

**Files:**
- Modify: `src/app/dashboard/upload/page.tsx`

**Interfaces:**
- Consumes: everything from Task 5 (`src/lib/fbaForecastUpload.ts`).

- [ ] **Step 1: Add imports**

At the top of `src/app/dashboard/upload/page.tsx`, alongside the existing `@/lib/*` imports:

```tsx
import {
  uploadFbaSales30d, uploadFbaStock, uploadFbaFbfDetails,
  fetchShipmentCaps, setShipmentCap, type ShipmentCapRow,
  fetchFbaSales30dInfo, fetchFbaStockInfo, fetchFbaStatusEventsInfo, type FbaDataInfo,
} from "@/lib/fbaForecastUpload";
```

- [ ] **Step 2: Add the 3 upload card components and the shipment-cap panel**

Insert these above `export default function UploadReportsPage()` (same file
region as `SocialMediaUploadCard`/`GoogleOrdersUploadCard`):

```tsx
interface FbaCardState { status: "idle" | "parsing" | "done" | "error"; fileName?: string; message?: string; }

function FbaSales30dUploadCard({ onUploaded, dataInfo }: { onUploaded: () => void; dataInfo: FbaDataInfo | undefined }) {
  const [state, setState] = useState<FbaCardState>({ status: "idle" });
  const [dragOver, setDragOver] = useState(false);

  const handleFile = async (file: File) => {
    setState({ status: "parsing", fileName: file.name });
    try {
      const res = await uploadFbaSales30d(file);
      setState({ status: "done", fileName: file.name, message: `${res.keptRows} rows saved${res.droppedRows ? `, ${res.droppedRows} dropped` : ""} (of ${res.totalRows})` });
      onUploaded();
    } catch (err) {
      setState({ status: "error", fileName: file.name, message: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="glass rounded-2xl border-2 border-primary/30 p-6 shadow-sm">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
          <FileSpreadsheet size={20} />
        </div>
        <div>
          <h3 className="font-bold text-sm text-foreground">Amazon All Orders (Last 30 Days)</h3>
          <span className="text-[10px] text-muted-foreground uppercase font-black tracking-wider">CSV</span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Reports → Fulfillment → All Orders, last 30 days. Feeds the FBA Forecast Report&apos;s 30-day sales and
        120-day forecast columns.
      </p>
      <label
        htmlFor="fba-sales-30d-upload"
        className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-xl py-8 cursor-pointer transition-colors ${dragOver ? "border-primary" : "border-border hover:border-primary/50"}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); }}
      >
        <UploadCloud size={24} className="text-muted-foreground" />
        <span className="text-xs text-muted-foreground px-2 text-center truncate max-w-full">
          {state.fileName || "Click or drop the All Orders .csv here"}
        </span>
      </label>
      {dataInfo && (
        <p className="text-[10px] text-muted-foreground mt-1">
          {dataInfo.maxDate ? `Data through ${dataInfo.maxDate} (${dataInfo.rowCount} rows)` : "No data"}
        </p>
      )}
      <input id="fba-sales-30d-upload" type="file" accept=".csv" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
      <div className="mt-3 text-xs min-h-[1.25rem]">
        {state.status === "parsing" && <span className="flex items-center gap-1.5 text-muted-foreground"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading &amp; saving to Supabase…</span>}
        {state.status === "done" && <span className="flex items-center gap-1.5 text-green-600 dark:text-green-400 font-semibold"><CheckCircle2 size={14} /> {state.message}</span>}
        {state.status === "error" && <span className="flex items-center gap-1.5 text-red-600 dark:text-red-400 font-semibold"><XCircle size={14} /> {state.message}</span>}
      </div>
    </div>
  );
}

function FbaStockUploadCard({ onUploaded, dataInfo }: { onUploaded: () => void; dataInfo: FbaDataInfo | undefined }) {
  const [state, setState] = useState<FbaCardState>({ status: "idle" });
  const [dragOver, setDragOver] = useState(false);

  const handleFile = async (file: File) => {
    setState({ status: "parsing", fileName: file.name });
    try {
      const res = await uploadFbaStock(file);
      setState({ status: "done", fileName: file.name, message: `${res.keptRows} rows saved${res.droppedRows ? `, ${res.droppedRows} dropped` : ""} (of ${res.totalRows})` });
      onUploaded();
    } catch (err) {
      setState({ status: "error", fileName: file.name, message: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="glass rounded-2xl border-2 border-primary/30 p-6 shadow-sm">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
          <FileSpreadsheet size={20} />
        </div>
        <div>
          <h3 className="font-bold text-sm text-foreground">FBA Stock (Custom Report Builder)</h3>
          <span className="text-[10px] text-muted-foreground uppercase font-black tracking-wider">CSV</span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Reports → Fulfillment → Custom Report Builder: ASIN, MSKU, Disposition, Ending Warehouse Balance, last 3
        days. Only the most recent date, SELLABLE, non-VSNC rows are kept.
      </p>
      <label
        htmlFor="fba-stock-upload"
        className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-xl py-8 cursor-pointer transition-colors ${dragOver ? "border-primary" : "border-border hover:border-primary/50"}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); }}
      >
        <UploadCloud size={24} className="text-muted-foreground" />
        <span className="text-xs text-muted-foreground px-2 text-center truncate max-w-full">
          {state.fileName || "Click or drop the FBA stock .csv here"}
        </span>
      </label>
      {dataInfo && (
        <p className="text-[10px] text-muted-foreground mt-1">
          {dataInfo.maxDate ? `Data through ${dataInfo.maxDate} (${dataInfo.rowCount} rows)` : "No data"}
        </p>
      )}
      <input id="fba-stock-upload" type="file" accept=".csv" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
      <div className="mt-3 text-xs min-h-[1.25rem]">
        {state.status === "parsing" && <span className="flex items-center gap-1.5 text-muted-foreground"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading &amp; saving to Supabase…</span>}
        {state.status === "done" && <span className="flex items-center gap-1.5 text-green-600 dark:text-green-400 font-semibold"><CheckCircle2 size={14} /> {state.message}</span>}
        {state.status === "error" && <span className="flex items-center gap-1.5 text-red-600 dark:text-red-400 font-semibold"><XCircle size={14} /> {state.message}</span>}
      </div>
    </div>
  );
}

function FbaFbfDetailsUploadCard({ onUploaded, dataInfo }: { onUploaded: () => void; dataInfo: { rowCount: number; monthsOnFile: string[] } | undefined }) {
  const [state, setState] = useState<FbaCardState>({ status: "idle" });
  const [dragOver, setDragOver] = useState(false);

  const handleFile = async (file: File) => {
    setState({ status: "parsing", fileName: file.name });
    try {
      const res = await uploadFbaFbfDetails(file);
      setState({
        status: "done", fileName: file.name,
        message: `${res.keptRows} rows saved${res.droppedRows ? `, ${res.droppedRows} excluded` : ""} across months: ${res.monthsFound.join(", ")}`,
      });
      onUploaded();
    } catch (err) {
      setState({ status: "error", fileName: file.name, message: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="glass rounded-2xl border-2 border-primary/30 p-6 shadow-sm">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
          <FileSpreadsheet size={20} />
        </div>
        <div>
          <h3 className="font-bold text-sm text-foreground">FBA &amp; FBF Details-Updated</h3>
          <span className="text-[10px] text-muted-foreground uppercase font-black tracking-wider">XLSX</span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Upload the whole multi-month workbook as-is — the current month&apos;s sheet plus the previous 2 are
        auto-detected and their Booked/Picked Up/Active rows routed by STATUS.
      </p>
      <label
        htmlFor="fba-fbf-details-upload"
        className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-xl py-8 cursor-pointer transition-colors ${dragOver ? "border-primary" : "border-border hover:border-primary/50"}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); }}
      >
        <UploadCloud size={24} className="text-muted-foreground" />
        <span className="text-xs text-muted-foreground px-2 text-center truncate max-w-full">
          {state.fileName || "Click or drop the FBA & FBF Details-Updated .xlsx here"}
        </span>
      </label>
      {dataInfo && (
        <p className="text-[10px] text-muted-foreground mt-1">
          {dataInfo.monthsOnFile.length ? `On file: ${dataInfo.monthsOnFile.join(", ")} (${dataInfo.rowCount} rows)` : "No data"}
        </p>
      )}
      <input id="fba-fbf-details-upload" type="file" accept=".xlsx,.xls" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
      <div className="mt-3 text-xs min-h-[1.25rem]">
        {state.status === "parsing" && <span className="flex items-center gap-1.5 text-muted-foreground"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading sheets &amp; saving to Supabase…</span>}
        {state.status === "done" && <span className="flex items-center gap-1.5 text-green-600 dark:text-green-400 font-semibold"><CheckCircle2 size={14} /> {state.message}</span>}
        {state.status === "error" && <span className="flex items-center gap-1.5 text-red-600 dark:text-red-400 font-semibold"><XCircle size={14} /> {state.message}</span>}
      </div>
    </div>
  );
}

function FbaShipmentCapsPanel() {
  const [caps, setCaps] = useState<ShipmentCapRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [newSku, setNewSku] = useState("");
  const [newZone, setNewZone] = useState("");
  const [newCap, setNewCap] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try { setCaps(await fetchShipmentCaps()); } finally { setLoading(false); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const save = async (sku: string, zone: string, capQuantity: number) => {
    setSavingKey(`${sku} ${zone}`);
    try { await setShipmentCap(sku, zone, capQuantity); await refresh(); } finally { setSavingKey(null); }
  };

  return (
    <div className="glass rounded-2xl border-2 border-primary/30 p-6 shadow-sm">
      <h3 className="font-bold text-sm text-foreground mb-1">Shipment Caps (per SKU + Zone)</h3>
      <p className="text-xs text-muted-foreground mb-4">
        Manual per-batch shipment limit for each SKU/zone — feeds the FBA Forecast Report&apos;s &quot;To Be
        Sent&quot; and &quot;Stock To Be Ordered&quot; columns. Not recomputed; edit as your ops plan changes.
      </p>
      <div className="flex flex-wrap gap-2 mb-4">
        <input value={newSku} onChange={(e) => setNewSku(e.target.value)} placeholder="SKU" className="px-3 py-1.5 text-xs rounded-lg border border-border bg-background" />
        <input value={newZone} onChange={(e) => setNewZone(e.target.value)} placeholder="Zone (e.g. Karnataka_zone)" className="px-3 py-1.5 text-xs rounded-lg border border-border bg-background" />
        <input value={newCap} onChange={(e) => setNewCap(e.target.value)} placeholder="Cap quantity" type="number" className="px-3 py-1.5 text-xs rounded-lg border border-border bg-background w-32" />
        <button
          onClick={() => { if (newSku && newZone && newCap) { save(newSku, newZone, Number(newCap)); setNewSku(""); setNewZone(""); setNewCap(""); } }}
          className="px-3 py-1.5 bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-bold rounded-lg"
        >
          Add / Update
        </button>
      </div>
      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : (
        <div className="glass rounded-xl border border-border overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="text-left text-muted-foreground"><th className="p-2">SKU</th><th className="p-2">Zone</th><th className="p-2">Cap</th><th className="p-2"></th></tr></thead>
            <tbody>
              {caps.map((c) => (
                <tr key={`${c.sku} ${c.zone}`} className="border-t border-border">
                  <td className="p-2">{c.sku}</td>
                  <td className="p-2">{c.zone}</td>
                  <td className="p-2">
                    <input
                      type="number"
                      defaultValue={c.cap_quantity}
                      onBlur={(e) => { const v = Number(e.target.value); if (v !== c.cap_quantity) save(c.sku, c.zone, v); }}
                      className="w-24 px-2 py-1 rounded border border-border bg-background"
                    />
                  </td>
                  <td className="p-2">{savingKey === `${c.sku} ${c.zone}` && <Loader2 className="w-3.5 h-3.5 animate-spin" />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Wire state + a render section into `UploadReportsPage`**

Inside `export default function UploadReportsPage()`, alongside the other
`useState`/`useCallback` data-info hooks:

```tsx
  const [fbaSalesInfo, setFbaSalesInfo] = useState<FbaDataInfo | undefined>(undefined);
  const [fbaStockInfo, setFbaStockInfo] = useState<FbaDataInfo | undefined>(undefined);
  const [fbaStatusInfo, setFbaStatusInfo] = useState<{ rowCount: number; monthsOnFile: string[] } | undefined>(undefined);
  const refreshFbaSalesInfo = useCallback(async () => setFbaSalesInfo(await fetchFbaSales30dInfo()), []);
  const refreshFbaStockInfo = useCallback(async () => setFbaStockInfo(await fetchFbaStockInfo()), []);
  const refreshFbaStatusInfo = useCallback(async () => setFbaStatusInfo(await fetchFbaStatusEventsInfo()), []);
```

Add these 3 to the existing startup `useEffect(() => { ... }, [...])` call
list (both the calls inside the effect body and its dependency array):

```tsx
  useEffect(() => {
    refreshMeta();
    refreshCombinedMeta();
    refreshMisMeta();
    refreshProductMarketingMeta();
    refreshSocialMediaMeta();
    refreshGoogleMeta();
    refreshFbaSalesInfo();
    refreshFbaStockInfo();
    refreshFbaStatusInfo();
  }, [refreshMeta, refreshCombinedMeta, refreshMisMeta, refreshProductMarketingMeta, refreshSocialMediaMeta, refreshGoogleMeta, refreshFbaSalesInfo, refreshFbaStockInfo, refreshFbaStatusInfo]);
```

Add this section to the returned JSX, right before the closing
`<CampaignSkuMappingSection />` line:

```tsx
      <div>
        <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground mb-3">
          FBA Forecast Report (optional)
        </h2>
        <p className="text-xs text-muted-foreground mb-3 -mt-2">
          Feeds the FBA Forecast Report on the Download page — 30-day sales, FBA stock, and booked/picked-up/active
          shipment status, all calculated server-side in Supabase, not in this browser tab.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          <FbaSales30dUploadCard onUploaded={refreshFbaSalesInfo} dataInfo={fbaSalesInfo} />
          <FbaStockUploadCard onUploaded={refreshFbaStockInfo} dataInfo={fbaStockInfo} />
          <FbaFbfDetailsUploadCard onUploaded={refreshFbaStatusInfo} dataInfo={fbaStatusInfo} />
        </div>
        <div className="mt-5">
          <FbaShipmentCapsPanel />
        </div>
      </div>

      <CampaignSkuMappingSection />
```

- [ ] **Step 4: Type-check**

Run: `npm run typecheck`
Expected: no new errors.

- [ ] **Step 5: Verify in the browser**

Start the dev server (`preview_start` with the `ppc-dashboard` launch
config), open `/dashboard/upload`, and confirm the new "FBA Forecast Report"
section renders with 3 upload cards and the shipment-caps panel below the
existing sections, with no console errors.

- [ ] **Step 6: Commit**

```bash
git add src/app/dashboard/upload/page.tsx
git commit -m "Add FBA Forecast Report upload section"
```

---

## Task 10: Download page UI

> **SUPERSEDED — as actually built:** folded into `src/app/dashboard/fba/
> page.tsx`'s "5. Generate & Download" section (see Task 9's superseded
> note) instead of `src/app/dashboard/reports/page.tsx` — the user wanted
> one page with the whole FBA flow, upload through download, not a second
> report card bolted onto the general Download page.
>
> The one functional difference from the code sketch below: `report_date`
> is **always `endDate` from `useDashboard()`** — the dashboard's own
> globally-selected date — never `new Date().toISOString()`/"today". This
> matches how every other report on `reports/page.tsx` (Ad Spend, Weekly
> Sales, Historical Analysis) already reads `endDate` and disables its
> Generate button with `disabled={generating || !endDate}`; the FBA
> Generate button follows the identical rule (`disabled={... || !endDate
> || !readyToGenerate}`, where `readyToGenerate` requires all 3 uploads to
> have data on file).

**Files:**
- Modify: `src/app/dashboard/reports/page.tsx`

**Interfaces:**
- Consumes: `fetchFbaForecastReportBlob` from `@/lib/fbaForecastJobs` (Task 8), `POST /api/generate-fba-forecast-report` + `GET /api/fba-forecast-report-status` (Task 8), `saveAs` from `file-saver` (already a dependency).

- [ ] **Step 1: Add imports**

```tsx
import Link from "next/link";
import { saveAs } from "file-saver";
import { fetchFbaForecastReportBlob } from "@/lib/fbaForecastJobs";
```

(If `Link` is already imported in this file, skip re-adding it.)

- [ ] **Step 2: Add state + handlers**

Inside `export default function ReportsPage()`, alongside the existing
`jobGenerating`/`jobStatus` state:

```tsx
  const [fbaForecastGenerating, setFbaForecastGenerating] = useState(false);
  const [fbaForecastJobStatus, setFbaForecastJobStatus] = useState<string | null>(null);
  const [fbaForecastMsg, setFbaForecastMsg] = useState<string | null>(null);
  const [fbaForecastDownloading, setFbaForecastDownloading] = useState(false);

  const todayIso = () => new Date().toISOString().slice(0, 10);

  const pollFbaForecastStatus = async (reportDate: string) => {
    const qs = new URLSearchParams({ reportDate });
    const r = await fetch(`/api/fba-forecast-report-status?${qs.toString()}`);
    const j = await r.json();
    return j.job as { status: string; error_message: string | null } | null;
  };

  useEffect(() => {
    const reportDate = todayIso();
    let cancelled = false;
    pollFbaForecastStatus(reportDate).then((job) => { if (!cancelled) setFbaForecastJobStatus(job?.status ?? null); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const handleGenerateFbaForecast = async (force = false) => {
    const reportDate = todayIso();
    setFbaForecastGenerating(true); setFbaForecastMsg(null);
    try {
      const r = await fetch("/api/generate-fba-forecast-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportDate, force }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Failed to start report generation");
      setFbaForecastJobStatus(j.status);
      setFbaForecastMsg(j.status === "completed" ? "Report already generated today." : "Generating…");

      const poll = async () => {
        try {
          const job = await pollFbaForecastStatus(reportDate);
          if (!job) { setFbaForecastMsg("Lost track of the report's status — try Generate again."); setFbaForecastGenerating(false); return; }
          setFbaForecastJobStatus(job.status);
          if (job.status === "completed") { setFbaForecastMsg("Completed."); setFbaForecastGenerating(false); return; }
          if (job.status === "failed") { setFbaForecastMsg(`Failed: ${job.error_message || "unknown error"} — Retry`); setFbaForecastGenerating(false); return; }
          setTimeout(poll, 5000);
        } catch (err) {
          setFbaForecastMsg("Failed to check report status: " + (err instanceof Error ? err.message : String(err)));
          setFbaForecastGenerating(false);
        }
      };
      setTimeout(poll, 5000);
    } catch (err) {
      setFbaForecastMsg("Failed: " + (err instanceof Error ? err.message : String(err)));
      setFbaForecastGenerating(false);
    }
  };

  const handleDownloadFbaForecast = async () => {
    setFbaForecastDownloading(true);
    try {
      const blob = await fetchFbaForecastReportBlob(todayIso());
      saveAs(blob, `FBA_Forecast_Report_${todayIso()}.xlsx`);
    } catch (err) {
      setFbaForecastMsg("Download failed: " + (err instanceof Error ? err.message : String(err)));
    } finally { setFbaForecastDownloading(false); }
  };
```

- [ ] **Step 3: Add the render block**

Insert this `<div>` right after the Daily Ad Spend Report section's closing
`</div>` (the block containing `handleGenerateAdSpend`/`handleGenerateAdSpendJob`
buttons) and before the "Live API reports" section:

```tsx
      <div className="glass rounded-2xl border border-border p-6 shadow-sm">
        <h3 className="font-bold text-sm mb-1">FBA Forecast Report</h3>
        <p className="text-xs text-muted-foreground mb-4">
          30-day sales, FBA stock, and booked/picked-up/active shipment status by SKU and zone — 120-day forecast,
          stock needed, days until stockout, computed server-side in Supabase from the files uploaded on the{" "}
          <Link href="/dashboard/upload" className="underline hover:text-foreground">Upload</Link> page&apos;s FBA
          Forecast Report section.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => handleGenerateFbaForecast(fbaForecastJobStatus === "failed" || fbaForecastJobStatus === "completed")}
            disabled={fbaForecastGenerating}
            className="px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-bold rounded-lg transition-colors flex items-center gap-2 shadow-md disabled:opacity-50"
          >
            {fbaForecastGenerating ? (
              <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Generating…</>
            ) : (
              <><RotateCcw size={14} /> {fbaForecastJobStatus === "completed" ? "Regenerate Report" : fbaForecastJobStatus === "failed" ? "Retry" : "Generate Report"}</>
            )}
          </button>
          <button
            onClick={handleDownloadFbaForecast}
            disabled={fbaForecastDownloading || fbaForecastJobStatus !== "completed"}
            className="px-4 py-2 bg-white dark:bg-white/10 border border-border hover:border-primary/50 text-foreground text-xs font-bold rounded-lg transition-colors flex items-center gap-2 shadow-sm disabled:opacity-50"
          >
            {fbaForecastDownloading ? (
              <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Downloading…</>
            ) : (
              <><Download size={14} /> Download</>
            )}
          </button>
        </div>
        {fbaForecastMsg && <p className="text-xs mt-3 font-semibold">{fbaForecastMsg}</p>}
      </div>
```

- [ ] **Step 4: Type-check**

Run: `npm run typecheck`
Expected: no new errors.

- [ ] **Step 5: Verify in the browser**

Open `/dashboard/reports`, confirm the "FBA Forecast Report" card renders
with a "Generate Report" button and a disabled "Download" button (no
completed job yet), no console errors.

- [ ] **Step 6: Commit**

```bash
git add src/app/dashboard/reports/page.tsx
git commit -m "Add FBA Forecast Report download section"
```

---

## Task 11: End-to-end verification against the real files

**Files:** none (verification only).

- [ ] **Step 1: Confirm Task 1's SQL has been run**

Re-run the `information_schema.tables` check from Task 1, Step 2, against
the live Supabase project.

- [ ] **Step 2: Confirm the Edge Function is deployed**

Run: `supabase functions list` and confirm `generate-fba-forecast-report`
is present (deployed in Task 7, Step 4).

- [ ] **Step 3: Upload the 3 real files**

Start the dev server and open `/dashboard/upload`. Upload, in order:
- The Amazon "All Orders" CSV the user supplied → `Amazon All Orders (Last 30 Days)` card.
- The FBA stock CSV the user supplied → `FBA Stock (Custom Report Builder)` card.
- `FBA & FBF Details-Updated (1).xlsx` (the exact file the user attached
  earlier in this conversation) → `FBA & FBF Details-Updated` card. Confirm
  the success message lists months `2026-09`, `2026-08`, `2026-07`
  (current month + previous 2, as of 2026-09-22).

- [ ] **Step 4: Generate and download the report**

Open `/dashboard/reports`, click "Generate Report" on the FBA Forecast
Report card, wait for it to show "Completed", click "Download".

- [ ] **Step 5: Golden-row check**

Open the downloaded `.xlsx`, go to the "FBA Analysis" sheet, and find the
row for SKU `B-SENBR-1`, Zone `Karnataka_zone`. Confirm it matches the live
values already present in the user's real `FBA_forecast sheet(30
days).xlsx` (`FBA analysis!row 2`, captured during design):

| Column | Expected |
|---|---|
| 30-Day Sales (Zone) | 108 |
| 120-Day Forecast (Zone) | 432 |
| Current Stock (Zone) | 168 |
| Stock Needed After Inbound (Zone) | 264 |
| Days Until Stockout (Zone) | 47 |

If any value differs, the discrepancy is almost certainly in product-name
resolution or the ship-state/FC values in the *current* uploaded files
differing from the snapshot the golden values were captured from (the
user's live data changes over time) — re-check by tracing that SKU/zone's
rows in the "30-Day Sales" and "FBA Stock" sheets of the same output
workbook before suspecting the formulas in Task 3.

- [ ] **Step 6: Report results to the user**

No commit for this task — it's a verification pass. Summarize what was
checked and whether the golden row matched.
