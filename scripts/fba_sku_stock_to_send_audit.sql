-- scripts/fba_sku_stock_to_send_audit.sql
-- Run once in the Supabase SQL Editor, after scripts/fba_sku_stock_to_send.sql.
-- There is no migration runner in this repo, so this file must be run by hand.
--
-- Audit trail for barm_fba_sku_stock_to_send (column X, stock ready to send):
--   source  'manual_migration' = copied once from the manual FBA_forecast
--           sheet (updated_at is that sheet's own date, about 10 Sep 2026);
--           'panel' = saved by someone on the FBA page's X values panel.
--   note    why a migrated value is what it is, kept as history.
-- The table stays the single source of truth for X; the report reads only
-- stock_to_send from it.
alter table public.barm_fba_sku_stock_to_send add column if not exists source text not null default 'manual_migration';
alter table public.barm_fba_sku_stock_to_send add column if not exists note text;

-- Every row so far came from the one-time migration (the panel has never
-- been live), so they all keep 'manual_migration' from the default above.
update public.barm_fba_sku_stock_to_send
set note = 'Original manual had 100 for Karnataka_zone and 35 for the other 13 zones. Normalized to 35 based on the 13-zone majority. Please review.'
where sku = 'B-BULB-CATH-PK10-3' and source = 'manual_migration';

-- New panel saves are marked 'panel'. The note is kept (history); the page
-- only flags it for review while the value is still the migrated one.
create or replace function public.save_barm_fba_sku_stock_to_send(rows jsonb)
returns integer
language plpgsql
as $$
declare
  v_count integer;
begin
  insert into public.barm_fba_sku_stock_to_send as t (sku, stock_to_send, updated_at, source)
  select r->>'sku', nullif(r->>'stock_to_send', '')::numeric, now(), 'panel'
  from jsonb_array_elements(rows) as r
  on conflict (sku) do update
    set stock_to_send = excluded.stock_to_send, updated_at = now(), source = 'panel'
    where t.stock_to_send is distinct from excluded.stock_to_send;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function public.save_barm_fba_sku_stock_to_send(jsonb) to anon;

notify pgrst, 'reload schema';

-- ── Confirm success ──────────────────────────────────────────────────────
-- select source, count(*) from public.barm_fba_sku_stock_to_send group by source;
-- Expected: manual_migration | 294
-- select stock_to_send, note from public.barm_fba_sku_stock_to_send where sku = 'B-BULB-CATH-PK10-3';
-- Expected: 35 | Original manual had 100 for Karnataka_zone ...
