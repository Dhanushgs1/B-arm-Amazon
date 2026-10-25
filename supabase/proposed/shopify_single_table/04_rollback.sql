-- Rollback for 04: removes the ingest function and log table, and gives service_role back direct EXECUTE
-- on upsert_shopify_order and INSERT/UPDATE/DELETE on barm_shopify_orders_v2 (the state after 01b).
-- Does not change any order data.
-- The Vault secret 'shopify_webhook_secret' is left alone; delete it from the Dashboard if no longer wanted.
begin;
drop view if exists public.barm_shopify_order_lines_live;
drop function if exists public.ingest_shopify_webhook(text, text, text, text, text, text);
drop table if exists public.barm_shopify_webhook_log;
grant execute on function public.upsert_shopify_order(jsonb, text, text, text, timestamptz) to service_role;
grant insert, update, delete on public.barm_shopify_orders_v2 to service_role;
commit;
