-- scripts/ad_spend_report_catchup.sql
-- "Data irundhaa auto-generate": replaces the fixed 04:00 UTC daily-ad-spend-report-generate job
-- (scripts/ad_spend_report_pg_cron.sql) with a catch-up that runs every 30 minutes and generates a
-- report for any recent day whose source data is on file but whose report is missing or older
-- than that data. This covers:
--   - days the daily job never generated (it failed on a statement timeout, or — from 30 Sep 2026 —
--     was rejected with 401 because its call carried no x-m360-internal header), and
--   - days generated BEFORE that day's ad/order upload landed (the 09:30 IST run often beat the
--     upload, saving Day = 0 and a short 7D), e.g. report 2026-09-18 saved 09-19 09:30, ads
--     uploaded 09-22 15:08.
--
-- A report date R is stale when, within the last 14 IST days up to yesterday:
--   - at least one platform's ad data for R itself is uploaded (so a day is never generated empty), and
--   - R has never been saved, or Amazon Sponsored Products / Flipkart ad data for any day in R's
--     7-day window (R-6 .. R) was uploaded after R's last save.
-- Only those two tables count as "new data": each day's rows are inserted once. The daily
-- "Last 7 days" upload re-inserts the previous 7 days of orders and Meesho ads every time, so
-- their created_at would mark 7 dates stale after every single upload.
-- "Last save" = newest of: barm_ad_spend_history.created_at, a completed job's completed_at,
-- daily_ad_spend_reports.updated_at. A date that had any job activity in the last 50 minutes is
-- skipped, so one in flight (or one that just failed) is not fired again on the next tick.
--
-- One date per tick (newest first), so ticks never stack several heavy generations at once — the
-- old daily job hit statement timeouts. Regenerating a past date never sends email: ad-spend
-- email is manual-only (src/pages/api/cron/scheduled-reports.ts).
--
-- Needs the Edge Functions' shared secret in Vault (same value as INTERNAL_API_SECRET):
--   select vault.create_secret('<INTERNAL_API_SECRET>', 'internal_api_secret');
-- Until it exists, ad_spend_catchup_tick() returns without calling anything.

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.ad_spend_stale_report_dates(p_days int default 14)
returns table (report_date date, raw_uploaded_at timestamptz, saved_at timestamptz)
language sql
stable
security definer
set search_path to 'public'
as $$
  with days as (
    select d::date as r
    from generate_series((now() at time zone 'Asia/Kolkata')::date - p_days,
                         (now() at time zone 'Asia/Kolkata')::date - 1,
                         interval '1 day') d
  ), s as (
    select
      r,
      (exists (select 1 from barm_amazon_sp_advertised_product x where x.report_date = r)
        or exists (select 1 from barm_flipkart_fsn_report x where x.report_date = r)
        or exists (select 1 from barm_daily_ms_barm_ads x where x.report_date = r)) as has_ads,
      greatest(
        (select max(created_at) from barm_amazon_sp_advertised_product x where x.report_date between r - 6 and r),
        (select max(created_at) from barm_flipkart_fsn_report x where x.report_date between r - 6 and r)
      ) as raw_at,
      greatest(
        (select max(created_at) from barm_ad_spend_history h where h.report_date = r),
        (select max(completed_at) from report_generation_jobs j
          where j.report_date = r and j.report_type = 'ad_spend_daily' and j.status = 'completed'),
        (select max(updated_at) from daily_ad_spend_reports a where a.report_date = r)
      ) as saved
    from days
  )
  select s.r, s.raw_at, s.saved
  from s
  where s.has_ads
    and (s.saved is null or s.raw_at > s.saved)
    and not exists (
      select 1 from report_generation_jobs j
      where j.report_date = s.r and j.report_type = 'ad_spend_daily'
        and j.updated_at > now() - interval '50 minutes')
  order by s.r desc;
$$;

create or replace function public.ad_spend_catchup_tick()
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_secret text;
  v_date   date;
  v_job    bigint;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'internal_api_secret';
  if v_secret is null then
    return 'skipped: no internal_api_secret in vault';
  end if;

  select report_date into v_date from public.ad_spend_stale_report_dates(14) limit 1;
  if v_date is null then
    return 'nothing stale';
  end if;

  -- Reuses the date's existing job row (e.g. one left "pending" by a rejected call).
  insert into report_generation_jobs (report_date, report_type, status)
  values (v_date, 'ad_spend_daily', 'pending')
  on conflict (report_date, report_type, account_name) do update
     set status = 'pending', error_message = null, updated_at = now()
  returning id into v_job;

  perform net.http_post(
    url := 'https://zslujuqitousvywjzqwc.functions.supabase.co/generate-ad-spend-report',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-m360-internal', v_secret),
    body := jsonb_build_object('job_id', v_job, 'report_date', v_date)
  );
  return 'queued ' || v_date || ' (job ' || v_job || ')';
end;
$$;

revoke all on function public.ad_spend_stale_report_dates(int) from public, anon, authenticated;
revoke all on function public.ad_spend_catchup_tick() from public, anon, authenticated;

-- The catch-up covers yesterday too, as soon as its data is uploaded, so the fixed daily job goes.
select cron.unschedule('daily-ad-spend-report-generate')
where exists (select 1 from cron.job where jobname = 'daily-ad-spend-report-generate');

select cron.schedule('ad-spend-report-catchup', '*/30 * * * *', $$select public.ad_spend_catchup_tick()$$);
