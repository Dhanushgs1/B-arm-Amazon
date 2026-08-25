-- Meesho upload tables — run this ONCE in the Supabase SQL Editor for the
-- project this app uses (see .env.local's NEXT_PUBLIC_SUPABASE_URL).
--
-- Mirrors the barm_amazon_* / barm_flipkart_* tables src/lib/amazonReportUpload.ts
-- and src/lib/flipkartReportUpload.ts already write to: RLS disabled and
-- explicit grants to anon, because this app talks to Supabase with the anon
-- key and no auth session (see scripts/fix_flipkart_listings_rls.sql for the
-- same fix applied to barm_flipkart_listings).
--
-- barm_meesho_ads   <- Meesho Ads Manager campaign-performance export
--                      (Date, Campaign name, Product, SKU ID, Spend, Views,
--                      Clicks, Orders by ad).
-- barm_meesho_orders <- Meesho order/payment report, line-item level
--                      (Reason for Credit Entry, Sub Order No, Catalog ID,
--                      Order Date, Order source, Customer State, Product Name,
--                      SKU, Size, Quantity, Supplier Listed Price, Supplier
--                      Discounted Price, Packet Id).
--
-- Column names/shapes here come from the seller's own hand-assembled "Last 7
-- days" workbook (its "MS BARM ads" / "MS BARM ord" sheets), not a native
-- Meesho export seen directly — if Meesho's own downloaded file uses
-- different header text, src/lib/meeshoReportUpload.ts's column matching may
-- need adjusting, but this table shape should still hold.

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

create index if not exists barm_meesho_ads_report_date_idx on public.barm_meesho_ads (report_date);
create index if not exists barm_meesho_ads_sku_idx on public.barm_meesho_ads (sku);
create index if not exists barm_meesho_orders_order_date_idx on public.barm_meesho_orders (order_date);
create index if not exists barm_meesho_orders_sku_idx on public.barm_meesho_orders (sku);

alter table public.barm_meesho_ads disable row level security;
alter table public.barm_meesho_orders disable row level security;
grant select, insert, update, delete on public.barm_meesho_ads to anon;
grant select, insert, update, delete on public.barm_meesho_orders to anon;
grant usage, select on all sequences in schema public to anon;
