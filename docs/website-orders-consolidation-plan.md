# B-ARM website orders — consolidation plan (WooCommerce + Shopify)

Status: **proposal, nothing applied.** Prepared 2026-10-24 from live Supabase (`zslujuqitousvywjzqwc`).
No table, row or production setting was changed to produce it; the proposed view was tested inside a
transaction that ended in `ROLLBACK` (`supabase/proposed/website_orders_consolidation/01c_test_suite.sql`, 13/13 ok).

## 1. What the "B-ARM" dashboard actually shows

The B-ARM tab (`/dashboard/barm`) reads **only `barm_online_orders`** — the B-ARM website's
**WooCommerce** export (billing names, "Payment Method Title", WooCommerce order numbers 28652–29242).
It is *not* Shopify data. The website moved to Shopify around 21 Sep 2026 (last WooCommerce order
#29078 on 21 Sep; Shopify numbers 1015–1017 appear in the Google card file on 22–24 Sep; #1067 on 22 Oct).

So the tab is renamed **"B-ARM Website"** (WooCommerce history) and kept, and **Shopify** has its own tab.

## 2. Current tables

| Table | Kind | Rows | Order coverage | Read by | Role |
|---|---|---|---|---|---|
| `barm_online_orders` | WooCommerce export, 1 row per order line | 486 | full orders 15 Apr – 21 Sep 2026 (350 sale orders, ₹5,23,929, 447 units); plus **46 SKU-only rows** to 21 Oct | B-ARM Website tab, weekly report, Overall | **Historical source of truth (WooCommerce)** |
| `barm_online_orders_mis` | monthly MIS copy of the same WooCommerce orders | 320 | Jun – 21 Sep | nothing in this app | duplicate of the above — not a source |
| `barm_shopify_orders_v2` | Shopify webhooks, 1 row per line item | 17 (12 real orders + 1 test order of 5 lines) | #1067–#1078, 22–24 Oct | Shopify tab (via `barm_shopify_orders_summary`), Ad Spend Report Google row | **Source of truth (Shopify) from now on** |
| `barm_shopify_webhook_log` | webhook audit log | 22 | 23–24 Oct | Edge Function only | audit, not orders |
| `barm_shopify_orders`, `barm_shopify_order_items` | earlier two-table design | 0 | — | nothing | empty legacy (phase 2/3 rename/drop still pending, separate approval) |
| `barm_daily_google_orders` | Google card uploads (B-Arm workbook lines, Shopify "Total sales by product" exports, a few WooCommerce invoices) | 57 | 19 Sep – 23 Oct | Ad Spend Report Google row only | **not an order record** (product-day totals, no order ids) |
| `barm_offline_orders`, `barm_offline_orders_mis` | offline / Tally sales | 238 / 73 | Aug / Jun–Sep | nothing in this app | separate channel, not website |

### Schema differences (why they can't simply be merged into one table)

| | WooCommerce (`barm_online_orders`) | Shopify (`barm_shopify_orders_v2`) |
|---|---|---|
| Grain | one row per order line, all text columns | one row per line item, typed columns, unique `(order_gid, line_item_gid)` |
| Order id | `"Order Number"` text (28652…) | `order_gid` / `order_name` (#1067…) |
| Date | `"Order Date"` text `DD-MM-YYYY HH:MM:SS` (some rows column-shifted) | `order_created_at timestamptz` (dashboard uses the India-time day) |
| Status | `"Order Status"` Received / Failed / Cancel Request; shifted columns can say "cancelled" / "RETURNED" | `cancelled_at`, `financial_status`, `fulfillment_status`, `is_test` |
| Money | `"Order Total Amount"` repeated on every line (no per-line price) | per-order totals + per-line `price` / `line_total` |
| Duplicates | same line can be re-loaded (`"created at"` differs) | prevented by the unique key; webhooks update rows in place |
| Personal data | names, phone, email, address | same, plus `raw_payload` |

## 3. Can history and new orders be one reliable source?

**Yes — as one read-only view, not one merged table.** Copying WooCommerce rows into the Shopify table
(or the reverse) would mix two schemas, lose the source of each row and make a rollback a data
operation. A view reads both tables as they are and can be dropped at any time.

Proposed view `barm_website_orders_unified` (`01_unified_view.sql`): one row per order with
`source` (`woocommerce` / `shopify`), `order_key` (source-prefixed, so numbers can never collide),
`order_ref`, `order_date`, `status`, `is_cancelled`, `is_sale`, `order_total`, `item_quantity`, `line_count`.
No personal data. Not readable by the browser key (it would be read through a function, like the Shopify tab).

Rules (identical to what the dashboard already uses — tested 1:1):
- **WooCommerce:** latest load of each `(Order Number, SKU)`; one row per Order Number; `is_sale` = Received
  and not shifted to cancelled/returned; total once per order. **Matches the B-ARM Website tab exactly:
  350 sale orders, ₹5,23,929, 447 units, 15 Apr – 21 Sep.** 16 non-sale orders (failed / cancel request) are
  kept with their status.
- **Shopify:** one row per order, test orders out, cancelled kept with `is_sale = false`. **12 orders,
  sales ₹12,643, #1076 cancelled.**
- **Left out, never deleted:** the 46 SKU-only rows in `barm_online_orders` (no order no., status or amount —
  those sales are Shopify orders), 2 WooCommerce rows with no parseable date, and `barm_daily_google_orders`.
- Checked: no duplicate `order_key`; no order number present in both sources; every source table's row
  count unchanged after the test.

## 4. The real gap: Shopify #1001–#1066 (about 21 Sep – 21 Oct)

These orders exist only in Shopify. They are **not** in `barm_shopify_orders_v2`, and the 46 SKU-only rows
can't stand in for them (no order ids, amounts or status). Until they are backfilled, website sales between
21 Sep and 21 Oct read low on every tab. Backfill = the method already used for #1067–#1078: bulk-tag the
orders `v2-sync` in Shopify admin → signed `orders/updated` webhooks → upserted in place (no duplicates).

## 5. Migration plan (each step needs your approval)

| Step | What | Risk / rollback |
|---|---|---|
| 0 | **Backfill Shopify #1001–#1066** (you tag them `v2-sync` in Shopify admin; I verify counts and totals against Shopify's order list) | none to existing rows; upserts by key |
| 1 | **Create the view** `01_unified_view.sql` after re-running `01c_test_suite.sql` | read-only; `01_rollback.sql` drops it |
| 2 | Add a read function for the dashboard (same pattern as `barm_shopify_orders_summary`) and, optionally, a combined "Website" total on the Overall tab | no change to existing tabs until switched |
| 3 | **Stop pasting SKU-only rows** into `barm_online_orders` (the outside process that loads it) and stop uploading Shopify product exports on the Google card | process change only; existing rows stay |
| 4 | Later, separately: retire the empty `barm_shopify_orders`/`_items`, freeze `barm_online_orders` as read-only history | separate approval; never deletes WooCommerce rows |

Nothing in this plan deletes, overwrites or moves an existing row.
