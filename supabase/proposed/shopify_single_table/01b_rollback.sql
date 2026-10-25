-- Rollback for 01b: restores the phase 1 objects to exactly what was live before the patch
-- (function body md5 ee2d7a347e2642d0e5f924b158f16bfc, and the default anon/authenticated SELECT grant).
-- Touches only public.upsert_shopify_order and public.barm_shopify_orders_v2. Legacy tables are not referenced.

begin;

-- pre-patch state had these default grants; RLS (no policies) still returns 0 rows to them
grant select on public.barm_shopify_orders_v2 to anon, authenticated;

create or replace function public.upsert_shopify_order(
  p_body          jsonb,
  p_topic         text default null,
  p_event_id      text default null,
  p_shop_domain   text default null,
  p_triggered_at  timestamptz default null
) returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_order_gid  text := p_body->>'admin_graphql_api_id';
  v_updated    timestamptz := nullif(p_body->>'updated_at', '')::timestamptz;
  v_items      jsonb := coalesce(p_body->'line_items', '[]'::jsonb);
  v_stored     timestamptz;
  v_first_seen timestamptz;
  v_rows       integer;
begin
  if v_order_gid is null then
    raise exception 'Shopify payload has no admin_graphql_api_id';
  end if;

  -- serialise concurrent webhooks for the same order
  perform pg_advisory_xact_lock(hashtext('barm_shopify_order:' || v_order_gid));

  select max(order_updated_at), min(inserted_at)
    into v_stored, v_first_seen
    from barm_shopify_orders_v2
   where order_gid = v_order_gid;

  -- an older webhook arriving late must not overwrite newer data
  if v_stored is not null and v_updated is not null and v_updated < v_stored then
    return 0;
  end if;

  -- replace the order's rows with the latest payload (same transaction, so readers never see a half-written order)
  delete from barm_shopify_orders_v2 where order_gid = v_order_gid;

  insert into barm_shopify_orders_v2 (
    order_gid, line_item_gid, line_position, is_order_primary_row,
    shop_domain, webhook_topic, webhook_event_id, webhook_triggered_at, is_test,
    shopify_order_id, order_name, order_number, confirmation_number, source_name, currency,
    financial_status, fulfillment_status, confirmed, cancel_reason, cancelled_at, closed_at,
    processed_at, order_created_at, order_updated_at,
    order_subtotal_price, order_current_subtotal_price, order_total_line_items_price,
    order_total_discounts, order_current_total_discounts, order_total_shipping, order_total_tax,
    order_total_price, order_current_total_price, order_total_outstanding, taxes_included,
    discount_codes, payment_gateway_names, tags, note, order_line_count,
    customer_id, customer_first_name, customer_last_name, email, phone, buyer_accepts_marketing,
    shipping_name, shipping_phone, shipping_address1, shipping_address2, shipping_city,
    shipping_province, shipping_zip, shipping_country_code,
    billing_name, billing_city, billing_province, billing_zip, billing_country_code,
    product_id, variant_id, sku, title, variant_title, vendor,
    quantity, current_quantity, fulfillable_quantity, refunded_quantity,
    price, line_discount, grams, line_fulfillment_status,
    requires_shipping, taxable, gift_card, product_exists,
    raw_payload, inserted_at, updated_at
  )
  select
    v_order_gid,
    case when li is null then 'NO_LINE_ITEMS' else coalesce(li->>'admin_graphql_api_id', 'LINE_' || pos) end,
    pos,
    pos <= 1,
    coalesce(p_shop_domain, split_part(p_body->>'order_status_url', '/', 3)),
    p_topic, p_event_id, p_triggered_at,
    coalesce((p_body->>'test')::boolean, false),
    nullif(split_part(v_order_gid, '/', 5), '')::bigint,
    p_body->>'name',
    nullif(p_body->>'order_number', '')::integer,
    p_body->>'confirmation_number',
    p_body->>'source_name',
    p_body->>'currency',
    p_body->>'financial_status',
    p_body->>'fulfillment_status',
    (p_body->>'confirmed')::boolean,
    p_body->>'cancel_reason',
    nullif(p_body->>'cancelled_at', '')::timestamptz,
    nullif(p_body->>'closed_at', '')::timestamptz,
    nullif(p_body->>'processed_at', '')::timestamptz,
    nullif(p_body->>'created_at', '')::timestamptz,
    v_updated,
    nullif(p_body->>'subtotal_price', '')::numeric,
    nullif(p_body->>'current_subtotal_price', '')::numeric,
    nullif(p_body->>'total_line_items_price', '')::numeric,
    nullif(p_body->>'total_discounts', '')::numeric,
    nullif(p_body->>'current_total_discounts', '')::numeric,
    nullif(p_body #>> '{total_shipping_price_set,shop_money,amount}', '')::numeric,
    nullif(p_body->>'total_tax', '')::numeric,
    nullif(p_body->>'total_price', '')::numeric,
    nullif(p_body->>'current_total_price', '')::numeric,
    nullif(p_body->>'total_outstanding', '')::numeric,
    (p_body->>'taxes_included')::boolean,
    p_body->'discount_codes',
    array(select jsonb_array_elements_text(coalesce(p_body->'payment_gateway_names', '[]'::jsonb))),
    p_body->>'tags',
    p_body->>'note',
    jsonb_array_length(v_items),
    nullif(split_part(p_body #>> '{customer,admin_graphql_api_id}', '/', 5), '')::bigint,
    p_body #>> '{customer,first_name}',
    p_body #>> '{customer,last_name}',
    coalesce(p_body->>'email', p_body->>'contact_email'),
    coalesce(p_body->>'phone', p_body #>> '{shipping_address,phone}'),
    (p_body->>'buyer_accepts_marketing')::boolean,
    p_body #>> '{shipping_address,name}',
    p_body #>> '{shipping_address,phone}',
    p_body #>> '{shipping_address,address1}',
    p_body #>> '{shipping_address,address2}',
    p_body #>> '{shipping_address,city}',
    p_body #>> '{shipping_address,province}',
    p_body #>> '{shipping_address,zip}',
    p_body #>> '{shipping_address,country_code}',
    p_body #>> '{billing_address,name}',
    p_body #>> '{billing_address,city}',
    p_body #>> '{billing_address,province}',
    p_body #>> '{billing_address,zip}',
    p_body #>> '{billing_address,country_code}',
    nullif(li->>'product_id', '')::bigint,
    nullif(li->>'variant_id', '')::bigint,
    li->>'sku',
    li->>'title',
    li->>'variant_title',
    li->>'vendor',
    nullif(li->>'quantity', '')::integer,
    nullif(li->>'current_quantity', '')::integer,
    nullif(li->>'fulfillable_quantity', '')::integer,
    coalesce((
      select sum((rli->>'quantity')::integer)
        from jsonb_array_elements(coalesce(p_body->'refunds', '[]'::jsonb)) r,
             jsonb_array_elements(coalesce(r->'refund_line_items', '[]'::jsonb)) rli
       where rli #>> '{line_item,admin_graphql_api_id}' = li->>'admin_graphql_api_id'
    ), 0),
    nullif(li->>'price', '')::numeric,
    nullif(li->>'total_discount', '')::numeric,
    nullif(li->>'grams', '')::integer,
    li->>'fulfillment_status',
    (li->>'requires_shipping')::boolean,
    (li->>'taxable')::boolean,
    (li->>'gift_card')::boolean,
    (li->>'product_exists')::boolean,
    p_body,
    coalesce(v_first_seen, now()),
    now()
  from (
    select null::jsonb as li, 0::bigint as pos where jsonb_array_length(v_items) = 0
    union all
    select e, o from jsonb_array_elements(v_items) with ordinality as t(e, o)
  ) items;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke all on function public.upsert_shopify_order(jsonb, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.upsert_shopify_order(jsonb, text, text, text, timestamptz) to service_role;

commit;
