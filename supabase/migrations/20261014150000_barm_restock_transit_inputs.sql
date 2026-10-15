-- The client's "Current stock sheet-DD-MM-YYYY.xlsx" restock upload (user, 2026-10-14): in transit and
-- order placed per product for the Consolidated Stock Sheet. snapshot_date = the date in the file name
-- (else the IST upload date). Current stock itself still comes from the godown sheet; this file's own
-- stock total is kept for audit only. An upload replaces every row of its date.
create table if not exists public.barm_restock_transit_inputs (
  snapshot_date   date        not null,
  product         text        not null,
  stock_intransit numeric,
  order_placed    numeric,
  current_stock   numeric,                        -- the file's 5 stock columns summed (audit only)
  uploaded_at     timestamptz not null default now(),
  primary key (snapshot_date, product)
);

-- Same access as the other barm_* upload tables (written from the browser with the anon key).
grant select, insert, update, delete on public.barm_restock_transit_inputs to anon;
