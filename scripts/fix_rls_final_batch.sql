-- Final batch — every remaining table not yet confirmed working for the anon key.
-- Same RLS-blocking-anon issue, confirmed directly on all 13 of these.

alter table public.barm_amazon_campaign_sku_map disable row level security;
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
alter table public.email_settings disable row level security;

grant select, insert, update, delete on public.barm_amazon_campaign_sku_map to anon;
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
grant select, insert, update on public.email_settings to anon;
grant usage, select on all sequences in schema public to anon;
