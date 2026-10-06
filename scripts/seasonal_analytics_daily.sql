-- Seasonal Analytics: daily sales history for the Seasonal Analytics tab.
--
-- product_forecast_summary_live_v is the authoritative product/SKU source, but it is a rolling-window
-- snapshot (7D/30D/2M/3M/LTV) with no date column, so it cannot produce a daily history by itself.
-- This function keeps the view authoritative for WHICH products/SKUs exist and HOW they map to the
-- master product (its Marketplace, Product, SKU ID rows), and reads the per-day units from the same
-- order tables the view aggregates, with the view's own dedup keys, cancellation filters and
-- quantity parsing, so a 30-day sum here reconciles with the view's "Total Orders (30D)".
--
-- Master product identity: master_product_skuid has no separate master ID column; its
-- "Product Name" is the master key (the view's "Product" column is exactly that name, resolved per
-- SKU + Platform, falling back to any platform). Rows the view could not map ("Unknown") are
-- returned with mapped = false so the dashboard flags them instead of merging them into a product.
--
-- Missing vs zero: a day with no rows at all for a marketplace is MISSING for that marketplace (no
-- upload), not zero. coverage.dates lists the days each marketplace actually has data for.
--
-- Returns one jsonb document (no 1000-row paging); stored by refresh_seasonal_sales_cache().

create or replace function public.seasonal_sales_daily()
returns jsonb
language sql
stable
set search_path = public
as $$
with
amazon_raw as (
  select distinct on (ao."amazon-order-id", ao.sku)
    ao.sku as sku_id, to_safe_date(ao."purchase-date") as d,
    nullif(regexp_replace(ao.quantity, '[^0-9\.-]', '', 'g'), '')::numeric as q
  from amazon_orders ao
  order by ao."amazon-order-id", ao.sku, ao.id desc nulls last
),
fk_raw as (
  select distinct on (fo.order_id, fo.sku_id)
    fo.sku_id, to_safe_date(fo.order_date) as d,
    nullif(regexp_replace(fo.quantity, '[^0-9.]', '', 'g'), '')::numeric as q
  from fk_orders fo
  where upper(btrim(fo.order_item_status)) <> 'CANCELLED'
  order by fo.order_id, fo.sku_id, fo.id desc nulls last
),
me_raw as (
  select sku_id, d, q from (
    select distinct on (mb."Sub Order No", mb."SKU", mb."Order Date")
      mb."SKU" as sku_id, to_safe_date(mb."Order Date") as d,
      nullif(regexp_replace(mb."Quantity", '[^0-9.]', '', 'g'), '')::numeric as q,
      mb."Reason for Credit Entry" as rce
    from meesho_barm_ord mb
    order by mb."Sub Order No", mb."SKU", mb."Order Date", mb.id desc nulls last
  ) b where upper(btrim(coalesce(b.rce, ''))) <> 'CANCELLED'
  union all
  select sku_id, d, q from (
    select distinct on (mm."Sub Order No", mm."SKU", mm."Order Date")
      mm."SKU" as sku_id, to_safe_date(mm."Order Date") as d,
      nullif(regexp_replace(mm."Quantity", '[^0-9.]', '', 'g'), '')::numeric as q,
      mm."Reason for Credit Entry" as rce
    from meesho_mw_ord mm
    order by mm."Sub Order No", mm."SKU", mm."Order Date", mm.id desc nulls last
  ) m where upper(btrim(coalesce(m.rce, ''))) <> 'CANCELLED'
),
bw_raw as (
  select sku_id, d, q from (
    select distinct on (o."Order Number", o."SKU")
      o."SKU" as sku_id, to_safe_date(o."Order Date") as d,
      nullif(regexp_replace(o."Quantity", '[^0-9.]', '', 'g'), '')::numeric as q
    from barm_online_orders o
    where o."Order Number" is not null and btrim(o."Order Number") <> '' and o."SKU" is not null and btrim(o."SKU") <> ''
    order by o."Order Number", o."SKU", o.id desc nulls last
  ) a
  union all
  select sku_id, d, q from (
    select distinct on (f."Date", f."SKU ID")
      f."SKU ID" as sku_id, to_safe_date(f."Date") as d,
      nullif(regexp_replace(f."Quantity", '[^0-9]', '', 'g'), '')::numeric as q
    from barm_offline_orders f
    where f."Date" is not null and btrim(f."Date") <> '' and f."SKU ID" is not null and btrim(f."SKU ID") <> ''
    order by f."Date", f."SKU ID", f.id desc nulls last
  ) b
),
raw as (
  select 'Amazon'::text as marketplace, sku_id, d, q from amazon_raw
  union all select 'Flipkart', sku_id, d, q from fk_raw
  union all select 'Meesho', sku_id, d, q from me_raw
  union all select 'Barm website', sku_id, d, q from bw_raw
),
vrows as materialized (
  -- the view is expensive (it rebuilds every rolling window); read it exactly once
  select "Marketplace", "SKU ID", "Product", "Current Stock" from product_forecast_summary_live_v
),
universe as (
  select distinct v."Marketplace" as marketplace, v."SKU ID" as sku_id, v."Product" as product
  from vrows v
  where v."SKU ID" is not null and btrim(v."SKU ID") <> ''
),
sku_list as (
  select row_number() over (order by marketplace, sku_id) - 1 as idx, marketplace, sku_id, product,
         (product is not null and product <> 'Unknown') as mapped
  from universe
),
daily as (
  select s.idx, r.d, sum(r.q) as units
  from raw r join sku_list s on s.marketplace = r.marketplace and s.sku_id = r.sku_id
  where r.d is not null and r.q is not null
  group by s.idx, r.d
),
coverage as (
  select marketplace, min(d) as first_date, max(d) as last_date,
         count(distinct d) as days_with_data,
         jsonb_agg(distinct d) as dates
  from raw where d is not null
  group by marketplace
),
quality as (
  select marketplace,
         count(*) filter (where d is null) as unparseable_dates,
         count(*) filter (where q is null) as missing_quantity,
         count(*) filter (where sku_id is null or btrim(sku_id) = '') as missing_sku
  from raw group by marketplace
),
dupes as (
  select 'Amazon' as marketplace, (select count(*) from amazon_orders) - (select count(*) from amazon_raw) as duplicate_rows
  union all select 'Flipkart', (select count(*) from fk_orders where upper(btrim(order_item_status)) <> 'CANCELLED') - (select count(*) from fk_raw)
  union all select 'Meesho', (select count(*) from meesho_barm_ord) + (select count(*) from meesho_mw_ord)
      - (select count(*) from (select distinct "Sub Order No", "SKU", "Order Date" from meesho_barm_ord) x)
      - (select count(*) from (select distinct "Sub Order No", "SKU", "Order Date" from meesho_mw_ord) y)
),
unmatched as (
  -- order rows whose SKU is not in the view's universe for that marketplace (excluded, but counted)
  select r.marketplace, count(*) as rows, coalesce(sum(r.q), 0) as units, count(distinct r.sku_id) as skus
  from raw r left join sku_list s on s.marketplace = r.marketplace and s.sku_id = r.sku_id
  where s.idx is null and r.d is not null
  group by r.marketplace
)
select jsonb_build_object(
  'generated_at', now(),
  'skus', (select coalesce(jsonb_agg(jsonb_build_array(marketplace, sku_id, product, mapped) order by idx), '[]') from sku_list),
  'daily', (select coalesce(jsonb_agg(jsonb_build_array(idx, d, units)), '[]') from daily),
  'coverage', (select coalesce(jsonb_agg(jsonb_build_object('marketplace', marketplace, 'first_date', first_date, 'last_date', last_date, 'days_with_data', days_with_data, 'dates', dates)), '[]') from coverage),
  'quality', (select coalesce(jsonb_agg(to_jsonb(q) || jsonb_build_object('duplicate_rows', coalesce(dp.duplicate_rows, 0))), '[]') from quality q left join dupes dp using (marketplace)),
  -- view rows the dashboard must flag rather than merge: blank SKU ID, unmapped ("Unknown") product
  'view_quality', (select jsonb_build_object(
      'rows', count(*),
      'blank_sku', count(*) filter (where "SKU ID" is null or btrim("SKU ID") = ''),
      'unknown_product', count(*) filter (where "Product" is null or "Product" = 'Unknown'),
      'products', count(distinct "Product") filter (where "Product" is not null and "Product" <> 'Unknown'))
    from vrows),
  'unmatched', (select coalesce(jsonb_agg(to_jsonb(u)), '[]') from unmatched u),
  -- present-day stock per master product, straight from the view (product-level, identical on every row)
  'stock_now', (select coalesce(jsonb_agg(jsonb_build_array(product, current_stock)), '[]') from (
    select "Product" as product, max("Current Stock") as current_stock from vrows
    where "Product" is not null group by 1) sn),
  'stock_daily', (
    select coalesce(jsonb_agg(jsonb_build_array(master_product_name, stock_date, closing_stock)), '[]')
    from (select master_product_name, stock_date, sum(closing_stock) as closing_stock
          from inventory_daily_stock where master_product_name is not null and closing_stock is not null
          group by 1, 2) st
  ),
  'ad_daily', (
    select coalesce(jsonb_agg(jsonb_build_array(mk, sku_id, d, spend)), '[]') from (
      select 'Amazon' as mk, s."Advertised SKU" as sku_id, to_safe_date(s."Date") as d,
             sum(nullif(regexp_replace(s."Total Spend", '[^0-9.\-]', '', 'g'), '')::numeric) as spend
      from amazon_spend s where s."Advertised SKU" is not null and to_safe_date(s."Date") is not null group by 1, 2, 3
      union all
      select 'Flipkart', a."Sku Id", a."Date",
             sum(nullif(regexp_replace(a."Ad Spend", '[^0-9.\-]', '', 'g'), '')::numeric)
      from fk_fsnreport_adspend a where a."Sku Id" is not null and a."Date" is not null group by 1, 2, 3
    ) ad where spend is not null
  )
);
$$;

-- Not granted to anon/authenticated: it is heavy (~10s). Served via seasonal_sales_cache (seasonal_analytics_cache.sql).
revoke execute on function public.seasonal_sales_daily() from public, anon, authenticated;
