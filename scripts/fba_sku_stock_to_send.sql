-- scripts/fba_sku_stock_to_send.sql
-- Run once in the Supabase SQL Editor, after
-- scripts/fba_manual_plan_and_active_date.sql. There is no migration runner
-- in this repo, so this file must be run by hand.
--
-- barm_fba_sku_stock_to_send: column X of the manual FBA analysis sheet
-- ("Stock present per SKU ID for FBA - booked", the stock ready to send),
-- kept as ONE value per SKU and applied to all 14 of that SKU's zones. It is
-- edited on the FBA page's "X values" panel; blank (null) means 0 to send.
-- The FBA Forecast Report reads X from here — barm_fba_manual_plan keeps only
-- the permanent SKU × zone list (its stock_to_send column is the original
-- manual copy and is no longer read).
create table if not exists public.barm_fba_sku_stock_to_send (
  sku text primary key,
  stock_to_send numeric check (stock_to_send is null or stock_to_send >= 0),
  updated_at timestamptz not null default now()
);

alter table public.barm_fba_sku_stock_to_send disable row level security;
grant select, insert, update, delete on public.barm_fba_sku_stock_to_send to anon;

-- Saves edited X values. Only a SKU whose value actually changed gets a new
-- updated_at, so "last updated" stays honest. Returns how many changed.
create or replace function public.save_barm_fba_sku_stock_to_send(rows jsonb)
returns integer
language plpgsql
as $$
declare
  v_count integer;
begin
  insert into public.barm_fba_sku_stock_to_send as t (sku, stock_to_send, updated_at)
  select r->>'sku', nullif(r->>'stock_to_send', '')::numeric, now()
  from jsonb_array_elements(rows) as r
  on conflict (sku) do update
    set stock_to_send = excluded.stock_to_send, updated_at = now()
    where t.stock_to_send is distinct from excluded.stock_to_send;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function public.save_barm_fba_sku_stock_to_send(jsonb) to anon;

-- One-time seed from the manual sheet's own X values (already stored per
-- SKU × zone in barm_fba_manual_plan). Each SKU takes the value on most of
-- its zones: only B-BULB-CATH-PK10-3 differed (35 on 13 zones, 100 on
-- Karnataka) and becomes 35. updated_at is the manual sheet's own date
-- (about 10 Sep 2026), not today, so the page's stale-X warning is truthful.
insert into public.barm_fba_sku_stock_to_send (sku, stock_to_send, updated_at)
select p.sku,
  (select q.stock_to_send from public.barm_fba_manual_plan q
   where q.sku = p.sku
   group by q.stock_to_send
   order by count(*) desc, q.stock_to_send desc nulls last
   limit 1),
  timestamptz '2026-09-10 00:00:00+05:30'
from (select distinct sku from public.barm_fba_manual_plan) p
on conflict (sku) do nothing;

notify pgrst, 'reload schema';

-- ── Confirm success ──────────────────────────────────────────────────────
-- select count(*), count(stock_to_send) from public.barm_fba_sku_stock_to_send;
-- Expected: 294 SKUs, 189 with a value.
-- select stock_to_send from public.barm_fba_sku_stock_to_send where sku = 'B-BULB-CATH-PK10-3';
-- Expected: 35
