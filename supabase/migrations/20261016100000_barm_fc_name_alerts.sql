-- "Name in the Current stock sheet but not in the FC sheet" mail log (user, 2026-10-16;
-- src/lib/fcNameCheck.ts). One row per check, run after each godown / restock upload on the
-- Consolidated Stock Sheet; the page shows the latest rows as the mail status.
create table if not exists public.barm_fc_name_alerts (
  id            bigserial   primary key,
  checked_at    timestamptz not null default now(),
  trigger       text        not null,                -- 'restock' | 'godown' | 'manual'
  restock_date  date,                                -- Current stock sheet checked
  godown_date   date,                                -- godown (FC) snapshot checked against
  missing       text[]      not null default '{}',
  recipients    text        not null default '',
  status        text        not null,                -- sent | failed | nothing_missing | already_sent | paused
  error         text
);
create index if not exists barm_fc_name_alerts_checked_at on public.barm_fc_name_alerts (checked_at desc);

-- Same access as the other barm_* tables (the API route and the page use the anon key).
grant select, insert on public.barm_fc_name_alerts to anon;
grant usage, select on sequence public.barm_fc_name_alerts_id_seq to anon;
