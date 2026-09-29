-- Run once in the Supabase SQL Editor (29 Sep 2026).
-- The Meesho Upload page is gone and Meesho orders are read from
-- meesho_barm_ord (src/lib/meeshoBarmOrd.ts), so nothing in the app reads or
-- writes these two tables any more. barm_meesho_ads is NOT dropped: it is
-- still the only source of Meesho ad spend (combined upload sheet "MS BARM ads").
DROP TABLE IF EXISTS public.barm_meesho_orders;
DROP TABLE IF EXISTS public.barm_meesho_returns;
