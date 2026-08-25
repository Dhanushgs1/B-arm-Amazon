-- barm_daily_ad_spend — run this ONCE in the Supabase SQL Editor for the
-- project this app uses (see .env.local's NEXT_PUBLIC_SUPABASE_URL).
--
-- This is a single, human-readable mirror of every sheet the "Ad Spend
-- Report — one-file upload" card (Upload page) reads from the seller's
-- combined "Last 7 days" workbook: one row per source row, tagged by
-- platform/sheet/date, with the handful of common fields (campaign, SKU,
-- spend, orders...) pulled out as real columns and everything else kept in
-- `raw` so nothing is lost.
--
-- IMPORTANT: this table is NOT what "Generate Ad Spend Report" (Download
-- page) reads from — that report still reads the existing barm_amazon_*/
-- barm_flipkart_*/barm_meesho_* tables, which is what the one-file upload
-- already feeds under the hood, unchanged. This table exists purely so the
-- upload has one plainly-named place to look at in Supabase to confirm "did
-- my file actually save" — it's a mirror/audit copy, not a second source of
-- truth. Re-running an upload for a date range that's already here replaces
-- those rows (platform + sheet + report_date), so nothing gets duplicated.

create table if not exists public.barm_daily_ad_spend (
  id bigint generated always as identity primary key,
  platform text not null,        -- 'amazon' | 'flipkart' | 'meesho'
  sheet text not null,           -- 'AM ads' | 'AM ord' | 'FK ads' | 'FK ord' | 'MS BARM ads' | 'MS BARM ord' | 'MS MW ads' | 'MS MW ord'
  report_date date,
  campaign_name text,
  product_name text,
  sku text,
  spend numeric,
  orders integer,
  units integer,
  sales numeric,
  raw jsonb,
  created_at timestamptz not null default now()
);

create index if not exists barm_daily_ad_spend_date_idx on public.barm_daily_ad_spend (report_date);
create index if not exists barm_daily_ad_spend_platform_sheet_idx on public.barm_daily_ad_spend (platform, sheet);
create index if not exists barm_daily_ad_spend_sku_idx on public.barm_daily_ad_spend (sku);

alter table public.barm_daily_ad_spend disable row level security;
grant select, insert, update, delete on public.barm_daily_ad_spend to anon;
grant usage, select on all sequences in schema public to anon;
