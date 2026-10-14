-- Schedule for the weekly Stock Purchase / Components snapshot
-- (supabase/migrations/20261013120000_barm_weekly_restock_snapshot.sql). Apply after that migration.
--
-- pg_cron runs in UTC: 04:30 UTC = 10:00 IST. It runs every hour on Monday from 10:00 to 23:00 IST,
-- so a failed attempt is retried within the hour; once the week is captured, later runs only return
-- 'skipped'. Nothing here touches send_schedule (the tool's own Monday email stays as it is).
select cron.schedule(
  'barm-weekly-restock-snapshot',
  '30 4-17 * * 1',
  $$select public.barm_capture_weekly_snapshot()$$
);

-- Undo:
--   select cron.unschedule('barm-weekly-restock-snapshot');
