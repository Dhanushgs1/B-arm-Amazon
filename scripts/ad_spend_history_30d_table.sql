-- 30-day companion to barm_ad_spend_history (scripts/ad_spend_history_table.sql).
--
-- barm_ad_spend_history stores each report's Day and 7D figures. Summing its day_* values does NOT
-- give a correct 30D figure: a report saved before that day's ad data was uploaded stores Day = 0
-- (e.g. report dates 2026-09-18..20), while its 7D figures are right. So the 30D figures are
-- computed by the same report code (saveAdSpendHistory in src/lib/adSpendReportExport.ts, same
-- spendTax/computeCpc/acosCell formulas) over the 30 days ending on report_date and stored here,
-- one row per report_date/platform/sku. Kept as its own table so barm_ad_spend_history itself is
-- left untouched.
--
-- acos_interval_summary_v (scripts/acos_intervals_table.sql) joins this table on "Report Date".

create table if not exists public.barm_ad_spend_history_30d (
  id bigint generated always as identity primary key,
  report_date date not null,
  range30_start date not null,
  platform text not null,
  sku text not null,
  product_name text,
  price numeric,
  spend numeric,
  spend_tax numeric,
  orders integer,
  cpc numeric,
  acos numeric,
  created_at timestamptz not null default now(),
  unique (report_date, platform, sku)
);

create index if not exists barm_ad_spend_history_30d_report_date_idx on public.barm_ad_spend_history_30d (report_date);

alter table public.barm_ad_spend_history_30d disable row level security;
grant select, insert, update, delete on public.barm_ad_spend_history_30d to anon, authenticated;
grant usage, select on all sequences in schema public to anon;
