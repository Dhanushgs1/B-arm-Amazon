-- Migration target: live-alert dedupe state, campaign pause/automation tracking, and the
-- 8 barm_daily_* per-sheet mirror tables — run this ONCE in the SQL Editor of the NEW
-- Supabase project.
--
-- Schema for the first 4 tables reverse-engineered from the actual read/write code (not
-- guessed): src/pages/api/live-alerts.ts for barm_alert_state, src/lib/campaignStateTracker.ts
-- for the 3 campaign tables. The 8 barm_daily_* tables are reproduced verbatim from the
-- existing scripts/barm_daily_sheet_tables.sql so this one file covers everything together.

-- ── 1. Live-alert dedupe state ───────────────────────────────────────────────
-- One row per (key_slot, alert_type, entity_id) — upserted only for alerts that actually
-- got emailed (see live-alerts.ts's `delivered` check), so a failed send is retried next
-- run instead of being silently marked as sent. `severity` drives the "did it get worse"
-- re-alert check; `details` carries the alert's title/impact for reference.
create table if not exists public.barm_alert_state (
  id bigint generated always as identity primary key,
  key_slot text not null,
  alert_type text not null,
  entity_id text not null,
  severity integer,
  details jsonb,
  last_sent_at timestamptz not null default now(),
  unique (key_slot, alert_type, entity_id)
);

-- ── 2. Campaign state (latest known state per campaign) ─────────────────────
-- Overwritten every run — each run diffs the fresh list_campaigns pull against "what we
-- saw last time" to detect ENABLED -> not-ENABLED transitions.
create table if not exists public.barm_campaign_state (
  id bigint generated always as identity primary key,
  key_slot text not null,
  campaign_id text not null,
  campaign_name text,
  state text,
  checked_at timestamptz not null default now(),
  unique (key_slot, campaign_id)
);

-- ── 3. Campaign pause log (append-only history of ENABLED -> other transitions) ──
create table if not exists public.barm_campaign_pause_log (
  id bigint generated always as identity primary key,
  key_slot text not null,
  campaign_id text not null,
  campaign_name text,
  previous_state text,
  new_state text,
  detected_at timestamptz not null default now()
);

-- ── 4. Campaign daily snapshot (immutable, one row per campaign per calendar day) ──
-- Never overwritten (unlike barm_campaign_state) — campaignPersistence.ts reads this to
-- find campaigns missing from the latest live pull and re-inject them as Paused instead of
-- letting them silently vanish from Active/Paused counts.
create table if not exists public.barm_campaign_daily_snapshot (
  id bigint generated always as identity primary key,
  key_slot text not null,
  campaign_id text not null,
  campaign_name text,
  snapshot_date date not null,
  raw_state text,
  status text,
  unique (key_slot, campaign_id, snapshot_date)
);

-- ── 5-12. barm_daily_* per-sheet mirror tables (verbatim from barm_daily_sheet_tables.sql) ──
-- One dedicated table per sheet of the combined "Last 7 days" workbook upload — Amazon/
-- Flipkart/Meesho never share a table, and for Meesho the BARM and MW stores never share a
-- table either. Every row's full original data is kept in `raw` jsonb.
create table if not exists public.barm_daily_am_ads (
  id bigint generated always as identity primary key,
  report_date date,
  end_date date,
  portfolio_name text,
  campaign_name text,
  ad_group_name text,
  sku text,
  asin text,
  impressions integer,
  clicks integer,
  spend numeric,
  sales_7d numeric,
  acos numeric,
  orders_7d integer,
  units_7d integer,
  raw jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.barm_daily_am_orders (
  id bigint generated always as identity primary key,
  order_id text,
  report_date date,
  purchase_datetime text,
  order_status text,
  sku text,
  asin text,
  product_name text,
  quantity integer,
  item_price numeric,
  ship_city text,
  ship_state text,
  raw jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.barm_daily_fk_ads (
  id bigint generated always as identity primary key,
  report_date date,
  campaign_id text,
  campaign_name text,
  ad_group_name text,
  sku text,
  product_name text,
  views integer,
  clicks integer,
  units_sold integer,
  revenue numeric,
  ad_spend numeric,
  roi numeric,
  raw jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.barm_daily_fk_orders (
  id bigint generated always as identity primary key,
  order_item_id text,
  order_id text,
  report_date date,
  order_datetime text,
  order_status text,
  sku text,
  fsn text,
  product_name text,
  quantity integer,
  tracking_id text,
  raw jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.barm_daily_ms_barm_ads (
  id bigint generated always as identity primary key,
  report_date date,
  campaign_name text,
  product_name text,
  sku text,
  spend numeric,
  views integer,
  clicks integer,
  orders_by_ad integer,
  raw jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.barm_daily_ms_mw_ads (
  id bigint generated always as identity primary key,
  report_date date,
  campaign_name text,
  product_name text,
  sku text,
  spend numeric,
  views integer,
  clicks integer,
  orders_by_ad integer,
  raw jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.barm_daily_ms_barm_orders (
  id bigint generated always as identity primary key,
  order_status text,
  sub_order_no text,
  catalog_id text,
  report_date date,
  order_source text,
  customer_state text,
  product_name text,
  sku text,
  size text,
  quantity integer,
  listed_price numeric,
  discounted_price numeric,
  packet_id text,
  raw jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.barm_daily_ms_mw_orders (
  id bigint generated always as identity primary key,
  order_status text,
  sub_order_no text,
  catalog_id text,
  report_date date,
  order_source text,
  customer_state text,
  product_name text,
  sku text,
  size text,
  quantity integer,
  listed_price numeric,
  discounted_price numeric,
  packet_id text,
  raw jsonb,
  created_at timestamptz not null default now()
);

-- ── Indexes ──────────────────────────────────────────────────────────────────
create index if not exists barm_alert_state_slot_idx on public.barm_alert_state (key_slot);
create index if not exists barm_campaign_state_slot_idx on public.barm_campaign_state (key_slot);
create index if not exists barm_campaign_pause_log_slot_idx on public.barm_campaign_pause_log (key_slot);
create index if not exists barm_campaign_pause_log_detected_idx on public.barm_campaign_pause_log (detected_at);
create index if not exists barm_campaign_daily_snapshot_date_idx on public.barm_campaign_daily_snapshot (snapshot_date);
create index if not exists barm_campaign_daily_snapshot_slot_idx on public.barm_campaign_daily_snapshot (key_slot);

create index if not exists barm_daily_am_ads_date_idx on public.barm_daily_am_ads (report_date);
create index if not exists barm_daily_am_ads_sku_idx on public.barm_daily_am_ads (sku);
create index if not exists barm_daily_am_orders_date_idx on public.barm_daily_am_orders (report_date);
create index if not exists barm_daily_am_orders_order_id_idx on public.barm_daily_am_orders (order_id);
create index if not exists barm_daily_fk_ads_date_idx on public.barm_daily_fk_ads (report_date);
create index if not exists barm_daily_fk_ads_sku_idx on public.barm_daily_fk_ads (sku);
create index if not exists barm_daily_fk_orders_date_idx on public.barm_daily_fk_orders (report_date);
create index if not exists barm_daily_fk_orders_order_item_idx on public.barm_daily_fk_orders (order_item_id);
create index if not exists barm_daily_ms_barm_ads_date_idx on public.barm_daily_ms_barm_ads (report_date);
create index if not exists barm_daily_ms_mw_ads_date_idx on public.barm_daily_ms_mw_ads (report_date);
create index if not exists barm_daily_ms_barm_orders_date_idx on public.barm_daily_ms_barm_orders (report_date);
create index if not exists barm_daily_ms_barm_orders_sub_order_idx on public.barm_daily_ms_barm_orders (sub_order_no);
create index if not exists barm_daily_ms_mw_orders_date_idx on public.barm_daily_ms_mw_orders (report_date);
create index if not exists barm_daily_ms_mw_orders_sub_order_idx on public.barm_daily_ms_mw_orders (sub_order_no);

-- ── RLS + grants (same anon-key access pattern as every other barm_* table) ────
alter table public.barm_alert_state disable row level security;
alter table public.barm_campaign_state disable row level security;
alter table public.barm_campaign_pause_log disable row level security;
alter table public.barm_campaign_daily_snapshot disable row level security;
alter table public.barm_daily_am_ads disable row level security;
alter table public.barm_daily_am_orders disable row level security;
alter table public.barm_daily_fk_ads disable row level security;
alter table public.barm_daily_fk_orders disable row level security;
alter table public.barm_daily_ms_barm_ads disable row level security;
alter table public.barm_daily_ms_mw_ads disable row level security;
alter table public.barm_daily_ms_barm_orders disable row level security;
alter table public.barm_daily_ms_mw_orders disable row level security;

grant select, insert, update, delete on public.barm_alert_state to anon;
grant select, insert, update, delete on public.barm_campaign_state to anon;
grant select, insert, update, delete on public.barm_campaign_pause_log to anon;
grant select, insert, update, delete on public.barm_campaign_daily_snapshot to anon;
grant select, insert, update, delete on public.barm_daily_am_ads to anon;
grant select, insert, update, delete on public.barm_daily_am_orders to anon;
grant select, insert, update, delete on public.barm_daily_fk_ads to anon;
grant select, insert, update, delete on public.barm_daily_fk_orders to anon;
grant select, insert, update, delete on public.barm_daily_ms_barm_ads to anon;
grant select, insert, update, delete on public.barm_daily_ms_mw_ads to anon;
grant select, insert, update, delete on public.barm_daily_ms_barm_orders to anon;
grant select, insert, update, delete on public.barm_daily_ms_mw_orders to anon;
grant usage, select on all sequences in schema public to anon;
