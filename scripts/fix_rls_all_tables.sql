-- Fix: "No data" showing on the live dashboard even though the tables have real rows.
--
-- Root cause: the data-copy script used the service_role key, which bypasses RLS entirely
-- — so it worked even if RLS was still ON. The live app correctly uses the anon key, and
-- RLS with no matching policy silently returns ZERO rows to anon (not an error), which is
-- exactly the "No data" / empty dashboard symptom. Confirmed directly: an anon-key request
-- against barm_amazon_am_orders returned status 200 with 0 rows, while the same request
-- with service_role returned all 10,761 real rows.
--
-- This is likely because the earlier `alter table ... disable row level security` lines
-- either didn't run, or this project has RLS enabled by default for new tables (it's an
-- existing, actively-managed company database with its own access-control system —
-- allowed_users/user_access/rpc/is_app_admin — unlike a fresh empty project). Run this
-- once to bring every barm_*/email_settings table in line with what the app needs: RLS
-- off, full anon access (same pattern as the original project).

alter table public.barm_amazon_sp_advertised_product disable row level security;
alter table public.barm_amazon_sb_campaign disable row level security;
alter table public.barm_amazon_sd_campaign disable row level security;
alter table public.barm_amazon_fba_inventory disable row level security;
alter table public.barm_amazon_inventory_ledger disable row level security;
alter table public.barm_amazon_am_orders disable row level security;
alter table public.barm_amazon_am_returns disable row level security;
alter table public.barm_amazon_fba_returns disable row level security;
alter table public.barm_amazon_price_listing disable row level security;
alter table public.barm_amazon_campaign_sku_map disable row level security;
alter table public.barm_amazon_sf_return disable row level security;
alter table public.barm_flipkart_fsn_report disable row level security;
alter table public.barm_flipkart_order_report disable row level security;
alter table public.barm_flipkart_returns disable row level security;
alter table public.barm_flipkart_listings disable row level security;
alter table public.barm_flipkart_campaign_performance disable row level security;
alter table public.barm_flipkart_overall_sales disable row level security;
alter table public.barm_meesho_ads disable row level security;
alter table public.barm_meesho_orders disable row level security;
alter table public.barm_ad_spend_history disable row level security;
alter table public.barm_alert_state disable row level security;
alter table public.barm_campaign_state disable row level security;
alter table public.barm_campaign_pause_log disable row level security;
alter table public.barm_campaign_daily_snapshot disable row level security;
alter table public.barm_rating_review disable row level security;
alter table public.barm_product_master disable row level security;
alter table public.email_settings disable row level security;
alter table public.barm_daily_am_ads disable row level security;
alter table public.barm_daily_am_orders disable row level security;
alter table public.barm_daily_fk_ads disable row level security;
alter table public.barm_daily_fk_orders disable row level security;
alter table public.barm_daily_ms_barm_ads disable row level security;
alter table public.barm_daily_ms_mw_ads disable row level security;
alter table public.barm_daily_ms_barm_orders disable row level security;
alter table public.barm_daily_ms_mw_orders disable row level security;

grant select, insert, update, delete on public.barm_amazon_sp_advertised_product to anon;
grant select, insert, update, delete on public.barm_amazon_sb_campaign to anon;
grant select, insert, update, delete on public.barm_amazon_sd_campaign to anon;
grant select, insert, update, delete on public.barm_amazon_fba_inventory to anon;
grant select, insert, update, delete on public.barm_amazon_inventory_ledger to anon;
grant select, insert, update, delete on public.barm_amazon_am_orders to anon;
grant select, insert, update, delete on public.barm_amazon_am_returns to anon;
grant select, insert, update, delete on public.barm_amazon_fba_returns to anon;
grant select, insert, update, delete on public.barm_amazon_price_listing to anon;
grant select, insert, update, delete on public.barm_amazon_campaign_sku_map to anon;
grant select, insert, update, delete on public.barm_amazon_sf_return to anon;
grant select, insert, update, delete on public.barm_flipkart_fsn_report to anon;
grant select, insert, update, delete on public.barm_flipkart_order_report to anon;
grant select, insert, update, delete on public.barm_flipkart_returns to anon;
grant select, insert, update, delete on public.barm_flipkart_listings to anon;
grant select, insert, update, delete on public.barm_flipkart_campaign_performance to anon;
grant select, insert, update, delete on public.barm_flipkart_overall_sales to anon;
grant select, insert, update, delete on public.barm_meesho_ads to anon;
grant select, insert, update, delete on public.barm_meesho_orders to anon;
grant select, insert, update, delete on public.barm_ad_spend_history to anon;
grant select, insert, update, delete on public.barm_alert_state to anon;
grant select, insert, update, delete on public.barm_campaign_state to anon;
grant select, insert, update, delete on public.barm_campaign_pause_log to anon;
grant select, insert, update, delete on public.barm_campaign_daily_snapshot to anon;
grant select, insert, update, delete on public.barm_rating_review to anon;
grant select, insert, update, delete on public.barm_product_master to anon;
grant select, insert, update on public.email_settings to anon;
grant select, insert, update, delete on public.barm_daily_am_ads to anon;
grant select, insert, update, delete on public.barm_daily_am_orders to anon;
grant select, insert, update, delete on public.barm_daily_fk_ads to anon;
grant select, insert, update, delete on public.barm_daily_fk_orders to anon;
grant select, insert, update, delete on public.barm_daily_ms_barm_ads to anon;
grant select, insert, update, delete on public.barm_daily_ms_mw_ads to anon;
grant select, insert, update, delete on public.barm_daily_ms_barm_orders to anon;
grant select, insert, update, delete on public.barm_daily_ms_mw_orders to anon;
grant usage, select on all sequences in schema public to anon;
