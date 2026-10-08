// FBA warehouse low-stock alerts — Live Inventory (SellerMate) stock per SKU, rolled up to the
// eight major FBA cities, mailed when a SKU newly drops below the threshold in a city.
//
// "Newly" is the point: on 2026-10-08 about 500 of the ~640 SKU × city combinations were already
// under 20 units, so a daily list of everything low would be the same 500 rows every morning. State
// (barm_alert_state, alert_type "fbaCityLow") remembers which SKU × city pairs were last seen low;
// one is mailed again only after it has been seen back at or above the threshold.
//
// Stock source is SellerMate's warehouse-wise ledger balance (src/lib/sellerMateLiveInventory.ts),
// the same figure the Live Inventory page shows. It is a daily ledger snapshot, so this is a daily
// check, not an intra-day one.

import type { LiveProduct } from "./sellerMateLiveInventory.ts";

// City → FC code prefixes. Delhi includes DEL4/DEL5 (Haryana FCs serving Delhi NCR), matching the
// seller's own Inventory-ledger area formula (FC_AREA_MAP_MANUAL in analysisReportExport.ts).
// Mumbai is BOM only — Pune (PNQ), Nagpur (NAX) and Nashik (ISK) are separate FCs, not Mumbai.
export const FBA_ALERT_CITIES: { city: string; prefixes: string[] }[] = [
  { city: "Bangalore", prefixes: ["BLR"] },
  { city: "Mumbai", prefixes: ["BOM"] },
  { city: "Chennai", prefixes: ["MAA"] },
  { city: "Hyderabad", prefixes: ["HYD"] },
  { city: "Delhi", prefixes: ["DEL", "DED"] },
  { city: "West Bengal", prefixes: ["CCX", "CCU"] },
  { city: "Lucknow", prefixes: ["LKO"] },
  { city: "Coimbatore", prefixes: ["CJB"] },
];

export function fcCity(code: string): string | null {
  const up = (code || "").toUpperCase();
  return FBA_ALERT_CITIES.find((c) => c.prefixes.some((p) => up.startsWith(p)))?.city ?? null;
}

export interface CityStock {
  key: string; // `${city}|${sku}` — the dedupe key
  city: string;
  sku: string;
  asin: string;
  title: string | null;
  units: number;
  fcs: { location: string; units: number }[];
}

/** SKU stock per city, summed over that city's FCs. A SKU with no ledger row in a city is absent
 *  (never stocked there) rather than 0; a city whose FC rows all have null units is skipped. */
export function cityStock(products: LiveProduct[]): CityStock[] {
  const out = new Map<string, CityStock>();
  const known = new Set<string>();
  for (const p of products) for (const s of p.skus) for (const w of s.warehouses) {
    const city = fcCity(w.location);
    if (!city) continue;
    const key = `${city}|${s.sku}`;
    let e = out.get(key);
    if (!e) { e = { key, city, sku: s.sku, asin: p.asin, title: p.title, units: 0, fcs: [] }; out.set(key, e); }
    if (w.units !== null) { e.units += w.units; known.add(key); }
    e.fcs.push({ location: w.location, units: w.units ?? 0 });
  }
  return [...out.values()].filter((e) => known.has(e.key));
}

/** prior: key → true if it was low (and mailed) last time, false if last seen recovered. */
export function findNewDrops(current: CityStock[], prior: Map<string, boolean>, threshold: number) {
  const drops: CityStock[] = [];
  const recovered: CityStock[] = [];
  let stillLow = 0;
  for (const c of current) {
    const wasLow = prior.get(c.key) === true;
    if (c.units < threshold) {
      if (wasLow) stillLow++;
      else drops.push(c);
    } else if (wasLow) recovered.push(c);
  }
  // Pairs in `prior` but missing from `current` keep their state: no ledger row is "unknown",
  // not "recovered", and must not re-arm the alert.
  drops.sort((a, b) => a.city.localeCompare(b.city) || a.units - b.units || a.sku.localeCompare(b.sku));
  return { drops, recovered, stillLow };
}
