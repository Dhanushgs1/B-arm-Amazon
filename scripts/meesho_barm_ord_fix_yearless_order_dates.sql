-- One-off data fix: the 854 meesho_barm_ord rows from the 22 Aug 2026 load
-- whose "Order Date" is year-less ("30-Jul" / "02-Aug"). See
-- meesho_barm_ord_order_date_normalize.sql for the cause and the trigger that
-- stops it recurring.
--
-- Year rule: created_at's year, minus one if that lands after created_at.
-- Checked 6 Oct 2026: every one of the 854 Sub Order Nos also appears in
-- another batch with an ISO "Order Date", and the inferred date matches it in
-- 854 / 854 cases (0 disagreements).
--
-- Run step by step. NOT yet run against the live project.

-- 1) Preview (read-only): expect 854 rows, 22-Jul..20-Aug -> 2026-07-22..2026-08-20.
select "Order Date" as old_value, inferred, count(*)
from (
  select "Order Date",
         to_char(case when make_date(extract(year from created_at)::int, extract(month from to_date("Order Date", 'DD-Mon'))::int, extract(day from to_date("Order Date", 'DD-Mon'))::int) > created_at::date
                      then make_date(extract(year from created_at)::int - 1, extract(month from to_date("Order Date", 'DD-Mon'))::int, extract(day from to_date("Order Date", 'DD-Mon'))::int)
                      else make_date(extract(year from created_at)::int,     extract(month from to_date("Order Date", 'DD-Mon'))::int, extract(day from to_date("Order Date", 'DD-Mon'))::int)
                 end, 'YYYY-MM-DD') as inferred
  from meesho_barm_ord
  where "Order Date" ~* '^\d{1,2}-[a-z]{3}$'
) x
group by 1, 2
order by 2;

-- 2) Backup + fix, in one transaction.
begin;

create table if not exists public.meesho_barm_ord_order_date_backup_20261006 as
  select id, "Order Date", created_at from meesho_barm_ord
  where "Order Date" ~* '^\d{1,2}-[a-z]{3}$';

update meesho_barm_ord
set "Order Date" = to_char(
  case when make_date(extract(year from created_at)::int, extract(month from to_date("Order Date", 'DD-Mon'))::int, extract(day from to_date("Order Date", 'DD-Mon'))::int) > created_at::date
       then make_date(extract(year from created_at)::int - 1, extract(month from to_date("Order Date", 'DD-Mon'))::int, extract(day from to_date("Order Date", 'DD-Mon'))::int)
       else make_date(extract(year from created_at)::int,     extract(month from to_date("Order Date", 'DD-Mon'))::int, extract(day from to_date("Order Date", 'DD-Mon'))::int)
  end, 'YYYY-MM-DD')
where "Order Date" ~* '^\d{1,2}-[a-z]{3}$';
-- expect: UPDATE 854

-- 3) Verify: expect 0.
select count(*) from meesho_barm_ord where to_safe_date("Order Date") is null;

commit;  -- or rollback;

-- Undo, if ever needed:
-- update meesho_barm_ord m set "Order Date" = b."Order Date"
--   from meesho_barm_ord_order_date_backup_20261006 b where b.id = m.id;
