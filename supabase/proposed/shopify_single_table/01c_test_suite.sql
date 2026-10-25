-- Test suite for phase 1 + 01b patch. Runs entirely inside one transaction and ROLLS BACK: nothing persists.
-- Paste the body of 01b_patch_review_fixes.sql (without its begin/commit) where marked, so the patched function is what gets tested.
-- Last run 2026-10-22 against project zslujuqitousvywjzqwc: 21/21 PASS.

begin;

-- >>> paste 01b_patch_review_fixes.sql body here (revokes + create or replace function + grants) <<<

create temp table t (step text, expected text, actual text);

do $$
declare
  li1 jsonb := '{"admin_graphql_api_id":"gid://shopify/LineItem/1001","sku":"B-OT-DT12","quantity":1,"current_quantity":1,"price":"599.00","total_discount":"0.00","discount_allocations":[]}';
  li2 jsonb := '{"admin_graphql_api_id":"gid://shopify/LineItem/1002","sku":"B-OVU-CASSETTE-PK5","quantity":3,"current_quantity":3,"price":"249.00","total_discount":"0.00","discount_allocations":[{"amount":"30.00"}]}';
  li3 jsonb := '{"admin_graphql_api_id":"gid://shopify/LineItem/1003","sku":"B-SEAT-BELT-ADJUSTER","quantity":1,"current_quantity":1,"price":"790.00","total_discount":"0.00"}';
  base jsonb := '{"admin_graphql_api_id":"gid://shopify/Order/9001","name":"#T1","currency":"INR","financial_status":"paid","created_at":"2026-10-22T10:00:00+05:30","updated_at":"2026-10-22T10:00:00+05:30","total_price":"2357.00","email":"a@example.com","customer":{"admin_graphql_api_id":"gid://shopify/Customer/77","first_name":"A"},"shipping_address":{"name":"A B","city":"Chennai","zip":"600001","country_code":"IN"},"refunds":[]}';
  b jsonb; n int; err text; r text;
  T0 timestamptz := '2026-10-22 10:00:00.100+05:30';
begin
  b := base || jsonb_build_object('line_items', jsonb_build_array(li1, li2, li3));
  n := upsert_shopify_order(b, 'orders/create', 'evt-A', 'shop', T0);
  insert into t select '01 3 items -> rows / primary / distinct line gids', '3 / 1 / 3', count(*) || ' / ' || count(*) filter (where is_order_primary_row) || ' / ' || count(distinct line_item_gid) from barm_shopify_orders_v2 where order_gid like '%9001';

  n := upsert_shopify_order(b || '{"financial_status":"SHOULD_NOT_APPLY"}', 'orders/create', 'evt-A', 'shop', T0);
  insert into t select '02 duplicate event id -> returned / status', '0 / paid', n || ' / ' || max(financial_status) from barm_shopify_orders_v2 where order_gid like '%9001';

  n := upsert_shopify_order(b || '{"financial_status":"OLDER_SAME_SECOND"}', 'orders/updated', 'evt-B', 'shop', T0 - interval '50 ms');
  insert into t select '03 same second, older trigger -> returned / status', '0 / paid', n || ' / ' || max(financial_status) from barm_shopify_orders_v2 where order_gid like '%9001';

  n := upsert_shopify_order(b || '{"financial_status":"partially_paid"}', 'orders/updated', 'evt-C', 'shop', T0 + interval '50 ms');
  insert into t select '04 same second, newer trigger -> returned / status', '3 / partially_paid', n || ' / ' || max(financial_status) from barm_shopify_orders_v2 where order_gid like '%9001';

  n := upsert_shopify_order(b || '{"financial_status":"paid"}', 'orders/updated', 'evt-D', 'shop', null);
  insert into t select '05 same second, null trigger -> returned / status', '3 / paid', n || ' / ' || max(financial_status) from barm_shopify_orders_v2 where order_gid like '%9001';

  n := upsert_shopify_order(base || '{"updated_at":"2026-10-22T09:00:00+05:30","financial_status":"pending"}' || jsonb_build_object('line_items', jsonb_build_array(li1 || '{"current_quantity":9}')), 'orders/updated', 'evt-E', 'shop', T0 + interval '1 hour');
  insert into t select '06 older updated_at -> returned / status / rows / qty item1', '0 / paid / 3 / 1', n || ' / ' || max(financial_status) || ' / ' || count(*) || ' / ' || max(current_quantity) filter (where sku = 'B-OT-DT12') from barm_shopify_orders_v2 where order_gid like '%9001';

  begin
    n := upsert_shopify_order(b - 'updated_at', 'orders/updated', 'evt-F');
    err := 'NO ERROR';
  exception when others then err := 'error raised';
  end;
  insert into t select '07 null updated_at -> error / rows unchanged', 'error raised / 3', err || ' / ' || count(*) from barm_shopify_orders_v2 where order_gid like '%9001';

  b := base || jsonb_build_object('updated_at', '2026-10-22T11:00:00+05:30', 'financial_status', 'partially_refunded',
         'line_items', jsonb_build_array(li1, li2 || '{"current_quantity":2}'),
         'refunds', '[{"refund_line_items":[{"quantity":1,"line_item":{"admin_graphql_api_id":"gid://shopify/LineItem/1002"}}]},{"refund_line_items":[{"quantity":1,"line_item":{"admin_graphql_api_id":"gid://shopify/LineItem/1002"}}]}]'::jsonb);
  n := upsert_shopify_order(b, 'orders/updated', 'evt-G', 'shop', T0 + interval '1 hour');
  insert into t select '08 edit: rows / removed seat-belt row gone / cassette qty / refunded', '2 / true / 2 / 2',
    count(*) || ' / ' || (count(*) filter (where sku = 'B-SEAT-BELT-ADJUSTER') = 0) || ' / ' || max(current_quantity) filter (where sku = 'B-OVU-CASSETTE-PK5') || ' / ' || max(refunded_quantity) filter (where sku = 'B-OVU-CASSETTE-PK5')
    from barm_shopify_orders_v2 where order_gid like '%9001';

  insert into t select '09 cassette line_total uses discount_allocations', '468.00', line_total::text from barm_shopify_orders_v2 where order_gid like '%9001' and sku = 'B-OVU-CASSETTE-PK5';

  n := upsert_shopify_order(b || '{"updated_at":"2026-10-22T12:00:00+05:30","cancelled_at":"2026-10-22T12:00:00+05:30","cancel_reason":"customer","financial_status":"refunded"}', 'orders/cancelled', 'evt-H', 'shop', T0 + interval '2 hours');
  insert into t select '10 cancel: cancelled rows of total / one inserted_at', '2 of 2 / true', count(*) filter (where cancelled_at is not null) || ' of ' || count(*) || ' / ' || (count(distinct inserted_at) = 1) from barm_shopify_orders_v2 where order_gid like '%9001';

  b := base || '{"admin_graphql_api_id":"gid://shopify/Order/9002","name":"#T2","total_price":"100.00","line_items":[]}';
  n := upsert_shopify_order(b, 'orders/create', 'evt-I');
  select count(*) || ' ' || max(line_item_gid) || ' ' || bool_and(is_order_primary_row) into r from barm_shopify_orders_v2 where order_gid like '%9002';
  b := b || jsonb_build_object('updated_at', '2026-10-22T10:30:00+05:30', 'line_items', jsonb_build_array(li1, li3));
  n := upsert_shopify_order(b, 'orders/updated', 'evt-J');
  select r || ' -> ' || count(*) || ' ' || count(*) filter (where line_item_gid = 'NO_LINE_ITEMS') || ' placeholders' into r from barm_shopify_orders_v2 where order_gid like '%9002';
  b := b || '{"updated_at":"2026-10-22T10:45:00+05:30","line_items":[]}';
  n := upsert_shopify_order(b, 'orders/updated', 'evt-K');
  select r || ' -> ' || count(*) || ' ' || max(line_item_gid) into r from barm_shopify_orders_v2 where order_gid like '%9002';
  insert into t values ('11 placeholder: none -> 2 items -> none', '1 NO_LINE_ITEMS true -> 2 0 placeholders -> 1 NO_LINE_ITEMS', r);

  begin
    insert into barm_shopify_orders_v2 (order_gid, line_item_gid, line_position, is_order_primary_row, raw_payload) values ('gid://shopify/Order/9002', 'NO_LINE_ITEMS', 0, false, '{}');
    err := 'ALLOWED';
  exception when unique_violation then err := 'blocked';
  end;
  insert into t values ('12 duplicate (order_gid, line_item_gid) insert', 'blocked', err);
  begin
    insert into barm_shopify_orders_v2 (order_gid, line_item_gid, line_position, is_order_primary_row, raw_payload) values ('gid://shopify/Order/9001', 'gid://shopify/LineItem/X', 9, true, '{}');
    err := 'ALLOWED';
  exception when unique_violation then err := 'blocked';
  end;
  insert into t values ('13 second primary row for one order', 'blocked', err);

  insert into t select '14 revenue primary-only / naive sum / line_total sum', '2457.00 / 4814.00 / 1067.00',
    sum(order_total_price) filter (where is_order_primary_row) || ' / ' || sum(order_total_price) || ' / ' || sum(line_total) from barm_shopify_orders_v2;

  insert into t select '15 orders with >1 distinct raw_payload/email/city/status', '0',
    count(*)::text from (select order_gid from barm_shopify_orders_v2 group by order_gid
      having count(distinct raw_payload) > 1 or count(distinct email) > 1 or count(distinct shipping_city) > 1 or count(distinct financial_status) > 1 or count(distinct order_updated_at) > 1) x;
end $$;

do $$
declare res text;
begin
  begin execute 'set local role anon'; perform count(*) from public.barm_shopify_orders_v2; execute 'reset role'; res := 'ALLOWED';
  exception when insufficient_privilege then res := 'denied'; end;
  insert into t values ('16 anon SELECT table', 'denied', res);
  begin execute 'set local role anon'; perform public.upsert_shopify_order('{"admin_graphql_api_id":"gid://shopify/Order/1","updated_at":"2026-10-22T10:00:00Z"}'); execute 'reset role'; res := 'ALLOWED';
  exception when insufficient_privilege then res := 'denied'; end;
  insert into t values ('17 anon EXECUTE function', 'denied', res);
  begin execute 'set local role authenticated'; insert into public.barm_shopify_orders_v2 (order_gid, line_item_gid, line_position, is_order_primary_row, raw_payload) values ('x','y',1,true,'{}'); execute 'reset role'; res := 'ALLOWED';
  exception when insufficient_privilege then res := 'denied'; end;
  insert into t values ('18 authenticated INSERT table', 'denied', res);
  begin execute 'set local role authenticated'; perform public.upsert_shopify_order('{"admin_graphql_api_id":"gid://shopify/Order/1","updated_at":"2026-10-22T10:00:00Z"}'); execute 'reset role'; res := 'ALLOWED';
  exception when insufficient_privilege then res := 'denied'; end;
  insert into t values ('19 authenticated EXECUTE function', 'denied', res);
  execute 'set local role service_role';
  perform public.upsert_shopify_order('{"admin_graphql_api_id":"gid://shopify/Order/9003","updated_at":"2026-10-22T10:00:00Z","line_items":[]}');
  select count(*)::text into res from public.barm_shopify_orders_v2 where order_gid like '%9003';
  execute 'reset role';
  insert into t values ('20 service_role EXECUTE + read back', '1', res);
end $$;

-- run the phase 1 rollback inside the same transaction and prove the old tables are untouched
drop function if exists public.upsert_shopify_order(jsonb, text, text, text, timestamptz);
drop table if exists public.barm_shopify_orders_v2;
insert into t select '21 after 01_rollback: v2 / fn / v2 seq gone; old tables + rows',
  'null / null / null; barm_shopify_orders 0, barm_shopify_order_items 0',
  coalesce(to_regclass('public.barm_shopify_orders_v2')::text, 'null') || ' / ' ||
  coalesce(to_regprocedure('public.upsert_shopify_order(jsonb, text, text, text, timestamptz)')::text, 'null') || ' / ' ||
  coalesce(to_regclass('public.barm_shopify_orders_v2_id_seq')::text, 'null') || '; ' ||
  to_regclass('public.barm_shopify_orders') || ' ' || (select count(*) from barm_shopify_orders) || ', ' ||
  to_regclass('public.barm_shopify_order_items') || ' ' || (select count(*) from barm_shopify_order_items);

create temp table t_out as select step, expected, actual, case when expected = actual then 'PASS' else 'FAIL' end as verdict from t;
select * from t_out order by step;

rollback;
