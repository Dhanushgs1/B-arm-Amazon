-- barm_daily_* per-sheet mirror tables — run this ONCE in the Supabase SQL
-- Editor for the project this app uses (see .env.local's
-- NEXT_PUBLIC_SUPABASE_URL).
--
-- One dedicated table per sheet of the seller's combined "Last 7 days"
-- workbook (the "Ad Spend Report — one-file upload" card on the Upload
-- page). Unlike scripts/barm_daily_ad_spend_table.sql (a single table for
-- every sheet, told apart by a `sheet` column), these are split one-per-sheet
-- so Amazon/Flipkart/Meesho never share a table, and — for Meesho — the BARM
-- and MW stores never share a table either. Every row's full original data
-- is kept in `raw` jsonb, so nothing from the source sheet is lost even for
-- columns not pulled out as their own field.
--
-- IMPORTANT: same as barm_daily_ad_spend, this is a mirror/audit copy, not a
-- second source of truth — "Generate Ad Spend Report" (Download page) keeps
-- reading the existing barm_amazon_*/barm_flipkart_*/barm_meesho_* tables,
-- unchanged. src/lib/combinedAdSpendUpload.ts writes to both: the existing
-- tables (for the report) and these new ones (so every sheet has its own
-- plainly-named place in Supabase to confirm "did my file actually save").
--
-- Re-uploading a date range that's already in one of these tables replaces
-- those rows (deletes the covered report_date range, then inserts), so
-- nothing gets duplicated.

create table if not exists public.barm_daily_am_ads (
  id bigint generated always as identity primary key,
  report_date date,
  end_date date,
  portfolio_name text,
  campaign_name text,
  ad_group_name text,
  sku text,
  asin text,
  impressions integer,
  clicks integer,
  spend numeric,
  sales_7d numeric,
  acos numeric,
  orders_7d integer,
  units_7d integer,
  raw jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.barm_daily_am_orders (
  id bigint generated always as identity primary key,
  order_id text,
  report_date date,
  purchase_datetime text,
  order_status text,
  sku text,
  asin text,
  product_name text,
  quantity integer,
  item_price numeric,
  ship_city text,
  ship_state text,
  raw jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.barm_daily_fk_ads (
  id bigint generated always as identity primary key,
  report_date date,
  campaign_id text,
  campaign_name text,
  ad_group_name text,
  sku text,
  product_name text,
  views integer,
  clicks integer,
  units_sold integer,
  revenue numeric,
  ad_spend numeric,
  roi numeric,
  raw jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.barm_daily_fk_orders (
  id bigint generated always as identity primary key,
  order_item_id text,
  order_id text,
  report_date date,
  order_datetime text,
  order_status text,
  sku text,
  fsn text,
  product_name text,
  quantity integer,
  tracking_id text,
  raw jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.barm_daily_ms_barm_ads (
  id bigint generated always as identity primary key,
  report_date date,
  campaign_name text,
  product_name text,
  sku text,
  spend numeric,
  views integer,
  clicks integer,
  orders_by_ad integer,
  raw jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.barm_daily_ms_mw_ads (
  id bigint generated always as identity primary key,
  report_date date,
  campaign_name text,
  product_name text,
  sku text,
  spend numeric,
  views integer,
  clicks integer,
  orders_by_ad integer,
  raw jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.barm_daily_ms_barm_orders (
  id bigint generated always as identity primary key,
  order_status text,
  sub_order_no text,
  catalog_id text,
  report_date date,
  order_source text,
  customer_state text,
  product_name text,
  sku text,
  size text,
  quantity integer,
  listed_price numeric,
  discounted_price numeric,
  packet_id text,
  raw jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.barm_daily_ms_mw_orders (
  id bigint generated always as identity primary key,
  order_status text,
  sub_order_no text,
  catalog_id text,
  report_date date,
  order_source text,
  customer_state text,
  product_name text,
  sku text,
  size text,
  quantity integer,
  listed_price numeric,
  discounted_price numeric,
  packet_id text,
  raw jsonb,
  created_at timestamptz not null default now()
);

create index if not exists barm_daily_am_ads_date_idx on public.barm_daily_am_ads (report_date);
create index if not exists barm_daily_am_ads_sku_idx on public.barm_daily_am_ads (sku);
create index if not exists barm_daily_am_orders_date_idx on public.barm_daily_am_orders (report_date);
create index if not exists barm_daily_am_orders_order_id_idx on public.barm_daily_am_orders (order_id);
create index if not exists barm_daily_fk_ads_date_idx on public.barm_daily_fk_ads (report_date);
create index if not exists barm_daily_fk_ads_sku_idx on public.barm_daily_fk_ads (sku);
create index if not exists barm_daily_fk_orders_date_idx on public.barm_daily_fk_orders (report_date);
create index if not exists barm_daily_fk_orders_order_item_idx on public.barm_daily_fk_orders (order_item_id);
create index if not exists barm_daily_ms_barm_ads_date_idx on public.barm_daily_ms_barm_ads (report_date);
create index if not exists barm_daily_ms_mw_ads_date_idx on public.barm_daily_ms_mw_ads (report_date);
create index if not exists barm_daily_ms_barm_orders_date_idx on public.barm_daily_ms_barm_orders (report_date);
create index if not exists barm_daily_ms_barm_orders_sub_order_idx on public.barm_daily_ms_barm_orders (sub_order_no);
create index if not exists barm_daily_ms_mw_orders_date_idx on public.barm_daily_ms_mw_orders (report_date);
create index if not exists barm_daily_ms_mw_orders_sub_order_idx on public.barm_daily_ms_mw_orders (sub_order_no);

alter table public.barm_daily_am_ads disable row level security;
alter table public.barm_daily_am_orders disable row level security;
alter table public.barm_daily_fk_ads disable row level security;
alter table public.barm_daily_fk_orders disable row level security;
alter table public.barm_daily_ms_barm_ads disable row level security;
alter table public.barm_daily_ms_mw_ads disable row level security;
alter table public.barm_daily_ms_barm_orders disable row level security;
alter table public.barm_daily_ms_mw_orders disable row level security;

grant select, insert, update, delete on public.barm_daily_am_ads to anon;
grant select, insert, update, delete on public.barm_daily_am_orders to anon;
grant select, insert, update, delete on public.barm_daily_fk_ads to anon;
grant select, insert, update, delete on public.barm_daily_fk_orders to anon;
grant select, insert, update, delete on public.barm_daily_ms_barm_ads to anon;
grant select, insert, update, delete on public.barm_daily_ms_mw_ads to anon;
grant select, insert, update, delete on public.barm_daily_ms_barm_orders to anon;
grant select, insert, update, delete on public.barm_daily_ms_mw_orders to anon;
grant usage, select on all sequences in schema public to anon;
