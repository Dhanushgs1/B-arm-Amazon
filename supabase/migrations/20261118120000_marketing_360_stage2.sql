-- Product Marketing 360, stage 2 (user, 2026-11-18)
-- 1. "FBA in which low weight products cannot be onboarded": left empty, typed in by the team.
alter table public.mkt_product_profile add column if not exists fba_weight_note text;

-- 2. Pincode prefix → state → FBA forecast zone (same grouping as the daily FBA Forecasting file),
--    seeded from src/lib/marketing360Import.ts pincodeState() + marketing360Rules.ts STATE_ZONE.
create table if not exists public.mkt_pin_zone (prefix3 text primary key, state text not null, zone text);
grant select on public.mkt_pin_zone to anon;

-- 3. Delivery per product per zone: the checks on date d, or (d null) the latest check per pincode.
create or replace function public.mkt_delivery_zone_summary(d date default null, p_asin text default null)
returns table (asin text, zone text, pincodes int, avg_days numeric, max_days numeric, slow int, unavailable int)
language sql stable as $$
  with latest as (
    select distinct on (s.asin_fsn, s.pincode) s.asin_fsn, s.pincode, s.days, s.status
    from public.mkt_delivery_sweep s
    where s.platform = 'Amazon' and (d is null or s.scraped_date = d) and (p_asin is null or s.asin_fsn = p_asin)
    order by s.asin_fsn, s.pincode, s.scraped_date desc nulls last, s.week desc
  ), tagged as (
    select l.*, z.zone, (l.days is null or l.status ~* '(unavailable|not deliverable|no listing|unable)') as no_delivery
    from latest l join public.mkt_pin_zone z on z.prefix3 = left(l.pincode, 3)
    where z.zone is not null
  )
  select asin_fsn, zone, count(*)::int,
         round(avg(days) filter (where not no_delivery), 1),
         max(days) filter (where not no_delivery),
         count(*) filter (where not no_delivery and days > 5)::int,
         count(*) filter (where no_delivery)::int
  from tagged group by asin_fsn, zone
$$;
grant execute on function public.mkt_delivery_zone_summary(date, text) to anon;


-- seed: same ranges as pincodeState() (narrowest range wins) and the same state→zone map as STATE_ZONE
with ranges(a, b, state) as (values
  (110,110,'Delhi'),(121,136,'Haryana'),(140,159,'Punjab'),(160,160,'Chandigarh'),(171,177,'Himachal Pradesh'),
  (180,194,'Jammu & Kashmir'),(246,246,'Uttarakhand'),(248,249,'Uttarakhand'),(262,263,'Uttarakhand'),
  (201,285,'Uttar Pradesh'),(301,345,'Rajasthan'),(360,396,'Gujarat'),(403,403,'Goa'),(400,445,'Maharashtra'),
  (450,488,'Madhya Pradesh'),(490,497,'Chhattisgarh'),(500,509,'Telangana'),(515,535,'Andhra Pradesh'),
  (560,591,'Karnataka'),(600,643,'Tamil Nadu'),(670,695,'Kerala'),(700,743,'West Bengal'),(737,737,'Sikkim'),
  (751,770,'Odisha'),(781,788,'Assam'),(790,792,'Arunachal Pradesh'),(793,794,'Meghalaya'),(795,795,'Manipur'),
  (796,796,'Mizoram'),(797,798,'Nagaland'),(799,799,'Tripura'),
  (814,816,'Jharkhand'),(822,822,'Jharkhand'),(825,835,'Jharkhand'),(800,855,'Bihar')
), zones(state, zone) as (values
  ('Andhra Pradesh','Telangana_zone'),('Arunachal Pradesh','Assam_zone'),('Assam','Assam_zone'),('Bihar','bihar_zone'),
  ('Chandigarh','Punjab_zone'),('Chhattisgarh','Nagpur_zone'),('Delhi','Delhi_zone'),('Goa','Karnataka_zone'),
  ('Gujarat','gujarat_zone'),('Haryana','Delhi_zone'),('Himachal Pradesh','Punjab_zone'),('Jammu & Kashmir','Punjab_zone'),
  ('Jharkhand','bihar_zone'),('Karnataka','Karnataka_zone'),('Kerala','Karnataka_zone'),('Madhya Pradesh','Nagpur_zone'),
  ('Maharashtra','Maharashtra_zone'),('Manipur','Assam_zone'),('Meghalaya','Assam_zone'),('Mizoram','Assam_zone'),
  ('Nagaland','Assam_zone'),('Odisha','Odisha_zone'),('Punjab','Punjab_zone'),('Rajasthan','Rajasthan_zone'),
  ('Sikkim','Assam_zone'),('Tamil Nadu','Tamilnadu_zone'),('Telangana','Telangana_zone'),('Tripura','Assam_zone'),
  ('Uttar Pradesh','Uttarpradesh_zone'),('Uttarakhand','Delhi_zone'),('West Bengal','WestBengal_zone')
), pick as (
  select distinct on (p) p::text as prefix3, r.state
  from generate_series(100, 999) p join ranges r on p between r.a and r.b
  order by p, (r.b - r.a)
)
insert into public.mkt_pin_zone (prefix3, state, zone)
select pick.prefix3, pick.state, zones.zone from pick left join zones on zones.state = pick.state
on conflict (prefix3) do update set state = excluded.state, zone = excluded.zone;

-- Competitor prices for the SAME product only (EXACT MATCH / CLOSE EQUIVALENT), latest check per competitor
-- listing, Amazon + Flipkart. competitor_analysis stays RLS-limited to signed-in Supabase users; this
-- function exposes only these columns to the dashboard (user approved 2026-11-18). our_sku is our
-- "|"-separated SKU list — Flipkart rows have no our_asin, so callers match on either (ourProduct()).
drop function if exists public.mkt_competitor_prices(text);
create function public.mkt_competitor_prices(p_asin text default null)
returns table (our_asin text, our_sku text, competitor_product_name text, competitor_product_url text, competitor_seller_name text,
               competitor_marketplace text, competitor_price numeric, our_price numeric, match_status text, last_checked_at timestamptz)
language sql stable security definer set search_path = public as $$
  select distinct on (coalesce(c.our_asin, c.our_sku), coalesce(c.competitor_product_url, c.competitor_product_name))
         c.our_asin, c.our_sku, c.competitor_product_name, c.competitor_product_url, c.competitor_seller_name, c.competitor_marketplace,
         c.competitor_price, c.our_price, c.match_status, c.last_checked_at
  from public.competitor_analysis c
  where c.match_status in ('EXACT MATCH', 'CLOSE EQUIVALENT') and c.competitor_price is not null
    and (p_asin is null or c.our_asin = p_asin)
  order by coalesce(c.our_asin, c.our_sku), coalesce(c.competitor_product_url, c.competitor_product_name), c.last_checked_at desc nulls last
$$;
revoke all on function public.mkt_competitor_prices(text) from public;
grant execute on function public.mkt_competitor_prices(text) to anon, authenticated;

-- Delivery summaries only change when a sweep file is imported, so keep them precomputed (2026-11-18:
-- the full sheet timed out when the database was busy). The live view/function stay for the date picker.
create materialized view if not exists public.mkt_delivery_summary_mv as select * from public.mkt_delivery_summary_v;
create unique index if not exists mkt_delivery_summary_mv_pk on public.mkt_delivery_summary_mv (asin);
create materialized view if not exists public.mkt_delivery_zone_mv as select * from public.mkt_delivery_zone_summary();
create unique index if not exists mkt_delivery_zone_mv_pk on public.mkt_delivery_zone_mv (asin, zone);
grant select on public.mkt_delivery_summary_mv, public.mkt_delivery_zone_mv to anon;

-- Called after a delivery import (importWorkbook); concurrent so readers never wait.
create or replace function public.mkt_refresh_delivery()
returns void language plpgsql security definer set search_path = public as $$
begin
  refresh materialized view concurrently public.mkt_delivery_summary_mv;
  refresh materialized view concurrently public.mkt_delivery_zone_mv;
end $$;
revoke all on function public.mkt_refresh_delivery() from public;
grant execute on function public.mkt_refresh_delivery() to anon;

-- Researched potential-buyer counts per audience group (India), with sources, for TAM suggestions
-- (TAM = buyers x our selling price). Products map to a group in marketing360Rules.ts tamGroup().
create table if not exists public.mkt_tam_research (
  group_key        text primary key,
  buyers           bigint,
  buyer_definition text,
  derivation       text,
  sources          jsonb not null default '[]'::jsonb,
  confidence       text,
  note             text,
  researched_at    timestamptz not null default now()
);
grant select on public.mkt_tam_research to anon;
