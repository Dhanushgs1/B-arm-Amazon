import * as XLSX from "xlsx-js-style";
import { mcp } from "@/lib/api";
import { resolveProductName } from "@/lib/categoryMap";
import { fetchAllRows, isCancelledOrder, isStandardOrderId, istDayWindowUtc } from "@/lib/amazonReportShared";
import { fetchMisAmazonOrders, fetchMisAmazonReturns, fetchMisFbaReturns, fetchMisSellerFlexReturns } from "@/lib/misAdapters";
import { fetchMasterSkuidMap, buildMasterSkuidResolver, gstMultiplierFromTax } from "@/lib/masterProductSkuid";
import { fetchProductMarketingMap, buildProductMarketingResolver } from "@/lib/productMarketingUpload";

// ── Analysis Report (Ad Performance) ────────────────────────────────────────
// Recreates the per-product "Analysis report" sheet from the seller's manual
// Amazon-ads workbook, rebuilt for two fixed trailing windows: Last 30 days and
// Last 7 days (both ending today, matching the dashboard's own "Last 30 Days"
// convention in DashboardContext).
//
// Ad spend/units, Orders and Returns all come from the SAME manually-uploaded
// tables historicalAnalysisReportExport.ts uses (SP advertised-product, AM
// orders, AM returns, FBA returns) — this used to call
// get_advertised_product_performance / get_retail_product_performance /
// get_fba_customer_returns live, which drifts from a fixed uploaded snapshot
// as new ad/order/return data lands on the live account between uploads, so
// the two reports never agreed even for the exact same date range. Price/
// FBA-MFN channel and FBA stock availability are still LIVE (product listing +
// inventory feed) — those are current-moment snapshots, not windowed figures,
// so there's no "which snapshot" drift to fix the way there was for Orders/
// Returns/spend.
//
// The seller's original sheet was a per-SKU pivot of raw Amazon report exports
// (SP advertised report + orders report + FBA/returns). The uploaded SP report
// is per-ASIN-and-SKU but this report only ever showed one row per ASIN, so it
// stays per-ASIN (with the primary SKU shown as a column) — format-faithful,
// not a byte-identical clone. SB/SD ad spend (campaign-level, no ASIN column)
// isn't included here, matching the live call this replaces — that endpoint
// only ever covered Sponsored Products too. The CPC / ACOS / TACOS
// formulas are reproduced exactly as the original sheet computed them:
//   Spend+Tax = ad spend × (1 + that ad row's SKU's own GST rate), from the
//               product master's per-SKU Tax column (18% used when a SKU has
//               none on file — most products are actually 5%, not 18%)
//   Final     = Orders − Returns
//   CPC       = Spend+Tax ÷ Advertised SKU Units   (÷1 when units = 0)
//   ACOS      = CPC ÷ Price = Spend+Tax ÷ (Price × Advertised SKU Units)   (÷1 when units = 0)
//   TACOS     = Spend+Tax ÷ (Price × Final)         (÷1 when final = 0)

// Amazon India fulfillment-centre (FC) code → state/region. Mirrors the mapping
// the seller's own "Inventory ledger" sheet used (its Location→Area IFS formula),
// extended to cover the common IN FCs. Used to reproduce the FBA-status columns
// (Available / Number of FBA Not Available / All FBA) from get_inventory's
// per-location breakdown. Unknown codes fall back to the raw code so nothing is
// silently dropped.
// FIX (Key Insights FC/state mismatch): this map is joined against order
// ship_state, which carries real STATE names — but BLR4/BLR7/BLR8, HYD3/
// HYD8/HYD2, LKO1 and JPX1/JPX2 used to map to their FC's CITY name
// (BANGALORE/HYDERABAD/LUCKNOW/JAIPUR) instead. Stock under those FCs then
// never joined any real ship_state, so Key Insights read "stock here, 0
// orders" for the FC's city label while the SAME region's real state label
// read "orders here, 0 stock" — a mirror-image false stockout/overstock
// verdict. Every other entry here was already a real state name (WEST
// BENGAL, TAMIL NADU, DELHI, HARYANA, ASSAM, PUNJAB, ODISHA, GUJARAT, BIHAR)
// — only these four FC groups were wrong.
const FC_STATE_MAP: Record<string, string> = {
  BLR4: "KARNATAKA", BLR7: "KARNATAKA", BLR8: "KARNATAKA",
  BOM5: "MAHARASHTRA", BOM7: "MAHARASHTRA", ISK3: "MAHARASHTRA", NAX1: "MAHARASHTRA", PNQ3: "MAHARASHTRA", PNQ2: "MAHARASHTRA",
  CCX1: "WEST BENGAL", CCX2: "WEST BENGAL",
  CJB1: "TAMIL NADU", MAA4: "TAMIL NADU", MAA1: "TAMIL NADU",
  DED3: "DELHI", DED4: "DELHI", DED5: "DELHI", DEL2: "DELHI", DEL8: "DELHI",
  DEL4: "HARYANA", DEL5: "HARYANA",
  HYD3: "TELANGANA", HYD8: "TELANGANA", HYD2: "TELANGANA",
  LKO1: "UTTAR PRADESH",
  JPX1: "RAJASTHAN", JPX2: "RAJASTHAN",
  GAX1: "ASSAM",
  ATX1: "PUNJAB", LDX1: "PUNJAB",
  BBX1: "ODISHA",
  AMD2: "GUJARAT", AMD3: "GUJARAT", SAMD: "GUJARAT",
  PAX1: "BIHAR",
  // Not a real geography — the seller's own uploaded Inventory Ledger names
  // this FC's Location/Area literally "VSNC" with no city/state anywhere in
  // that row, and their own hand-built pivot uses "VSNC" as its own bucket
  // label too (see FC_AREA_MAP_MANUAL below). So this can never join a real
  // ship_state — that's a genuine data gap, not a mapping bug, and inventing
  // a state here would misattribute this stock to somewhere it isn't.
  VSNC: "VSNC",
};

export function fcToState(code: string): string {
  if (!code) return "UNKNOWN";
  const up = code.toUpperCase();
  if (FC_STATE_MAP[up]) return FC_STATE_MAP[up];
  // Prefix fallback (e.g. an unseen BLRx still reads as Karnataka).
  const prefix3 = up.slice(0, 3);
  const byPrefix = Object.entries(FC_STATE_MAP).find(([k]) => k.slice(0, 3) === prefix3);
  return byPrefix ? byPrefix[1] : up;
}

// Transcription of the IFS formula in the "Area" column of the seller's own
// "Inventory ledger" sheet — no prefix fallback, no extra FCs, anything
// unlisted becomes "UNKNOWN", exactly as their formula's TRUE branch does.
// Used ONLY where this workbook has to reconcile 1:1 with their manual pivot
// (the FBA status sheet, the Analysis report's FBA columns, and the raw
// Inventory ledger mirror). Everywhere else uses fcToState above.
//
// This map is CITY-grained, matching the labels their formula already emits
// (BANGALORE, HYDERABAD, JAIPUR, LUCKNOW, DELHI). fcToState is STATE-grained
// for the same codes, on purpose — it is joined against order ship_state, which
// carries real state names (GUJARAT, HARYANA, ...). So the two disagreeing is
// correct, not a bug:
//   DEL4/DEL5 -> DELHI here, HARYANA in fcToState (they are Haryana FCs).
//   AMD2/AMD3/SAMD -> AHMEDABAD here, GUJARAT in fcToState.
//
// The one deliberate deviation from their formula: it never listed the
// Ahmedabad FCs at all, so AMD stock fell through to UNKNOWN in their pivot.
// Dhanush confirmed 08-08-2026 that AMD means Ahmedabad, so it is labelled
// rather than left unknown. Unit counts are unaffected — same bucket, real name.
const FC_AREA_MAP_MANUAL: Record<string, string> = {
  BLR4: "BANGALORE", BLR7: "BANGALORE", BLR8: "BANGALORE",
  BOM5: "MAHARASHTRA", BOM7: "MAHARASHTRA", ISK3: "MAHARASHTRA", NAX1: "MAHARASHTRA", PNQ3: "MAHARASHTRA",
  CCX1: "WEST BENGAL", CCX2: "WEST BENGAL",
  CJB1: "TAMIL NADU", MAA4: "TAMIL NADU",
  DED3: "DELHI", DED4: "DELHI", DED5: "DELHI", DEL2: "DELHI", DEL8: "DELHI",
  DEL4: "DELHI", DEL5: "DELHI",
  HYD3: "HYDERABAD", HYD8: "HYDERABAD",
  LKO1: "LUCKNOW",
  JPX1: "JAIPUR", JPX2: "JAIPUR",
  GAX1: "ASSAM",
  ATX1: "PUNJAB", LDX1: "PUNJAB",
  BBX1: "ODISHA",
  AMD2: "AHMEDABAD", AMD3: "AHMEDABAD", SAMD: "AHMEDABAD",
  VSNC: "VSNC",
};

export function fcToAreaManual(code: string): string {
  if (!code) return "UNKNOWN";
  return FC_AREA_MAP_MANUAL[code.toUpperCase()] || "UNKNOWN";
}

// Local-time YYYY-MM-DD, matching DashboardContext.getLocalDateStr so the
// windows line up with the rest of the dashboard (no UTC timezone shift).
function localDateStr(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// DD-MM-YYYY for the human-readable window headers ("23-05-2026 to 21-06-2026").
function dotDate(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

interface WindowStats {
  spendTax: number;   // ad spend × (1 + that SKU's own GST rate)
  adSales: number;    // ad-attributed sales (for the Total Units estimate)
  advUnits: number;   // Advertised SKU Units (#) — ad orders/purchases
  totalUnits: number; // Total Units (#) — ad-attributed units (adSales ÷ price)
  orders: number;     // total units ordered (all channels)
  returns: number;    // genuine customer returns
}

function emptyWindow(): WindowStats {
  return { spendTax: 0, adSales: 0, advUnits: 0, totalUnits: 0, orders: 0, returns: 0 };
}

// Per-SKU listing detail (Price / FBA-MFN / FBA availability are all genuinely
// per-SKU; ad + retail sales are only available per-ASIN, so they live on the
// parent ProductRow and are shown against the primary SKU only).
interface SkuInfo {
  sku: string;
  price: number;
  channel: string;   // FBA/MFN — real listing fulfillment-channel (AMAZON_IN / DEFAULT)
  isFba: boolean;
  fbmQty: number;
  fbaTotal: number;                    // FBA units on hand across all FCs (this SKU)
  stateBalances: Map<string, number>;  // state/region → warehouse balance (this SKU)
}

function emptySku(sku: string): SkuInfo {
  return { sku, price: 0, channel: "", isFba: false, fbmQty: 0, fbaTotal: 0, stateBalances: new Map() };
}

interface ProductRow {
  asin: string;
  name: string;            // fallback/raw name; the clean Master-sheet name is resolved per SKU at emit time
  price: number;           // representative (primary SKU) price — used for the Total-Units derivation
  w30: WindowStats;        // ASIN-level ad + retail stats (30d)
  w7: WindowStats;         // ASIN-level ad + retail stats (7d)
  skus: Map<string, SkuInfo>;
}

export type ToolCaller = (tool: string, args: any) => Promise<any>;

// Ad spend/units per ASIN, from the uploaded SP advertised-product report —
// same table historicalAnalysisReportExport.ts reads (there, keyed by SKU;
// here, by the row's own advertised_asin since this report is ASIN-grain).
// SB/SD (campaign-level, no ASIN column) aren't included here, same as the
// live get_advertised_product_performance call this replaces — that endpoint
// only ever covered Sponsored Products too.
function spRowsToAdRows(spRows: any[]): any[] {
  return spRows
    .filter((r) => r.advertised_asin)
    .map((r) => ({
      adAsin: r.advertised_asin,
      // This SP row's own SKU — GST is a per-SKU rate (see aggregateWindow),
      // so it must travel with the row even though ProductRow itself is keyed
      // by ASIN, not SKU.
      adSku: r.advertised_sku || "",
      spend: r.spend || 0,
      sales: r.advertised_sku_sales_7d || r.sales_7d || 0,
      orders: r.advertised_sku_units_7d || r.units_7d || 0,
    }));
}

// Orders (units ordered, all channels) per ASIN, from the uploaded AM orders
// table — same source + cancelled-order/non-standard-order-id exclusion as
// historicalAnalysisReportExport.ts, mapped into the {asin, productName,
// unitsOrdered, averageSellingPrice} shape aggregateWindow's retail-rows
// branch expects.
function ordersToRetailRows(orderRows: any[]): any[] {
  return orderRows
    .filter((r) => r.sku && !isCancelledOrder(r) && isStandardOrderId(r.amazon_order_id))
    .map((r) => ({
      asin: r.asin,
      productName: r.product_name,
      unitsOrdered: r.quantity || 0,
      averageSellingPrice: r.item_price || 0,
    }));
}

// Returns per ASIN — computed per SKU first (AM returns take priority; FBA +
// SF returns only fill in for a SKU with NO AM return recorded, since the same
// physical return can otherwise show up in both and get double-counted), then
// rolled up to each SKU's own ASIN. Same rule as
// historicalAnalysisReportExport.ts, verified directly against the seller's
// workbook (AM-else-(FBA+SF) reproduced their Returns column for all 140 SKUs
// it currently tracks — a plain sum or an AM-only figure each diverged).
function returnsToReturnRows(amReturnRows: any[], fbaReturnRows: any[], sfReturnRows: any[]): any[] {
  const amBySku = new Map<string, number>();
  const skuAsin = new Map<string, string>();
  amReturnRows.forEach((r) => {
    if (!r.merchant_sku) return;
    amBySku.set(r.merchant_sku, (amBySku.get(r.merchant_sku) || 0) + (r.return_quantity || 0));
    if (r.asin) skuAsin.set(r.merchant_sku, r.asin);
  });
  const fbaSfBySku = new Map<string, number>();
  fbaReturnRows.forEach((r) => {
    if (!r.sku) return;
    fbaSfBySku.set(r.sku, (fbaSfBySku.get(r.sku) || 0) + (r.quantity || 0));
    if (r.asin) skuAsin.set(r.sku, r.asin);
  });
  sfReturnRows.forEach((r) => {
    if (!r.msku) return;
    fbaSfBySku.set(r.msku, (fbaSfBySku.get(r.msku) || 0) + (r.units || 0));
    if (r.asin) skuAsin.set(r.msku, r.asin);
  });
  const out: any[] = [];
  new Set([...amBySku.keys(), ...fbaSfBySku.keys()]).forEach((sku) => {
    const asin = skuAsin.get(sku);
    if (!asin) return;
    const amSum = amBySku.get(sku) || 0;
    out.push({ asin, quantity: amSum > 0 ? amSum : (fbaSfBySku.get(sku) || 0) });
  });
  return out;
}

// Per-location FBA view — each item carries fba.byLocation (FC code + warehouse
// balance) plus the rolled-up fba.endingWarehouseBalance. This is what feeds the
// Available / Grand Total / Number-of-FBA-Not-Available / All-FBA columns.
// Exported so historicalAnalysisReportExport.ts can reuse the same live-catalog
// sourcing for Price/FBA-MFN/inventory (nothing in the manually-uploaded report
// files carries that data).
export async function fetchInventoryByLocation(call: ToolCaller, args: any) {
  const seen = new Set<string>();
  const all: any[] = [];
  let offset = 0;
  for (let i = 0; i < 10; i++) {
    const res = await call("get_inventory", { ...args, view: "fba_by_location", limit: 200, offset }).catch(() => null);
    const items = res?.items || [];
    for (const item of items) {
      if (item.asin && seen.has(item.asin)) continue;
      if (item.asin) seen.add(item.asin);
      all.push(item);
    }
    if (items.length === 0 || offset + items.length >= (res?.total || 0)) break;
    offset += 200;
  }
  return all;
}

export async function fetchFullCatalog(call: ToolCaller, args: any) {
  const all: any[] = [];
  let offset = 0;
  for (let i = 0; i < 30; i++) {
    const res = await call("list_product_catalog", { ...args, limit: 200, offset, include_suppressed: true }).catch(() => null);
    const page = res?.products || [];
    all.push(...page);
    offset += page.length;
    if (page.length < 200 || offset >= (res?.total || 0)) break;
  }
  return all;
}

// Reduce a window's ad + retail + returns rows into per-ASIN WindowStats.
function aggregateWindow(
  rows: Map<string, ProductRow>,
  ensure: (asin: string) => ProductRow,
  pick: (p: ProductRow) => WindowStats,
  adRows: any[],
  retailRows: any[],
  returnRows: any[]
) {
  // Ad spend / ad sales / advertised orders per ASIN.
  adRows.forEach((r: any) => {
    if (!r.adAsin) return;
    const p = ensure(r.adAsin);
    if (p.name === p.asin && r.adProductName) p.name = r.adProductName;
    const w = pick(p);
    w.spendTax += (r.spend || 0) * gstMultiplierFromTax();
    w.adSales += r.sales || 0;
    w.advUnits += r.orders || 0; // purchases — closest per-ASIN unit proxy the API exposes
  });

  // Total orders (units) + selling price per ASIN.
  retailRows.forEach((r: any) => {
    if (!r.asin) return;
    const p = ensure(r.asin);
    if (p.name === p.asin && r.productName) p.name = r.productName;
    const w = pick(p);
    w.orders += r.unitsOrdered || 0;
    const asp = r.averageSellingPrice || (r.unitsOrdered ? (r.totalSales || 0) / r.unitsOrdered : 0);
    if (asp && !p.price) p.price = asp;
  });

  // Returns per ASIN — returnRows are already genuine-return-filtered by the
  // caller (returnsToReturnRows), so this just sums quantity.
  const returnsByAsin = new Map<string, number>();
  returnRows.forEach((r: any) => {
    if (!r.asin) return;
    returnsByAsin.set(r.asin, (returnsByAsin.get(r.asin) || 0) + (r.quantity || 1));
  });
  returnsByAsin.forEach((cnt, asin) => {
    const w = pick(ensure(asin));
    w.returns += cnt;
  });
}

// Finalize the derived Total Units estimate (adSales ÷ price) once prices are known.
function finalizeUnits(w: WindowStats, price: number) {
  if (price > 0 && w.adSales > 0) {
    w.totalUnits = Math.round(w.adSales / price);
  } else {
    w.totalUnits = w.advUnits;
  }
}

// Excel-faithful metric formulas (guarded division as the original sheet did).
function computeCpc(w: WindowStats) {
  return w.advUnits > 0 ? w.spendTax / w.advUnits : w.spendTax;
}
// ACOS exactly as the source sheet: M = CPC / Price = Spend+Tax / (Advertised SKU
// Units × Price). Uses Advertised Units (G), NOT the derived Total Units.
function computeAcos(w: WindowStats, price: number) {
  return price > 0 ? computeCpc(w) / price : 0;
}
function computeTacos(w: WindowStats, price: number) {
  const final = Math.max(0, w.orders - w.returns);
  const denom = price * (final || 1);
  return denom > 0 ? w.spendTax / denom : 0;
}

interface BuildOpts {
  call: ToolCaller;
  accountId: string | undefined;
  workspaceId: string | undefined;
  accountName: string | undefined;
  today?: Date; // injectable for testing; defaults to now
}

export async function buildAnalysisReportWorkbook(opts: BuildOpts) {
  const { call, accountId, workspaceId, accountName } = opts;
  const baseArgs = { amazon_account_id: accountId, workspace_id: workspaceId };

  const today = opts.today || new Date();
  const end = localDateStr(today);
  const d30 = new Date(today); d30.setDate(d30.getDate() - 29);
  const d7 = new Date(today); d7.setDate(d7.getDate() - 6);
  const start30 = localDateStr(d30);
  const start7 = localDateStr(d7);

  const label30 = `Last 30 days (${dotDate(start30)} to ${dotDate(end)})`;
  const label7 = `Last 7 days (${dotDate(start7)} to ${dotDate(end)})`;

  const args30 = { ...baseArgs, start_date: start30, end_date: end };
  const args7 = { ...baseArgs, start_date: start7, end_date: end };
  // Orders/FBA-returns carry a timestamp — bucket by IST calendar day (see
  // istDayWindowUtc), not the raw UTC instant.
  const win30Ist = istDayWindowUtc(start30, end);
  const win7Ist = istDayWindowUtc(start7, end);

  // Fire every fetch concurrently — same fan-out style as the Full report.
  // Ad spend/orders/returns are fetched once for the 30-day window (a superset
  // of the 7-day window) and the 7-day slice is filtered in memory below,
  // matching historicalAnalysisReportExport.ts's single-fetch pattern for the
  // same tables.
  const [
    spRows30, orderRows30, amReturnRows30, fbaReturnRows30, sfReturnRows30, inventory, catalog, masterSkuid, productMarketing,
  ] = await Promise.all([
    fetchAllRows("barm_amazon_sp_advertised_product", (q) => q.gte("report_date", start30).lte("report_date", end)),
    fetchMisAmazonOrders((q) => q.gte("purchase_datetime", win30Ist.gte).lt("purchase_datetime", win30Ist.lt)),
    fetchMisAmazonReturns((q) => q.gte("return_request_date", start30).lte("return_request_date", end)),
    fetchMisFbaReturns((q) => q.gte("return_date", win30Ist.gte).lt("return_date", win30Ist.lt)),
    fetchMisSellerFlexReturns((q) => q.gte("pickup_date", start30).lte("pickup_date", end)),
    fetchInventoryByLocation(call, baseArgs).catch(() => []),
    fetchFullCatalog(call, baseArgs).catch(() => []),
    fetchMasterSkuidMap(),
    fetchProductMarketingMap(),
  ]);
  const { resolveName: resolveSkuidNameRaw } = buildMasterSkuidResolver(masterSkuid);
  const { resolveName: resolveMarketingName } = buildProductMarketingResolver(productMarketing);
  // master_product_marketing is the marketing team's freshest, most current master — checked
  // first; master_product_skuid only fills in a SKU it doesn't have.
  const resolveSkuidName = (sku: string, fallback: string) => resolveMarketingName(sku, resolveSkuidNameRaw(sku, fallback));

  const products = new Map<string, ProductRow>();
  const ensure = (asin: string): ProductRow => {
    let p = products.get(asin);
    if (!p) {
      p = { asin, name: asin, price: 0, w30: emptyWindow(), w7: emptyWindow(), skus: new Map() };
      products.set(asin, p);
    }
    return p;
  };
  const ensureSku = (p: ProductRow, sku?: string): SkuInfo | null => {
    if (!sku) return null;
    let s = p.skus.get(sku);
    if (!s) { s = emptySku(sku); p.skus.set(sku, s); }
    return s;
  };

  // Catalog is the authoritative per-SKU source for Price and FBA/MFN (fulfillment
  // channel) — exactly like the seller's "Price" (All-Listings) sheet. Each SKU
  // keeps its own price + channel + FBM quantity so it can be its own report row.
  catalog.forEach((c: any) => {
    if (!c.asin) return;
    const p = ensure(c.asin);
    if (p.name === p.asin && c.itemName) p.name = c.itemName;
    const s = ensureSku(p, c.sku);
    if (!s) return;
    const isFbaSku = typeof c.fulfillmentChannel === "string" && c.fulfillmentChannel.toUpperCase().startsWith("AMAZON");
    s.isFba = isFbaSku;
    s.channel = isFbaSku ? "AMAZON_IN" : "DEFAULT";
    const price = Number(c.price) || 0;
    if (price > 0) s.price = price;
    if (!isFbaSku) s.fbmQty += Number(c.quantity) || 0;
  });

  // 7-day subsets — filtered in memory from the same 30-day fetch (no second DB round-trip).
  const spRows7 = spRows30.filter((r: any) => r.report_date >= start7);
  const orderRows7 = orderRows30.filter((r: any) => r.purchase_datetime >= win7Ist.gte);
  const amReturnRows7 = amReturnRows30.filter((r: any) => r.return_request_date >= start7);
  const fbaReturnRows7 = fbaReturnRows30.filter((r: any) => r.return_date >= win7Ist.gte);
  const sfReturnRows7 = sfReturnRows30.filter((r: any) => r.pickup_date >= start7);

  aggregateWindow(products, ensure, (p) => p.w30, spRowsToAdRows(spRows30), ordersToRetailRows(orderRows30), returnsToReturnRows(amReturnRows30, fbaReturnRows30, sfReturnRows30));
  aggregateWindow(products, ensure, (p) => p.w7, spRowsToAdRows(spRows7), ordersToRetailRows(orderRows7), returnsToReturnRows(amReturnRows7, fbaReturnRows7, sfReturnRows7));

  // Inventory (per-location): FBA warehouse balance per FC → aggregate by state,
  // keyed to the specific SKU each location row carries.
  inventory.forEach((i: any) => {
    if (!i.asin) return;
    const p = ensure(i.asin);
    for (const loc of i.fba?.byLocation || []) {
      const bal = loc.endingWarehouseBalance || 0;
      const s = ensureSku(p, loc.sku || i.sku);
      if (!s) continue;
      s.isFba = true;
      if (bal <= 0) continue;
      s.fbaTotal += bal;
      const state = fcToState(loc.location);
      s.stateBalances.set(state, (s.stateBalances.get(state) || 0) + bal);
    }
    // Fallback: an item with no byLocation rows but a rolled-up balance.
    if (!(i.fba?.byLocation?.length) && (i.fba?.endingWarehouseBalance || 0) > 0) {
      const s = ensureSku(p, i.sku);
      if (s) { s.isFba = true; s.fbaTotal += i.fba.endingWarehouseBalance; }
    }
  });

  // Account-wide set of FBA states (union across all SKUs) — the denominator for
  // "Number of FBA Not Available", mirroring the fixed per-state columns in the
  // seller's FBA-status pivot.
  const accountStates = new Set<string>();
  products.forEach((p) => p.skus.forEach((s) => s.stateBalances.forEach((_v, st) => accountStates.add(st))));

  // Primary SKU per ASIN = the main listing the ASIN-level ad/retail sales are
  // shown against (so grand totals never double-count across sibling SKUs).
  // Preference: FBA listing first (ads normally run on the FBA SKU), then most
  // stock on hand, then priciest, then SKU id for a stable tiebreak.
  const rank = (s: SkuInfo): [number, number, number] => [s.isFba ? 1 : 0, s.fbaTotal + s.fbmQty, s.price];
  const primarySku = (p: ProductRow): string | null => {
    let best: SkuInfo | null = null;
    p.skus.forEach((s) => {
      if (!best) { best = s; return; }
      const rs = rank(s), rb = rank(best);
      for (let i = 0; i < rs.length; i++) {
        if (rs[i] !== rb[i]) { if (rs[i] > rb[i]) best = s; return; }
      }
      if (s.sku < best.sku) best = s;
    });
    return best ? (best as SkuInfo).sku : null;
  };

  // Representative price (primary SKU) drives the Total-Units derivation.
  products.forEach((p) => {
    const prim = primarySku(p);
    p.price = (prim && p.skus.get(prim)?.price) || [...p.skus.values()].find((s) => s.price > 0)?.price || p.price || 0;
    finalizeUnits(p.w30, p.price);
    finalizeUnits(p.w7, p.price);
  });

  // Keep ASINs that had any real activity in either window, or that hold stock —
  // drops the long tail of dormant catalog ASINs with zero everything.
  const rows = [...products.values()].filter((p) => {
    const winActive = p.w30.spendTax || p.w30.orders || p.w7.spendTax || p.w7.orders;
    const stockActive = [...p.skus.values()].some((s) => s.fbaTotal || s.fbmQty);
    return !!(winActive || stockActive);
  });

  // Sort by 30-day ad spend (biggest ad investment first), then total orders.
  rows.sort((a, b) => (b.w30.spendTax - a.w30.spendTax) || (b.w30.orders - a.w30.orders));

  // ── Build the sheet ──
  const WIN_COLS = ["Spend+Tax", "Advertised SKU Units (#)", "Total Units (#)", "Orders", "Returns", "Final", "CPC", "ACOS", "TACOS"];
  const AVAIL_COLS = ["Available", "Grand Total", "Inbound-shipped-quantity", "Number of FBA Not Available", "All FBA"];
  const LEAD_COLS = ["Product", "SKU ID", "FBA/MFN", "Price"];

  // Inbound-shipped-quantity is not exposed by the SellerMate / SP-API inventory
  // feed (only the ledger warehouse balance is synced — not inbound/in-transit),
  // so this column is present for layout fidelity but shown as "—".
  const INBOUND_NA = "—";

  // Availability cells for a whole ASIN (Excel cols X–AB), aggregated across every
  // SKU it carries — unlike sales, stock-on-hand is genuinely known per SKU/FC, so
  // summing it for the product is real data, not a guess (same aggregation the
  // Weekly Sales Report already does for its "stock" figure).
  const buildAvailCells = (p: ProductRow) => {
    let fbaTotal = 0;
    let anyFba = false;
    const stateBalances = new Map<string, number>();
    p.skus.forEach((s) => {
      if (s.isFba) anyFba = true;
      fbaTotal += s.fbaTotal;
      s.stateBalances.forEach((v, st) => stateBalances.set(st, (stateBalances.get(st) || 0) + v));
    });
    if (!anyFba && fbaTotal <= 0) return ["0", "", "", "", ""];
    const withStock = [...stateBalances.entries()].filter(([, v]) => v > 0).map(([st]) => st).sort();
    const available = withStock.length ? withStock.join(", ") : "0";
    const notAvailable = Math.max(0, accountStates.size - withStock.length);
    return [available, fbaTotal, INBOUND_NA, notAvailable, notAvailable > 0 ? "No" : "Yes"];
  };

  const header0: any[] = [...LEAD_COLS];                 // group row
  const header1: any[] = [...LEAD_COLS];                 // column row
  // 30-day block
  header0.push(label30, ...Array(WIN_COLS.length - 1).fill(""));
  header1.push(...WIN_COLS);
  // 7-day block
  header0.push(label7, ...Array(WIN_COLS.length - 1).fill(""));
  header1.push(...WIN_COLS);
  // availability block
  header0.push("FBA Availability (current)", ...Array(AVAIL_COLS.length - 1).fill(""));
  header1.push(...AVAIL_COLS);

  const aoa: any[][] = [header0, header1];

  const buildWinCells = (w: WindowStats, price: number) => {
    const final = Math.max(0, w.orders - w.returns);
    return [
      w.spendTax,
      w.advUnits,
      w.totalUnits,
      w.orders,
      w.returns,
      final,
      computeCpc(w),
      computeAcos(w, price),
      computeTacos(w, price),
    ];
  };

  // One row per ASIN (matches the Weekly Sales Report's row model). Ad/retail
  // sales are only ever known per ASIN, never per SKU, so — like Weekly — this
  // shows the ASIN's real sales once, represented by its primary SKU (FBA
  // listing preferred, then most stock, then price). A sibling SKU of the same
  // ASIN is not given its own row; its stock is still folded into the
  // availability columns via buildAvailCells, so nothing is silently dropped
  // except the sibling's own SKU-ID/Price/FBA-MFN line.
  let emittedRows = 0;
  rows.forEach((p) => {
    const prim = primarySku(p);
    const primInfo = prim ? p.skus.get(prim) : undefined;
    // master_product_skuid's curated name wins over both the categoryMap.ts
    // fallback and the raw ad/order/catalog title — same priority every other
    // report gives it (see masterProductSkuid.ts's header comment).
    const name = resolveSkuidName(prim || "", resolveProductName(p.name, prim) || p.name);
    aoa.push([
      name,
      prim || "",
      primInfo?.channel || "",
      Math.round(primInfo?.price || p.price || 0),
      ...buildWinCells(p.w30, p.price),
      ...buildWinCells(p.w7, p.price),
      ...buildAvailCells(p),
    ]);
    emittedRows++;
  });

  // Grand-total row. Additive columns are summed; the ratio columns (CPC / ACOS
  // / TACOS) are recomputed from the aggregated numerators and denominators —
  // using the SAME denominators the per-row formulas use (Price × Units, Price ×
  // Final), so the total stays consistent with the rows above it rather than
  // being a meaningless average of ratios.
  const totalRowCells = (getW: (p: ProductRow) => WindowStats) => {
    let spendTax = 0, advUnits = 0, totalUnits = 0, orders = 0, returns = 0;
    let acosDenom = 0, tacosDenom = 0;
    rows.forEach((p) => {
      const w = getW(p);
      spendTax += w.spendTax; advUnits += w.advUnits; totalUnits += w.totalUnits;
      orders += w.orders; returns += w.returns;
      acosDenom += p.price * w.advUnits; // ACOS uses Advertised Units (matches per-row M = CPC/Price)
      tacosDenom += p.price * Math.max(0, w.orders - w.returns);
    });
    const final = Math.max(0, orders - returns);
    return [
      spendTax, advUnits, totalUnits, orders, returns, final,
      advUnits > 0 ? spendTax / advUnits : spendTax,
      acosDenom > 0 ? spendTax / acosDenom : 0,
      tacosDenom > 0 ? spendTax / tacosDenom : 0,
    ];
  };
  const totFbaAvail = rows.reduce((a, p) => a + [...p.skus.values()].reduce((x, s) => x + s.fbaTotal, 0), 0);
  const grandRowIdx = aoa.length;
  aoa.push([
    "GRAND TOTAL", "", "", "",
    ...totalRowCells((p) => p.w30),
    ...totalRowCells((p) => p.w7),
    "", totFbaAvail, "", "", "",
  ]);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const totalCols = header1.length;

  // Merges: lead cols span both header rows; each block spans its columns in row 0.
  const merges: any[] = LEAD_COLS.map((_, c) => ({ s: { r: 0, c }, e: { r: 1, c } }));
  const b30 = LEAD_COLS.length;
  const b7 = b30 + WIN_COLS.length;
  const bAvail = b7 + WIN_COLS.length;
  merges.push({ s: { r: 0, c: b30 }, e: { r: 0, c: b30 + WIN_COLS.length - 1 } });
  merges.push({ s: { r: 0, c: b7 }, e: { r: 0, c: b7 + WIN_COLS.length - 1 } });
  merges.push({ s: { r: 0, c: bAvail }, e: { r: 0, c: bAvail + AVAIL_COLS.length - 1 } });
  ws["!merges"] = merges;

  // Header styling — indigo group row, lighter indigo column row (matches the
  // Amazon Sales report). 7-day block gets a slightly different hue so the two
  // windows read apart at a glance.
  for (let r = 0; r <= 1; r++) {
    for (let c = 0; c < totalCols; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (!ws[addr]) ws[addr] = { t: "s", v: "" };
      let fill = r === 0 ? "312E81" : "4F46E5";
      if (c >= b7 && c < bAvail) fill = r === 0 ? "3730A3" : "6366F1"; // 7-day block accent
      if (c >= bAvail) fill = r === 0 ? "065F46" : "059669";          // availability block accent
      ws[addr].s = {
        font: { bold: true, color: { rgb: "FFFFFF" }, sz: r === 0 ? 11 : 10 },
        fill: { fgColor: { rgb: fill } },
        alignment: { horizontal: "center", vertical: "center", wrapText: true },
        border: { bottom: { style: "medium", color: { rgb: "1E1B4B" } } },
      };
    }
  }

  const acosColor = (v: number) => (v < 0.25 ? "92D050" : v > 0.4 ? "FF0000" : "FFCC00");

  for (let r = 2; r < aoa.length; r++) {
    const isGrand = r === grandRowIdx;
    for (let c = 0; c < totalCols; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (!cell) continue;

      const style: any = {
        font: { color: { rgb: "1F2937" }, bold: isGrand },
        alignment: { vertical: "center", horizontal: c === 0 ? "left" : "center" },
        border: {
          bottom: { style: isGrand ? "medium" : "thin", color: { rgb: isGrand ? "312E81" : "E5E7EB" } },
          ...(isGrand ? { top: { style: "medium", color: { rgb: "312E81" } } } : {}),
        },
      };

      // Determine which logical column this is (Price, or an index within a block).
      const isPriceCol = c === 3;
      let posInWin = -1;
      if (c >= b30 && c < b7) posInWin = c - b30;
      else if (c >= b7 && c < bAvail) posInWin = c - b7;

      if (isPriceCol) {
        style.numFmt = "#,##0"; // Price as a whole number — no .00 decimals
      } else if (posInWin >= 0) {
        // 0 Spend+Tax, 1 AdvUnits, 2 TotalUnits, 3 Orders, 4 Returns, 5 Final, 6 CPC, 7 ACOS, 8 TACOS
        if (posInWin === 0 || posInWin === 6) style.numFmt = "#,##0.00";
        else if (posInWin >= 1 && posInWin <= 5) style.numFmt = "#,##0";
        else if (posInWin === 7 || posInWin === 8) {
          style.numFmt = "0.00%";
          if (typeof cell.v === "number" && cell.v > 0) {
            style.fill = { fgColor: { rgb: acosColor(cell.v) } };
            style.font = { color: { rgb: cell.v > 0.4 ? "FFFFFF" : "000000" }, bold: true };
          }
        }
        // Final < 0 (more returns than orders) flagged red.
        if (posInWin === 5 && typeof cell.v === "number" && cell.v < 0) {
          style.font = { color: { rgb: "B91C1C" }, bold: true };
        }
      } else if (c === 0) {
        style.font = { color: { rgb: "111827" }, bold: true };
      } else if (c === 1) {
        style.font = { color: { rgb: "4338CA" }, bold: true };
      }
      cell.s = style;
    }
  }

  const cols: any[] = [{ wch: 46 }, { wch: 20 }, { wch: 11 }, { wch: 10 }];
  for (let i = 0; i < 2; i++) {
    cols.push({ wch: 11 }, { wch: 13 }, { wch: 11 }, { wch: 9 }, { wch: 9 }, { wch: 8 }, { wch: 10 }, { wch: 9 }, { wch: 9 });
  }
  // Availability block: Available (state list) / Grand Total / Inbound-shipped-qty
  // / Number of FBA Not Available / All FBA.
  cols.push({ wch: 46 }, { wch: 11 }, { wch: 22 }, { wch: 24 }, { wch: 8 });
  ws["!cols"] = cols;
  ws["!rows"] = [{ hpt: 22 }, { hpt: 40 }];
  ws["!views"] = [{ state: "frozen", xSplit: 4, ySplit: 2 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Analysis report");

  // A small notes sheet documenting sourcing + the ~48h Amazon sync lag, so the
  // trailing-day dip isn't mistaken for a real drop.
  const wsNote = XLSX.utils.aoa_to_sheet([
    ["Analysis Report — Ad Performance"],
    [`Account: ${accountName || "-"}`],
    [`Last 30 days: ${dotDate(start30)} to ${dotDate(end)}`],
    [`Last 7 days: ${dotDate(start7)} to ${dotDate(end)}`],
    [""],
    ["Spend+Tax = ad spend x (1 + that SKU's GST rate), from the product master's per-SKU Tax column (18% used when a SKU has none on file). Final = Orders - Returns."],
    ["CPC = Spend+Tax / Advertised SKU Units (falls back to Spend+Tax when units = 0)."],
    ["ACOS = CPC / Price = Spend+Tax / (Advertised SKU Units x Price)."],
    ["TACOS = Spend+Tax / (Price x Final)."],
    ["Advertised SKU Units = ad-attributed orders; Total Units = ad sales / price (estimate)."],
    ["Product name comes from the Master SKU sheet; Price shown as a whole number."],
    ["One row per ASIN (product) - matches the Weekly Sales Report. Ad + retail sales are only ever known per ASIN, never per SKU, so when a product has multiple SKUs only one (the primary: FBA listing preferred, then most stock, then price) is shown as the SKU ID / FBA-MFN / Price for that row."],
    ["FBA availability (Available / Grand Total / Number of FBA Not Available / All FBA) is summed across every SKU of the product, not just the primary one - stock levels are genuinely known per SKU, unlike sales."],
    ["Price and FBA/MFN come from the live product listing (All-Listings feed) - the listing price and its fulfillment channel (AMAZON_IN = FBA, DEFAULT = MFN) of the primary SKU."],
    ["Inbound-shipped-quantity shows '—': Amazon's inbound / in-transit quantity is not exposed by the SP-API inventory feed (only the ledger warehouse balance is synced)."],
    ["Returns = AM returns for a SKU if any were recorded, otherwise FBA + SF returns for that SKU (courier RTO / undeliverable included either way) — matching the seller's own workbook. AM and FBA/SF returns can both record the same physical return, so they aren't simply added together."],
    ["The most recent 1-2 days can look low - that's Amazon's own reporting sync lag, not a real drop."],
  ]);
  wsNote["!cols"] = [{ wch: 110 }];
  wsNote["A1"].s = { font: { bold: true, sz: 13, color: { rgb: "312E81" } } };
  XLSX.utils.book_append_sheet(wb, wsNote, "Notes");

  const filename = `Amazon_Analysis_Report_Ad_Performance_${start30}_to_${end}.xlsx`;
  return { wb, filename, productCount: emittedRows };
}

// Browser entry point used by the Reports page — fetches through the /api/tool
// proxy with the account's keySlot, then triggers a real file download.
export async function exportAnalysisReport(opts: {
  account: { id?: string; workspace_id?: string; name?: string } | null | undefined;
  keySlot: string;
}) {
  const { account, keySlot } = opts;
  const call: ToolCaller = (tool, args) => mcp(tool, args, keySlot);
  const { wb, filename, ...stats } = await buildAnalysisReportWorkbook({
    call,
    accountId: account?.id,
    workspaceId: account?.workspace_id,
    accountName: account?.name,
  });
  XLSX.writeFile(wb, filename);
  return { filename, ...stats };
}
