import type { PeriodWindow, ProductRow } from "@/lib/amazonSkuPeriodData";
import { fetchBarmOnlineOrders } from "@/lib/barmOnlineOrders";
import { categorizeTitle } from "@/lib/categoryMap";
import { fetchProductMasterMap, buildProductMasterResolver } from "@/lib/productMasterUpload";
import { fetchMasterSkuidMap, buildMasterSkuidResolver } from "@/lib/masterProductSkuid";
import { fetchProductMarketingMap, buildProductMarketingResolver } from "@/lib/productMarketingUpload";
import type { WeeklySkuPeriodData } from "@/lib/weeklySalesExport";

// BARM's counterpart of loadAmazonSkuPeriodData / loadMeeshoSkuPeriodData — the same per-SKU
// per-period shape, so the BARM Weekly Sales Report runs through weeklySalesExport.ts's exact
// sheets and formulas. Built from barm_online_orders with the seller's BARM rules
// (barmOnlineOrders.ts): Received orders only, cancelled/returned rows skipped, Sales = each
// order's Order Total Amount counted once.
//
//   Orders           = units ordered, by Order Date.
//   All / Customer Returns = 0 — barm_online_orders carries no returns data.
//   Total Orders     = Orders.
//   Total Sales      = Σ Order Total Amount. A single-product order's total is that SKU's sale;
//                      every multi-product order of the week is summed into ONE row,
//                      "Multi-product orders (not split)", since its total can't be split across
//                      its products without guessing.
//   Price            = Total Sales ÷ Orders (0 on the multi-product row).
// SKUs that resolve to no category are listed as "Uncategorised" rather than hidden (the Amazon
// report hides "Other"), so no BARM sale drops out of the totals. No stock or ad data exists here.

export const BARM_MULTI_SKU = "MULTI-PRODUCT";
const MULTI_NAME = "Multi-product orders (not split)";
const MULTI_CATEGORY = "Multi-product orders";

export async function loadBarmSkuPeriodData(opts: { periods: PeriodWindow[] }): Promise<WeeklySkuPeriodData> {
  const { periods } = opts;
  if (periods.length === 0) throw new Error("loadBarmSkuPeriodData: no periods");
  const rangeEnd = periods[periods.length - 1].end;
  const dataPulledAt = new Date().toISOString();
  const periodForDate = (dayIso: string): PeriodWindow | undefined => periods.find((p) => dayIso >= p.start && dayIso <= p.end);

  const [orders, productMaster, masterSkuid, productMarketing] = await Promise.all([
    fetchBarmOnlineOrders(),
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

  const orderDates = orders.map((o) => o.order_date).sort();
  const dataThrough = orderDates.length ? orderDates[orderDates.length - 1] : null;
  const staleDays = dataThrough
    ? Math.max(0, Math.round((Date.parse(`${rangeEnd}T00:00:00Z`) - Date.parse(`${dataThrough}T00:00:00Z`)) / 86_400_000))
    : 0;
  const returnCoverageWarnings = [
    "BARM: barm_online_orders carries no returns data, so All Returns and Customer Returns are 0 and Total Orders equals Orders.",
  ];

  const nameBySku = new Map<string, string>();
  const stats = new Map<string, Map<string, { orders: number; totalSales: number }>>();
  const orderIdsBySkuPeriod = new Map<string, Set<string>>();
  const add = (sku: string, label: string, units: number, sales: number, orderNumber: string) => {
    let m = stats.get(sku);
    if (!m) { m = new Map(); stats.set(sku, m); }
    const s = m.get(label) || { orders: 0, totalSales: 0 };
    s.orders += units;
    s.totalSales += sales;
    m.set(label, s);
    const key = `${sku}|${label}`;
    let ids = orderIdsBySkuPeriod.get(key);
    if (!ids) { ids = new Set(); orderIdsBySkuPeriod.set(key, ids); }
    ids.add(orderNumber);
  };

  orders.forEach((o) => {
    const pd = periodForDate(o.order_date);
    if (!pd) return;
    const units = o.lines.reduce((t, l) => t + l.quantity, 0);
    if (o.lines.length > 1) {
      add(BARM_MULTI_SKU, pd.label, units, o.total, o.order_number);
      return;
    }
    const line = o.lines[0];
    const sku = line.sku || line.name;
    if (!nameBySku.has(sku)) nameBySku.set(sku, line.name);
    add(sku, pd.label, units, o.total, o.order_number);
  });
  const orderCountOf = (sku: string, label: string) => orderIdsBySkuPeriod.get(`${sku}|${label}`)?.size || 0;

  const products: ProductRow[] = [];
  const catBySku = new Map<string, string>();
  stats.forEach((periodMap, sku) => {
    const isMulti = sku === BARM_MULTI_SKU;
    const rawName = nameBySku.get(sku) || sku;
    const p: ProductRow = {
      sku,
      name: isMulti ? MULTI_NAME : resolveMasterName(sku, rawName),
      periods: {},
      grandTotalSales: 0,
      hasActivity: true,
    };
    periods.forEach((pd) => {
      const raw = periodMap.get(pd.label);
      if (!raw) return;
      // A multi-product row's total isn't split, so it has no per-unit price (0).
      const price = !isMulti && raw.orders > 0 ? raw.totalSales / raw.orders : 0;
      p.periods[pd.label] = { orders: raw.orders, allReturns: 0, returns: 0, totalOrders: raw.orders, price, totalSales: raw.totalSales };
      p.grandTotalSales += raw.totalSales;
    });
    // Display-only price backfill for a period with no orders, same as Amazon.
    const knownPrice = periods.map((pd) => p.periods[pd.label]?.price || 0).find((v) => v > 0) || 0;
    periods.forEach((pd) => {
      const stat = p.periods[pd.label];
      if (stat && stat.price === 0) stat.price = knownPrice;
    });
    const cat = isMulti ? MULTI_CATEGORY : resolveMasterCategory(sku, categorizeTitle(p.name, undefined, sku));
    catBySku.set(sku, cat === "Other" ? "Uncategorised" : cat);
    products.push(p);
  });

  const rows = products.sort((a, b) => b.grandTotalSales - a.grandTotalSales);
  const visibleRows = rows.filter((p) => catBySku.get(p.sku) !== "Discontinued");
  const categoryAgg = new Map<string, { periods: Record<string, { sales: number; units: number }>; grandSales: number; grandUnits: number }>();
  visibleRows.forEach((p) => {
    const cat = catBySku.get(p.sku)!;
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

  const periodTotals = periods.map((pd) => {
    const t = { label: pd.label, start: pd.start, end: pd.end, orders: 0, allReturns: 0, customerReturns: 0, totalOrders: 0, totalSales: 0 };
    visibleRows.forEach((p) => {
      const s = p.periods[pd.label];
      if (!s) return;
      t.orders += s.orders;
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
    stockOf: () => undefined,
    adsOf: () => undefined,
    hasAdData: false,
    orderCountOf, orderIdsBySkuPeriod,
  };
}
