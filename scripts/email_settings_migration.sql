-- Run this ONCE in the Supabase SQL Editor for the CORRECT/current project:
-- https://supabase.com/dashboard/project/uujhgaaryqrkboninapt/sql/new
--
-- Recreates email_settings (dropped when Vercel's SUPABASE_URL was switched
-- to this project 23h ago, leaving production with no saved account config)
-- and restores the slot "B" row exactly as it was in the old project
-- (glvnqvjnglvnrgfyaypk), last updated 2026-07-27T09:38:20Z.
-- Slot "A" never had a saved row in the old project either, so there is
-- nothing to restore for it — it still needs to be entered once via
-- Settings in the dashboard UI.

create table if not exists public.email_settings (
  key_slot   text primary key,
  settings   jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.email_settings disable row level security;
grant select, insert, update on public.email_settings to anon;

insert into public.email_settings (key_slot, settings, updated_at) values (
  'B',
  '{"ccEmail": "sruthisri@barmenterprises.com,sriram@b-arm.com,harshineebarm@gmail.com,kaviyapriyabarm@gmail.com,nivetha@b-arm.com,jayaprakashbarm@gmail.com,dangibbs@b-arm.com,dhanush@stratai.io,prinesh@b-arm.com", "keySlot": "B", "recMode": "balanced", "currency": "INR", "slackUrl": "", "timezone": "Asia/Kolkata", "aiEnabled": true, "autoPause": false, "twoFactor": false, "autoBudget": false, "ipRestrict": false, "liveAlerts": true, "notifEmail": "ceo@barmenterprises.com", "pushAlerts": false, "roasAlerts": true, "roasTarget": 4, "compactMode": false, "emailAlerts": true, "slackAlerts": false, "smartAlerts": true, "workspaceId": "6a3279510c060940d2b87662", "autoInsights": true, "dailySummary": true, "defaultRange": "30d", "meeshoApiKey": "", "syncSchedule": "6h", "whitelistIps": "", "acosThreshold": 40, "autoNegatives": false, "weeklySummary": true, "flipkartApiKey": "", "forecastWindow": "30d", "monthlySummary": false, "amazonAccountId": "6a3279a4af744dda69afe36d", "inventoryAlerts": true, "flipkartSellerId": "", "meeshoSupplierId": "", "lowStockThreshold": 15}'::jsonb,
  '2026-07-27T09:38:20.256+00:00'
)
on conflict (key_slot) do update set settings = excluded.settings, updated_at = excluded.updated_at;
