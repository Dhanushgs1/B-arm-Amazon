-- Stock on the godown workbook's "Not restocked Products" tab (user, 2026-10-17), saved with each
-- godown upload (src/lib/consolidatedStockUpload.ts). Kept apart from barm_godown_stock, which stays the
-- FC Stock sheet (the FC name check mail reads it); the Consolidated Stock Sheet adds this stock to the
-- product's current stock. Inbound = the tab's "Inbound" column.
create table if not exists public.barm_godown_not_restocked (
  snapshot_date  date        not null,
  product        text        not null,
  current_stock  numeric     not null default 0,
  inbound        numeric     not null default 0,
  unfulfillable  numeric     not null default 0,
  warehouse      numeric     not null default 0,
  qc_godown      numeric     not null default 0,
  packing_godown numeric     not null default 0,
  sku_rows       integer     not null default 0,
  uploaded_at    timestamptz not null default now(),
  primary key (snapshot_date, product)
);

grant select, insert, update on public.barm_godown_not_restocked to anon;
