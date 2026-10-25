-- PROPOSED — NOT APPLIED. One reliable list of B-ARM website orders across both platforms, without
-- copying, moving or changing a single source row:
--   source 'woocommerce' = barm_online_orders (the old site, up to the Shopify move, 21 Sep 2026)
--   source 'shopify'     = barm_shopify_orders_v2 (webhooks; test orders left out)
-- One row per order. Duplicates are impossible by construction:
--   - WooCommerce: the same (Order Number, SKU) loaded twice -> latest "created at" wins, then one row
--     per Order Number (the dashboard's own rule, src/lib/barmOnlineOrderRules.ts);
--   - Shopify: one row per order_gid (v2 is unique on order + line item);
--   - order_key carries the source, so a WooCommerce and a Shopify number can never collide.
-- Left out on purpose (listed by 01c, never deleted): barm_online_orders rows with no Order Number
-- (SKU-only rows pasted in after the move — no amount, no order id; the real orders are in Shopify)
-- and rows with no parseable date. barm_daily_google_orders (Google card uploads) is an input to the
-- Ad Spend Report only, not an order record, and stays out.
-- is_sale follows each source's sales rule: WooCommerce = Received and not shifted to
-- "cancelled"/"returned"; Shopify = not cancelled. Not sales still appear, with their status.
-- Rollback: 01_rollback.sql (drops the view only).
begin;

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

comment on view public.barm_website_orders_unified is
  'B-ARM website orders, one row per order: WooCommerce (barm_online_orders, before the Shopify move) + Shopify (barm_shopify_orders_v2, test orders excluded). Read-only view; no data copied. Proposed 2026-10-24.';

-- Not readable by the browser key; the dashboard would read it through a SECURITY DEFINER function
-- like barm_shopify_orders_summary if this is adopted.
revoke all on public.barm_website_orders_unified from anon, authenticated;
grant select on public.barm_website_orders_unified to service_role;

commit;
