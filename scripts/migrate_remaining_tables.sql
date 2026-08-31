-- Remaining tables not yet in the new Supabase project — confirmed missing by actually
-- attempting a full data copy (old -> new) and seeing which inserts failed with "table not
-- found in schema cache". Run this ONCE in the new project's SQL Editor, then re-run the
-- data copy for just these tables.
--
-- Schema reverse-engineered from the actual upload code, same as every other migration
-- file: src/lib/amazonReportUpload.ts's mapOrderRow/mapAmReturnRow/mapFbaReturnRow/
-- mapPriceListingRow/mapSfReturnRow, src/lib/flipkartReportUpload.ts's parseOrderReport/
-- parseReturnsReport/parseListingsReport/mirrorFsnToCampaignPerformance/
-- mirrorEarnMoreToOverallSales, scripts/meesho_tables.sql, scripts/ad_spend_history_table.sql.
--
-- None of these need a unique() constraint — all are either "delete the covered date range,
-- then insert" (am_orders, am_returns, fba_returns, sf_return, order_report, returns) or
-- "truncate and fully replace on every upload" (price_listing, listings) — same reasoning as
-- fba_inventory/inventory_ledger in the earlier migration file.

-- ── Amazon: Orders report (raw per-order-line — the weekly report's ground truth source) ──
create table if not exists public.barm_amazon_am_orders (
  id bigint generated always as identity primary key,
  amazon_order_id text,
  order_item_id text,
  purchase_date date,
  purchase_datetime text,
  order_status text,
  fulfillment_channel text,
  sales_channel text,
  product_name text,
  sku text,
  asin text,
  item_status text,
  quantity integer,
  currency text,
  item_price numeric,
  item_tax numeric,
  shipping_price numeric,
  item_promotion_discount numeric,
  ship_city text,
  ship_state text,
  ship_postal_code text,
  raw jsonb,
  created_at timestamptz not null default now()
);

-- ── Amazon: Returns (return-requests) report ────────────────────────────────
create table if not exists public.barm_amazon_am_returns (
  id bigint generated always as identity primary key,
  order_id text,
  order_item_id text,
  order_date date,
  return_request_date date,
  return_request_status text,
  asin text,
  merchant_sku text,
  item_name text,
  return_quantity integer,
  return_reason text,
  in_policy text,
  return_type text,
  resolution text,
  order_amount numeric,
  order_quantity integer,
  category text,
  raw jsonb,
  created_at timestamptz not null default now()
);

-- ── Amazon: FBA customer returns ─────────────────────────────────────────────
create table if not exists public.barm_amazon_fba_returns (
  id bigint generated always as identity primary key,
  return_date timestamptz,
  order_id text,
  sku text,
  asin text,
  fnsku text,
  product_name text,
  quantity integer,
  fulfillment_center_id text,
  detailed_disposition text,
  reason text,
  license_plate_number text,
  customer_comments text,
  raw jsonb,
  created_at timestamptz not null default now()
);

-- ── Amazon: Price/All-Listings report ────────────────────────────────────────
create table if not exists public.barm_amazon_price_listing (
  id bigint generated always as identity primary key,
  seller_sku text,
  item_name text,
  price numeric,
  business_price numeric,
  quantity integer,
  fulfillment_channel text,
  asin1 text,
  item_condition text,
  status text,
  raw jsonb,
  created_at timestamptz not null default now()
);

-- ── Amazon: SellerFlex (SF) Returns ──────────────────────────────────────────
create table if not exists public.barm_amazon_sf_return (
  id bigint generated always as identity primary key,
  return_type text,
  customer_order_id text,
  shipment_id text,
  sku text,
  msku text,
  asin text,
  external_id_1 text,
  external_id_2 text,
  external_id_3 text,
  units integer,
  forward_leg_tracking_id text,
  reverse_leg_tracking_id text,
  rma_id text,
  return_status text,
  carrier text,
  pickup_date date,
  last_updated_on date,
  returned_with_otp text,
  days_in_transit integer,
  days_since_return_complete integer,
  raw jsonb,
  created_at timestamptz not null default now()
);

-- ── Amazon: hand-maintained campaign -> SKU mapping (empty on the old project too, ────
-- included for completeness so nothing errors if it's ever used) ────────────
create table if not exists public.barm_amazon_campaign_sku_map (
  id bigint generated always as identity primary key,
  campaign_name text,
  sku text,
  raw jsonb,
  created_at timestamptz not null default now()
);

-- ── Flipkart: Order report (order-item level) ────────────────────────────────
create table if not exists public.barm_flipkart_order_report (
  id bigint generated always as identity primary key,
  order_item_id text,
  order_id text,
  fulfilment_source text,
  fulfilment_type text,
  order_date date,
  order_datetime text,
  order_approval_date text,
  order_item_status text,
  sku text,
  fsn text,
  product_title text,
  quantity integer,
  delivery_logistics_partner text,
  pickup_logistics_partner text,
  delivery_tracking_id text,
  order_cancellation_date date,
  cancellation_reason text,
  cancellation_sub_reason text,
  order_return_approval_date date,
  return_id text,
  return_reason text,
  return_sub_reason text,
  dispatched_date date,
  order_delivery_date date,
  dispatch_sla_breached text,
  delivery_sla_breached text,
  raw jsonb,
  created_at timestamptz not null default now()
);

-- ── Flipkart: Returns report ──────────────────────────────────────────────────
create table if not exists public.barm_flipkart_returns (
  id bigint generated always as identity primary key,
  order_id text,
  order_item_id text,
  return_id text,
  sku text,
  fsn text,
  product_title text,
  total_price numeric,
  quantity integer,
  ff_type text,
  return_requested_date date,
  return_approval_date date,
  completed_date date,
  return_status text,
  completion_status text,
  return_type text,
  return_reason text,
  return_sub_reason text,
  location_name text,
  raw jsonb,
  created_at timestamptz not null default now()
);

-- ── Flipkart: Listings (Manage Listings) — current price/stock snapshot ─────
-- No `raw` column here — parseListingsReport doesn't keep one (see flipkartReportUpload.ts).
create table if not exists public.barm_flipkart_listings (
  id bigint generated always as identity primary key,
  listing_id text,
  seller_sku_id text,
  product_title text,
  selling_price numeric,
  mrp numeric,
  stock_count numeric,
  listing_status text,
  updated_at timestamptz not null default now()
);

-- ── Flipkart: campaign_performance mirror (derived from fsn_report on every upload) ──
create table if not exists public.barm_flipkart_campaign_performance (
  id bigint generated always as identity primary key,
  campaign_name text,
  campaign_type text,
  sku_id text,
  product_name text,
  product_title text,
  impressions integer,
  clicks integer,
  ad_spend numeric,
  total_revenue_rs numeric,
  direct_units integer,
  indirect_units integer,
  total_orders integer,
  report_date date,
  created_at timestamptz not null default now()
);

-- ── Flipkart: overall_sales mirror (derived from earn_more on every upload) ──
create table if not exists public.barm_flipkart_overall_sales (
  id bigint generated always as identity primary key,
  order_date date,
  sku_id text,
  seller_sku_id text,
  product_name text,
  product_title text,
  final_sale_amount numeric,
  final_sale_units integer,
  gmv numeric,
  gross_units integer,
  cancellation_units integer,
  return_units integer,
  created_at timestamptz not null default now()
);

-- ── Meesho ads/orders — verbatim from scripts/meesho_tables.sql ─────────────
create table if not exists public.barm_meesho_ads (
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
  created_at timestamptz not null default now(),
  unique (report_date, campaign_name, sku)
);

create table if not exists public.barm_meesho_orders (
  id bigint generated always as identity primary key,
  order_status text,
  sub_order_no text,
  catalog_id text,
  order_date date,
  order_source text,
  customer_state text,
  product_name text,
  sku text,
  size text,
  quantity integer,
  supplier_listed_price numeric,
  supplier_discounted_price numeric,
  packet_id text,
  raw jsonb,
  created_at timestamptz not null default now(),
  unique (sub_order_no)
);

-- ── Ad Spend Report history — verbatim from scripts/ad_spend_history_table.sql ──
create table if not exists public.barm_ad_spend_history (
  id bigint generated always as identity primary key,
  report_date date not null,
  range_start date not null,
  platform text not null,
  sku text not null,
  product_name text,
  price numeric,
  day_spend numeric,
  day_spend_tax numeric,
  day_orders integer,
  day_cpc numeric,
  day_acos numeric,
  range_spend numeric,
  range_spend_tax numeric,
  range_orders integer,
  range_cpc numeric,
  range_acos numeric,
  created_at timestamptz not null default now(),
  unique (report_date, platform, sku)
);

-- ── Ratings & Reviews base table (the 158k-row weekly tracker import) ────────
-- Columns from RawRow in src/lib/barmRatingReviewData.ts, PLUS `price` — confirmed by
-- actually attempting the data copy: the real old table has a `price` column that the
-- app's own .select(...) list omits (per that file's comment, populated on <1% of rows),
-- so it never showed up in the TypeScript interface. This is a base table (read AND
-- presumably written by a separate import process this session didn't find the write path
-- for) — unlike barm_rating_review_snapshots/barm_rating_review_weekly below.
create table if not exists public.barm_rating_review (
  id bigint generated always as identity primary key,
  product text,
  sku_id text,
  asin_fsn text,
  marketplace text,
  sku_suffix text,
  snapshot_date date not null,
  star_value numeric,
  ratings_count integer,
  reviews_count integer,
  raw_customers text,
  latch_on_seller text,
  price numeric,
  orders integer,
  returns_count integer,
  created_at timestamptz not null default now()
  -- No unique() here — confirmed by an actual failed insert partway through the real data
  -- copy that the old table has genuine duplicate (sku_id, marketplace, snapshot_date)
  -- combinations, so that assumed natural key was wrong. Left as a plain table.
);

-- ⚠️ NOT INCLUDED: barm_rating_review_snapshots and barm_rating_review_weekly.
-- These are only ever SELECTed in the app code (src/lib/barmRatingReviewData.ts), never
-- written to — strong evidence they're SQL VIEWS computed from barm_rating_review in the
-- old project, not physical tables with their own data. That's almost certainly why the
-- data-copy script couldn't write to them ("table not found"). Recreating a VIEW needs its
-- exact defining SQL query, which isn't visible from application code — please check the
-- old Supabase project's Table Editor (they'll be listed under "Views", not "Tables", if
-- this is right) and either paste me the view definition (Database -> Views -> the view's
-- "..." menu -> "Show definition SQL" in the Supabase dashboard) or confirm they're actual
-- tables instead, and I'll fix this file.

-- ── Indexes ──────────────────────────────────────────────────────────────────
create index if not exists barm_amazon_am_orders_date_idx on public.barm_amazon_am_orders (purchase_date);
create index if not exists barm_amazon_am_orders_order_idx on public.barm_amazon_am_orders (amazon_order_id);
create index if not exists barm_amazon_am_returns_date_idx on public.barm_amazon_am_returns (return_request_date);
create index if not exists barm_amazon_fba_returns_date_idx on public.barm_amazon_fba_returns (return_date);
create index if not exists barm_amazon_price_listing_sku_idx on public.barm_amazon_price_listing (seller_sku);
create index if not exists barm_amazon_sf_return_date_idx on public.barm_amazon_sf_return (pickup_date);
create index if not exists barm_flipkart_order_report_date_idx on public.barm_flipkart_order_report (order_date);
create index if not exists barm_flipkart_returns_date_idx on public.barm_flipkart_returns (return_requested_date);
create index if not exists barm_flipkart_listings_sku_idx on public.barm_flipkart_listings (seller_sku_id);
create index if not exists barm_flipkart_campaign_performance_date_idx on public.barm_flipkart_campaign_performance (report_date);
create index if not exists barm_flipkart_overall_sales_date_idx on public.barm_flipkart_overall_sales (order_date);
create index if not exists barm_meesho_ads_report_date_idx on public.barm_meesho_ads (report_date);
create index if not exists barm_meesho_orders_order_date_idx on public.barm_meesho_orders (order_date);
create index if not exists barm_ad_spend_history_report_date_idx on public.barm_ad_spend_history (report_date);
create index if not exists barm_rating_review_snapshot_date_idx on public.barm_rating_review (snapshot_date);
create index if not exists barm_rating_review_sku_idx on public.barm_rating_review (sku_id);

-- ── RLS + grants ──────────────────────────────────────────────────────────────
alter table public.barm_amazon_am_orders disable row level security;
alter table public.barm_amazon_am_returns disable row level security;
alter table public.barm_amazon_fba_returns disable row level security;
alter table public.barm_amazon_price_listing disable row level security;
alter table public.barm_amazon_sf_return disable row level security;
alter table public.barm_amazon_campaign_sku_map disable row level security;
alter table public.barm_flipkart_order_report disable row level security;
alter table public.barm_flipkart_returns disable row level security;
alter table public.barm_flipkart_listings disable row level security;
alter table public.barm_flipkart_campaign_performance disable row level security;
alter table public.barm_flipkart_overall_sales disable row level security;
alter table public.barm_meesho_ads disable row level security;
alter table public.barm_meesho_orders disable row level security;
alter table public.barm_ad_spend_history disable row level security;
alter table public.barm_rating_review disable row level security;

grant select, insert, update, delete on public.barm_amazon_am_orders to anon;
grant select, insert, update, delete on public.barm_amazon_am_returns to anon;
grant select, insert, update, delete on public.barm_amazon_fba_returns to anon;
grant select, insert, update, delete on public.barm_amazon_price_listing to anon;
grant select, insert, update, delete on public.barm_amazon_sf_return to anon;
grant select, insert, update, delete on public.barm_amazon_campaign_sku_map to anon;
grant select, insert, update, delete on public.barm_flipkart_order_report to anon;
grant select, insert, update, delete on public.barm_flipkart_returns to anon;
grant select, insert, update, delete on public.barm_flipkart_listings to anon;
grant select, insert, update, delete on public.barm_flipkart_campaign_performance to anon;
grant select, insert, update, delete on public.barm_flipkart_overall_sales to anon;
grant select, insert, update, delete on public.barm_meesho_ads to anon;
grant select, insert, update, delete on public.barm_meesho_orders to anon;
grant select, insert, update, delete on public.barm_ad_spend_history to anon;
grant select, insert, update, delete on public.barm_rating_review to anon;
grant usage, select on all sequences in schema public to anon;

-- ── Fix for barm_campaign_daily_snapshot (already exists in the new project, per the
-- data-copy attempt, but is missing a `created_at` column the old table has) ──────────
alter table public.barm_campaign_daily_snapshot add column if not exists created_at timestamptz not null default now();
