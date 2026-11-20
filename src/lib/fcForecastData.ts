// FC Forecast tab (2026-11-20) — data access. Every number comes from the SQL functions in
// supabase/migrations/20261120130000_fc_forecast_functions.sql (+ 20261120140000), one small RPC each.

import { supabasePublic } from "@/lib/supabasePublic";
import { normalizeSku } from "@/lib/sellerFlexShipments";
import type { FcRow, FcSourceDate, FcUnmapped } from "@/lib/fcForecastRules";

export const FC_KEYS = {
  forecast: (asOf: string) => ["fc_forecast", asOf] as const,
  unmapped: (asOf: string) => ["fc_unmapped_skus", asOf] as const,
  sources: ["fc_source_dates"] as const,
  products: ["fc_product_names"] as const,
};

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

export async function fetchFcForecast(asOf: string): Promise<FcRow[]> {
  const { data, error } = await supabasePublic.rpc("fc_forecast", { p_as_of: asOf }, { get: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: Record<string, unknown>) => ({
    ...(r as unknown as FcRow),
    block1: num(r.block1), block2: num(r.block2), block3: num(r.block3),
    peak: num(r.peak), last30: num(r.last30), max_units: num(r.max_units), min_stock: num(r.min_stock),
    ch_amazon: num(r.ch_amazon), ch_flipkart: num(r.ch_flipkart), ch_meesho: num(r.ch_meesho),
    ch_website: num(r.ch_website), ch_sellerflex: num(r.ch_sellerflex),
  }));
}

export async function fetchFcUnmapped(asOf: string): Promise<FcUnmapped[]> {
  const { data, error } = await supabasePublic.rpc("fc_unmapped_skus", { p_as_of: asOf }, { get: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: Record<string, unknown>) => ({ ...(r as unknown as FcUnmapped), units_90d: num(r.units_90d) }));
}

export async function fetchFcSourceDates(): Promise<FcSourceDate[]> {
  const { data, error } = await supabasePublic.rpc("fc_source_dates", {}, { get: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Every product name the map and the product list know, for the Unmapped panel's picker. */
export async function fetchFcProductNames(): Promise<string[]> {
  const p = await supabasePublic.from("fc_products").select("product");
  if (p.error) throw new Error(p.error.message);
  const names = (p.data ?? []).map((r) => String(r.product));
  // The API returns at most 1,000 rows per request; the map has ~1,500.
  for (let from = 0; ; from += 1000) {
    const m = await supabasePublic.from("fc_sku_product_map").select("product").order("sku").range(from, from + 999);
    if (m.error) throw new Error(m.error.message);
    names.push(...(m.data ?? []).map((r) => String(r.product)));
    if ((m.data ?? []).length < 1000) break;
  }
  return [...new Set(names.map((n) => n.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/** Maps a sold SKU to a product (new or existing name). The next forecast load picks it up. */
export async function saveSkuMapping(sku: string, product: string): Promise<void> {
  const key = normalizeSku(sku);
  const name = product.trim();
  if (!key || !name) throw new Error("Pick or type a product name first.");
  const { error } = await supabasePublic
    .from("fc_sku_product_map")
    .upsert({ sku: key, product: name, source: "dashboard", updated_at: new Date().toISOString() }, { onConflict: "sku" });
  if (error) throw new Error(`Saving the mapping failed: ${error.message}`);
}
