-- Product Master table — run this ONCE in the Supabase SQL Editor for the
-- project this app uses (see .env.local's NEXT_PUBLIC_SUPABASE_URL).
--
-- Mirrors the barm_amazon_*/barm_flipkart_*/barm_meesho_* tables (RLS
-- disabled, explicit grants to anon) since this app talks to Supabase with
-- the anon key and no auth session — see scripts/meesho_tables.sql for the
-- same pattern.
--
-- barm_product_master <- the seller's own hand-maintained "Product Master"
--                         workbook's "Product Master" sheet (Master SKU ID,
--                         Approved Product Name, Category, ...). A full
--                         snapshot re-uploaded whenever the workbook is
--                         rebuilt (see src/lib/productMasterUpload.ts) — no
--                         date column, so each upload truncates and replaces
--                         the whole table rather than merging.
--
-- src/lib/adSpendReportExport.ts checks this table FIRST when resolving a
-- product's display name for a SKU, ahead of the order-report/price-listing
-- derived name and the old hand-maintained SKU_NAME_MAP in categoryMap.ts —
-- this is the one the seller's team actually curates and approves.

create table if not exists public.barm_product_master (
  sku text primary key,
  product_name text not null,
  category text,
  approval_status text,
  raw jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists barm_product_master_product_name_idx on public.barm_product_master (product_name);

alter table public.barm_product_master disable row level security;
grant select, insert, update, delete on public.barm_product_master to anon;
