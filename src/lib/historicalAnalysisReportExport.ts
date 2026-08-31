import * as XLSX from "xlsx-js-style";
import { fcToState } from "@/lib/analysisReportExport";
import { fetchAllRows, isCancelledOrder, isGenuineAmReturn, isGenuineFbaReturn, isStandardOrderId, istDayWindowUtc } from "@/lib/amazonReportShared";
import { fetchMisAmazonOrders, fetchMisAmazonReturns, fetchMisFbaReturns, fetchMisSellerFlexReturns } from "@/lib/misAdapters";

// Re-exported for existing importers (weeklySalesExport.ts) — the actual
// definitions live in amazonReportShared.ts so analysisReportExport.ts can use
// them too without an import cycle (this file still imports fcToState FROM
// analysisReportExport.ts).
export { fetchAllRows, isCancelledOrder, isGenuineAmReturn, isGenuineFbaReturn };

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
// EVERY figure in this report comes from the uploaded tables — there is no live
// SellerMate call anywhere in this file. Price, FBA/MFN channel and FBA
// availability used to fall back to the live catalog/inventory feed when their
// file was missing, which quietly mixed TODAY's snapshot into a historical
// window: the sheet looked complete while describing the wrong point in time,
// and nothing on the face of it said which rows were affected. Now a missing
// upload shows as missing data and is named on the Notes sheet, so the reader
// can see exactly what is absent and upload it.

const GST_MULTIPLIER = 1.18;

function dotDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

function getDateWindow(toDate: string, days: number): { start: string; end: string } {
  const end = new Date(`${toDate}T00:00:00Z`);
  const start = new Date(end.getTime());
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

const UNMAPPED = "__UNMAPPED__";
const UNMAPPED_LABEL = "⚠ Unmapped SB/SD campaigns — assign a SKU on the Upload page";

// ── Per-window numeric aggregate (recomputed once for the 30-day rows, once
// for the 7-day rows) ────────────────────────────────────────────────────────
//
// The Analysis report is keyed per CAMPAIGN x SKU, matching the seller's own
// pivot, so the numbers split across two grains:
//
//   per campaign x SKU — Spend+Tax and Advertised SKU Units. Only these differ
//     between two rows that share a SKU.
//   per SKU           — Total Units, Orders and Returns. Orders and returns are
//     never attributable to one campaign (Amazon reports them per SKU), so the
//     SKU's figure is repeated on each of its campaign rows, exactly as the
//     seller's workbook does. Summing an Orders column therefore double-counts
//     any SKU advertised by more than one campaign — that is why the sheet has
//     no Orders grand total.
interface PairAgg {
  spendTax: number;
  advUnits: number;
}
function emptyPairAgg(): PairAgg {
  return { spendTax: 0, advUnits: 0 };
}
interface SkuAgg {
  /** "Total Units (#)" — this SKU's ad-attributed units across ALL campaigns. */
  advUnitsTotal: number;
  /** "Orders" — SUM of order quantity, excluding cancelled orders. */
  orderUnits: number;
  returns: number;
  /**
   * This SKU's Spend+Tax across ALL its campaigns — the numerator TACOS needs.
   * TACOS asks "is this SKU's advertising paying for itself", which is a
   * question about the SKU's whole ad cost, so it cannot be answered from one
   * campaign's slice of the spend. See computeTacos.
   */
  spendTaxTotal: number;
}
function emptySkuAgg(): SkuAgg {
  return { advUnitsTotal: 0, orderUnits: 0, returns: 0, spendTaxTotal: 0 };
}

/** One Analysis-report row: a campaign x SKU pair plus its SKU-level figures. */
interface WindowAgg {
  spendTax: number;
  advUnits: number;
  totalUnits: number;
  orderUnits: number;
  returns: number;
  /** SKU-grain Spend+Tax — TACOS only. See SkuAgg.spendTaxTotal. */
  skuSpendTax: number;
}
function combineAgg(p: PairAgg | undefined, s: SkuAgg | undefined): WindowAgg {
  return {
    spendTax: p?.spendTax || 0,
    advUnits: p?.advUnits || 0,
    totalUnits: s?.advUnitsTotal || 0,
    orderUnits: s?.orderUnits || 0,
    returns: s?.returns || 0,
    skuSpendTax: s?.spendTaxTotal || 0,
  };
}
function computeCpc(w: WindowAgg): number {
  return w.advUnits > 0 ? w.spendTax / w.advUnits : w.spendTax;
}
function computeAcos(w: WindowAgg, price: number): number {
  return price > 0 ? computeCpc(w) / price : 0;
}
/**
 * TACOS is measured at SKU grain, matching the seller's own workbook: the
 * numerator is the SKU's TOTAL Spend+Tax across every campaign advertising it,
 * so the same value repeats on each of that SKU's campaign rows. That is the
 * figure they read to decide whether a SKU's advertising pays for itself.
 *
 * Dividing only ONE campaign's spend by the SKU's whole net order volume — which
 * this used to do — answers a different question ("which campaign eats the
 * margin") and understates every multi-campaign SKU relative to their workbook.
 * It also disagreed with this file's own TACOS sheet, which was already per-SKU.
 *
 * Final = 0 means spend with no net orders, so TACOS is genuinely undefined
 * rather than zero — but their workbook prints 0 there, and inventing a
 * denominator of 1 (the previous behaviour) is worse: it silently reports
 * Spend+Tax / Price as though exactly one unit had sold.
 */
function computeTacos(w: WindowAgg, price: number): number {
  const final = Math.max(0, w.orderUnits - w.returns);
  if (final <= 0 || price <= 0) return 0;
  return w.skuSpendTax / (price * final);
}

// Excel sorts "B-OT-DT12" before "BMN132" because its collation ignores the
// hyphen; a plain JS string compare puts "B-" first and reorders the whole
// sheet against the seller's. Strip non-alphanumerics to match.
function excelSortKey(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
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
  /** Shown on the Notes sheet only — no account credentials are needed, since
   *  every figure comes from the uploaded tables rather than the live API. */
  accountName: string | undefined;
  endDate: string; // 'YYYY-MM-DD' — both windows are trailing windows ending here
}

export async function buildHistoricalAnalysisReportWorkbook(opts: BuildOpts) {
  const { accountName, endDate } = opts;
  // Stamped once, at the moment this build actually reads its source tables —
  // written to the Notes sheet below so a reader can tell this file and a
  // Weekly Sales Report apart when the two were generated minutes (or days)
  // apart and therefore don't see the same upload state, instead of assuming
  // any mismatch is a bug.
  const dataPulledAt = new Date().toISOString();

  const win30 = getDateWindow(endDate, 30);
  const win7 = getDateWindow(endDate, 7);
  // Orders/FBA-returns carry a timestamp — bucket by IST calendar day (see
  // istDayWindowUtc), not the raw UTC instant.
  const win30Ist = istDayWindowUtc(win30.start, endDate);
  const win7Ist = istDayWindowUtc(win7.start, endDate);

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
    fetchMisAmazonOrders((q) => q.gte("purchase_datetime", win30Ist.gte).lt("purchase_datetime", win30Ist.lt)),
    fetchMisAmazonReturns((q) => q.gte("return_request_date", win30.start).lte("return_request_date", endDate)),
    fetchMisFbaReturns((q) => q.gte("return_date", win30Ist.gte).lt("return_date", win30Ist.lt)),
    // No "id" column on this table (it's a plain campaign->SKU weight map,
    // upserted rather than appended) — fetchAllRows defaults to ordering by
    // "id" for stable pagination, which errors here. Order by its natural
    // (campaign_name, sku) key instead.
    fetchAllRows("barm_amazon_campaign_sku_map", (q) => q, ["campaign_name", "sku"]),
    fetchAllRows("barm_amazon_price_listing", (q) => q),
    fetchAllRows("barm_amazon_fba_inventory", (q) => q),
    // Whole SELLABLE ledger, deliberately NOT filtered by date. The ledger is a
    // point-in-time stock snapshot, not a per-day history, so the uploaded file
    // is normally dated AFTER the report window (the seller exports it today).
    // Filtering to <= endDate matched nothing and made every FBA SKU read 0 —
    // the same trap weeklySalesExport.ts documents. The snapshot to use is
    // chosen below, preferring one at or before endDate.
    fetchAllRows("barm_amazon_inventory_ledger", (q) => q.eq("disposition", "SELLABLE")),
    // Raw "Inventory ledger" sheet — every disposition, deliberately NOT filtered
    // by date, for the exact same reason as the SELLABLE fetch just above: the
    // ledger is a point-in-time snapshot normally dated AFTER the report window,
    // so a `.gte(win30.start).lte(endDate)` filter here matched zero rows and the
    // sheet rendered as header-only. Narrowed to the chosen snapshot (ledgerAsOf,
    // computed below from the SELLABLE fetch) right before it's written to the sheet.
    fetchAllRows("barm_amazon_inventory_ledger", (q) => q),
    fetchMisSellerFlexReturns((q) => q.gte("pickup_date", win30.start).lte("pickup_date", endDate)),
  ]);

  // Campaign -> weighted SKU allocation. Sponsored Brands / Display exports have
  // no SKU column, so each such campaign's spend is split across the SKUs the
  // seller assigned it on the Upload page, in proportion to their weights.
  // Weights are relative: a campaign's shares are weight / sum(weights).
  const campaignSkuMap = new Map<string, { sku: string; weight: number }[]>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mapRows.forEach((r: any) => {
    const weight = Number(r.weight);
    const list = campaignSkuMap.get(r.campaign_name) || [];
    list.push({ sku: r.sku, weight: Number.isFinite(weight) && weight > 0 ? weight : 1 });
    campaignSkuMap.set(r.campaign_name, list);
  });
  /** Fractional shares for one campaign, or null when it has no mapping yet. */
  const campaignShares = (campaignName: string): { sku: string; share: number }[] | null => {
    const list = campaignSkuMap.get(campaignName);
    if (!list || !list.length) return null;
    const total = list.reduce((s, e) => s + e.weight, 0);
    if (total <= 0) return null;
    return list.map((e) => ({ sku: e.sku, share: e.weight / total }));
  };

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

  // Listing status ("Active"/"Inactive" on Amazon's own All-Listings export) —
  // used below to stop a delisted SKU's leftover FBA ledger balance alone from
  // pulling it into this report when it had no orders or ad spend in the
  // window. That was the source of SKUs appearing ONLY in this report and
  // never in the order-driven Weekly Sales Report: a discontinued listing can
  // carry stale FBA stock (and this report's stock rule treated any stock as
  // "active") for months after its last real order. Blank/missing status is
  // treated as unknown, not inactive, since older Price exports don't carry
  // the column at all — the rule below must never be the reason a genuinely
  // active SKU with real sales silently drops out.
  const listingStatusBySku = new Map<string, string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  priceListingRows.forEach((r: any) => {
    if (!r.seller_sku || !r.status) return;
    listingStatusBySku.set(r.seller_sku, String(r.status));
  });
  const isInactiveListing = (sku: string): boolean => {
    const s = listingStatusBySku.get(sku);
    return !!s && s.trim().toLowerCase() !== "active";
  };

  const inboundShippedBySku = new Map<string, number>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fbaInventoryRows.forEach((r: any) => {
    if (!r.sku) return;
    inboundShippedBySku.set(r.sku, (inboundShippedBySku.get(r.sku) || 0) + (r.afn_inbound_shipped_quantity || 0));
  });
  const hasUploadedFbaInv = inboundShippedBySku.size > 0;

  // Which snapshot date the stock figures actually describe. Ideally the latest
  // one at or before endDate — a true "as of the window" reading. When the
  // upload only covers later dates (the normal case, since the ledger is
  // exported today) fall back to the EARLIEST available snapshot: it is the
  // closest thing to the window that exists, it is uploaded and dated rather
  // than a live snapshot, and the Notes sheet states the date so the reader
  // knows the stock describes that day rather than the report period. Reporting
  // nothing here would be worse — the FBA status sheet would lose every state
  // column over a technicality about which day the file was pulled.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ledgerDates = [...new Set((ledgerRows as any[]).map((r) => r.ledger_date).filter(Boolean))].sort();
  const atOrBefore = ledgerDates.filter((d) => d <= endDate);
  // No snapshot on or before the window end (the common case — ledger exports are
  // dated when pulled, not backdated) falls back to the MOST RECENT snapshot
  // available at all, not the oldest — the freshest stock read is the closest
  // stand-in for "current" when nothing inside the window exists.
  const ledgerAsOf: string | null = atOrBefore.length ? atOrBefore[atOrBefore.length - 1] : (ledgerDates[ledgerDates.length - 1] ?? null);
  const ledgerIsAfterWindow = !!ledgerAsOf && ledgerAsOf > endDate;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ledgerInScope = (ledgerRows as any[]).filter((r) => r.ledger_date && r.ledger_date <= (ledgerAsOf ?? ""));
  // When the only snapshots are after the window, `ledgerInScope` is empty by
  // that test, so use the chosen snapshot's own rows instead.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ledgerEffective: any[] = ledgerInScope.length ? ledgerInScope : (ledgerRows as any[]).filter((r) => r.ledger_date === ledgerAsOf);

  // Raw "Inventory ledger" sheet: every currently-uploaded row, every date it
  // covers — no single-snapshot narrowing. Deliberately just ledgerRawRows
  // itself (fetched with no date filter above); kept as its own name so the
  // book_append_sheet call below stays self-documenting about which set backs
  // the raw dump vs which backs the FBA status sheet's deduped stock numbers.
  const ledgerRawEffective = ledgerRawRows;

  const ledgerLatestByKey = new Map<string, { ledger_date: string; msku: string; location: string; ending_balance: number }>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ledgerEffective.forEach((r: any) => {
    if (!r.msku) return;
    const key = `${r.msku}|${r.location}`;
    const cur = ledgerLatestByKey.get(key);
    if (!cur || r.ledger_date > cur.ledger_date) ledgerLatestByKey.set(key, r);
  });
  const ledgerBySku = new Map<string, { fbaTotal: number; stateBalances: Map<string, number> }>();
  const ledgerStates = new Set<string>();
  ledgerLatestByKey.forEach((r) => {
    const bal = r.ending_balance || 0;
    let s = ledgerBySku.get(r.msku);
    if (!s) { s = { fbaTotal: 0, stateBalances: new Map() }; ledgerBySku.set(r.msku, s); }
    if (bal > 0) s.fbaTotal += bal;
    const state = fcToState(r.location);
    // Register the state even when its latest balance is 0 (a location the
    // ledger has a row for but is currently empty) — this is what lets the FBA
    // status sheet's "Number of FBA Not Available" tell "reported and
    // currently 0" (a real literal 0, the seller's own not-available signal)
    // apart from "the ledger never had a row for this SKU+state at all" (which
    // must stay blank there). Skipping bal<=0 rows here used to collapse both
    // cases into "never seen", so a state the SKU simply never shipped to
    // looked identical to one it emptied out of.
    s.stateBalances.set(state, (s.stateBalances.get(state) || 0) + bal);
    ledgerStates.add(state);
  });
  const hasUploadedLedger = ledgerBySku.size > 0;

  // No live-API fallback here by design — see this file's header comment. Every
  // figure comes from the uploaded exports, so a missing file shows as missing
  // data (and is named on the Notes sheet) rather than being quietly filled in
  // with today's live snapshot for a historical window.

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
    const shares = campaignShares(r.campaign_name);
    if (!shares) {
      ensureMeta(UNMAPPED).name = UNMAPPED_LABEL;
      return;
    }
    shares.forEach(({ sku }) => {
      const m = ensureMeta(sku);
      if (!m.campaignName) m.campaignName = r.campaign_name;
    });
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

  // Price / FBA-MFN channel — from the uploaded Price (All Listings) report.
  // Without it, price stays 0, which zeroes ACOS and TACOS (both guard on
  // price > 0). That is the honest outcome: those ratios are meaningless
  // without the price the SKU actually sold at during the window, and the
  // Notes sheet says so rather than substituting today's live catalog price.
  priceBySku.forEach((info, sku) => {
    const m = ensureMeta(sku);
    m.isFba = info.isFba;
    m.channel = info.channel;
    if (info.price > 0) m.price = info.price;
    m.fbmQty += info.fbmQty;
  });

  // FBA availability — from the uploaded Inventory Ledger, taken as of endDate
  // so the stock shown belongs to the report's window rather than to today.
  // Without the ledger there is no per-state stock at all: accountStates stays
  // empty, so the FBA status sheet loses its state columns and the Analysis
  // report's Available column reads 0. Previously this fell back to the live
  // per-location feed, which pulled TODAY's balances into a historical window —
  // the numbers looked complete while describing the wrong point in time.
  const accountStates = new Set<string>();
  ledgerBySku.forEach((info, sku) => {
    const m = ensureMeta(sku);
    m.isFba = true;
    m.fbaTotal += info.fbaTotal;
    info.stateBalances.forEach((v, st) => m.stateBalances.set(st, (m.stateBalances.get(st) || 0) + v));
  });
  ledgerStates.forEach((st) => accountStates.add(st));

  // ── Per-window numeric aggregation — same function run twice: once over
  // the full 30-day rows, once over the 7-day-filtered subset. ──
  const pairKey = (campaign: string, sku: string) => `${campaign}\u0000${sku}`;
  interface WindowMaps {
    pairs: Map<string, PairAgg>;
    skus: Map<string, SkuAgg>;
    /** campaign x SKU pairs seen in the ad data, in insertion order. */
    pairIds: Map<string, { campaign: string; sku: string }>;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function aggregateWindow(rowsSp: any[], rowsSb: any[], rowsSd: any[], rowsOrders: any[], rowsAmReturns: any[], rowsFbaReturns: any[], rowsSfReturns: any[]): WindowMaps {
    const pairs = new Map<string, PairAgg>();
    const skus = new Map<string, SkuAgg>();
    const pairIds = new Map<string, { campaign: string; sku: string }>();
    const ensurePair = (campaign: string, sku: string): PairAgg => {
      const k = pairKey(campaign, sku);
      let p = pairs.get(k);
      if (!p) { p = emptyPairAgg(); pairs.set(k, p); pairIds.set(k, { campaign, sku }); }
      return p;
    };
    const ensureSku = (sku: string): SkuAgg => {
      let s = skus.get(sku);
      if (!s) { s = emptySkuAgg(); skus.set(sku, s); }
      return s;
    };
    /** Ad spend + ad-attributed units land on BOTH grains at once. */
    const addAd = (campaign: string, sku: string, spend: number, units: number) => {
      const taxed = spend * GST_MULTIPLIER;
      const p = ensurePair(campaign, sku);
      p.spendTax += taxed;
      p.advUnits += units;
      const s = ensureSku(sku);
      s.advUnitsTotal += units;
      // Every rupee of spend — SP, SB and SD, including the unmapped bucket —
      // funnels through here, so this is the one place that can total spend per
      // SKU without re-walking the pair map later.
      s.spendTaxTotal += taxed;
    };
    // SP: true SKU-level ad spend + ad-attributed units, straight from the CSV.
    // "Advertised SKU Units (#)" is deliberately populated from Amazon's "7 Day
    // Total Units" column (units_7d) — NOT "7 Day Advertised SKU Units"
    // (advertised_sku_units_7d), despite the misleadingly similar name. Verified
    // directly against the seller's own workbook: their "Advertised SKU Units
    // (#)" pivot column reproduces SUM(units_7d) exactly for every SKU checked
    // (e.g. SKU A001-5 over 2026-07-04→2026-08-02: units_7d sums to 4, matching
    // their 4 — advertised_sku_units_7d sums to only 1, which is what this line
    // used to read and is why CPC/ACOS were previously off by ~4x for that SKU).
    rowsSp.forEach((r) => {
      if (!r.advertised_sku) return;
      addAd(r.campaign_name || "", r.advertised_sku, r.spend || 0, r.units_7d || 0);
    });
    // SB/SD: campaign-level only — SPEND is split across the campaign's mapped
    // SKUs by weight, but Advertised SKU Units are recorded as 0, matching the
    // seller's workbook. Amazon attributes those units to the campaign, not to a
    // SKU; apportioning them by the same weights would invent fractional units
    // (a third of a sale) and feed them into CPC = Spend+Tax / units. Total Units
    // therefore counts only genuinely SKU-level (Sponsored Products) units.
    // Unmapped campaigns land in an explicit bucket rather than being dropped, so
    // their spend still shows up in the total.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function applyCampaignAdRow(r: any) {
      const spend = r.spend || 0;
      const shares = campaignShares(r.campaign_name);
      if (!shares) {
        addAd(r.campaign_name || "", UNMAPPED, spend, 0);
        return;
      }
      shares.forEach(({ sku, share }) => addAd(r.campaign_name || "", sku, spend * share, 0));
    }
    rowsSb.forEach((r) => applyCampaignAdRow(r));
    rowsSd.forEach((r) => applyCampaignAdRow(r));
    // Orders — "Orders" is the SUM of order quantity, not the number of order
    // records, matching the seller's pivot. Cancelled orders are excluded: they
    // were never sold, so counting them would inflate Orders and depress ACOS.
    // Non-standard order IDs ("S02-..." instead of "NNN-NNNNNNN-NNNNNNN") are
    // excluded too — verified against the seller's own workbook, which omits
    // every single one of these regardless of SKU.
    rowsOrders.forEach((r) => {
      if (!r.sku || isCancelledOrder(r) || !isStandardOrderId(r.amazon_order_id)) return;
      ensureSku(r.sku).orderUnits += r.quantity || 0;
    });
    // Returns — AM returns (Seller Central return-requests) are the seller's
    // canonical per-SKU record; FBA + SF returns only fill in for a SKU that
    // has NO AM return recorded, since the same physical return can otherwise
    // show up in both AM returns and FBA/SF returns and get double-counted.
    // Verified directly against the seller's own workbook: this exact
    // AM-else-(FBA+SF) fallback rule reproduced their Returns column for ALL
    // 140 SKUs it currently tracks — a plain unfiltered sum of all three
    // channels, or AM-only, or a genuine-returns filter, each diverged on a
    // large minority of SKUs. isGenuineAmReturn/isGenuineFbaReturn stay
    // available for other reports (e.g. weeklySalesExport.ts) that want a
    // genuine-only figure — this report just isn't one of them.
    const amReturnsBySku = new Map<string, number>();
    rowsAmReturns.forEach((r) => {
      if (!r.merchant_sku) return;
      amReturnsBySku.set(r.merchant_sku, (amReturnsBySku.get(r.merchant_sku) || 0) + (r.return_quantity || 0));
    });
    const fbaSfReturnsBySku = new Map<string, number>();
    rowsFbaReturns.forEach((r) => {
      if (!r.sku) return;
      fbaSfReturnsBySku.set(r.sku, (fbaSfReturnsBySku.get(r.sku) || 0) + (r.quantity || 0));
    });
    rowsSfReturns.forEach((r) => {
      if (!r.msku) return;
      fbaSfReturnsBySku.set(r.msku, (fbaSfReturnsBySku.get(r.msku) || 0) + (r.units || 0));
    });
    new Set([...amReturnsBySku.keys(), ...fbaSfReturnsBySku.keys()]).forEach((sku) => {
      const amSum = amReturnsBySku.get(sku) || 0;
      ensureSku(sku).returns += amSum > 0 ? amSum : (fbaSfReturnsBySku.get(sku) || 0);
    });
    return { pairs, skus, pairIds };
  }

  const winAMap = aggregateWindow(spRows, sbRows, sdRows, orderRows, amReturnRows, fbaReturnRows, sfReturnRows);

  // 7-day subset — filtered in memory from the same 30-day fetch (no second DB round-trip).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spRows7 = spRows.filter((r: any) => r.report_date >= win7.start);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sbRows7 = sbRows.filter((r: any) => r.report_date >= win7.start);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdRows7 = sdRows.filter((r: any) => r.report_date >= win7.start);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orderRows7 = orderRows.filter((r: any) => r.purchase_datetime >= win7Ist.gte);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const amReturnRows7 = amReturnRows.filter((r: any) => r.return_request_date >= win7.start);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fbaReturnRows7 = fbaReturnRows.filter((r: any) => r.return_date >= win7Ist.gte);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sfReturnRows7 = sfReturnRows.filter((r: any) => r.pickup_date >= win7.start);

  const winBMap = aggregateWindow(spRows7, sbRows7, sdRows7, orderRows7, amReturnRows7, fbaReturnRows7, sfReturnRows7);

  // ── Combine: one row per CAMPAIGN x SKU pair that had ad activity in the
  // 30-day window, sorted by SKU (Excel's punctuation-insensitive order, so the
  // sheet lines up row-for-row with the seller's own pivot), then by campaign. ──
  interface Row { campaign: string; sku: string; meta: SkuMeta; wA: WindowAgg; wB: WindowAgg; }
  // Every campaign x SKU that appears in the ad exports gets a row, including
  // ones whose spend and units are both zero — the campaign still ran against
  // that SKU, and dropping them would silently shrink the sheet.
  const rows: Row[] = [...winAMap.pairIds.entries()]
    .map(([k, id]) => ({
      campaign: id.campaign,
      sku: id.sku,
      meta: metaMap.get(id.sku) || emptyMeta(id.sku),
      wA: combineAgg(winAMap.pairs.get(k), winAMap.skus.get(id.sku)),
      wB: combineAgg(winBMap.pairs.get(k), winBMap.skus.get(id.sku)),
    }));

  // Every SKU with orders/returns in the 30-day window gets a row even when it
  // was never advertised — winAMap.skus already holds it (orders are recorded
  // per SKU regardless of ad activity), only winAMap.pairIds (ad rows only)
  // left it out above. Without this, the sheet was silently scoped to
  // advertised/FBA-tracked SKUs only: a SKU with real sales but no campaign
  // and no FBA stock never appeared here at all, while it was fully present in
  // the order-driven Weekly Sales Report — the source of SKUs missing from
  // this report entirely. campaign: "" falls through to the SKU's product name
  // in the row-render below, exactly like the "no campaign yet" case already
  // handled there.
  const skusWithAdPair = new Set(rows.map((r) => r.sku));
  winAMap.skus.forEach((s, sku) => {
    if (skusWithAdPair.has(sku) || sku === UNMAPPED) return;
    if (!s.orderUnits && !s.returns) return;
    rows.push({
      campaign: "",
      sku,
      meta: metaMap.get(sku) || emptyMeta(sku),
      wA: combineAgg(undefined, s),
      wB: combineAgg(undefined, winBMap.skus.get(sku)),
    });
  });

  rows.sort((a, b) => {
    const ka = excelSortKey(a.sku), kb = excelSortKey(b.sku);
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.campaign < b.campaign ? -1 : a.campaign > b.campaign ? 1 : 0;
  });

  // Per-SKU view of the same data, for the sheets that are genuinely per-SKU
  // (TACOS, FBA status, leaderboards, state analysis). A SKU appears once here
  // even when several campaigns advertise it; its spend is the sum across them.
  interface SkuRow { sku: string; meta: SkuMeta; wA: WindowAgg; wB: WindowAgg; }
  /** Roll every campaign x SKU pair up to its SKU, in one pass over the pairs. */
  const rollUpToSku = (m: WindowMaps): Map<string, WindowAgg> => {
    const out = new Map<string, WindowAgg>();
    const ensure = (sku: string): WindowAgg => {
      let w = out.get(sku);
      if (!w) {
        const s = m.skus.get(sku);
        // spendTax accumulates from the pairs below and lands on the same total
        // as skuSpendTax; taking skuSpendTax straight from SkuAgg keeps one
        // source of truth for the TACOS numerator at either grain.
        w = { spendTax: 0, advUnits: 0, totalUnits: s?.advUnitsTotal || 0, orderUnits: s?.orderUnits || 0, returns: s?.returns || 0, skuSpendTax: s?.spendTaxTotal || 0 };
        out.set(sku, w);
      }
      return w;
    };
    m.pairIds.forEach((id, k) => {
      const p = m.pairs.get(k);
      if (!p) return;
      const w = ensure(id.sku);
      w.spendTax += p.spendTax;
      w.advUnits += p.advUnits;
    });
    m.skus.forEach((_, sku) => ensure(sku));
    return out;
  };
  const skuRollA = rollUpToSku(winAMap);
  const skuRollB = rollUpToSku(winBMap);
  const emptyWindowAgg = (): WindowAgg => ({ spendTax: 0, advUnits: 0, totalUnits: 0, orderUnits: 0, returns: 0, skuSpendTax: 0 });

  const activeSkus = new Set<string>();
  skuRollA.forEach((w, sku) => { if (w.spendTax || w.advUnits || w.orderUnits || w.returns) activeSkus.add(sku); });
  metaMap.forEach((m, sku) => {
    if (m.fbaTotal <= 0 && m.fbmQty <= 0) return;
    // Real 30-day activity (checked above, order matters — activeSkus is
    // already fully populated by it) always wins regardless of listing
    // status. Only a SKU with NO activity at all, admitted purely because old
    // stock is still on the books, gets held back for being inactive.
    if (isInactiveListing(sku) && !activeSkus.has(sku)) return;
    activeSkus.add(sku);
  });
  const skuRows: SkuRow[] = [...activeSkus].map((sku) => ({
    sku,
    meta: metaMap.get(sku) || emptyMeta(sku),
    wA: skuRollA.get(sku) || emptyWindowAgg(),
    wB: skuRollB.get(sku) || emptyWindowAgg(),
  }));
  skuRows.sort((a, b) => (b.wA.spendTax - a.wA.spendTax) || (b.wA.orderUnits - a.wA.orderUnits));

  // Worst-ACOS-first preview for the email body (the workbook itself carries the full detail) —
  // same reasoning as adSpendReportExport.ts's shortlist: a SKU that's barely spent anything can
  // show a wildly misleading ACOS from sheer small-sample noise, so a real-spend floor comes first.
  const ACOS_HIGHLIGHT_MIN_SPEND = 500;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const topWorstAcos = [...skuRows]
    .filter((r) => r.wA.spendTax > ACOS_HIGHLIGHT_MIN_SPEND)
    .map((r) => ({ sku: r.sku, name: r.meta.name, spendTax: r2(r.wA.spendTax), acos: computeAcos(r.wA, r.meta.price) }))
    .sort((a, b) => b.acos - a.acos)
    .slice(0, 5);
  const totalSpend30 = r2(skuRows.reduce((a, r) => a + r.wA.spendTax, 0));
  const totalSpend7 = r2(skuRows.reduce((a, r) => a + r.wB.spendTax, 0));

  // Final is deliberately left unclamped (see buildWinCells below) because
  // that is what the seller's own workbook does — a return is dated by
  // request, not by its original order date, so it can legitimately belong to
  // an order placed before this window and outnumber this window's orders.
  // Clamping it to 0 would disagree with their workbook. Surfaced here as an
  // explicit, named list instead, so a negative Final reads as "a real return
  // against an earlier order", not as a bug in this report.
  const negativeFinalNote = (w: (r: SkuRow) => WindowAgg, label: string): string | null => {
    const hits = skuRows
      .filter((r) => r.sku !== UNMAPPED)
      .map((r) => ({ sku: r.sku, w: w(r) }))
      .filter(({ w }) => w.orderUnits - w.returns < 0);
    if (!hits.length) return null;
    return (
      `⚠ ${label}: Final (Orders − Returns) is negative for ${hits.length} SKU(s) — a return was recorded with no matching order in this window, so it belongs to an order placed in an earlier period ("returns without matching in-window order"). Left unclamped, matching the seller's own workbook: ` +
      hits.map((h) => `${h.sku} (Orders ${h.w.orderUnits}, Returns ${h.w.returns}, Final ${h.w.orderUnits - h.w.returns})`).join("; ") +
      "."
    );
  };
  const negativeFinalNote30 = negativeFinalNote((r) => r.wA, "Last 30 days");
  const negativeFinalNote7 = negativeFinalNote((r) => r.wB, "Last 7 days");

  const buildAvailCells = (m: SkuMeta): (string | number)[] => {
    if (!m.isFba && m.fbaTotal <= 0) return ["0", "", "", "", ""];
    const withStock = [...m.stateBalances.entries()].filter(([, v]) => v > 0).map(([st]) => st).sort();
    const available = withStock.length ? withStock.join(", ") : "0";
    // Same COUNTIF(states,0) semantic as the FBA status sheet's formula below:
    // only states the ledger reported and are currently 0 count as "not
    // available", not every account-wide state this SKU simply never shipped
    // to — that used to make almost every SKU read "No" here (accountStates
    // covers the whole account, not just the states this one SKU touched).
    const notAvailable = [...m.stateBalances.values()].filter((v) => v === 0).length;
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
  // Five lead columns, matching the seller's pivot: the composite Campaign*SKU
  // key it was grouped on, then the campaign and SKU it decomposes into. Both
  // key columns are literally headed "Row Labels" there (Excel's own pivot
  // caption) — kept verbatim so the sheets diff cleanly against each other.
  const LEAD_COLS = ["Row Labels", "Row Labels", "SKU ID", "FBA/MFN", "Price"];

  const label30 = `Last 30 days (${dotDate(win30.start)} to ${dotDate(win30.end)})`;
  const label7 = `Last 7 days (${dotDate(win7.start)} to ${dotDate(win7.end)})`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const header0: any[] = Array(LEAD_COLS.length).fill("");
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
    const final = w.orderUnits - w.returns; // unclamped — matches the Final Excel formula below
    return [w.spendTax, w.advUnits, w.totalUnits, w.orderUnits, w.returns, final, computeCpc(w), computeAcos(w, price), computeTacos(w, price)];
  };

  rows.forEach((row) => {
    const price = Math.round(row.meta.price);
    const skuLabel = row.sku === UNMAPPED ? "—" : row.sku;
    const campaignLabel = row.sku === UNMAPPED ? UNMAPPED_LABEL : (row.campaign || displayName(row.meta));
    aoa.push([
      `${campaignLabel}*${skuLabel}`, campaignLabel, skuLabel, row.meta.channel, price,
      ...buildWinCells(row.wA, row.meta.price),
      ...buildWinCells(row.wB, row.meta.price),
      ...buildAvailCells(row.meta),
    ]);
  });

  // Grand-total row. Spend+Tax and Advertised Units sum over the campaign x SKU
  // ROWS (each is that pair's own spend, so the sum is the account total), but
  // Total Units / Orders / Returns are SKU-grain figures repeated on every
  // campaign row for a SKU — summing the rows would count them once per
  // campaign. They are summed over the deduplicated per-SKU view instead.
  // CPC/ACOS/TACOS are recomputed from aggregated numerators and denominators,
  // never averaged from the per-row ratios.
  const shownSkus = new Set(rows.map((r) => r.sku));
  const totalRowCells = (getW: (r: Row) => WindowAgg, getSkuW: (r: SkuRow) => WindowAgg) => {
    let spendTax = 0, advUnits = 0, acosDenom = 0;
    rows.forEach((row) => {
      const w = getW(row);
      spendTax += w.spendTax;
      advUnits += w.advUnits;
      acosDenom += row.meta.price * w.advUnits;
    });
    // Only the SKUs actually listed above — skuRows also covers SKUs with orders
    // or stock but no ad activity, which have no row in this sheet, and totalling
    // them here would make the row larger than anything visible in the column.
    let totalUnits = 0, orderUnits = 0, returns = 0, tacosDenom = 0;
    skuRows.filter((r) => shownSkus.has(r.sku)).forEach((row) => {
      const w = getSkuW(row);
      totalUnits += w.totalUnits;
      orderUnits += w.orderUnits;
      returns += w.returns;
      tacosDenom += row.meta.price * Math.max(0, w.orderUnits - w.returns);
    });
    const final = Math.max(0, orderUnits - returns);
    return [
      spendTax, advUnits, totalUnits, orderUnits, returns, final,
      advUnits > 0 ? spendTax / advUnits : spendTax,
      acosDenom > 0 ? spendTax / acosDenom : 0,
      tacosDenom > 0 ? spendTax / tacosDenom : 0,
    ];
  };
  const gFbaTotal = skuRows.reduce((sum, r) => sum + r.meta.fbaTotal, 0);
  const grandRowIdx = aoa.length;
  aoa.push([
    "GRAND TOTAL", "", "", "", "",
    ...totalRowCells((r) => r.wA, (r) => r.wA),
    ...totalRowCells((r) => r.wB, (r) => r.wB),
    "", gFbaTotal, "", "", "",
  ]);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const totalCols = header1.length;
  const b30 = LEAD_COLS.length;
  const b7 = b30 + WIN_COLS.length;
  const bAvail = b7 + WIN_COLS.length;

  const priceCol = colLetter(LEAD_COLS.length - 1);
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

  // Merges: each window block spans its columns in row 0. The lead columns are
  // deliberately NOT merged down — their labels live in row 1 with row 0 left
  // blank above them, as in the seller's pivot. Merging would make Excel show
  // the (empty) row-0 cell and hide every lead label.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const merges: any[] = [];
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
      const isPriceCol = c === LEAD_COLS.length - 1;
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
      } else if (c === 0 || c === 1) {
        style.font = { color: { rgb: "111827" }, bold: true };
      } else if (c === 2) {
        style.font = { color: { rgb: "4338CA" }, bold: true };
      }
      cell.s = style;
    }
  }

  const cols = [{ wch: 52 }, { wch: 40 }, { wch: 24 }, { wch: 11 }, { wch: 10 }];
  for (let i = 0; i < 2; i++) {
    cols.push({ wch: 11 }, { wch: 13 }, { wch: 11 }, { wch: 9 }, { wch: 9 }, { wch: 8 }, { wch: 10 }, { wch: 9 }, { wch: 9 });
  }
  cols.push({ wch: 46 }, { wch: 11 }, { wch: 22 }, { wch: 24 }, { wch: 8 });
  ws["!cols"] = cols;
  ws["!rows"] = [{ hpt: 22 }, { hpt: 40 }];
  ws["!views"] = [{ state: "frozen", xSplit: LEAD_COLS.length, ySplit: 2 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Analysis report");

  // ═══════════════════════════════════════════════════════════════════════
  // ── TACOS sheet — dual block, matching the seller's original pivot: CPC
  // here = Spend+Tax ÷ Final orders (cost per net order), a DIFFERENT metric
  // than the Analysis report's CPC (÷ Advertised Units). TACOS = CPC ÷ Price
  // as a live formula (unlike the Analysis report, where it's a computed value).
  // ═══════════════════════════════════════════════════════════════════════
  // Keyed per SKU, not per campaign x SKU — TACOS measures a SKU's total ad cost
  // against its total net orders, so splitting it by campaign would be
  // meaningless (each row would divide one campaign's spend by the SKU's whole
  // order volume). Sorted by SKU in Excel's collation, and covering every SKU
  // with activity or stock, not just the advertised ones.
  const tacosRows = skuRows
    .filter((r) => r.sku !== UNMAPPED)
    .slice()
    .sort((a, b) => {
      const ka = excelSortKey(a.sku), kb = excelSortKey(b.sku);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  const TACOS_WIN_COLS = ["Spend+Tax", "Orders", "Returns", "Final orders", "CPC", "TACOS"];
  // Unlike the Analysis report, this sheet's lead labels sit in row 0 and are
  // merged DOWN over a blank row 1 — matching the seller's own TACOS pivot.
  const tHeader0: (string)[] = ["SKU ID", "Price", label30, "", "", "", "", "", label7, "", "", "", "", ""];
  const tHeader1: (string)[] = ["", "", ...TACOS_WIN_COLS, ...TACOS_WIN_COLS];
  const tacosAoa: (string | number)[][] = [tHeader0, tHeader1];
  const tacosWinCells = (w: WindowAgg, price: number) => {
    const final = w.orderUnits - w.returns;
    const cpc = final === 0 ? w.spendTax : w.spendTax / final;
    const tacos = price > 0 ? cpc / price : 0;
    return [w.spendTax, w.orderUnits, w.returns, final, cpc, tacos];
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
  // Per-SKU, not per campaign x SKU: stock on hand belongs to the SKU, so a SKU
  // advertised by two campaigns must still appear once with one stock figure.
  const fbaRows = skuRows.filter((r) => r.sku !== UNMAPPED && (r.meta.isFba || r.meta.fbaTotal > 0));
  const stateList = [...accountStates].sort();
  const fbaHeader = ["SKU ID", ...stateList, "Available", "Grand Total", "Inbound-shipped-quantity", "Number of FBA Not Available", "All FBA"];
  const fbaAoa: (string | number | undefined)[][] = [fbaHeader];
  fbaRows.forEach((row) => {
    // A state this SKU's ledger rows never mention must be a genuinely BLANK
    // cell — matching the seller's own workbook. COUNTIF(range,0) below only
    // counts real zero VALUES, never blanks, so writing 0 for every unstocked
    // state (regardless of whether the ledger ever tracked that state for this
    // SKU) made almost every SKU count as "not available" somewhere and broke
    // "All FBA" (showed "No" for nearly all of them). A state the ledger DOES
    // carry a row for, net zero, must still be a literal 0 — that is the
    // seller's own "not available there" signal (see the has() distinction in
    // the ledger-ingest block above).
    const stateVals = stateList.map((st) => (row.meta.stateBalances.has(st) ? row.meta.stateBalances.get(st) : undefined));
    const inbound = hasUploadedFbaInv ? (inboundShippedBySku.get(row.sku) || 0) : "—";
    fbaAoa.push([row.sku, ...stateVals, "", row.meta.fbaTotal, inbound, "", ""]);
  });
  const wsFba = XLSX.utils.aoa_to_sheet(fbaAoa);
  if (stateList.length > 0) {
    const stateColStart = colLetter(1);
    const stateColEnd = colLetter(stateList.length);
    const availCol = colLetter(1 + stateList.length);
    // Layout after the state block: Available(+1), Grand Total(+2),
    // Inbound-shipped-quantity(+3), Number of FBA Not Available(+4), All FBA(+5)
    // — offsets are relative to availCol, i.e. +3/+4 from here. This used to
    // read +2/+3, which landed COUNTIF on Inbound-shipped-quantity (silently
    // overwriting the real uploaded value with a formula) and IF on Number-of-
    // FBA-Not-Available, leaving the true All FBA column blank.
    const notAvailCol = colLetter(1 + stateList.length + 3);
    const allFbaCol = colLetter(1 + stateList.length + 4);
    for (let i = 0; i < fbaRows.length; i++) {
      const r = i + 2;
      const meta = fbaRows[i].meta;
      const ifParts = stateList
        .map((_, si) => {
          const letter = colLetter(1 + si);
          return `IF(${letter}${r}>0,$${letter}$1&", ","")`;
        })
        .join("&");
      // Each of these carries BOTH the formula (so the sheet stays live and
      // editable like the seller's own workbook) and a pre-computed value.
      // The value is not optional: xlsx-js-style DROPS a formula cell that has
      // no cached `v` when writing the file, so a formula-only cell vanished
      // entirely and these three columns arrived blank in every export.
      // Computed from the same state balances the formula ranges over, so the
      // two can't disagree — and Excel still recalculates on edit.
      const withStock = stateList.filter((st) => (meta.stateBalances.get(st) ?? 0) > 0);
      const availableVal = withStock.length ? withStock.join(", ") : "0";
      // Mirrors COUNTIF(states,0): only a state the ledger actually reported
      // and is currently zero counts as "not available" — a state this SKU
      // simply never shipped to is blank, and COUNTIF ignores blanks.
      const notAvailVal = stateList.filter((st) => meta.stateBalances.get(st) === 0).length;
      wsFba[`${availCol}${r}`] = { t: "s", v: availableVal, f: `TRIM(SUBSTITUTE(${ifParts},", "," ",LEN(${ifParts})-LEN(SUBSTITUTE(${ifParts},",",""))))` };
      wsFba[`${notAvailCol}${r}`] = { t: "n", v: notAvailVal, f: `COUNTIF(${stateColStart}${r}:${stateColEnd}${r},0)` };
      wsFba[`${allFbaCol}${r}`] = { t: "s", v: notAvailVal > 0 ? "No" : "Yes", f: `IF(${notAvailCol}${r}>0,"No","Yes")` };
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
    [...map.entries()].filter(([sku, w]) => sku !== UNMAPPED && w.orderUnits > 0).map(([sku, w]): [string, number] => [sku, w.orderUnits]).sort((a, b) => b[1] - a[1]);
  const topReturns = (map: Map<string, WindowAgg>) =>
    [...map.entries()].filter(([sku, w]) => sku !== UNMAPPED && w.returns > 0).map(([sku, w]): [string, number] => [sku, w.returns]).sort((a, b) => b[1] - a[1]);

  // Adspend by campaign x SKU — the same grain the Analysis report uses, so an
  // SB/SD campaign contributes one line per SKU it was split across rather than
  // hiding the split behind a single arbitrarily-chosen SKU.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function campaignSpendMap(rowsSp: any[], rowsSb: any[], rowsSd: any[]): Map<string, number> {
    const map = new Map<string, number>();
    const add = (campaignName: string | undefined, sku: string | undefined, spend: number | undefined) => {
      if (!campaignName) return;
      const key = `${campaignName}*${sku || ""}`;
      map.set(key, (map.get(key) || 0) + (spend || 0));
    };
    rowsSp.forEach((r) => add(r.campaign_name, r.advertised_sku, r.spend));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const addCampaignLevel = (r: any) => {
      const shares = campaignShares(r.campaign_name);
      if (!shares) { add(r.campaign_name, "", r.spend); return; }
      shares.forEach(({ sku, share }) => add(r.campaign_name, sku, (r.spend || 0) * share));
    };
    rowsSb.forEach(addCampaignLevel);
    rowsSd.forEach(addCampaignLevel);
    return map;
  }
  const topAdspendByCampaign = (map: Map<string, number>) =>
    [...map.entries()].filter(([, spend]) => spend > 0).map((e): [string, number] => [e[0], e[1]]).sort((a, b) => b[1] - a[1]);
  const topAdspendBySku = (map: Map<string, WindowAgg>) =>
    [...map.entries()].filter(([sku, w]) => sku !== UNMAPPED && w.spendTax > 0).map((e): [string, number, number] => [e[0], e[1].spendTax / GST_MULTIPLIER, e[1].advUnits]).sort((a, b) => b[1] - a[1]);

  const lbOrders30 = topOrders(skuRollA), lbOrders7 = topOrders(skuRollB);
  const lbReturns30 = topReturns(skuRollA), lbReturns7 = topReturns(skuRollB);
  const campSpend30 = campaignSpendMap(spRows, sbRows, sdRows);
  const campSpend7 = campaignSpendMap(spRows7, sbRows7, sdRows7);
  const lbAdCamp30 = topAdspendByCampaign(campSpend30), lbAdCamp7 = topAdspendByCampaign(campSpend7);
  const lbAdSku30 = topAdspendBySku(skuRollA), lbAdSku7 = topAdspendBySku(skuRollB);

  const lbRowCount = Math.max(
    lbOrders30.length, lbOrders7.length, lbReturns30.length, lbReturns7.length,
    lbAdCamp30.length, lbAdCamp7.length, lbAdSku30.length, lbAdSku7.length,
  );

  // Column layout mirrors the seller's sheet exactly: four 5-wide Adspend
  // groups, then two 3-wide Orders groups and two Returns groups (the last
  // without its trailing spacer) = 31 columns. Each group is its own
  // independently sorted top-N list, so a spacer column separates them and a
  // given row is NOT a joined record across groups.
  const LB_GROUPS: { width: number; label30: boolean }[] = [
    { width: 5, label30: true }, { width: 5, label30: false },   // Adspend by campaign*SKU
    { width: 5, label30: true }, { width: 5, label30: false },   // Adspend by SKU
    { width: 3, label30: true }, { width: 3, label30: false },   // Orders
    { width: 3, label30: true }, { width: 2, label30: false },   // Returns
  ];
  const lbStarts: number[] = [];
  LB_GROUPS.reduce((acc, g) => { lbStarts.push(acc); return acc + g.width; }, 0);
  const lbTotalCols = LB_GROUPS.reduce((s, g) => s + g.width, 0);

  // Row 0: the three section captions. Row 1: the window each group covers.
  // There is no third header row — the seller's sheet labels nothing further,
  // and the column meaning is fixed by position (key, spend, spend+tax, units).
  const lbHeader0: string[] = Array(lbTotalCols).fill("");
  lbHeader0[lbStarts[0]] = "Adspend";
  lbHeader0[lbStarts[4]] = "Orders";
  lbHeader0[lbStarts[6]] = "Returns";
  const lbHeader1: string[] = Array(lbTotalCols).fill("");
  LB_GROUPS.forEach((g, i) => { lbHeader1[lbStarts[i]] = g.label30 ? "30 days" : "7 days"; });

  const lbAoa: (string | number)[][] = [lbHeader0, lbHeader1];
  const spacer = (n: number) => Array(n).fill("") as (string | number)[];
  for (let i = 0; i < lbRowCount; i++) {
    lbAoa.push([
      // Adspend by campaign*SKU — no per-SKU unit count exists at this grain.
      lbAdCamp30[i]?.[0] ?? "", lbAdCamp30[i]?.[1] ?? "", "", ...spacer(2),
      lbAdCamp7[i]?.[0] ?? "", lbAdCamp7[i]?.[1] ?? "", "", ...spacer(2),
      // Adspend by SKU — key, spend, spend+tax, advertised units.
      lbAdSku30[i]?.[0] ?? "", lbAdSku30[i]?.[1] ?? "", "", lbAdSku30[i]?.[2] ?? "", "",
      lbAdSku7[i]?.[0] ?? "", lbAdSku7[i]?.[1] ?? "", "", lbAdSku7[i]?.[2] ?? "", "",
      lbOrders30[i]?.[0] ?? "", lbOrders30[i]?.[1] ?? "", "",
      lbOrders7[i]?.[0] ?? "", lbOrders7[i]?.[1] ?? "", "",
      lbReturns30[i]?.[0] ?? "", lbReturns30[i]?.[1] ?? "", "",
      lbReturns7[i]?.[0] ?? "", lbReturns7[i]?.[1] ?? "",
    ]);
  }
  const wsLb = XLSX.utils.aoa_to_sheet(lbAoa);
  // Spend+Tax stays a live formula (= Spend x 1.18) so the GST assumption is
  // visible and editable in the sheet rather than baked into a value.
  const lbSpendTaxCol = (groupIdx: number) => colLetter(lbStarts[groupIdx] + 2);
  for (let i = 0; i < lbRowCount; i++) {
    const r = i + 3; // 2 header rows
    // Campaign x SKU rows are [key, spend]; by-SKU rows add advertised units.
    const put = (groupIdx: number, present: readonly [string, number, ...number[]] | undefined) => {
      if (!present) return;
      const spendCol = colLetter(lbStarts[groupIdx] + 1);
      // Cached value as well as the formula — xlsx-js-style drops a formula
      // cell with no `v`, which silently blanked this whole column. present[1]
      // is the pre-tax spend, so this is the same arithmetic the formula shows.
      wsLb[`${lbSpendTaxCol(groupIdx)}${r}`] = { t: "n", v: present[1] * GST_MULTIPLIER, f: `${spendCol}${r}*${GST_MULTIPLIER}` };
    };
    put(0, lbAdCamp30[i]); put(1, lbAdCamp7[i]); put(2, lbAdSku30[i]); put(3, lbAdSku7[i]);
  }
  wsLb["!merges"] = [
    { s: { r: 0, c: lbStarts[0] }, e: { r: 0, c: lbStarts[4] - 1 } },
    { s: { r: 0, c: lbStarts[4] }, e: { r: 0, c: lbStarts[6] - 1 } },
    { s: { r: 0, c: lbStarts[6] }, e: { r: 0, c: lbTotalCols - 1 } },
    ...LB_GROUPS.map((g, i) => ({ s: { r: 1, c: lbStarts[i] }, e: { r: 1, c: lbStarts[i] + g.width - 1 } })),
  ];
  const lbGroupOf = (c: number) => {
    for (let i = LB_GROUPS.length - 1; i >= 0; i--) if (c >= lbStarts[i]) return i;
    return 0;
  };
  for (let r = 0; r <= 1; r++) {
    for (let c = 0; c < lbTotalCols; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (!wsLb[addr]) wsLb[addr] = { t: "s", v: "" };
      const fill = r === 0 ? "312E81" : LB_GROUPS[lbGroupOf(c)].label30 ? "4F46E5" : "6366F1";
      wsLb[addr].s = {
        font: { bold: true, color: { rgb: "FFFFFF" }, sz: r === 0 ? 11 : 10 },
        fill: { fgColor: { rgb: fill } },
        alignment: { horizontal: "center", vertical: "center", wrapText: true },
      };
    }
  }
  wsLb["!cols"] = Array.from({ length: lbTotalCols }, (_, c) => {
    const g = lbGroupOf(c);
    const offset = c - lbStarts[g];
    if (offset === 0) return { wch: g < 2 ? 46 : 22 };   // the key column
    if (offset >= LB_GROUPS[g].width - 1) return { wch: 3 }; // spacer
    return { wch: 12 };
  });
  wsLb["!views"] = [{ state: "frozen", ySplit: 2 }];
  XLSX.utils.book_append_sheet(wb, wsLb, "Orders, returns, adspend");


  // ── Raw sheets — verbatim dumps of the uploaded exports ───────────────────
  // Every uploaded row keeps its original CSV row in a `raw` JSON column, so
  // these sheets reproduce the seller's workbook column-for-column instead of a
  // hand-picked subset. Headers are the canonical export headers including their
  // quirks — the leading space in " Merchant SKU", the trailing one in
  // "is-prime " and "Date " — because the seller's own sheets key off those.
  //
  // A few columns in that workbook are not in Amazon's export at all; they were
  // derived in Excel (an IST timestamp beside the UTC purchase date, a date-only
  // column, the Campaign*SKU pivot key, the ledger's Area, the FBA return's
  // split date/time). Those are computed here so the sheet has no gaps.

  /** Match a header to a raw key ignoring case, spaces and punctuation, so a
   * header still resolves when the upload mangled it (the "₹" in
   * "7 Day Total Sales (₹)" arrives as "?" from some CSV encodings). */
  const normHeader = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

  // Derived columns get `get`, the same tolerant lookup the plain columns use, so
  // a header that arrives with different case/spacing still resolves. Reading
  // raw[...] directly would silently blank the column instead.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type RawResolver = (row: any, get: (header: string) => unknown) => unknown;

  /** Numbers arrive from CSV as strings; Excel should hold them as numbers.
   * Values with a meaningful leading zero (a "007" SKU) stay text. */
  function coerceScalar(v: unknown): unknown {
    if (typeof v !== "string") return v;
    const t = v.trim();
    if (!t) return "";
    if (/^0\d/.test(t)) return v;
    if (!/^-?\d*\.?\d+(e[+-]?\d+)?$/i.test(t)) return v;
    const n = Number(t);
    return Number.isFinite(n) ? n : v;
  }

  function buildRawSheet(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dataRows: any[],
    headers: string[],
    derived: Record<string, RawResolver> = {},
    /** Headers holding Excel serials, mapped to the format to display them with. */
    dateFormats: Record<string, string> = {},
  ) {
    // The raw key set is the same for every row of one upload, but union across
    // rows anyway so a partially-populated upload cannot drop a whole column.
    const keyIndex = new Map<string, string>();
    dataRows.forEach((r) => {
      const raw = (r?.raw || {}) as Record<string, unknown>;
      Object.keys(raw).forEach((k) => {
        const n = normHeader(k);
        if (!keyIndex.has(n)) keyIndex.set(n, k);
      });
    });
    // Blanks are emitted as null, NOT "": aoa_to_sheet skips null and writes no
    // cell at all, while "" writes a real (empty) cell. These exports are sparse
    // — most rows leave promotion, gift-wrap and SafeT columns empty — so on
    // ~470k cells that difference is several MB of XML.
    const rawAoa: unknown[][] = [headers];
    dataRows.forEach((r) => {
      const raw = (r?.raw || {}) as Record<string, unknown>;
      const get = (header: string): unknown => {
        const key = keyIndex.get(normHeader(header));
        return key === undefined ? undefined : raw[key];
      };
      rawAoa.push(headers.map((h) => {
        const d = derived[h];
        if (d) {
          const dv = d(r, get);
          return dv === undefined || dv === null || dv === "" ? null : dv;
        }
        const v = get(h);
        if (v === undefined || v === null) return null;
        const c = coerceScalar(v);
        return c === "" ? null : c;
      }));
    });
    const rws = XLSX.utils.aoa_to_sheet(rawAoa, { cellDates: true });
    // Give the serial columns a date number format, otherwise Excel shows the
    // bare serial (46225.9) instead of a date.
    Object.entries(dateFormats).forEach(([header, fmt]) => {
      const c = headers.indexOf(header);
      if (c < 0) return;
      for (let r = 1; r < rawAoa.length; r++) {
        const cell = rws[XLSX.utils.encode_cell({ r, c })];
        if (cell && typeof cell.v === "number") cell.z = fmt;
      }
    });
    for (let c = 0; c < headers.length; c++) {
      const addr = XLSX.utils.encode_cell({ r: 0, c });
      if (!rws[addr]) continue;
      rws[addr].s = {
        font: { bold: true, color: { rgb: "FFFFFF" } },
        fill: { fgColor: { rgb: "4F46E5" } },
        alignment: { horizontal: "center", vertical: "center" },
      };
    }
    rws["!cols"] = headers.map((h) => ({ wch: Math.min(42, Math.max(12, h.length + 4)) }));
    rws["!views"] = [{ state: "frozen", ySplit: 1 }];
    return rws;
  }

  // Date cells are written as raw Excel SERIAL NUMBERS, not JS Dates. SheetJS
  // converts a Date using the HOST machine's timezone offset, so a Date already
  // shifted into IST comes out shifted twice (+11:00) on an IST box and not at
  // all on a UTC one — the same code would produce different spreadsheets on a
  // laptop and on the deploy host. A serial carries no timezone, so the value is
  // whatever wall clock we compute here and nothing re-interprets it.
  const EXCEL_EPOCH_OFFSET = 25569; // days from 1899-12-30 to 1970-01-01
  const MS_PER_DAY = 86400000;
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const EXCEL_DATETIME_FMT = "yyyy-mm-dd hh:mm:ss";
  const EXCEL_DATE_FMT = "yyyy-mm-dd";

  /** UTC instant -> Excel serial for the same moment in IST wall-clock time. */
  function istSerial(v: unknown): number | null {
    if (!v) return null;
    const ms = new Date(String(v)).getTime();
    if (Number.isNaN(ms)) return null;
    return (ms + IST_OFFSET_MS) / MS_PER_DAY + EXCEL_EPOCH_OFFSET;
  }
  /** Same, truncated to midnight of the IST calendar day. */
  function istDateSerial(v: unknown): number | null {
    const s = istSerial(v);
    return s === null ? null : Math.floor(s);
  }
  /** A plain 'YYYY-MM-DD' -> Excel serial, no timezone involved. */
  function isoDateSerial(v: unknown): number | null {
    const s = String(v || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    return Math.floor(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / MS_PER_DAY) + EXCEL_EPOCH_OFFSET;
  }
  const isoDatePart = (v: unknown): string => (v ? String(v).slice(0, 10) : "");
  const isoTimePart = (v: unknown): string => {
    const s = String(v || "");
    const m = s.match(/[T ](\d{2}:\d{2}:\d{2})/);
    return m ? m[1] : "";
  };

  // ── "Price" — the full All-Listings export (the seller's workbook calls this
  // sheet Price; it is the same 48-column dump, not a trimmed price list).
  const PRICE_HEADERS = [
    "item-name", "item-description", "listing-id", "seller-sku", "price", "quantity", "open-date",
    "image-url", "item-is-marketplace", "product-id-type", "zshop-shipping-fee", "item-note",
    "item-condition", "zshop-category1", "zshop-browse-path", "zshop-storefront-feature",
    "asin1", "asin2", "asin3", "will-ship-internationally", "expedited-shipping", "zshop-boldface",
    "product-id", "bid-for-featured-placement", "add-delete", "pending-quantity", "fulfillment-channel",
    "Business Price", "Quantity Price Type", "Quantity Lower Bound 1", "Quantity Price 1",
    "Quantity Lower Bound 2", "Quantity Price 2", "Quantity Lower Bound 3", "Quantity Price 3",
    "Quantity Lower Bound 4", "Quantity Price 4", "Quantity Lower Bound 5", "Quantity Price 5",
    "optional-payment-type-exclusion", "Progressive Price Type", "Progressive Lower Bound 1",
    "Progressive Price 1", "Progressive Lower Bound 2", "Progressive Price 2",
    "Progressive Lower Bound 3", "Progressive Price 3", "maximum-retail-price",
  ];
  XLSX.utils.book_append_sheet(wb, buildRawSheet(priceListingRows, PRICE_HEADERS), "Price");

  // ── "AM orders" — Seller Central order export, plus the two Excel-derived
  // columns the seller's sheet carries next to the UTC purchase date.
  const AM_ORDER_HEADERS = [
    "amazon-order-id", "merchant-order-id", "purchase-date", "IST with Time", "Date ",
    "last-updated-date", "order-status", "fulfillment-channel", "sales-channel", "order-channel",
    "url", "ship-service-level", "product-name", "sku", "asin", "item-status", "quantity", "currency",
    "item-price", "item-tax", "shipping-price", "shipping-tax", "gift-wrap-price", "gift-wrap-tax",
    "item-promotion-discount", "ship-promotion-discount", "ship-city", "ship-state",
    "ship-postal-code", "ship-country", "promotion-ids", "is-business-order", "purchase-order-number",
    "price-designation", "fulfilled-by", "is-iba", "order-item-id", "is-prime ",
  ];
  // Both fall back to the parsed DB column, so these stay populated even if the
  // export's own date header changes.
  XLSX.utils.book_append_sheet(wb, buildRawSheet(orderRows, AM_ORDER_HEADERS, {
    "IST with Time": (r, get) => istSerial(get("purchase-date") ?? r.purchase_date),
    "Date ": (r, get) => istDateSerial(get("purchase-date") ?? r.purchase_date),
  }, {
    "IST with Time": EXCEL_DATETIME_FMT,
    "Date ": EXCEL_DATE_FMT,
  }), "AM orders");

  // ── "AM returns" — Seller Central return-requests export, verbatim.
  const AM_RETURN_HEADERS = [
    "Order ID", "Order date", "Return request date", "Return request status", "Amazon RMA ID",
    "Seller RMA ID", "Label type", "Label cost", "Currency code", "Return carrier", "Tracking ID",
    "Label to be paid by", "A-to-z claim", "Is prime", "ASIN", " Merchant SKU", "Item Name",
    "Return quantity", "Return reason", "In policy", "Return type", "Resolution", "Invoice number",
    "Return delivery date", "Order Amount", "Order quantity", "SafeT Action reason", "SafeT claim ID",
    "SafeT claim state", "SafeT claim creation time", "SafeT claim reimbursement amount",
    "Refunded Amount", "Category", "Order Item ID",
  ];
  XLSX.utils.book_append_sheet(wb, buildRawSheet(amReturnRows, AM_RETURN_HEADERS), "AM returns");

  // ── "FBA returns" — FBA customer returns. Amazon ships one ISO timestamp;
  // the seller's sheet splits it into a date and a time column.
  const FBA_RETURN_HEADERS = [
    "return-date", "return-time", "order-id", "sku", "asin", "fnsku", "product-name", "quantity",
    "fulfillment-center-id", "detailed-disposition", "reason", "license-plate-number",
    "customer-comments",
  ];
  XLSX.utils.book_append_sheet(wb, buildRawSheet(fbaReturnRows, FBA_RETURN_HEADERS, {
    "return-date": (r, get) => isoDatePart(get("return-date") ?? r.return_date),
    "return-time": (r, get) => isoTimePart(get("return-date") ?? r.return_date),
  }), "FBA returns");

  // ── "SF returns" — SellerFlex (self-fulfilled) returns, verbatim.
  const SF_RETURN_HEADERS = [
    "Return Type", "Customer Order ID", "Shipment ID", "SKU", "mSKU", "ASIN", "External ID1",
    "External ID2", "External ID3", "Units", "Forward Leg Tracking ID", "Reverse Leg Tracking ID",
    "RMA ID", "Return Status", "Carrier", "Pick -up date", "Last Updated On", "Returned with OTP",
    "Days In-transit", "Days Since Return Complete", "Return Reason",
  ];
  XLSX.utils.book_append_sheet(wb, buildRawSheet(sfReturnRows, SF_RETURN_HEADERS), "SF returns");

  // ── "Adspend" — the Sponsored Products advertised-product export, PLUS one
  // row per (Sponsored Brands/Display campaign x mapped SKU) carrying that
  // SKU's weighted share of the campaign's spend. Amazon gives no SKU on those
  // campaigns, so the seller appends exactly such rows by hand; generating them
  // here is what lets this sheet reconcile with the Analysis report.
  const ADSPEND_HEADERS = [
    "Start Date", "End Date", "Portfolio name", "Currency", "Campaign Name", "Ad Group Name",
    "Advertised SKU", "Campaign Name*Advertised SKU", "Advertised ASIN", "Impressions", "Clicks",
    "Click-Thru Rate (CTR)", "Cost Per Click (CPC)", "Spend", "7 Day Total Sales (₹)",
    "Total Advertising Cost of Sales (ACOS) ", "Total Return on Advertising Spend (ROAS)",
    "7 Day Total Orders (#)", "7 Day Total Units (#)", "7 Day Conversion Rate",
    "7 Day Advertised SKU Units (#)", "7 Day Other SKU Units (#)", "7 Day Advertised SKU Sales (₹)",
    "7 Day Other SKU Sales (₹)",
  ];
  interface AdSheetRow {
    raw: Record<string, unknown>;
    date: string;
    campaign: string;
    sku: string;
    spend: number;
    advUnits: number;
    /** True for a synthesized SB/SD share row: no ad group or ASIN exists. */
    split: boolean;
  }
  const adSheetRows: AdSheetRow[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spRows.forEach((r: any) => adSheetRows.push({
    raw: r.raw || {}, date: r.report_date, campaign: r.campaign_name || "", sku: r.advertised_sku || "",
    spend: r.spend || 0, advUnits: r.advertised_sku_units_7d || r.advertised_sku_units || 0, split: false,
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pushCampaignAdSheetRows = (r: any) => {
    const shares = campaignShares(r.campaign_name);
    // Advertised SKU Units stay 0 on these rows for the same reason as in
    // aggregateWindow: the units are campaign-level and cannot be apportioned.
    if (!shares) {
      adSheetRows.push({ raw: r.raw || {}, date: r.report_date, campaign: r.campaign_name || "", sku: "", spend: r.spend || 0, advUnits: 0, split: true });
      return;
    }
    shares.forEach(({ sku, share }) => adSheetRows.push({
      raw: r.raw || {}, date: r.report_date, campaign: r.campaign_name || "", sku,
      spend: (r.spend || 0) * share, advUnits: 0, split: true,
    }));
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sbRows.forEach((r: any) => pushCampaignAdSheetRows(r));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sdRows.forEach((r: any) => pushCampaignAdSheetRows(r));
  adSheetRows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  XLSX.utils.book_append_sheet(wb, buildRawSheet(adSheetRows, ADSPEND_HEADERS, {
    // Both date columns carry the row's own day: these are daily exports, so a
    // row's reporting period starts and ends on the same date.
    "Start Date": (r) => isoDateSerial(r.date),
    "End Date": (r) => isoDateSerial(r.date),
    "Campaign Name": (r) => r.campaign,
    "Advertised SKU": (r) => r.sku,
    "Campaign Name*Advertised SKU": (r) => `${r.campaign}*${r.sku}`,
    "Spend": (r) => r.spend,
    "7 Day Advertised SKU Units (#)": (r) => r.advUnits,
    // A split SB/SD row has no ad group or advertised ASIN to report.
    "Ad Group Name": (r, get) => (r.split ? "" : get("Ad Group Name") ?? ""),
    "Advertised ASIN": (r, get) => (r.split ? "" : get("Advertised ASIN") ?? ""),
  }, {
    "Start Date": EXCEL_DATE_FMT,
    "End Date": EXCEL_DATE_FMT,
  }), "Adspend");

  // ── "Inventory ledger" — the ledger export plus the Area column the seller
  // derives from Location with an IFS formula.
  const LEDGER_HEADERS = [
    "Date", "FNSKU", "ASIN", "MSKU", "Title", "Disposition", "Starting Warehouse Balance",
    "In Transit Between Warehouses", "Receipts", "Customer Shipments", "Customer Returns",
    "Vendor Returns", "Warehouse Transfer In/Out", "Found", "Lost", "Damaged", "Disposed",
    "Other Events", "Ending Warehouse Balance", "Unknown Events", "Location", "Area",
  ];
  XLSX.utils.book_append_sheet(wb, buildRawSheet(ledgerRawEffective, LEDGER_HEADERS, {
    Area: (r, get) => fcToState(String(get("Location") ?? r.location ?? "")),
  }), "Inventory ledger");

  // ── "FBA inventory" — the FBA inventory snapshot, verbatim.
  const FBA_INVENTORY_HEADERS = [
    "sku", "fnsku", "asin", "product-name", "condition", "your-price", "mfn-listing-exists",
    "mfn-fulfillable-quantity", "afn-listing-exists", "afn-warehouse-quantity",
    "afn-fulfillable-quantity", "afn-unsellable-quantity", "afn-reserved-quantity",
    "afn-total-quantity", "per-unit-volume", "afn-inbound-working-quantity",
    "afn-inbound-shipped-quantity", "afn-inbound-receiving-quantity", "afn-researching-quantity",
    "afn-reserved-future-supply", "afn-future-supply-buyable", "store",
  ];
  XLSX.utils.book_append_sheet(wb, buildRawSheet(fbaInventoryRows, FBA_INVENTORY_HEADERS), "FBA inventory");

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
  // Per-SKU, not per campaign x SKU — otherwise a SKU advertised by two
  // campaigns would have its stock counted twice into its states.
  skuRows.forEach((row) => {
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
  // Same split of grains as the Analysis report's total row: spend/ad-units over
  // the campaign x SKU rows, orders/returns over the deduplicated per-SKU view.
  const [gSpendTax, , , gOrderUnits, gReturns] = totalRowCells((r) => r.wA, (r) => r.wA);
  const gAcosDenomKey = rows.reduce((s, r) => s + r.meta.price * r.wA.advUnits, 0);
  const gTacosDenomKey = skuRows.reduce((s, r) => s + r.meta.price * Math.max(0, r.wA.orderUnits - r.wA.returns), 0);
  const unmappedSpend30 = skuRollA.get(UNMAPPED)?.spendTax || 0;

  // ── Key Insights & Recommendations sheet ──
  const insightsAoa: (string | number)[][] = [
    ["🔍 KEY INSIGHTS & RECOMMENDATIONS (Last 30 days)", "", "", "", "", "", "", ""],
    ["Window", `${dotDate(win30.start)} to ${dotDate(win30.end)}`, "", "", "", "", "", ""],
    ["", "", "", "", "", "", "", ""],
    ["📊 PERFORMANCE SUMMARY", "", "", "", "", "", "", ""],
    ["Campaign x SKU Rows Analyzed", rows.filter((r) => r.sku !== UNMAPPED).length, "", "", "", "", "", ""],
    ["Distinct SKUs Analyzed", skuRows.filter((r) => r.sku !== UNMAPPED).length, "", "", "", "", "", ""],
    ["Total Spend+Tax", gSpendTax, "", "", "", "", "", ""],
    ["Total Orders (units)", gOrderUnits, "", "", "", "", "", ""],
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
    [`Data pulled at: ${dataPulledAt} (compare this against the Weekly Sales Report's own "Data pulled at" — the two files disagree on a SKU whenever they were generated far enough apart to see different uploads, not because either one is wrong).`],
    [""],
    ["Every figure here comes from the manually uploaded reports (Upload Reports page). The live SellerMate API is NOT called at all — not for spend, orders, returns, price, channel or FBA stock. That is what lets both trailing windows be recomputed from a fixed historical upload instead of only 'as of today', and it means a missing upload shows up as missing data (flagged below) rather than being filled in with today's snapshot."],
    ["Analysis report / TACOS sheets: both windows always end on the same date and are recomputed from the SAME 30-day fetch — the 7-day block is simply the last 7 days of that data, not a separate query."],
    ["GRAIN — the Analysis report has ONE ROW PER CAMPAIGN x SKU. Only Spend+Tax and Advertised SKU Units are per-campaign. Total Units, Orders and Returns belong to the SKU (Amazon reports them per SKU, never per campaign), so a SKU advertised by two campaigns — most commonly one campaign per fulfillment channel, e.g. an FBA campaign and an MFN campaign for the same SKU — shows the SAME Orders/Returns on BOTH of its rows. Summing this sheet's Orders column therefore double-counts every such SKU (looks like ~2x for a dual-channel SKU with exactly one campaign per channel). For a genuine per-SKU total, either read the GRAND TOTAL row (which deliberately sums Orders/Returns/Total Units over distinct SKUs, not over rows, and so will not equal a plain SUM() of the column above it) or the TACOS sheet, which is already one row per SKU."],
    ["A SKU that had orders or returns this window but was never advertised and carries no FBA stock still gets a row here (Row Labels blank campaign, falls back to its product name) — Orders/Returns are real, Spend+Tax and Advertised SKU Units are correctly 0. Previously such SKUs were left out of this sheet entirely (it only covered advertised/FBA-tracked SKUs), which is why a plain SKU export could show far fewer rows here than on the order-driven Weekly Sales Report."],
    ["Sponsored Brands / Display spend is only ever known per campaign (Amazon's own export has no SKU column). Each such campaign's spend is split across the SKUs assigned to it on the Upload Reports page, in proportion to the WEIGHT given to each. Weights are relative, so {2,1,1} and {50,25,25} split identically. Campaigns with no mapping at all are grouped under the '⚠ Unmapped SB/SD campaigns' row rather than being dropped, so their spend still appears in the totals."],
    ["Spend+Tax = ad spend x 1.18 (18% GST) — computed from each row's raw 'spend' field, summed per campaign x SKU, then multiplied once by 1.18. Not a formula in the Analysis report/TACOS sheets (matches the original workbook), but is a live formula (Spend x 1.18) in the 'Orders, returns, adspend' sheet."],
    ["Orders = the SUM OF ORDER QUANTITY for the SKU (units ordered), NOT the number of order records — matching the seller's own pivot. CANCELLED orders are excluded: they were never sold, so counting them would inflate Orders and depress ACOS/TACOS."],
    ["Total Units (#) = the SKU's ad-attributed units across ALL its campaigns, so it is the same on every campaign row for that SKU, while Advertised SKU Units (#) is just that one campaign's share. For a SKU advertised by a single campaign the two columns are equal."],
    ["Advertised SKU Units is 0 on Sponsored Brands / Display rows. Amazon attributes those units to the campaign, never to a SKU, so apportioning them by the spend weights would invent fractional units (a third of a sale) and then divide spend by them in CPC. Only Sponsored Products units — which are genuinely per-SKU in the export — are counted."],
    ["Final = Orders - Returns. CPC (Analysis report) = Spend+Tax / Advertised SKU Units. ACOS = CPC / Price. TACOS = Spend+Tax / (Price x Final)."],
    ["TACOS sheet is keyed PER SKU (not per campaign x SKU): it measures a SKU's whole ad cost against its whole net order volume, so splitting it by campaign would divide one campaign's spend by the SKU's total orders. Its CPC is also a DIFFERENT metric from the Analysis report's: here CPC = Spend+Tax / Final orders (cost per net order), matching the seller's original workbook. TACOS (= CPC / Price) comes out the same either way."],
["Returns = AM returns for a SKU if any were recorded, otherwise FBA + SF returns for that SKU (courier RTO / undeliverable included either way) — matching the seller's own workbook. AM and FBA/SF returns can both record the same physical return, so they aren't simply added together; the raw rows are on the 'AM returns', 'FBA returns' and 'SF returns' sheets if you need a different figure."],
    [
      hasUploadedPrice
        ? "Price and FBA/MFN channel come from the uploaded Price (All Listings) report."
        : "⚠ NO Price (All Listings) report uploaded — Price reads 0 for every SKU, and because ACOS and TACOS both divide by Price they read 0 too. Those two columns are therefore NOT usable in this file. Upload the Price report and regenerate. (Nothing is substituted from the live catalog: today's price is not the price this window sold at.)",
    ],
    [
      hasUploadedLedger
        ? (ledgerIsAfterWindow
            ? `⚠ FBA availability comes from the uploaded Inventory Ledger snapshot dated ${dotDate(ledgerAsOf!)}, which is AFTER this report's window (ends ${dotDate(win30.end)}) — the ledger is a point-in-time stock snapshot, not a per-day history, and no snapshot on or before the window end has been uploaded. So the stock/state figures describe ${dotDate(ledgerAsOf!)}, not the report period. Upload a ledger dated on or before ${dotDate(win30.end)} for a true as-of reading.`
            : `FBA availability comes from the uploaded Inventory Ledger snapshot dated ${dotDate(ledgerAsOf!)} (the latest SELLABLE balance per SKU/location on or before ${dotDate(win30.end)}) — not today. Not time-windowed like the ad/order metrics: it's a single snapshot shared by both the 30-day and 7-day blocks.`)
        : "⚠ NO Inventory Ledger report uploaded — there is no per-state FBA stock in this file, so the FBA status sheet has no state columns and the Available column reads 0. Upload the Inventory Ledger and regenerate. (Nothing is substituted from the live inventory feed: today's balances do not describe this window.)",
    ],
    [
      hasUploadedFbaInv
        ? "Inbound-shipped-quantity comes from the uploaded FBA Inventory report."
        : "Inbound-shipped-quantity shows '—': no FBA Inventory report has been uploaded.",
    ],
    ["FBA status sheet: per-state stock pivot for FBA SKUs only (a snapshot, not time-windowed), with the same Available / Number of FBA Not Available / All FBA formulas as the seller's original workbook."],
    ["Price / AM orders / AM returns / FBA returns / SF returns / Adspend / Inventory ledger / FBA inventory sheets: verbatim dumps of the uploaded exports, every original column kept (each uploaded row stores its source CSV row, so nothing is trimmed). A few columns in these sheets are DERIVED, not from Amazon: 'IST with Time' and 'Date ' on AM orders (from the UTC purchase-date), 'return-time' on FBA returns (split out of return-date), 'Area' on Inventory ledger (from Location), and on Adspend the 'Start/End Date' pair plus the 'Campaign Name*Advertised SKU' pivot key."],
    ["Adspend sheet also carries one synthesized row per (Sponsored Brands/Display campaign x mapped SKU) holding that SKU's weighted share of the campaign's spend — those rows have a blank Ad Group Name and Advertised ASIN, because neither exists at campaign grain. This is what makes the sheet reconcile with the Analysis report."],
    ["SF returns sheet: raw dump of uploaded SellerFlex (self-fulfilled) returns for the 30-day window, if any were uploaded. Folded into the Returns / Final / ACOS / TACOS figures elsewhere in this workbook, same as AM returns + FBA returns."],
    ["'Orders, returns, adspend' sheet: 4 independent top-N lists side by side (Adspend by campaign x SKU, Adspend by SKU, Orders by SKU, Returns by SKU), each split into its own 30-day/7-day pair — a given row is NOT a joined record; the SKU in the Orders columns has no relation to whatever SKU appears in the Returns columns of that same row."],
    ["Key Insights sheet: State-wise analysis and recommendations are based on the 30-day window only."],
    ["A delisted/discontinued SKU's leftover FBA stock no longer pulls it into the TACOS/FBA-status sheets on its own once the uploaded Price (All Listings) report marks it 'Inactive' AND it had no orders, returns or ad spend in the 30-day window — that combination was the source of SKUs appearing ONLY in this report and never in the order-driven Weekly Sales Report. A SKU with any real activity this window still appears regardless of listing status; an account without a Status column in its Price upload is unaffected (treated as unknown, not inactive)."],
    ...(negativeFinalNote30 ? [[negativeFinalNote30]] : []),
    ...(negativeFinalNote7 ? [[negativeFinalNote7]] : []),
  ]);
  wsNote["!cols"] = [{ wch: 110 }];
  wsNote["A1"].s = { font: { bold: true, sz: 13, color: { rgb: "312E81" } } };
  XLSX.utils.book_append_sheet(wb, wsNote, "Notes");

  // Tab order, to match the seller's own workbook. The sheets are built in
  // dependency order above (aggregates before the dumps they reconcile against),
  // so the final order is applied here instead: SheetNames is what the writer
  // walks, and Sheets is keyed by name, so reordering this array is sufficient.
  // Any sheet not listed keeps its build order at the end — that is how the two
  // extra analytical tabs (Key Insights, Notes) stay after the matched twelve.
  const SHEET_ORDER = [
    "Analysis report", "TACOS", "Price", "FBA status", "Orders, returns, adspend",
    "FBA returns", "AM returns", "SF returns", "AM orders", "Adspend",
    "Inventory ledger", "FBA inventory",
  ];
  wb.SheetNames.sort((a, b) => {
    const ia = SHEET_ORDER.indexOf(a), ib = SHEET_ORDER.indexOf(b);
    return (ia < 0 ? SHEET_ORDER.length : ia) - (ib < 0 ? SHEET_ORDER.length : ib);
  });

  // Marketplace-prefixed so an Amazon and a Flipkart export of the same window
  // don't sit in Downloads as near-identical names (the Flipkart builder already
  // prefixes; this one used to be the odd one out).
  const filename = `Amazon_Historical_Analysis_Report_${win30.start}_to_${endDate}.xlsx`;
  return {
    wb,
    filename,
    // rows are campaign x SKU pairs now, so report both — the pair count is what
    // the Analysis report's length reflects, the SKU count is what a seller means
    // by "how many products".
    skuCount: skuRows.length,
    pairCount: rows.length,
    unmappedCampaignSpend: unmappedSpend30,
    totalSpend30,
    totalSpend7,
    topWorstAcos,
  };
}

/**
 * No API key parameter by design — this report reads only the uploaded tables
 * (enforced by the no-restricted-imports rule for this file in
 * eslint.config.mjs). `account` is used for the display name on the Notes sheet.
 */
export async function exportHistoricalAnalysisReport(opts: {
  endDate?: string;
  account: { id?: string; workspace_id?: string; name?: string } | null | undefined;
}) {
  const { account } = opts;
  const endDate = opts.endDate || new Date().toISOString().slice(0, 10);

  const { wb, filename, ...stats } = await buildHistoricalAnalysisReportWorkbook({
    accountName: account?.name,
    endDate,
  });
  // bookSST forces a shared-string table instead of xlsx-js-style's default of
  // inlining every string cell — with thousands of Orders rows repeating the
  // same ~150-char product names, this is the difference between an ~8MB and
  // ~1.5MB file for the same data.
  //
  // compression DEFLATEs the zip entries; without it the parts are STORED, and
  // since the raw-dump sheets are highly repetitive XML that alone accounts for
  // most of the file. An .xlsx is a zip either way, so both open identically.
  XLSX.writeFile(wb, filename, { bookSST: true, compression: true });
  return { filename, ...stats };
}
