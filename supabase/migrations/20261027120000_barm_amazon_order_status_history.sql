-- Amazon order-status history (user, 2026-10-27).
--
-- The synced orders table (amazon_orders, filled by the external MIS feed) keeps each order line's
-- status from the day its batch was loaded, so a line loaded as "Pending" stays Pending after Amazon
-- cancels it. The Orders upload card (barm_amazon_am_orders) has the later status, but each new Orders
-- upload deletes every row outside its own date range (PRUNE_TO_UPLOAD_RANGE in amazonReportUpload.ts),
-- so that evidence disappears with the next upload of a different range.
--
-- This table keeps every status Amazon reported for an order line, one row per
-- (order, SKU, Amazon last-updated-date, status), written by each Orders card upload
-- (src/lib/amazonReportUpload.ts) and never pruned. The Historical Analysis Report takes the status with
-- the newest last-updated-date (src/lib/historicalReportRules.ts). Status only: it never adds or removes
-- an order line and never changes a quantity in a report.
--
-- Append-only: anon may read and insert, but not update or delete. Re-uploading the same file inserts
-- nothing new (insert ... on conflict do nothing on the unique key).
create table if not exists public.barm_amazon_order_status_history (
  id               bigserial   primary key,
  amazon_order_id  text        not null,
  sku              text        not null,
  order_status     text        not null,
  item_status      text,
  quantity         integer,
  purchase_date    date,
  last_updated_at  timestamptz not null,
  source           text        not null,
  source_file      text,
  uploaded_at      timestamptz not null default now(),
  constraint barm_amazon_order_status_history_line_status_key
    unique (amazon_order_id, sku, last_updated_at, order_status)
);

create index if not exists barm_amazon_order_status_history_purchase_date_idx
  on public.barm_amazon_order_status_history (purchase_date);
create index if not exists barm_amazon_order_status_history_line_idx
  on public.barm_amazon_order_status_history (amazon_order_id, sku);

grant select, insert on public.barm_amazon_order_status_history to anon;
grant usage, select on sequence public.barm_amazon_order_status_history_id_seq to anon;

-- One-time backfill from the Orders card rows already stored, so the statuses in the 23 Oct 2026 file
-- survive the next Orders upload. Rows the daily combined upload wrote into barm_amazon_am_orders before
-- 27 Oct 2026 carry that workbook's extra columns ("IST with Time", "Date ") and are left out.
insert into public.barm_amazon_order_status_history
  (amazon_order_id, sku, order_status, item_status, quantity, purchase_date, last_updated_at, source, source_file, uploaded_at)
select o.amazon_order_id, o.sku, o.order_status, o.item_status, o.quantity, o.purchase_date,
       (o.raw ->> 'last-updated-date')::timestamptz, 'Orders card upload (backfill)', null, o.created_at
from public.barm_amazon_am_orders o
where o.amazon_order_id is not null and o.sku is not null and o.order_status is not null
  and o.raw ? 'last-updated-date' and coalesce(o.raw ->> 'last-updated-date', '') <> ''
  and not (o.raw ? 'IST with Time') and not (o.raw ? 'Date ')
on conflict on constraint barm_amazon_order_status_history_line_status_key do nothing;
