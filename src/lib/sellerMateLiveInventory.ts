// Live Inventory — SellerMate only. Never mixed with the uploaded Amazon FBA Inventory report
// (that is the separate Inventory page, src/lib/inventoryStock.ts).
//
// What SellerMate actually returns (inspected 2026-10-06, every view, every page):
//   get_inventory view=merged          asin, itemName, price, mainImageUrl, fbm.quantity (per ASIN),
//                                      fba.endingWarehouseBalance (per ASIN); sku is always ""
//   get_inventory view=fba_by_location asin, sku, fba.endingWarehouseBalance, fba.asOfDate,
//                                      fba.byLocation[] { location, endingWarehouseBalance, fnsku, sku, asOfDate }
//   list_product_catalog               asin, sku, itemName, price, mainImageUrl, fulfillmentChannel
//                                      (AMAZON_IN = FBA, DEFAULT = MFN), quantity (listing qty; often null),
//                                      status (always [] so far), marketplaceId (always "" so far)
// NOT provided by SellerMate: available/fulfillable, reserved, inbound / working / in-transit,
// unfulfillable. Those are null here and shown as "—" — never 0.
//
// Two SellerMate quirks this module works around:
//  • offset pagination of get_inventory is unstable — pages repeat rows and skip others (three pulls
//    on 2026-10-06 returned 271, 352 and 200 distinct ASINs out of 352). The fetcher therefore asks
//    by explicit ASIN batches (see fetchLiveInventory) and this module de-duplicates anyway.
//  • view=fbm reports 0 per SKU where both the merged view and the catalog listing quantity show
//    stock, so it is not used; FBM is merged's per-ASIN fbm.quantity, as SellerMate documents it.

export interface SmMergedItem {
  asin: string;
  sku?: string;
  itemName?: string | null;
  price?: number | null;
  mainImageUrl?: string | null;
  fbm?: { quantity?: number | null } | null;
  fba?: { endingWarehouseBalance?: number | null } | null;
}

export interface SmLocation { location: string; endingWarehouseBalance: number | null; fnsku?: string | null; sku?: string | null; asOfDate?: string | null }

export interface SmByLocationItem {
  asin: string;
  sku?: string | null;
  itemName?: string | null;
  price?: number | null;
  mainImageUrl?: string | null;
  fba?: { endingWarehouseBalance?: number | null; asOfDate?: string | null; byLocation?: SmLocation[] | null } | null;
}

export interface SmCatalogItem {
  asin: string;
  sku: string;
  itemName?: string | null;
  price?: number | null;
  mainImageUrl?: string | null;
  fulfillmentChannel?: string | null;
  quantity?: number | null;
  status?: unknown;
  marketplaceId?: string | null;
}

export interface LiveWarehouse { location: string; units: number | null; fnsku: string | null; asOfDate: string | null }

export interface LiveSku {
  sku: string;
  channel: "FBA" | "MFN" | null; // from catalog fulfillmentChannel; null = not in catalog
  listingQuantity: number | null; // catalog quantity (null = SellerMate gave none)
  fnsku: string | null;
  fbaWarehouseBalance: number | null; // sum over this SKU's warehouses; null = no FBA ledger rows
  ledgerDate: string | null;
  warehouses: LiveWarehouse[];
  catalogStatus: string | null; // catalog status joined; null when SellerMate sends none
  inCatalog: boolean; // catalogued under THIS ASIN
  catalogAsin: string | null; // set when the SKU is catalogued under a different ASIN

}

export interface LiveProduct {
  asin: string;
  title: string | null;
  imageUrl: string | null;
  price: number | null;
  fbmQuantity: number | null; // merged fbm.quantity (per ASIN)
  fbaWarehouseBalance: number | null; // merged fba.endingWarehouseBalance (per ASIN)
  warehouseTotal: number | null; // sum of all warehouse entries — must equal fbaWarehouseBalance
  ledgerDate: string | null;
  warehouseCount: number;
  skus: LiveSku[];
  stockStatus: "In stock" | "Out of stock" | "Unknown"; // derived from SellerMate quantities (labelled as derived in the UI)
  // fields SellerMate does not provide — always null, rendered "—"
  available: null;
  reserved: null;
  inbound: null;
  unfulfillable: null;
  notes: string[];
}

export interface LiveWarehouseSummary { location: string; units: number; skuCount: number; asinCount: number }

export interface LiveInventoryResult {
  fetchedAt: string;
  ledgerDates: string[];
  products: LiveProduct[];
  warehouses: LiveWarehouseSummary[];
  counts: { asins: number; catalogSkus: number; fbaSkuRows: number; warehouseEntries: number; mergedRows: number; duplicateRowsRemoved: number };
  notes: string[];
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const day = (v: unknown): string | null => { const s = str(v); return s ? s.slice(0, 10) : null; };
const sumOrNull = (xs: (number | null)[]): number | null => (xs.some((x) => x !== null) ? xs.reduce<number>((a, x) => a + (x ?? 0), 0) : null);

export function buildLiveInventory(
  catalog: SmCatalogItem[],
  merged: SmMergedItem[],
  byLocation: SmByLocationItem[],
  fetchedAt: string,
): LiveInventoryResult {
  const notes: string[] = [];

  // de-duplicate (SellerMate repeats rows across pages)
  const mergedByAsin = new Map<string, SmMergedItem>();
  let dupes = 0;
  for (const m of merged) { if (!m?.asin) continue; if (mergedByAsin.has(m.asin)) dupes++; else mergedByAsin.set(m.asin, m); }
  const locByKey = new Map<string, SmByLocationItem>();
  for (const l of byLocation) { if (!l?.asin) continue; const k = `${l.asin}|${l.sku ?? ""}`; if (locByKey.has(k)) dupes++; else locByKey.set(k, l); }
  // keyed by ASIN + SKU: SellerMate's catalog can list the same SKU under two ASINs (seen:
  // 1Q-B0BQ-TJYO on B000F4UP10 and B01M6UNY12), and both product links must survive
  const catByKey = new Map<string, SmCatalogItem>();
  for (const c of catalog) { if (!c?.sku) continue; const k = `${c.asin}|${c.sku}`; if (catByKey.has(k)) dupes++; else catByKey.set(k, c); }
  const catBySku = new Map<string, SmCatalogItem>();
  for (const c of catByKey.values()) if (!catBySku.has(c.sku)) catBySku.set(c.sku, c);

  // every ASIN any source mentions — nothing may disappear
  const asins = new Set<string>([...mergedByAsin.keys(), ...[...locByKey.values()].map((l) => l.asin), ...[...catByKey.values()].map((c) => c.asin).filter(Boolean)]);

  const skusByAsin = new Map<string, Map<string, LiveSku>>();
  const ensureSku = (asin: string, sku: string): LiveSku => {
    const m = skusByAsin.get(asin) ?? new Map<string, LiveSku>(); skusByAsin.set(asin, m);
    let s = m.get(sku);
    if (!s) {
      const own = catByKey.get(`${asin}|${sku}`);
      const c = own ?? catBySku.get(sku); // same SKU = same listing settings, even if catalogued elsewhere
      const ch = str(c?.fulfillmentChannel);
      const status = Array.isArray(c?.status) ? (c!.status as unknown[]).map(String).filter(Boolean).join(", ") : str(c?.status);
      s = {
        sku, channel: ch === "AMAZON_IN" || ch?.startsWith("AMAZON") ? "FBA" : ch === "DEFAULT" ? "MFN" : null,
        listingQuantity: num(c?.quantity), fnsku: null, fbaWarehouseBalance: null, ledgerDate: null, warehouses: [],
        catalogStatus: status || null, inCatalog: !!own, catalogAsin: !own && c ? c.asin : null,
      };
      m.set(sku, s);
    }
    return s;
  };
  for (const c of catByKey.values()) if (c.asin) ensureSku(c.asin, c.sku);
  for (const l of locByKey.values()) {
    for (const w of l.fba?.byLocation ?? []) {
      const sku = str(w.sku) ?? str(l.sku);
      if (!sku) continue;
      const s = ensureSku(l.asin, sku);
      s.warehouses.push({ location: str(w.location) ?? "—", units: num(w.endingWarehouseBalance), fnsku: str(w.fnsku), asOfDate: day(w.asOfDate) });
    }
  }
  for (const m of skusByAsin.values()) for (const s of m.values()) {
    if (s.warehouses.length) {
      s.fbaWarehouseBalance = sumOrNull(s.warehouses.map((w) => w.units));
      s.ledgerDate = s.warehouses.map((w) => w.asOfDate).filter(Boolean).sort().at(-1) ?? null;
      s.fnsku = s.warehouses.find((w) => w.fnsku)?.fnsku ?? null;
      s.warehouses.sort((a, b) => (b.units ?? -1) - (a.units ?? -1));
    }
  }

  const products: LiveProduct[] = [];
  for (const asin of asins) {
    const m = mergedByAsin.get(asin);
    const locItems = [...locByKey.values()].filter((l) => l.asin === asin);
    const skus = [...(skusByAsin.get(asin)?.values() ?? [])].sort((a, b) => (b.fbaWarehouseBalance ?? -1) - (a.fbaWarehouseBalance ?? -1) || a.sku.localeCompare(b.sku));
    const anyCat = skus.map((s) => catByKey.get(`${asin}|${s.sku}`)).find(Boolean);
    const warehouseTotal = sumOrNull(skus.filter((s) => s.warehouses.length).map((s) => s.fbaWarehouseBalance));
    const fbaBalance = num(m?.fba?.endingWarehouseBalance) ?? sumOrNull(locItems.map((l) => num(l.fba?.endingWarehouseBalance)));
    const fbm = num(m?.fbm?.quantity);
    const pNotes: string[] = [];
    if (!m) pNotes.push("Not returned by SellerMate's inventory list (shown from catalog / warehouse data).");
    if (fbaBalance !== null && warehouseTotal !== null && fbaBalance !== warehouseTotal) pNotes.push(`Warehouse rows add up to ${warehouseTotal}, SellerMate's FBA total says ${fbaBalance}.`);
    const known = [fbm, fbaBalance].filter((x): x is number => x !== null);
    products.push({
      asin,
      title: str(m?.itemName) ?? str(locItems[0]?.itemName) ?? str(anyCat?.itemName),
      imageUrl: str(m?.mainImageUrl) ?? str(locItems.find((l) => str(l.mainImageUrl))?.mainImageUrl) ?? str(anyCat?.mainImageUrl),
      price: num(m?.price) ?? num(locItems[0]?.price) ?? num(anyCat?.price),
      fbmQuantity: fbm,
      fbaWarehouseBalance: fbaBalance,
      warehouseTotal,
      ledgerDate: skus.map((s) => s.ledgerDate).filter(Boolean).sort().at(-1) ?? day(locItems[0]?.fba?.asOfDate),
      warehouseCount: new Set(skus.flatMap((s) => s.warehouses.map((w) => w.location))).size,
      skus,
      stockStatus: known.length === 0 ? "Unknown" : known.some((x) => x > 0) ? "In stock" : "Out of stock",
      available: null, reserved: null, inbound: null, unfulfillable: null,
      notes: pNotes,
    });
  }
  products.sort((a, b) => ((b.fbaWarehouseBalance ?? 0) + (b.fbmQuantity ?? 0)) - ((a.fbaWarehouseBalance ?? 0) + (a.fbmQuantity ?? 0)) || a.asin.localeCompare(b.asin));

  // warehouse-wise summary across every SKU
  const wh = new Map<string, { units: number; skus: Set<string>; asins: Set<string> }>();
  for (const p of products) for (const s of p.skus) for (const w of s.warehouses) {
    const e = wh.get(w.location) ?? { units: 0, skus: new Set<string>(), asins: new Set<string>() };
    e.units += w.units ?? 0; e.skus.add(s.sku); e.asins.add(p.asin); wh.set(w.location, e);
  }
  const warehouses = [...wh].map(([location, e]) => ({ location, units: e.units, skuCount: e.skus.size, asinCount: e.asins.size })).sort((a, b) => b.units - a.units);

  const ledgerDates = [...new Set(products.flatMap((p) => p.skus.flatMap((s) => s.warehouses.map((w) => w.asOfDate))).filter((d): d is string => !!d))].sort();
  if (ledgerDates.length > 1) notes.push(`Warehouse data spans several ledger dates: ${ledgerDates.join(", ")}.`);
  const missingFromList = products.filter((p) => !mergedByAsin.has(p.asin)).length;
  if (missingFromList) notes.push(`${missingFromList} ASIN(s) appear only in SellerMate's catalog or warehouse data, not in its inventory list — shown anyway so nothing disappears.`);

  return {
    fetchedAt,
    ledgerDates,
    products,
    warehouses,
    counts: {
      asins: products.length,
      catalogSkus: catBySku.size, // distinct SKU codes
      fbaSkuRows: locByKey.size,
      warehouseEntries: products.reduce((a, p) => a + p.skus.reduce((b, s) => b + s.warehouses.length, 0), 0),
      mergedRows: mergedByAsin.size,
      duplicateRowsRemoved: dupes,
    },
    notes,
  };
}

// ── Fetching (server side; `call` performs one SellerMate tool call) ────────────────────────────
// get_inventory's offset paging is unstable, so every ASIN is requested by explicit batches. The
// ASIN list is the catalog's ASINs plus every ASIN the FBA warehouse view pages through — an FBA ASIN
// missing from the catalog still appears.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SellerMateCaller = (tool: string, args: Record<string, unknown>) => Promise<any>;

/** Runs tasks with at most `limit` in flight — SellerMate answers HTTP 429 when ~16 calls land at once. */
async function pooled<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out = new Array<T>(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) { const i = next++; out[i] = await tasks[i](); }
  }));
  return out;
}

export async function fetchLiveInventory(call: SellerMateCaller, base: { workspace_id: string; amazon_account_id: string }, batchSize = 50, concurrency = 3) {
  const catalog: SmCatalogItem[] = [];
  for (let off = 0, i = 0; i < 50; i++) {
    const r = await call("list_product_catalog", { ...base, limit: 200, offset: off });
    const p: SmCatalogItem[] = r.products || [];
    catalog.push(...p); off += p.length;
    if (!p.length || off >= (r.total || 0)) break;
  }
  const pagedLoc: SmByLocationItem[] = [];
  for (let off = 0, i = 0; i < 50; i++) {
    const r = await call("get_inventory", { ...base, view: "fba_by_location", limit: 200, offset: off });
    const items: SmByLocationItem[] = r.items || [];
    pagedLoc.push(...items); off += items.length;
    if (!items.length || off >= (r.total || 0)) break;
  }
  const asins = [...new Set([...catalog.map((c) => c.asin), ...pagedLoc.map((l) => l.asin)].filter(Boolean))];
  const batches: string[][] = [];
  for (let i = 0; i < asins.length; i += batchSize) batches.push(asins.slice(i, i + batchSize));
  const tasks = batches.flatMap((b) => [
    () => call("get_inventory", { ...base, view: "merged", asins: b, limit: 200 }),
    () => call("get_inventory", { ...base, view: "fba_by_location", asins: b, limit: 200 }),
  ]);
  const results = await pooled(tasks, concurrency);
  const merged: SmMergedItem[] = [];
  const byLoc: SmByLocationItem[] = [...pagedLoc];
  results.forEach((r, i) => { if (i % 2 === 0) merged.push(...(r.items || [])); else byLoc.push(...(r.items || [])); });
  const mergedAsins = new Set(merged.map((m) => m.asin));
  const result = buildLiveInventory(catalog, merged, byLoc, new Date().toISOString());
  return { ...result, requested: { asins: asins.length, catalogRows: catalog.length, missingFromInventoryList: asins.filter((a) => !mergedAsins.has(a)).length } };
}
