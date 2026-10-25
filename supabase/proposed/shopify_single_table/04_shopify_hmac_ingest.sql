-- PROPOSED (needs approval): verify Shopify's HMAC inside Supabase, then write the order.
-- n8n sends the untouched request body (base64 of the exact bytes) plus the Shopify headers to
-- public.ingest_shopify_webhook. The signing secret lives only in Supabase Vault under the name
-- 'shopify_webhook_secret' (plus 'shopify_webhook_secret_next' only while rotating) - added through the
-- Dashboard (Integrations -> Vault), never in this file.
--
-- Objects created:  public.barm_shopify_webhook_log (+ its sequence, pkey, index), public.ingest_shopify_webhook,
--                   view public.barm_shopify_order_lines_live (real orders only, for reporting)
-- Objects changed:  EXECUTE on public.upsert_shopify_order and INSERT/UPDATE/DELETE on barm_shopify_orders_v2 are
--                   taken away from service_role (SELECT stays), so the only way to write an order is through
--                   the signature check.
-- Not touched:      barm_shopify_orders, barm_shopify_order_items, barm_shopify_orders_v2 (data/columns)

begin;

-- One row per webhook call. Holds outcome metadata only: no body, no customer fields, no error text
-- (error messages can echo payload values), just the SQLSTATE.
create table public.barm_shopify_webhook_log (
  id            bigserial primary key,
  received_at   timestamptz not null default now(),
  outcome       text not null check (outcome in (
                  'applied', 'skipped_stale_or_duplicate',
                  'rejected_signature', 'rejected_shop', 'rejected_topic', 'rejected_payload',
                  'not_configured', 'write_failed')),
  http_status   integer not null,
  topic         text,                 -- header values; unverified when outcome is rejected_*
  event_id      text,
  shop_domain   text,
  triggered_at  timestamptz,
  order_gid     text,                 -- only filled once the signature is verified
  rows_written  integer,
  body_sha256   text,                 -- fingerprint of the raw body, lets you match a log row to a Shopify delivery
  body_bytes    integer,
  sqlstate      text
);

create index barm_shopify_webhook_log_received_idx on public.barm_shopify_webhook_log (received_at desc);

alter table public.barm_shopify_webhook_log enable row level security;
revoke all on public.barm_shopify_webhook_log from anon, authenticated;
revoke all on sequence public.barm_shopify_webhook_log_id_seq from anon, authenticated;

create or replace function public.ingest_shopify_webhook(
  p_raw_body_b64  text,     -- base64 of the exact request bytes Shopify sent
  p_hmac          text,     -- X-Shopify-Hmac-Sha256
  p_topic         text,     -- X-Shopify-Topic
  p_event_id      text,     -- X-Shopify-Event-Id
  p_shop_domain   text,     -- X-Shopify-Shop-Domain
  p_triggered_at  text      -- X-Shopify-Triggered-At
) returns jsonb
language plpgsql
security definer            -- runs as owner (postgres): needs Vault and the now service-role-less upsert function
set search_path = ''
as $$
declare
  c_topics   constant text[] := array['orders/create', 'orders/updated', 'orders/cancelled'];
  c_shop     constant text   := 'sjtpux-5d.myshopify.com';
  v_topic    text := left(p_topic, 100);
  v_event    text := left(p_event_id, 100);
  v_shop     text := left(p_shop_domain, 255);
  v_trigger  timestamptz;
  v_raw      bytea;
  v_secret   text;
  v_expected text;
  v_key      bytea := extensions.gen_random_bytes(32);
  v_found    boolean := false;
  v_valid    boolean := false;
  v_body     jsonb;
  v_rows     integer;
  v_outcome  text;
  v_http     integer;
  v_state    text;
begin
  begin
    v_trigger := nullif(p_triggered_at, '')::timestamptz;
  exception when others then
    v_trigger := null;
  end;

  <<checks>>
  begin
    begin
      v_raw := decode(p_raw_body_b64, 'base64');
    exception when others then
      v_raw := null;
    end;
    if v_raw is null or length(v_raw) = 0 then
      v_outcome := 'rejected_payload'; v_http := 400;
      exit checks;
    end if;

    -- 'shopify_webhook_secret' is the active key; 'shopify_webhook_secret_next' is only present during a
    -- rotation (e.g. a custom app's new client secret), so both are accepted until the old one is retired.
    -- Every configured secret is checked (no early exit) so timing does not reveal which one matched.
    for v_secret in
      select decrypted_secret from vault.decrypted_secrets
       where name in ('shopify_webhook_secret', 'shopify_webhook_secret_next') and coalesce(decrypted_secret, '') <> ''
    loop
      v_found := true;
      -- HMAC-SHA256 over the exact bytes, base64, as Shopify computes it
      v_expected := encode(extensions.hmac(v_raw, convert_to(v_secret, 'UTF8'), 'sha256'), 'base64');
      -- constant-time comparison: compare HMACs of both values under a random per-call key,
      -- so how long the comparison takes says nothing about the expected signature
      if p_hmac is not null
         and extensions.hmac(convert_to(p_hmac, 'UTF8'), v_key, 'sha256')
             = extensions.hmac(convert_to(v_expected, 'UTF8'), v_key, 'sha256') then
        v_valid := true;
      end if;
    end loop;
    v_secret := null;
    v_expected := null;

    if not v_found then
      v_outcome := 'not_configured'; v_http := 500;
      exit checks;
    end if;
    if not v_valid then
      v_outcome := 'rejected_signature'; v_http := 401;
      exit checks;
    end if;

    -- signature is good from here on
    if v_shop is distinct from c_shop then
      v_outcome := 'rejected_shop'; v_http := 403;
      exit checks;
    end if;
    if v_topic is null or not (v_topic = any (c_topics)) then
      v_outcome := 'rejected_topic'; v_http := 422;
      exit checks;
    end if;

    begin
      v_body := convert_from(v_raw, 'UTF8')::jsonb;  -- jsonb keeps Shopify's big ids exact
    exception when others then
      v_body := null;
    end;
    if v_body is null or jsonb_typeof(v_body) <> 'object' then
      v_outcome := 'rejected_payload'; v_http := 400;
      exit checks;
    end if;

    begin
      v_rows := public.upsert_shopify_order(v_body, v_topic, v_event, v_shop, v_trigger);
    exception when others then
      -- the write is rolled back to this point; only the log row below survives
      v_state := sqlstate;
      v_outcome := 'write_failed'; v_http := 500;
      exit checks;
    end;

    v_outcome := case when v_rows > 0 then 'applied' else 'skipped_stale_or_duplicate' end;
    v_http := 200;
  end checks;

  insert into public.barm_shopify_webhook_log
    (outcome, http_status, topic, event_id, shop_domain, triggered_at, order_gid, rows_written, body_sha256, body_bytes, sqlstate)
  values
    (v_outcome, v_http, v_topic, v_event, v_shop, v_trigger,
     case when v_body is not null then v_body->>'admin_graphql_api_id' end,
     v_rows,
     case when v_raw is not null then encode(extensions.digest(v_raw, 'sha256'), 'hex') end,
     length(v_raw),
     v_state);

  return jsonb_build_object('ok', v_http = 200, 'outcome', v_outcome, 'http_status', v_http, 'rows_written', v_rows);
end;
$$;

revoke all on function public.ingest_shopify_webhook(text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.ingest_shopify_webhook(text, text, text, text, text, text) to service_role;

-- close the bypasses: the service-role key can no longer write orders without a valid signature,
-- neither through the upsert function nor straight into the table (n8n Supabase "Create a row" nodes).
-- service_role keeps SELECT for reporting.
revoke execute on function public.upsert_shopify_order(jsonb, text, text, text, timestamptz) from service_role;
revoke insert, update, delete on public.barm_shopify_orders_v2 from service_role;

-- Reporting source: real orders only. Test orders (Shopify test notifications, bogus-gateway orders) stay in
-- barm_shopify_orders_v2 for audit but never reach reports. security_invoker: readers need their own SELECT on v2.
create view public.barm_shopify_order_lines_live with (security_invoker = true) as
  select * from public.barm_shopify_orders_v2 where not is_test;
revoke all on public.barm_shopify_order_lines_live from anon, authenticated;

commit;
