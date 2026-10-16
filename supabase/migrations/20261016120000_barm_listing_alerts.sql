-- "Every Amazon listing of a product is inactive or deleted" mail log for the Listing Team
-- (user, 2026-10-16; src/lib/listingCheck.ts). Same shape as barm_fc_name_alerts, plus each flagged
-- product's SKUs and their status in details.
create table if not exists public.barm_listing_alerts (
  id            bigserial   primary key,
  checked_at    timestamptz not null default now(),
  trigger       text        not null,                -- 'restock' | 'manual'
  restock_date  date,                                -- Current stock sheet checked
  godown_date   date,                                -- unused (kept for the shared status panel)
  missing       text[]      not null default '{}',   -- flagged product names
  details       jsonb       not null default '[]',   -- [{ product, skus: [{ sku, state, status }] }]
  recipients    text        not null default '',
  status        text        not null,                -- sent | failed | nothing_missing | already_sent | paused
  error         text
);
create index if not exists barm_listing_alerts_checked_at on public.barm_listing_alerts (checked_at desc);

grant select, insert on public.barm_listing_alerts to anon;
grant usage, select on sequence public.barm_listing_alerts_id_seq to anon;
