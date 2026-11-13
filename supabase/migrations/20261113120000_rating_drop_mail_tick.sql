-- Rating drop mail trigger (user, 2026-11-13). The weekly ratings collector writes straight to
-- Supabase (product_rating_review_metrics -> trigger -> product_rating_review_history); nothing is
-- uploaded on the dashboard, so nothing told the app that new data was in. This tick does:
-- every 30 minutes, if a channel's newest snapshot is this week's, has not been mailed, has a
-- previous snapshot to compare with, and no row of it was written in the last 60 minutes, it calls
-- the dashboard's /api/rating-drop-alert, which works out the drops, sends the mail and records the
-- snapshot in barm_alert_state (so the next tick finds nothing to do).
--
-- Mirrors the checks in src/lib/ratingDropAlert.ts (7-day age, 60-minute settle, status buckets) —
-- keep the two in step. The route repeats every check itself; this is only the cheap "is there
-- anything to ask about" test, so a quiet week costs one small query per tick and no HTTP call.
-- Off unless Settings has Email alerts and Rating Drop switched on for slot B.

create or replace function public.rating_drop_mail_tick()
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_secret   text;
  v_settings jsonb;
  v_today    date := (now() at time zone 'Asia/Kolkata')::date;
  v_pending  text;
  v_arriving text;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'internal_api_secret';
  if v_secret is null then
    return 'skipped: no internal_api_secret in vault';
  end if;

  select settings into v_settings from public.email_settings where key_slot = 'B';
  if v_settings is null
     or coalesce((v_settings->>'emailAlerts')::boolean, false) is not true
     or coalesce((v_settings->>'ratingDropAlerts')::boolean, true) is not true
     or coalesce(v_settings->>'notifEmail', '') = ''
     or coalesce(v_settings->>'amazonAccountId', '') = ''
     or coalesce(v_settings->>'workspaceId', '') = '' then
    return 'skipped: rating drop mail is off in Settings';
  end if;

  with dates as (          -- every snapshot date of each real channel
    select platform, snapshot_date, sum(rated_count) as rated
      from public.product_rating_review_weekly
     where lower(btrim(platform)) not in ('deleted', 'old', 'sku changed', 'no sku', 'unknown')
     group by platform, snapshot_date
  ), ranked as (
    select platform, snapshot_date, rated,
           row_number() over (partition by platform order by snapshot_date desc) as rn,
           count(*)     over (partition by platform)                             as n
      from dates
  ), legacy as (           -- plain-date state rows (before 2026-10-25) cover every channel up to that date
    select coalesce(max(entity_id), '') as last_date
      from public.barm_alert_state
     where key_slot = 'B' and alert_type = 'ratingDropWeekly' and entity_id ~ '^\d{4}-\d{2}-\d{2}$'
  ), fresh as (            -- newest snapshot per channel: this week's, comparable, not mailed yet
    select r.platform, r.snapshot_date,
           (select max(h.captured_at) from public.product_rating_review_history h
             where h.platform = r.platform and h.snapshot_date = r.snapshot_date) as last_write
      from ranked r, legacy l
     where r.rn = 1 and r.n >= 2 and r.rated > 0
       and v_today - r.snapshot_date between 0 and 7
       and r.snapshot_date::text > l.last_date
       and not exists (select 1 from public.barm_alert_state s
                        where s.key_slot = 'B' and s.alert_type = 'ratingDropWeekly'
                          and s.entity_id = r.platform || '|' || r.snapshot_date::text)
  )
  select string_agg(platform || ' ' || snapshot_date, ', ' order by platform),
         string_agg(platform, ', ' order by platform)
           filter (where last_write is not null and last_write > now() - interval '60 minutes')
    into v_pending, v_arriving
    from fresh;

  if v_pending is null then
    return 'nothing new';
  end if;
  if v_arriving is not null then
    return 'waiting: still arriving for ' || v_arriving;
  end if;

  perform net.http_post(
    url := 'https://amazon-ppc-analytics-dashboard.vercel.app/api/rating-drop-alert',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-m360-internal', v_secret),
    body := jsonb_strip_nulls(jsonb_build_object(
      'slot', 'B',
      'amazon_account_id', v_settings->>'amazonAccountId',
      'workspace_id', v_settings->>'workspaceId',
      'to', v_settings->>'notifEmail',
      'cc', nullif(v_settings->>'ccEmail', '')
    )),
    timeout_milliseconds := 120000
  );
  return 'asked the dashboard to mail: ' || v_pending;
end;
$function$;

revoke all on function public.rating_drop_mail_tick() from public, anon, authenticated;

-- Every 30 minutes. Replaces any earlier schedule of the same name.
select cron.unschedule(jobid) from cron.job where jobname = 'rating-drop-mail';
select cron.schedule('rating-drop-mail', '*/30 * * * *', 'select public.rating_drop_mail_tick()');
