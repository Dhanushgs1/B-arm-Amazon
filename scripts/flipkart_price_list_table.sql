-- Flipkart Price List table — run this ONCE in the Supabase SQL Editor
-- for the project this app uses (see .env.local's NEXT_PUBLIC_SUPABASE_URL).
--
-- flipkart_price_list <- the seller's own manual "Price List.xlsx" master
-- workbook (all marketplaces in one sheet, tagged by a "(FK)"/"(AM)"/etc.
-- suffix on the SKU column) — filtered to the Flipkart-tagged rows only,
-- keyed on the base SKU with that suffix stripped.
--
-- This is DELIBERATELY a separate table from barm_flipkart_listings:
-- barm_flipkart_listings is Flipkart's own official "Listings (price/stock)"
-- export, uploaded via the app's Upload page, and that upload truncates and
-- fully replaces the table every time (FULL_REPLACE_TYPES in
-- flipkartReportUpload.ts). Writing this manual master-file data into that
-- table would get silently wiped the next time the real Listings report is
-- uploaded. flipkart_price_list instead persists independently, the same
-- role meesho_price_marketing (scripts/meesho_price_marketing_table.sql)
-- plays for Meesho, and is checked as one more fallback tier in the Flipkart
-- price precedence (fetchFlipkartProducts in adSpendReportExport.ts).
--
-- Same RLS/grants pattern as meesho_price_marketing / barm_flipkart_listings
-- — the app/scripts talk to Supabase with the anon key and no auth session,
-- so RLS must be off with explicit grants.

create table if not exists public.flipkart_price_list (
  id bigint generated always as identity primary key,
  sku_id text not null,
  product_name text not null,
  price numeric,
  price_updated_at timestamptz,
  created_at timestamptz not null default now(),
  unique (sku_id)
);

create index if not exists flipkart_price_list_sku_id_idx on public.flipkart_price_list (sku_id);

alter table public.flipkart_price_list disable row level security;
grant select, insert, update, delete on public.flipkart_price_list to anon;
grant usage, select on all sequences in schema public to anon;
