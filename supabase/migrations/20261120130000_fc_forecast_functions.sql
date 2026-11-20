-- FC Forecast tab (2026-11-20): read-only functions behind /dashboard/inventory/fc-forecast.
-- Sources and filters: docs/superpowers/specs/2026-11-20-fc-forecast-design.md ("Data sources").
-- Every channel excludes cancelled orders; day = IST calendar day.

-- One row per sold order line in [p_from, p_to], from the five self-ship channels.
create or replace function public.fc_sales_lines(p_from date, p_to date)
returns table(day date, channel text, sku text, title text, units numeric)
language sql stable security invoker as $$
  with
  am_max as (select max(left("purchase-date", 10))::date d from public.amazon_orders where "fulfillment-channel" = 'Merchant'),
  fk_max as (select max(order_date) d from public.barm_flipkart_order_report),
  woo_latest as (
    select distinct on (btrim("Order Number"), btrim("SKU")) *
    from public.barm_online_orders
    where btrim(coalesce("Order Number", '')) <> ''
    order by btrim("Order Number"), btrim("SKU"), "created at" desc nulls last
  )
  -- Amazon self-ship: full order report up to its last day, then the daily upload.
  select left(o."purchase-date", 10)::date, 'amazon', o.sku, o."product-name", coalesce(nullif(o.quantity, '')::numeric, 0)
  from public.amazon_orders o, am_max
  where o."fulfillment-channel" = 'Merchant'
    and coalesce(o."order-status", '') not ilike 'cancel%'
    and o."purchase-date" >= p_from::text
    and o."purchase-date" < (least(p_to, am_max.d) + 1)::text
  union all
  select d.report_date, 'amazon', d.sku, d.product_name, coalesce(d.quantity, 0)
  from public.barm_daily_am_orders d, am_max
  where d.raw->>'fulfillment-channel' = 'Merchant'
    and coalesce(d.order_status, '') not ilike 'cancel%'
    and d.report_date between greatest(p_from, coalesce(am_max.d, p_from - 1) + 1) and p_to
  union all
  -- Flipkart self-ship (not FBF): order report up to its last day, then the daily upload.
  select f.order_date, 'flipkart', f.sku, f.product_title, coalesce(f.quantity, 0)
  from public.barm_flipkart_order_report f, fk_max
  where coalesce(f.fulfilment_type, f.raw->>'fulfilment_type', '') <> 'FBF'
    and coalesce(f.order_item_status, f.raw->>'order_item_status', '') not ilike 'cancel%'
    and f.order_date between p_from and least(p_to, fk_max.d)
  union all
  select d.report_date, 'flipkart', d.sku, d.product_name, coalesce(d.quantity, 0)
  from public.barm_daily_fk_orders d, fk_max
  where coalesce(d.raw->>'fulfilment_type', '') <> 'FBF'
    and coalesce(d.order_status, '') not ilike 'cancel%'
    and d.report_date between greatest(p_from, coalesce(fk_max.d, p_from - 1) + 1) and p_to
  union all
  -- Meesho (B Arm account).
  select m.report_date, 'meesho', m.sku, m.product_name, coalesce(m.quantity, 0)
  from public.barm_daily_ms_barm_orders m
  where coalesce(m.order_status, '') not ilike 'cancel%'
    and m.report_date between p_from and p_to
  union all
  -- Website, Shopify (from 17 Sep 2026).
  select (s.order_created_at at time zone 'Asia/Kolkata')::date, 'website', s.sku, s.title, coalesce(s.current_quantity, s.quantity, 0)
  from public.barm_shopify_orders_v2 s
  where not coalesce(s.is_test, false)
    and s.cancelled_at is null
    and (s.order_created_at at time zone 'Asia/Kolkata')::date between p_from and p_to
  union all
  -- Website, WooCommerce history — rules of src/lib/barmOnlineOrderRules.ts.
  select to_date(left(w."Order Date", 10), 'DD-MM-YYYY'), 'website', btrim(w."SKU"), w."Item Name",
         coalesce(nullif(regexp_replace(coalesce(w."Quantity", ''), '[^0-9.]', '', 'g'), '')::numeric, 1)
  from woo_latest w
  where w."Order Date" ~ '^\d{2}-(0[1-9]|1[0-2])-\d{4}'
    and lower(btrim(coalesce(w."Order Status", ''))) = 'received'
    and lower(btrim(coalesce(w."Order Total Tax Amount", ''))) <> 'cancelled'
    and lower(btrim(coalesce(w."COD Fee", ''))) <> 'returned'
    and to_date(left(w."Order Date", 10), 'DD-MM-YYYY') between p_from and p_to
  union all
  -- Amazon Seller Flex customer shipments.
  select x.shipment_creation_date, 'sellerflex', x.sku, null::text, x.units::numeric
  from public.barm_sellerflex_shipments x
  where coalesce(x.status, '') not ilike 'cancel%'
    and x.shipment_creation_date between p_from and p_to
$$;

-- Sales lines with their product: client map first, then master_product_skuid, else null (unmapped).
create or replace function public.fc_mapped_lines(p_from date, p_to date)
returns table(day date, channel text, sku text, title text, units numeric, product text)
language sql stable security invoker as $$
  with master as (
    select distinct on (public.fc_norm_sku("SKU ID")) public.fc_norm_sku("SKU ID") k, btrim("Product Name") product
    from public.master_product_skuid
    where public.fc_norm_sku("SKU ID") <> '' and btrim(coalesce("Product Name", '')) <> ''
    order by public.fc_norm_sku("SKU ID"), id
  )
  select l.day, l.channel, l.sku, l.title, l.units, coalesce(m.product, ms.product)
  from public.fc_sales_lines(p_from, p_to) l
  left join public.fc_sku_product_map m on m.sku = public.fc_norm_sku(l.sku)
  left join master ms on ms.k = public.fc_norm_sku(l.sku)
$$;

-- The forecast: one row per product. Blocks are rolling 30-day windows ending p_as_of.
create or replace function public.fc_forecast(p_as_of date)
returns table(
  product text, block1 numeric, block2 numeric, block3 numeric, peak numeric, last30 numeric, max_units numeric, min_stock int,
  ch_amazon numeric, ch_flipkart numeric, ch_meesho numeric, ch_website numeric, ch_sellerflex numeric,
  b1_from date, b1_to date, b2_from date, b2_to date, b3_from date, b3_to date
)
language sql stable security invoker as $$
  with
  lines as (select * from public.fc_mapped_lines(p_as_of - 89, p_as_of) where product is not null),
  agg as (
    select product,
      sum(units) filter (where day >= p_as_of - 29) b1,
      sum(units) filter (where day between p_as_of - 59 and p_as_of - 30) b2,
      sum(units) filter (where day <= p_as_of - 60) b3,
      sum(units) filter (where day >= p_as_of - 29 and channel = 'amazon') a,
      sum(units) filter (where day >= p_as_of - 29 and channel = 'flipkart') f,
      sum(units) filter (where day >= p_as_of - 29 and channel = 'meesho') m,
      sum(units) filter (where day >= p_as_of - 29 and channel = 'website') w,
      sum(units) filter (where day >= p_as_of - 29 and channel = 'sellerflex') s
    from lines group by product
  ),
  prods as (
    select product from public.fc_products where active
    union
    select product from agg
  ),
  t as (
    select p.product,
      coalesce(a.b1, 0) b1, coalesce(a.b2, 0) b2, coalesce(a.b3, 0) b3,
      coalesce(a.a, 0) a, coalesce(a.f, 0) f, coalesce(a.m, 0) m, coalesce(a.w, 0) w, coalesce(a.s, 0) s
    from prods p left join agg a using (product)
  )
  select product, b1, b2, b3,
    greatest(b1, b2, b3) peak,
    b1 last30,
    greatest(greatest(b1, b2, b3), b1) max_units,
    greatest(round(greatest(greatest(b1, b2, b3), b1) * 1.5), 5)::int min_stock,
    a, f, m, w, s,
    p_as_of - 29, p_as_of, p_as_of - 59, p_as_of - 30, p_as_of - 89, p_as_of - 60
  from t
  order by min_stock desc, product
$$;

-- SKUs sold in the 90 days ending p_as_of that map to no product.
create or replace function public.fc_unmapped_skus(p_as_of date)
returns table(sku text, channel text, units_90d numeric, sample_title text)
language sql stable security invoker as $$
  select min(sku), channel, sum(units), max(title)
  from public.fc_mapped_lines(p_as_of - 89, p_as_of)
  where product is null
  group by public.fc_norm_sku(sku), channel
  order by sum(units) desc
$$;

-- Newest day per source table, for the page's "data up to" line.
create or replace function public.fc_source_dates()
returns table(channel text, source text, max_day date)
language sql stable security invoker as $$
  select 'amazon', 'amazon_orders', (select max(left("purchase-date", 10))::date from public.amazon_orders where "fulfillment-channel" = 'Merchant')
  union all select 'amazon', 'barm_daily_am_orders', (select max(report_date) from public.barm_daily_am_orders)
  union all select 'flipkart', 'barm_flipkart_order_report', (select max(order_date) from public.barm_flipkart_order_report)
  union all select 'flipkart', 'barm_daily_fk_orders', (select max(report_date) from public.barm_daily_fk_orders)
  union all select 'meesho', 'barm_daily_ms_barm_orders', (select max(report_date) from public.barm_daily_ms_barm_orders)
  union all select 'website', 'barm_shopify_orders_v2', (select max((order_created_at at time zone 'Asia/Kolkata')::date) from public.barm_shopify_orders_v2 where not coalesce(is_test, false))
  union all select 'sellerflex', 'barm_sellerflex_shipments', (select max(shipment_creation_date) from public.barm_sellerflex_shipments)
$$;

grant execute on function public.fc_sales_lines(date, date)   to anon;
grant execute on function public.fc_mapped_lines(date, date)  to anon;
grant execute on function public.fc_forecast(date)            to anon;
grant execute on function public.fc_unmapped_skus(date)       to anon;
grant execute on function public.fc_source_dates()            to anon;
