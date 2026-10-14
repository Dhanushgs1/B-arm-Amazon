-- Weekly Monday snapshot of the tool's Stock Purchase and Components numbers for the Consolidated
-- Stock Sheet (src/lib/consolidatedStock*.ts). The godown sheet is uploaded daily; in transit, order
-- placed, Suggested RFQ and the combo component needs stay fixed for the week, as captured on Monday
-- 10:00 IST (user, 2026-10-13). The schedule is in scripts/barm_weekly_restock_snapshot_cron.sql.
--
-- Read-only copy: the capture only reads product_forecast_rfq_v (which applies rfq_selection's
-- forecast period and manual override) and components_sheet. It never writes the tool's tables and
-- has nothing to do with send_schedule (the tool's own, disabled, Monday email).

-- One row per Monday: whether that week's copy exists. A week is captured once; later runs skip it.
create table if not exists public.barm_weekly_snapshot_runs (
  week_start      date        primary key check (extract(isodow from week_start) = 1),
  status          text        not null check (status in ('ok', 'failed')),
  captured_at     timestamptz,                -- when the 'ok' copy was taken
  rfq_rows        integer     not null default 0,
  component_rows  integer     not null default 0,
  attempts        integer     not null default 0,
  last_attempt_at timestamptz not null default now(),
  last_error      text
);

-- product_forecast_rfq_v, one row per product (its values are per product, repeated on every SKU row).
create table if not exists public.barm_weekly_rfq_snapshot (
  week_start             date    not null references public.barm_weekly_snapshot_runs (week_start) on delete cascade,
  product                text    not null,
  suggested_rfq_for      text    not null,      -- forecast period used (rfq_selection, default 180 days)
  suggested_rfq_override numeric,               -- manual RFQ from rfq_selection, if any
  suggested_rfq          numeric not null,      -- the tool's Suggested RFQ
  stock_intransit        numeric,
  order_placed           numeric,
  current_stock          numeric,               -- the tool's stock behind that RFQ (audit only)
  forecast_qty           numeric,               -- the chosen period's forecast (audit only)
  primary key (week_start, product)
);

-- components_sheet, row for row (the dashboard sums required qty and takes max stock per component,
-- exactly as the tool's Components export does).
create table if not exists public.barm_weekly_component_snapshot (
  week_start      date    not null references public.barm_weekly_snapshot_runs (week_start) on delete cascade,
  source_id       bigint  not null,             -- components_sheet.id
  component       text    not null,
  product         text,                         -- the product / combo the component goes into
  qty_per_unit    numeric,
  rfq             numeric,
  required_qty    numeric,                      -- "Required Component Quantity"
  component_stock numeric,                      -- "Current Stock" (blank stays null)
  stock_intransit numeric,
  order_placed    numeric,
  primary key (week_start, source_id)
);

-- Read-only for the dashboard (anon key); nobody but the capture function writes.
alter table public.barm_weekly_snapshot_runs enable row level security;
alter table public.barm_weekly_rfq_snapshot enable row level security;
alter table public.barm_weekly_component_snapshot enable row level security;
revoke all on public.barm_weekly_snapshot_runs, public.barm_weekly_rfq_snapshot, public.barm_weekly_component_snapshot from anon, authenticated;
grant select on public.barm_weekly_snapshot_runs, public.barm_weekly_rfq_snapshot, public.barm_weekly_component_snapshot to anon, authenticated;
drop policy if exists barm_weekly_snapshot_runs_read on public.barm_weekly_snapshot_runs;
drop policy if exists barm_weekly_rfq_snapshot_read on public.barm_weekly_rfq_snapshot;
drop policy if exists barm_weekly_component_snapshot_read on public.barm_weekly_component_snapshot;
create policy barm_weekly_snapshot_runs_read on public.barm_weekly_snapshot_runs for select to anon, authenticated using (true);
create policy barm_weekly_rfq_snapshot_read on public.barm_weekly_rfq_snapshot for select to anon, authenticated using (true);
create policy barm_weekly_component_snapshot_read on public.barm_weekly_component_snapshot for select to anon, authenticated using (true);

-- Takes this week's copy. Rules:
--  * only the current IST week, and not before its Monday 10:00 IST (a copy is "now"; it can never
--    stand in for an earlier week);
--  * once a week is 'ok' it is never touched again (duplicate runs return 'skipped');
--  * all or nothing: a failure keeps no partial rows, records status 'failed' and the error, and the
--    next run retries.
-- p_now exists for tests; the schedule calls it without arguments.
create or replace function public.barm_capture_weekly_snapshot(p_now timestamptz default now())
returns text
language plpgsql
security definer
set search_path = public
set statement_timeout = '300s'
as $$
declare
  v_local   timestamp := p_now at time zone 'Asia/Kolkata';
  v_week    date      := date_trunc('week', v_local)::date;          -- Monday of this IST week
  v_opens   timestamp := date_trunc('week', v_local) + interval '10 hours';
  v_run     public.barm_weekly_snapshot_runs%rowtype;
  v_rfq     integer;
  v_comp    integer;
  v_err     text;
begin
  if v_local < v_opens then
    return format('not yet: week %s opens at Monday 10:00 IST', v_week);
  end if;

  perform pg_advisory_xact_lock(hashtext('barm_capture_weekly_snapshot'));

  select * into v_run from public.barm_weekly_snapshot_runs where week_start = v_week;
  if found and v_run.status = 'ok' then
    return format('skipped: week %s already captured at %s', v_week, v_run.captured_at);
  end if;

  begin
    insert into public.barm_weekly_snapshot_runs (week_start, status, captured_at, attempts, last_attempt_at, last_error)
    values (v_week, 'ok', p_now, coalesce(v_run.attempts, 0) + 1, p_now, null)
    on conflict (week_start) do update
      set status = 'ok', captured_at = p_now, attempts = excluded.attempts, last_attempt_at = p_now, last_error = null;

    insert into public.barm_weekly_rfq_snapshot
      (week_start, product, suggested_rfq_for, suggested_rfq_override, suggested_rfq, stock_intransit, order_placed, current_stock, forecast_qty)
    select distinct on (v."Product")
           v_week, v."Product", v."Suggested RFQ For", s.suggested_rfq_override, v."Suggested RFQ",
           v."Stock intransit", v."Order placed", v."Current Stock",
           case v."Suggested RFQ For"
             when '45 days order forecast'  then v."45 days order forecast"
             when '60 days order forecast'  then v."60 days order forecast"
             when '90 days order forecast'  then v."90 days order forecast"
             when '120 days forecast'       then v."120 days forecast"
             when '150 days order forecast' then v."150 days order forecast"
             else                                v."180 days order forecast"
           end
      from public.product_forecast_rfq_v v
      left join public.rfq_selection s on s.product_name = v."Product"
     where v."Product" is not null
     order by v."Product";
    get diagnostics v_rfq = row_count;

    insert into public.barm_weekly_component_snapshot
      (week_start, source_id, component, product, qty_per_unit, rfq, required_qty, component_stock, stock_intransit, order_placed)
    select v_week, c.id, c."Components required", c."Product",
           public.js_number(c."Quantities required"), public.js_number(c."RFQ"),
           public.js_number(c."Required Component Quantity"), public.js_number(c."Current Stock"),
           public.js_number(c."Stock Intransit"), public.js_number(c."Order Placed")
      from public.components_sheet c
     where nullif(btrim(c."Components required"), '') is not null;
    get diagnostics v_comp = row_count;

    if v_rfq = 0 then
      raise exception 'product_forecast_rfq_v returned no products';
    end if;

    update public.barm_weekly_snapshot_runs set rfq_rows = v_rfq, component_rows = v_comp where week_start = v_week;
    return format('ok: week %s captured (%s products, %s component rows)', v_week, v_rfq, v_comp);
  exception when others then
    v_err := sqlerrm;   -- everything inside the block above is rolled back
  end;

  insert into public.barm_weekly_snapshot_runs (week_start, status, attempts, last_attempt_at, last_error)
  values (v_week, 'failed', coalesce(v_run.attempts, 0) + 1, p_now, v_err)
  on conflict (week_start) do update
    set status = 'failed', attempts = excluded.attempts, last_attempt_at = p_now, last_error = v_err;
  return format('failed: week %s: %s', v_week, v_err);
end;
$$;

revoke execute on function public.barm_capture_weekly_snapshot(timestamptz) from public, anon, authenticated;
