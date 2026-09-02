-- Master Product Marketing table — run this ONCE in the Supabase SQL Editor
-- for the project this app uses (see .env.local's NEXT_PUBLIC_SUPABASE_URL).
--
-- master_product_marketing <- the seller's marketing team's "Master SKU sheet
-- with Category" workbook (Product, Product name, SKU ID, Platforms,
-- Category) — one row per SKU *variant* per platform (the same SKU code can
-- repeat across several platform rows for one product, e.g. "SCGSB1" used by
-- both Flipkart and Amazon). A full snapshot re-uploaded whenever the
-- workbook is rebuilt (see src/lib/productMarketingUpload.ts) — no date
-- column, so each upload truncates and replaces the whole table rather than
-- merging, same pattern as barm_product_master (scripts/product_master_table.sql).
--
-- This is the freshest, most current master the marketing team maintains —
-- report exporters check it FIRST when resolving a product's display
-- name/category for a SKU, ahead of master_product_skuid and
-- barm_product_master.
--
-- Same RLS/grants pattern as every other barm_*/master_* table this app
-- writes to — the app talks to Supabase with the anon key and no auth
-- session, so RLS must be off with explicit grants.

create table if not exists public.master_product_marketing (
  id bigint generated always as identity primary key,
  product text,
  product_name text not null,
  sku text not null,
  platform text,
  category text,
  raw jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists master_product_marketing_sku_idx on public.master_product_marketing (sku);
create index if not exists master_product_marketing_product_name_idx on public.master_product_marketing (product_name);

alter table public.master_product_marketing enable row level security;
drop policy if exists master_product_marketing_anon_all on public.master_product_marketing;
create policy master_product_marketing_anon_all on public.master_product_marketing
  for all to anon using (true) with check (true);
grant select, insert, update, delete on public.master_product_marketing to anon;
grant usage, select on all sequences in schema public to anon;
