-- FC Forecast tab (2026-11-20): tables behind /dashboard/inventory/fc-forecast.
-- See docs/superpowers/specs/2026-11-20-fc-forecast-design.md. Additive only.

-- SKU normalization shared by the seeds, the page (normalizeSku in src/lib/sellerFlexShipments.ts)
-- and the forecast functions: drop invisible marks (U+200B–U+200F, U+FEFF), trim, lowercase.
create or replace function public.fc_norm_sku(s text) returns text
language sql immutable parallel safe as $$
  select lower(btrim(regexp_replace(coalesce(s, ''), '[​-‏﻿]', '', 'g')))
$$;
grant execute on function public.fc_norm_sku(text) to anon;

-- SKU -> product name. Seeded from the client sheet's "SKUID,NAME" tab (source = 'client_sheet');
-- the page's Unmapped panel adds rows (source = 'dashboard'). sku is stored normalized.
create table if not exists public.fc_sku_product_map (
  sku        text primary key check (sku = public.fc_norm_sku(sku) and sku <> ''),
  product    text not null check (btrim(product) <> ''),
  source     text not null default 'dashboard',
  updated_at timestamptz not null default now()
);

-- Products always listed on the forecast (the client sheet's 186), even with no sales (min stock 5).
create table if not exists public.fc_products (
  product text primary key,
  active  boolean not null default true
);

-- Amazon Seller Flex customer shipments (VSNC-CUSTOMER_SHIPMENTS-ALL-*.csv). sku = the CSV "MSKU".
create table if not exists public.barm_sellerflex_shipments (
  id                     bigserial primary key,
  shipment_id            text not null,
  sku                    text not null,
  asin                   text,
  customer_order_id      text,
  units                  int  not null,
  status                 text,
  shipment_creation_date date not null,
  channel                text,
  raw                    jsonb,
  created_at             timestamptz not null default now(),
  unique (shipment_id, sku)
);
create index if not exists barm_sellerflex_shipments_day on public.barm_sellerflex_shipments (shipment_creation_date);

alter table public.fc_sku_product_map        enable row level security;
alter table public.fc_products               enable row level security;
alter table public.barm_sellerflex_shipments enable row level security;

create policy fc_sku_product_map_read  on public.fc_sku_product_map for select to anon using (true);
create policy fc_sku_product_map_ins   on public.fc_sku_product_map for insert to anon with check (true);
create policy fc_sku_product_map_upd   on public.fc_sku_product_map for update to anon using (true) with check (true);
create policy fc_products_read         on public.fc_products for select to anon using (true);
create policy sellerflex_ship_read     on public.barm_sellerflex_shipments for select to anon using (true);
create policy sellerflex_ship_ins      on public.barm_sellerflex_shipments for insert to anon with check (true);
create policy sellerflex_ship_upd      on public.barm_sellerflex_shipments for update to anon using (true) with check (true);

grant select, insert, update on public.fc_sku_product_map, public.barm_sellerflex_shipments to anon;
grant select on public.fc_products to anon;
grant usage on sequence public.barm_sellerflex_shipments_id_seq to anon;
