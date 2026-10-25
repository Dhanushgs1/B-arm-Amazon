-- PROPOSED, not applied. Needs approval.
--
-- Why: every Amazon report and the Overall page read amazon_orders by date range, 1,000 rows a page,
-- ordered by ("purchase-date", id) (misAdapters.ts fetchMisDateFiltered). The table (55k rows) has
-- no index on "purchase-date", so each page seq-scans and sorts the whole table: 2.87 s measured for
-- one 60-day page on 2026-10-25, against the anon role's 3 s statement_timeout — Amazon never loads.
--
-- What: one btree index matching that filter + ORDER BY. Adds no column, changes no data or
-- permission. Takes a brief lock on writes while it builds (~1 s at this size).
create index if not exists idx_amazon_orders_purchase_date_id
  on public.amazon_orders ("purchase-date", id);

-- Rollback:
-- drop index if exists public.idx_amazon_orders_purchase_date_id;
