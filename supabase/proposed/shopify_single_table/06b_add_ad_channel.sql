-- 06b: adds ad_channel to barm_shopify_orders_summary so the Ad Spend Report's Google row can credit
-- Google Ads only with orders whose visit came from a Google Ads click (gclid / gbraid / wbraid /
-- gad_source / gad_campaignid on the landing URL). Labels: google_ads, meta_ads, google_organic,
-- direct, other. Only the label leaves the function, never the URLs. The return type changes, so the
-- function is dropped and recreated with the same grants. Rollback: 06b_rollback.sql.
begin;

drop function if exists public.barm_shopify_orders_summary(date, date);

create function public.barm_shopify_orders_summary(p_start date default null, p_end date default null)
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
  items jsonb,
  ad_channel text
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
    ),
    -- Where the visit that placed the order came from: Shopify's landing_site / referring_site.
    max(case
      when o.raw_payload->>'landing_site' ~* '[?&](gclid|gbraid|wbraid|gad_source|gad_campaignid)=' then 'google_ads'
      when o.raw_payload->>'landing_site' ~* '[?&]fbclid=' then 'meta_ads'
      when o.raw_payload->>'landing_site' ~* '[?&]srsltid='
        or o.raw_payload->>'referring_site' ~* '^https?://([a-z0-9-]+\.)*google\.' then 'google_organic'
      when coalesce(o.raw_payload->>'referring_site', '') = '' then 'direct'
      else 'other'
    end) filter (where o.is_order_primary_row)
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
