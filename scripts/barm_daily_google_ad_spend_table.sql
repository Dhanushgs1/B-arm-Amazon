-- Google Ads spend upload table — run this ONCE in the Supabase SQL Editor for the project this app
-- uses (see .env.local's NEXT_PUBLIC_SUPABASE_URL), same as scripts/barm_daily_social_media_table.sql.
--
-- barm_daily_google_ad_spend <- Google Ads "Campaign report" export, dropped on the Upload page's
--                               Google card (src/lib/googleOrdersUpload.ts → uploadGoogleFile).
--                               One row per campaign: its per-network lines (Google Search, Search
--                               partners, YouTube …) summed, every "Total: …" line skipped (see
--                               src/lib/googleAdSpendRules.ts). The lines themselves are kept in raw.
--
-- report_start/report_end are stored separately, same reasoning as barm_daily_social_media: a
-- single-day export and a 7-day export for the same campaign coexist as distinct rows, and the Ad
-- Spend Report's Google row prefers the row matching its exact window (see fetchWindowedAdSpend in
-- adSpendReportExport.ts) — never double-counting.

create table if not exists public.barm_daily_google_ad_spend (
  id bigint generated always as identity primary key,
  report_start date not null,
  report_end date not null,
  campaign_name text not null,
  spend numeric not null default 0,
  clicks integer,
  conversions numeric,
  conv_value numeric,
  currency text,
  raw jsonb,
  created_at timestamptz not null default now(),
  unique (report_start, report_end, campaign_name)
);

create index if not exists barm_daily_google_ad_spend_report_start_idx on public.barm_daily_google_ad_spend (report_start);
create index if not exists barm_daily_google_ad_spend_report_end_idx on public.barm_daily_google_ad_spend (report_end);

alter table public.barm_daily_google_ad_spend disable row level security;
grant select, insert, update, delete on public.barm_daily_google_ad_spend to anon;
grant usage, select on all sequences in schema public to anon;
