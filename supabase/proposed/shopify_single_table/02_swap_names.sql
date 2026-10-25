-- PHASE 2 (needs separate approval): give the single table the final name.
-- Old tables are renamed to *_legacy, not dropped. All in one transaction: either everything swaps or nothing does.

begin;

-- stop if anything has started writing to the old two-table design
do $$
begin
  if exists (select 1 from public.barm_shopify_orders) or exists (select 1 from public.barm_shopify_order_items) then
    raise exception 'barm_shopify_orders / barm_shopify_order_items are not empty - review before swapping';
  end if;
end $$;

alter table public.barm_shopify_order_items rename to barm_shopify_order_items_legacy;
alter table public.barm_shopify_orders      rename to barm_shopify_orders_legacy;
alter table public.barm_shopify_orders_v2   rename to barm_shopify_orders;

-- point the writer function at the renamed table (same body, table name swapped)
do $$
declare
  v_def text := pg_get_functiondef('public.upsert_shopify_order(jsonb, text, text, text, timestamptz)'::regprocedure);
begin
  execute replace(v_def, 'barm_shopify_orders_v2', 'barm_shopify_orders');
end $$;

commit;
