-- Rollback for PHASE 1: removes only what phase 1 added. Existing tables are untouched.
begin;
drop function if exists public.upsert_shopify_order(jsonb, text, text, text, timestamptz);
drop table if exists public.barm_shopify_orders_v2;
commit;
