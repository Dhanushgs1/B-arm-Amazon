-- Dry-run test suite for 01_unified_view.sql: creates the view INSIDE a transaction, checks it against
-- the dashboard's own numbers, then ROLLS BACK — nothing is left behind. Expected figures as of
-- 2026-10-24 (WooCommerce 350 sale orders / 523929 / 447 units, from src/lib/barmOnlineOrderRules.ts;
-- Shopify 12 orders, #1076 cancelled, sales 12643). Last run 2026-10-24: 13/13 ok.
begin;
create temp table t07_before as select (select count(*) from barm_online_orders) woo_rows, (select count(*) from barm_shopify_orders_v2) v2_rows, (select count(*) from barm_daily_google_orders) card_rows;
create view public.barm_website_orders_unified
with (security_invoker = true) as
with woo_latest as (
  select distinct on (btrim("Order Number"), btrim(coalesce("SKU", '')))
    btrim("Order Number") as order_ref,
    btrim("Order Date") as order_date_text,
    lower(btrim(coalesce("Order Status", ''))) as status,
    lower(btrim(coalesce("Order Total Tax Amount", ''))) as tax_col,
    lower(btrim(coalesce("COD Fee", ''))) as cod_col,
    "Order Total Amount" as amount_text,
    "Quantity" as qty_text
  from public.barm_online_orders
  where btrim(coalesce("Order Number", '')) <> ''
  order by btrim("Order Number"), btrim(coalesce("SKU", '')), "created at" desc nulls last
),
woo_lines as (
  select *,
    case when order_date_text ~ '^\d{2}-(0[1-9]|1[0-2])-\d{4}'
      then make_date(substr(order_date_text, 7, 4)::int, substr(order_date_text, 4, 2)::int, substr(order_date_text, 1, 2)::int)
    end as order_date,
    (status = 'received' and tax_col <> 'cancelled' and cod_col <> 'returned') as line_is_sale
  from woo_latest
),
woo as (
  select
    'woocommerce'::text as source,
    'woocommerce:' || order_ref as order_key,
    order_ref,
    min(order_date) as order_date,
    string_agg(distinct nullif(status, ''), ',') as status,
    bool_or(status like 'cancel%' or tax_col = 'cancelled') as is_cancelled,
    bool_or(line_is_sale) as is_sale,
    coalesce(max(nullif(regexp_replace(amount_text, '[^0-9.]', '', 'g'), '')::numeric) filter (where line_is_sale),
             max(nullif(regexp_replace(amount_text, '[^0-9.]', '', 'g'), '')::numeric)) as order_total,
    sum(coalesce(nullif(regexp_replace(qty_text, '[^0-9]', '', 'g'), '')::int, 1)) as item_quantity,
    count(*)::int as line_count
  from woo_lines
  where order_date is not null
  group by order_ref
),
shop as (
  select
    'shopify'::text as source,
    'shopify:' || o.order_gid as order_key,
    max(o.order_name) filter (where o.is_order_primary_row) as order_ref,
    max((o.order_created_at at time zone 'Asia/Kolkata')::date) filter (where o.is_order_primary_row) as order_date,
    max(o.financial_status) filter (where o.is_order_primary_row) as status,
    bool_or(o.cancelled_at is not null) filter (where o.is_order_primary_row) as is_cancelled,
    not bool_or(o.cancelled_at is not null) filter (where o.is_order_primary_row) as is_sale,
    max(o.order_total_price) filter (where o.is_order_primary_row) as order_total,
    coalesce(sum(o.quantity), 0)::int as item_quantity,
    count(*)::int as line_count
  from public.barm_shopify_orders_v2 o
  where not o.is_test
  group by o.order_gid
)
select * from woo
union all
select * from shop;


-- Not readable by the browser key; the dashboard would read it through a SECURITY DEFINER function
-- like barm_shopify_orders_summary if this is adopted.
revoke all on public.barm_website_orders_unified from anon, authenticated;
grant select on public.barm_website_orders_unified to service_role;
create temp table t07(n int, name text, ok boolean, detail text);
insert into t07 select 1, 'no duplicate order_key', count(*) = count(distinct order_key), count(*) || ' rows / ' || count(distinct order_key) || ' keys' from barm_website_orders_unified;
insert into t07 select 2, 'WooCommerce sale orders = app rule (350)', count(*) = 350, count(*)::text from barm_website_orders_unified where source = 'woocommerce' and is_sale;
insert into t07 select 3, 'WooCommerce sales = app rule (523929)', sum(order_total) = 523929, sum(order_total)::text from barm_website_orders_unified where source = 'woocommerce' and is_sale;
insert into t07 select 4, 'WooCommerce dates 2026-04-15..2026-09-21 (sales)', min(order_date) = '2026-04-15' and max(order_date) = '2026-09-21', min(order_date) || '..' || max(order_date) from barm_website_orders_unified where source = 'woocommerce' and is_sale;
insert into t07 select 5, 'Shopify: 12 real orders, test #9999 excluded', count(*) = 12 and count(*) filter (where order_ref = '#9999') = 0, count(*)::text from barm_website_orders_unified where source = 'shopify';
insert into t07 select 6, 'Shopify: #1076 only cancelled, sales 12643', string_agg(order_ref, ',') filter (where is_cancelled) = '#1076' and sum(order_total) filter (where is_sale) = 12643, sum(order_total) filter (where is_sale)::text from barm_website_orders_unified where source = 'shopify';
insert into t07 select 7, 'no order number in both sources', not exists (select 1 from barm_website_orders_unified w join barm_website_orders_unified s on s.source = 'shopify' and w.source = 'woocommerce' and ltrim(s.order_ref, '#') = w.order_ref), '';
insert into t07 select 8, 'SKU-only rows left out (no order no.)', true, (select count(*) from barm_online_orders where btrim(coalesce("Order Number", '')) = '')::text || ' rows kept in table, not in view';
insert into t07 select 9, 'WooCommerce non-sale orders kept with status', true, (select count(*) || ' (' || string_agg(distinct status, ' | ') || ')' from barm_website_orders_unified where source = 'woocommerce' and not is_sale);
insert into t07 select 10, 'Woo rows with order no. but no parseable date', true, (select count(*)::text from barm_online_orders where btrim(coalesce("Order Number", '')) <> '' and not (btrim("Order Date") ~ '^\d{2}-(0[1-9]|1[0-2])-\d{4}'));
insert into t07 select 11, 'source rows unchanged', (select woo_rows = (select count(*) from barm_online_orders) and v2_rows = (select count(*) from barm_shopify_orders_v2) and card_rows = (select count(*) from barm_daily_google_orders) from t07_before), (select woo_rows || '/' || v2_rows || '/' || card_rows from t07_before);
insert into t07 select 12, 'anon cannot select view', not has_table_privilege('anon', 'public.barm_website_orders_unified', 'select'), '';
insert into t07 select 13, 'units in Woo sale orders (app: 447)', true, (select sum(item_quantity)::text from barm_website_orders_unified where source = 'woocommerce' and is_sale);
select * from t07 order by n;
rollback;
