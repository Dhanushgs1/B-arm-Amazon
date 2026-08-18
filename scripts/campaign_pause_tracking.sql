-- Campaign pause tracking — run this once in the Supabase SQL Editor
-- (Project → SQL Editor → New query → paste → Run).
--
-- Backs src/lib/campaignStateTracker.ts (writes) and
-- src/lib/campaignPersistence.ts (reads, via the RPC function below).

-- 1) Latest known state per (key_slot, campaign_id) — overwritten every check.
create table if not exists public.barm_campaign_state (
  key_slot      text not null,
  campaign_id   text not null,
  campaign_name text,
  state         text not null,
  checked_at    timestamptz not null default now(),
  primary key (key_slot, campaign_id)
);

-- 2) Append-only log of ENABLED -> non-ENABLED transitions.
create table if not exists public.barm_campaign_pause_log (
  id             bigserial primary key,
  key_slot       text not null,
  campaign_id    text not null,
  campaign_name  text,
  previous_state text,
  new_state      text not null,
  detected_at    timestamptz not null default now()
);
create index if not exists barm_campaign_pause_log_slot_campaign_idx
  on public.barm_campaign_pause_log (key_slot, campaign_id, detected_at desc);

-- 3) One immutable row per campaign per calendar day.
create table if not exists public.barm_campaign_daily_snapshot (
  key_slot      text not null,
  campaign_id   text not null,
  campaign_name text,
  snapshot_date date not null,
  raw_state     text,
  status        text not null,
  primary key (key_slot, campaign_id, snapshot_date)
);
create index if not exists barm_campaign_daily_snapshot_slot_date_idx
  on public.barm_campaign_daily_snapshot (key_slot, snapshot_date);

-- 4) RPC used by campaignPersistence.ts: campaigns whose last known snapshot
--    predates this account's most recent daily pull (i.e. dropped out of a
--    later list_campaigns response without an explicit pause being logged).
create or replace function public.get_missing_campaign_history(p_key_slot text)
returns table (campaign_id text, campaign_name text, last_seen_date date)
language sql
stable
as $$
  with latest_pull as (
    select max(snapshot_date) as pull_date
    from public.barm_campaign_daily_snapshot
    where key_slot = p_key_slot
  ),
  per_campaign as (
    select
      s.campaign_id,
      max(s.snapshot_date) as last_seen_date,
      (array_agg(s.campaign_name order by s.snapshot_date desc))[1] as campaign_name
    from public.barm_campaign_daily_snapshot s
    where s.key_slot = p_key_slot
    group by s.campaign_id
  )
  select pc.campaign_id, pc.campaign_name, pc.last_seen_date
  from per_campaign pc, latest_pull lp
  where lp.pull_date is not null
    and pc.last_seen_date < lp.pull_date;
$$;

-- RLS: this app talks to Supabase with the anon key (see
-- src/lib/emailSettingsStore.ts's header comment), so match whatever policy
-- your other barm_* tables (e.g. barm_alert_state) already use. If those
-- already work today with RLS enabled + a permissive policy, mirror that
-- here instead of the blanket disable below:
--
-- alter table public.barm_campaign_state enable row level security;
-- create policy "anon rw" on public.barm_campaign_state for all
--   to anon using (true) with check (true);
-- (repeat per table)
--
-- Simplest option if your other barm_* tables have RLS off:
alter table public.barm_campaign_state disable row level security;
alter table public.barm_campaign_pause_log disable row level security;
alter table public.barm_campaign_daily_snapshot disable row level security;

grant select, insert, update on public.barm_campaign_state to anon;
grant select, insert on public.barm_campaign_pause_log to anon;
grant select, insert, update on public.barm_campaign_daily_snapshot to anon;
grant execute on function public.get_missing_campaign_history(text) to anon;
