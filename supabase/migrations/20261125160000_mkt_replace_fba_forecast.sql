-- Product Marketing 360 — FBA forecast Drive auto-import (user, 2026-11-25): one verified forecast
-- file replaces ONE report date in a single transaction, so a failure never leaves a half-imported day,
-- and re-importing the same file never duplicates rows. Other dates (history) are never touched.
--
--   p_report_date  the forecast date from the file name (FBA Forecasting YYYY-MM-DD.xlsx)
--   p_zones        FBA analysis rows (SKU x zone), without report_date
--   p_fc           FBA_stock rows, each with its own report_date (the FC balance date inside the file)
--
-- SECURITY DEFINER so the anon key needs no DELETE grant on the tables; it can only do this replace.
-- Measured 2026-11-25 (rolled back): 4,270 zone + 1,558 FC rows in 0.35 s, inside the anon 3 s limit.

create or replace function public.mkt_replace_fba_forecast(p_report_date date, p_zones jsonb, p_fc jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  nz int;
  nf int;
  fc_dates date[];
begin
  if p_report_date is null then raise exception 'report date is required'; end if;
  if p_zones is null or jsonb_typeof(p_zones) <> 'array' or jsonb_array_length(p_zones) = 0 then
    raise exception 'no forecast rows for % — refusing to replace', p_report_date;
  end if;
  if p_fc is null or jsonb_typeof(p_fc) <> 'array' or jsonb_array_length(p_fc) = 0 then
    raise exception 'no FC stock rows for % — refusing to replace', p_report_date;
  end if;
  select array_agg(distinct (x->>'report_date')::date) into fc_dates from jsonb_array_elements(p_fc) x;
  if fc_dates is null or array_position(fc_dates, null) is not null then
    raise exception 'FC stock rows without a balance date — refusing to replace';
  end if;

  delete from mkt_fba_forecast_zone where report_date = p_report_date;
  insert into mkt_fba_forecast_zone (report_date, sku, zone, product_name, orders_30d, forecast_75d, current_stock, booked, intransit, to_send, runs_out_days, forecast_35d, shortfall_35d, alert_35d)
  select p_report_date, r.sku, r.zone, r.product_name, r.orders_30d, r.forecast_75d, r.current_stock, r.booked, r.intransit, r.to_send, r.runs_out_days, r.forecast_35d, r.shortfall_35d, r.alert_35d
  from jsonb_to_recordset(p_zones) as r(sku text, zone text, product_name text, orders_30d numeric, forecast_75d numeric, current_stock numeric, booked numeric, intransit numeric, to_send numeric, runs_out_days numeric, forecast_35d numeric, shortfall_35d numeric, alert_35d text);
  get diagnostics nz = row_count;

  delete from mkt_fba_fc_stock where report_date = any (fc_dates);
  insert into mkt_fba_fc_stock (report_date, fc, msku, disposition, asin, zone, quantity)
  select r.report_date, r.fc, r.msku, r.disposition, r.asin, r.zone, coalesce(r.quantity, 0)
  from jsonb_to_recordset(p_fc) as r(report_date date, fc text, msku text, disposition text, asin text, zone text, quantity numeric);
  get diagnostics nf = row_count;

  return jsonb_build_object('report_date', p_report_date, 'zones', nz, 'fc', nf, 'fc_dates', to_jsonb(fc_dates));
end;
$$;

revoke all on function public.mkt_replace_fba_forecast(date, jsonb, jsonb) from public;
grant execute on function public.mkt_replace_fba_forecast(date, jsonb, jsonb) to anon;
