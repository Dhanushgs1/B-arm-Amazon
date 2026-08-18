-- Fixes: "Insert into barm_flipkart_listings failed: new row violates
-- row-level security policy for table 'barm_flipkart_listings'"
--
-- This table has RLS enabled with no policy permitting the anon key (which
-- is how this app talks to Supabase — see src/lib/emailSettingsStore.ts's
-- header comment). Every other barm_* table this app writes to has RLS off,
-- so this brings barm_flipkart_listings in line with the rest.
--
-- Run in the SQL Editor for https://uujhgaaryqrkboninapt.supabase.co (the
-- project this app actually uses).

alter table public.barm_flipkart_listings disable row level security;
grant select, insert, update, delete on public.barm_flipkart_listings to anon;
