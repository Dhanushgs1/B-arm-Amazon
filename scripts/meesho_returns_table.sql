-- Meesho returns upload table — run this ONCE in the Supabase SQL Editor for the
-- project this app uses (see .env.local's NEXT_PUBLIC_SUPABASE_URL), after
-- scripts/meesho_tables.sql.
--
-- barm_meesho_returns <- the three "Returns ..." sheets of the seller's Meesho raw
--                        workbook (Returns In Transit / Returns Delivered /
--                        Returns OFD). One row per return, keyed on Suborder
--                        Number: a return that moves from In Transit to OFD to
--                        Delivered between uploads updates in place (return_stage
--                        follows it) instead of being counted twice.
--
-- Feeds the Meesho Weekly Sales Report's Returns column: every return counts,
-- Customer Return and Courier Return (RTO) alike (seller's decision, 28 Sep 2026),
-- bucketed by return_created_date.
--
-- RLS disabled and explicit grants to anon, same as every other barm_* upload
-- table — this app talks to Supabase with the anon key and no auth session.

create table if not exists public.barm_meesho_returns (
  id bigint generated always as identity primary key,
  sub_order_no text not null,
  order_number text,
  product_name text,
  sku text,
  variation text,
  category text,
  quantity integer,
  dispatch_date date,
  return_created_date date,
  type_of_return text,
  sub_type text,
  return_stage text,
  return_status text,
  expected_delivery_date date,
  delivered_date date,
  courier_partner text,
  awb_number text,
  return_price_type text,
  return_reason text,
  detailed_return_reason text,
  raw jsonb,
  created_at timestamptz not null default now(),
  unique (sub_order_no)
);

create index if not exists barm_meesho_returns_created_date_idx on public.barm_meesho_returns (return_created_date);
create index if not exists barm_meesho_returns_sku_idx on public.barm_meesho_returns (sku);

alter table public.barm_meesho_returns disable row level security;
grant select, insert, update, delete on public.barm_meesho_returns to anon;
grant usage, select on all sequences in schema public to anon;
