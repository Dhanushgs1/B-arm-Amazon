-- Rollback for 06: removes the dashboard order-summary function. Does not change any order data.
begin;
drop function if exists public.barm_shopify_orders_summary(date, date);
commit;
