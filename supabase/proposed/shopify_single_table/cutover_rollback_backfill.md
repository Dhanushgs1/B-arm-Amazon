# B-ARM Shopify orders: cutover checklist, rollback plan, backfill plan

Orders only. Every step marked GATE needs explicit approval for that step. Never paste a key or secret into chat,
n8n workflow JSON, SQL files or this document.

## Current state (verified 2026-10-22)

- Shopify (store b-arm-gynecology): one admin-created webhook, Order creation -> n8n `/webhook-test/BarmShopify`.
  Test-only URL + inactive workflow = every live order delivery fails. No updated/cancelled subscriptions.
- n8n: "B-ARM Shopify Orders" (Dhanush, `iZV5CBD9q7gEm4V0`) inactive, writes straight to v2, no HMAC. Leave unchanged.
- Supabase: `barm_shopify_orders_v2` + `upsert_shopify_order` (01b) live, 0 rows. SQL 04 NOT applied.
- Signing key: treated as exposed. Support request pending (`shopify_signing_key_plan.md`).

## Cutover checklist

| # | Step | Who | Verify before moving on |
|---|------|-----|-------------------------|
| 1 | GATE: apply `04_shopify_hmac_ingest.sql` (one transaction) | Claude | snapshot before; objects + grants after; 04c rollback-only 40/40 |
| 2 | Tell Dhanush his v2 workflow will be denied after step 1 | you | acknowledged |
| 3 | GATE: Vault `shopify_webhook_secret` = signing key in use (admin key, or custom-app client secret if migrated) via Dashboard form | you | Claude checks name exists, non-empty, never the value |
| 4 | GATE: dedicated Supabase secret key `n8n-shopify` + n8n "Supabase API" credential | you | credential test passes |
| 5 | GATE: import `n8n_barm_shopify_hmac_test_workflow.json` as a NEW workflow, keep inactive, bind credential | Claude | Raw Body on, responseMode = Respond node, saving of execution data off |
| 6 | GATE: one Shopify test subscription to the new workflow's test URL ("Listen for test event"), send test notifications for create / updated / cancelled | you + Claude | log: `applied`; duplicate: `skipped_stale_or_duplicate`; v2 rows correct; `is_test` = true |
| 7 | Negative test: POST without / with wrong signature to the test URL | Claude | log `rejected_signature`, HTTP 401, v2 unchanged |
| 8 | GATE: activate the new workflow (production URL `/webhook/barm-shopify-orders-v2`) | Claude | n8n shows active; no requests yet |
| 9 | GATE: in Shopify, point Order creation to the production URL and add Order update + Order cancellation (JSON, same API version) | you | next real order -> log `applied`, `is_test` = false, appears in `barm_shopify_order_lines_live` |
| 10 | Watch 24 h: compare Shopify order count vs distinct `order_gid` in the live view; no `rejected_*` / `write_failed` from Shopify | Claude | counts match |
| 11 | GATE: retire Dhanush's workflow; later phase 2 / 3 as already planned | you | - |

Downtime: none. Nothing captures orders today, so no working flow is interrupted.

## Rollback plan (any step can be undone independently)

| Undo | How | Effect |
|------|-----|--------|
| Shopify change (step 9) | Point Order creation back / delete the update+cancel subscriptions | Same as today (deliveries fail); no data loss in v2 |
| n8n activation (step 8) | Deactivate the new workflow | Shopify gets 404, retries, nothing written |
| Vault secret (step 3) | Delete it in Dashboard | ingest answers `not_configured` (500), nothing written |
| SQL 04 (step 1) | `04_rollback.sql` (one transaction) | drops view, ingest function, log table; restores service_role grants to post-01b state; order rows untouched |
| Bad data written | Rows are rebuilt per order on every newer webhook; a specific order can be re-sent from Shopify or backfilled | - |

## Backfill plan (separate task, after the receiver is live)

1. Window: from the first order you want captured (e.g. go-live date of the old webhook, ~2026-10-22 10:33 UTC, or earlier
   if you want history) up to the first `applied` real order in `barm_shopify_webhook_log`.
2. Access: needs an app token with `read_orders` (custom app; admin-created webhooks give no API token). Orders older than
   60 days also need `read_all_orders`. Name/email/phone/address need protected customer data Level 2 fields.
3. Payload shape: `upsert_shopify_order` expects the webhook (REST) order JSON. Either fetch each order from the REST
   Admin API (same shape; REST is legacy - confirm it is still available to the custom app at that time) or map
   GraphQL results to that shape and test the mapping first.
4. Write path: a separate admin-only function (proposal, not written yet) that calls `upsert_shopify_order` with
   topic `backfill`, executable by `postgres` only - never exposed to n8n or the service role.
5. Safety: the upsert's `updated_at` guard means a backfilled copy can never overwrite newer webhook data; running the
   backfill twice is harmless (same `updated_at` + same event id is skipped).
6. Check: Shopify order count for the window = distinct `order_gid` in `barm_shopify_order_lines_live` for that window.
