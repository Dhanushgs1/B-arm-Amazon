-- Migration target: FBA Inventory, Inventory Ledger, Sponsored Brands campaign,
-- Sponsored Display campaign, Sponsored Products (advertised product), Product Master,
-- Email Settings, Flipkart FSN (ad spend) report — run this ONCE in the SQL Editor of
-- the NEW Supabase project you're moving these 8 tables to.
--
-- Schema reverse-engineered from the actual upload/config code — src/lib/amazonReportUpload.ts's
-- mapFbaInventoryRow/mapInventoryLedgerRow/mapSbRow/mapSdRow/mapSpRow/mapCampaignCommon for
-- the 6 Amazon tables, src/lib/flipkartReportUpload.ts's parseFsnReportCsv/parseFsnReportXlsx
-- for the Flipkart one, scripts/email_settings_migration.sql for email_settings — not
-- guessed, these are exactly the columns the app writes/reads today. Same house style as
-- the existing barm_daily_sheet_tables.sql / product_master_table.sql: RLS disabled,
-- explicit grants to anon (the app talks to Supabase with the anon key, no auth session),
-- a `raw jsonb` column keeping the full original upload row so nothing is lost.
--
-- After creating these in the new project, point the app at it by updating
-- NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY (or whichever env vars
-- supabasePublic in src/lib/amazonReportUpload.ts / flipkartReportUpload.ts read) in
-- .env.local / Vercel. If you're moving ONLY these 8 tables and leaving the rest
-- (am_orders, am_returns, fba_returns, price_listing, order_report, earn_more, etc.) on
-- the old project, the app will need TWO Supabase clients instead of one — flag that
-- separately, it's a bigger code change than just running this SQL.

-- ── 0. Sponsored Products — Advertised Product report ───────────────────────
-- Upserted per-row on (report_date, campaign_name, ad_group_name, advertised_sku) — see
-- ON_CONFLICT.sp_advertised_product in amazonReportUpload.ts — unique constraint required.
-- Also PRUNE_TO_UPLOAD_RANGE: rows outside a freshly-uploaded file's date range get deleted
-- (app-side logic, not a schema concern) since this table is meant to hold only the
-- seller's "Last N days" window, not full history.
create table if not exists public.barm_amazon_sp_advertised_product (
  id bigint generated always as identity primary key,
  report_date date,
  portfolio_name text,
  currency text,
  campaign_name text,
  ad_group_name text,
  country text,
  advertised_sku text,
  advertised_asin text,
  impressions integer,
  clicks integer,
  ctr numeric,
  cpc numeric,
  spend numeric,
  sales_7d numeric,
  acos numeric,
  roas numeric,
  orders_7d integer,
  units_7d integer,
  conversion_rate_7d numeric,
  advertised_sku_units_7d integer,
  other_sku_units_7d integer,
  advertised_sku_sales_7d numeric,
  other_sku_sales_7d numeric,
  raw jsonb,
  created_at timestamptz not null default now(),
  unique (report_date, campaign_name, ad_group_name, advertised_sku)
);

-- ── 1. Sponsored Brands — Campaign report ───────────────────────────────────
-- Upserted per-row on (report_date, campaign_name) — see ON_CONFLICT.sb_campaign in
-- amazonReportUpload.ts — so the unique constraint below is REQUIRED, not optional;
-- without it the app's .upsert(..., { onConflict: "report_date,campaign_name" }) fails.
create table if not exists public.barm_amazon_sb_campaign (
  id bigint generated always as identity primary key,
  report_date date,
  portfolio_name text,
  currency text,
  campaign_name text,
  cost_type text,
  country text,
  impressions integer,
  clicks integer,
  ctr numeric,
  cpc numeric,
  spend numeric,
  acos numeric,
  roas numeric,
  sales numeric,
  orders integer,
  units integer,
  conversion_rate numeric,
  raw jsonb,
  created_at timestamptz not null default now(),
  unique (report_date, campaign_name)
);

-- ── 2. Sponsored Display — Campaign report ──────────────────────────────────
-- Same upsert key as SB: (report_date, campaign_name) — unique constraint required.
create table if not exists public.barm_amazon_sd_campaign (
  id bigint generated always as identity primary key,
  report_date date,
  portfolio_name text,
  currency text,
  campaign_name text,
  cost_type text,
  country text,
  impressions integer,
  clicks integer,
  ctr numeric,
  cpc numeric,
  spend numeric,
  acos numeric,
  roas numeric,
  status text,
  sales_14d numeric,
  orders_14d integer,
  units_14d integer,
  raw jsonb,
  created_at timestamptz not null default now(),
  unique (report_date, campaign_name)
);

-- ── 3. FBA Inventory report ──────────────────────────────────────────────────
-- A current-moment stock snapshot with no date column (FULL_REPLACE_TYPES.fba_inventory)
-- — every upload truncates and replaces the whole table rather than upserting by key, so
-- no unique constraint on sku is required (a plain index is enough for lookups).
create table if not exists public.barm_amazon_fba_inventory (
  id bigint generated always as identity primary key,
  sku text,
  fnsku text,
  asin text,
  product_name text,
  condition text,
  your_price numeric,
  mfn_fulfillable_quantity integer,
  afn_fulfillable_quantity integer,
  afn_total_quantity integer,
  afn_unsellable_quantity integer,
  afn_reserved_quantity integer,
  afn_inbound_working_quantity integer,
  afn_inbound_shipped_quantity integer,
  afn_inbound_receiving_quantity integer,
  raw jsonb,
  created_at timestamptz not null default now()
);

-- ── 4. Inventory Ledger report ───────────────────────────────────────────────
-- Re-ingested as "delete whatever ledger_date range this file covers, then insert"
-- (REPLACE_DATE_FIELD.inventory_ledger = "ledger_date") rather than per-row upsert, since
-- Amazon's own export has no fully-reliable natural key — so no unique constraint here
-- either, just indexes matching the actual query patterns (disposition filter, msku/asin
-- lookups).
create table if not exists public.barm_amazon_inventory_ledger (
  id bigint generated always as identity primary key,
  ledger_date date,
  fnsku text,
  asin text,
  msku text,
  title text,
  disposition text,
  starting_balance integer,
  ending_balance integer,
  customer_shipments integer,
  customer_returns integer,
  location text,
  raw jsonb,
  created_at timestamptz not null default now()
);

-- ── 5. Product Master ─────────────────────────────────────────────────────
-- Already has its own script — scripts/product_master_table.sql — reproduced here
-- verbatim so this one file covers everything end to end.
create table if not exists public.barm_product_master (
  sku text primary key,
  product_name text not null,
  category text,
  approval_status text,
  raw jsonb,
  updated_at timestamptz not null default now()
);

-- ── 6. Email Settings (per-account notification/automation config) ──────────
-- Already has its own script — scripts/email_settings_migration.sql — schema reproduced
-- here (WITHOUT the data row, since that carries real recipient emails and account IDs —
-- see that file directly if you also want to carry the existing saved settings across,
-- not just recreate the empty table).
create table if not exists public.email_settings (
  key_slot   text primary key,
  settings   jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ── 7. Flipkart FSN report (ad spend — "FK ads") ────────────────────────────
-- Upserted per-row on (report_date, campaign_id, adgroup_id, sku_id) — see
-- upsertInChunks(table, rows, "report_date,campaign_id,adgroup_id,sku_id") in
-- flipkartReportUpload.ts — unique constraint required. Note this is Flipkart's OWN
-- Supabase client/project convention (barm_flipkart_* naming) — same anon-key access
-- pattern as the Amazon tables above, just a separate table family.
create table if not exists public.barm_flipkart_fsn_report (
  id bigint generated always as identity primary key,
  report_date date,
  campaign_id text,
  campaign_name text,
  adgroup_id text,
  adgroup_name text,
  sku_id text,
  product_name text,
  views integer,
  clicks integer,
  direct_units_sold integer,
  indirect_units_sold integer,
  total_revenue numeric,
  conversion_rate numeric,
  roi numeric,
  ad_spend numeric,
  raw jsonb,
  created_at timestamptz not null default now(),
  unique (report_date, campaign_id, adgroup_id, sku_id)
);

-- ── Indexes ──────────────────────────────────────────────────────────────────
create index if not exists barm_amazon_sp_advertised_product_date_idx on public.barm_amazon_sp_advertised_product (report_date);
create index if not exists barm_amazon_sp_advertised_product_sku_idx on public.barm_amazon_sp_advertised_product (advertised_sku);
create index if not exists barm_amazon_sb_campaign_date_idx on public.barm_amazon_sb_campaign (report_date);
create index if not exists barm_amazon_sb_campaign_name_idx on public.barm_amazon_sb_campaign (campaign_name);
create index if not exists barm_amazon_sd_campaign_date_idx on public.barm_amazon_sd_campaign (report_date);
create index if not exists barm_amazon_sd_campaign_name_idx on public.barm_amazon_sd_campaign (campaign_name);
create index if not exists barm_amazon_fba_inventory_sku_idx on public.barm_amazon_fba_inventory (sku);
create index if not exists barm_amazon_fba_inventory_asin_idx on public.barm_amazon_fba_inventory (asin);
create index if not exists barm_amazon_inventory_ledger_date_idx on public.barm_amazon_inventory_ledger (ledger_date);
create index if not exists barm_amazon_inventory_ledger_msku_idx on public.barm_amazon_inventory_ledger (msku);
create index if not exists barm_amazon_inventory_ledger_disposition_idx on public.barm_amazon_inventory_ledger (disposition);
create index if not exists barm_product_master_product_name_idx on public.barm_product_master (product_name);
create index if not exists barm_flipkart_fsn_report_date_idx on public.barm_flipkart_fsn_report (report_date);
create index if not exists barm_flipkart_fsn_report_sku_idx on public.barm_flipkart_fsn_report (sku_id);

-- ── RLS + grants (same anon-key access pattern as every other barm_* table) ────
alter table public.barm_amazon_sp_advertised_product disable row level security;
alter table public.barm_amazon_sb_campaign disable row level security;
alter table public.barm_amazon_sd_campaign disable row level security;
alter table public.barm_amazon_fba_inventory disable row level security;
alter table public.barm_amazon_inventory_ledger disable row level security;
alter table public.barm_product_master disable row level security;
alter table public.email_settings disable row level security;
alter table public.barm_flipkart_fsn_report disable row level security;

grant select, insert, update, delete on public.barm_amazon_sp_advertised_product to anon;
grant select, insert, update, delete on public.barm_amazon_sb_campaign to anon;
grant select, insert, update, delete on public.barm_amazon_sd_campaign to anon;
grant select, insert, update, delete on public.barm_amazon_fba_inventory to anon;
grant select, insert, update, delete on public.barm_amazon_inventory_ledger to anon;
grant select, insert, update, delete on public.barm_product_master to anon;
-- No delete here — matches email_settings_migration.sql exactly (settings are only ever
-- upserted, never deleted, by the app).
grant select, insert, update on public.email_settings to anon;
grant select, insert, update, delete on public.barm_flipkart_fsn_report to anon;
grant usage, select on all sequences in schema public to anon;
