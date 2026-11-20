-- FC Forecast (2026-11-20): website/Shopify lines read through barm_shopify_orders_summary(), because the anon
-- key cannot read barm_shopify_orders_v2 (found by the anon RPC smoke check). Replaces the two functions
-- from 20261120130000_fc_forecast_functions.sql.

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
  -- Website, Shopify (from 17 Sep 2026). The anon key cannot read barm_shopify_orders_v2, so read the
  -- SECURITY DEFINER barm_shopify_orders_summary() the Shopify tab uses (real orders only, no customer data).
  select o.order_date, 'website', it->>'sku', it->>'title',
         greatest(coalesce((it->>'quantity')::numeric, 0) - coalesce((it->>'refunded_quantity')::numeric, 0), 0)
  from public.barm_shopify_orders_summary() o, jsonb_array_elements(coalesce(o.items, '[]'::jsonb)) it
  where not o.is_cancelled
    and o.order_date between p_from and p_to
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

create or replace function public.fc_source_dates()
returns table(channel text, source text, max_day date)
language sql stable security invoker as $$
  select 'amazon', 'amazon_orders', (select max(left("purchase-date", 10))::date from public.amazon_orders where "fulfillment-channel" = 'Merchant')
  union all select 'amazon', 'barm_daily_am_orders', (select max(report_date) from public.barm_daily_am_orders)
  union all select 'flipkart', 'barm_flipkart_order_report', (select max(order_date) from public.barm_flipkart_order_report)
  union all select 'flipkart', 'barm_daily_fk_orders', (select max(report_date) from public.barm_daily_fk_orders)
  union all select 'meesho', 'barm_daily_ms_barm_orders', (select max(report_date) from public.barm_daily_ms_barm_orders)
  union all select 'website', 'barm_shopify_orders_summary', (select max(order_date) from public.barm_shopify_orders_summary())
  union all select 'sellerflex', 'barm_sellerflex_shipments', (select max(shipment_creation_date) from public.barm_sellerflex_shipments)
$$;

