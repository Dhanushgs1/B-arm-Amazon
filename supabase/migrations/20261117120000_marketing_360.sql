-- Product Marketing 360 (user, 2026-11-17): the marketing team's per-product template
-- ("Postpartum Recovery Kit 10 pcs - Marketing Team Template.xlsx") on the dashboard.
--
-- Imported from the team's Drive files with the page's "Import Drive files" panel
-- (src/lib/marketing360Import.ts parses them):
--   mkt_delivery_sweep        BARM_W41_W44_Sweep_NoRating_NoReviewCount, one tab per week
--   mkt_rating_weekly         AM FK Rating and Review - <date>_Ratings & Reviews (final).xlsx
--   mkt_keyword_positions     BARM_Gyno_Competitor_Position_Tracker, "BARM Position Tracking"
--   mkt_competitor_positions  same workbook, "Competitor Position Tracking"
--   mkt_fba_forecast_zone     FBA Forecasting <date>.xlsx, "FBA analysis" (SKU x zone)
--   mkt_fba_fc_stock          same workbook, "FBA_stock" (per FC ending balance)
-- Typed in on the page (no system holds these):
--   mkt_product_profile, mkt_influencer_posts, mkt_action_plan, mkt_channel_notes, mkt_pincode_state

create table if not exists public.mkt_delivery_sweep (
  week          text        not null,
  platform      text        not null,
  asin_fsn      text        not null,
  pincode       text        not null,
  tier          text,
  product_name  text,
  sku           text,
  location      text,
  delivery_text text,
  days          numeric,
  scraped_date  date,
  status        text,
  note          text,
  uploaded_at   timestamptz not null default now(),
  primary key (week, platform, asin_fsn, pincode)
);
create index if not exists mkt_delivery_sweep_asin on public.mkt_delivery_sweep (asin_fsn);

create table if not exists public.mkt_rating_weekly (
  snapshot_date date        not null,
  sku_id        text        not null,
  asin_fsn      text        not null,
  product       text,
  link          text,
  last_star     numeric,
  last_count    integer,
  this_star     numeric,
  this_count    integer,
  stock_status  text,
  uploaded_at   timestamptz not null default now(),
  primary key (snapshot_date, sku_id, asin_fsn)
);
create index if not exists mkt_rating_weekly_asin on public.mkt_rating_weekly (asin_fsn);

create table if not exists public.mkt_keyword_positions (
  week             text        not null,
  search_term      text        not null,
  asin             text        not null,
  product_group    text,
  brand            text,
  sp_position      integer,
  sb_position      integer,
  organic_position integer,
  status           text,
  uploaded_at      timestamptz not null default now(),
  primary key (week, search_term, asin)
);
create index if not exists mkt_keyword_positions_asin on public.mkt_keyword_positions (asin);

create table if not exists public.mkt_competitor_positions (
  week             text        not null,
  search_term      text        not null,
  asin             text        not null,
  competitor_brand text,
  product_name     text,
  product_url      text,
  sp_position      integer,
  sb_position      integer,
  organic_position integer,
  status           text,
  uploaded_at      timestamptz not null default now(),
  primary key (week, search_term, asin)
);
create index if not exists mkt_competitor_positions_term on public.mkt_competitor_positions (search_term);

create table if not exists public.mkt_fba_forecast_zone (
  report_date    date        not null,
  sku            text        not null,
  zone           text        not null,
  product_name   text,
  orders_30d     numeric,
  forecast_75d   numeric,
  current_stock  numeric,
  booked         numeric,
  intransit      numeric,
  to_send        numeric,
  runs_out_days  numeric,
  forecast_35d   numeric,
  shortfall_35d  numeric,
  alert_35d      text,
  uploaded_at    timestamptz not null default now(),
  primary key (report_date, sku, zone)
);
create index if not exists mkt_fba_forecast_zone_sku on public.mkt_fba_forecast_zone (sku);

create table if not exists public.mkt_fba_fc_stock (
  report_date  date        not null,
  fc           text        not null,
  msku         text        not null,
  disposition  text        not null,
  asin         text,
  zone         text,
  quantity     numeric     not null default 0,
  uploaded_at  timestamptz not null default now(),
  primary key (report_date, fc, msku, disposition)
);
create index if not exists mkt_fba_fc_stock_asin on public.mkt_fba_fc_stock (asin);

create table if not exists public.mkt_pincode_state (
  pincode text primary key,
  state   text not null,
  city    text
);

create table if not exists public.mkt_product_profile (
  asin               text primary key,
  tam_value          numeric,
  primary_audience   text,
  secondary_audience text,
  retarget           jsonb not null default '{}'::jsonb,   -- { "Whatsapp": true, ... }
  content            jsonb not null default '{}'::jsonb,   -- how-to-use video, QR pamphlet, SEO description, hashtags
  ad_keywords        text,                                 -- words that find this product's Google / Meta campaigns
  notes              text,
  updated_at         timestamptz not null default now()
);

create table if not exists public.mkt_influencer_posts (
  id              bigint generated always as identity primary key,
  asin            text not null,
  kind            text not null default 'organic',  -- organic | ads
  language        text,
  influencer_name text,
  post_link       text,
  digital_rights  text,
  states          text,
  created_at      timestamptz not null default now()
);
create index if not exists mkt_influencer_posts_asin on public.mkt_influencer_posts (asin);

create table if not exists public.mkt_action_plan (
  id         bigint generated always as identity primary key,
  asin       text not null,
  plan_date  text,
  task       text not null,
  status     text not null default 'Open',
  created_at timestamptz not null default now()
);
create index if not exists mkt_action_plan_asin on public.mkt_action_plan (asin);

create table if not exists public.mkt_channel_notes (
  product    text not null,
  channel    text not null,
  note       text not null,
  updated_at timestamptz not null default now(),
  primary key (product, channel)
);

grant select, insert, update on
  public.mkt_delivery_sweep, public.mkt_rating_weekly, public.mkt_keyword_positions,
  public.mkt_competitor_positions, public.mkt_fba_forecast_zone, public.mkt_fba_fc_stock,
  public.mkt_pincode_state, public.mkt_product_profile, public.mkt_influencer_posts,
  public.mkt_action_plan, public.mkt_channel_notes
to anon;
grant delete on public.mkt_influencer_posts, public.mkt_action_plan, public.mkt_channel_notes to anon;

-- Full-sheet view: per ASIN, the latest Amazon check per pincode summarised.
create or replace view public.mkt_delivery_summary_v as
with latest as (
  select distinct on (asin_fsn, pincode) asin_fsn, pincode, days, status, scraped_date
  from public.mkt_delivery_sweep
  where platform = 'Amazon'
  order by asin_fsn, pincode, scraped_date desc nulls last, week desc
), tagged as (
  select *, (days is null or status ~* '(unavailable|not deliverable|no listing|unable)') as no_delivery from latest
)
select asin_fsn as asin,
       count(*)::int as pincodes,
       count(*) filter (where not no_delivery and days <= 2)::int as fast,
       count(*) filter (where not no_delivery and days > 5)::int as slow,
       count(*) filter (where no_delivery)::int as unavailable,
       round(avg(days) filter (where not no_delivery), 1) as avg_days,
       max(scraped_date) as last_checked
from tagged
group by asin_fsn;
grant select on public.mkt_delivery_summary_v to anon;

-- Full-sheet delivery date picker (user, 2026-11-18): the dates that have checks, and a per-date summary.
create index if not exists mkt_delivery_sweep_date on public.mkt_delivery_sweep (scraped_date);

create or replace function public.mkt_delivery_dates()
returns table (scraped_date date, checks int, products int)
language sql stable as $$
  select s.scraped_date, count(*)::int, count(distinct s.asin_fsn)::int
  from public.mkt_delivery_sweep s
  where s.platform = 'Amazon' and s.scraped_date is not null
  group by s.scraped_date
  order by s.scraped_date desc
$$;

create or replace function public.mkt_delivery_summary_on(d date)
returns table (asin text, pincodes int, fast int, slow int, unavailable int, avg_days numeric, last_checked date)
language sql stable as $$
  with latest as (
    select distinct on (s.asin_fsn, s.pincode) s.asin_fsn, s.pincode, s.days, s.status, s.scraped_date
    from public.mkt_delivery_sweep s
    where s.platform = 'Amazon' and s.scraped_date = d
    order by s.asin_fsn, s.pincode, s.week desc
  ), tagged as (
    select *, (days is null or status ~* '(unavailable|not deliverable|no listing|unable)') as no_delivery from latest
  )
  select asin_fsn, count(*)::int,
         count(*) filter (where not no_delivery and days <= 2)::int,
         count(*) filter (where not no_delivery and days > 5)::int,
         count(*) filter (where no_delivery)::int,
         round(avg(days) filter (where not no_delivery), 1),
         max(scraped_date)
  from tagged group by asin_fsn
$$;

grant execute on function public.mkt_delivery_dates() to anon;
grant execute on function public.mkt_delivery_summary_on(date) to anon;
