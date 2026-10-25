-- PROPOSED, not applied. Needs approval.
--
-- Why: Flipkart orders are read by date range, 1,000 rows a page, ordered by (order_date, id)
-- (misAdapters.ts fetchMisFkOrders → fetchMisDateFiltered). fk_orders (~36k rows) has no index on
-- order_date, so every page seq-scans and sorts the table: 3.5 s measured for a 7-day page on
-- 2026-10-25, over the anon role's 3 s statement_timeout — Flipkart never loads on Overall.
-- Same fix as idx_amazon_orders_purchase_date_id (applied 2026-10-25, 2.28 s → 0.15 s).
--
-- What: one btree index matching that filter + ORDER BY. No data, column or permission change.
-- Takes a brief lock on writes while it builds (~1 s at this size).
create index if not exists idx_fk_orders_order_date_id
  on public.fk_orders (order_date, id);

-- Rollback:
-- drop index if exists public.idx_fk_orders_order_date_id;
