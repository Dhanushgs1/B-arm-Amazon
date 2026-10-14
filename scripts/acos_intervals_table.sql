-- "ACOS Intervals": the Daily Ad Spend Report's currently selected window, the same way
-- public."Intervals" holds the Stock Purchase / forecast 30D-7D window.
--
-- One row (id = 1). The dashboard (src/lib/DashboardContext.tsx) calls
-- set_acos_interval(<end date>) whenever the date picked at the top changes (BARM login only),
-- so the row always holds the dashboard's current date: Report Date = that day, 7D = the 6 days
-- before it through that day, 30D = the 29 days before it through that day (same windows
-- adSpendReportExport.ts's getDateWindow(endDate, 7 / 30) uses).
--
-- acos_interval_summary_v reads barm_ad_spend_history (Day, 7D) and barm_ad_spend_history_30d
-- (30D) through this row's "Report Date", so changing that date changes the view immediately —
-- no refresh needed. The 7D/30D date columns describe the windows those saved figures cover;
-- editing them alone does not recompute anything. One direction only: editing the view's rows
-- can't move the interval.

create table if not exists public."ACOS Intervals" (
  id              bigint primary key default 1 check (id = 1),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  "Report Date"   date not null,
  "From Date 7D"  date not null,
  "To Date 7D"    date not null,
  "From Date 30D" date,
  "To Date 30D"   date
);

-- Added after the table first shipped.
alter table public."ACOS Intervals"
  add column if not exists "From Date 30D" date,
  add column if not exists "To Date 30D" date;

update public."ACOS Intervals"
   set "From Date 30D" = "Report Date" - 29,
       "To Date 30D"   = "Report Date"
 where "From Date 30D" is null or "To Date 30D" is null;

create or replace function public.set_acos_interval(p_report_date date)
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if p_report_date is null then
    raise exception 'set_acos_interval: report date is required';
  end if;

  insert into public."ACOS Intervals" (id, "Report Date", "From Date 7D", "To Date 7D", "From Date 30D", "To Date 30D")
  values (1, p_report_date, p_report_date - 6, p_report_date, p_report_date - 29, p_report_date)
  on conflict (id) do update
     set "Report Date"   = excluded."Report Date",
         "From Date 7D"  = excluded."From Date 7D",
         "To Date 7D"    = excluded."To Date 7D",
         "From Date 30D" = excluded."From Date 30D",
         "To Date 30D"   = excluded."To Date 30D",
         updated_at      = now();

  return 'Day ' || p_report_date || ', 7D ' || (p_report_date - 6) || '..' || p_report_date
      || ', 30D ' || (p_report_date - 29) || '..' || p_report_date;
end;
$$;

grant execute on function public.set_acos_interval(date) to anon, authenticated, service_role;

-- Seed with the latest date that already has history, so the view isn't empty on day one.
insert into public."ACOS Intervals" (id, "Report Date", "From Date 7D", "To Date 7D", "From Date 30D", "To Date 30D")
select 1, d, d - 6, d, d - 29, d
from (select max(report_date) d from public.barm_ad_spend_history) m
where d is not null
on conflict (id) do nothing;

-- 30D figures come from barm_ad_spend_history_30d (scripts/ad_spend_history_30d_table.sql), saved
-- by the same report run for the 30 days ending on "Report Date". Full join so a SKU with 30D
-- activity but nothing in the 7D window still shows, with its Day/7D columns empty.
-- Dropped and recreated (not "create or replace") because new columns sit mid-list.
--
-- "Overall ACOS (Day/7D/30D)": the product's ACOS across every SKU and platform carrying the same
-- product name (case/space-insensitive), repeated on each of its rows = total Spend / total Sales.
-- Sales isn't stored, so each row's is recovered as Spend / ACOS (exact, since the row's ACOS is
-- Spend / its sales). Rows with no usable ACOS (NULL — e.g. an unpriced Amazon SKU — or 0, or the
-- 9.99 "undefined" sentinel) have unknown sales, so they are left out of BOTH sums rather than
-- counting their spend against zero sales.
drop view if exists public.acos_interval_summary_v;
create view public.acos_interval_summary_v as
with base as (
select
  i."Report Date",
  i."From Date 7D",
  i."To Date 7D",
  i."From Date 30D",
  i."To Date 30D",
  coalesce(h.platform, m.platform)          as "Platform",
  coalesce(h.sku, m.sku)                    as "SKU",
  coalesce(h.product_name, m.product_name)  as "Product",
  coalesce(h.price, m.price)                as "Price",
  h.day_spend       as "Spend (Day)",
  h.day_spend_tax   as "Spend+Tax (Day)",
  h.day_orders      as "Orders (Day)",
  h.day_cpc         as "CPC (Day)",
  h.day_acos        as "ACOS (Day)",
  h.range_spend     as "Spend (7D)",
  h.range_spend_tax as "Spend+Tax (7D)",
  h.range_orders    as "Orders (7D)",
  h.range_cpc       as "CPC (7D)",
  h.range_acos      as "ACOS (7D)",
  m.spend           as "Spend (30D)",
  m.spend_tax       as "Spend+Tax (30D)",
  m.orders          as "Orders (30D)",
  m.cpc             as "CPC (30D)",
  m.acos            as "ACOS (30D)",
  coalesce(h.created_at, m.created_at) as "Saved At"
-- Each side is narrowed to the one Report Date first ("ACOS Intervals" is a single row, id = 1),
-- so the full join never touches the rest of the history.
from public."ACOS Intervals" i
join (
  (select * from public.barm_ad_spend_history
    where report_date = (select "Report Date" from public."ACOS Intervals" where id = 1)) h
  full join
  (select * from public.barm_ad_spend_history_30d
    where report_date = (select "Report Date" from public."ACOS Intervals" where id = 1)) m
    on m.platform = h.platform and m.sku = h.sku
) on i.id = 1
)
select
  b."Report Date", b."From Date 7D", b."To Date 7D", b."From Date 30D", b."To Date 30D",
  b."Platform", b."SKU", b."Product", b."Price",
  b."Spend (Day)", b."Spend+Tax (Day)", b."Orders (Day)", b."CPC (Day)", b."ACOS (Day)",
  round(
    sum(b."Spend (Day)") filter (where b."ACOS (Day)" > 0 and b."ACOS (Day)" < 9.99) over p
    / nullif(sum(b."Spend (Day)" / b."ACOS (Day)") filter (where b."ACOS (Day)" > 0 and b."ACOS (Day)" < 9.99) over p, 0),
  4) as "Overall ACOS (Day)",
  b."Spend (7D)", b."Spend+Tax (7D)", b."Orders (7D)", b."CPC (7D)", b."ACOS (7D)",
  round(
    sum(b."Spend (7D)") filter (where b."ACOS (7D)" > 0 and b."ACOS (7D)" < 9.99) over p
    / nullif(sum(b."Spend (7D)" / b."ACOS (7D)") filter (where b."ACOS (7D)" > 0 and b."ACOS (7D)" < 9.99) over p, 0),
  4) as "Overall ACOS (7D)",
  b."Spend (30D)", b."Spend+Tax (30D)", b."Orders (30D)", b."CPC (30D)", b."ACOS (30D)",
  round(
    sum(b."Spend (30D)") filter (where b."ACOS (30D)" > 0 and b."ACOS (30D)" < 9.99) over p
    / nullif(sum(b."Spend (30D)" / b."ACOS (30D)") filter (where b."ACOS (30D)" > 0 and b."ACOS (30D)" < 9.99) over p, 0),
  4) as "Overall ACOS (30D)",
  b."Saved At"
from base b
window p as (partition by lower(btrim(b."Product")));

grant select on public.acos_interval_summary_v to anon, authenticated;
