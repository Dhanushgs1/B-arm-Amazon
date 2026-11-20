-- FC Forecast review fixes (2026-11-20).
-- 1. fc_norm_sku strips the same edge whitespace as JS String.trim() (tab, CR/LF, NBSP, U+2000–U+200A,
--    U+3000, ...), so a SKU mapped from the page (normalizeSku in src/lib/sellerFlexShipments.ts) always
--    matches its sales. Existing fc_sku_product_map rows were JS-trimmed, so they still pass the CHECK.
-- 2. Woo dates are parsed in a CTE behind a CASE, never before the shape test.

create or replace function public.fc_norm_sku(s text) returns text
language sql immutable parallel safe as $$
  select lower(regexp_replace(
    regexp_replace(coalesce(s, ''), '[\u200B-\u200F\uFEFF]', '', 'g'),
    '^[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+|[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+$', '', 'g'))
$$;

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
  ),
  -- Parse the date only where it has the DD-MM-YYYY shape: Postgres does not promise to test the regex
  -- before to_date() in one WHERE, and one malformed row must not break every forecast call.
  woo_dated as (
    select w.*, case when w."Order Date" ~ '^(0[1-9]|[12][0-9]|3[01])-(0[1-9]|1[0-2])-\d{4}'
                     then to_date(left(w."Order Date", 10), 'DD-MM-YYYY') end as order_day
    from woo_latest w
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
  select w.order_day, 'website', btrim(w."SKU"), w."Item Name",
         coalesce(nullif(regexp_replace(coalesce(w."Quantity", ''), '[^0-9.]', '', 'g'), '')::numeric, 1)
  from woo_dated w
  where w.order_day between p_from and p_to
    and lower(btrim(coalesce(w."Order Status", ''))) = 'received'
    and lower(btrim(coalesce(w."Order Total Tax Amount", ''))) <> 'cancelled'
    and lower(btrim(coalesce(w."COD Fee", ''))) <> 'returned'
  union all
  -- Amazon Seller Flex customer shipments.
  select x.shipment_creation_date, 'sellerflex', x.sku, null::text, x.units::numeric
  from public.barm_sellerflex_shipments x
  where coalesce(x.status, '') not ilike 'cancel%'
    and x.shipment_creation_date between p_from and p_to
$$;

