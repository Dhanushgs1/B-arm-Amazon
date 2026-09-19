-- Google (direct/website) orders upload table — run this ONCE in the Supabase
-- SQL Editor for the project this app uses (see .env.local's
-- NEXT_PUBLIC_SUPABASE_URL), same as scripts/meesho_tables.sql.
--
-- barm_daily_google_orders <- the seller's own hand-kept "B-Arm Orders" workbook for
--                        direct/Google-driven sales that don't come through
--                        Amazon, Flipkart or Meesho (S no, Invoice, Product,
--                        Qty, Price columns — no date column, no ad-spend
--                        figure of any kind: this channel has no ad campaign
--                        data, only realised orders). Feeds the Ad Spend
--                        Report's "Google" Summary row (Overall Sales
--                        QTS/Value = sum(Quantity) / sum(Quantity x Price))
--                        and the Ad spend report sheet's Google section.
--
-- RLS disabled and explicit grants to anon, same as every other barm_* upload
-- table — this app talks to Supabase with the anon key and no auth session.
create table if not exists public.barm_daily_google_orders (
  id bigint generated always as identity primary key,
  serial_no integer,
  invoice text not null,
  product_name text,
  quantity integer,
  price numeric,
  raw jsonb,
  created_at timestamptz not null default now(),
  -- Invoice numbers are unique per line item across every "B-Arm Orders" file
  -- the seller has shared so far — upserting on it means re-uploading a file
  -- that overlaps a previous one (or re-uploading the same file twice)
  -- converges to the same rows instead of double-counting Quantity/Price.
  unique (invoice)
);

create index if not exists barm_daily_google_orders_product_idx on public.barm_daily_google_orders (product_name);

alter table public.barm_daily_google_orders disable row level security;
grant select, insert, update, delete on public.barm_daily_google_orders to anon;
grant usage, select on all sequences in schema public to anon;
