-- Fixes "No data" on the "Ad Spend Report — one-file upload" card — same RLS-blocking-anon
-- issue as before, confirmed directly on all 8 barm_daily_* tables.

alter table public.barm_daily_am_ads disable row level security;
alter table public.barm_daily_am_orders disable row level security;
alter table public.barm_daily_fk_ads disable row level security;
alter table public.barm_daily_fk_orders disable row level security;
alter table public.barm_daily_ms_barm_ads disable row level security;
alter table public.barm_daily_ms_barm_orders disable row level security;
alter table public.barm_daily_ms_mw_ads disable row level security;
alter table public.barm_daily_ms_mw_orders disable row level security;

grant select, insert, update, delete on public.barm_daily_am_ads to anon;
grant select, insert, update, delete on public.barm_daily_am_orders to anon;
grant select, insert, update, delete on public.barm_daily_fk_ads to anon;
grant select, insert, update, delete on public.barm_daily_fk_orders to anon;
grant select, insert, update, delete on public.barm_daily_ms_barm_ads to anon;
grant select, insert, update, delete on public.barm_daily_ms_barm_orders to anon;
grant select, insert, update, delete on public.barm_daily_ms_mw_ads to anon;
grant select, insert, update, delete on public.barm_daily_ms_mw_orders to anon;
grant usage, select on all sequences in schema public to anon;
