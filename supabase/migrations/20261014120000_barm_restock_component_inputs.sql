-- Restock inputs upload, back on the Consolidated Stock page (user, 2026-10-14): the tool's
-- "Stock Purchase Sheet.xlsx" and "Components Sheet.xlsx", given every Friday. For the picked date
-- the page uses whichever is newer — this upload or the Monday 10:00 IST snapshot
-- (20261013120000_barm_weekly_restock_snapshot.sql).
--   barm_restock_inputs             (20261012180000_consolidated_stock.sql) Stock Purchase Sheet, per product
--   barm_restock_component_inputs   Components Sheet, row for row
-- An upload replaces every row of its date.

create table if not exists public.barm_restock_component_inputs (
  snapshot_date   date        not null,           -- IST date of the upload
  row_no          integer     not null,           -- row in the file
  component       text        not null,
  product         text,                           -- "Product Entity"
  qty_per_unit    numeric,                        -- "Quantities required"
  rfq             numeric,
  required_qty    numeric,                        -- "Required Component Quantity"
  component_stock numeric,                        -- "Current Stock" (blank stays null)
  uploaded_at     timestamptz not null default now(),
  primary key (snapshot_date, row_no)
);

-- Same access as the other barm_* upload tables (written from the browser with the anon key).
grant select, insert, update, delete on public.barm_restock_component_inputs to anon;
