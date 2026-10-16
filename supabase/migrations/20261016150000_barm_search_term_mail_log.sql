-- Monthly Search Terms mail log (user, 2026-10-16; src/pages/api/search-term-monthly-mail.ts).
-- One row per send attempt; the Search Terms page's Mail tab reads it. The cron sends a period once:
-- it checks for a status 'sent', partial = false row with the same key_slot and period_end.
create table if not exists public.barm_search_term_mail_log (
  id            bigserial   primary key,
  checked_at    timestamptz not null default now(),
  key_slot      text        not null,                -- 'A' (Lkn) | 'B' (B-ARM)
  trigger       text        not null,                -- 'cron' | 'manual'
  period_label  text        not null,                -- e.g. 'Oct 2026'
  period_start  date        not null,
  period_end    date        not null,
  partial       boolean     not null default false,  -- manual send before the period's last day
  counts        jsonb       not null default '{}',   -- { orders0, acos50, acos25, acos13 }
  recipients    text        not null default '',
  status        text        not null,                -- sent | failed | paused
  error         text
);
create index if not exists barm_search_term_mail_log_checked_at on public.barm_search_term_mail_log (checked_at desc);

grant select, insert on public.barm_search_term_mail_log to anon;
grant usage, select on sequence public.barm_search_term_mail_log_id_seq to anon;
