-- Rollback for 01: drops the view only. No source table or row is touched by 01 or by this.
begin;
drop view if exists public.barm_website_orders_unified;
commit;
