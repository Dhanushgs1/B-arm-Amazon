-- Clears the barm_* copies of Amazon Orders/Returns/FBA Returns now that reports read
-- from the MIS tables (amazon_orders, amazon_returns, amazon_fba_returns) instead. Not
-- dropping the tables themselves — the Upload page still writes new CSV uploads here, so
-- keeping the table structure avoids breaking those cards. Old project still has this data
-- untouched.

truncate table public.barm_amazon_am_orders;
truncate table public.barm_amazon_am_returns;
truncate table public.barm_amazon_fba_returns;
