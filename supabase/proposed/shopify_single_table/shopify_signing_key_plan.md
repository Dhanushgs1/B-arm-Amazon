# Shopify webhook signing key: exposure handling and replacement plan

Status 2026-10-22: orders-only. Nothing below has been applied. Never paste the key itself into this file, chat, n8n or SQL.

## 1. Message for Shopify Support (you send it from Shopify admin -> Help)

> Subject: Rotate the webhook signing key for admin-created webhooks
>
> Store: B-Arm (b-arm.com, admin handle b-arm-gynecology).
> The webhook signing key shown under Settings -> Notifications -> Webhooks ("Your webhooks will be signed with ...")
> was captured in a screenshot and a local log during an integration session. We want to treat it as exposed.
> 1. Can this store-level signing key be rotated or regenerated? If yes, please rotate it or tell us how.
> 2. If it cannot be rotated, please confirm that, and confirm that webhooks created by a custom app
>    (Dev Dashboard) are signed with that app's client secret instead of this store key.
> 3. If it is rotated, does the change apply immediately to all existing admin-created webhooks?
> We currently have one admin-created webhook (Order creation). Thank you.

Do not include the key in the ticket.

## 2. If Support rotates it

1. Before they rotate: put the new key in Vault as `shopify_webhook_secret_next` once you have it (04 accepts both).
2. After rotation is confirmed: replace `shopify_webhook_secret` with the new key, delete `shopify_webhook_secret_next`.
3. Verify with a Shopify test notification that the log shows `applied` / `skipped_stale_or_duplicate`, not `rejected_signature`.

## 3. If it cannot be rotated: move order webhooks to a custom app (Dev Dashboard)

Legacy custom apps can no longer be created in admin (since 2026-01-01); new single-store apps are made in the Dev Dashboard.
App webhooks are signed with the app's client secret, which can be rotated (Dev Dashboard -> app -> Settings -> Credentials -> Secret -> Rotate).

1. Dev Dashboard: create app "B-ARM Orders Webhooks", custom distribution to the B-Arm store only.
2. Scopes: `read_orders` only (`read_all_orders` only if a backfill older than 60 days is wanted).
   Orders and order webhooks are protected customer data. Level 1 covers order data without personal fields;
   Level 2 adds the individually requested fields name, email, phone, address. Shopify lists both levels as
   "always available" for custom apps (review is required for public apps), but the fields must still be selected
   in the app's protected customer data settings or they arrive empty/redacted. Confirm the exact screen in the Dev Dashboard.
3. Webhook subscriptions (app config `shopify.app.toml` or Dev Dashboard), JSON, pinned API version:
   - `orders/create`, `orders/updated`, `orders/cancelled` -> the verified n8n receiver URL (not a `/webhook-test/` URL).
4. Install the app on the B-Arm store.
5. Vault: add the app's client secret as `shopify_webhook_secret_next` (dashboard form only).
6. Test with app-triggered test events; confirm `applied` in `barm_shopify_webhook_log`, a duplicate gives
   `skipped_stale_or_duplicate`, a wrong signature gives `rejected_signature`, and customer fields are populated
   (proves the Level 2 field selection).
7. Swap: set `shopify_webhook_secret` = app client secret, delete `_next`.
8. Delete the admin-created "Order creation" webhook, which retires the exposed store key from use
   (the store key still exists in Shopify, but nothing of ours trusts it any more).

Rotation later: Dev Dashboard Rotate -> put new secret in `_next` -> Shopify keeps signing with the oldest unrevoked secret
-> revoke old secret -> move new secret into `shopify_webhook_secret`, delete `_next`.

## 4. Unchanged rules

- SQL 04, Vault secrets, n8n workflows and Shopify subscriptions each need explicit approval.
- Do not point any subscription at a `/webhook-test/` URL in production.
- Orders placed before cutover need a separate backfill decision.
