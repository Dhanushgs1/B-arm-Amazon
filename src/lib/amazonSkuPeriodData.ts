import { fetchAllRows, isGenuineAmReturn, isGenuineFbaReturn } from "@/lib/historicalAnalysisReportExport";
import { istDayWindowUtc, istDateOnly, isStandardOrderId } from "@/lib/amazonReportShared";
import { dedupeSellerFlexReturns } from "@/lib/amazonSpendRules";
import { fetchMisAmazonOrders, fetchMisAmazonReturns, fetchMisFbaReturns, fetchMisSellerFlexReturns, fetchAllMisReportDataInfo } from "@/lib/misAdapters";
import { staleSourceWarnings } from "@/lib/reportCoverage";
import { categorizeTitle, resolveProductName } from "@/lib/categoryMap";
import { fetchProductMasterMap, buildProductMasterResolver } from "@/lib/productMasterUpload";
import { fetchMasterSkuidMap, buildMasterSkuidResolver, fetchMasterSkuidAmazonCatalog } from "@/lib/masterProductSkuid";
import { fetchProductMarketingMap, buildProductMarketingResolver } from "@/lib/productMarketingUpload";

// Per-SKU, per-period Amazon sales figures from the app's synced MIS tables (orders, AM/FBA/
// SellerFlex returns) — never live SellerMate. Shared by the Weekly Sales Report (two periods:
// last week / this week, weeklySalesExport.ts) and the Amazon Daily/Weekly/Monthly Sales report
// (any number of periods from buildPeriods, amazonSalesExport.ts), so both compute Orders, All
// Returns, Customer Returns, Total Orders, Price and Total Sales identically. Periods must be
// consecutive and non-overlapping; every row is fetched once over [first start, last end] and
// bucketed by IST calendar day in memory.

export interface PeriodWindow {
  label: string;
  start: string;
  end: string;
}

export interface PeriodStats {
  orders: number; // units ordered
  allReturns: number; // every return reported, including courier RTO/undeliverable
  returns: number; // genuine customer returns only
  totalOrders: number;
  price: number;
  totalSales: number;
  /** Only for channels whose weekly report shows a separate gross column (Meesho). */
  grossSales?: number;
}

export interface ProductRow {
  sku: string;
  name: string;
  periods: Record<string, PeriodStats>;
  grandTotalSales: number;
  // False for a row seeded purely from the product catalog with zero orders in every period —
  // kept out of Growth Summary/decliner analysis (nothing to analyze) but still shown on the
  // Amazon Sales sheet, at the bottom, so the seller can see what isn't selling.
  hasActivity: boolean;
}

const ZERO_PERIOD_STATS: PeriodStats = { orders: 0, allReturns: 0, returns: 0, totalOrders: 0, price: 0, totalSales: 0 };

function fmtDot(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

export const EXCLUDED_CATEGORIES = new Set(["Discontinued", "Other"]);

export async function loadAmazonSkuPeriodData(opts: {
  periods: PeriodWindow[];
  // Sponsored Products spend/clicks per SKU per period (adsOf/hasAdData) — only the weekly
  // report's insights use it, so callers that don't can skip the fetch.
  includeAds?: boolean;
}) {
  const { periods, includeAds = true } = opts;
  if (periods.length === 0) throw new Error("loadAmazonSkuPeriodData: no periods");
  const rangeStart = periods[0].start;
  const rangeEnd = periods[periods.length - 1].end;
  // Stamped once at the moment this build reads its source tables, written to
  // the report's Notes sheet — the same field historicalAnalysisReportExport.ts
  // carries, so the two reports' generation times can be compared directly
  // instead of assuming any per-SKU drift between them is a bug.
  const dataPulledAt = new Date().toISOString();
  const periodForDate = (dayIso: string): PeriodWindow | undefined =>
    periods.find((p) => dayIso >= p.start && dayIso <= p.end);

  // Both windows' order/return timestamps are bucketed by IST calendar day
  // (istDayWindowUtc), not the raw UTC instant — matching
  // historicalAnalysisReportExport.ts's own convention (see amazonReportShared.ts's
  // comment: truncating the UTC instant directly puts any row from ~18:30 UTC
  // onward on the wrong, earlier calendar day). The two reports used to disagree
  // by a handful of units on exactly the SKUs with orders/returns near midnight
  // IST, because this file bucketed by the raw UTC purchase_date/return_date
  // while the Historical report already shifted into IST.
  const ordersWindow = istDayWindowUtc(rangeStart, rangeEnd);
  const fbaReturnsWindow = istDayWindowUtc(rangeStart, rangeEnd);

  // How far each return source reaches, checked in parallel with the main fetch below.
  const coveragePromise = fetchAllMisReportDataInfo();
  // Fetch every relevant row once across the whole span of the periods, split by date in memory
  // below — same "fetch once, filter per window" approach historicalAnalysisReportExport.ts uses for its 30/7-day windows.
  const [orderRows, amReturnRows, fbaReturnRows, sfReturnRows, priceListingRows, ledgerRows, adRows, productMaster, masterSkuid, masterSkuidCatalog, productMarketing] = await Promise.all([
    fetchMisAmazonOrders((q) => q.gte("purchase_datetime", ordersWindow.gte).lt("purchase_datetime", ordersWindow.lt)),
    fetchMisAmazonReturns((q) => q.gte("return_request_date", rangeStart).lte("return_request_date", rangeEnd)),
    fetchMisFbaReturns((q) =>
      q.gte("return_date", fbaReturnsWindow.gte).lt("return_date", fbaReturnsWindow.lt)
    ),
    // SellerFlex (self-fulfilled) returns — a separate export from AM/FBA returns, with no order
    // overlap between them. Previously never fetched here, so SF-heavy SKUs (Insemination kit,
    // Ovulation thermometer) under-reported All Returns and over-reported Total Orders.
    fetchMisSellerFlexReturns((q) => q.gte("pickup_date", rangeStart).lte("pickup_date", rangeEnd)),
    fetchAllRows("barm_amazon_price_listing", (q) => q),
    // The ledger is a point-in-time snapshot of stock on hand, not a per-day history — it holds
    // whichever date the last upload covered, which is normally AFTER the report window. Filtering
    // it to `ledger_date <= rangeEnd` matched nothing, so every FBA SKU read as 0 units and
    // every decliner was labelled "Low stock — check replenishment" (A019-14 was flagged at 0 units
    // while actually holding 277). Take the whole snapshot and pick its latest date below.
    fetchAllRows("barm_amazon_inventory_ledger", (q) => q.eq("disposition", "SELLABLE")),
    // Sponsored-Products performance per advertised SKU per day — lets the category insights below
    // attribute a decline to ad pull-back rather than guessing. Optional: an account with no ads
    // uploaded simply yields no rows, and the campaign reason never fires.
    includeAds
      ? fetchAllRows("barm_amazon_sp_advertised_product", (q) =>
          q.gte("report_date", rangeStart).lte("report_date", rangeEnd)
        ).catch(() => [])
      : Promise.resolve([]),
    fetchProductMasterMap(),
    fetchMasterSkuidMap(),
    fetchMasterSkuidAmazonCatalog(),
    fetchProductMarketingMap(),
  ]);
  const { resolveName: resolveBarmName, resolveCategory: resolveBarmCategory } = buildProductMasterResolver(productMaster);
  const { resolveName: resolveSkuidName, resolveCategory: resolveSkuidCategory } = buildMasterSkuidResolver(masterSkuid);
  const { resolveName: resolveMarketingName, resolveCategory: resolveMarketingCategory } = buildProductMarketingResolver(productMarketing);
  // master_product_marketing is the marketing team's freshest, most current master — checked
  // first; master_product_skuid and barm_product_master only fill in a SKU it doesn't have.
  const resolveMasterName = (sku: string, fallback: string) =>
    resolveMarketingName(sku, resolveSkuidName(sku, resolveBarmName(sku, fallback)));
  const resolveMasterCategory = (sku: string, fallback: string) =>
    resolveMarketingCategory(sku, resolveSkuidCategory(sku, resolveBarmCategory(sku, fallback)));

  // How far the uploaded/MIS-synced orders actually reach. If they stop
  // before the end of "this week", the current week is measured over fewer
  // days than the one it's compared against, and every Growth % reads
  // catastrophically negative for no reason other than missing data — see
  // the identical check in flipkartWeeklySalesExport.ts, which this mirrors.
  const orderDates = orderRows.map((r) => r.purchase_date).filter((d): d is string => !!d).sort();
  const dataThrough = orderDates.length ? orderDates[orderDates.length - 1] : null;
  const staleDays = dataThrough
    ? Math.max(0, Math.round((Date.parse(`${rangeEnd}T00:00:00Z`) - Date.parse(`${dataThrough}T00:00:00Z`)) / 86_400_000))
    : 0;
  // Same idea per return source: AM returns stopped syncing on 3 Sep 2026 while orders ran on, and
  // the report showed 0 AM returns for the later days as if none happened.
  const coverage = await coveragePromise;
  const returnCoverageWarnings = staleSourceWarnings(
    [
      { label: "AM returns (amazon_returns)", maxDate: coverage.am_returns?.maxDate ?? null, error: coverage.am_returns?.error },
      { label: "FBA returns (amazon_fba_returns)", maxDate: coverage.fba_returns?.maxDate ?? null, error: coverage.fba_returns?.error },
      { label: "SellerFlex returns (amazon_seller_flex_return)", maxDate: coverage.sf_return?.maxDate ?? null, error: coverage.sf_return?.error },
    ],
    rangeEnd,
    "All Returns and Customer Returns are understated for those days, so Total Orders and Total Sales are overstated.",
    fmtDot
  );

  // Uploaded Price/Listing snapshot, keyed by SKU. Two uses: filling in a shelf price for a period
  // where a SKU had zero orders, and standing in for an order row whose own price came through as 0.
  const catalogPriceBySku = new Map<string, number>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  priceListingRows.forEach((r: any) => {
    if (!r.seller_sku) return;
    const price = Number(r.price) || 0;
    if (price > 0 && !catalogPriceBySku.has(r.seller_sku)) catalogPriceBySku.set(r.seller_sku, price);
  });

  // ── Per-SKU per-period aggregation ──
  const nameBySku = new Map<string, string>();
  const statsBySkuPeriod = new Map<string, Map<string, { orders: number; allReturns: number; returns: number; totalSales: number }>>();
  const ensurePeriodStat = (sku: string, label: string) => {
    let m = statsBySkuPeriod.get(sku);
    if (!m) { m = new Map(); statsBySkuPeriod.set(sku, m); }
    let s = m.get(label);
    if (!s) { s = { orders: 0, allReturns: 0, returns: 0, totalSales: 0 }; m.set(label, s); }
    return s;
  };

  // Distinct order count per SKU per period, kept separate from unit count — one order can carry
  // several units, so "orders down 30%" and "units down 30%" are different statements and the
  // category insights below report both.
  const orderIdsBySkuPeriod = new Map<string, Set<string>>();
  const countOrder = (sku: string, label: string, orderId: string) => {
    const key = `${sku}|${label}`;
    let set = orderIdsBySkuPeriod.get(key);
    if (!set) { set = new Set(); orderIdsBySkuPeriod.set(key, set); }
    set.add(orderId);
  };
  const orderCountOf = (sku: string, label: string) => orderIdsBySkuPeriod.get(`${sku}|${label}`)?.size || 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  orderRows.forEach((r: any) => {
    if (!r.sku || !r.purchase_datetime) return;
    // IST calendar day, not the raw UTC purchase_date column — see the fetch
    // above's comment. Bucketing by purchase_date here (this file's old
    // behaviour) put any order from ~18:30 UTC onward a day earlier than the
    // Historical Analysis Report placed the exact same order.
    const pd = periodForDate(istDateOnly(r.purchase_datetime));
    if (!pd) return;
    if (r.product_name && !nameBySku.has(r.sku)) nameBySku.set(r.sku, r.product_name);
    // A cancelled order never became revenue. Amazon still exports a row for it, usually with no
    // quantity but occasionally carrying a price — counting those added phantom sales.
    if (String(r.order_status || "").toLowerCase().startsWith("cancelled")) return;
    // Non-standard order IDs ("S02-..." instead of "NNN-NNNNNNN-NNNNNNN") aren't
    // real sales — historicalAnalysisReportExport.ts already excludes these,
    // verified against the seller's own workbook (every S02- row is absent from
    // their Orders sheet). Without this exclusion here too, a single SKU with a
    // couple of large S02- rows could read many times its real order count —
    // e.g. one live SKU read 214 units here against 8 on the Historical report,
    // entirely from two 103-unit S02- rows.
    if (!isStandardOrderId(r.amazon_order_id)) return;
    const qty = r.quantity || 0;
    const s = ensurePeriodStat(r.sku, pd.label);
    s.orders += qty;
    // item_price in Amazon's Orders export is the LINE TOTAL (already quantity-multiplied) —
    // a qty-2 line of a ₹399 product carries item_price 798, not 399. Multiplying by qty again
    // inflated every multi-unit order (verified against barm_amazon_am_orders: 0 of 282
    // multi-qty rows match a per-unit reading, 227 match line-total).
    // Some despatched rows arrive with item_price 0 despite real units (whole SKUs, e.g.
    // B-OVU-STRIPS-PK10-3's 30 shipped units, reported ₹0) — fall back to the listing price so
    // that revenue isn't silently dropped.
    const linePrice = Number(r.item_price) || 0;
    s.totalSales += linePrice > 0 ? linePrice : qty * (catalogPriceBySku.get(r.sku) || 0);
    if (r.amazon_order_id) countOrder(r.sku, pd.label, String(r.amazon_order_id));
  });

  // ── Ad spend/clicks per SKU per period (Sponsored Products) ──
  const adsBySkuPeriod = new Map<string, { spend: number; adSales: number; clicks: number; impressions: number }>();
  // Plain sum of every SP-table row's raw spend (no orphan-campaign divisor), including the seller's
  // per-SKU split of Brand/Display spend — the SKU attribution the seller wants counted (24 Sep 2026).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adRows.forEach((r: any) => {
    const sku = r.advertised_sku;
    if (!sku || !r.report_date) return;
    const pd = periodForDate(String(r.report_date).slice(0, 10));
    if (!pd) return;
    const key = `${sku}|${pd.label}`;
    const cur = adsBySkuPeriod.get(key) || { spend: 0, adSales: 0, clicks: 0, impressions: 0 };
    cur.spend += Number(r.spend) || 0;
    cur.adSales += Number(r.sales_7d) || 0;
    cur.clicks += Number(r.clicks) || 0;
    cur.impressions += Number(r.impressions) || 0;
    adsBySkuPeriod.set(key, cur);
  });
  const adsOf = (sku: string, label: string) => adsBySkuPeriod.get(`${sku}|${label}`);
  const hasAdData = adRows.length > 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  amReturnRows.forEach((r: any) => {
    if (!r.merchant_sku || !r.return_request_date) return;
    const pd = periodForDate(String(r.return_request_date).slice(0, 10));
    if (!pd) return;
    const qty = r.return_quantity || 0;
    const s = ensurePeriodStat(r.merchant_sku, pd.label);
    s.allReturns += qty;
    if (isGenuineAmReturn(r)) s.returns += qty;
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fbaReturnRows.forEach((r: any) => {
    if (!r.sku || !r.return_date) return;
    // IST calendar day, same reasoning as the orders block above —
    // return_date is a timestamptz, and slicing its raw UTC value put a
    // late-evening-IST return on the wrong day relative to the Historical
    // Analysis Report, which already bucketed FBA returns by IST.
    const pd = periodForDate(istDateOnly(r.return_date));
    if (!pd) return;
    const qty = r.quantity || 0;
    const s = ensurePeriodStat(r.sku, pd.label);
    s.allReturns += qty;
    if (isGenuineFbaReturn(r)) s.returns += qty;
  });
  // The MIS amazon_seller_flex_return table holds each return several times over (one copy per
  // re-upload), so each (order, shipment, mSKU) counts once — see dedupeSellerFlexReturns.
  // pickup_date is already an IST calendar date.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dedupeSellerFlexReturns(sfReturnRows as any[]).forEach((r: any) => {
    const pd = periodForDate(r.pickup_date);
    if (!pd) return;
    const qty = r.units || 0;
    const s = ensurePeriodStat(r.msku, pd.label);
    s.allReturns += qty;
    // SF's "Return Type" uses the same UNDELIVERED / CUSTOMER_RETURN split as AM returns.
    if (isGenuineAmReturn(r)) s.returns += qty;
  });

  // ── Stock-on-hand (best-effort — only used for the Growth Summary's "Low stock" reason) ──
  const fbmQtyBySku = new Map<string, number>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  priceListingRows.forEach((r: any) => {
    if (!r.seller_sku) return;
    const isFba = typeof r.fulfillment_channel === "string" && r.fulfillment_channel.toUpperCase().startsWith("AMAZON");
    if (!isFba) fbmQtyBySku.set(r.seller_sku, (fbmQtyBySku.get(r.seller_sku) || 0) + (Number(r.quantity) || 0));
  });
  const fbaTotalBySku = new Map<string, number>();
  // SKUs the ledger actually covers, balance or not. A SKU missing from the snapshot has UNKNOWN
  // stock, which is not the same as zero — without this distinction every untracked SKU (131 of
  // the 225 that sold in a recent week) would be reported as "0 units on hand".
  const ledgerTrackedSkus = new Set<string>();
  {
    const latestByKey = new Map<string, { ledger_date: string; msku: string; ending_balance: number }>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ledgerRows.forEach((r: any) => {
      if (!r.msku) return;
      ledgerTrackedSkus.add(r.msku);
      const key = `${r.msku}|${r.location}`;
      const cur = latestByKey.get(key);
      if (!cur || r.ledger_date > cur.ledger_date) latestByKey.set(key, r);
    });
    latestByKey.forEach((r) => {
      const bal = r.ending_balance || 0;
      if (bal <= 0) return;
      fbaTotalBySku.set(r.msku, (fbaTotalBySku.get(r.msku) || 0) + bal);
    });
  }
  const fbmTrackedSkus = new Set(fbmQtyBySku.keys());
  // undefined = no stock signal for this SKU, so callers must not claim anything about its stock.
  const stockOf = (sku: string): number | undefined => {
    if (!ledgerTrackedSkus.has(sku) && !fbmTrackedSkus.has(sku)) return undefined;
    return (fbaTotalBySku.get(sku) || 0) + (fbmQtyBySku.get(sku) || 0);
  };

  // ── Build product rows ──
  const products = new Map<string, ProductRow>();
  const ensureProduct = (sku: string): ProductRow => {
    let p = products.get(sku);
    if (!p) {
      const rawName = nameBySku.get(sku) || sku;
      // Product Master's approved name wins over both the order-report name and the older
      // hand-maintained SKU_NAME_MAP in categoryMap.ts — same seller-curated priority as the
      // Amazon Sales report. A SKU the master doesn't have yet keeps whatever name resolveProductName
      // (or the raw order-report name) already produced.
      const name = resolveMasterName(sku, resolveProductName(rawName, sku) || rawName);
      p = { sku, name, periods: {}, grandTotalSales: 0, hasActivity: true };
      products.set(sku, p);
    }
    return p;
  };
  statsBySkuPeriod.forEach((periodMap, sku) => {
    const p = ensureProduct(sku);
    periods.forEach((pd) => {
      const raw = periodMap.get(pd.label);
      if (!raw) return;
      // Total Orders = Orders - All Returns. Previously this subtracted a
      // deduped AM-else-FBA+SF figure instead of raw.allReturns, on the theory
      // that AM and FBA/SF sometimes record the SAME physical return twice —
      // but that logic silently dropped genuinely distinct courier RTO returns
      // (recorded only in the FBA/SF export) any time the SKU/period also had
      // an ordinary AM-recorded customer return, e.g. A019-13: Orders 4, AM
      // returns 3 (all genuine), FBA/SF returns a further 2 courier RTOs — the
      // dedup used only the AM figure (3) instead of All Returns (5). Flagged
      // by the seller reconciling this report against their own workbook, which
      // reduces Total Orders by every return reported. Left unclamped: a return
      // recorded with no matching order THIS window (the order belongs to an
      // earlier period) legitimately goes negative.
      const totalOrders = raw.orders - raw.allReturns;
      const price = raw.orders > 0 ? raw.totalSales / raw.orders : 0;
      // Total Sales must reflect the SAME net-of-returns units as Total Orders —
      // raw.totalSales is the gross revenue for every unit ORDERED this period,
      // so a fully-returned order (Total Orders 0) still showed its full gross
      // revenue instead of 0. Also flagged by the seller (A019-13: Total Orders
      // 0 but Total Sales showed 3,156, i.e. Orders x Price instead of Total
      // Orders x Price).
      const totalSales = price * totalOrders;
      p.periods[pd.label] = { orders: raw.orders, allReturns: raw.allReturns, returns: raw.returns, totalOrders, price, totalSales };
      p.grandTotalSales += totalSales;
    });
  });

  // A period with zero orders computes price as 0 above — backfill it from whichever other
  // period actually sold this SKU, falling back to the uploaded catalog snapshot. Display-only:
  // does not touch totalSales/growth, which correctly stay 0 for a period with no orders.
  products.forEach((p) => {
    const knownPrice = periods.map((pd) => p.periods[pd.label]?.price || 0).find((v) => v > 0) || catalogPriceBySku.get(p.sku) || 0;
    if (!knownPrice) return;
    periods.forEach((pd) => {
      const stat = p.periods[pd.label];
      if (stat && stat.price === 0) stat.price = knownPrice;
    });
  });

  // Seed a zero-order row for every known Amazon SKU that had no order/return activity at all
  // in any period, so the seller can see what ISN'T selling and not just what is — placed at the
  // bottom of the sheet (see rowsByCategory below) and excluded from Growth Summary/decliner
  // analysis (nothing to analyze about a SKU with no activity), but still present on Amazon Sales.
  masterSkuidCatalog.forEach((entry) => {
    if (products.has(entry.sku)) return;
    const price = catalogPriceBySku.get(entry.sku) || 0;
    products.set(entry.sku, {
      sku: entry.sku,
      name: resolveMasterName(entry.sku, entry.name),
      periods: Object.fromEntries(periods.map((pd) => [pd.label, { ...ZERO_PERIOD_STATS, price }])),
      grandTotalSales: 0,
      hasActivity: false,
    });
  });

  const rows = [...products.values()].sort((a, b) => b.grandTotalSales - a.grandTotalSales);

  // ── Category/Department aggregation — same per-product per-period data, grouped by department. ──
  const categoryAgg = new Map<string, { periods: Record<string, { sales: number; units: number }>; grandSales: number; grandUnits: number }>();
  const catBySku = new Map<string, string>();
  rows.forEach((p) => {
    // Product Master's own Category column wins when the SKU is in it, same seller-curated
    // priority as the name resolution above; categoryMap.ts's SKU_CATEGORY_MAP / title
    // fuzzy-match only fills in SKUs the master doesn't have a category for yet.
    const cat = resolveMasterCategory(p.sku, categorizeTitle(p.name, undefined, p.sku));
    catBySku.set(p.sku, cat);
    let c = categoryAgg.get(cat);
    if (!c) { c = { periods: {}, grandSales: 0, grandUnits: 0 }; categoryAgg.set(cat, c); }
    periods.forEach((pd) => {
      const stat = p.periods[pd.label];
      if (!stat) return;
      const cur = c!.periods[pd.label] || { sales: 0, units: 0 };
      cur.sales += stat.totalSales;
      cur.units += stat.orders;
      c!.periods[pd.label] = cur;
      c!.grandSales += stat.totalSales;
      c!.grandUnits += stat.orders;
    });
  });

  const visibleRows = rows.filter((p) => !EXCLUDED_CATEGORIES.has(catBySku.get(p.sku) || "Other"));

  // Per-week totals over exactly the rows the Amazon Sales sheet shows — returned to callers so the
  // weekly email's KPIs are this workbook's own figures, never a separately computed approximation.
  const periodTotals = periods.map((pd) => {
    const t = { label: pd.label, start: pd.start, end: pd.end, orders: 0, allReturns: 0, customerReturns: 0, totalOrders: 0, totalSales: 0 };
    visibleRows.forEach((p) => {
      const s = p.periods[pd.label];
      if (!s) return;
      t.orders += s.orders;
      t.allReturns += s.allReturns;
      t.customerReturns += s.returns;
      t.totalOrders += s.totalOrders;
      t.totalSales += s.totalSales;
    });
    return t;
  });

  const categoryRank = new Map<string, number>();
  [...categoryAgg.entries()]
    .sort((a, b) => b[1].grandSales - a[1].grandSales)
    .forEach(([name], i) => categoryRank.set(name, i));
  // Every SKU with real activity first (grouped by department, best-selling department and then
  // best-selling product within it — unchanged from before), THEN every zero-order catalog-seeded
  // SKU at the very bottom of the sheet (grouped by department, then alphabetically) — so a reader
  // scanning top-down sees real performance first and "not selling at all" as a distinct trailing
  // block, not interleaved with it.
  const rowsByCategory = [...visibleRows].sort((a, b) => {
    if (a.hasActivity !== b.hasActivity) return a.hasActivity ? -1 : 1;
    const ra = categoryRank.get(catBySku.get(a.sku) || "") ?? 999;
    const rb = categoryRank.get(catBySku.get(b.sku) || "") ?? 999;
    if (ra !== rb) return ra - rb;
    if (!a.hasActivity) return a.name.localeCompare(b.name);
    return b.grandTotalSales - a.grandTotalSales;
  });
  return {
    dataPulledAt, dataThrough, staleDays, returnCoverageWarnings,
    products, rows, visibleRows, rowsByCategory, catBySku, categoryAgg, periodTotals,
    stockOf, adsOf, hasAdData, orderCountOf, orderIdsBySkuPeriod,
  };
}
