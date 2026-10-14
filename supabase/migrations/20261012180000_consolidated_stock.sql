-- Consolidated Stock Sheet (src/lib/consolidatedStock.ts, /dashboard/inventory/consolidated).
-- Filled from the browser by the dashboard's uploads, like the other barm_* upload tables.

-- One row per master product per godown upload ("Combined godown stock sheet as on DD.MM.YYYY").
create table if not exists public.barm_godown_stock (
  snapshot_date   date        not null,
  product         text        not null,
  current_stock   numeric     not null default 0,
  inbound_shipped numeric     not null default 0,
  unfulfillable   numeric     not null default 0,
  warehouse       numeric     not null default 0,
  qc_godown       numeric     not null default 0,
  packing_godown  numeric     not null default 0,
  sku_rows        integer     not null default 0,
  discontinued    boolean     not null default false,
  uploaded_at     timestamptz not null default now(),
  primary key (snapshot_date, product)
);

-- Daily stock movement per master product (the godown sheet's "Stock as on" blocks). Each upload
-- carries the latest ~31 days; a newer upload overwrites the same dates.
create table if not exists public.barm_godown_daily (
  stock_date  date        not null,
  product     text        not null,
  opening     numeric     not null default 0,
  stock_in    numeric     not null default 0,
  stock_out   numeric     not null default 0,
  closing     numeric     not null default 0,
  uploaded_at timestamptz not null default now(),
  primary key (stock_date, product)
);

-- "Total Orders and Minimum Stock" inputs: order placed, stock in transit, purchase-sheet qty.
create table if not exists public.barm_restock_inputs (
  snapshot_date    date        not null,
  product          text        not null,
  order_placed     numeric,
  stock_intransit  numeric,
  purchase_qty     numeric,
  uploaded_at      timestamptz not null default now(),
  primary key (snapshot_date, product)
);

-- Same access as the other barm_* upload tables (written from the browser with the anon key).
grant select, insert, update, delete on public.barm_godown_stock, public.barm_godown_daily, public.barm_restock_inputs to anon;
