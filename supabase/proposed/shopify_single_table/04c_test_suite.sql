-- Test suite for 04_shopify_hmac_ingest.sql. One transaction, ends in ROLLBACK: nothing persists.
-- Paste the body of 04_shopify_hmac_ingest.sql (without begin/commit) where marked if 04 is not applied yet.
-- If no Vault secret 'shopify_webhook_secret' exists, a DUMMY one is created inside the transaction and discarded.
-- Valid signatures are computed in SQL from whatever secret Vault holds; the secret is never selected or printed.

begin;

-- >>> paste 04_shopify_hmac_ingest.sql body here when testing before it is applied <<<

create temp table t (step text, expected text, actual text);
create temp table t_flags as
  select not exists (select 1 from vault.secrets where name = 'shopify_webhook_secret') as created_dummy;
select vault.create_secret('dummy-test-secret-not-real', 'shopify_webhook_secret')
  from t_flags where created_dummy;

create function pg_temp.sign(p_body text) returns text language sql as $$
  select encode(extensions.hmac(convert_to(p_body, 'UTF8'),
                convert_to((select decrypted_secret from vault.decrypted_secrets where name = 'shopify_webhook_secret'), 'UTF8'),
                'sha256'), 'base64')
$$;
create function pg_temp.b64(p_body text) returns text language sql as $$ select encode(convert_to(p_body, 'UTF8'), 'base64') $$;

do $$
declare
  -- pretty-printed on purpose: the signature must be checked on these exact bytes, not on re-serialised JSON
  body text := E'{\n  "id": 820982911946154508,\n  "admin_graphql_api_id": "gid://shopify/Order/820982911946154508",\n  "name": "#9999",\n  "test": true,\n  "email": "jon@example.com",\n  "shipping_address": {"name": "Steve Shipper", "city": "Shippington"},\n  "updated_at": "2026-10-22T16:04:24+05:30",\n  "total_price": "1672.98",\n  "line_items": [\n    {"id": 866550311766439020, "admin_graphql_api_id": "gid://shopify/LineItem/866550311766439020", "sku": "B-OT-DT12", "quantity": 1, "current_quantity": 1, "price": "599.00"},\n    {"id": 141249953214522974, "admin_graphql_api_id": "gid://shopify/LineItem/141249953214522974", "sku": "B-OVU-CASSETTE-PK5", "quantity": 1, "current_quantity": 1, "price": "249.00"}\n  ]\n}';
  shop text := 'sjtpux-5d.myshopify.com';
  trg  text := '2026-10-22T10:34:25.126662602Z';
  b2 text; r jsonb;
begin
  r := public.ingest_shopify_webhook(pg_temp.b64(body), pg_temp.sign(body), 'orders/create', 'evt-1', shop, trg);
  insert into t select '01 valid create: outcome / http / rows', 'applied / 200 / 2', (r->>'outcome') || ' / ' || (r->>'http_status') || ' / ' || (r->>'rows_written');
  insert into t select '02 big ids exact: shopify_order_id / raw id / line raw id', '820982911946154508 / 820982911946154508 / 866550311766439020',
    max(shopify_order_id) || ' / ' || max(raw_payload->>'id') || ' / ' || max(raw_payload #>> '{line_items,0,id}')
    from public.barm_shopify_orders_v2 where order_gid = 'gid://shopify/Order/820982911946154508';

  r := public.ingest_shopify_webhook(pg_temp.b64(body), pg_temp.sign(body), 'orders/create', 'evt-1', shop, trg);
  insert into t select '03 duplicate event: outcome / http / rows in table', 'skipped_stale_or_duplicate / 200 / 2',
    (r->>'outcome') || ' / ' || (r->>'http_status') || ' / ' || (select count(*) from public.barm_shopify_orders_v2 where order_gid like '%820982911946154508');

  r := public.ingest_shopify_webhook(pg_temp.b64(body::jsonb::text), pg_temp.sign(body), 'orders/create', 'evt-2', shop, trg);
  insert into t select '04 re-serialised body with original signature', 'rejected_signature / 401', (r->>'outcome') || ' / ' || (r->>'http_status');

  b2 := replace(body, '#9999', '#9998');
  r := public.ingest_shopify_webhook(pg_temp.b64(b2), pg_temp.sign(body), 'orders/updated', 'evt-3', shop, trg);
  insert into t select '05 tampered body: outcome / order name unchanged', 'rejected_signature / #9999',
    (r->>'outcome') || ' / ' || (select max(order_name) from public.barm_shopify_orders_v2 where order_gid like '%820982911946154508');

  r := public.ingest_shopify_webhook(pg_temp.b64(body), null, 'orders/create', 'evt-4', shop, trg);
  insert into t select '06 missing signature', 'rejected_signature / 401', (r->>'outcome') || ' / ' || (r->>'http_status');

  r := public.ingest_shopify_webhook(pg_temp.b64(body), 'AAAA' || pg_temp.sign(body), 'orders/create', 'evt-5', shop, trg);
  insert into t select '07 wrong signature', 'rejected_signature / 401', (r->>'outcome') || ' / ' || (r->>'http_status');

  r := public.ingest_shopify_webhook(pg_temp.b64(body), pg_temp.sign(body), 'orders/create', 'evt-6', 'evil-shop.myshopify.com', trg);
  insert into t select '08 signed but other shop', 'rejected_shop / 403', (r->>'outcome') || ' / ' || (r->>'http_status');

  r := public.ingest_shopify_webhook(pg_temp.b64(body), pg_temp.sign(body), 'orders/paid', 'evt-7', shop, trg);
  insert into t select '09 signed but unsupported topic', 'rejected_topic / 422', (r->>'outcome') || ' / ' || (r->>'http_status');
  r := public.ingest_shopify_webhook(pg_temp.b64(body), pg_temp.sign(body), null, 'evt-7b', shop, trg);
  insert into t select '10 signed but missing topic', 'rejected_topic / 422', (r->>'outcome') || ' / ' || (r->>'http_status');

  r := public.ingest_shopify_webhook('%%% not base64 %%%', 'x', 'orders/create', 'evt-8', shop, trg);
  insert into t select '11 body not base64', 'rejected_payload / 400', (r->>'outcome') || ' / ' || (r->>'http_status');
  r := public.ingest_shopify_webhook(pg_temp.b64('hello'), pg_temp.sign('hello'), 'orders/create', 'evt-9', shop, trg);
  insert into t select '12 signed but not JSON', 'rejected_payload / 400', (r->>'outcome') || ' / ' || (r->>'http_status');
  r := public.ingest_shopify_webhook(pg_temp.b64('[1,2]'), pg_temp.sign('[1,2]'), 'orders/create', 'evt-9b', shop, trg);
  insert into t select '13 signed JSON but not an object', 'rejected_payload / 400', (r->>'outcome') || ' / ' || (r->>'http_status');

  b2 := replace(body, '2026-10-22T16:04:24+05:30', '2026-10-22T17:00:00+05:30');
  b2 := replace(b2, '"total_price": "1672.98"', '"total_price": "1672.98", "financial_status": "partially_refunded"');
  r := public.ingest_shopify_webhook(pg_temp.b64(b2), pg_temp.sign(b2), 'orders/updated', 'evt-10', shop, '2026-10-22T11:30:00Z');
  insert into t select '14 signed update: outcome / status on all rows', 'applied / partially_refunded x2',
    (r->>'outcome') || ' / ' || (select max(financial_status) || ' x' || count(*) from public.barm_shopify_orders_v2 where order_gid like '%820982911946154508');

  b2 := replace(b2, '2026-10-22T17:00:00+05:30', '2026-10-22T18:00:00+05:30');
  b2 := replace(b2, '"test": true,', '"test": true, "cancelled_at": "2026-10-22T18:00:00+05:30", "cancel_reason": "customer",');
  r := public.ingest_shopify_webhook(pg_temp.b64(b2), pg_temp.sign(b2), 'orders/cancelled', 'evt-11', shop, '2026-10-22T12:30:00Z');
  insert into t select '15 signed cancel: outcome / cancelled rows', 'applied / 2 of 2',
    (r->>'outcome') || ' / ' || (select count(*) filter (where cancelled_at is not null) || ' of ' || count(*) from public.barm_shopify_orders_v2 where order_gid like '%820982911946154508');

  b2 := '{"admin_graphql_api_id": "gid://shopify/Order/555", "name": "#NOUPDATEDAT", "line_items": []}';
  r := public.ingest_shopify_webhook(pg_temp.b64(b2), pg_temp.sign(b2), 'orders/create', 'evt-12', shop, trg);
  insert into t select '16 signed but write fails: outcome / http / sqlstate logged / rows written', 'write_failed / 500 / P0001 / 0',
    (r->>'outcome') || ' / ' || (r->>'http_status') || ' / ' ||
    (select sqlstate from public.barm_shopify_webhook_log where event_id = 'evt-12') || ' / ' ||
    (select count(*) from public.barm_shopify_orders_v2 where order_gid = 'gid://shopify/Order/555');

  insert into t select '17 test order flagged is_test', 'true', bool_and(is_test)::text from public.barm_shopify_orders_v2 where order_gid like '%820982911946154508';
end $$;

insert into t select '18 log rows / outcomes', '15 / applied:3 not_configured:0 rejected_payload:3 rejected_shop:1 rejected_signature:4 rejected_topic:2 skipped_stale_or_duplicate:1 write_failed:1',
  (select count(*) from public.barm_shopify_webhook_log) || ' / ' ||
  (select string_agg(o || ':' || coalesce(c, 0), ' ' order by o) from unnest(array['applied','not_configured','rejected_payload','rejected_shop','rejected_signature','rejected_topic','skipped_stale_or_duplicate','write_failed']) o
     left join (select outcome, count(*) c from public.barm_shopify_webhook_log group by outcome) x on x.outcome = o);
insert into t select '19 log holds no customer data or body text', '0',
  count(*)::text from public.barm_shopify_webhook_log l where row_to_json(l)::text ~* 'example\.com|Steve|Shippington|B-OT-DT12|1672';
insert into t select '20 order_gid only logged after signature verified', '0',
  count(*)::text from public.barm_shopify_webhook_log where outcome = 'rejected_signature' and order_gid is not null;
insert into t select '21 function source holds no secret', 'false',
  (prosrc ~ 'dummy-test-secret')::text from pg_proc where proname = 'ingest_shopify_webhook';

-- exactly-once and no-side-effect checks, using a fingerprint of every v2 row (all columns, incl. updated_at)
create function pg_temp.fp(p_gid text) returns text language sql as $$
  select coalesce(md5(string_agg(row_to_json(v)::text, '|' order by v.order_gid, v.line_item_gid)), 'empty')
    from public.barm_shopify_orders_v2 v where p_gid is null or v.order_gid = p_gid
$$;
do $$
declare
  shop text := 'sjtpux-5d.myshopify.com';
  real_body text := '{"admin_graphql_api_id": "gid://shopify/Order/888", "name": "#REAL1", "test": false, "updated_at": "2026-10-22T10:00:00Z", "total_price": "599.00", "line_items": [{"admin_graphql_api_id": "gid://shopify/LineItem/8881", "sku": "B-OT-DT12", "quantity": 1, "current_quantity": 1, "price": "599.00"}, {"admin_graphql_api_id": "gid://shopify/LineItem/8882", "sku": "B-SEAT-BELT-ADJUSTER", "quantity": 2, "current_quantity": 2, "price": "790.00"}]}';
  older text; newer text; before_all text; before_test text; r jsonb; n_log_before int; n_log_after int;
begin
  -- accepted create writes exactly one row per line item
  r := public.ingest_shopify_webhook(pg_temp.b64(real_body), pg_temp.sign(real_body), 'orders/create', 'evt-real-1', shop, '2026-10-22T04:30:00Z');
  insert into t select '33 real order create: outcome / rows / primary rows / is_test', 'applied / 2 / 1 / false',
    (r->>'outcome') || ' / ' || count(*) || ' / ' || count(*) filter (where is_order_primary_row) || ' / ' || bool_or(is_test)
    from public.barm_shopify_orders_v2 where order_gid = 'gid://shopify/Order/888';

  -- duplicate delivery changes nothing at all (not even updated_at)
  before_all := pg_temp.fp(null);
  r := public.ingest_shopify_webhook(pg_temp.b64(real_body), pg_temp.sign(real_body), 'orders/create', 'evt-real-1', shop, '2026-10-22T04:30:00Z');
  insert into t select '34 duplicate: outcome / table unchanged', 'skipped_stale_or_duplicate / true', (r->>'outcome') || ' / ' || (pg_temp.fp(null) = before_all);

  -- older event arriving late changes nothing
  older := replace(replace(real_body, '2026-10-22T10:00:00Z', '2026-10-22T09:00:00Z'), '"current_quantity": 2', '"current_quantity": 0');
  r := public.ingest_shopify_webhook(pg_temp.b64(older), pg_temp.sign(older), 'orders/updated', 'evt-real-old', shop, '2026-10-22T05:00:00Z');
  insert into t select '35 out-of-order older event: outcome / table unchanged', 'skipped_stale_or_duplicate / true', (r->>'outcome') || ' / ' || (pg_temp.fp(null) = before_all);

  -- every kind of rejected or failed request leaves order data untouched (log rows only)
  select count(*) into n_log_before from public.barm_shopify_webhook_log;
  perform public.ingest_shopify_webhook(pg_temp.b64(real_body), null, 'orders/updated', 'evt-x1', shop, null);                        -- missing signature
  perform public.ingest_shopify_webhook(pg_temp.b64(real_body), pg_temp.sign('other'), 'orders/updated', 'evt-x2', shop, null);      -- wrong signature
  perform public.ingest_shopify_webhook(pg_temp.b64(replace(real_body, '599.00', '1.00')), pg_temp.sign(real_body), 'orders/updated', 'evt-x3', shop, null); -- tampered
  perform public.ingest_shopify_webhook(pg_temp.b64(real_body), pg_temp.sign(real_body), 'orders/updated', 'evt-x4', 'evil.myshopify.com', null); -- wrong shop
  perform public.ingest_shopify_webhook(pg_temp.b64(real_body), pg_temp.sign(real_body), 'customers/create', 'evt-x5', shop, null);  -- unsupported topic
  perform public.ingest_shopify_webhook('not base64 !!!', 'x', 'orders/updated', 'evt-x6', shop, null);                               -- malformed transport
  perform public.ingest_shopify_webhook(pg_temp.b64('{"broken": '), pg_temp.sign('{"broken": '), 'orders/updated', 'evt-x7', shop, null); -- malformed JSON
  perform public.ingest_shopify_webhook(pg_temp.b64('{"admin_graphql_api_id": "gid://shopify/Order/888", "line_items": []}'),
                                        pg_temp.sign('{"admin_graphql_api_id": "gid://shopify/Order/888", "line_items": []}'), 'orders/updated', 'evt-x8', shop, null); -- no updated_at -> write_failed
  select count(*) into n_log_after from public.barm_shopify_webhook_log;
  insert into t select '36 8 rejected/failed requests: order data unchanged / log rows added', 'true / 8', (pg_temp.fp(null) = before_all) || ' / ' || (n_log_after - n_log_before);

  -- an accepted update touches only its own order
  before_test := pg_temp.fp('gid://shopify/Order/820982911946154508');
  newer := replace(replace(real_body, '2026-10-22T10:00:00Z', '2026-10-22T11:00:00Z'), '"current_quantity": 2', '"current_quantity": 1');
  r := public.ingest_shopify_webhook(pg_temp.b64(newer), pg_temp.sign(newer), 'orders/updated', 'evt-real-2', shop, '2026-10-22T05:30:00Z');
  insert into t select '37 update: outcome / seat-belt qty now / other order untouched', 'applied / 1 / true',
    (r->>'outcome') || ' / ' || (select current_quantity from public.barm_shopify_orders_v2 where line_item_gid = 'gid://shopify/LineItem/8882') || ' / ' ||
    (pg_temp.fp('gid://shopify/Order/820982911946154508') = before_test);

  -- cancellation of the real order: all its rows marked, still exactly 2 rows
  newer := replace(replace(newer, '2026-10-22T11:00:00Z', '2026-10-22T12:00:00Z'), '"test": false,', '"test": false, "cancelled_at": "2026-10-22T12:00:00Z", "cancel_reason": "customer",');
  r := public.ingest_shopify_webhook(pg_temp.b64(newer), pg_temp.sign(newer), 'orders/cancelled', 'evt-real-3', shop, '2026-10-22T06:30:00Z');
  insert into t select '38 cancel real order: outcome / rows / cancelled rows', 'applied / 2 / 2',
    (r->>'outcome') || ' / ' || count(*) || ' / ' || count(*) filter (where cancelled_at is not null)
    from public.barm_shopify_orders_v2 where order_gid = 'gid://shopify/Order/888';

  -- reporting view: real order present, test orders absent
  insert into t select '39 reporting view: real order rows / test order rows', '2 / 0',
    (select count(*) from public.barm_shopify_order_lines_live where order_gid = 'gid://shopify/Order/888') || ' / ' ||
    (select count(*) from public.barm_shopify_order_lines_live where is_test);
end $$;

do $$
declare res text;
begin
  begin execute 'set local role anon'; perform public.ingest_shopify_webhook('e30=', 'x', 'orders/create', 'e', 's', null); execute 'reset role'; res := 'ALLOWED';
  exception when insufficient_privilege then res := 'denied'; end;
  insert into t values ('22 anon EXECUTE ingest', 'denied', res);
  begin execute 'set local role authenticated'; perform public.ingest_shopify_webhook('e30=', 'x', 'orders/create', 'e', 's', null); execute 'reset role'; res := 'ALLOWED';
  exception when insufficient_privilege then res := 'denied'; end;
  insert into t values ('23 authenticated EXECUTE ingest', 'denied', res);
  begin execute 'set local role anon'; perform count(*) from public.barm_shopify_webhook_log; execute 'reset role'; res := 'ALLOWED';
  exception when insufficient_privilege then res := 'denied'; end;
  insert into t values ('24 anon SELECT log', 'denied', res);
  begin execute 'set local role service_role'; perform public.upsert_shopify_order('{"admin_graphql_api_id":"gid://shopify/Order/1","updated_at":"2026-10-22T10:00:00Z"}'); execute 'reset role'; res := 'ALLOWED';
  exception when insufficient_privilege then res := 'denied'; end;
  insert into t values ('25 service_role calls upsert directly (HMAC bypass)', 'denied', res);
  execute 'set local role service_role';
  res := public.ingest_shopify_webhook('e30=', 'bad', 'orders/create', 'evt-sr', 'sjtpux-5d.myshopify.com', null)->>'outcome';
  execute 'reset role';
  insert into t values ('26 service_role EXECUTE ingest (bad signature)', 'rejected_signature', res);
  begin execute 'set local role service_role'; insert into public.barm_shopify_orders_v2 (order_gid, line_item_gid, line_position, is_order_primary_row, raw_payload) values ('gid://shopify/Order/direct', 'x', 1, true, '{}'); execute 'reset role'; res := 'ALLOWED';
  exception when insufficient_privilege then res := 'denied'; end;
  insert into t values ('29 service_role direct INSERT into v2 (n8n Create-a-row bypass)', 'denied', res);
  begin execute 'set local role service_role'; update public.barm_shopify_orders_v2 set note = 'x' where false; execute 'reset role'; res := 'ALLOWED';
  exception when insufficient_privilege then res := 'denied'; end;
  insert into t values ('30 service_role direct UPDATE on v2', 'denied', res);
  begin execute 'set local role service_role'; perform count(*) from public.barm_shopify_orders_v2; execute 'reset role'; res := 'allowed';
  exception when insufficient_privilege then res := 'denied'; end;
  insert into t values ('31 service_role SELECT v2 (reporting)', 'allowed', res);
  begin execute 'set local role anon'; perform count(*) from public.barm_shopify_order_lines_live; execute 'reset role'; res := 'ALLOWED';
  exception when insufficient_privilege then res := 'denied'; end;
  insert into t values ('40 anon SELECT reporting view', 'denied', res);
end $$;

-- rotation: a second secret in 'shopify_webhook_secret_next' is accepted alongside the current one
-- (only checked when no real _next secret exists, so a real one is never touched)
create temp table t_flags_next as
  select not exists (select 1 from vault.secrets where name = 'shopify_webhook_secret_next') as created_dummy_next;
select vault.create_secret('dummy-next-secret-not-real', 'shopify_webhook_secret_next') from t_flags_next where created_dummy_next;
do $$
declare
  b text := '{"admin_graphql_api_id": "gid://shopify/Order/777", "name": "#ROTATE", "updated_at": "2026-10-22T10:00:00Z", "line_items": []}';
  sig_next text := encode(extensions.hmac(convert_to(b, 'UTF8'), convert_to('dummy-next-secret-not-real', 'UTF8'), 'sha256'), 'base64');
  sig_cur  text := encode(extensions.hmac(convert_to(b, 'UTF8'),
                     convert_to((select decrypted_secret from vault.decrypted_secrets where name = 'shopify_webhook_secret'), 'UTF8'), 'sha256'), 'base64');
  sig_bad  text := encode(extensions.hmac(convert_to(b, 'UTF8'), convert_to('some-other-secret', 'UTF8'), 'sha256'), 'base64');
  r1 jsonb; r2 jsonb; r3 jsonb;
begin
  if (select created_dummy_next from t_flags_next) then
    r1 := public.ingest_shopify_webhook(encode(convert_to(b, 'UTF8'), 'base64'), sig_next, 'orders/create', 'evt-rot-1', 'sjtpux-5d.myshopify.com', null);
    r2 := public.ingest_shopify_webhook(encode(convert_to(b, 'UTF8'), 'base64'), sig_cur, 'orders/create', 'evt-rot-2', 'sjtpux-5d.myshopify.com', null);
    r3 := public.ingest_shopify_webhook(encode(convert_to(b, 'UTF8'), 'base64'), sig_bad, 'orders/create', 'evt-rot-3', 'sjtpux-5d.myshopify.com', null);
    insert into t values ('32 rotation: next-secret sig / current-secret sig / unknown-secret sig',
      'applied / applied / rejected_signature', (r1->>'outcome') || ' / ' || (r2->>'outcome') || ' / ' || (r3->>'outcome'));
  else
    insert into t values ('32 rotation: next-secret sig / current-secret sig / unknown-secret sig', 'skipped', 'skipped');
  end if;
end $$;
delete from vault.secrets where name = 'shopify_webhook_secret_next' and (select created_dummy_next from t_flags_next);

-- without a secret the endpoint must refuse everything (only checked when the secret is the dummy one)
delete from vault.secrets where name = 'shopify_webhook_secret' and (select created_dummy from t_flags);
insert into t select '27 no secret in Vault -> not_configured', case when (select created_dummy from t_flags) then 'not_configured / 500' else 'skipped' end,
  case when (select created_dummy from t_flags)
       then (select r->>'outcome' || ' / ' || (r->>'http_status') from (select public.ingest_shopify_webhook('e30=', 'x', 'orders/create', 'e', 'sjtpux-5d.myshopify.com', null) r) z)
       else 'skipped' end;

insert into t select '28 legacy tables rows', '0 / 0', (select count(*) from public.barm_shopify_orders) || ' / ' || (select count(*) from public.barm_shopify_order_items);

create temp table t_out as select step, expected, actual, case when expected = actual then 'PASS' else 'FAIL' end as verdict from t;
select * from t_out order by step;

rollback;
