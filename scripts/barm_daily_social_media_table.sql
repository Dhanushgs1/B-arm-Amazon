-- Social Media (Meta Ads) upload table — run this ONCE in the Supabase SQL
-- Editor for the project this app uses (see .env.local's
-- NEXT_PUBLIC_SUPABASE_URL).
--
-- Same shape/reasoning as scripts/meesho_tables.sql: RLS disabled and
-- explicit grants to anon, because this app talks to Supabase with the anon
-- key and no auth session.
--
-- barm_daily_social_media <- Meta Ads Manager "Raw Data Report" export
--                             (Campaign name, Currency, Amount spent (INR),
--                             Reporting starts, Reporting ends). The blank-
--                             campaign-name "Total" row Meta includes in every
--                             export is skipped by src/lib/socialMediaReportUpload.ts,
--                             not stored here.
--
-- report_start/report_end are stored separately (not collapsed to a single
-- report_date) because Meta's export can cover either a single day
-- (report_start = report_end) or a multi-day range (e.g. "last 7 days") —
-- keeping both lets a single-day upload and a range upload for the same
-- campaign coexist as distinct rows instead of colliding, so the report can
-- prefer daily rows and only fall back to a range row when no daily data
-- exists for that exact window (see fetchSocialMediaAdSpend in
-- adSpendReportExport.ts) — never double-counting either way.

create table if not exists public.barm_daily_social_media (
  id bigint generated always as identity primary key,
  report_start date not null,
  report_end date not null,
  campaign_name text not null,
  spend numeric not null default 0,
  currency text,
  raw jsonb,
  created_at timestamptz not null default now(),
  unique (report_start, report_end, campaign_name)
);

create index if not exists barm_daily_social_media_report_start_idx on public.barm_daily_social_media (report_start);
create index if not exists barm_daily_social_media_report_end_idx on public.barm_daily_social_media (report_end);

alter table public.barm_daily_social_media disable row level security;
grant select, insert, update, delete on public.barm_daily_social_media to anon;
grant usage, select on all sequences in schema public to anon;
