// SUPERSEDED (2026-10-22): option (b) was chosen - HMAC is verified in Supabase by public.ingest_shopify_webhook
// (04_shopify_hmac_ingest.sql) and the n8n side is n8n_barm_shopify_hmac_test_workflow.json. Kept for reference only.
//
// n8n Code node ("Run Once for Each Item"), placed directly after the Shopify Webhook node and BEFORE the Supabase RPC call.
// Rejects any request whose X-Shopify-Hmac-Sha256 header does not match the raw request body.
//
// Prerequisites (self-hosted n8n on the Hostinger VPS):
//   1. Webhook node -> Options -> "Raw Body" = ON. The HMAC must be computed over the exact bytes Shopify sent;
//      re-serialising the parsed JSON never matches (n8n has already rounded the big numeric ids, e.g. ...508 -> ...500).
//   2. Webhook node -> "Respond" = "Using 'Respond to Webhook' node" (or immediately), so a rejected call still gets a reply.
//   3. Environment: NODE_FUNCTION_ALLOW_BUILTIN=crypto, and SHOPIFY_WEBHOOK_SECRET=<the signing secret from
//      Shopify admin -> Settings -> Notifications -> Webhooks ("Your webhooks will be signed with ..."),
//      or the app's client secret if the webhook was registered by an app>. Never paste the secret into the workflow.

const crypto = require('crypto');

const secret = $env.SHOPIFY_WEBHOOK_SECRET;
if (!secret) throw new Error('SHOPIFY_WEBHOOK_SECRET is not set');

const headers = $json.headers || {};
const received = headers['x-shopify-hmac-sha256'] || '';

// with Raw Body on, the untouched body arrives as binary data
const raw = await this.helpers.getBinaryDataBuffer($itemIndex, 'data');

const expected = crypto.createHmac('sha256', secret).update(raw).digest('base64');
const a = Buffer.from(expected);
const b = Buffer.from(received);
if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
  throw new Error('Shopify HMAC mismatch - request rejected');
}

// Build the RPC request body as text, splicing Shopify's raw JSON in as the p_body object, so the numbers reach
// Postgres unrounded. (Passing raw.toString() as a field value would arrive as a jsonb *string*, not an object.)
// Next node: HTTP Request, POST .../rest/v1/rpc/upsert_shopify_order, Body Content Type = Raw,
// Content-Type = application/json, Body = {{ $json.rpc_body }}, auth = service-role key credential.
const rpcBody =
  '{"p_body":' + raw.toString('utf8') +
  ',"p_topic":' + JSON.stringify(headers['x-shopify-topic'] || null) +
  ',"p_event_id":' + JSON.stringify(headers['x-shopify-event-id'] || null) +
  ',"p_shop_domain":' + JSON.stringify(headers['x-shopify-shop-domain'] || null) +
  ',"p_triggered_at":' + JSON.stringify(headers['x-shopify-triggered-at'] || null) + '}';

return { json: { rpc_body: rpcBody } };
