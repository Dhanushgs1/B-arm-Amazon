import * as XLSX from "xlsx-js-style";
import { supabasePublic } from "@/lib/amazonReportUpload";
import { fetchFullCatalog, fetchInventoryByLocation, fcToState, type ToolCaller } from "@/lib/analysisReportExport";
import { mcp } from "@/lib/api";

// ── Historical Analysis Report (Ad Performance) ─────────────────────────────
// Same Analysis-Report SHAPE as analysisReportExport.ts (Price, Spend+Tax,
// Units, Orders, Returns, CPC, ACOS, TACOS side by side for a 30-day window
// and a 7-day window), but sourced from the manually uploaded report tables
// (src/lib/amazonReportUpload.ts) instead of the live SellerMate API, for two
// reasons:
//
// 1. This report is genuinely per-SKU. The live API only exposes ad/retail
//    data per ASIN; the uploaded raw Amazon exports (SP advertised report,
//    Orders report, both returns reports) all carry the real SKU.
// 2. Sponsored Brands / Sponsored Display only export campaign-level spend
//    (no SKU column) — routed to a SKU via the seller-maintained Campaign ->
//    SKU map, so the lead column here is the CAMPAIGN name, not the product
//    name, matching how spend is actually attributed.
//
// Both windows always end on the same date (the report's `endDate`, default
// today): "Last 30 days" = that date and the 29 before it, "Last 7 days" =
// that date and the 6 before it — exactly the dashboard's own trailing-window
// convention (DashboardContext), just computed from uploaded data so it stays
// correct even when the live account's trailing window has since moved on.
//
// Price, FBA/MFN channel, and FBA inventory availability prefer the uploaded
// Price / FBA Inventory / Inventory Ledger reports (a snapshot, not itself
// windowed) — falling back independently per field to the live SellerMate
// catalog/inventory when a given file hasn't been uploaded.

const GST_MULTIPLIER = 1.18;

function dotDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

function nextDayIso(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function getDateWindow(toDate: string, days: number): { start: string; end: string } {
  const end = new Date(`${toDate}T00:00:00Z`);
  const start = new Date(end.getTime());
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

// Same courier-RTO exclusion the live report uses for FBA customer returns
// (an UNDELIVERABLE/refused parcel never reached the customer).
export function isGenuineFbaReturn(r: { reason?: string }): boolean {
  return !String(r.reason || "").toUpperCase().startsWith("UNDELIVERABLE");
}
// AM returns (Seller Central return-requests export) signals the same thing
// via "Return type" = "Undelivered" instead of a reason-code prefix.
export function isGenuineAmReturn(r: { return_type?: string }): boolean {
  return String(r.return_type || "").toLowerCase() !== "undelivered";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchAllRows(table: string, apply: (q: any) => any): Promise<any[]> {
  const all: unknown[] = [];
  const PAGE = 1000;
  let from = 0;
  for (let i = 0; i < 200; i++) {
    const { data, error } = await apply(supabasePublic.from(table).select("*")).range(from, from + PAGE - 1);
    if (error) throw new Error(`Fetch ${table} failed: ${error.message}`);
    const rows = data || [];
    all.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

const UNMAPPED = "__UNMAPPED__";
const UNMAPPED_LABEL = "⚠ Unmapped SB/SD campaigns — assign a SKU on the Upload page";

// ── Per-window numeric aggregate (recomputed once for the 30-day rows, once
// for the 7-day rows) ────────────────────────────────────────────────────────
interface WindowAgg {
  spendTax: number;
  advUnits: number;
  totalUnits: number;
  orderCount: number; // number of order records (NOT total quantity — see Total Units)
  returns: number;
}
function emptyWindowAgg(): WindowAgg {
  return { spendTax: 0, advUnits: 0, totalUnits: 0, orderCount: 0, returns: 0 };
}
function computeCpc(w: WindowAgg): number {
  return w.advUnits > 0 ? w.spendTax / w.advUnits : w.spendTax;
}
function computeAcos(w: WindowAgg, price: number): number {
  return price > 0 ? computeCpc(w) / price : 0;
}
function computeTacos(w: WindowAgg, price: number): number {
  const final = Math.max(0, w.orderCount - w.returns);
  const denom = price * (final || 1);
  return denom > 0 ? w.spendTax / denom : 0;
}

// ── Per-SKU identity + snapshot metadata (NOT windowed — price/FBA stock are
// a point-in-time snapshot, shared by both the 30-day and 7-day blocks) ─────
interface SkuMeta {
  sku: string;
  name: string;
  campaignName: string;
  price: number;
  channel: string;
  isFba: boolean;
  fbaTotal: number;
  fbmQty: number;
  stateBalances: Map<string, number>;
}
function emptyMeta(sku: string): SkuMeta {
  return { sku, name: sku, campaignName: "", price: 0, channel: "", isFba: false, fbaTotal: 0, fbmQty: 0, stateBalances: new Map() };
}

interface BuildOpts {
  call: ToolCaller;
  accountId: string | undefined;
  workspaceId: string | undefined;
  accountName: string | undefined;
  endDate: string; // 'YYYY-MM-DD' — both windows are trailing windows ending here
}

export async function buildHistoricalAnalysisReportWorkbook(opts: BuildOpts) {
  const { call, accountId, workspaceId, accountName, endDate } = opts;
  const baseArgs = { amazon_account_id: accountId, workspace_id: workspaceId };

  const win30 = getDateWindow(endDate, 30);
  const win7 = getDateWindow(endDate, 7);
  const endExclusive = nextDayIso(endDate);

  // Fetch every ad/order/return row ONCE for the 30-day window (a superset of
  // the 7-day window) — the 7-day block is then derived by filtering these
  // same rows in memory, avoiding a second round-trip to Supabase.
  const [
    spRows, sbRows, sdRows, orderRows, amReturnRows, fbaReturnRows, mapRows,
    priceListingRows, fbaInventoryRows, ledgerRows, ledgerRawRows, sfReturnRows,
  ] = await Promise.all([
    fetchAllRows("barm_amazon_sp_advertised_product", (q) => q.gte("report_date", win30.start).lte("report_date", endDate)),
    fetchAllRows("barm_amazon_sb_campaign", (q) => q.gte("report_date", win30.start).lte("report_date", endDate)),
    fetchAllRows("barm_amazon_sd_campaign", (q) => q.gte("report_date", win30.start).lte("report_date", endDate)),
    fetchAllRows("barm_amazon_am_orders", (q) => q.gte("purchase_date", win30.start).lte("purchase_date", endDate)),
    fetchAllRows("barm_amazon_am_returns", (q) => q.gte("return_request_date", win30.start).lte("return_request_date", endDate)),
    fetchAllRows("barm_amazon_fba_returns", (q) => q.gte("return_date", `${win30.start}T00:00:00Z`).lt("return_date", `${endExclusive}T00:00:00Z`)),
    fetchAllRows("barm_amazon_campaign_sku_map", (q) => q),
    fetchAllRows("barm_amazon_price_listing", (q) => q),
    fetchAllRows("barm_amazon_fba_inventory", (q) => q),
    // Ledger "as of" endDate — every SELLABLE row up to and including endDate;
    // the latest one per (SKU, location) is that location's true balance as
    // of the report period, not today.
    fetchAllRows("barm_amazon_inventory_ledger", (q) => q.lte("ledger_date", endDate).eq("disposition", "SELLABLE")),
    // Raw "Inventory ledger" sheet — every disposition, mirroring what was
    // actually uploaded for the 30-day window.
    fetchAllRows("barm_amazon_inventory_ledger", (q) => q.gte("ledger_date", win30.start).lte("ledger_date", endDate)),
    fetchAllRows("barm_amazon_sf_return", (q) => q.gte("pickup_date", win30.start).lte("pickup_date", endDate)),
  ]);

  const campaignSkuMap = new Map<string, string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mapRows.forEach((r: any) => campaignSkuMap.set(r.campaign_name, r.sku));

  // ── Snapshot metadata (price/channel/FBA availability) — shared by both windows ──
  const priceBySku = new Map<string, { price: number; channel: string; isFba: boolean; fbmQty: number }>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  priceListingRows.forEach((r: any) => {
    if (!r.seller_sku) return;
    const isFbaSku = typeof r.fulfillment_channel === "string" && r.fulfillment_channel.toUpperCase().startsWith("AMAZON");
    const cur = priceBySku.get(r.seller_sku) || { price: 0, channel: "", isFba: false, fbmQty: 0 };
    cur.isFba = isFbaSku;
    cur.channel = isFbaSku ? "AMAZON_IN" : "DEFAULT";
    if (r.price > 0) cur.price = r.price;
    if (!isFbaSku) cur.fbmQty += Number(r.quantity) || 0;
    priceBySku.set(r.seller_sku, cur);
  });
  const hasUploadedPrice = priceBySku.size > 0;

  const inboundShippedBySku = new Map<string, number>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fbaInventoryRows.forEach((r: any) => {
    if (!r.sku) return;
    inboundShippedBySku.set(r.sku, (inboundShippedBySku.get(r.sku) || 0) + (r.afn_inbound_shipped_quantity || 0));
  });
  const hasUploadedFbaInv = inboundShippedBySku.size > 0;

  const ledgerLatestByKey = new Map<string, { ledger_date: string; msku: string; location: string; ending_balance: number }>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ledgerRows.forEach((r: any) => {
    if (!r.msku) return;
    const key = `${r.msku}|${r.location}`;
    const cur = ledgerLatestByKey.get(key);
    if (!cur || r.ledger_date > cur.ledger_date) ledgerLatestByKey.set(key, r);
  });
  const ledgerBySku = new Map<string, { fbaTotal: number; stateBalances: Map<string, number> }>();
  const ledgerStates = new Set<string>();
  ledgerLatestByKey.forEach((r) => {
    const bal = r.ending_balance || 0;
    if (bal <= 0) return;
    let s = ledgerBySku.get(r.msku);
    if (!s) { s = { fbaTotal: 0, stateBalances: new Map() }; ledgerBySku.set(r.msku, s); }
    s.fbaTotal += bal;
    const state = fcToState(r.location);
    s.stateBalances.set(state, (s.stateBalances.get(state) || 0) + bal);
    ledgerStates.add(state);
  });
  const hasUploadedLedger = ledgerBySku.size > 0;

  const [catalog, inventory] = await Promise.all([
    hasUploadedPrice ? Promise.resolve([]) : fetchFullCatalog(call, baseArgs).catch(() => []),
    hasUploadedLedger ? Promise.resolve([]) : fetchInventoryByLocation(call, baseArgs).catch(() => []),
  ]);

  const metaMap = new Map<string, SkuMeta>();
  const ensureMeta = (sku: string): SkuMeta => {
    let m = metaMap.get(sku);
    if (!m) { m = emptyMeta(sku); metaMap.set(sku, m); }
    return m;
  };

  // Identity (campaign name / product name) — resolved from the full 30-day
  // rows so a SKU with only sparse recent activity still gets a name.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spRows.forEach((r: any) => {
    if (!r.advertised_sku) return;
    const m = ensureMeta(r.advertised_sku);
    if (r.campaign_name && !m.campaignName) m.campaignName = r.campaign_name;
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function applyCampaignIdentity(r: any) {
    const sku = campaignSkuMap.get(r.campaign_name) || UNMAPPED;
    const m = ensureMeta(sku);
    if (sku === UNMAPPED) {
      m.name = UNMAPPED_LABEL;
    } else if (!m.campaignName) {
      m.campaignName = r.campaign_name;
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sbRows.forEach((r: any) => applyCampaignIdentity(r));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sdRows.forEach((r: any) => applyCampaignIdentity(r));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  orderRows.forEach((r: any) => {
    if (!r.sku) return;
    const m = ensureMeta(r.sku);
    if (r.product_name && m.name === m.sku) m.name = r.product_name;
  });

  // Price / FBA-MFN channel — uploaded Price report when available, else live catalog.
  if (hasUploadedPrice) {
    priceBySku.forEach((info, sku) => {
      const m = ensureMeta(sku);
      m.isFba = info.isFba;
      m.channel = info.channel;
      if (info.price > 0) m.price = info.price;
      m.fbmQty += info.fbmQty;
    });
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    catalog.forEach((c: any) => {
      if (!c.sku) return;
      const m = ensureMeta(c.sku);
      if (c.itemName && m.name === m.sku) m.name = c.itemName;
      const isFbaSku = typeof c.fulfillmentChannel === "string" && c.fulfillmentChannel.toUpperCase().startsWith("AMAZON");
      m.isFba = isFbaSku;
      m.channel = isFbaSku ? "AMAZON_IN" : "DEFAULT";
      const price = Number(c.price) || 0;
      if (price > 0) m.price = price;
      if (!isFbaSku) m.fbmQty += Number(c.quantity) || 0;
    });
  }

  // FBA inventory availability — uploaded Inventory Ledger (as of endDate)
  // when available, else the live per-location breakdown.
  const accountStates = new Set<string>();
  if (hasUploadedLedger) {
    ledgerBySku.forEach((info, sku) => {
      const m = ensureMeta(sku);
      m.isFba = true;
      m.fbaTotal += info.fbaTotal;
      info.stateBalances.forEach((v, st) => m.stateBalances.set(st, (m.stateBalances.get(st) || 0) + v));
    });
    ledgerStates.forEach((st) => accountStates.add(st));
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inventory.forEach((i: any) => {
      for (const loc of i.fba?.byLocation || []) {
        const sku = loc.sku || i.sku;
        if (!sku) continue;
        const bal = loc.endingWarehouseBalance || 0;
        const m = ensureMeta(sku);
        m.isFba = true;
        if (bal <= 0) continue;
        m.fbaTotal += bal;
        const state = fcToState(loc.location);
        m.stateBalances.set(state, (m.stateBalances.get(state) || 0) + bal);
        accountStates.add(state);
      }
      if (!(i.fba?.byLocation?.length) && (i.fba?.endingWarehouseBalance || 0) > 0 && i.sku) {
        const m = ensureMeta(i.sku);
        m.isFba = true;
        m.fbaTotal += i.fba.endingWarehouseBalance;
      }
    });
  }

  // ── Per-window numeric aggregation — same function run twice: once over
  // the full 30-day rows, once over the 7-day-filtered subset. ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function aggregateWindow(rowsSp: any[], rowsSb: any[], rowsSd: any[], rowsOrders: any[], rowsAmReturns: any[], rowsFbaReturns: any[]): Map<string, WindowAgg> {
    const map = new Map<string, WindowAgg>();
    const ensure = (sku: string): WindowAgg => {
      let w = map.get(sku);
      if (!w) { w = emptyWindowAgg(); map.set(sku, w); }
      return w;
    };
    // SP: true SKU-level ad spend + ad-attributed units, straight from the CSV.
    rowsSp.forEach((r) => {
      if (!r.advertised_sku) return;
      const w = ensure(r.advertised_sku);
      w.spendTax += (r.spend || 0) * GST_MULTIPLIER;
      w.advUnits += r.advertised_sku_units_7d || r.advertised_sku_units || 0;
    });
    // SB/SD: campaign-level only — routed to a SKU via the campaign->SKU map;
    // unmapped campaigns land in an explicit bucket instead of being dropped.
    function applyCampaignAdRow(r: any, unitsField: string) {
      const sku = campaignSkuMap.get(r.campaign_name) || UNMAPPED;
      const w = ensure(sku);
      w.spendTax += (r.spend || 0) * GST_MULTIPLIER;
      w.advUnits += r[unitsField] || 0;
    }
    rowsSb.forEach((r) => applyCampaignAdRow(r, "units"));
    rowsSd.forEach((r) => applyCampaignAdRow(r, "units_14d"));
    // Orders: real total units + order count per SKU, from the Orders export.
    rowsOrders.forEach((r) => {
      if (!r.sku) return;
      const w = ensure(r.sku);
      w.orderCount += 1;
      w.totalUnits += r.quantity || 0;
    });
    // Returns: genuine customer returns only (courier RTO / undeliverable excluded).
    rowsAmReturns.forEach((r) => {
      if (!r.merchant_sku || !isGenuineAmReturn(r)) return;
      ensure(r.merchant_sku).returns += r.return_quantity || 0;
    });
    rowsFbaReturns.forEach((r) => {
      if (!r.sku || !isGenuineFbaReturn(r)) return;
      ensure(r.sku).returns += r.quantity || 0;
    });
    return map;
  }

  const winAMap = aggregateWindow(spRows, sbRows, sdRows, orderRows, amReturnRows, fbaReturnRows);

  // 7-day subset — filtered in memory from the same 30-day fetch (no second DB round-trip).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spRows7 = spRows.filter((r: any) => r.report_date >= win7.start);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sbRows7 = sbRows.filter((r: any) => r.report_date >= win7.start);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdRows7 = sdRows.filter((r: any) => r.report_date >= win7.start);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orderRows7 = orderRows.filter((r: any) => r.purchase_date >= win7.start);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const amReturnRows7 = amReturnRows.filter((r: any) => r.return_request_date >= win7.start);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fbaReturnRows7 = fbaReturnRows.filter((r: any) => r.return_date >= `${win7.start}T00:00:00Z`);

  const winBMap = aggregateWindow(spRows7, sbRows7, sdRows7, orderRows7, amReturnRows7, fbaReturnRows7);

  // ── Combine: one row per SKU with any activity in the 30-day window, or
  // any current stock on hand — sorted by 30-day ad spend (biggest first). ──
  const activeSkus = new Set<string>();
  winAMap.forEach((w, sku) => { if (w.spendTax || w.orderCount || w.returns) activeSkus.add(sku); });
  metaMap.forEach((m, sku) => { if (m.fbaTotal > 0 || m.fbmQty > 0) activeSkus.add(sku); });

  interface Row { sku: string; meta: SkuMeta; wA: WindowAgg; wB: WindowAgg; }
  const rows: Row[] = [...activeSkus].map((sku) => ({
    sku,
    meta: metaMap.get(sku) || emptyMeta(sku),
    wA: winAMap.get(sku) || emptyWindowAgg(),
    wB: winBMap.get(sku) || emptyWindowAgg(),
  }));
  rows.sort((a, b) => (b.wA.spendTax - a.wA.spendTax) || (b.wA.orderCount - a.wA.orderCount));

  const buildAvailCells = (m: SkuMeta): (string | number)[] => {
    if (!m.isFba && m.fbaTotal <= 0) return ["0", "", "", "", ""];
    const withStock = [...m.stateBalances.entries()].filter(([, v]) => v > 0).map(([st]) => st).sort();
    const available = withStock.length ? withStock.join(", ") : "0";
    const notAvailable = Math.max(0, accountStates.size - withStock.length);
    const inbound = hasUploadedFbaInv ? (inboundShippedBySku.get(m.sku) || 0) : "—";
    return [available, m.fbaTotal, inbound, notAvailable, notAvailable > 0 ? "No" : "Yes"];
  };

  const displayName = (m: SkuMeta): string => (m.name === UNMAPPED_LABEL ? UNMAPPED_LABEL : (m.campaignName || m.name));

  const colLetter = (c: number) => XLSX.utils.encode_col(c);
  const acosColor = (v: number) => (v < 0.25 ? "92D050" : v > 0.4 ? "FF0000" : "FFCC00");

  // ═══════════════════════════════════════════════════════════════════════
  // ── Analysis report sheet — dual block: Last 30 days | Last 7 days ──────
  // Mirrors analysisReportExport.ts's exact layout/colors/formulas (the live
  // report), just sourced from the uploaded historical data and keyed by
  // Campaign Name instead of Product (SB/SD spend is genuinely per-campaign).
  // ═══════════════════════════════════════════════════════════════════════
  const WIN_COLS = ["Spend+Tax", "Advertised SKU Units (#)", "Total Units (#)", "Orders", "Returns", "Final", "CPC", "ACOS", "TACOS"];
  const AVAIL_COLS = ["Available", "Grand Total", "Inbound-shipped-quantity", "Number of FBA Not Available", "All FBA"];
  const LEAD_COLS = ["Campaign Name", "SKU ID", "FBA/MFN", "Price"];

  const label30 = `Last 30 days (${dotDate(win30.start)} to ${dotDate(win30.end)})`;
  const label7 = `Last 7 days (${dotDate(win7.start)} to ${dotDate(win7.end)})`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const header0: any[] = [...LEAD_COLS];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const header1: any[] = [...LEAD_COLS];
  header0.push(label30, ...Array(WIN_COLS.length - 1).fill(""));
  header1.push(...WIN_COLS);
  header0.push(label7, ...Array(WIN_COLS.length - 1).fill(""));
  header1.push(...WIN_COLS);
  header0.push("FBA Availability (current)", ...Array(AVAIL_COLS.length - 1).fill(""));
  header1.push(...AVAIL_COLS);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aoa: any[][] = [header0, header1];

  const buildWinCells = (w: WindowAgg, price: number) => {
    const final = w.orderCount - w.returns; // unclamped — matches the Final Excel formula below
    return [w.spendTax, w.advUnits, w.totalUnits, w.orderCount, w.returns, final, computeCpc(w), computeAcos(w, price), computeTacos(w, price)];
  };

  rows.forEach((row) => {
    const price = Math.round(row.meta.price);
    aoa.push([
      displayName(row.meta), row.sku === UNMAPPED ? "—" : row.sku, row.meta.channel, price,
      ...buildWinCells(row.wA, row.meta.price),
      ...buildWinCells(row.wB, row.meta.price),
      ...buildAvailCells(row.meta),
    ]);
  });

  // Grand-total row: additive columns summed; CPC/ACOS/TACOS recomputed from
  // aggregated numerators/denominators (not an average of ratios).
  const totalRowCells = (getW: (r: Row) => WindowAgg) => {
    let spendTax = 0, advUnits = 0, totalUnits = 0, orderCount = 0, returns = 0, acosDenom = 0, tacosDenom = 0;
    rows.forEach((row) => {
      const w = getW(row);
      spendTax += w.spendTax; advUnits += w.advUnits; totalUnits += w.totalUnits;
      orderCount += w.orderCount; returns += w.returns;
      acosDenom += row.meta.price * w.advUnits;
      tacosDenom += row.meta.price * Math.max(0, w.orderCount - w.returns);
    });
    const final = Math.max(0, orderCount - returns);
    return [
      spendTax, advUnits, totalUnits, orderCount, returns, final,
      advUnits > 0 ? spendTax / advUnits : spendTax,
      acosDenom > 0 ? spendTax / acosDenom : 0,
      tacosDenom > 0 ? spendTax / tacosDenom : 0,
    ];
  };
  const gFbaTotal = rows.reduce((sum, r) => sum + r.meta.fbaTotal, 0);
  const grandRowIdx = aoa.length;
  aoa.push([
    "GRAND TOTAL", "", "", "",
    ...totalRowCells((r) => r.wA),
    ...totalRowCells((r) => r.wB),
    "", gFbaTotal, "", "", "",
  ]);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const totalCols = header1.length;
  const b30 = LEAD_COLS.length;
  const b7 = b30 + WIN_COLS.length;
  const bAvail = b7 + WIN_COLS.length;

  const priceCol = colLetter(3);
  for (const blockStart of [b30, b7]) {
    const spendTaxCol = colLetter(blockStart);
    const advUnitsCol = colLetter(blockStart + 1);
    const ordersCol = colLetter(blockStart + 3);
    const returnsCol = colLetter(blockStart + 4);
    const finalCol = colLetter(blockStart + 5);
    const cpcCol = colLetter(blockStart + 6);
    const acosCol = colLetter(blockStart + 7);
    for (let r = 2; r < grandRowIdx; r++) {
      const excelRow = r + 1;
      const finalAddr = `${finalCol}${excelRow}`;
      const cpcAddr = `${cpcCol}${excelRow}`;
      const acosAddr = `${acosCol}${excelRow}`;
      if (ws[finalAddr]) ws[finalAddr].f = `${ordersCol}${excelRow}-${returnsCol}${excelRow}`;
      if (ws[cpcAddr]) ws[cpcAddr].f = `IF(${advUnitsCol}${excelRow}=0,${spendTaxCol}${excelRow},${spendTaxCol}${excelRow}/${advUnitsCol}${excelRow})`;
      if (ws[acosAddr]) ws[acosAddr].f = `${cpcCol}${excelRow}/${priceCol}${excelRow}`;
    }
  }

  // Merges: lead cols span both header rows; each block spans its columns in row 0.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const merges: any[] = LEAD_COLS.map((_, c) => ({ s: { r: 0, c }, e: { r: 1, c } }));
  merges.push({ s: { r: 0, c: b30 }, e: { r: 0, c: b30 + WIN_COLS.length - 1 } });
  merges.push({ s: { r: 0, c: b7 }, e: { r: 0, c: b7 + WIN_COLS.length - 1 } });
  merges.push({ s: { r: 0, c: bAvail }, e: { r: 0, c: bAvail + AVAIL_COLS.length - 1 } });
  ws["!merges"] = merges;

  // Header styling — indigo group/column rows; 7-day block gets a distinct
  // accent hue so the two windows read apart at a glance; green for availability.
  for (let r = 0; r <= 1; r++) {
    for (let c = 0; c < totalCols; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (!ws[addr]) ws[addr] = { t: "s", v: "" };
      let fill = r === 0 ? "312E81" : "4F46E5";
      if (c >= b7 && c < bAvail) fill = r === 0 ? "3730A3" : "6366F1";
      if (c >= bAvail) fill = r === 0 ? "065F46" : "059669";
      ws[addr].s = {
        font: { bold: true, color: { rgb: "FFFFFF" }, sz: r === 0 ? 11 : 10 },
        fill: { fgColor: { rgb: fill } },
        alignment: { horizontal: "center", vertical: "center", wrapText: true },
        border: { bottom: { style: "medium", color: { rgb: "1E1B4B" } } },
      };
    }
  }

  for (let r = 2; r < aoa.length; r++) {
    const isGrand = r === grandRowIdx;
    for (let c = 0; c < totalCols; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (!cell) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const style: any = {
        font: { color: { rgb: "1F2937" }, bold: isGrand },
        alignment: { vertical: "center", horizontal: c === 0 ? "left" : "center" },
        border: {
          bottom: { style: isGrand ? "medium" : "thin", color: { rgb: isGrand ? "312E81" : "E5E7EB" } },
          ...(isGrand ? { top: { style: "medium", color: { rgb: "312E81" } } } : {}),
        },
      };
      const isPriceCol = c === 3;
      let posInWin = -1;
      if (c >= b30 && c < b7) posInWin = c - b30;
      else if (c >= b7 && c < bAvail) posInWin = c - b7;

      if (isPriceCol) {
        style.numFmt = "#,##0";
      } else if (posInWin >= 0) {
        if (posInWin === 0 || posInWin === 6) style.numFmt = "#,##0.00";
        else if (posInWin >= 1 && posInWin <= 5) style.numFmt = "#,##0";
        else if (posInWin === 7 || posInWin === 8) {
          style.numFmt = "0.00%";
          if (typeof cell.v === "number" && cell.v > 0) {
            style.fill = { fgColor: { rgb: acosColor(cell.v) } };
            style.font = { color: { rgb: cell.v > 0.4 ? "FFFFFF" : "000000" }, bold: true };
          }
        }
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

  const cols = [{ wch: 46 }, { wch: 20 }, { wch: 11 }, { wch: 10 }];
  for (let i = 0; i < 2; i++) {
    cols.push({ wch: 11 }, { wch: 13 }, { wch: 11 }, { wch: 9 }, { wch: 9 }, { wch: 8 }, { wch: 10 }, { wch: 9 }, { wch: 9 });
  }
  cols.push({ wch: 46 }, { wch: 11 }, { wch: 22 }, { wch: 24 }, { wch: 8 });
  ws["!cols"] = cols;
  ws["!rows"] = [{ hpt: 22 }, { hpt: 40 }];
  ws["!views"] = [{ state: "frozen", xSplit: 4, ySplit: 2 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Analysis report");

  // ═══════════════════════════════════════════════════════════════════════
  // ── TACOS sheet — dual block, matching the seller's original pivot: CPC
  // here = Spend+Tax ÷ Final orders (cost per net order), a DIFFERENT metric
  // than the Analysis report's CPC (÷ Advertised Units). TACOS = CPC ÷ Price
  // as a live formula (unlike the Analysis report, where it's a computed value).
  // ═══════════════════════════════════════════════════════════════════════
  const tacosRows = rows.filter((r) => r.sku !== UNMAPPED);
  const TACOS_WIN_COLS = ["Spend+Tax", "Orders", "Returns", "Final orders", "CPC", "TACOS"];
  const tHeader0: (string)[] = ["SKU ID", "Price", label30, "", "", "", "", "", label7, "", "", "", "", ""];
  const tHeader1: (string)[] = ["SKU ID", "Price", ...TACOS_WIN_COLS, ...TACOS_WIN_COLS];
  const tacosAoa: (string | number)[][] = [tHeader0, tHeader1];
  const tacosWinCells = (w: WindowAgg, price: number) => {
    const final = w.orderCount - w.returns;
    const cpc = final === 0 ? w.spendTax : w.spendTax / final;
    const tacos = price > 0 ? cpc / price : 0;
    return [w.spendTax, w.orderCount, w.returns, final, cpc, tacos];
  };
  tacosRows.forEach((row) => {
    tacosAoa.push([
      row.sku, Math.round(row.meta.price),
      ...tacosWinCells(row.wA, row.meta.price),
      ...tacosWinCells(row.wB, row.meta.price),
    ]);
  });
  const wsTacos = XLSX.utils.aoa_to_sheet(tacosAoa);
  const tB30 = 2, tB7 = 2 + TACOS_WIN_COLS.length;
  for (const blockStart of [tB30, tB7]) {
    const spendCol = colLetter(blockStart);
    const ordersCol = colLetter(blockStart + 1);
    const returnsCol = colLetter(blockStart + 2);
    const finalCol = colLetter(blockStart + 3);
    const cpcCol = colLetter(blockStart + 4);
    const tacosCol = colLetter(blockStart + 5);
    for (let i = 0; i < tacosRows.length; i++) {
      const r = i + 3; // 2 header rows
      wsTacos[`${finalCol}${r}`].f = `${ordersCol}${r}-${returnsCol}${r}`;
      wsTacos[`${cpcCol}${r}`].f = `IF(${finalCol}${r}=0,${spendCol}${r},${spendCol}${r}/${finalCol}${r})`;
      wsTacos[`${tacosCol}${r}`].f = `${cpcCol}${r}/B${r}`;
    }
  }
  wsTacos["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 1, c: 0 } },
    { s: { r: 0, c: 1 }, e: { r: 1, c: 1 } },
    { s: { r: 0, c: tB30 }, e: { r: 0, c: tB30 + TACOS_WIN_COLS.length - 1 } },
    { s: { r: 0, c: tB7 }, e: { r: 0, c: tB7 + TACOS_WIN_COLS.length - 1 } },
  ];
  for (let r = 0; r <= 1; r++) {
    for (let c = 0; c < tHeader1.length; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (!wsTacos[addr]) wsTacos[addr] = { t: "s", v: "" };
      const fill = c >= tB7 ? (r === 0 ? "3730A3" : "6366F1") : (r === 0 ? "312E81" : "4F46E5");
      wsTacos[addr].s = {
        font: { bold: true, color: { rgb: "FFFFFF" }, sz: r === 0 ? 11 : 10 },
        fill: { fgColor: { rgb: fill } },
        alignment: { horizontal: "center", vertical: "center", wrapText: true },
      };
    }
  }
  for (let r = 2; r < tacosAoa.length; r++) {
    for (let c = 0; c < tHeader1.length; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = wsTacos[addr];
      if (!cell) continue;
      const posInBlock = c >= tB7 ? c - tB7 : c >= tB30 ? c - tB30 : -1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const style: any = { alignment: { horizontal: c < 2 ? "left" : "center", vertical: "center" } };
      if (posInBlock === 5 && typeof cell.v === "number") {
        style.numFmt = "0.00%";
        if (cell.v > 0) { style.fill = { fgColor: { rgb: acosColor(cell.v) } }; style.font = { bold: true, color: { rgb: cell.v > 0.4 ? "FFFFFF" : "000000" } }; }
      } else if (posInBlock === 0 || posInBlock === 4) {
        style.numFmt = "#,##0.00";
      } else if (posInBlock >= 1 && posInBlock <= 3) {
        style.numFmt = "#,##0";
        if (posInBlock === 3 && typeof cell.v === "number" && cell.v < 0) style.font = { color: { rgb: "B91C1C" }, bold: true };
      }
      cell.s = style;
    }
  }
  wsTacos["!cols"] = [{ wch: 20 }, { wch: 10 }, { wch: 12 }, { wch: 9 }, { wch: 9 }, { wch: 12 }, { wch: 10 }, { wch: 9 }, { wch: 12 }, { wch: 9 }, { wch: 9 }, { wch: 12 }, { wch: 10 }, { wch: 9 }];
  wsTacos["!views"] = [{ state: "frozen", xSplit: 2, ySplit: 2 }];
  XLSX.utils.book_append_sheet(wb, wsTacos, "TACOS");

  // ── FBA status sheet ── one row per FBA SKU: stock-on-hand pivoted by
  // state (a current snapshot, not time-windowed), plus the Available /
  // Number-of-FBA-Not-Available / All-FBA formulas.
  const fbaRows = rows.filter((r) => r.sku !== UNMAPPED && (r.meta.isFba || r.meta.fbaTotal > 0));
  const stateList = [...accountStates].sort();
  const fbaHeader = ["SKU ID", ...stateList, "Available", "Grand Total", "Inbound-shipped-quantity", "Number of FBA Not Available", "All FBA"];
  const fbaAoa: (string | number)[][] = [fbaHeader];
  fbaRows.forEach((row) => {
    const stateVals = stateList.map((st) => row.meta.stateBalances.get(st) || 0);
    const inbound = hasUploadedFbaInv ? (inboundShippedBySku.get(row.sku) || 0) : "—";
    fbaAoa.push([row.sku, ...stateVals, "", row.meta.fbaTotal, inbound, "", ""]);
  });
  const wsFba = XLSX.utils.aoa_to_sheet(fbaAoa);
  if (stateList.length > 0) {
    const stateColStart = colLetter(1);
    const stateColEnd = colLetter(stateList.length);
    const availCol = colLetter(1 + stateList.length);
    const notAvailCol = colLetter(1 + stateList.length + 2);
    const allFbaCol = colLetter(1 + stateList.length + 3);
    for (let i = 0; i < fbaRows.length; i++) {
      const r = i + 2;
      const ifParts = stateList
        .map((_, si) => {
          const letter = colLetter(1 + si);
          return `IF(${letter}${r}>0,$${letter}$1&", ","")`;
        })
        .join("&");
      wsFba[`${availCol}${r}`] = { t: "s", f: `TRIM(SUBSTITUTE(${ifParts},", "," ",LEN(${ifParts})-LEN(SUBSTITUTE(${ifParts},",",""))))` };
      wsFba[`${notAvailCol}${r}`] = { t: "n", f: `COUNTIF(${stateColStart}${r}:${stateColEnd}${r},0)` };
      wsFba[`${allFbaCol}${r}`] = { t: "s", f: `IF(${notAvailCol}${r}>0,"No","Yes")` };
    }
  }
  for (let c = 0; c < fbaHeader.length; c++) {
    const addr = `${colLetter(c)}1`;
    if (!wsFba[addr]) wsFba[addr] = { t: "s", v: "" };
    wsFba[addr].s = {
      font: { bold: true, color: { rgb: "FFFFFF" } },
      fill: { fgColor: { rgb: "059669" } },
      alignment: { horizontal: "center", vertical: "center", wrapText: true },
    };
  }
  wsFba["!cols"] = [{ wch: 20 }, ...stateList.map(() => ({ wch: 12 })), { wch: 46 }, { wch: 11 }, { wch: 22 }, { wch: 24 }, { wch: 8 }];
  XLSX.utils.book_append_sheet(wb, wsFba, "FBA status");

  // ═══════════════════════════════════════════════════════════════════════
  // ── Orders / Returns / Adspend leaderboards sheet — 4 independent top-N
  // lists (Orders by SKU, Returns by SKU, Adspend by campaign, Adspend by
  // SKU), each now split into its own 30-day / 7-day pair, matching the
  // dashboard's trailing-window convention used everywhere else in this
  // workbook. Each column-group is sorted on its own — a given row is NOT a
  // joined record.
  // ═══════════════════════════════════════════════════════════════════════
  const topOrders = (map: Map<string, WindowAgg>) =>
    [...map.entries()].filter(([sku, w]) => sku !== UNMAPPED && w.orderCount > 0).map(([sku, w]): [string, number] => [sku, w.orderCount]).sort((a, b) => b[1] - a[1]);
  const topReturns = (map: Map<string, WindowAgg>) =>
    [...map.entries()].filter(([sku, w]) => sku !== UNMAPPED && w.returns > 0).map(([sku, w]): [string, number] => [sku, w.returns]).sort((a, b) => b[1] - a[1]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function campaignSpendMap(rowsSp: any[], rowsSb: any[], rowsSd: any[]): Map<string, { spend: number; sku: string }> {
    const map = new Map<string, { spend: number; sku: string }>();
    const add = (campaignName: string | undefined, sku: string | undefined, spend: number | undefined) => {
      if (!campaignName) return;
      const cur = map.get(campaignName) || { spend: 0, sku: sku || "" };
      cur.spend += spend || 0;
      if (!cur.sku && sku) cur.sku = sku;
      map.set(campaignName, cur);
    };
    rowsSp.forEach((r) => add(r.campaign_name, r.advertised_sku, r.spend));
    rowsSb.forEach((r) => add(r.campaign_name, campaignSkuMap.get(r.campaign_name), r.spend));
    rowsSd.forEach((r) => add(r.campaign_name, campaignSkuMap.get(r.campaign_name), r.spend));
    return map;
  }
  const topAdspendByCampaign = (map: Map<string, { spend: number; sku: string }>) =>
    [...map.entries()].filter(([, v]) => v.spend > 0).map((e): [string, number] => [`${e[0]}*${e[1].sku}`, e[1].spend]).sort((a, b) => b[1] - a[1]);
  const topAdspendBySku = (map: Map<string, WindowAgg>) =>
    [...map.entries()].filter(([sku, w]) => sku !== UNMAPPED && w.spendTax > 0).map((e): [string, number, number] => [e[0], e[1].spendTax / GST_MULTIPLIER, e[1].advUnits]).sort((a, b) => b[1] - a[1]);

  const lbOrders30 = topOrders(winAMap), lbOrders7 = topOrders(winBMap);
  const lbReturns30 = topReturns(winAMap), lbReturns7 = topReturns(winBMap);
  const campSpend30 = campaignSpendMap(spRows, sbRows, sdRows);
  const campSpend7 = campaignSpendMap(spRows7, sbRows7, sdRows7);
  const lbAdCamp30 = topAdspendByCampaign(campSpend30), lbAdCamp7 = topAdspendByCampaign(campSpend7);
  const lbAdSku30 = topAdspendBySku(winAMap), lbAdSku7 = topAdspendBySku(winBMap);

  const lbRowCount = Math.max(
    lbOrders30.length, lbOrders7.length, lbReturns30.length, lbReturns7.length,
    lbAdCamp30.length, lbAdCamp7.length, lbAdSku30.length, lbAdSku7.length,
  );

  // Column layout: Orders(4) | Returns(4) | Adspend-by-Campaign(6) | Adspend-by-SKU(8) = 22 cols
  const lbHeader0 = [
    "Orders", "", "", "",
    "Returns", "", "", "",
    "Adspend (by Campaign)", "", "", "", "", "",
    "Adspend (by SKU)", "", "", "", "", "", "", "",
  ];
  const lbHeader1 = [
    "Last 30 days", "", "Last 7 days", "",
    "Last 30 days", "", "Last 7 days", "",
    "Last 30 days", "", "", "Last 7 days", "", "",
    "Last 30 days", "", "", "", "Last 7 days", "", "", "",
  ];
  const lbHeader2 = [
    "SKU", "Orders", "SKU", "Orders",
    "SKU", "Returns", "SKU", "Returns",
    "Campaign*SKU", "Spend", "Spend+Tax", "Campaign*SKU", "Spend", "Spend+Tax",
    "SKU", "Spend", "Spend+Tax", "Adv. Units", "SKU", "Spend", "Spend+Tax", "Adv. Units",
  ];
  const lbAoa: (string | number)[][] = [lbHeader0, lbHeader1, lbHeader2];
  for (let i = 0; i < lbRowCount; i++) {
    lbAoa.push([
      lbOrders30[i]?.[0] ?? "", lbOrders30[i]?.[1] ?? "", lbOrders7[i]?.[0] ?? "", lbOrders7[i]?.[1] ?? "",
      lbReturns30[i]?.[0] ?? "", lbReturns30[i]?.[1] ?? "", lbReturns7[i]?.[0] ?? "", lbReturns7[i]?.[1] ?? "",
      lbAdCamp30[i]?.[0] ?? "", lbAdCamp30[i]?.[1] ?? "", "", lbAdCamp7[i]?.[0] ?? "", lbAdCamp7[i]?.[1] ?? "", "",
      lbAdSku30[i]?.[0] ?? "", lbAdSku30[i]?.[1] ?? "", "", lbAdSku30[i]?.[2] ?? "",
      lbAdSku7[i]?.[0] ?? "", lbAdSku7[i]?.[1] ?? "", "", lbAdSku7[i]?.[2] ?? "",
    ]);
  }
  const wsLb = XLSX.utils.aoa_to_sheet(lbAoa);
  for (let i = 0; i < lbRowCount; i++) {
    const r = i + 4; // 3 header rows
    if (lbAdCamp30[i]) wsLb[`K${r}`] = { t: "n", f: `J${r}*1.18` };
    if (lbAdCamp7[i]) wsLb[`N${r}`] = { t: "n", f: `M${r}*1.18` };
    if (lbAdSku30[i]) wsLb[`Q${r}`] = { t: "n", f: `P${r}*1.18` };
    if (lbAdSku7[i]) wsLb[`U${r}`] = { t: "n", f: `T${r}*1.18` };
  }
  wsLb["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }, { s: { r: 0, c: 4 }, e: { r: 0, c: 7 } },
    { s: { r: 0, c: 8 }, e: { r: 0, c: 13 } }, { s: { r: 0, c: 14 }, e: { r: 0, c: 21 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 1 } }, { s: { r: 1, c: 2 }, e: { r: 1, c: 3 } },
    { s: { r: 1, c: 4 }, e: { r: 1, c: 5 } }, { s: { r: 1, c: 6 }, e: { r: 1, c: 7 } },
    { s: { r: 1, c: 8 }, e: { r: 1, c: 10 } }, { s: { r: 1, c: 11 }, e: { r: 1, c: 13 } },
    { s: { r: 1, c: 14 }, e: { r: 1, c: 17 } }, { s: { r: 1, c: 18 }, e: { r: 1, c: 21 } },
  ];
  for (let r = 0; r <= 2; r++) {
    for (let c = 0; c < lbHeader2.length; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (!wsLb[addr]) wsLb[addr] = { t: "s", v: "" };
      const in7Day = (c >= 2 && c < 4) || (c >= 6 && c < 8) || (c >= 11 && c < 14) || c >= 18;
      const fill = r === 0 ? "312E81" : in7Day ? "6366F1" : "4F46E5";
      wsLb[addr].s = {
        font: { bold: true, color: { rgb: "FFFFFF" }, sz: r === 0 ? 11 : 10 },
        fill: { fgColor: { rgb: fill } },
        alignment: { horizontal: "center", vertical: "center", wrapText: true },
      };
    }
  }
  wsLb["!cols"] = [
    { wch: 20 }, { wch: 9 }, { wch: 20 }, { wch: 9 },
    { wch: 20 }, { wch: 9 }, { wch: 20 }, { wch: 9 },
    { wch: 44 }, { wch: 11 }, { wch: 11 }, { wch: 44 }, { wch: 11 }, { wch: 11 },
    { wch: 20 }, { wch: 11 }, { wch: 11 }, { wch: 11 }, { wch: 20 }, { wch: 11 }, { wch: 11 }, { wch: 11 },
  ];
  wsLb["!views"] = [{ state: "frozen", ySplit: 3 }];
  XLSX.utils.book_append_sheet(wb, wsLb, "Orders, returns, adspend");

  // ── Raw sheets (mirror the uploaded transactional files, full 30-day window) ──
  interface LightCol { key: string; label: string; percent?: boolean; numeric?: boolean; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function buildLightSheet(dataRows: any[], columns: LightCol[]) {
    const lightAoa: unknown[][] = [columns.map((c) => c.label)];
    dataRows.forEach((row) => {
      lightAoa.push(columns.map((c) => {
        const v = row[c.key] ?? "";
        if (c.numeric && v !== "") {
          const n = Number(v);
          if (Number.isFinite(n)) return n;
        }
        return v;
      }));
    });
    const lws = XLSX.utils.aoa_to_sheet(lightAoa);
    for (let c = 0; c < columns.length; c++) {
      const addr = XLSX.utils.encode_cell({ r: 0, c });
      if (!lws[addr]) continue;
      lws[addr].s = {
        font: { bold: true, color: { rgb: "FFFFFF" } },
        fill: { fgColor: { rgb: "4F46E5" } },
        alignment: { horizontal: "center", vertical: "center" },
      };
    }
    if (columns.some((c) => c.percent)) {
      const percentCols = new Set(columns.map((c, i) => (c.percent ? i : -1)).filter((i) => i >= 0));
      for (let r = 1; r < lightAoa.length; r++) {
        percentCols.forEach((c) => {
          const addr = XLSX.utils.encode_cell({ r, c });
          if (lws[addr] && typeof lws[addr].v === "number") lws[addr].s = { numFmt: "0.00%" };
        });
      }
    }
    lws["!cols"] = columns.map((c) => ({ wch: Math.max(12, c.label.length + 4) }));
    return lws;
  }

  const ORDER_COLS: LightCol[] = [
    { key: "purchase_date", label: "Purchase Date" }, { key: "amazon_order_id", label: "Order ID" },
    { key: "order_status", label: "Status" }, { key: "fulfillment_channel", label: "Fulfillment" },
    { key: "sku", label: "SKU" }, { key: "asin", label: "ASIN" }, { key: "product_name", label: "Product" },
    { key: "quantity", label: "Qty" }, { key: "item_price", label: "Item Price" }, { key: "item_tax", label: "Item Tax" },
    { key: "shipping_price", label: "Shipping" }, { key: "ship_city", label: "City" }, { key: "ship_state", label: "State" },
  ];
  XLSX.utils.book_append_sheet(wb, buildLightSheet(orderRows, ORDER_COLS), "Orders");

  const AM_RETURN_COLS: LightCol[] = [
    { key: "return_request_date", label: "Return Request Date" }, { key: "order_date", label: "Order Date" },
    { key: "order_id", label: "Order ID" }, { key: "asin", label: "ASIN" }, { key: "merchant_sku", label: "SKU" },
    { key: "item_name", label: "Item Name" }, { key: "return_quantity", label: "Qty" }, { key: "return_reason", label: "Reason" },
    { key: "return_type", label: "Return Type" }, { key: "resolution", label: "Resolution" }, { key: "order_amount", label: "Order Amount" },
  ];
  XLSX.utils.book_append_sheet(wb, buildLightSheet(amReturnRows, AM_RETURN_COLS), "AM returns");

  const FBA_RETURN_COLS: LightCol[] = [
    { key: "return_date", label: "Return Date" }, { key: "order_id", label: "Order ID" }, { key: "sku", label: "SKU" },
    { key: "asin", label: "ASIN" }, { key: "product_name", label: "Product" }, { key: "quantity", label: "Qty" },
    { key: "fulfillment_center_id", label: "FC" }, { key: "detailed_disposition", label: "Disposition" }, { key: "reason", label: "Reason" },
  ];
  XLSX.utils.book_append_sheet(wb, buildLightSheet(fbaReturnRows, FBA_RETURN_COLS), "FBA returns");

  const SF_RETURN_COLS: LightCol[] = [
    { key: "pickup_date", label: "Pick-up Date" }, { key: "customer_order_id", label: "Order ID" }, { key: "sku", label: "SKU" },
    { key: "msku", label: "mSKU" }, { key: "asin", label: "ASIN" }, { key: "units", label: "Units" },
    { key: "return_type", label: "Return Type" }, { key: "return_status", label: "Return Status" }, { key: "carrier", label: "Carrier" },
    { key: "returned_with_otp", label: "Returned with OTP" }, { key: "days_in_transit", label: "Days In-transit" },
    { key: "days_since_return_complete", label: "Days Since Return Complete" },
  ];
  XLSX.utils.book_append_sheet(wb, buildLightSheet(sfReturnRows, SF_RETURN_COLS), "SF returns");

  const adRows = [
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...spRows.map((r: any) => ({ reportType: "SP", date: r.report_date, campaign: r.campaign_name, sku: r.advertised_sku, spend: r.spend, sales: r.sales_7d, units: r.advertised_sku_units_7d, acos: r.acos, roas: r.roas })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...sbRows.map((r: any) => ({ reportType: "SB", date: r.report_date, campaign: r.campaign_name, sku: campaignSkuMap.get(r.campaign_name) || "", spend: r.spend, sales: r.sales, units: r.units, acos: r.acos, roas: r.roas })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...sdRows.map((r: any) => ({ reportType: "SD", date: r.report_date, campaign: r.campaign_name, sku: campaignSkuMap.get(r.campaign_name) || "", spend: r.spend, sales: r.sales_14d, units: r.units_14d, acos: r.acos, roas: r.roas })),
  ];
  const ADSPEND_COLS: LightCol[] = [
    { key: "reportType", label: "Report" }, { key: "date", label: "Date" }, { key: "campaign", label: "Campaign" },
    { key: "sku", label: "SKU" }, { key: "spend", label: "Spend" }, { key: "sales", label: "Sales" },
    { key: "units", label: "Units" }, { key: "acos", label: "ACOS", percent: true }, { key: "roas", label: "ROAS" },
  ];
  XLSX.utils.book_append_sheet(wb, buildLightSheet(adRows, ADSPEND_COLS), "Adspend");

  const PRICE_COLS: LightCol[] = [
    { key: "seller_sku", label: "Seller SKU" }, { key: "asin1", label: "ASIN" }, { key: "item_name", label: "Item Name" },
    { key: "price", label: "Price" }, { key: "business_price", label: "Business Price" }, { key: "quantity", label: "Quantity" },
    { key: "fulfillment_channel", label: "Fulfillment Channel" }, { key: "item_condition", label: "Condition" },
  ];
  XLSX.utils.book_append_sheet(wb, buildLightSheet(priceListingRows, PRICE_COLS), "Price");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allListingsRows = priceListingRows.map((r: any) => r.raw || {});
  const ALL_LISTINGS_COLS: LightCol[] = [
    { key: "item-name", label: "Item Name" }, { key: "item-description", label: "Item Description" }, { key: "listing-id", label: "Listing ID" },
    { key: "seller-sku", label: "Seller SKU" }, { key: "price", label: "Price", numeric: true }, { key: "quantity", label: "Quantity", numeric: true },
    { key: "open-date", label: "Open Date" }, { key: "image-url", label: "Image URL" }, { key: "item-is-marketplace", label: "Item Is Marketplace" },
    { key: "product-id-type", label: "Product ID Type" }, { key: "zshop-shipping-fee", label: "Zshop Shipping Fee", numeric: true },
    { key: "item-note", label: "Item Note" }, { key: "item-condition", label: "Item Condition" }, { key: "zshop-category1", label: "Zshop Category1" },
    { key: "zshop-browse-path", label: "Zshop Browse Path" }, { key: "zshop-storefront-feature", label: "Zshop Storefront Feature" },
    { key: "asin1", label: "ASIN1" }, { key: "asin2", label: "ASIN2" }, { key: "asin3", label: "ASIN3" },
    { key: "will-ship-internationally", label: "Will Ship Internationally" }, { key: "expedited-shipping", label: "Expedited Shipping" },
    { key: "zshop-boldface", label: "Zshop Boldface" }, { key: "product-id", label: "Product ID" },
    { key: "bid-for-featured-placement", label: "Bid For Featured Placement" }, { key: "add-delete", label: "Add Delete" },
    { key: "pending-quantity", label: "Pending Quantity", numeric: true }, { key: "fulfillment-channel", label: "Fulfillment Channel" },
    { key: "Business Price", label: "Business Price", numeric: true }, { key: "Quantity Price Type", label: "Quantity Price Type" },
    { key: "Quantity Lower Bound 1", label: "Quantity Lower Bound 1", numeric: true }, { key: "Quantity Price 1", label: "Quantity Price 1", numeric: true },
    { key: "Quantity Lower Bound 2", label: "Quantity Lower Bound 2", numeric: true }, { key: "Quantity Price 2", label: "Quantity Price 2", numeric: true },
    { key: "Quantity Lower Bound 3", label: "Quantity Lower Bound 3", numeric: true }, { key: "Quantity Price 3", label: "Quantity Price 3", numeric: true },
    { key: "Quantity Lower Bound 4", label: "Quantity Lower Bound 4", numeric: true }, { key: "Quantity Price 4", label: "Quantity Price 4", numeric: true },
    { key: "Quantity Lower Bound 5", label: "Quantity Lower Bound 5", numeric: true }, { key: "Quantity Price 5", label: "Quantity Price 5", numeric: true },
    { key: "optional-payment-type-exclusion", label: "Optional Payment Type Exclusion" }, { key: "Progressive Price Type", label: "Progressive Price Type" },
    { key: "Progressive Lower Bound 1", label: "Progressive Lower Bound 1", numeric: true }, { key: "Progressive Price 1", label: "Progressive Price 1", numeric: true },
    { key: "Progressive Lower Bound 2", label: "Progressive Lower Bound 2", numeric: true }, { key: "Progressive Price 2", label: "Progressive Price 2", numeric: true },
    { key: "Progressive Lower Bound 3", label: "Progressive Lower Bound 3", numeric: true }, { key: "Progressive Price 3", label: "Progressive Price 3", numeric: true },
    { key: "maximum-retail-price", label: "Maximum Retail Price", numeric: true },
  ];
  XLSX.utils.book_append_sheet(wb, buildLightSheet(allListingsRows, ALL_LISTINGS_COLS), "All Listings");

  const FBA_INVENTORY_COLS: LightCol[] = [
    { key: "sku", label: "SKU" }, { key: "fnsku", label: "FNSKU" }, { key: "asin", label: "ASIN" }, { key: "product_name", label: "Product" },
    { key: "condition", label: "Condition" }, { key: "your_price", label: "Your Price" }, { key: "mfn_fulfillable_quantity", label: "MFN Fulfillable Qty" },
    { key: "afn_fulfillable_quantity", label: "AFN Fulfillable Qty" }, { key: "afn_total_quantity", label: "AFN Total Qty" },
    { key: "afn_unsellable_quantity", label: "AFN Unsellable Qty" }, { key: "afn_reserved_quantity", label: "AFN Reserved Qty" },
    { key: "afn_inbound_working_quantity", label: "AFN Inbound Working Qty" }, { key: "afn_inbound_shipped_quantity", label: "AFN Inbound Shipped Qty" },
    { key: "afn_inbound_receiving_quantity", label: "AFN Inbound Receiving Qty" },
  ];
  XLSX.utils.book_append_sheet(wb, buildLightSheet(fbaInventoryRows, FBA_INVENTORY_COLS), "FBA inventory");

  const LEDGER_COLS: LightCol[] = [
    { key: "ledger_date", label: "Date" }, { key: "fnsku", label: "FNSKU" }, { key: "asin", label: "ASIN" }, { key: "msku", label: "MSKU" },
    { key: "title", label: "Title" }, { key: "disposition", label: "Disposition" }, { key: "starting_balance", label: "Starting Balance" },
    { key: "customer_shipments", label: "Customer Shipments" }, { key: "customer_returns", label: "Customer Returns" },
    { key: "ending_balance", label: "Ending Balance" }, { key: "location", label: "Location" },
  ];
  XLSX.utils.book_append_sheet(wb, buildLightSheet(ledgerRawRows, LEDGER_COLS), "Inventory ledger");

  // ═══════════════════════════════════════════════════════════════════════
  // ── State-level demand vs. supply analysis (feeds Key Insights below) ──
  // Rolls every SKU's per-state FBA stock up into one row per STATE, then
  // cross-references it against real customer demand in that state
  // (ship_state on the 30-day Orders export) so each state gets an actual
  // verdict — stockout risk / overstock / healthy — not just a number.
  // ═══════════════════════════════════════════════════════════════════════
  interface StateAgg { stockUnits: number; stockValue: number; skuCount: number; orderUnits: number; orderCount: number; }
  const stateAgg = new Map<string, StateAgg>();
  const ensureState = (st: string): StateAgg => {
    let a = stateAgg.get(st);
    if (!a) { a = { stockUnits: 0, stockValue: 0, skuCount: 0, orderUnits: 0, orderCount: 0 }; stateAgg.set(st, a); }
    return a;
  };
  rows.forEach((row) => {
    if (row.sku === UNMAPPED) return;
    row.meta.stateBalances.forEach((units, st) => {
      if (units <= 0) return;
      const a = ensureState(st);
      a.stockUnits += units;
      a.stockValue += units * row.meta.price;
      a.skuCount += 1;
    });
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  orderRows.forEach((r: any) => {
    const st = String(r.ship_state || "").trim().toUpperCase();
    if (!st) return;
    const a = ensureState(st);
    a.orderUnits += r.quantity || 0;
    a.orderCount += 1;
  });

  const totalStockValue = [...stateAgg.values()].reduce((sum, a) => sum + a.stockValue, 0);
  const stateRows = [...stateAgg.entries()].sort((a, b) => b[1].stockValue - a[1].stockValue);

  const stateVerdict = (a: StateAgg): string => {
    if (a.stockUnits <= 0 && a.orderUnits > 0) return "🔴 Stockout risk — demand exists, zero FBA stock here";
    if (a.stockUnits > 0 && a.orderUnits <= 0) return "🟡 Overstocked — stock sitting with no recent orders";
    if (a.orderUnits <= 0 && a.stockUnits <= 0) return "⚪ No activity";
    const ratio = a.stockUnits / a.orderUnits;
    if (ratio < 0.5) return "🔴 Understocked — demand outpacing stock, risk of lost sales";
    if (ratio > 8) return "🟡 Slow-moving — stock far exceeds recent demand";
    return "🟢 Healthy — stock roughly matches demand";
  };

  const stateTableRows: (string | number)[][] = stateRows.map(([st, a]) => {
    const pctOfTotal = totalStockValue > 0 ? (a.stockValue / totalStockValue) * 100 : 0;
    return [st, a.stockUnits, Math.round(a.stockValue), `${pctOfTotal.toFixed(1)}%`, a.orderUnits, a.orderCount, a.skuCount, stateVerdict(a)];
  });

  const top3Value = stateRows.slice(0, 3).reduce((sum, [, a]) => sum + a.stockValue, 0);
  const top3Pct = totalStockValue > 0 ? (top3Value / totalStockValue) * 100 : 0;
  const stockoutStates = stateRows.filter(([, a]) => a.stockUnits <= 0 && a.orderUnits > 0).map(([st]) => st);
  const understockedStates = stateRows.filter(([, a]) => a.orderUnits > 0 && a.stockUnits > 0 && a.stockUnits / a.orderUnits < 0.5).map(([st]) => st);
  const overstockedStates = stateRows.filter(([, a]) => a.stockUnits > 0 && (a.orderUnits <= 0 || a.stockUnits / a.orderUnits > 8)).map(([st]) => st);

  // Grand totals for the 30-day window (for the Key Insights summary block).
  const [gSpendTax, gAdvUnits, , gOrderCount, gReturns] = totalRowCells((r) => r.wA);
  const gAcosDenomKey = rows.reduce((s, r) => s + r.meta.price * r.wA.advUnits, 0);
  const gTacosDenomKey = rows.reduce((s, r) => s + r.meta.price * Math.max(0, r.wA.orderCount - r.wA.returns), 0);
  const unmappedSpend30 = winAMap.get(UNMAPPED)?.spendTax || 0;

  // ── Key Insights & Recommendations sheet ──
  const insightsAoa: (string | number)[][] = [
    ["🔍 KEY INSIGHTS & RECOMMENDATIONS (Last 30 days)", "", "", "", "", "", "", ""],
    ["Window", `${dotDate(win30.start)} to ${dotDate(win30.end)}`, "", "", "", "", "", ""],
    ["", "", "", "", "", "", "", ""],
    ["📊 PERFORMANCE SUMMARY", "", "", "", "", "", "", ""],
    ["Total Campaigns Analyzed", rows.filter((r) => r.sku !== UNMAPPED).length, "", "", "", "", "", ""],
    ["Total Spend+Tax", gSpendTax, "", "", "", "", "", ""],
    ["Total Orders", gOrderCount, "", "", "", "", "", ""],
    ["Total Returns", gReturns, "", "", "", "", "", ""],
    ["Average ACOS", `${((gSpendTax / (gAcosDenomKey || 1)) * 100).toFixed(2)}%`, "", "", "", "", "", ""],
    ["Average TACOS", `${((gSpendTax / (gTacosDenomKey || 1)) * 100).toFixed(2)}%`, "", "", "", "", "", ""],
    ["", "", "", "", "", "", "", ""],
    ["🎯 BEST PERFORMING CAMPAIGNS", "", "", "", "", "", "", ""],
    ...rows
      .filter((r) => r.sku !== UNMAPPED && r.wA.spendTax > 0)
      .sort((a, b) => computeAcos(a.wA, a.meta.price) - computeAcos(b.wA, b.meta.price))
      .slice(0, 5)
      .map((r) => [displayName(r.meta), `ACOS: ${(computeAcos(r.wA, r.meta.price) * 100).toFixed(2)}%`, "", "", "", "", "", ""]),
    ["", "", "", "", "", "", "", ""],
    ["⚠️ CAMPAIGNS TO OPTIMIZE", "", "", "", "", "", "", ""],
    ...rows
      .filter((r) => r.sku !== UNMAPPED && r.wA.spendTax > 0)
      .sort((a, b) => computeAcos(b.wA, b.meta.price) - computeAcos(a.wA, a.meta.price))
      .slice(0, 5)
      .map((r) => [displayName(r.meta), `ACOS: ${(computeAcos(r.wA, r.meta.price) * 100).toFixed(2)}%`, "", "", "", "", "", ""]),
    ["", "", "", "", "", "", "", ""],
    ["📍 STATE-WISE INVENTORY vs. DEMAND ANALYSIS", "", "", "", "", "", "", ""],
    ["State", "Stock (units)", "Stock Value (₹)", "% of Total Value", "Orders (units)", "Order Count", "SKUs in Stock", "Verdict"],
    ...stateTableRows,
    ["", "", "", "", "", "", "", ""],
    ["🧭 State Analysis Summary", "", "", "", "", "", "", ""],
    ["Concentration risk", top3Pct >= 60
      ? `⚠️ Top 3 states (${stateRows.slice(0, 3).map(([st]) => st).join(", ")}) hold ${top3Pct.toFixed(1)}% of FBA value — a single regional disruption hits most of your stock.`
      : `✅ Value is reasonably spread — top 3 states hold ${top3Pct.toFixed(1)}% of FBA value.`, "", "", "", "", "", ""],
    ["Stockout risk states", stockoutStates.length ? `🔴 ${stockoutStates.join(", ")} — orders exist but zero FBA stock. Highest-priority replenishment.` : "✅ None — every state with orders has some stock.", "", "", "", "", "", ""],
    ["Understocked states", understockedStates.length ? `🔴 ${understockedStates.join(", ")} — demand is outpacing stock on hand. Replenish soon.` : "✅ None — stock keeps pace with demand everywhere.", "", "", "", "", "", ""],
    ["Overstocked states", overstockedStates.length ? `🟡 ${overstockedStates.join(", ")} — stock far exceeds recent demand. Consider inter-warehouse transfer or a regional promo.` : "✅ None — no state is meaningfully overstocked.", "", "", "", "", "", ""],
    ["", "", "", "", "", "", "", ""],
    ["🚀 RECOMMENDATIONS", "", "", "", "", "", "", ""],
    ["1. BOOST", "Campaigns with ACOS < 25% - These are your profit drivers. Increase budget.", "", "", "", "", "", ""],
    ["2. OPTIMIZE", "Campaigns with 25% < ACOS < 40% - Test bid adjustments and keywords.", "", "", "", "", "", ""],
    ["3. PAUSE", "Campaigns with ACOS > 50% or 0 orders - Unless they have strategic value.", "", "", "", "", "", ""],
    ["4. REPLENISH FIRST", stockoutStates.concat(understockedStates).length
      ? `Prioritize FBA inbound shipments to: ${[...new Set(stockoutStates.concat(understockedStates))].join(", ")}`
      : "No urgent replenishment gaps detected.", "", "", "", "", "", ""],
    ["5. MISSING DATA", "Upload SF Returns, Inventory Ledger for complete analysis.", "", "", "", "", "", ""],
    ["", "", "", "", "", "", "", ""],
    ["💡 ACTION ITEMS", "", "", "", "", "", "", ""],
    ["Priority 1", `Review unmapped SB/SD campaigns on Upload page - ₹${unmappedSpend30.toFixed(2)} unattributed (last 30 days)`, "", "", "", "", "", ""],
    ["Priority 2", stockoutStates.length ? `Ship inventory to stockout states: ${stockoutStates.join(", ")}` : "Increase FBA availability in high-demand states", "", "", "", "", "", ""],
    ["Priority 3", "Pause low-ACOS campaigns or test new keywords", "", "", "", "", "", ""],
    ["Priority 4", "Upload missing returns/inventory data for better insights", "", "", "", "", "", ""],
  ];

  const wsInsights = XLSX.utils.aoa_to_sheet(insightsAoa);
  for (let c = 0; c < 8; c++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c });
    if (!wsInsights[addr]) wsInsights[addr] = { t: "s", v: "" };
    wsInsights[addr].s = {
      font: { bold: true, color: { rgb: "FFFFFF" }, sz: 13 },
      fill: { fgColor: { rgb: "1E40AF" } },
      alignment: { horizontal: "left", vertical: "center" },
    };
  }
  const stateHeaderRowIdx = insightsAoa.findIndex((r) => r[0] === "State" && r[1] === "Stock (units)");
  if (stateHeaderRowIdx >= 0) {
    for (let c = 0; c < 8; c++) {
      const addr = XLSX.utils.encode_cell({ r: stateHeaderRowIdx, c });
      if (!wsInsights[addr]) wsInsights[addr] = { t: "s", v: "" };
      wsInsights[addr].s = {
        font: { bold: true, color: { rgb: "FFFFFF" }, sz: 10 },
        fill: { fgColor: { rgb: "065F46" } },
        alignment: { horizontal: "center", vertical: "center" },
      };
    }
    for (let i = 0; i < stateTableRows.length; i++) {
      const r = stateHeaderRowIdx + 1 + i;
      const verdict = String(stateTableRows[i][7] || "");
      const fill = verdict.startsWith("🔴") ? "FEE2E2" : verdict.startsWith("🟡") ? "FEF9C3" : verdict.startsWith("🟢") ? "DCFCE7" : "F3F4F6";
      for (let c = 0; c < 8; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        if (wsInsights[addr]) wsInsights[addr].s = { fill: { fgColor: { rgb: fill } }, alignment: { horizontal: c === 0 || c === 7 ? "left" : "center", vertical: "center" } };
      }
    }
  }
  wsInsights["!cols"] = [{ wch: 30 }, { wch: 50 }, { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 12 }, { wch: 13 }, { wch: 55 }];
  XLSX.utils.book_append_sheet(wb, wsInsights, "Key Insights");

  // ── Notes sheet ──
  const wsNote = XLSX.utils.aoa_to_sheet([
    ["Historical Analysis Report — Ad Performance"],
    [`Account: ${accountName || "-"}`],
    [`Last 30 days: ${dotDate(win30.start)} to ${dotDate(win30.end)}`],
    [`Last 7 days: ${dotDate(win7.start)} to ${dotDate(win7.end)}`],
    [""],
    ["Sourced from the manually uploaded reports (Upload Reports page), not the live SellerMate API — this is what lets both trailing windows be recomputed from a fixed historical upload instead of only 'as of today'."],
    ["Analysis report / TACOS sheets: both windows always end on the same date and are recomputed from the SAME 30-day fetch — the 7-day block is simply the last 7 days of that data, not a separate query."],
    ["Lead column is CAMPAIGN NAME, not product name: Sponsored Brands/Display spend is only ever known per campaign (Amazon's own export has no SKU column), so a campaign's spend is routed to a SKU via the Campaign -> SKU map (Upload page). Unmapped campaigns are grouped under the '⚠ Unmapped SB/SD campaigns' row instead of being dropped."],
    ["Spend+Tax = ad spend x 1.18 (18% GST) — computed directly from each row's raw 'spend' field, summed per SKU, then multiplied once by 1.18. Not a formula in the Analysis report/TACOS sheets (matches the original workbook), but is a live formula (Spend x 1.18) in the leaderboard sheet."],
    ["Orders = number of order records for the SKU (order count). Total Units (#) = sum of quantity across those orders. These are deliberately different metrics — a SKU can have few high-quantity orders or many single-unit orders."],
    ["Final = Orders (count) - Returns. CPC (Analysis report) = Spend+Tax / Advertised SKU Units. ACOS = CPC / Price. TACOS = Spend+Tax / (Price x Final)."],
    ["TACOS sheet's CPC is a DIFFERENT metric from the Analysis report's CPC: here CPC = Spend+Tax / Final orders (cost per net order), matching the seller's original workbook. TACOS (= CPC / Price) comes out the same as the Analysis report's TACOS either way."],
    ["Returns exclude courier RTO / undeliverable (AM returns: Return Type = 'Undelivered'; FBA returns: reason starting with 'UNDELIVERABLE')."],
    [
      hasUploadedPrice
        ? "Price and FBA/MFN channel come from the uploaded Price (All Listings) report."
        : "Price and FBA/MFN channel come from the LIVE product catalog (today's snapshot) — no Price report has been uploaded, so this may not match what price actually was during this date range.",
    ],
    [
      hasUploadedLedger
        ? `FBA availability comes from the uploaded Inventory Ledger report, as of ${dotDate(win30.end)} (the latest SELLABLE balance per SKU/location on or before that date) — not today. Not time-windowed like the ad/order metrics — it's a single current snapshot shared by both the 30-day and 7-day blocks.`
        : "FBA availability comes from the LIVE inventory feed (today's snapshot) — no Inventory Ledger report has been uploaded, so this may not match actual stock during this date range.",
    ],
    [
      hasUploadedFbaInv
        ? "Inbound-shipped-quantity comes from the uploaded FBA Inventory report."
        : "Inbound-shipped-quantity shows '—': not exposed by the live inventory feed, and no FBA Inventory report has been uploaded.",
    ],
    ["FBA status sheet: per-state stock pivot for FBA SKUs only (a snapshot, not time-windowed), with the same Available / Number of FBA Not Available / All FBA formulas as the seller's original workbook."],
    ["Price / All Listings / FBA inventory / Inventory ledger sheets: raw dumps of the uploaded snapshot/ledger files, for reference — not filtered or aggregated."],
    ["SF returns sheet: raw dump of uploaded SellerFlex (self-fulfilled) returns for the 30-day window, if any were uploaded. Not currently folded into the Returns / Final / ACOS / TACOS figures elsewhere in this workbook — those still only count AM returns + FBA returns."],
    ["'Orders, returns, adspend' sheet: 4 independent top-N lists side by side (Orders by SKU, Returns by SKU, Adspend by campaign, Adspend by SKU), each now split into its own 30-day/7-day pair — a given row is NOT a joined record; SKU X in the Orders columns has no relation to whatever SKU appears in the Returns columns of that same row."],
    ["Key Insights sheet: State-wise analysis and recommendations are based on the 30-day window only."],
  ]);
  wsNote["!cols"] = [{ wch: 110 }];
  wsNote["A1"].s = { font: { bold: true, sz: 13, color: { rgb: "312E81" } } };
  XLSX.utils.book_append_sheet(wb, wsNote, "Notes");

  const filename = `Historical_Analysis_Report_${win30.start}_to_${endDate}.xlsx`;
  return {
    wb,
    filename,
    skuCount: rows.length,
    unmappedCampaignSpend: unmappedSpend30,
  };
}

export async function exportHistoricalAnalysisReport(opts: {
  endDate?: string;
  account: { id?: string; workspace_id?: string; name?: string } | null | undefined;
  keySlot: string;
}) {
  const { account, keySlot } = opts;
  const endDate = opts.endDate || new Date().toISOString().slice(0, 10);
  const call: ToolCaller = (tool, args) => mcp(tool, args, keySlot);

  const { wb, filename, ...stats } = await buildHistoricalAnalysisReportWorkbook({
    call,
    accountId: account?.id,
    workspaceId: account?.workspace_id,
    accountName: account?.name,
    endDate,
  });
  // bookSST forces a shared-string table instead of xlsx-js-style's default of
  // inlining every string cell — with thousands of Orders rows repeating the
  // same ~150-char product names, this is the difference between an ~8MB and
  // ~1.5MB file for the same data.
  XLSX.writeFile(wb, filename, { bookSST: true });
  return { filename, ...stats };
}
