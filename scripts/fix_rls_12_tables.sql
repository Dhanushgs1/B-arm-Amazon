-- RLS fix, scoped to just the 12 tables actually in use right now:
-- am_orders, am_returns, fba_returns, sf_return, fk_orders (order_report),
-- fk_returns, fba_inventory, inventory_ledger, sb_campaign (Sponsored Brands),
-- sd_campaign (Sponsored Display), product_master, fsn_report (FK spend).

alter table public.barm_amazon_am_orders disable row level security;
alter table public.barm_amazon_am_returns disable row level security;
alter table public.barm_amazon_fba_returns disable row level security;
alter table public.barm_amazon_sf_return disable row level security;
alter table public.barm_flipkart_order_report disable row level security;
alter table public.barm_flipkart_returns disable row level security;
alter table public.barm_amazon_fba_inventory disable row level security;
alter table public.barm_amazon_inventory_ledger disable row level security;
alter table public.barm_amazon_sb_campaign disable row level security;
alter table public.barm_amazon_sd_campaign disable row level security;
alter table public.barm_product_master disable row level security;
alter table public.barm_flipkart_fsn_report disable row level security;

grant select, insert, update, delete on public.barm_amazon_am_orders to anon;
grant select, insert, update, delete on public.barm_amazon_am_returns to anon;
grant select, insert, update, delete on public.barm_amazon_fba_returns to anon;
grant select, insert, update, delete on public.barm_amazon_sf_return to anon;
grant select, insert, update, delete on public.barm_flipkart_order_report to anon;
grant select, insert, update, delete on public.barm_flipkart_returns to anon;
grant select, insert, update, delete on public.barm_amazon_fba_inventory to anon;
grant select, insert, update, delete on public.barm_amazon_inventory_ledger to anon;
grant select, insert, update, delete on public.barm_amazon_sb_campaign to anon;
grant select, insert, update, delete on public.barm_amazon_sd_campaign to anon;
grant select, insert, update, delete on public.barm_product_master to anon;
grant select, insert, update, delete on public.barm_flipkart_fsn_report to anon;
grant usage, select on all sequences in schema public to anon;
