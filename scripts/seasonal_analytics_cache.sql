-- Seasonal Analytics cache. seasonal_sales_daily() (seasonal_analytics_daily.sql) reads
-- product_forecast_summary_live_v, which alone takes ~6-7s to compute — past the anon role's
-- statement timeout. Same answer as forecast_snapshot_tick/refresh_forecast_snapshot: build the
-- payload in the background and serve the stored copy.
--
-- Refresh trigger: piggybacks on forecast_snapshot_state.refreshed_at, which the existing
-- forecast tick already advances whenever source data changes, the date window changes, refresh is
-- pressed, or hourly. So this cache is never more than ~1 minute behind the forecast snapshot and
-- never rebuilds when nothing upstream changed.

create table if not exists public.seasonal_sales_cache (
  id                     int primary key default 1 check (id = 1),
  payload                jsonb not null,
  refreshed_at           timestamptz not null,
  built_from_forecast_at timestamptz,
  last_duration_ms       int,
  last_error             text,
  last_error_at          timestamptz
);
alter table public.seasonal_sales_cache enable row level security;
revoke all on public.seasonal_sales_cache from anon, authenticated;

-- The heavy builder is internal only.
revoke execute on function public.seasonal_sales_daily() from public, anon, authenticated;

create or replace function public.refresh_seasonal_sales_cache()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  t0  timestamptz := clock_timestamp();
  fc  timestamptz;
  p   jsonb;
begin
  if not pg_try_advisory_xact_lock(hashtext('seasonal_sales_cache')) then
    return 'busy';
  end if;
  select refreshed_at into fc from forecast_snapshot_state where id = 1;
  begin
    p := seasonal_sales_daily();
    -- Zero SKUs is never real: a source was caught mid-reload. Keep the last good payload.
    if jsonb_array_length(coalesce(p->'skus', '[]')) = 0 then
      raise exception 'seasonal_sales_daily returned 0 SKUs; kept previous cache';
    end if;
    insert into seasonal_sales_cache (id, payload, refreshed_at, built_from_forecast_at, last_duration_ms, last_error, last_error_at)
    values (1, p, t0, fc, (extract(epoch from clock_timestamp() - t0) * 1000)::int, null, null)
    on conflict (id) do update
      set payload = excluded.payload, refreshed_at = excluded.refreshed_at,
          built_from_forecast_at = excluded.built_from_forecast_at,
          last_duration_ms = excluded.last_duration_ms, last_error = null, last_error_at = null;
    return 'refreshed';
  exception when others then
    update seasonal_sales_cache set last_error = sqlerrm, last_error_at = clock_timestamp() where id = 1;
    return 'error: ' || sqlerrm;
  end;
end $$;

create or replace function public.seasonal_sales_tick()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  c  record;
  fc timestamptz;
begin
  select refreshed_at into fc from forecast_snapshot_state where id = 1;
  select built_from_forecast_at, refreshed_at into c from seasonal_sales_cache where id = 1;
  if not found
     or (fc is not null and fc is distinct from c.built_from_forecast_at)
     or c.refreshed_at < now() - interval '2 hours' then
    return refresh_seasonal_sales_cache();
  end if;
  return 'fresh';
end $$;

-- Read path for the dashboard API route (anon key, server side).
create or replace function public.get_seasonal_sales_cache()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select payload || jsonb_build_object('cache_refreshed_at', refreshed_at, 'cache_error', last_error)
  from seasonal_sales_cache where id = 1
$$;

revoke execute on function public.refresh_seasonal_sales_cache() from public, anon, authenticated;
revoke execute on function public.seasonal_sales_tick() from public, anon, authenticated;
grant execute on function public.get_seasonal_sales_cache() to anon, authenticated;

select cron.schedule('seasonal-sales-tick', '* * * * *', 'select public.seasonal_sales_tick()');
