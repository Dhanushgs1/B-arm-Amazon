-- barm_amazon_campaign_sku_map — run this ONCE in the Supabase SQL Editor for
-- the project this app uses (see .env.local's NEXT_PUBLIC_SUPABASE_URL).
--
-- This table exists but is missing two columns the app's code actually writes
-- (src/lib/amazonReportUpload.ts's setCampaignSkus/fetchCampaignSkuWeights):
-- "Couldn't load campaigns — column barm_amazon_campaign_sku_map.weight does
-- not exist" on the Upload page's Amazon Campaign -> SKU Mapping section.
-- Checked live: the table only has campaign_name/sku/created_at — "weight"
-- and "updated_at" were never added after the Supabase project migration.
-- This blocks the whole "split a Sponsored Brands/Display campaign's spend
-- across its SKUs" feature (100 spend / 5 SKUs -> 20 each), which is exactly
-- what routes the currently-unmapped SB/SD spend into the Historical
-- Analysis Report's SKU totals instead of the "unmapped" bucket.
--
-- setCampaignSkus() upserts on (campaign_name, sku) — that needs a unique
-- index on those two columns, which a plain "add column" won't create on its
-- own, so this also adds one (a unique index is all PostgREST's upsert
-- onConflict needs; it doesn't have to be a named constraint).

alter table public.barm_amazon_campaign_sku_map add column if not exists weight numeric not null default 1;
alter table public.barm_amazon_campaign_sku_map add column if not exists updated_at timestamptz not null default now();

create unique index if not exists barm_amazon_campaign_sku_map_campaign_sku_idx
  on public.barm_amazon_campaign_sku_map (campaign_name, sku);
