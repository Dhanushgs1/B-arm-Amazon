-- Rollback for PHASE 2: puts every name back exactly as it was after phase 1.
begin;

alter table public.barm_shopify_orders             rename to barm_shopify_orders_v2;
alter table public.barm_shopify_orders_legacy      rename to barm_shopify_orders;
alter table public.barm_shopify_order_items_legacy rename to barm_shopify_order_items;

do $$
declare
  v_def text := pg_get_functiondef('public.upsert_shopify_order(jsonb, text, text, text, timestamptz)'::regprocedure);
begin
  execute regexp_replace(v_def, '\mbarm_shopify_orders\M', 'barm_shopify_orders_v2', 'g');
end $$;

commit;
