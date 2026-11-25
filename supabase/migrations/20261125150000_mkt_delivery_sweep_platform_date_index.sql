-- mkt_delivery_dates() (Marketing 360 full sheet + Data sources) seq-scanned the ~60k-row sweep
-- (5.4 s) and hit the anon key's 3 s statement timeout: the sheet showed "canceling statement due to
-- statement timeout" and Data sources showed Delivery date "No data". With this index it is an
-- index-only scan (~70 ms). Applied to production 2026-11-25.
create index if not exists mkt_delivery_sweep_platform_date_asin
  on public.mkt_delivery_sweep (platform, scraped_date, asin_fsn);
