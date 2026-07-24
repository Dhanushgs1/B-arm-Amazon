import * as XLSX from "xlsx-js-style";
import { mcp } from "@/lib/api";
import { resolveProductName } from "@/lib/categoryMap";

// ── Analysis Report (Ad Performance) ────────────────────────────────────────
// Recreates the per-product "Analysis report" sheet from the seller's manual
// Amazon-ads workbook, but sourced LIVE from the SellerMate API and rebuilt for
// two fixed trailing windows: Last 30 days and Last 7 days (both ending today,
// matching the dashboard's own "Last 30 Days" convention in DashboardContext).
//
// The seller's original sheet was a per-SKU pivot of raw Amazon report exports
// (SP advertised report + orders report + FBA/returns). The live API is
// per-ASIN and ad-only, so this report is per-ASIN (with SKU(s) shown as a
// column) — format-faithful, not a byte-identical clone. The CPC / ACOS / TACOS
// formulas are reproduced exactly as the original sheet computed them:
//   Spend+Tax = ad spend × 1.18            (18% GST)
//   Final     = Orders − Returns
//   CPC       = Spend+Tax ÷ Advertised SKU Units   (÷1 when units = 0)
//   ACOS      = Spend+Tax ÷ (Price × Total Units)   (÷1 when units = 0)
//   TACOS     = Spend+Tax ÷ (Price × Final)         (÷1 when final = 0)

const GST_MULTIPLIER = 1.18;

// Amazon India fulfillment-centre (FC) code → state/region. Mirrors the mapping
// the seller's own "Inventory ledger" sheet used (its Location→Area IFS formula),
// extended to cover the common IN FCs. Used to reproduce the FBA-status columns
// (Available / Number of FBA Not Available / All FBA) from get_inventory's
// per-location breakdown. Unknown codes fall back to the raw code so nothing is
// silently dropped.
const FC_STATE_MAP: Record<string, string> = {
  BLR4: "KARNATAKA", BLR7: "KARNATAKA", BLR8: "KARNATAKA",
  BOM5: "MAHARASHTRA", BOM7: "MAHARASHTRA", ISK3: "MAHARASHTRA", NAX1: "MAHARASHTRA", PNQ3: "MAHARASHTRA", PNQ2: "MAHARASHTRA",
  CCX1: "WEST BENGAL", CCX2: "WEST BENGAL",
  CJB1: "TAMIL NADU", MAA4: "TAMIL NADU", MAA1: "TAMIL NADU",
  DED3: "DELHI", DED4: "DELHI", DED5: "DELHI", DEL2: "DELHI", DEL8: "DELHI",
  DEL4: "HARYANA", DEL5: "HARYANA",
  HYD3: "TELANGANA", HYD8: "TELANGANA", HYD2: "TELANGANA",
  LKO1: "LUCKNOW",
  JPX1: "RAJASTHAN", JPX2: "RAJASTHAN",
  GAX1: "ASSAM",
  ATX1: "PUNJAB", LDX1: "PUNJAB",
  BBX1: "ODISHA",
  AMD2: "GUJARAT", AMD3: "GUJARAT", SAMD: "GUJARAT",
  PAX1: "BIHAR",
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

// Same courier-RTO filter used across the dashboard (see amazonSalesExport.ts):
// an UNDELIVERABLE "return" never reached the customer, so it isn't a genuine
// product return and is excluded from the Returns count.
function isGenuineReturn(r: any) {
  return !String(r.reason || "").toUpperCase().startsWith("UNDELIVERABLE");
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
  spendTax: number;   // ad spend × 1.18
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

// get_fba_customer_returns rejects start_date === end_date, but our windows are
// always ≥ 7 days so a straight paged fetch is fine here.
async function fetchAllReturns(call: ToolCaller, args: any) {
  const all: any[] = [];
  for (let page = 0; page < 20; page++) {
    const res = await call("get_fba_customer_returns", { ...args, page, page_size: 500 }).catch(() => null);
    const rows = res?.order_returns || [];
    all.push(...rows);
    if (!res?.pagination?.hasMore || rows.length === 0) break;
  }
  return all;
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
    w.spendTax += (r.spend || 0) * GST_MULTIPLIER;
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

  // Genuine customer returns per ASIN.
  const returnsByAsin = new Map<string, number>();
  returnRows.forEach((r: any) => {
    if (!r.asin || !isGenuineReturn(r)) return;
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

  // Fire every fetch concurrently — same fan-out style as the Full report.
  const [
    ad30, ad7, retail30, retail7, returns30, returns7, inventory, catalog,
  ] = await Promise.all([
    mcpAllPagesVia(call, "get_advertised_product_performance", args30),
    mcpAllPagesVia(call, "get_advertised_product_performance", args7),
    mcpAllPagesVia(call, "get_retail_product_performance", args30),
    mcpAllPagesVia(call, "get_retail_product_performance", args7),
    fetchAllReturns(call, args30),
    fetchAllReturns(call, args7),
    fetchInventoryByLocation(call, baseArgs).catch(() => []),
    fetchFullCatalog(call, baseArgs).catch(() => []),
  ]);

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

  aggregateWindow(products, ensure, (p) => p.w30, ad30, retail30, returns30);
  aggregateWindow(products, ensure, (p) => p.w7, ad7, retail7, returns7);

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
    const name = resolveProductName(p.name, prim) || p.name;
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
    ["Spend+Tax = ad spend x 1.18 (18% GST). Final = Orders - Returns."],
    ["CPC = Spend+Tax / Advertised SKU Units (falls back to Spend+Tax when units = 0)."],
    ["ACOS = CPC / Price = Spend+Tax / (Advertised SKU Units x Price)."],
    ["TACOS = Spend+Tax / (Price x Final)."],
    ["Advertised SKU Units = ad-attributed orders; Total Units = ad sales / price (estimate)."],
    ["Product name comes from the Master SKU sheet; Price shown as a whole number."],
    ["One row per ASIN (product) - matches the Weekly Sales Report. Ad + retail sales are only ever known per ASIN, never per SKU, so when a product has multiple SKUs only one (the primary: FBA listing preferred, then most stock, then price) is shown as the SKU ID / FBA-MFN / Price for that row."],
    ["FBA availability (Available / Grand Total / Number of FBA Not Available / All FBA) is summed across every SKU of the product, not just the primary one - stock levels are genuinely known per SKU, unlike sales."],
    ["Price and FBA/MFN come from the live product listing (All-Listings feed) - the listing price and its fulfillment channel (AMAZON_IN = FBA, DEFAULT = MFN) of the primary SKU."],
    ["Inbound-shipped-quantity shows '—': Amazon's inbound / in-transit quantity is not exposed by the SP-API inventory feed (only the ledger warehouse balance is synced)."],
    ["Returns exclude courier RTO / undeliverable (not genuine customer returns)."],
    ["The most recent 1-2 days can look low - that's Amazon's own reporting sync lag, not a real drop."],
  ]);
  wsNote["!cols"] = [{ wch: 110 }];
  wsNote["A1"].s = { font: { bold: true, sz: 13, color: { rgb: "312E81" } } };
  XLSX.utils.book_append_sheet(wb, wsNote, "Notes");

  const filename = `Analysis_Report_Ad_Performance_${start30}_to_${end}.xlsx`;
  return { wb, filename, productCount: emittedRows };
}

// Local copy of mcpAllPages that accepts an arbitrary ToolCaller (so this
// builder stays transport-agnostic, mirroring amazonSalesExport.ts).
async function mcpAllPagesVia(call: ToolCaller, tool: string, args: any, maxPages = 24) {
  const all: any[] = [];
  for (let page = 0; page < maxPages; page++) {
    const res = await call(tool, { ...args, page, page_size: 500 }).catch(() => null);
    const rows = res?.data || [];
    all.push(...rows);
    if (!res?.pagination?.hasMore || rows.length === 0) break;
  }
  return all;
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
