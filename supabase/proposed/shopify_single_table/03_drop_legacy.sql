-- PHASE 3 (needs separate approval, run only after n8n has been writing to the new table successfully).
-- Not reversible. Both legacy tables held 0 rows when checked on 2026-10-22; the guard re-checks.
begin;

do $$
begin
  if exists (select 1 from public.barm_shopify_orders_legacy) or exists (select 1 from public.barm_shopify_order_items_legacy) then
    raise exception 'legacy Shopify tables contain rows - export them before dropping';
  end if;
end $$;

drop table public.barm_shopify_order_items_legacy;  -- has the FK, so drop it first
drop table public.barm_shopify_orders_legacy;

commit;
