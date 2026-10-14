-- meesho_barm_ord: store "Order Date" as a full ISO date.
--
-- meesho_barm_ord is loaded from outside this app (no code here inserts into
-- it — see src/lib/meeshoBarmOrd.ts). The 22 Aug 2026 load (one batch,
-- created_at 2026-08-22 03:18:25, 854 rows) wrote "Order Date" as "30-Jul" /
-- "02-Aug": the CSV was saved from an Excel sheet whose date column was
-- formatted dd-mmm, so the displayed text — not the date — was exported.
-- public.to_safe_date() can't place a year-less date, so the forecast view and
-- seasonal_sales_daily() dropped those rows from every dated window.
--
-- This trigger rewrites a year-less "DD-Mon" to YYYY-MM-DD on insert/update,
-- taking the row's created_at year and stepping back a year when that would
-- put the order after the load (a December order loaded in January) — the
-- same rule as parseMeeshoOrderDate() in src/lib/meeshoBarmOrd.ts. Anything
-- else (ISO, DD-MM-YYYY, ...) passes through untouched.

create or replace function public.meesho_barm_ord_normalize_order_date()
returns trigger
language plpgsql
as $$
declare
  v_m     text[];
  v_month int;
  v_day   int;
  v_ref   date;
  v_d     date;
begin
  v_m := regexp_match(btrim(coalesce(new."Order Date", '')), '^(\d{1,2})-([A-Za-z]{3})$');
  if v_m is null then
    return new;
  end if;
  v_month := array_position(
    array['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'],
    lower(v_m[2]));
  if v_month is null then
    return new;
  end if;
  v_day := v_m[1]::int;
  v_ref := (coalesce(new.created_at, now()) at time zone 'Asia/Kolkata')::date;
  begin
    v_d := make_date(extract(year from v_ref)::int, v_month, v_day);
    if v_d > v_ref then
      v_d := make_date(extract(year from v_ref)::int - 1, v_month, v_day);
    end if;
  exception when others then
    return new; -- e.g. 29-Feb in a non-leap year: leave the text as loaded
  end;
  new."Order Date" := to_char(v_d, 'YYYY-MM-DD');
  return new;
end;
$$;

drop trigger if exists meesho_barm_ord_normalize_order_date on public.meesho_barm_ord;
create trigger meesho_barm_ord_normalize_order_date
  before insert or update of "Order Date" on public.meesho_barm_ord
  for each row execute function public.meesho_barm_ord_normalize_order_date();
