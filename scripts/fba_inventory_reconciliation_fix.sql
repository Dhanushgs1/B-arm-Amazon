-- FBA inventory reconciliation fix (2026-10-06). See the Inventory page for the metric definition.
--
-- 1. barm_amazon_fba_inventory: the uploaded file is Amazon's "FBA Inventory" (planning) report,
--    whose columns are available / Total Reserved Quantity / unfulfillable-quantity /
--    inbound-working|shipped|received / snapshot-date. The uploader only knew the older "Manage FBA
--    Inventory" columns (afn-fulfillable-quantity, …), so every parsed quantity was stored as 0.
--    Re-derive the typed columns from each row's raw JSON (a re-parse, not a per-SKU edit) and keep
--    the report's own snapshot date so the dashboard can say what date the stock describes.
-- 2. barm_amazon_inventory_ledger: two ledger files uploaded concurrently both ran "delete date range"
--    before either inserted, so their overlapping days were stored twice (3,900 byte-identical
--    rows). Remove exact duplicates and enforce the ledger's natural key so it cannot recur; the
--    uploader now upserts on that key.

alter table public.barm_amazon_fba_inventory add column if not exists snapshot_date date;

create or replace function public._fba_int(v text) returns integer language sql immutable as $$
  select nullif(regexp_replace(coalesce(v, ''), '[^0-9-]', '', 'g'), '')::integer
$$;

update public.barm_amazon_fba_inventory set
  snapshot_date                  = nullif(raw->>'snapshot-date', '')::date,
  afn_fulfillable_quantity       = coalesce(public._fba_int(raw->>'available'), 0),
  afn_reserved_quantity          = coalesce(public._fba_int(raw->>'Total Reserved Quantity'), 0),
  afn_unsellable_quantity        = coalesce(public._fba_int(raw->>'unfulfillable-quantity'), 0),
  afn_inbound_working_quantity   = coalesce(public._fba_int(raw->>'inbound-working'), 0),
  afn_inbound_shipped_quantity   = coalesce(public._fba_int(raw->>'inbound-shipped'), 0),
  afn_inbound_receiving_quantity = coalesce(public._fba_int(raw->>'inbound-received'), 0),
  afn_total_quantity = coalesce(public._fba_int(raw->>'available'), 0)
                     + coalesce(public._fba_int(raw->>'Total Reserved Quantity'), 0)
                     + coalesce(public._fba_int(raw->>'unfulfillable-quantity'), 0)
                     + coalesce(public._fba_int(raw->>'inbound-working'), 0)
                     + coalesce(public._fba_int(raw->>'inbound-shipped'), 0)
                     + coalesce(public._fba_int(raw->>'inbound-received'), 0),
  -- the planning report has no MFN column: unknown, not zero
  mfn_fulfillable_quantity       = null
where raw ? 'available';

drop function public._fba_int(text);

-- exact duplicates only (same natural key AND identical raw row); keep the earliest id
delete from public.barm_amazon_inventory_ledger a
using public.barm_amazon_inventory_ledger b
where a.id > b.id
  and a.ledger_date = b.ledger_date and a.fnsku = b.fnsku and a.msku = b.msku
  and a.disposition = b.disposition and a.location = b.location
  and a.raw = b.raw;

alter table public.barm_amazon_inventory_ledger
  add constraint barm_amazon_inventory_ledger_natural_key unique (ledger_date, fnsku, msku, disposition, location);
