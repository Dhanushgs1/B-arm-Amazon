-- 06: read-only order summary for the dashboard's Shopify tab.
-- The dashboard reads Supabase with the anon key, and since 04/05 anon has no access to
-- barm_shopify_orders_v2 or barm_shopify_order_lines_live. This SECURITY DEFINER function returns
-- one row per REAL order (is_test excluded) with order-level fields and its line items only —
-- no customer name, email, phone, address or raw_payload. No table is created or changed.
-- Date = the order's creation day in India time; p_start / p_end are inclusive, null = unbounded.
begin;

create or replace function public.barm_shopify_orders_summary(p_start date default null, p_end date default null)
returns table (
  order_gid text,
  order_name text,
  order_number integer,
  order_date date,
  order_created_at timestamptz,
  financial_status text,
  fulfillment_status text,
  is_cancelled boolean,
  cancel_reason text,
  source_name text,
  tags text,
  currency text,
  order_total_price numeric,
  order_current_total_price numeric,
  order_subtotal_price numeric,
  order_total_tax numeric,
  order_total_shipping numeric,
  order_total_discounts numeric,
  line_count integer,
  item_quantity integer,
  items jsonb
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    o.order_gid,
    max(o.order_name) filter (where o.is_order_primary_row),
    max(o.order_number) filter (where o.is_order_primary_row),
    max((o.order_created_at at time zone 'Asia/Kolkata')::date) filter (where o.is_order_primary_row),
    max(o.order_created_at) filter (where o.is_order_primary_row),
    max(o.financial_status) filter (where o.is_order_primary_row),
    max(o.fulfillment_status) filter (where o.is_order_primary_row),
    bool_or(o.cancelled_at is not null) filter (where o.is_order_primary_row),
    max(o.cancel_reason) filter (where o.is_order_primary_row),
    max(o.source_name) filter (where o.is_order_primary_row),
    max(o.tags) filter (where o.is_order_primary_row),
    max(o.currency) filter (where o.is_order_primary_row),
    max(o.order_total_price) filter (where o.is_order_primary_row),
    max(o.order_current_total_price) filter (where o.is_order_primary_row),
    max(o.order_subtotal_price) filter (where o.is_order_primary_row),
    max(o.order_total_tax) filter (where o.is_order_primary_row),
    max(o.order_total_shipping) filter (where o.is_order_primary_row),
    max(o.order_total_discounts) filter (where o.is_order_primary_row),
    count(o.line_item_gid)::integer,
    coalesce(sum(o.quantity), 0)::integer,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'title', o.title,
          'variant_title', o.variant_title,
          'sku', o.sku,
          'quantity', o.quantity,
          'refunded_quantity', o.refunded_quantity,
          'price', o.price,
          'line_total', o.line_total
        ) order by o.line_position
      ) filter (where o.line_item_gid is not null),
      '[]'::jsonb
    )
  from public.barm_shopify_orders_v2 o
  where not o.is_test
  group by o.order_gid
  having (p_start is null or max((o.order_created_at at time zone 'Asia/Kolkata')::date) filter (where o.is_order_primary_row) >= p_start)
     and (p_end is null or max((o.order_created_at at time zone 'Asia/Kolkata')::date) filter (where o.is_order_primary_row) <= p_end)
  order by max(o.order_created_at) filter (where o.is_order_primary_row);
$$;

revoke all on function public.barm_shopify_orders_summary(date, date) from public;
grant execute on function public.barm_shopify_orders_summary(date, date) to anon, authenticated, service_role;

commit;
