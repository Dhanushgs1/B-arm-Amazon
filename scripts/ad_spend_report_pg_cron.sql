-- scripts/ad_spend_report_pg_cron.sql
-- Daily trigger for the Daily Ad Spend Report generation Edge Function,
-- replacing the old Vercel Cron -> heavy-computation path. Runs at 04:00 UTC
-- (matches the retired vercel.json cron's own "0 4 * * *" schedule) for
-- "yesterday" (UTC date), inserting a job row first so the same dedupe path
-- the manual Generate button uses also covers the automated daily run.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'daily-ad-spend-report-generate',
  '0 4 * * *',
  $$
  with new_job as (
    insert into report_generation_jobs (report_date, report_type, status)
    values ((now() at time zone 'utc')::date - 1, 'ad_spend_daily', 'pending')
    on conflict (report_date, report_type, account_name) do nothing
    returning id, report_date
  )
  select net.http_post(
    url := '<SUPABASE_EDGE_URL>/generate-ad-spend-report',
    -- The Edge Function rejects calls without x-m360-internal (see
    -- supabase/functions/_shared/internalAuth.ts). The secret is read from
    -- Supabase Vault so it never appears in this job's stored command text.
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-m360-internal', (select decrypted_secret from vault.decrypted_secrets where name = 'internal_api_secret')
    ),
    body := jsonb_build_object('job_id', new_job.id, 'report_date', new_job.report_date)
  )
  from new_job;
  $$
);

-- Before running: replace <SUPABASE_EDGE_URL> above with the real Edge
-- Functions base URL for this Supabase project (same value used for Task 6's
-- SUPABASE_EDGE_URL env var, e.g. https://<project-ref>.supabase.co/functions/v1).
-- This is a placeholder on purpose — do not run this script until it's replaced.
--
-- Also store the Edge Functions' shared secret in Vault first (same value as
-- the INTERNAL_API_SECRET Vercel env var and Supabase function secret):
--   select vault.create_secret('<INTERNAL_API_SECRET>', 'internal_api_secret');
-- If this job is already scheduled, re-run cron.schedule above (same job name
-- replaces it) — the old definition sends no header and will now get a 401.
