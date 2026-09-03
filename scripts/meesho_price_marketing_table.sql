-- Meesho Price Marketing table — run this ONCE in the Supabase SQL Editor
-- for the project this app uses (see .env.local's NEXT_PUBLIC_SUPABASE_URL).
--
-- meesho_price_marketing <- "Meesho Product Links.xlsx" (Product, Product
-- link, SKU ID), one row per SKU. price is filled in separately by scraping
-- each product_link's live Meesho listing price.
--
-- Same RLS/grants pattern as barm_meesho_ads / barm_meesho_orders
-- (scripts/meesho_tables.sql) — the app/scripts talk to Supabase with the
-- anon key and no auth session, so RLS must be off with explicit grants.

create table if not exists public.meesho_price_marketing (
  id bigint generated always as identity primary key,
  sku_id text not null,
  product_name text not null,
  product_link text,
  price numeric,
  price_updated_at timestamptz,
  created_at timestamptz not null default now(),
  unique (sku_id)
);

create index if not exists meesho_price_marketing_sku_id_idx on public.meesho_price_marketing (sku_id);

alter table public.meesho_price_marketing disable row level security;
grant select, insert, update, delete on public.meesho_price_marketing to anon;
grant usage, select on all sequences in schema public to anon;
