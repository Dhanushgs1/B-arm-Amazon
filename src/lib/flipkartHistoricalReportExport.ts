import * as XLSX from "xlsx-js-style";
import { fetchAllRows } from "@/lib/amazonReportShared";
import { FK_REPORT_LABEL } from "@/lib/flipkartReportUpload";
import { fetchMisFkOrders, fetchMisFkReturns } from "@/lib/misAdapters";

// ── Flipkart Historical Analysis Report ─────────────────────────────────────
// The Flipkart counterpart of historicalAnalysisReportExport.ts: the same
// dual-block "Last 30 days | Last 7 days" Analysis-report layout, built from the
// four raw exports uploaded on /dashboard/flipkart/upload rather than from a
// live API (Flipkart exposes no ads API at all, so uploaded files are the only
// source of truth here).
//
// Both windows always end on the same date — "Last 30 days" is that date and the
// 29 before it, "Last 7 days" that date and the 6 before it — and the 7-day block
// is filtered in memory out of the same 30-day fetch, so the two can never
// disagree and there is no second round-trip.
//
// That end date is the dashboard's selected end date, verbatim — it is never
// moved. If the newest uploaded row predates it, the window still runs to the
// selected date and the Notes sheet carries a warning naming the gap
// (dataThrough / staleDays). An earlier version silently pulled the end date
// back to the latest date with data, which meant the period the seller asked
// for was not the period they got, and the workbook could not be reconciled
// against their own pivots.
//
// Where the numbers come from, and why:
//
//   Spend / ad units / ad revenue   FSN report (per campaign x ad group x SKU,
//                                   one file per day)
//   Orders / Returns                Order report (order-item level, by status —
//                                   see aggregateWindow). Earn more is used only
//                                   for revenue (Final Sale Value, Price fallback)
//                                   since it carries no per-order-item status.
//   Stock / listing price / status  barm_flipkart_listings snapshot
//
// Unlike Amazon, Flipkart's ad export IS per-SKU for every campaign type, so
// there is no campaign -> SKU weighting step and no "unmapped campaign" bucket:
// every rupee of spend already knows its SKU.

const GST_MULTIPLIER = 1.18;
// Placeholder "campaign" for a SKU with real Order-report activity but no FSN
// ad row at all in the window — mirrors Amazon's unmapped-campaign bucket.
// Without this the SKU has no pair row, so it vanishes from the Analysis
// report and its Orders/Returns are excluded from the GRAND TOTAL, even
// though the sale genuinely happened.
const NO_ADS = "(no ads data)";

const FSN_TABLE = "barm_flipkart_fsn_report";
const EARN_MORE_TABLE = "barm_flipkart_earn_more";
const LISTINGS_TABLE = "barm_flipkart_listings";
// Orders/Returns moved to the MIS-synced fk_orders/fk_returns tables (see
// misAdapters.ts) — this report used to read barm_flipkart_order_report/
// barm_flipkart_returns directly, the CSV-upload tables, which sit behind
// the live MIS feed (5,211 order rows vs fk_orders' 6,723 for the identical
// window, verified directly against Supabase) even though
// flipkartWeeklySalesExport.ts and adSpendReportExport.ts already made this
// switch. fetchMisFkOrders/fetchMisFkReturns map every row into the exact
// same field shape parseOrderReport/parseReturnsReport produced, so nothing
// below this — aggregateWindow, the raw-dump sheets — needed to change.

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

/** Latest value of `col` in `table` on or before `cap` — a 1-row query via the
 * same paginated fetcher (order + limit(1) means the first page is the whole
 * answer, so it never actually paginates). */
async function fetchMaxDate(table: string, col: string, cap: string): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await fetchAllRows(table, (q: any) => q.lte(col, cap).order(col, { ascending: false }).limit(1));
  return (rows[0] as Record<string, string> | undefined)?.[col]?.slice(0, 10) ?? null;
}

// Excel's collation ignores punctuation, so "B-CT-G" sorts next to "BCTG", not
// before every unhyphenated SKU. Match it so the sheet lines up with the
// seller's own pivots.
function excelSortKey(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ── aggregates ──────────────────────────────────────────────────────────────

/** Per campaign x SKU — only these two differ between two rows of one SKU. */
interface PairAgg {
  spendTax: number;
  adUnits: number;
  adRevenue: number;
}
/** Per SKU — repeated on each of that SKU's campaign rows (see the Notes sheet). */
interface SkuAgg {
  adUnitsTotal: number;
  orderUnits: number;
  returns: number;
  saleAmount: number;
}
interface WindowAgg {
  spendTax: number;
  adUnits: number;
  adRevenue: number;
  totalUnits: number;
  orderUnits: number;
  returns: number;
}
const emptyWindowAgg = (): WindowAgg => ({
  spendTax: 0, adUnits: 0, adRevenue: 0, totalUnits: 0, orderUnits: 0, returns: 0,
});

function computeCpc(w: WindowAgg): number {
  return w.adUnits > 0 ? w.spendTax / w.adUnits : w.spendTax;
}
function computeAcos(w: WindowAgg, price: number): number {
  return price > 0 ? computeCpc(w) / price : 0;
}
// No computeTacos here on purpose: the seller's Flipkart workbook has no TACOS
// column, so the Analysis sheet doesn't carry one (it uses their real-time
// cpc/acos pair instead — see the Analysis report block). The TACOS *sheet*
// further down is per-SKU by construction and computes its own ratio inline
// from the rolled-up SKU spend, so it needs nothing here. The Amazon report
// keeps a computeTacos because its Analysis sheet does show TACOS.

interface SkuMeta {
  sku: string;
  /** Best available human label: product name from the FSN/order export. */
  name: string;
  campaignName: string;
  price: number;
  mrp: number;
  stock: number;
  listingStatus: string;
  /** False when `price` is the realised-ASP fallback rather than a listed price. */
  hasListing: boolean;
  fulfilment: string;
  category: string;
}
const emptyMeta = (sku: string): SkuMeta => ({
  sku, name: sku, campaignName: "", price: 0, mrp: 0, stock: 0, listingStatus: "", hasListing: false, fulfilment: "", category: "",
});

// ── workbook builder ────────────────────────────────────────────────────────

export interface FlipkartReportOpts {
  /** 'YYYY-MM-DD' — both trailing windows end here. */
  endDate: string;
  accountName?: string;
}

export async function buildFlipkartHistoricalReportWorkbook(opts: FlipkartReportOpts) {
  const { endDate: selectedEndDate, accountName } = opts;

  // Both windows end on the date the dashboard selected, full stop: "Last 30
  // days" is that date and the 29 before it, "Last 7 days" that date and the 6
  // before it. The selected date is never silently moved.
  //
  // An earlier version pulled the end date back to the latest date any source
  // actually had a row for. That was well-meant — it stopped a seller who
  // hadn't uploaded today's file from seeing an empty tail — but it meant the
  // date they picked was not the date they got, which made the report
  // impossible to reconcile against their own workbook. The latest date WITH
  // data is still looked up, but only to warn (dataThrough / staleDays below),
  // never to move the window.
  const [maxFsn, maxOrder, maxEarn] = await Promise.all([
    fetchMaxDate(FSN_TABLE, "report_date", selectedEndDate),
    fetchMaxDate("fk_orders", "order_date", selectedEndDate),
    fetchMaxDate(EARN_MORE_TABLE, "order_date", selectedEndDate),
  ]);
  const endDate = selectedEndDate;
  const dataThrough = [maxFsn, maxOrder, maxEarn].filter((d): d is string => !!d).sort().pop() || null;
  // Whole days at the end of the window that no source has a row for yet.
  const staleDays = dataThrough
    ? Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${dataThrough}T00:00:00Z`)) / 86_400_000)
    : 0;

  const win30 = getDateWindow(endDate, 30);
  const win7 = getDateWindow(endDate, 7);

  // One 30-day fetch per source; the 7-day block is a filter over these.
  const [fsnRows, earnRows, orderRows, listingRows, returnsRows] = await Promise.all([
    fetchAllRows(FSN_TABLE, (q) => q.gte("report_date", win30.start).lte("report_date", endDate)),
    fetchAllRows(EARN_MORE_TABLE, (q) => q.gte("order_date", win30.start).lte("order_date", endDate)),
    fetchMisFkOrders((q) => q.gte("order_date", win30.start).lte("order_date", endDate)),
    fetchAllRows(LISTINGS_TABLE, (q) => q).catch(() => []),
    fetchMisFkReturns((q) => q.gte("return_requested_date", win30.start).lte("return_requested_date", endDate)).catch(() => []),
  ]);

  // Collapse Order report rows repeating an (order item ID, status, quantity)
  // triple — the same key the uploader uses, applied again here to catch rows
  // already sitting in Supabase from an older upload.
  //
  // This must NOT key on (order ID, SKU, quantity), which an earlier version
  // did: Flipkart splits a 2-unit order of one SKU into two SEPARATE
  // order_item_ids of quantity 1, so that key destroyed one leg of every such
  // order and Orders read low against the seller's own workbook. Status and
  // quantity stay in the key so the two legs of a partial return — which share
  // ONE order_item_id — both survive. See dedupeOrderReportRows in
  // flipkartReportUpload.ts.
  const seenOrderKeys = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dedupedOrderRows = (orderRows as any[]).filter((r) => {
    const key = `${r.order_item_id}|${r.order_item_status}|${r.quantity}`;
    if (seenOrderKeys.has(key)) return false;
    seenOrderKeys.add(key);
    return true;
  });

  if (!fsnRows.length && !earnRows.length && !dedupedOrderRows.length) {
    throw new Error(
      `No uploaded Flipkart data in ${dotDate(win30.start)} to ${dotDate(endDate)}. ` +
        `Upload the reports for that period first, or pick an end date the uploaded data covers.`
    );
  }

  // ── SKU identity + snapshot metadata (shared by both windows) ──
  const metaMap = new Map<string, SkuMeta>();
  const ensureMeta = (sku: string): SkuMeta => {
    let m = metaMap.get(sku);
    if (!m) { m = emptyMeta(sku); metaMap.set(sku, m); }
    return m;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fsnRows.forEach((r: any) => {
    if (!r.sku_id) return;
    const m = ensureMeta(r.sku_id);
    if (r.product_name && m.name === m.sku) m.name = r.product_name;
    if (r.campaign_name && !m.campaignName) m.campaignName = r.campaign_name;
  });
  // Campaign ID lookup by name — the FSN report is the only source that
  // carries the ID, so this is filled once from it and read back wherever a
  // campaign name is shown in the Analysis report.
  const campaignIdByName = new Map<string, string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fsnRows.forEach((r: any) => {
    if (r.campaign_name && r.campaign_id && !campaignIdByName.has(r.campaign_name)) {
      campaignIdByName.set(r.campaign_name, r.campaign_id);
    }
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dedupedOrderRows.forEach((r: any) => {
    if (!r.sku) return;
    const m = ensureMeta(r.sku);
    if (r.product_title && m.name === m.sku) m.name = r.product_title;
    if (r.fulfilment_type && !m.fulfilment) m.fulfilment = r.fulfilment_type;
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  earnRows.forEach((r: any) => {
    if (!r.sku_id) return;
    const m = ensureMeta(r.sku_id);
    if (r.category && !m.category) m.category = r.category;
    if (r.fulfillment_type && !m.fulfilment) m.fulfilment = r.fulfillment_type;
  });

  // Price prefers the listings snapshot (what the SKU is actually listed at).
  // Where no listing row exists, fall back to the window's realised ASP —
  // final sale value / final units — so ACOS/TACOS still have a denominator.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listingBySku = new Map<string, any>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  listingRows.forEach((l: any) => {
    if (l.seller_sku_id) listingBySku.set(String(l.seller_sku_id).toLowerCase(), l);
  });
  const hasListings = listingBySku.size > 0;

  const aspAcc = new Map<string, { amount: number; units: number }>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  earnRows.forEach((r: any) => {
    if (!r.sku_id) return;
    const a = aspAcc.get(r.sku_id) || { amount: 0, units: 0 };
    a.amount += num(r.final_sale_amount) || num(r.gmv);
    a.units += num(r.final_sale_units) || num(r.gross_units);
    aspAcc.set(r.sku_id, a);
  });

  metaMap.forEach((m, sku) => {
    const listing = listingBySku.get(sku.toLowerCase());
    if (listing) {
      m.hasListing = true;
      m.price = num(listing.selling_price);
      m.mrp = num(listing.mrp);
      m.stock = num(listing.stock_count);
      m.listingStatus = listing.listing_status || "";
    }
    if (m.price <= 0) {
      const a = aspAcc.get(sku);
      if (a && a.units > 0) m.price = a.amount / a.units;
    }
  });

  // ── per-window aggregation ──
  const pairKey = (campaign: string, sku: string) => `${campaign} ${sku}`;
  interface WindowMaps {
    pairs: Map<string, PairAgg>;
    skus: Map<string, SkuAgg>;
    pairIds: Map<string, { campaign: string; sku: string }>;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function aggregateWindow(rowsFsn: any[], rowsEarn: any[], rowsOrder: any[], rowsReturns: any[]): WindowMaps {
    const pairs = new Map<string, PairAgg>();
    const skus = new Map<string, SkuAgg>();
    const pairIds = new Map<string, { campaign: string; sku: string }>();
    const skusWithAds = new Set<string>();
    const ensurePair = (campaign: string, sku: string): PairAgg => {
      const k = pairKey(campaign, sku);
      let p = pairs.get(k);
      if (!p) { p = { spendTax: 0, adUnits: 0, adRevenue: 0 }; pairs.set(k, p); pairIds.set(k, { campaign, sku }); }
      return p;
    };
    const ensureSku = (sku: string): SkuAgg => {
      let s = skus.get(sku);
      if (!s) { s = { adUnitsTotal: 0, orderUnits: 0, returns: 0, saleAmount: 0 }; skus.set(sku, s); }
      return s;
    };

    // Ads. Flipkart's FSN export is genuinely per-SKU for every campaign type,
    // so spend needs no apportioning — a campaign x SKU row is the real grain.
    // Direct + indirect units are both ad-attributed sales of the advertised
    // SKU (indirect = a different variant/quantity of the same listing).
    rowsFsn.forEach((r) => {
      if (!r.sku_id) return;
      const p = ensurePair(r.campaign_name || "", r.sku_id);
      skusWithAds.add(r.sku_id);
      const units = num(r.direct_units_sold) + num(r.indirect_units_sold);
      const taxed = num(r.ad_spend) * GST_MULTIPLIER;
      p.spendTax += taxed;
      p.adUnits += units;
      p.adRevenue += num(r.total_revenue);
      ensureSku(r.sku_id).adUnitsTotal += units;
    });

    // Orders — from the Order report (order-item level), not Earn more. Earn
    // more is usually uploaded for far fewer days than the Order report, which
    // starves Orders for most of the 30-day window. A cancelled item was never
    // sold, so it's excluded the same way Amazon's report excludes cancelled
    // orders. A partially-returned item exports as two rows sharing one
    // order_item_id (e.g. quantity=2 RETURNED + quantity=1 DELIVERED) — summing
    // every non-cancelled row's quantity recovers the original gross order.
    //
    // Returns: the dedicated Returns report is used when it has any rows in
    // this window (below) — it tracks a return from the moment it's requested
    // through in-transit/completed, which the Order report's order_item_status
    // can still show as pending (RETURN_REQUESTED) or can miss altogether if
    // the underlying order falls outside this window. Falls back to the Order
    // report's RETURNED status only when no Returns report has been uploaded
    // for this window at all, so older reports built before that upload existed
    // keep working exactly as before.
    const hasReturnsReport = rowsReturns.length > 0;
    rowsOrder.forEach((r) => {
      if (!r.sku) return;
      const status = String(r.order_item_status || "").toUpperCase();
      if (status.startsWith("CANCEL")) return;
      const s = ensureSku(r.sku);
      const qty = num(r.quantity);
      s.orderUnits += qty;
      if (!hasReturnsReport && status === "RETURNED") s.returns += qty;
    });
    if (hasReturnsReport) {
      rowsReturns.forEach((r) => {
        if (!r.sku) return;
        ensureSku(r.sku).returns += num(r.quantity);
      });
    }

    // Revenue only. The Order report carries no monetary columns at all, so
    // Final Sale Value and the Price ASP-fallback still come from Earn more.
    rowsEarn.forEach((r) => {
      if (!r.sku_id) return;
      ensureSku(r.sku_id).saleAmount += num(r.final_sale_amount);
    });

    // A SKU with real Orders/Returns but zero FSN rows in this window gets a
    // "(no ads data)" placeholder pair so it still gets a row in the Analysis
    // report and counts towards the GRAND TOTAL — see the NO_ADS comment.
    skus.forEach((s, sku) => {
      if (skusWithAds.has(sku)) return;
      if (s.orderUnits > 0 || s.returns > 0) ensurePair(NO_ADS, sku);
    });

    return { pairs, skus, pairIds };
  }

  const winA = aggregateWindow(fsnRows, earnRows, dedupedOrderRows, returnsRows);
  const winB = aggregateWindow(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fsnRows.filter((r: any) => r.report_date >= win7.start),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    earnRows.filter((r: any) => r.order_date >= win7.start),
    dedupedOrderRows.filter((r) => r.order_date >= win7.start),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (returnsRows as any[]).filter((r) => r.return_requested_date >= win7.start)
  );

  const combine = (m: WindowMaps, k: string, sku: string): WindowAgg => {
    const p = m.pairs.get(k);
    const s = m.skus.get(sku);
    return {
      spendTax: p?.spendTax || 0,
      adUnits: p?.adUnits || 0,
      adRevenue: p?.adRevenue || 0,
      totalUnits: s?.adUnitsTotal || 0,
      orderUnits: s?.orderUnits || 0,
      returns: s?.returns || 0,
    };
  };

  interface Row { campaign: string; sku: string; meta: SkuMeta; wA: WindowAgg; wB: WindowAgg; }
  const allPairRows: Row[] = [...winA.pairIds.entries()].map(([k, id]) => ({
    campaign: id.campaign,
    sku: id.sku,
    meta: metaMap.get(id.sku) || emptyMeta(id.sku),
    wA: combine(winA, k, id.sku),
    wB: combine(winB, k, id.sku),
  }));
  // SKUs that sold without ever being advertised are reported on their own
  // sheet rather than inside the Analysis report. The Analysis report is an
  // ADVERTISING document — one row per campaign x SKU — and the seller's own
  // workbook only ever lists advertised pairs, so folding a "(no ads data)"
  // pseudo-campaign into it made the sheet un-diffable against theirs. The
  // sales are still real, so they get a dedicated sheet instead of vanishing.
  const rows: Row[] = allPairRows.filter((r) => r.campaign !== NO_ADS);
  const noAdsRows: Row[] = allPairRows
    .filter((r) => r.campaign === NO_ADS)
    .sort((a, b) => (b.wA.orderUnits - a.wA.orderUnits) || (b.wA.returns - a.wA.returns));
  rows.sort((a, b) => {
    const ka = excelSortKey(a.sku), kb = excelSortKey(b.sku);
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.campaign < b.campaign ? -1 : a.campaign > b.campaign ? 1 : 0;
  });

  // Per-SKU roll-up, for the sheets that are genuinely per-SKU.
  const rollUp = (m: WindowMaps): Map<string, WindowAgg> => {
    const out = new Map<string, WindowAgg>();
    const ensure = (sku: string): WindowAgg => {
      let w = out.get(sku);
      if (!w) {
        const s = m.skus.get(sku);
        w = { ...emptyWindowAgg(), totalUnits: s?.adUnitsTotal || 0, orderUnits: s?.orderUnits || 0, returns: s?.returns || 0 };
        out.set(sku, w);
      }
      return w;
    };
    m.pairIds.forEach((id, k) => {
      const p = m.pairs.get(k);
      if (!p) return;
      const w = ensure(id.sku);
      w.spendTax += p.spendTax;
      w.adUnits += p.adUnits;
      w.adRevenue += p.adRevenue;
    });
    m.skus.forEach((_, sku) => ensure(sku));
    return out;
  };
  const skuRollA = rollUp(winA);
  const skuRollB = rollUp(winB);

  const activeSkus = new Set<string>();
  skuRollA.forEach((w, sku) => {
    if (w.spendTax || w.adUnits || w.orderUnits || w.returns) activeSkus.add(sku);
  });
  metaMap.forEach((m, sku) => { if (m.stock > 0) activeSkus.add(sku); });

  interface SkuRow { sku: string; meta: SkuMeta; wA: WindowAgg; wB: WindowAgg; }
  const skuRows: SkuRow[] = [...activeSkus].map((sku) => ({
    sku,
    meta: metaMap.get(sku) || emptyMeta(sku),
    wA: skuRollA.get(sku) || emptyWindowAgg(),
    wB: skuRollB.get(sku) || emptyWindowAgg(),
  }));
  skuRows.sort((a, b) => (b.wA.spendTax - a.wA.spendTax) || (b.wA.orderUnits - a.wA.orderUnits));

  const colLetter = (c: number) => XLSX.utils.encode_col(c);
  const acosColor = (v: number) => (v < 0.25 ? "92D050" : v > 0.4 ? "FF0000" : "FFCC00");

  const wb = XLSX.utils.book_new();

  // ═══════════════════════════════════════════════════════════════════════
  // Analysis report — one row per CAMPAIGN x SKU, dual 30-day / 7-day block
  // ═══════════════════════════════════════════════════════════════════════
  // Column layout is copied VERBATIM from the seller's own "Fk Final Report "
  // sheet — including its trailing spaces and inconsistent casing ("Ad Spent
  // with Tax " vs "Ad spent with Tax ", "acos" vs "acos ", "real Time cpc") — so
  // the two line up column-for-column and any formula, pivot or VLOOKUP they
  // already built against it keeps working. Two things differ from the Amazon
  // report on purpose, because their Flipkart workbook is built differently:
  //
  //   * the 7-DAY block comes FIRST, then the 30-day one, and Stock sits up
  //     front as a lead column rather than in a trailing listing block.
  //   * there is no TACOS column at all. Instead they carry a second pair of
  //     ratios: cpc/acos measure spend against AD-attributed orders, while
  //     "real time" cpc/acos measure the same spend against ALL of that SKU's
  //     orders — which is what shows whether the ad cost is carrying the SKU's
  //     whole demand or only the slice the ads can claim.
  //
  // Verified against their workbook (SKU A006-1, 7-day block): Ad Spent 403.28
  // -> with-tax 475.8704, cpc 475.8704/3 = 158.6235, acos /556 = 0.28529,
  // real time CPC 475.8704/6 = 79.3117, Real Time ACOS = 0.14265.
  const FK_WIN_7 = ["Ad Spent ", "Ad Spent with Tax ", "Orders by Ad spent ", "Orders ", "Returns ", "Final Orders ", "cpc", "acos", "real time CPC ", "Real Time ACOS "];
  const FK_WIN_30 = ["Ad Spent ", "Ad spent with Tax ", "Orders by Ads ", "Orders ", "Returns ", "Final Orders ", "cpc", "acos ", "real Time cpc", "real time acos "];
  // Additive, so columns 0-25 stay exactly where their sheet has them: Orders /
  // Returns / Final repeat on every campaign row of a multi-campaign SKU, so
  // SUMming those columns double-counts. A 1 marks the one row per SKU that is
  // safe to include.
  const FLAG_COL_NAME = "First Row (SKU)?";

  // Fixed positions — nothing below counts columns by hand.
  const C_KEY = 0, C_SKU = 1, C_PRICE = 2, C_STOCK = 3;
  const C_LABEL_7 = 4;
  const B7 = C_LABEL_7 + 1;                    // first metric column, 7-day block
  const C_LABEL_30 = B7 + FK_WIN_7.length;
  const B30 = C_LABEL_30 + 1;                  // first metric column, 30-day block
  const FLAG = B30 + FK_WIN_30.length;

  // The Analysis sheet's own headers are just "7 Days " / "30 DAYS " to match
  // their workbook, so the dated labels are only used by the other sheets
  // (TACOS, non-advertised sales) and the Notes sheet.
  const label30 = `Last 30 days (${dotDate(win30.start)} to ${dotDate(win30.end)})`;
  const label7 = `Last 7 days (${dotDate(win7.start)} to ${dotDate(win7.end)})`;

  const header: (string | number)[] = [
    "Campaign Name *SKU*Campaign Id ", "SKU ", "Price ", "Stock ",
    "7 Days ", ...FK_WIN_7,
    "30 DAYS ", ...FK_WIN_30,
    FLAG_COL_NAME,
  ];

  // Their header carries no dates (just "7 Days " / "30 DAYS "), so the exact
  // windows live on the Notes sheet instead of being baked into the labels.
  const fkWinCells = (w: WindowAgg, price: number): number[] => {
    const spendTax = w.spendTax;
    const orders = w.orderUnits;
    // computeCpc already falls back to the untouched spend when there are no
    // ad-attributed orders, which is what their sheet shows (a row with 0
    // "Orders by Ad spent" reads cpc = Ad Spent with Tax).
    const cpc = computeCpc(w);
    const rtCpc = orders > 0 ? spendTax / orders : spendTax;
    return [
      spendTax / GST_MULTIPLIER, spendTax, w.adUnits, orders, w.returns, orders - w.returns,
      cpc, computeAcos(w, price),
      rtCpc, price > 0 ? rtCpc / price : 0,
    ];
  };

  // Rows are already sorted by SKU, so the first time a SKU is seen here IS its
  // first row — matching the live COUNTIF written onto the flag column below.
  const seenSkuForFlag = new Set<string>();
  const isFirstRowForSku = (sku: string): number => {
    if (seenSkuForFlag.has(sku)) return 0;
    seenSkuForFlag.add(sku);
    return 1;
  };

  const aoa: (string | number)[][] = [header];
  rows.forEach((row) => {
    const campaignName = row.campaign || row.meta.campaignName;
    const campaignId = campaignIdByName.get(campaignName) || "—";
    aoa.push([
      `${row.campaign || row.meta.name}*${row.sku}*${campaignId}`,
      row.sku,
      Math.round(row.meta.price),
      row.meta.hasListing ? row.meta.stock : "—",
      "",
      ...fkWinCells(row.wB, row.meta.price),
      "",
      ...fkWinCells(row.wA, row.meta.price),
      isFirstRowForSku(row.sku),
    ]);
  });

  // Grand total. Ad Spent and Orders-by-Ad are per campaign x SKU so they sum
  // plainly; Orders and Returns are SKU figures repeated across that SKU's
  // campaign rows, so they are summed over the DEDUPLICATED per-SKU view —
  // which is why this row will not equal a plain SUM() of the column above it.
  // Ratios are recomputed from aggregated numerators/denominators, never
  // averaged from the per-row ratios.
  const shownSkus = new Set(rows.map((r) => r.sku));
  const fkTotalCells = (getW: (r: Row) => WindowAgg, getSkuW: (r: SkuRow) => WindowAgg): number[] => {
    let spendTax = 0, adUnits = 0, acosDenom = 0;
    rows.forEach((row) => {
      const w = getW(row);
      spendTax += w.spendTax;
      adUnits += w.adUnits;
      acosDenom += row.meta.price * w.adUnits;
    });
    let orders = 0, returns = 0, rtDenom = 0;
    skuRows.filter((r) => shownSkus.has(r.sku)).forEach((row) => {
      const w = getSkuW(row);
      orders += w.orderUnits;
      returns += w.returns;
      rtDenom += row.meta.price * w.orderUnits;
    });
    return [
      spendTax / GST_MULTIPLIER, spendTax, adUnits, orders, returns, orders - returns,
      adUnits > 0 ? spendTax / adUnits : spendTax,
      acosDenom > 0 ? spendTax / acosDenom : 0,
      orders > 0 ? spendTax / orders : spendTax,
      rtDenom > 0 ? spendTax / rtDenom : 0,
    ];
  };
  const grandRowIdx = aoa.length;
  aoa.push([
    "GRAND TOTAL", "", "", "", "",
    ...fkTotalCells((r) => r.wB, (r) => r.wB),
    "",
    ...fkTotalCells((r) => r.wA, (r) => r.wA),
    "",
  ]);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const totalCols = header.length;
  const priceCol = colLetter(C_PRICE);

  // Live formulas so an analyst can change a price, an orders figure or the GST
  // multiplier in Excel and watch every ratio follow. These are set on cells
  // that already hold a computed value, which matters: xlsx-js-style DROPS a
  // formula cell that has no cached value, so a formula-only cell would vanish
  // from the file entirely.
  for (const blockStart of [B7, B30]) {
    const adSpendCol = colLetter(blockStart);
    const spendTaxCol = colLetter(blockStart + 1);
    const byAdCol = colLetter(blockStart + 2);
    const ordersCol = colLetter(blockStart + 3);
    const returnsCol = colLetter(blockStart + 4);
    const finalCol = colLetter(blockStart + 5);
    const cpcCol = colLetter(blockStart + 6);
    const acosCol = colLetter(blockStart + 7);
    const rtCpcCol = colLetter(blockStart + 8);
    const rtAcosCol = colLetter(blockStart + 9);
    for (let r = 1; r < grandRowIdx; r++) {
      const n = r + 1; // 1 header row, so aoa row 1 is Excel row 2
      const set = (col: string, f: string) => { if (ws[`${col}${n}`]) ws[`${col}${n}`].f = f };
      set(spendTaxCol, `${adSpendCol}${n}*${GST_MULTIPLIER}`);
      set(finalCol, `${ordersCol}${n}-${returnsCol}${n}`);
      set(cpcCol, `IF(${byAdCol}${n}=0,${spendTaxCol}${n},${spendTaxCol}${n}/${byAdCol}${n})`);
      set(acosCol, `IF(${priceCol}${n}=0,0,${cpcCol}${n}/${priceCol}${n})`);
      set(rtCpcCol, `IF(${ordersCol}${n}=0,${spendTaxCol}${n},${spendTaxCol}${n}/${ordersCol}${n})`);
      set(rtAcosCol, `IF(${priceCol}${n}=0,0,${rtCpcCol}${n}/${priceCol}${n})`);
    }
  }

  // Live COUNTIF flag: 1 only on the first row for that SKU, so an analyst who
  // reorders or filters rows in Excel still gets a correct flag.
  {
    const skuCol = colLetter(C_SKU);
    const flagColLetter = colLetter(FLAG);
    for (let r = 1; r < grandRowIdx; r++) {
      const n = r + 1;
      if (ws[`${flagColLetter}${n}`]) {
        ws[`${flagColLetter}${n}`].f = `IF(COUNTIF($${skuCol}$2:${skuCol}${n},${skuCol}${n})=1,1,0)`;
      }
    }
  }

  // Header — single row, matching their sheet. The two window blocks get
  // distinct fills so the 7/30 split is still readable at a glance without a
  // banner row above it.
  for (let c = 0; c < totalCols; c++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c });
    if (!ws[addr]) ws[addr] = { t: "s", v: "" };
    let fill = "312E81";                                  // lead columns
    if (c === C_LABEL_7 || (c >= B7 && c < C_LABEL_30)) fill = "4F46E5";
    else if (c === C_LABEL_30 || (c >= B30 && c < FLAG)) fill = "3730A3";
    else if (c === FLAG) fill = "374151";
    ws[addr].s = {
      font: { bold: true, color: { rgb: "FFFFFF" }, sz: 10 },
      fill: { fgColor: { rgb: fill } },
      alignment: { horizontal: "center", vertical: "center", wrapText: true },
      border: { bottom: { style: "medium", color: { rgb: "1E1B4B" } } },
    };
  }

  for (let r = 1; r < aoa.length; r++) {
    const isGrand = r === grandRowIdx;
    for (let c = 0; c < totalCols; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (!cell) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const style: any = {
        font: { color: { rgb: "1F2937" }, bold: isGrand },
        alignment: { vertical: "center", horizontal: c === C_KEY ? "left" : "center" },
        border: {
          bottom: { style: isGrand ? "medium" : "thin", color: { rgb: isGrand ? "312E81" : "E5E7EB" } },
          ...(isGrand ? { top: { style: "medium", color: { rgb: "312E81" } } } : {}),
        },
      };

      let pos = -1;
      if (c >= B7 && c < C_LABEL_30) pos = c - B7;
      else if (c >= B30 && c < FLAG) pos = c - B30;

      if (c === C_KEY || c === C_SKU) {
        style.font = { color: { rgb: "111827" }, bold: true };
      } else if (c === C_PRICE) {
        style.numFmt = "#,##0";
        style.font = { color: { rgb: "111827" }, bold: true };
      } else if (c === C_STOCK) {
        style.numFmt = "#,##0";
        style.font = { color: { rgb: "4338CA" }, bold: true };
      } else if (pos >= 0) {
        if (pos === 0 || pos === 1 || pos === 6 || pos === 8) style.numFmt = "#,##0.00";
        else if (pos >= 2 && pos <= 5) style.numFmt = "#,##0";
        if (pos === 5 && typeof cell.v === "number" && cell.v < 0) {
          style.font = { color: { rgb: "B91C1C" }, bold: true };
        }
        if (pos === 7 || pos === 9) {
          style.numFmt = "0.00%";
          if (typeof cell.v === "number" && cell.v > 0) {
            style.fill = { fgColor: { rgb: acosColor(cell.v) } };
            style.font = { color: { rgb: cell.v > 0.4 ? "FFFFFF" : "000000" }, bold: true };
          }
        }
      } else if (c === FLAG) {
        style.numFmt = "0";
        if (typeof cell.v === "number" && cell.v === 1) style.font = { color: { rgb: "047857" }, bold: true };
      }
      cell.s = style;
    }
  }

  const cols = [{ wch: 52 }, { wch: 24 }, { wch: 9 }, { wch: 8 }];
  cols.push({ wch: 9 });                                   // "7 Days " label
  for (let i = 0; i < FK_WIN_7.length; i++) cols.push({ wch: i <= 1 ? 12 : 11 });
  cols.push({ wch: 10 });                                  // "30 DAYS " label
  for (let i = 0; i < FK_WIN_30.length; i++) cols.push({ wch: i <= 1 ? 12 : 11 });
  cols.push({ wch: 13 });
  ws["!cols"] = cols;
  ws["!rows"] = [{ hpt: 40 }];
  ws["!views"] = [{ state: "frozen", xSplit: 4, ySplit: 1 }];
  XLSX.utils.book_append_sheet(wb, ws, "Analysis report");

  // ═══════════════════════════════════════════════════════════════════════
  // Non-advertised sales — SKUs with real Orders/Returns in the window but no
  // FSN ad row at all. Split out of the Analysis report so that sheet stays a
  // pure advertising view (and stays comparable to the seller's own workbook),
  // without the sales themselves disappearing from the workbook.
  // ═══════════════════════════════════════════════════════════════════════
  const NA_WIN = ["Orders", "Returns", "Final"];
  const naAoa: (string | number)[][] = [
    ["", "", "", label30, "", "", label7, "", "", "Listing (current snapshot)", "", ""],
    ["SKU ID", "Product", "Price", ...NA_WIN, ...NA_WIN, "Stock", "Listing Price", "Listing Status"],
  ];
  const naWin = (w: WindowAgg) => [w.orderUnits, w.returns, Math.max(0, w.orderUnits - w.returns)];
  noAdsRows.forEach((r) => {
    naAoa.push([
      r.sku, r.meta.name, Math.round(r.meta.price),
      ...naWin(r.wA), ...naWin(r.wB),
      ...(r.meta.hasListing
        ? [r.meta.stock, Math.round(r.meta.price), r.meta.listingStatus || "—"]
        : ["—", "—", hasListings ? "not listed" : "not uploaded"]),
    ]);
  });
  const naGrandIdx = naAoa.length;
  const naTotal = (get: (r: Row) => WindowAgg) => {
    let o = 0, rt = 0;
    noAdsRows.forEach((r) => { const w = get(r); o += w.orderUnits; rt += w.returns; });
    return [o, rt, Math.max(0, o - rt)];
  };
  naAoa.push(["GRAND TOTAL", "", "", ...naTotal((r) => r.wA), ...naTotal((r) => r.wB), "", "", ""]);

  const wsNa = noAdsRows.length
    ? XLSX.utils.aoa_to_sheet(naAoa)
    : XLSX.utils.aoa_to_sheet([["Every SKU with sales in this window was advertised — nothing to report here."]]);
  if (noAdsRows.length) {
    wsNa["!merges"] = [
      { s: { r: 0, c: 3 }, e: { r: 0, c: 5 } },
      { s: { r: 0, c: 6 }, e: { r: 0, c: 8 } },
      { s: { r: 0, c: 9 }, e: { r: 0, c: 11 } },
    ];
    for (let r = 0; r <= 1; r++) {
      for (let c = 0; c < 12; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        if (!wsNa[addr]) wsNa[addr] = { t: "s", v: "" };
        let fill = r === 0 ? "312E81" : "4F46E5";
        if (c >= 6 && c < 9) fill = r === 0 ? "3730A3" : "6366F1";
        if (c >= 9) fill = r === 0 ? "065F46" : "059669";
        wsNa[addr].s = {
          font: { bold: true, color: { rgb: "FFFFFF" }, sz: 10 },
          fill: { fgColor: { rgb: fill } },
          alignment: { horizontal: "center", vertical: "center", wrapText: true },
        };
      }
    }
    for (let r = 2; r < naAoa.length; r++) {
      const isGrand = r === naGrandIdx;
      for (let c = 0; c < 12; c++) {
        const cell = wsNa[XLSX.utils.encode_cell({ r, c })];
        if (!cell) continue;
        cell.s = {
          font: { bold: isGrand, color: { rgb: "1F2937" } },
          alignment: { vertical: "center", horizontal: c <= 1 ? "left" : "center" },
          numFmt: c === 2 || (c >= 3 && c <= 8) ? "#,##0" : undefined,
          border: isGrand ? { top: { style: "medium", color: { rgb: "312E81" } } } : undefined,
        };
      }
    }
    wsNa["!cols"] = [{ wch: 26 }, { wch: 55 }, { wch: 9 }, ...Array(6).fill({ wch: 10 }), { wch: 9 }, { wch: 12 }, { wch: 14 }];
    wsNa["!views"] = [{ state: "frozen", xSplit: 3, ySplit: 2 }];
  }
  XLSX.utils.book_append_sheet(wb, wsNa, "Non-advertised sales");

  // ═══════════════════════════════════════════════════════════════════════
  // TACOS — per SKU (not per campaign x SKU): a SKU's whole ad cost against its
  // whole net order volume. CPC here is therefore a DIFFERENT metric from the
  // Analysis report's — Spend+Tax / Final orders, i.e. cost per net order.
  // ═══════════════════════════════════════════════════════════════════════
  const TACOS_WIN = ["Spend+Tax", "Orders", "Returns", "Final", "CPC (per net order)", "TACOS"];
  const tacosAoa: (string | number)[][] = [
    ["", "", "", label30, "", "", "", "", "", label7, "", "", "", "", ""],
    ["SKU ID", "Product", "Price", ...TACOS_WIN, ...TACOS_WIN],
  ];
  const tacosSkuRows = [...skuRows].sort((a, b) => (excelSortKey(a.sku) < excelSortKey(b.sku) ? -1 : 1));
  const tacosWin = (w: WindowAgg, price: number) => {
    const final = Math.max(0, w.orderUnits - w.returns);
    const cpc = final > 0 ? w.spendTax / final : w.spendTax;
    return [w.spendTax, w.orderUnits, w.returns, final, cpc, price > 0 ? cpc / price : 0];
  };
  tacosSkuRows.forEach((r) => {
    tacosAoa.push([
      r.sku, r.meta.name, Math.round(r.meta.price),
      ...tacosWin(r.wA, r.meta.price),
      ...tacosWin(r.wB, r.meta.price),
    ]);
  });
  const wsTacos = XLSX.utils.aoa_to_sheet(tacosAoa);
  wsTacos["!merges"] = [
    { s: { r: 0, c: 3 }, e: { r: 0, c: 8 } },
    { s: { r: 0, c: 9 }, e: { r: 0, c: 14 } },
  ];
  for (let r = 0; r <= 1; r++) {
    for (let c = 0; c < 15; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (!wsTacos[addr]) wsTacos[addr] = { t: "s", v: "" };
      wsTacos[addr].s = {
        font: { bold: true, color: { rgb: "FFFFFF" }, sz: 10 },
        fill: { fgColor: { rgb: c >= 9 ? (r === 0 ? "3730A3" : "6366F1") : r === 0 ? "312E81" : "4F46E5" } },
        alignment: { horizontal: "center", vertical: "center", wrapText: true },
      };
    }
  }
  for (let r = 2; r < tacosAoa.length; r++) {
    for (let c = 0; c < 15; c++) {
      const cell = wsTacos[XLSX.utils.encode_cell({ r, c })];
      if (!cell) continue;
      const pos = c >= 9 ? c - 9 : c >= 3 ? c - 3 : -1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const style: any = { alignment: { vertical: "center", horizontal: c <= 1 ? "left" : "center" } };
      if (c === 2) style.numFmt = "#,##0";
      else if (pos === 0 || pos === 4) style.numFmt = "#,##0.00";
      else if (pos >= 1 && pos <= 3) style.numFmt = "#,##0";
      else if (pos === 5) {
        style.numFmt = "0.00%";
        if (typeof cell.v === "number" && cell.v > 0) {
          style.fill = { fgColor: { rgb: acosColor(cell.v) } };
          style.font = { color: { rgb: cell.v > 0.4 ? "FFFFFF" : "000000" }, bold: true };
        }
      }
      cell.s = style;
    }
  }
  wsTacos["!cols"] = [{ wch: 24 }, { wch: 55 }, { wch: 9 }, ...Array(12).fill({ wch: 12 })];
  wsTacos["!views"] = [{ state: "frozen", xSplit: 3, ySplit: 2 }];
  XLSX.utils.book_append_sheet(wb, wsTacos, "TACOS");

  // ═══════════════════════════════════════════════════════════════════════
  // Orders, returns, adspend — four INDEPENDENT top-20 lists side by side.
  // A given row is not a joined record: the SKU in the Orders columns has no
  // relation to whatever SKU appears in the Returns columns of that same row.
  // ═══════════════════════════════════════════════════════════════════════
  const topBy = (pick: (w: WindowAgg) => number, limit = 20) =>
    [...skuRows].filter((r) => pick(r.wA) > 0).sort((a, b) => pick(b.wA) - pick(a.wA)).slice(0, limit);
  const topSpend = topBy((w) => w.spendTax);
  const topOrders = topBy((w) => w.orderUnits);
  const topReturns = topBy((w) => w.returns);
  const topRevenue = topBy((w) => w.adRevenue);

  const lbHeader0 = ["Ad spend by SKU", "", "", "", "Orders by SKU", "", "", "", "Returns by SKU", "", "", "", "Ad revenue by SKU", "", "", ""];
  const lbHeader1 = ["SKU", "30d", "7d", "", "SKU", "30d", "7d", "", "SKU", "30d", "7d", "", "SKU", "30d", "7d", ""];
  const lbLen = Math.max(topSpend.length, topOrders.length, topReturns.length, topRevenue.length);
  const lbAoa: (string | number)[][] = [lbHeader0, lbHeader1];
  for (let i = 0; i < lbLen; i++) {
    lbAoa.push([
      topSpend[i]?.sku ?? "", topSpend[i] ? Math.round(topSpend[i].wA.spendTax) : "", topSpend[i] ? Math.round(topSpend[i].wB.spendTax) : "", "",
      topOrders[i]?.sku ?? "", topOrders[i]?.wA.orderUnits ?? "", topOrders[i]?.wB.orderUnits ?? "", "",
      topReturns[i]?.sku ?? "", topReturns[i]?.wA.returns ?? "", topReturns[i]?.wB.returns ?? "", "",
      topRevenue[i]?.sku ?? "", topRevenue[i] ? Math.round(topRevenue[i].wA.adRevenue) : "", topRevenue[i] ? Math.round(topRevenue[i].wB.adRevenue) : "", "",
    ]);
  }
  const wsLb = XLSX.utils.aoa_to_sheet(lbAoa);
  wsLb["!merges"] = [0, 4, 8, 12].map((c) => ({ s: { r: 0, c }, e: { r: 0, c: c + 2 } }));
  for (let r = 0; r <= 1; r++) {
    for (let c = 0; c < 16; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (!wsLb[addr]) wsLb[addr] = { t: "s", v: "" };
      if ((c + 1) % 4 === 0) continue;
      wsLb[addr].s = {
        font: { bold: true, color: { rgb: "FFFFFF" }, sz: 10 },
        fill: { fgColor: { rgb: r === 0 ? "312E81" : "4F46E5" } },
        alignment: { horizontal: "center", vertical: "center" },
      };
    }
  }
  wsLb["!cols"] = [0, 1, 2, 3].flatMap(() => [{ wch: 26 }, { wch: 10 }, { wch: 10 }, { wch: 2 }]);
  XLSX.utils.book_append_sheet(wb, wsLb, "Orders, returns, adspend");

  // ═══════════════════════════════════════════════════════════════════════
  // Raw sheets — verbatim dumps of the uploaded exports for the 30-day window.
  // Every uploaded row keeps its original file row in a `raw` JSON column, so
  // these reproduce the seller's own file column-for-column rather than a
  // hand-picked subset.
  // ═══════════════════════════════════════════════════════════════════════
  function buildRawSheet(dataRows: unknown[], sheetName: string) {
    // Header order follows the first row's key order (SheetJS/Papa preserve the
    // file's own column order), unioned across rows so a sparse upload can't
    // silently drop a column.
    const headers: string[] = [];
    const seen = new Set<string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dataRows as any[]).forEach((r) => {
      Object.keys((r?.raw || {}) as Record<string, unknown>).forEach((k) => {
        if (!seen.has(k)) { seen.add(k); headers.push(k); }
      });
    });
    if (!headers.length) {
      const empty = XLSX.utils.aoa_to_sheet([[`No ${sheetName} rows uploaded for this window.`]]);
      XLSX.utils.book_append_sheet(wb, empty, sheetName);
      return;
    }
    // Blanks are emitted as null, not "": aoa_to_sheet skips null and writes no
    // cell at all. These exports are sparse (most order rows leave every
    // cancellation/return column empty), so on a few hundred thousand cells that
    // is megabytes of XML.
    const rawAoa: unknown[][] = [headers];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dataRows as any[]).forEach((r) => {
      const raw = (r?.raw || {}) as Record<string, unknown>;
      rawAoa.push(headers.map((h) => {
        const v = raw[h];
        if (v === undefined || v === null || v === "") return null;
        // Numbers arrive from CSV as strings; Excel should hold them as numbers.
        // A value with a meaningful leading zero (an "007" SKU) stays text.
        if (typeof v === "string") {
          const t = v.trim();
          if (!/^0\d/.test(t) && /^-?\d*\.?\d+(e[+-]?\d+)?$/i.test(t)) {
            const n = Number(t);
            if (Number.isFinite(n)) return n;
          }
        }
        return v;
      }));
    });
    const rws = XLSX.utils.aoa_to_sheet(rawAoa);
    headers.forEach((_, c) => {
      const addr = XLSX.utils.encode_cell({ r: 0, c });
      if (rws[addr]) {
        rws[addr].s = {
          font: { bold: true, color: { rgb: "FFFFFF" }, sz: 10 },
          fill: { fgColor: { rgb: "334155" } },
          alignment: { horizontal: "center", vertical: "center", wrapText: true },
        };
      }
    });
    rws["!cols"] = headers.map(() => ({ wch: 18 }));
    rws["!views"] = [{ state: "frozen", ySplit: 1 }];
    XLSX.utils.book_append_sheet(wb, rws, sheetName);
  }

  buildRawSheet(fsnRows, "FSN report");
  buildRawSheet(returnsRows, "Returns report");

  // ═══════════════════════════════════════════════════════════════════════
  // Key Insights
  // ═══════════════════════════════════════════════════════════════════════
  // Computed directly rather than destructured out of the grand-total display
  // array: that coupled these figures to the Analysis sheet's column ORDER, so
  // rearranging that sheet silently reassigned them. Spend/ad figures sum per
  // campaign x SKU; Orders/Returns are SKU figures and must be summed over the
  // deduplicated per-SKU view or every multi-campaign SKU is counted twice.
  const gSpendTax = rows.reduce((s, r) => s + r.wA.spendTax, 0);
  const gAdUnits = rows.reduce((s, r) => s + r.wA.adUnits, 0);
  const gAdRevenue = rows.reduce((s, r) => s + r.wA.adRevenue, 0);
  const shownSkuRows = skuRows.filter((r) => shownSkus.has(r.sku));
  const gOrderUnits = shownSkuRows.reduce((s, r) => s + r.wA.orderUnits, 0);
  const gReturns = shownSkuRows.reduce((s, r) => s + r.wA.returns, 0);
  const gAcosDenom = rows.reduce((s, r) => s + r.meta.price * r.wA.adUnits, 0);
  const gTacosDenom = skuRows.reduce((s, r) => s + r.meta.price * Math.max(0, r.wA.orderUnits - r.wA.returns), 0);
  const gGrossSales = skuRows.reduce((s, r) => s + (winA.skus.get(r.sku)?.saleAmount || 0), 0);

  // Zero-order spend is the cleanest waste signal Flipkart's export gives:
  // the campaign ran, cost money, and produced no attributed unit at all.
  const wastedSpendRows = rows
    .filter((r) => r.wA.spendTax > 0 && r.wA.adUnits === 0)
    .sort((a, b) => b.wA.spendTax - a.wA.spendTax);
  const wastedSpend = wastedSpendRows.reduce((s, r) => s + r.wA.spendTax, 0);

  // Only SKUs with a real listing row can be judged out of stock. Without the
  // snapshot every stock is 0, which would flag the whole catalogue.
  const outOfStockSelling = skuRows.filter((r) => r.meta.hasListing && r.meta.stock <= 0 && r.wA.orderUnits > 0);
  const highReturnSkus = skuRows
    .filter((r) => r.wA.orderUnits >= 5 && r.wA.returns / r.wA.orderUnits > 0.2)
    .sort((a, b) => b.wA.returns / b.wA.orderUnits - a.wA.returns / a.wA.orderUnits);

  // ── Data integrity checks (30-day window) ──────────────────────────────
  // Independent re-derivations of the same totals, computed a different way,
  // so a future edit that reintroduces double-counting (e.g. summing Orders
  // straight off the pair rows again) fails visibly here instead of silently
  // inflating every number downstream.
  const nonAdsOrders30 = noAdsRows.reduce((s, r) => s + r.wA.orderUnits, 0);
  const nonAdsReturns30 = noAdsRows.reduce((s, r) => s + r.wA.returns, 0);
  // Direct from the per-SKU aggregate (bypasses the advertised/non-advertised
  // split entirely) — the ground truth both branches above should sum back to.
  const directOrderTotal30 = [...winA.skus.values()].reduce((s, sk) => s + sk.orderUnits, 0);
  const directReturnsTotal30 = [...winA.skus.values()].reduce((s, sk) => s + sk.returns, 0);
  const skuRowCounts = new Map<string, number>();
  rows.forEach((r) => skuRowCounts.set(r.sku, (skuRowCounts.get(r.sku) || 0) + 1));
  const multiCampaignSkus = [...skuRowCounts.values()].filter((n) => n > 1).length;
  // What a plain SUM() over the Analysis report's Orders column would give —
  // deliberately WRONG for any SKU with 2+ campaign rows, since it repeats
  // that SKU's order count once per row. Compared against gOrderUnits below.
  const rawOrdersAcrossRows30 = rows.reduce((s, r) => s + r.wA.orderUnits, 0);
  const distinctSkuCount30 = hasListings ? listingBySku.size : skuRows.length;
  const skusContributingOrders30 = skuRows.filter((r) => r.wA.orderUnits > 0).length;

  const dedupDidNothingButShouldHave = multiCampaignSkus > 0 && rawOrdersAcrossRows30 === gOrderUnits;
  const ordersReconcile = gOrderUnits + nonAdsOrders30 === directOrderTotal30;
  const returnsReconcile = gReturns + nonAdsReturns30 === directReturnsTotal30;

  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
  const insightsAoa: (string | number)[][] = [
    ["🔍 FLIPKART — KEY INSIGHTS & RECOMMENDATIONS (Last 30 days)", "", "", ""],
    ["Window", `${dotDate(win30.start)} to ${dotDate(win30.end)}`, "", ""],
    ["", "", "", ""],
    ["📊 PERFORMANCE SUMMARY", "", "", ""],
    ["Campaign x SKU rows analysed", rows.length, "", ""],
    ["Distinct SKUs analysed", skuRows.length, "", ""],
    ["Ad Spend + Tax (₹)", Math.round(gSpendTax), "", ""],
    ["Ad-attributed revenue (₹)", Math.round(gAdRevenue), "", ""],
    ["Ad-attributed units", gAdUnits, "", ""],
    ["Blended ROAS (ad revenue ÷ spend+tax)", gSpendTax > 0 ? Number((gAdRevenue / gSpendTax).toFixed(2)) : 0, "", ""],
    // Advertised-only, matching the Analysis report's GRAND TOTAL. The
    // non-advertised SKUs are counted separately below rather than silently
    // folded in, so these tie back to the sheet they came from.
    ["Orders on ADVERTISED SKUs (units, cancellations excluded)", gOrderUnits, "", ""],
    ["Returns on ADVERTISED SKUs (units)", gReturns, "", ""],
    ["Return rate (advertised SKUs)", gOrderUnits > 0 ? pct(gReturns / gOrderUnits) : "—", "", ""],
    ["Orders on NON-ADVERTISED SKUs (see that sheet)", noAdsRows.reduce((s, r) => s + r.wA.orderUnits, 0), "", ""],
    ["Returns on NON-ADVERTISED SKUs", noAdsRows.reduce((s, r) => s + r.wA.returns, 0), "", ""],
    ["TOTAL Orders, whole account (units)", gOrderUnits + noAdsRows.reduce((s, r) => s + r.wA.orderUnits, 0), "", ""],
    ["Final sale value (₹)", Math.round(gGrossSales), "", ""],
    ["Average ACOS", pct(gSpendTax / (gAcosDenom || 1)), "", ""],
    ["Average TACOS", pct(gSpendTax / (gTacosDenom || 1)), "", ""],
    ["", "", "", ""],
    ["✅ DATA INTEGRITY CHECKS (run before publishing)", "", "", ""],
    [
      hasListings ? "Distinct SKUs (Listing sheet)" : "Distinct SKUs analysed (no listings snapshot uploaded)",
      distinctSkuCount30, "", "",
    ],
    ["Unique SKUs contributing to Orders (deduped, whole account)", skusContributingOrders30, "", ""],
    ["SKUs advertised by 2+ campaigns this window", multiCampaignSkus, "", ""],
    ["Raw Orders sum via a naive SUM() over the Analysis report's Orders column", rawOrdersAcrossRows30, "", ""],
    ["Deduped Orders total actually used above (advertised bucket)", gOrderUnits, "", ""],
    [
      "Check: dedup actually reduced the total (or there were no multi-campaign SKUs to reduce)",
      dedupDidNothingButShouldHave ? "⚠️ FAIL — raw and deduped sums match despite multi-campaign SKUs; check aggregateWindow" : "✅ PASS",
      "", "",
    ],
    [
      "Check: Advertised + Non-advertised Orders reconciles to the direct per-SKU total",
      ordersReconcile ? `✅ PASS (${directOrderTotal30})` : `⚠️ FAIL — ${gOrderUnits + nonAdsOrders30} vs ${directOrderTotal30}`,
      "", "",
    ],
    [
      "Check: Advertised + Non-advertised Returns reconciles to the direct per-SKU total",
      returnsReconcile ? `✅ PASS (${directReturnsTotal30})` : `⚠️ FAIL — ${gReturns + nonAdsReturns30} vs ${directReturnsTotal30}`,
      "", "",
    ],
    ["", "", "", ""],
    ["🎯 BEST PERFORMING (lowest ACOS, spend > 0)", "SKU", "ACOS", "Spend+Tax (₹)"],
    ...rows
      .filter((r) => r.wA.spendTax > 0 && r.wA.adUnits > 0 && r.meta.price > 0)
      .sort((a, b) => computeAcos(a.wA, a.meta.price) - computeAcos(b.wA, b.meta.price))
      .slice(0, 5)
      .map((r) => [r.campaign || r.meta.name, r.sku, pct(computeAcos(r.wA, r.meta.price)), Math.round(r.wA.spendTax)]),
    ["", "", "", ""],
    ["⚠️ WORST PERFORMING (highest ACOS, spend > 0)", "SKU", "ACOS", "Spend+Tax (₹)"],
    ...rows
      .filter((r) => r.wA.spendTax > 0 && r.wA.adUnits > 0 && r.meta.price > 0)
      .sort((a, b) => computeAcos(b.wA, b.meta.price) - computeAcos(a.wA, a.meta.price))
      .slice(0, 5)
      .map((r) => [r.campaign || r.meta.name, r.sku, pct(computeAcos(r.wA, r.meta.price)), Math.round(r.wA.spendTax)]),
    ["", "", "", ""],
    ["🔥 SPEND WITH ZERO ATTRIBUTED UNITS", "SKU", "", "Spend+Tax (₹)"],
    ...wastedSpendRows.slice(0, 10).map((r) => [r.campaign || r.meta.name, r.sku, "", Math.round(r.wA.spendTax)]),
    ["", "", "", ""],
    ["📦 STOCK & RETURNS RISK", "", "", ""],
    ["Selling but out of stock", !hasListings
      ? "Unknown — no listings snapshot uploaded, so stock is not on file for any SKU."
      : outOfStockSelling.length ? outOfStockSelling.slice(0, 15).map((r) => r.sku).join(", ") : "✅ None", "", ""],
    ["Return rate over 20% (5+ orders)", highReturnSkus.length ? highReturnSkus.slice(0, 15).map((r) => `${r.sku} (${pct(r.wA.returns / r.wA.orderUnits)})`).join(", ") : "✅ None", "", ""],
    ["", "", "", ""],
    ["🚀 RECOMMENDATIONS", "", "", ""],
    ["1. BOOST", "Campaign x SKU rows with ACOS under 25% — raise the bid/budget, these pay for themselves.", "", ""],
    ["2. OPTIMISE", "ACOS between 25% and 40% — test bids and negative keywords before adding budget.", "", ""],
    ["3. CUT", wastedSpend > 0
      ? `₹${Math.round(wastedSpend).toLocaleString("en-IN")} of spend produced zero attributed units in 30 days. Pause or re-target those rows first.`
      : "No spend went entirely unconverted this window.", "", ""],
    ["4. RESTOCK", !hasListings
      ? "Can't tell — upload the listings snapshot to get stock-out warnings here."
      : outOfStockSelling.length
      ? `Replenish the SKUs still selling with zero listed stock: ${outOfStockSelling.slice(0, 10).map((r) => r.sku).join(", ")}`
      : "No selling SKU is out of stock.", "", ""],
    ["5. MISSING DATA", hasListings
      ? "All four reports plus the listings snapshot are available."
      : "No Flipkart listings snapshot on file — Price falls back to realised ASP and Stock/Listing Status are blank. Upload listings on the Upload Data tab.", "", ""],
  ];
  const wsInsights = XLSX.utils.aoa_to_sheet(insightsAoa);
  for (let c = 0; c < 4; c++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c });
    if (!wsInsights[addr]) wsInsights[addr] = { t: "s", v: "" };
    wsInsights[addr].s = {
      font: { bold: true, color: { rgb: "FFFFFF" }, sz: 13 },
      fill: { fgColor: { rgb: "1E40AF" } },
      alignment: { horizontal: "left", vertical: "center" },
    };
  }
  insightsAoa.forEach((row, r) => {
    const label = String(row[0] || "");
    if (r === 0 || !/^[\p{Emoji_Presentation}\u{1F300}-\u{1FAFF}]/u.test(label)) return;
    for (let c = 0; c < 4; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (!wsInsights[addr]) wsInsights[addr] = { t: "s", v: "" };
      wsInsights[addr].s = {
        font: { bold: true, color: { rgb: "FFFFFF" }, sz: 10 },
        fill: { fgColor: { rgb: "4F46E5" } },
        alignment: { horizontal: "left", vertical: "center" },
      };
    }
  });
  wsInsights["!cols"] = [{ wch: 46 }, { wch: 60 }, { wch: 14 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(wb, wsInsights, "Key Insights");

  // ═══════════════════════════════════════════════════════════════════════
  // Notes
  // ═══════════════════════════════════════════════════════════════════════
  const wsNote = XLSX.utils.aoa_to_sheet([
    ["Flipkart Historical Analysis Report"],
    [`Account: ${accountName || "Barm — Flipkart"}`],
    [`Last 30 days: ${dotDate(win30.start)} to ${dotDate(win30.end)}`],
    [`Last 7 days: ${dotDate(win7.start)} to ${dotDate(win7.end)}`],
    ...(staleDays > 0
      ? [[`⚠️ Both windows end on the selected date ${dotDate(endDate)}, but the newest uploaded row is from ${dotDate(dataThrough!)} — the last ${staleDays} day(s) of both windows have no data yet. Upload the newer files, or pick ${dotDate(dataThrough!)} as the end date, to remove that empty tail.`]]
      : []),
    [""],
    [`Built entirely from the four exports uploaded on the Flipkart "Upload Reports" page — ${Object.values(FK_REPORT_LABEL).join(", ")}. Flipkart exposes no ads API, so uploaded files are the only source; nothing here is live-fetched or estimated.`],
    ["Both windows end on the DATE SELECTED ON THE DASHBOARD, verbatim — 'Last 30 days' is that date and the 29 before it, 'Last 7 days' that date and the 6 before it. The selected date is never moved. Both are recomputed from the SAME 30-day fetch (the 7-day block is simply the last 7 days of that data, not a second query), so the two can never disagree. If the newest uploaded row predates the selected date, the window still runs to the selected date and a warning naming the gap appears at the top of this sheet — the fix is to upload the newer files or pick an earlier end date, not to have the report quietly report a different period than the one asked for."],
    ["GRAIN — the Analysis report has ONE ROW PER CAMPAIGN x SKU. Only Spend+Tax, Ad Units and Ad Revenue are CAMPAIGN-LEVEL — safe to sum directly, row over row. Total Units, Orders, Returns and Final are SKU-LEVEL (the Order report is order-item level, with no campaign dimension at all), so a SKU advertised by two campaigns shows the SAME Orders/Returns on both of its rows. Summing an Orders column therefore double-counts such SKUs — the GRAND TOTAL row deliberately sums those three columns over distinct SKUs instead, which is why it will not equal a plain SUM() of the column above it."],
    ["'First Row (SKU)?' column — a live =COUNTIF(...)=1 helper flag, 1 only on a SKU's first campaign row. If you build your own pivot or SUM() on this sheet (rather than reading the GRAND TOTAL row or the Key Insights sheet), multiply the SKU-level columns (Total Units, Orders, Returns, Final) by this flag first — e.g. =SUMPRODUCT(FlagColumn, OrdersColumn) — or you will double/triple-count any SKU running in more than one campaign. Spend+Tax, Ad Units, Ad Revenue, CPC and ACOS need no such flag; they are genuinely one row = one value."],
    ["Key Insights' 'DATA INTEGRITY CHECKS' section re-derives the Orders/Returns totals a second, independent way (straight off the per-SKU aggregate, bypassing the advertised/non-advertised split) and flags a FAIL if they don't reconcile, or if a naive SUM() over this sheet's Orders column happens to equal the deduped total despite multi-campaign SKUs existing — either would mean the dedup logic broke."],
    ["Unlike the Amazon report, there is no campaign -> SKU weighting: Flipkart's FSN export carries the SKU on every ad row, for every campaign type, so all spend is already attributed, and there is no unmapped-campaign bucket."],
    [`A SKU that sold in the window but was NEVER advertised (no FSN row at all) is reported on the separate "Non-advertised sales" sheet, not in the Analysis report. The Analysis report is one row per campaign x SKU and only covers advertised pairs, so its GRAND TOTAL is the ADVERTISED total — add the "Non-advertised sales" grand total to it for the account-wide Orders/Returns figure. ${noAdsRows.length} SKU(s) fell into that bucket this window.`],
    ["Spend+Tax = Ad Spend x 1.18 (18% GST), summed per campaign x SKU and multiplied once."],
    ["Ad Units = Direct Units Sold + Indirect Units Sold from the FSN report. Ad Revenue = its Total Revenue column — Flipkart attributes revenue to the ad, so ROAS here is genuine, not derived from price x units."],
    ["Orders = every Order report row's Quantity for that SKU/window EXCEPT status CANCELLED (a cancelled unit was never sold, so counting it would inflate Orders and depress ACOS/TACOS). A partially-returned line item exports as two rows sharing one order_item_id (e.g. quantity=2 RETURNED + quantity=1 DELIVERED) — summing both recovers the original gross order. Final = Orders - Returns. This switched from the earn more report to the Order report because earn more is typically uploaded for far fewer days, which starved Orders for most of the 30-day window; the Order report is order-item level so this now needs no netting Flipkart didn't already hand over."],
    returnsRows.length
      ? ["Returns = the Quantity of every row in the dedicated Returns report whose Return Requested Date falls in this window, per SKU — it tracks a return from the moment it's requested through in-transit/completed, which the Order report's order_item_status can still show as pending (RETURN_REQUESTED) or can miss entirely if the underlying order falls outside this window."]
      : ["Returns = the Quantity of Order report rows with status RETURNED (no dedicated Returns report was uploaded for this window, so this is the fallback — upload one to get the fuller, more accurate figure described above)."],
    ["Total Units (#) = the SKU's ad-attributed units across ALL its campaigns, so it repeats on every campaign row for that SKU, while Ad Units (#) is just that one campaign's share. For a SKU advertised by a single campaign the two are equal."],
    ["CPC (Analysis report) = Spend+Tax / Ad Units. ACOS = CPC / Price. TACOS = Spend+Tax / (Price x Final). Final, CPC and ACOS are live Excel formulas so the sheet recalculates if you edit a Price or an Orders figure."],
    ["TACOS sheet is keyed PER SKU, and its CPC is a DIFFERENT metric from the Analysis report's: here CPC = Spend+Tax / Final orders (cost per net order), matching the Amazon workbook's TACOS tab. TACOS (= CPC / Price) comes out the same either way."],
    [
      hasListings
        ? "Price comes from the barm_flipkart_listings snapshot (selling_price), with Stock / MRP / Listing Status alongside it. Where a SKU has no listing row, Price falls back to the window's realised ASP (final sale value / final units)."
        : "No listings snapshot is on file, so Price is the window's realised ASP (final sale value / final units) for every SKU, and Stock / MRP / Listing Status are blank. Upload the Flipkart listings file on the Upload Data tab to pin these to the real listing.",
    ],
    ["The listing block is a CURRENT snapshot, not time-windowed — it is shared by both the 30-day and 7-day blocks."],
    ["'Orders, returns, adspend' sheet: 4 independent top-20 lists side by side. A given row is NOT a joined record — the SKU in the Orders columns has no relation to the SKU in the Returns columns of that row."],
    ["FSN report / Returns report sheets: verbatim dumps of the uploaded files for the 30-day window, every original column kept (each uploaded row stores its source row, so nothing is trimmed)."],
    ["Order report rows are order-item level and include RETURNED, CANCELLED and in-flight statuses (READY_TO_SHIP, RETURN_REQUESTED, ...). It is now the SOURCE of the Orders/Returns figures (see the Orders line above) as well as operational detail (SLA breaches, logistics partner, return reasons)."],
    ["Earn more report is used ONLY for revenue now: Final Sale Value (Key Insights) and the Price ASP-fallback (final sale value / final units, for a SKU with no listings snapshot row). It no longer drives Orders/Returns — Order report carries no monetary columns at all, so Earn more is still needed for those two figures, but it is not required for Orders/Returns to be non-zero."],
    ["Order report rows repeating an (Order item ID, status, Quantity) triple are collapsed to one before this sheet is built (both here and at upload time) — Flipkart's export occasionally repeats a line item verbatim. This key deliberately does NOT include Order ID + SKU: Flipkart splits a 2-unit order of one SKU into two SEPARATE order item IDs of quantity 1, so keying on (Order ID, SKU, Quantity) silently deleted one leg of every such order and made Orders read low. The two legs of a partial return, which share ONE order item ID, both survive because their status and quantity differ."],
    ["Campaign ID (Analysis report) comes from the FSN report, looked up by Campaign Name — Flipkart's other three exports don't carry an ID, only the FSN report does."],
    ["Re-uploading a file that overlaps a period already uploaded replaces that period rather than duplicating it, so this report is safe to regenerate after a re-upload."],
  ]);
  wsNote["!cols"] = [{ wch: 120 }];
  wsNote["A1"].s = { font: { bold: true, sz: 13, color: { rgb: "312E81" } } };
  XLSX.utils.book_append_sheet(wb, wsNote, "Notes");

  const filename = `Flipkart_Historical_Analysis_Report_${win30.start}_to_${endDate}.xlsx`;
  return {
    wb,
    filename,
    pairCount: rows.length,
    skuCount: skuRows.length,
    spendTax30: gSpendTax,
    wastedSpend30: wastedSpend,
    /** Latest date any source has a row for, and how many days of the window
     *  trail past it. staleDays > 0 means the tail of both windows is empty —
     *  the window is NOT moved, the caller just says so. */
    dataThrough,
    staleDays,
    missingSources: [
      !fsnRows.length && FK_REPORT_LABEL.fsn_report,
      !earnRows.length && FK_REPORT_LABEL.earn_more,
      !orderRows.length && FK_REPORT_LABEL.order_report,
      !returnsRows.length && FK_REPORT_LABEL.returns,
    ].filter(Boolean) as string[],
  };
}

export async function exportFlipkartHistoricalReport(opts: FlipkartReportOpts) {
  const { wb, filename, ...stats } = await buildFlipkartHistoricalReportWorkbook(opts);
  // bookSST shares repeated strings instead of inlining them (these dumps repeat
  // the same ~150-char product titles thousands of times) and compression
  // DEFLATEs the zip entries — together the difference between a ~20MB and a
  // ~3MB file for identical data.
  XLSX.writeFile(wb, filename, { bookSST: true, compression: true });
  return { filename, ...stats };
}
