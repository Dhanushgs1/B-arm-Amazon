-- One log of every email the dashboard sends (user, 2026-10-16): a row per send attempt.
--   source 'send-email'     every template / cron / alert / Reports page send through /api/send-email
--                           (written by src/lib/emailLog.ts; status sent | failed | paused)
--   source 'ad-spend-edge'  the Daily Ad Spend Report, mailed by the send-ad-spend-email Edge Function.
--                           /api/send-ad-spend-email writes a 'queued' row with the recipients; the
--                           trigger below completes it from report_generation_jobs.email_status
--                           (sent | failed), or adds a row when the send did not start from that route.
create table if not exists public.email_log (
  id           bigserial   primary key,
  created_at   timestamptz not null default now(),
  source       text        not null,
  mail_type    text        not null default '',     -- send-email "type" (custom, highAcosTrend, ...)
  subject      text        not null default '',
  to_addr      text        not null default '',
  cc_addr      text        not null default '',
  attachments  text[]      not null default '{}',   -- attachment file names
  status       text        not null,                -- queued | sent | failed | paused
  error        text,
  message_id   text,
  job_id       bigint,                              -- report_generation_jobs.id (ad spend mail)
  sent_at      timestamptz
);
create index if not exists email_log_created_at on public.email_log (created_at desc);
create index if not exists email_log_job_id on public.email_log (job_id) where job_id is not null;

grant select, insert, update on public.email_log to anon;
grant usage, select on sequence public.email_log_id_seq to anon;

create or replace function public.email_log_from_ad_spend_job() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.email_status in ('sent', 'failed') and new.email_status is distinct from old.email_status then
    update public.email_log
       set status = new.email_status, error = new.email_error,
           sent_at = case when new.email_status = 'sent' then coalesce(new.email_sent_at, now()) end
     where id = (select id from public.email_log where job_id = new.id and status = 'queued' order by created_at desc limit 1);
    if not found then
      insert into public.email_log (source, mail_type, subject, status, error, job_id, sent_at)
      values ('ad-spend-edge', 'adSpendDaily', '📈 Ad spend Report', new.email_status, new.email_error, new.id,
              case when new.email_status = 'sent' then coalesce(new.email_sent_at, now()) end);
    end if;
  end if;
  return new;
end $$;

drop trigger if exists email_log_ad_spend on public.report_generation_jobs;
create trigger email_log_ad_spend after update of email_status on public.report_generation_jobs
  for each row execute function public.email_log_from_ad_spend_job();
