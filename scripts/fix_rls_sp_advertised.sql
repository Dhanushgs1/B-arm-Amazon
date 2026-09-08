alter table public.barm_amazon_sp_advertised_product disable row level security;
grant select, insert, update, delete on public.barm_amazon_sp_advertised_product to anon;
