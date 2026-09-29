import { fetchAllRows } from "@/lib/amazonReportShared";
import { EXCLUDED_CATEGORIES, type PeriodWindow, type ProductRow } from "@/lib/amazonSkuPeriodData";
import { fetchMeeshoOrderRows, fetchMeeshoReturnRows } from "@/lib/meeshoBarmOrd";
import { categorizeTitle, resolveProductName } from "@/lib/categoryMap";
import { fetchProductMasterMap, buildProductMasterResolver } from "@/lib/productMasterUpload";
import { fetchMasterSkuidMap, buildMasterSkuidResolver } from "@/lib/masterProductSkuid";
import { fetchProductMarketingMap, buildProductMarketingResolver } from "@/lib/productMarketingUpload";
import type { WeeklySkuPeriodData } from "@/lib/weeklySalesExport";

// Meesho's counterpart of loadAmazonSkuPeriodData — the same per-SKU per-period shape, so the
// Meesho Weekly Sales Report runs through weeklySalesExport.ts's exact sheets and formulas (the
// seller asked for Meesho to be calculated the same way as the Amazon weekly report, 29 Sep 2026).
//
//   Orders           = units in meesho_barm_ord, every status except CANCELLED, by Order Date.
//   All Returns      = units in meesho_barm_return_intransit / _ofd / _delivered, each Suborder
//                      Number once, by Return Created Date (customer returns and courier RTO).
//   Customer Returns = the "Customer Return" rows of All Returns (courier RTO excluded), like Amazon.
//   Total Orders     = Orders − All Returns, unclamped (same as Amazon).
//   Total Sales      = Σ Quantity × Supplier Listed Price (Incl. GST + Commission) over that
//                      period's non-cancelled order rows — the seller's rule (29 Sep 2026), NOT
//                      Amazon's Price × Total Orders, so returns don't reduce it.
//   Price            = Total Sales ÷ Orders (average listed price per unit).
// Distinct orders are counted by the order number before the "_n" line suffix of Sub Order No.
// Meesho has no stock data here, so stockOf is always undefined (the Low Stock reason never fires).

function fmtDot(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

export async function loadMeeshoSkuPeriodData(opts: { periods: PeriodWindow[] }): Promise<WeeklySkuPeriodData> {
  const { periods } = opts;
  if (periods.length === 0) throw new Error("loadMeeshoSkuPeriodData: no periods");
  const rangeStart = periods[0].start;
  const rangeEnd = periods[periods.length - 1].end;
  const dataPulledAt = new Date().toISOString();
  const periodForDate = (dayIso: string | null): PeriodWindow | undefined =>
    dayIso ? periods.find((p) => dayIso >= p.start && dayIso <= p.end) : undefined;

  const [orderRows, returnRows, adRows, productMaster, masterSkuid, productMarketing] = await Promise.all([
    fetchMeeshoOrderRows(),
    fetchMeeshoReturnRows(),
    fetchAllRows("barm_daily_ms_barm_ads", (q) => q.gte("report_date", rangeStart).lte("report_date", rangeEnd)).catch(() => []),
    fetchProductMasterMap(),
    fetchMasterSkuidMap(),
    fetchProductMarketingMap(),
  ]);
  const { resolveName: resolveBarmName, resolveCategory: resolveBarmCategory } = buildProductMasterResolver(productMaster);
  const { resolveName: resolveSkuidName, resolveCategory: resolveSkuidCategory } = buildMasterSkuidResolver(masterSkuid);
  const { resolveName: resolveMarketingName, resolveCategory: resolveMarketingCategory } = buildProductMarketingResolver(productMarketing);
  const resolveMasterName = (sku: string, fallback: string) =>
    resolveMarketingName(sku, resolveSkuidName(sku, resolveBarmName(sku, fallback)));
  const resolveMasterCategory = (sku: string, fallback: string) =>
    resolveMarketingCategory(sku, resolveSkuidCategory(sku, resolveBarmCategory(sku, fallback)));

  const orderDates = orderRows.map((r) => r.order_date).filter((d): d is string => !!d).sort();
  const dataThrough = orderDates.length ? orderDates[orderDates.length - 1] : null;
  const staleDays = dataThrough
    ? Math.max(0, Math.round((Date.parse(`${rangeEnd}T00:00:00Z`) - Date.parse(`${dataThrough}T00:00:00Z`)) / 86_400_000))
    : 0;
  const returnDates = returnRows.map((r) => r.return_created_date).filter((d): d is string => !!d).sort();
  const returnsThrough = returnDates.length ? returnDates[returnDates.length - 1] : null;
  const returnCoverageWarnings =
    returnsThrough && returnsThrough < rangeEnd
      ? [
          `⚠ Meesho returns (meesho_barm_return_* tables) only reach ${fmtDot(returnsThrough)}, but the report runs to ${fmtDot(rangeEnd)}. All Returns and Customer Returns are understated for those days, so Total Orders and Total Sales are overstated.`,
        ]
      : [];

  const nameBySku = new Map<string, string>();
  const statsBySkuPeriod = new Map<string, Map<string, { orders: number; allReturns: number; returns: number; totalSales: number }>>();
  const ensurePeriodStat = (sku: string, label: string) => {
    let m = statsBySkuPeriod.get(sku);
    if (!m) { m = new Map(); statsBySkuPeriod.set(sku, m); }
    let s = m.get(label);
    if (!s) { s = { orders: 0, allReturns: 0, returns: 0, totalSales: 0 }; m.set(label, s); }
    return s;
  };
  const orderIdsBySkuPeriod = new Map<string, Set<string>>();
  const orderCountOf = (sku: string, label: string) => orderIdsBySkuPeriod.get(`${sku}|${label}`)?.size || 0;

  // Latest listed price per SKU, for displaying a price in a period the SKU didn't sell in.
  const latestPriceBySku = new Map<string, { date: string; price: number }>();
  orderRows.forEach((r) => {
    if (!r.sku) return;
    if (r.product_name && !nameBySku.has(r.sku)) nameBySku.set(r.sku, r.product_name);
    const price = Number(r.supplier_listed_price) || 0;
    const date = r.order_date || "";
    const prev = latestPriceBySku.get(r.sku);
    if (price > 0 && (!prev || date > prev.date)) latestPriceBySku.set(r.sku, { date, price });
  });

  orderRows.forEach((r) => {
    const pd = periodForDate(r.order_date);
    if (!r.sku || !pd) return;
    if (r.order_status.toUpperCase().startsWith("CANCEL")) return;
    const qty = Number(r.quantity) || 0;
    const s = ensurePeriodStat(r.sku, pd.label);
    s.orders += qty;
    s.totalSales += qty * (Number(r.supplier_listed_price) || latestPriceBySku.get(r.sku)?.price || 0);
    const key = `${r.sku}|${pd.label}`;
    let ids = orderIdsBySkuPeriod.get(key);
    if (!ids) { ids = new Set(); orderIdsBySkuPeriod.set(key, ids); }
    ids.add(r.sub_order_no.replace(/_\d+$/, ""));
  });

  returnRows.forEach((r) => {
    const pd = periodForDate(r.return_created_date);
    if (!r.sku || !pd) return;
    if (r.product_name && !nameBySku.has(r.sku)) nameBySku.set(r.sku, r.product_name);
    const s = ensurePeriodStat(r.sku, pd.label);
    s.allReturns += r.quantity;
    if (r.type_of_return.trim().toLowerCase() === "customer return") s.returns += r.quantity;
  });

  const adsBySkuPeriod = new Map<string, { spend: number; adSales: number; clicks: number; impressions: number }>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adRows as any[]).forEach((r) => {
    const sku = String(r.sku || "").trim();
    const pd = periodForDate(r.report_date ? String(r.report_date).slice(0, 10) : null);
    if (!sku || !pd) return;
    const key = `${sku}|${pd.label}`;
    const cur = adsBySkuPeriod.get(key) || { spend: 0, adSales: 0, clicks: 0, impressions: 0 };
    cur.spend += Number(r.spend) || 0;
    cur.clicks += Number(r.clicks) || 0;
    cur.impressions += Number(r.views) || 0;
    adsBySkuPeriod.set(key, cur);
  });
  const adsOf = (sku: string, label: string) => adsBySkuPeriod.get(`${sku}|${label}`);
  const hasAdData = adRows.length > 0;
  const stockOf = (_sku: string): number | undefined => undefined;

  const products = new Map<string, ProductRow>();
  statsBySkuPeriod.forEach((periodMap, sku) => {
    const rawName = nameBySku.get(sku) || sku;
    const p: ProductRow = {
      sku,
      name: resolveMasterName(sku, resolveProductName(rawName, sku) || rawName),
      periods: {},
      grandTotalSales: 0,
      hasActivity: true,
    };
    periods.forEach((pd) => {
      const raw = periodMap.get(pd.label);
      if (!raw) return;
      const totalOrders = raw.orders - raw.allReturns;
      const price = raw.orders > 0 ? raw.totalSales / raw.orders : 0;
      const totalSales = raw.totalSales;
      p.periods[pd.label] = { orders: raw.orders, allReturns: raw.allReturns, returns: raw.returns, totalOrders, price, totalSales };
      p.grandTotalSales += totalSales;
    });
    // Display-only price backfill for a period with no orders, same as Amazon.
    const knownPrice = periods.map((pd) => p.periods[pd.label]?.price || 0).find((v) => v > 0) || latestPriceBySku.get(sku)?.price || 0;
    periods.forEach((pd) => {
      const stat = p.periods[pd.label];
      if (stat && stat.price === 0) stat.price = knownPrice;
    });
    products.set(sku, p);
  });

  const rows = [...products.values()].sort((a, b) => b.grandTotalSales - a.grandTotalSales);
  const categoryAgg = new Map<string, { periods: Record<string, { sales: number; units: number }>; grandSales: number; grandUnits: number }>();
  const catBySku = new Map<string, string>();
  rows.forEach((p) => {
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
  [...categoryAgg.entries()].sort((a, b) => b[1].grandSales - a[1].grandSales).forEach(([name], i) => categoryRank.set(name, i));
  const rowsByCategory = [...visibleRows].sort((a, b) => {
    const ra = categoryRank.get(catBySku.get(a.sku) || "") ?? 999;
    const rb = categoryRank.get(catBySku.get(b.sku) || "") ?? 999;
    if (ra !== rb) return ra - rb;
    return b.grandTotalSales - a.grandTotalSales;
  });

  return {
    dataPulledAt, dataThrough, staleDays, returnCoverageWarnings,
    visibleRows, rowsByCategory, catBySku, categoryAgg, periodTotals,
    stockOf, adsOf, hasAdData, orderCountOf, orderIdsBySkuPeriod,
  };
}
