-- Fixes "Failed: Fetch barm_daily_fk_orders failed: canceling statement due to
-- statement timeout" on the "Generate Daily Ad Spend Report (SKU-wise)" card.
--
-- barm_daily_sheet_tables.sql already creates barm_daily_fk_orders_date_idx on
-- report_date, which the report's own fetchDailyFlipkartOrders() query relies
-- on (WHERE report_date BETWEEN ... ORDER BY report_date, id). If Postgres
-- still times out despite that index existing, the most common real-world
-- cause is stale table statistics after months of daily bulk upload/delete
-- cycles (combinedAdSpendUpload.ts replaces each uploaded date range wholesale)
-- — autovacuum may not have caught up, so the planner picks a sequential scan
-- over the whole table's history instead of an index range scan over just the
-- requested week.

-- 1. Check whether the index actually exists on the real production table.
select indexname, indexdef from pg_indexes where tablename = 'barm_daily_fk_orders';

-- 2. Check how large the table has grown (context for how bad a seq scan would be).
select count(*) as total_rows, min(report_date) as earliest, max(report_date) as latest
from public.barm_daily_fk_orders;

-- 3. Re-create the index in case it's missing (safe no-op if already present).
create index if not exists barm_daily_fk_orders_date_idx on public.barm_daily_fk_orders (report_date);

-- 4. Refresh planner statistics — cheap, safe, and the most likely actual fix
--    if the index already exists but the planner still isn't using it.
analyze public.barm_daily_fk_orders;

-- 5. Do the same for the sibling Amazon orders mirror table, which uses the
--    identical query shape (fetchDailyAmazonOrders) and could hit the same
--    issue as it grows.
analyze public.barm_daily_am_orders;
