-- barm_flipkart_earn_more — run this ONCE in the Supabase SQL Editor for the
-- project this app uses (see .env.local's NEXT_PUBLIC_SUPABASE_URL).
--
-- This table is missing entirely on the current Supabase project ("Could not
-- find the table 'public.barm_flipkart_earn_more' in the schema cache" on the
-- Flipkart Download page) — it holds the Growth > Earn more per-day, per-SKU
-- export (src/lib/flipkartReportUpload.ts's parseEarnMore), which
-- flipkartHistoricalReportExport.ts / adSpendReportExport.ts read for
-- price-fallback and mirrorEarnMoreToOverallSales() reads to populate
-- barm_flipkart_overall_sales. Its own upload card is hidden in the UI, but
-- the read side is still live, so the table has to exist even without a way
-- to upload new files through this app.
--
-- RLS disabled + explicit grants to anon, mirroring every other barm_* table
-- (see scripts/meesho_tables.sql / scripts/fix_rls_all_tables.sql) — this app
-- talks to Supabase with the anon key and no auth session.
--
-- No unique constraint: uploadFlipkartReportFile's save path for earn_more is
-- delete-the-uploaded-date-range-then-insert (see deleteDateRange +
-- insertInChunks in flipkartReportUpload.ts), not an upsert, so there's no
-- natural key to dedupe on the way the fsn_report/meesho tables have.

create table if not exists public.barm_flipkart_earn_more (
  id bigint generated always as identity primary key,
  order_date date,
  product_id text,
  sku_id text,
  category text,
  brand text,
  vertical text,
  fulfillment_type text,
  location_id text,
  gross_units integer,
  gmv numeric,
  cancellation_units integer,
  cancellation_amount numeric,
  return_units integer,
  return_amount numeric,
  final_sale_units integer,
  final_sale_amount numeric,
  raw jsonb,
  created_at timestamptz not null default now()
);

create index if not exists barm_flipkart_earn_more_order_date_idx on public.barm_flipkart_earn_more (order_date);
create index if not exists barm_flipkart_earn_more_sku_id_idx on public.barm_flipkart_earn_more (sku_id);

alter table public.barm_flipkart_earn_more disable row level security;
grant select, insert, update, delete on public.barm_flipkart_earn_more to anon;
grant usage, select on all sequences in schema public to anon;
