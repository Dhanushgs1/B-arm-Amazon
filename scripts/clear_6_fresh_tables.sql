-- Clears the copied historical data from the 6 tables that should stay empty/fresh,
-- ready for a new upload — as opposed to am_orders/am_returns/fba_returns/sf_return/
-- order_report/returns, which intentionally keep their copied data and are NOT touched here.
-- The old project still has this data untouched, so nothing is permanently lost overall.

truncate table public.barm_amazon_fba_inventory;
truncate table public.barm_amazon_inventory_ledger;
truncate table public.barm_amazon_sb_campaign;
truncate table public.barm_amazon_sd_campaign;
truncate table public.barm_product_master;
truncate table public.barm_flipkart_fsn_report;
