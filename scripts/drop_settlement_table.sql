-- The Settled Transaction report feature has been fully removed from the app
-- (upload card, parser, and all report-calculation code). This table is
-- already empty; this drops the table object itself since nothing reads or
-- writes it anymore.
--
-- Run in the SQL Editor for https://uujhgaaryqrkboninapt.supabase.co

drop table if exists public.barm_flipkart_settlement;
