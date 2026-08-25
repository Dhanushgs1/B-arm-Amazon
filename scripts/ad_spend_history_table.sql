-- Ad Spend Report history — run this ONCE in the Supabase SQL Editor for the
-- project this app uses (see .env.local's NEXT_PUBLIC_SUPABASE_URL).
--
-- Every time the Ad Spend Report is generated (either by clicking "Generate &
-- Download" on the Download page, or by the daily cron job at
-- src/pages/api/cron/ad-spend-history.ts), one row per product per platform
-- is upserted here — a running history of Spend/Orders/CPC/ACOS you can query
-- or chart later, independent of any single downloaded .xlsx file.
--
-- Same RLS/grants pattern as every other barm_* table this app writes to (see
-- scripts/fix_flipkart_listings_rls.sql) — the app talks to Supabase with the
-- anon key and no auth session, so RLS must be off with explicit grants.

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

create index if not exists barm_ad_spend_history_report_date_idx on public.barm_ad_spend_history (report_date);
create index if not exists barm_ad_spend_history_platform_sku_idx on public.barm_ad_spend_history (platform, sku);

alter table public.barm_ad_spend_history disable row level security;
grant select, insert, update, delete on public.barm_ad_spend_history to anon;
grant usage, select on all sequences in schema public to anon;
