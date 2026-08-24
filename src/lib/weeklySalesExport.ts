import * as XLSX from "xlsx-js-style";
import { fetchAllRows, isGenuineAmReturn, isGenuineFbaReturn } from "@/lib/historicalAnalysisReportExport";
import { istDayWindowUtc, istDateOnly, isStandardOrderId } from "@/lib/amazonReportShared";
import { categorizeTitle, resolveProductName, CATEGORY_COLORS } from "@/lib/categoryMap";

// SKU-wise sibling of amazonSalesExport.ts's buildAmazonSalesWorkbook, built for the Weekly
// Report email attachment only. Fixed to exactly two periods (last week / this week — the same
// windows the email body compares), sourced from the Amazon export files already uploaded to
// Supabase (Orders, Returns) instead of SellerMate's live retail-performance API — that API only
// exposes data per ASIN, while the uploaded raw exports carry the real per-order SKU. Mirrors the
// same sheet shapes/styling as amazonSalesExport.ts (Amazon Sales / Growth Summary / Category
// Breakdown); the Reports page's own on-demand download keeps using amazonSalesExport.ts
// unchanged — this file only backs the weekly email attachment.

interface PeriodWindow {
  label: string;
  start: string;
  end: string;
}

interface PeriodStats {
  orders: number; // units ordered
  allReturns: number; // every return reported, including courier RTO/undeliverable
  returns: number; // genuine customer returns only
  totalOrders: number;
  price: number;
  totalSales: number;
}

interface ProductRow {
  sku: string;
  name: string;
  periods: Record<string, PeriodStats>;
  grandTotalSales: number;
}

function fmtDot(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

function weekLabel(start: string, end: string): string {
  return `${fmtDot(start)}-${fmtDot(end)}`;
}

const EXCLUDED_CATEGORIES = new Set(["Discontinued", "Other"]);

export async function buildWeeklySalesWorkbookFromHistorical(opts: {
  thisWeek: { start: string; end: string };
  lastWeek: { start: string; end: string };
}) {
  const { thisWeek, lastWeek } = opts;
  // Stamped once at the moment this build reads its source tables, written to
  // the Notes sheet below — the same field historicalAnalysisReportExport.ts
  // carries, so the two reports' generation times can be compared directly
  // instead of assuming any per-SKU drift between them is a bug.
  const dataPulledAt = new Date().toISOString();
  const periods: PeriodWindow[] = [
    { label: weekLabel(lastWeek.start, lastWeek.end), start: lastWeek.start, end: lastWeek.end },
    { label: weekLabel(thisWeek.start, thisWeek.end), start: thisWeek.start, end: thisWeek.end },
  ];
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
  const ordersWindow = istDayWindowUtc(lastWeek.start, thisWeek.end);
  const fbaReturnsWindow = istDayWindowUtc(lastWeek.start, thisWeek.end);

  // Fetch every relevant row once across the combined 2-week span, split by date in memory below —
  // same "fetch once, filter twice" approach historicalAnalysisReportExport.ts uses for its 30/7-day windows.
  const [orderRows, amReturnRows, fbaReturnRows, priceListingRows, ledgerRows, adRows] = await Promise.all([
    fetchAllRows("barm_amazon_am_orders", (q) => q.gte("purchase_datetime", ordersWindow.gte).lt("purchase_datetime", ordersWindow.lt)),
    fetchAllRows("barm_amazon_am_returns", (q) => q.gte("return_request_date", lastWeek.start).lte("return_request_date", thisWeek.end)),
    fetchAllRows("barm_amazon_fba_returns", (q) =>
      q.gte("return_date", fbaReturnsWindow.gte).lt("return_date", fbaReturnsWindow.lt)
    ),
    fetchAllRows("barm_amazon_price_listing", (q) => q),
    // The ledger is a point-in-time snapshot of stock on hand, not a per-day history — it holds
    // whichever date the last upload covered, which is normally AFTER the report window. Filtering
    // it to `ledger_date <= thisWeek.end` matched nothing, so every FBA SKU read as 0 units and
    // every decliner was labelled "Low stock — check replenishment" (A019-14 was flagged at 0 units
    // while actually holding 277). Take the whole snapshot and pick its latest date below.
    fetchAllRows("barm_amazon_inventory_ledger", (q) => q.eq("disposition", "SELLABLE")),
    // Sponsored-Products performance per advertised SKU per day — lets the category insights below
    // attribute a decline to ad pull-back rather than guessing. Optional: an account with no ads
    // uploaded simply yields no rows, and the campaign reason never fires.
    fetchAllRows("barm_amazon_sp_advertised_product", (q) =>
      q.gte("report_date", lastWeek.start).lte("report_date", thisWeek.end)
    ).catch(() => []),
  ]);

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
  // AM-else-(FBA+SF) returns per SKU per period — the same physical return can
  // be recorded in BOTH the AM returns export and the FBA/SF returns export,
  // so historicalAnalysisReportExport.ts's Final column (verified against the
  // seller's own workbook) takes the AM figure when one exists and only falls
  // back to FBA+SF otherwise, never adds them together. "All Returns"/
  // "Customer Returns" below stay a plain additive dump on purpose (they are
  // meant to show every return reported, not a deduped figure) — only
  // totalOrders (this file's Final-equivalent) needs the deduped version, so
  // it is tracked separately here rather than changing allReturns' meaning.
  const amReturnQtyBySkuPeriod = new Map<string, number>();
  const fbaSfReturnQtyBySkuPeriod = new Map<string, number>();
  const addReturnQty = (map: Map<string, number>, sku: string, label: string, qty: number) => {
    const key = `${sku}|${label}`;
    map.set(key, (map.get(key) || 0) + qty);
  };
  const dedupedReturnsOf = (sku: string, label: string): number => {
    const key = `${sku}|${label}`;
    const amQty = amReturnQtyBySkuPeriod.get(key) || 0;
    return amQty > 0 ? amQty : (fbaSfReturnQtyBySkuPeriod.get(key) || 0);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  amReturnRows.forEach((r: any) => {
    if (!r.merchant_sku || !r.return_request_date) return;
    const pd = periodForDate(String(r.return_request_date).slice(0, 10));
    if (!pd) return;
    const qty = r.return_quantity || 0;
    const s = ensurePeriodStat(r.merchant_sku, pd.label);
    s.allReturns += qty;
    if (isGenuineAmReturn(r)) s.returns += qty;
    addReturnQty(amReturnQtyBySkuPeriod, r.merchant_sku, pd.label, qty);
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
    addReturnQty(fbaSfReturnQtyBySkuPeriod, r.sku, pd.label, qty);
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
      p = { sku, name: resolveProductName(rawName, sku) || rawName, periods: {}, grandTotalSales: 0 };
      products.set(sku, p);
    }
    return p;
  };
  statsBySkuPeriod.forEach((periodMap, sku) => {
    const p = ensureProduct(sku);
    periods.forEach((pd) => {
      const raw = periodMap.get(pd.label);
      if (!raw) return;
      // Total Orders = Orders - Returns, using the SAME deduped (AM-else-
      // FBA+SF) return figure the Historical Analysis Report's Final column
      // uses — NOT raw.allReturns, which sums AM and FBA/SF unconditionally
      // and so double-counts a return that both exports recorded. Left
      // unclamped for the same reason Historical's Final is unclamped: a
      // return recorded with no matching order THIS window (the order
      // belongs to an earlier period) legitimately goes negative.
      const totalOrders = raw.orders - dedupedReturnsOf(sku, pd.label);
      const price = raw.orders > 0 ? raw.totalSales / raw.orders : 0;
      p.periods[pd.label] = { orders: raw.orders, allReturns: raw.allReturns, returns: raw.returns, totalOrders, price, totalSales: raw.totalSales };
      p.grandTotalSales += raw.totalSales;
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

  const rows = [...products.values()].sort((a, b) => b.grandTotalSales - a.grandTotalSales);

  // ── Category/Department aggregation — same per-product per-period data, grouped by department. ──
  const categoryAgg = new Map<string, { periods: Record<string, { sales: number; units: number }>; grandSales: number; grandUnits: number }>();
  const catBySku = new Map<string, string>();
  rows.forEach((p) => {
    const cat = categorizeTitle(p.name, undefined, p.sku);
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

  const categoryRank = new Map<string, number>();
  [...categoryAgg.entries()]
    .sort((a, b) => b[1].grandSales - a[1].grandSales)
    .forEach(([name], i) => categoryRank.set(name, i));
  const rowsByCategory = [...visibleRows].sort((a, b) => {
    const ra = categoryRank.get(catBySku.get(a.sku) || "") ?? 999;
    const rb = categoryRank.get(catBySku.get(b.sku) || "") ?? 999;
    if (ra !== rb) return ra - rb;
    return b.grandTotalSales - a.grandTotalSales;
  });

  // ═══════════════════════════════════════════════════════════════════════
  // ── Shared per-SKU/category deltas — computed once here (not inside any one sheet's block)
  // so the Growth Summary, Executive Dashboard and CEO Decision Center sheets all read the exact
  // same numbers instead of each recomputing their own and risking drift between sheets.
  // ═══════════════════════════════════════════════════════════════════════
  const lastLabel = periods[0].label;
  const thisLabel = periods[1].label;

  type Delta = {
    name: string; sku: string; price: number;
    lastUnits: number; lastSales: number; thisUnits: number; thisSales: number;
    delta: number; pct: number; reason: string; category: string;
    // Extra signals the category insights below diagnose against.
    lastOrders: number; thisOrders: number;
    lastPrice: number; thisPrice: number;
    stock: number | undefined; returnsJump: number; thisReturns: number;
    lastSpend: number; thisSpend: number; lastClicks: number; thisClicks: number;
  };
  const deltas: Delta[] = visibleRows
    .map((p) => {
      const last = p.periods[thisLabel];
      const prev = p.periods[lastLabel];
      if (!last && !prev) return null;
      const lastSales = last?.totalSales || 0;
      const prevSales = prev?.totalSales || 0;
      if (lastSales === 0 && prevSales === 0) return null;
      const delta = lastSales - prevSales;
      const pct = prevSales !== 0 ? delta / prevSales : lastSales > 0 ? 1 : 0;
      const stock = stockOf(p.sku); // undefined when this SKU has no stock signal at all
      const returnsJump = (last?.returns || 0) - (prev?.returns || 0);

      // Sales can only move for two reasons: how many units sold, and what each one sold for.
      // Stating both answers the first question a reader actually has ("did we sell fewer, or
      // did we sell them cheaper?") — a bare "sales declined" leaves them to divide it by hand.
      const lastUnits = prev?.orders || 0;
      const thisUnits = last?.orders || 0;
      const lastPrice = prev?.price || 0;
      const thisPrice = last?.price || 0;
      const unitPct = lastUnits > 0 ? (thisUnits - lastUnits) / lastUnits : null;
      // Comparing per-unit price against a period that sold nothing is meaningless — a SKU that
      // simply stopped selling would otherwise be reported as a 100% price cut.
      const pricePct = lastUnits > 0 && thisUnits > 0 && lastPrice > 0 ? (thisPrice - lastPrice) / lastPrice : null;
      const move = (v: number) => (Math.abs(v) < 0.03 ? "flat" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(0)}%`);
      const driver =
        unitPct === null ? "" : pricePct === null ? `Units ${move(unitPct)}` : `Units ${move(unitPct)}, price ${move(pricePct)}`;

      // A corroborating signal, only when the data actually supports one. Stock is claimed only
      // for SKUs the inventory snapshot covers — silence beats inventing "0 units on hand".
      let signal = "";
      if (delta < 0) {
        if (stock !== undefined && stock < 15) signal = `low stock (${stock} on hand) — check replenishment`;
        else if (returnsJump >= 3) signal = `returns up by ${returnsJump}`;
        else if (lastSales === 0) signal = "no sales — check listing status/traffic";
      } else if (delta > 0) {
        if (pricePct !== null && pricePct <= -0.05) signal = "price cut likely drove growth";
        else if (prevSales === 0) signal = "first sale(s) — no orders in the previous period";
        else if (returnsJump <= -2) signal = `returns down by ${Math.abs(returnsJump)}`;
      }
      const reason = [driver, signal].filter(Boolean).join(" — ");
      const price = last?.price || prev?.price || 0;
      const lastAds = adsOf(p.sku, lastLabel);
      const thisAds = adsOf(p.sku, thisLabel);
      return {
        name: p.name, sku: p.sku, price,
        lastUnits: prev?.orders || 0, lastSales: prevSales,
        thisUnits: last?.orders || 0, thisSales: lastSales,
        delta, pct, reason, category: catBySku.get(p.sku) || "Other",
        lastOrders: orderCountOf(p.sku, lastLabel), thisOrders: orderCountOf(p.sku, thisLabel),
        lastPrice, thisPrice,
        stock, returnsJump, thisReturns: last?.returns || 0,
        lastSpend: lastAds?.spend || 0, thisSpend: thisAds?.spend || 0,
        lastClicks: lastAds?.clicks || 0, thisClicks: thisAds?.clicks || 0,
      };
    })
    .filter((d): d is Delta => d !== null);

  const categoriesInOrder = [...categoryAgg.entries()]
    .filter(([name]) => !EXCLUDED_CATEGORIES.has(name))
    .sort((a, b) => b[1].grandSales - a[1].grandSales)
    .map(([name]) => name)
    .filter((name) => deltas.some((d) => d.category === name));

  type Diagnosis = { reason: string; action: string; impact: number };

  // Candidate explanations for one product's decline, each scored by the rupees it plausibly
  // accounts for, then returned worst-first. Impact is an attribution estimate, not a
  // measurement: price and volume decompose the drop exactly, the rest are bounded by it.
  const diagnose = (d: Delta): Diagnosis[] => {
    const out: Diagnosis[] = [];
    const bothSold = d.lastUnits > 0 && d.thisUnits > 0;
    const priceLoss = bothSold ? d.thisUnits * Math.max(0, d.lastPrice - d.thisPrice) : 0;
    const volumeLoss = d.lastPrice > 0 ? Math.max(0, d.lastUnits - d.thisUnits) * d.lastPrice : 0;
    // Only a period that actually sold has a realised price to compare against.
    const pricePct = bothSold && d.lastPrice > 0 ? d.thisPrice / d.lastPrice - 1 : 0;
    const units = (n: number) => `${n} unit${n === 1 ? "" : "s"}`;

    if (priceLoss > 0 && pricePct <= -0.05) {
      out.push({
        reason: `Price Drop — realised price ${(pricePct * 100).toFixed(0)}% (₹${Math.round(d.lastPrice)} → ₹${Math.round(d.thisPrice)})`,
        action: `Review pricing on ${d.name} — restore price or confirm the discount is intentional`,
        impact: priceLoss,
      });
    }
    if (d.stock !== undefined && d.stock < 15 && volumeLoss > 0) {
      out.push({
        reason: `Low Stock — ${units(d.stock)} on hand`,
        action:
          d.thisUnits > 0
            ? `Replenish ${d.name} — ${units(d.stock)} left against ${d.thisUnits} sold this week`
            : `Replenish ${d.name} — ${units(d.stock)} left and it sold nothing this week (${d.lastUnits} last week)`,
        impact: volumeLoss,
      });
    }
    if (d.returnsJump >= 2) {
      out.push({
        reason: `High Returns — up ${d.returnsJump} vs last week (${d.thisReturns} total)`,
        action: `Check quality and listing accuracy for ${d.name} — returns are climbing`,
        impact: d.returnsJump * (d.thisPrice || d.lastPrice),
      });
    }
    if (hasAdData && d.lastSpend > 0) {
      const spendPct = d.thisSpend / d.lastSpend - 1;
      if (spendPct <= -0.3 && volumeLoss > 0) {
        out.push({
          reason: `Campaign Performance — ad spend ${(spendPct * 100).toFixed(0)}% (₹${Math.round(d.lastSpend)} → ₹${Math.round(d.thisSpend)}), clicks ${d.lastClicks} → ${d.thisClicks}`,
          action: `Restore advertising on ${d.name} — spend was cut ${Math.abs(spendPct * 100).toFixed(0)}% and volume followed`,
          impact: volumeLoss * Math.min(1, Math.abs(spendPct)),
        });
      }
    }
    // Nothing sold at all despite stock being available reads as a listing problem, not demand.
    if (d.thisSales === 0 && d.lastSales > 0 && (d.stock === undefined || d.stock >= 15)) {
      out.push({
        reason: "Listing Issue — no sales at all this week while stock was available",
        action: `Check ${d.name}'s listing status, buy box and search visibility`,
        impact: d.lastSales,
      });
    }
    if (out.length === 0 && volumeLoss > 0) {
      // Don't claim stock is fine for a SKU the inventory snapshot never covered.
      const steady = d.stock === undefined ? "price steady, stock not tracked" : "price and stock steady";
      out.push({
        reason: `Demand Softness — units ${d.lastUnits} → ${d.thisUnits} with ${steady}`,
        action: `Review traffic and conversion for ${d.name} — no supply-side cause found`,
        impact: volumeLoss,
      });
    }
    return out.sort((a, b) => b.impact - a.impact);
  };

  // Health score, 0–100, from four weighted components. Stated in the Growth Summary sheet's own
  // legend so a reader never has to ask where the number came from.
  //   Revenue growth 40 — flat scores 20; +20% or better 40; −20% or worse 0
  //   Growing share  20 — share of the category's products whose revenue grew
  //   Returns rate   20 — 0% scores 20; 10% or worse scores 0
  //   Stock cover    20 — share of category revenue from products not flagged low stock
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const scoreCategory = (cat: string) => {
    const ds = deltas.filter((d) => d.category === cat);
    const thisRev = ds.reduce((a, d) => a + d.thisSales, 0);
    const lastRev = ds.reduce((a, d) => a + d.lastSales, 0);
    const growth = lastRev > 0 ? thisRev / lastRev - 1 : 0;
    const units = ds.reduce((a, d) => a + d.thisUnits, 0);
    // Distinct orders touching the category — summing each SKU's own order count would count a
    // single basket twice when it holds two SKUs from the same category.
    const orderIds = new Set<string>();
    ds.forEach((d) => orderIdsBySkuPeriod.get(`${d.sku}|${thisLabel}`)?.forEach((id) => orderIds.add(id)));
    const orders = orderIds.size;
    const returns = ds.reduce((a, d) => a + d.thisReturns, 0);

    const growthPts = 40 * clamp01((growth + 0.2) / 0.4);
    const growers = ds.filter((d) => d.delta > 0).length;
    const breadthPts = ds.length > 0 ? 20 * (growers / ds.length) : 10;
    const returnRate = units > 0 ? returns / units : 0;
    const returnPts = 20 * clamp01(1 - returnRate / 0.1);
    const known = ds.filter((d) => d.stock !== undefined);
    const healthyRev = known.filter((d) => (d.stock as number) >= 15).reduce((a, d) => a + d.thisSales, 0);
    const knownRev = known.reduce((a, d) => a + d.thisSales, 0);
    const stockPts = knownRev > 0 ? 20 * (healthyRev / knownRev) : 10; // 10 = neutral when unknown

    const score = Math.round(growthPts + breadthPts + returnPts + stockPts);
    const status = score >= 75 ? "🟢 Excellent" : score >= 50 ? "🟡 Stable" : "🔴 Needs Attention";
    return { thisRev, lastRev, growth, units, orders, score, status };
  };

  // Reason is decided from the same signals the per-product diagnosis above uses — never a guess.
  // Growth is credited to whichever product grew most; decline reuses diagnose() so the wording
  // matches (and doesn't contradict) the per-category "Needs Attention" detail rows.
  const changeReason = (cat: string, s: ReturnType<typeof scoreCategory>) => {
    const ds = deltas.filter((d) => d.category === cat);
    if (s.lastRev === 0) return "New this week — no sales last week to compare against";
    if (ds.length === 0) return "No comparable product data";
    const best = [...ds].sort((a, b) => b.delta - a.delta)[0];
    const worst = [...ds].sort((a, b) => a.delta - b.delta)[0];
    if (s.growth >= 0.02 && best.delta > 0) {
      return `Growth led by ${best.name} (+${Math.round(best.pct * 100)}%)`;
    }
    if (s.growth <= -0.02 && worst.delta < 0) {
      const dx = diagnose(worst);
      return dx.length ? `${worst.name}: ${dx[0].reason}` : `Led by ${worst.name} — no clear cause found in the data`;
    }
    return "Roughly flat vs last week";
  };

  // ═══════════════════════════════════════════════════════════════════════
  // ── Shared whole-business metrics/helpers — used by every sheet below (Growth Summary's new
  // KPI block, Category Breakdown's new columns, Amazon Sales' new summary block, Executive
  // Dashboard, CEO Decision Center) so none of them can disagree with each other. No native Excel
  // charts or conditional-formatting data bars here — xlsx-js-style (this file's export engine)
  // can't write those OOXML features, so "visual" is simulated with coloured cells, arrows and
  // bar-of-blocks text instead of faked/broken chart objects.
  // ═══════════════════════════════════════════════════════════════════════
  const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
  const pctStr = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;
  const arrow = (v: number) => (v > 0.02 ? "▲" : v < -0.02 ? "▼" : "▬");
  // 5-band scale for whole-business scores — deliberately distinct from the Growth Summary sheet's
  // 3-band per-category status, since the two are different metrics.
  const healthBand = (score: number) =>
    score >= 80
      ? { label: "🟢 Excellent", color: "047857" }
      : score >= 65
        ? { label: "🔵 Good", color: "2563EB" }
        : score >= 50
          ? { label: "🟡 Average", color: "B45309" }
          : score >= 35
            ? { label: "🟠 Poor", color: "C2410C" }
            : { label: "🔴 Critical", color: "B91C1C" };
  // A simple bar-of-blocks string standing in for a real progress bar / data bar, e.g. "███████░░░ 72%".
  const barOf = (share: number, width = 10) => {
    const filled = Math.round(clamp01(share) * width);
    return `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))} ${(share * 100).toFixed(0)}%`;
  };

  const scoredCats = categoriesInOrder.map((cat) => ({ cat, ...scoreCategory(cat) }));
  const totalThisRev = scoredCats.reduce((a, s) => a + s.thisRev, 0);
  const totalLastRev = scoredCats.reduce((a, s) => a + s.lastRev, 0);
  const overallGrowth = totalLastRev > 0 ? totalThisRev / totalLastRev - 1 : totalThisRev > 0 ? 1 : 0;
  const totalThisUnits = deltas.reduce((a, d) => a + d.thisUnits, 0);
  const totalLastUnits = deltas.reduce((a, d) => a + d.lastUnits, 0);
  const globalOrderCount = (label: string) => {
    const ids = new Set<string>();
    deltas.forEach((d) => orderIdsBySkuPeriod.get(`${d.sku}|${label}`)?.forEach((id) => ids.add(id)));
    return ids.size;
  };
  const totalThisOrders = globalOrderCount(thisLabel);
  const totalLastOrders = globalOrderCount(lastLabel);
  const ordersGrowthPct = totalLastOrders > 0 ? totalThisOrders / totalLastOrders - 1 : 0;
  const unitsGrowthPct = totalLastUnits > 0 ? totalThisUnits / totalLastUnits - 1 : 0;
  const avgOrderValue = totalThisOrders > 0 ? totalThisRev / totalThisOrders : 0;
  const aspThis = totalThisUnits > 0 ? totalThisRev / totalThisUnits : 0;
  const aspLast = totalLastUnits > 0 ? totalLastRev / totalLastUnits : 0;
  const aspChangePct = aspLast > 0 ? aspThis / aspLast - 1 : 0;
  const activeProducts = deltas.filter((d) => d.thisUnits > 0).length;

  const bySalesDesc = [...deltas].sort((a, b) => b.thisSales - a.thisSales);
  const bestSellingProduct = bySalesDesc[0];
  const growers = deltas.filter((d) => d.lastSales > 0 && d.delta > 0).sort((a, b) => b.pct - a.pct);
  const fastestGrowingProduct = growers[0];
  const decliners = deltas.filter((d) => d.delta < 0).sort((a, b) => a.delta - b.delta);
  const top5Sales = bySalesDesc.slice(0, 5).reduce((a, d) => a + d.thisSales, 0);
  const revenueConcentrationPct = totalThisRev > 0 ? top5Sales / totalThisRev : 0;
  const revenueAtRiskPct = totalThisRev > 0 ? decliners.reduce((a, d) => a + d.thisSales, 0) / totalThisRev : 0;

  const catsBySalesDesc = [...scoredCats].sort((a, b) => b.thisRev - a.thisRev);
  const highestRevCategory = catsBySalesDesc[0];
  const lowestRevCategory = [...catsBySalesDesc].reverse()[0];
  const businessHealthScore =
    totalThisRev > 0 ? Math.round(scoredCats.reduce((a, s) => a + s.score * (s.thisRev / totalThisRev), 0)) : 0;
  // Deliberately a different, simpler formula than Business Health Score above — this one is pure
  // week-over-week revenue momentum (no stock/returns/breadth factors), stated so a reader never
  // mistakes it for the same number. Flat growth scores 50; +30% or better scores 100; -30% or
  // worse scores 0.
  const weeklyPerformanceScore = Math.round(100 * clamp01((overallGrowth + 0.3) / 0.6));
  // Growth Confidence Score — how much the categories agree on direction. Two weeks of data can't
  // support real statistical confidence, so this is capped to a 30–70 band and labelled as such
  // everywhere it's shown, rather than implying more certainty than two data points can carry.
  const growingCatsCount = scoredCats.filter((s) => s.growth > 0).length;
  const decliningCatsCount = scoredCats.filter((s) => s.growth < 0).length;
  const growthConsistency = scoredCats.length > 0 ? Math.max(growingCatsCount, decliningCatsCount) / scoredCats.length : 0;
  const growthConfidencePct = Math.round(30 + growthConsistency * 40);

  // ═══════════════════════════════════════════════════════════════════════
  // ── Main "Amazon Sales" sheet ──
  // Column 0 = Product, column 1 = SKU, column 2 = Category, then 7 columns per period
  // (Orders, All Returns, Customer Returns, Total Orders, Price, Total Sales, Growth %).
  // ═══════════════════════════════════════════════════════════════════════
  const COLS_PER_PERIOD = 7;
  const LEAD_COLS = 3;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const headerRow1: any[] = ["Product", "SKU", "Category"];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const headerRow2: any[] = ["", "", ""];
  periods.forEach(() => {
    headerRow1.push(...Array(COLS_PER_PERIOD).fill(""));
    headerRow2.push("Orders", "All Returns", "Customer Returns", "Total Orders", "Price", "Total Sales", "Growth %");
  });
  periods.forEach((pd, i) => { headerRow1[LEAD_COLS + i * COLS_PER_PERIOD] = pd.label; });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aoa: any[][] = [headerRow1, headerRow2];
  const categoryChangeRows = new Set<number>();

  let prevCat: string | null = null;
  rowsByCategory.forEach((p) => {
    const cat = catBySku.get(p.sku) || "Other";
    if (cat !== prevCat) { categoryChangeRows.add(aoa.length); prevCat = cat; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rowData: any[] = [p.name, p.sku, cat];
    let prevTotalSales: number | null = null;
    periods.forEach((pd) => {
      const stat = p.periods[pd.label];
      const orders = stat?.orders || 0;
      const allReturns = stat?.allReturns || 0;
      const returns = stat?.returns || 0;
      const totalOrders = stat?.totalOrders || 0;
      const price = stat?.price || 0;
      const totalSales = stat?.totalSales || 0;
      const growth = prevTotalSales !== null && prevTotalSales !== 0 ? (totalSales - prevTotalSales) / prevTotalSales : "";
      rowData.push(orders, allReturns, returns, totalOrders, price, totalSales, growth);
      prevTotalSales = totalSales;
    });
    aoa.push(rowData);
  });

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const totalCols = LEAD_COLS + periods.length * COLS_PER_PERIOD;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const merges: any[] = [
    { s: { r: 0, c: 0 }, e: { r: 1, c: 0 } },
    { s: { r: 0, c: 1 }, e: { r: 1, c: 1 } },
    { s: { r: 0, c: 2 }, e: { r: 1, c: 2 } },
  ];
  periods.forEach((_, i) => {
    const c0 = LEAD_COLS + i * COLS_PER_PERIOD;
    merges.push({ s: { r: 0, c: c0 }, e: { r: 0, c: c0 + COLS_PER_PERIOD - 1 } });
  });
  ws["!merges"] = merges;

  for (let r = 0; r <= 1; r++) {
    for (let c = 0; c < totalCols; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (!ws[addr]) ws[addr] = { t: "s", v: "" };
      ws[addr].s = {
        font: { bold: true, color: { rgb: "FFFFFF" } },
        fill: { fgColor: { rgb: r === 0 ? "312E81" : "4F46E5" } },
        alignment: { horizontal: "center", vertical: "center" },
        border: { bottom: { style: "medium", color: { rgb: "1E1B4B" } } },
      };
    }
  }

  for (let r = 2; r < aoa.length; r++) {
    const isGroupStart = categoryChangeRows.has(r) && r > 2;
    for (let c = 0; c < totalCols; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (!cell) continue;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const style: any = {
        font: { color: { rgb: "1F2937" } },
        alignment: { vertical: "center" },
        border: {
          bottom: { style: "thin", color: { rgb: "E5E7EB" } },
          ...(isGroupStart ? { top: { style: "medium", color: { rgb: "C7D2FE" } } } : {}),
        },
      };

      if (c === 0) {
        style.font = { color: { rgb: "111827" }, bold: true };
      } else if (c === 1) {
        style.font = { color: { rgb: "4338CA" }, bold: true };
      } else if (c === 2) {
        const catColor = CATEGORY_COLORS[String(cell.v)] || CATEGORY_COLORS.Other;
        style.font = { color: { rgb: catColor.replace("#", "") }, bold: true };
      } else {
        const posInPeriod = (c - LEAD_COLS) % COLS_PER_PERIOD;
        // Total Orders — flagged, not clamped, when it goes negative: a
        // return landed in this period with no matching order in it (see the
        // totalOrders comment above).
        if (posInPeriod === 3 && typeof cell.v === "number" && cell.v < 0) {
          style.font = { color: { rgb: "B91C1C" }, bold: true };
        }
        if (posInPeriod === 4) style.numFmt = "#,##0.00"; // Price
        if (posInPeriod === 5) {
          style.numFmt = "#,##0.00"; // Total Sales
          style.font = { color: { rgb: "059669" }, bold: true };
        }
        if (posInPeriod === 6 && typeof cell.v === "number") {
          style.numFmt = "0.0%";
          if (cell.v > 0) style.font = { color: { rgb: "047857" }, bold: true };
          else if (cell.v < 0) style.font = { color: { rgb: "B91C1C" }, bold: true };
        }
      }
      cell.s = style;
    }
  }

  const wscols = [{ wch: 42 }, { wch: 16 }, { wch: 20 }];
  periods.forEach(() => {
    wscols.push({ wch: 10 }, { wch: 11 }, { wch: 15 }, { wch: 12 }, { wch: 10 }, { wch: 13 }, { wch: 10 });
  });
  ws["!cols"] = wscols;
  ws["!views"] = [{ state: "frozen", xSplit: 3, ySplit: 2 }];

  const wb = XLSX.utils.book_new();

  // ═══════════════════════════════════════════════════════════════════════
  // ── Growth Summary — always compares the two periods directly (last week vs this week). ──
  // ═══════════════════════════════════════════════════════════════════════
  {
    const TOP_N = 5;

    const SUMMARY_COLS = 10; // Product, SKU, Price, Last Wk Units, Last Wk Sales, This Wk Units, This Wk Sales, Δ Sales, Δ %, Possible Reason
    const blankRow = () => Array(SUMMARY_COLS).fill("");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sAoA: any[][] = [[`Growth Summary — ${lastLabel} vs ${thisLabel}`, ...Array(SUMMARY_COLS - 1).fill("")], []];
    const catHeaderRows: { row: number; color: string }[] = [];
    const lossHeaderRows: number[] = [];
    const gainHeaderRows: number[] = [];
    const colHeader = (label: string) => [
      label, "SKU", "Price", "Last Wk Units", "Last Wk Sales", "This Wk Units", "This Wk Sales", "Δ Sales", "Δ %",
      "Possible Reason (add your own note if blank)",
    ];

    // ═════════════════════════════════════════════════════════════════════
    // ── Key metrics + AI weekly growth summary, ahead of the per-category Top 5 tables below. ──
    // Purely additive — nothing already in this sheet moves or changes; this block only adds rows
    // before the existing per-category loop starts.
    // ═════════════════════════════════════════════════════════════════════
    const kpiSectionRows: number[] = [];
    const kpiWideTextRows: number[] = [];
    const kpiLabelRows: number[] = [];
    const kpiValueCells: { row: number; col: number; tone?: "good" | "bad" | "neutral" }[] = [];
    const pushKpiSection = (text: string) => {
      kpiSectionRows.push(sAoA.length);
      sAoA.push([text, ...Array(SUMMARY_COLS - 1).fill("")]);
    };
    const pushKpiWideText = (text: string) => {
      kpiWideTextRows.push(sAoA.length);
      sAoA.push([text, ...Array(SUMMARY_COLS - 1).fill("")]);
    };
    // 2 KPI cards per row, each spanning half the sheet's columns (SUMMARY_COLS / 2).
    const kpiMerges: { s: { r: number; c: number }; e: { r: number; c: number } }[] = [];
    const halfCols = SUMMARY_COLS / 2;
    const pushKpiRow = (cards: { label: string; value: string; tone?: "good" | "bad" | "neutral" }[]) => {
      const padded = [...cards];
      while (padded.length < 2) padded.push({ label: "", value: "" });
      const labelRow = sAoA.length;
      sAoA.push(Array(SUMMARY_COLS).fill(""));
      sAoA.push(Array(SUMMARY_COLS).fill(""));
      kpiLabelRows.push(labelRow);
      padded.forEach((c, i) => {
        const c0 = i * halfCols;
        kpiMerges.push({ s: { r: labelRow, c: c0 }, e: { r: labelRow, c: c0 + halfCols - 1 } });
        kpiMerges.push({ s: { r: labelRow + 1, c: c0 }, e: { r: labelRow + 1, c: c0 + halfCols - 1 } });
        sAoA[labelRow][c0] = c.label;
        sAoA[labelRow + 1][c0] = c.value;
        kpiValueCells.push({ row: labelRow + 1, col: c0, tone: c.tone });
      });
    };

    pushKpiSection("KEY METRICS");
    pushKpiRow([
      { label: "Revenue Growth %", value: `${arrow(overallGrowth)} ${pctStr(overallGrowth)}`, tone: overallGrowth >= 0 ? "good" : "bad" },
      { label: "Revenue Difference", value: `${totalThisRev - totalLastRev >= 0 ? "+" : ""}${inr(totalThisRev - totalLastRev)}`, tone: totalThisRev >= totalLastRev ? "good" : "bad" },
    ]);
    sAoA.push(blankRow());
    pushKpiRow([
      { label: "Orders Growth %", value: `${arrow(ordersGrowthPct)} ${pctStr(ordersGrowthPct)}`, tone: ordersGrowthPct >= 0 ? "good" : "bad" },
      { label: "Units Growth %", value: `${arrow(unitsGrowthPct)} ${pctStr(unitsGrowthPct)}`, tone: unitsGrowthPct >= 0 ? "good" : "bad" },
    ]);
    sAoA.push(blankRow());
    pushKpiRow([
      { label: "Average Selling Price (This Wk)", value: inr(aspThis) },
      { label: "ASP Change %", value: `${arrow(aspChangePct)} ${pctStr(aspChangePct)}`, tone: aspChangePct >= 0 ? "good" : "bad" },
    ]);
    sAoA.push(blankRow());
    pushKpiRow([
      { label: "Business Health Score", value: `${businessHealthScore}/100 — ${healthBand(businessHealthScore).label}`, tone: businessHealthScore >= 65 ? "good" : businessHealthScore >= 50 ? "neutral" : "bad" },
      { label: "Weekly Performance Score", value: `${weeklyPerformanceScore}/100 — ${healthBand(weeklyPerformanceScore).label}`, tone: weeklyPerformanceScore >= 65 ? "good" : weeklyPerformanceScore >= 50 ? "neutral" : "bad" },
    ]);
    sAoA.push(blankRow());
    pushKpiRow([
      { label: "Revenue Concentration % (Top 5)", value: barOf(revenueConcentrationPct) },
      { label: "Revenue at Risk %", value: barOf(revenueAtRiskPct), tone: revenueAtRiskPct >= 0.3 ? "bad" : revenueAtRiskPct >= 0.15 ? "neutral" : "good" },
    ]);
    sAoA.push(blankRow());

    pushKpiSection("AI WEEKLY GROWTH SUMMARY");
    [
      `Revenue ${overallGrowth >= 0 ? "increased" : "decreased"} by ${Math.abs(overallGrowth * 100).toFixed(1)}% compared to last week (${inr(totalLastRev)} → ${inr(totalThisRev)}).`,
      `Order volume ${ordersGrowthPct >= 0 ? "increased" : "decreased"} ${pctStr(ordersGrowthPct)} while average selling price ${Math.abs(aspChangePct) < 0.03 ? "remained stable" : `${aspChangePct >= 0 ? "rose" : "fell"} ${pctStr(aspChangePct)}`}.`,
      highestRevCategory ? `Growth was primarily driven by ${highestRevCategory.cat} (${inr(highestRevCategory.thisRev)}, ${pctStr(highestRevCategory.growth)}).` : "No category recorded sales this week.",
      lowestRevCategory && lowestRevCategory.score < 50 ? `Demand weakened in ${lowestRevCategory.cat} products (health score ${lowestRevCategory.score}/100).` : "No category fell into a weak health band this week.",
      `Overall weekly performance is rated ${healthBand(weeklyPerformanceScore).label} (${weeklyPerformanceScore}/100).`,
    ].forEach((l) => pushKpiWideText(l));
    sAoA.push(blankRow());

    pushKpiSection("TOP POSITIVE CHANGES");
    const kpiGrowers = deltas.filter((d) => d.lastSales > 0 && d.delta > 0).sort((a, b) => b.pct - a.pct);
    (kpiGrowers.length ? kpiGrowers.slice(0, 3) : [null]).forEach((d) =>
      pushKpiWideText(d ? `📈 ${d.name} grew ${pctStr(d.pct)} (${inr(d.lastSales)} → ${inr(d.thisSales)})` : "No product grew this week.")
    );
    sAoA.push(blankRow());

    pushKpiSection("TOP DECLINING METRICS");
    const metricMoves: { label: string; v: number }[] = [
      { label: "Revenue", v: overallGrowth },
      { label: "Orders", v: ordersGrowthPct },
      { label: "Units", v: unitsGrowthPct },
      { label: "Average Selling Price", v: aspChangePct },
    ];
    const decliningMetrics = metricMoves.filter((m) => m.v < -0.02).sort((a, b) => a.v - b.v);
    if (decliningMetrics.length === 0) pushKpiWideText("No top-line metric declined this week.");
    decliningMetrics.forEach((m) => pushKpiWideText(`📉 ${m.label} declined ${pctStr(m.v)} vs last week.`));
    sAoA.push(blankRow());

    pushKpiSection("WEEKLY GROWTH HIGHLIGHTS");
    [
      bestSellingProduct ? `🏆 Best seller: ${bestSellingProduct.name} at ${inr(bestSellingProduct.thisSales)}.` : null,
      fastestGrowingProduct ? `🚀 Fastest growing: ${fastestGrowingProduct.name}, up ${pctStr(fastestGrowingProduct.pct)}.` : null,
      highestRevCategory ? `📊 Leading category: ${highestRevCategory.cat} at ${inr(highestRevCategory.thisRev)}.` : null,
    ]
      .filter((l): l is string => !!l)
      .forEach((l) => pushKpiWideText(l));
    sAoA.push(blankRow());

    pushKpiSection("BUSINESS RISKS");
    const kpiRisks: string[] = [];
    if (revenueAtRiskPct >= 0.15) kpiRisks.push(`${(revenueAtRiskPct * 100).toFixed(0)}% of this week's revenue comes from declining products.`);
    scoredCats.filter((s) => s.score < 50).forEach((s) => kpiRisks.push(`${s.cat} is in a ${healthBand(s.score).label} health band (${s.score}/100).`));
    if (kpiRisks.length === 0) kpiRisks.push("No category or concentration risk crossed this report's warning thresholds this week.");
    kpiRisks.slice(0, 5).forEach((r) => pushKpiWideText(`⚠️ ${r}`));
    sAoA.push(blankRow());

    pushKpiSection("GROWTH CONFIDENCE SCORE");
    const confidenceRow = sAoA.length;
    sAoA.push([`${growthConfidencePct}% — based on 2 weeks of data (directional, not a statistical forecast)`, ...Array(SUMMARY_COLS - 1).fill("")]);
    sAoA.push(blankRow());

    categoriesInOrder.forEach((cat) => {
      const catDeltas = deltas.filter((d) => d.category === cat);
      const losers = catDeltas.filter((d) => d.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, TOP_N);
      const gainers = catDeltas.filter((d) => d.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, TOP_N);
      if (losers.length === 0 && gainers.length === 0) return;

      catHeaderRows.push({ row: sAoA.length, color: CATEGORY_COLORS[cat] || CATEGORY_COLORS.Other });
      sAoA.push([cat, ...Array(SUMMARY_COLS - 1).fill("")]);

      lossHeaderRows.push(sAoA.length);
      sAoA.push(colHeader("Top 5 Worst"));
      if (losers.length > 0)
        losers.forEach((d) => sAoA.push([d.name, d.sku, d.price, d.lastUnits, d.lastSales, d.thisUnits, d.thisSales, d.delta, d.pct, d.reason]));
      else sAoA.push(["No decline this period", ...Array(SUMMARY_COLS - 1).fill("")]);
      sAoA.push(blankRow());

      gainHeaderRows.push(sAoA.length);
      sAoA.push(colHeader("Top 5 Best"));
      if (gainers.length > 0)
        gainers.forEach((d) => sAoA.push([d.name, d.sku, d.price, d.lastUnits, d.lastSales, d.thisUnits, d.thisSales, d.delta, d.pct, d.reason]));
      else sAoA.push(["No growth this period", ...Array(SUMMARY_COLS - 1).fill("")]);
      sAoA.push(blankRow());
    });

    // ═════════════════════════════════════════════════════════════════════
    // ── Category insights, appended below the per-category Top 5 tables ──
    // diagnose()/scoreCategory()/changeReason() are shared with the Executive Dashboard and CEO
    // Decision Center sheets (declared once, above, alongside `deltas`) so the numbers and wording
    // here can never drift from what those sheets say about the same categories.
    // ═════════════════════════════════════════════════════════════════════
    const insightRows = { title: [] as number[], header: [] as number[], banner: [] as { row: number; color: string }[], good: [] as number[], bad: [] as number[], rec: [] as number[], legend: [] as number[] };
    // totalThisRev is the shared whole-business figure declared near the top of the function.

    // Columns mean different things below this row (Growth %, Orders, Contribution % …) than they
    // do in the Top 5 tables above it, so the Top 5 number formatting must stop here.
    const insightsFrom = sAoA.length;
    const overviewDataRows: number[] = [];

    sAoA.push(blankRow());
    insightRows.title.push(sAoA.length);
    sAoA.push(["CATEGORY INSIGHTS", ...Array(SUMMARY_COLS - 1).fill("")]);
    sAoA.push(blankRow());

    // ── Overview: one row per category ──
    insightRows.header.push(sAoA.length);
    sAoA.push(["Category", "Revenue (This Wk)", "Revenue (Last Wk)", "Revenue Growth %", "Orders", "Units Sold", "Contribution %", "Health Score", "Status", "Reason for Change"]);
    const scored = categoriesInOrder.map((cat) => ({ cat, ...scoreCategory(cat) }));
    scored.forEach((s) => {
      overviewDataRows.push(sAoA.length);
      sAoA.push([
        s.cat, s.thisRev, s.lastRev, s.lastRev > 0 ? s.growth : "", s.orders, s.units,
        totalThisRev > 0 ? s.thisRev / totalThisRev : 0, `${s.score}/100`, s.status, changeReason(s.cat, s),
      ]);
    });
    sAoA.push(blankRow());

    // ── Per-category detail: best product, worst product with a diagnosis, one recommendation ──
    scored.forEach((s) => {
      const ds = deltas.filter((d) => d.category === s.cat);
      if (ds.length === 0) return;
      const best = [...ds].sort((a, b) => b.delta - a.delta)[0];
      const worst = [...ds].sort((a, b) => a.delta - b.delta)[0];

      insightRows.banner.push({ row: sAoA.length, color: CATEGORY_COLORS[s.cat] || CATEGORY_COLORS.Other });
      sAoA.push([`${s.cat} — ${s.status}  ·  Health ${s.score}/100`, ...Array(SUMMARY_COLS - 1).fill("")]);

      insightRows.header.push(sAoA.length);
      sAoA.push(["Focus", "Product", "Revenue", "Revenue Δ %", "Units Sold", "Orders", "Orders Δ %", "AI Possible Reason", "Recommended Action", ""]);

      const ordersPct = (d: Delta) => (d.lastOrders > 0 ? d.thisOrders / d.lastOrders - 1 : "");
      if (best && best.delta > 0) {
        insightRows.good.push(sAoA.length);
        sAoA.push(["Top Performer", best.name, best.thisSales, best.pct, best.thisUnits, best.thisOrders, ordersPct(best), "", "", ""]);
      } else {
        insightRows.good.push(sAoA.length);
        sAoA.push(["Top Performer", "No product grew this week", "", "", "", "", "", "", "", ""]);
      }

      if (worst && worst.delta < 0) {
        const dx = diagnose(worst);
        insightRows.bad.push(sAoA.length);
        sAoA.push([
          "Needs Attention", worst.name, worst.thisSales, worst.pct, worst.thisUnits, worst.thisOrders, ordersPct(worst),
          dx.map((x) => x.reason).join(" · ") || "No supply-side signal found",
          dx[0]?.action || `Review traffic and conversion for ${worst.name}`, "",
        ]);
        insightRows.rec.push(sAoA.length);
        sAoA.push([
          "AI Recommendation",
          dx[0]?.action || `Review traffic and conversion for ${worst.name}`,
          ...Array(SUMMARY_COLS - 2).fill(""),
        ]);
      } else {
        insightRows.bad.push(sAoA.length);
        sAoA.push(["Needs Attention", "No product declined this week", "", "", "", "", "", "", "", ""]);
        insightRows.rec.push(sAoA.length);
        sAoA.push(["AI Recommendation", `Hold course on ${s.cat} — every product held or grew this week`, ...Array(SUMMARY_COLS - 2).fill("")]);
      }
      sAoA.push(blankRow());
    });

    insightRows.legend.push(sAoA.length);
    sAoA.push([
      "How to read this: Health Score = revenue growth (40) + share of products growing (20) + returns rate (20) + stock cover (20). 🟢 75+ Excellent · 🟡 50–74 Stable · 🔴 under 50 Needs Attention. Reasons are ranked by the revenue each explains, and are only shown when the data supports them — product ratings and seasonality are not available in the uploaded exports, so they are never inferred.",
      ...Array(SUMMARY_COLS - 1).fill(""),
    ]);

    const wsSummary = XLSX.utils.aoa_to_sheet(sAoA);
    wsSummary["!merges"] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: SUMMARY_COLS - 1 } },
      ...catHeaderRows.map((h) => ({ s: { r: h.row, c: 0 }, e: { r: h.row, c: SUMMARY_COLS - 1 } })),
      ...insightRows.title.map((r) => ({ s: { r, c: 0 }, e: { r, c: SUMMARY_COLS - 1 } })),
      ...insightRows.banner.map((h) => ({ s: { r: h.row, c: 0 }, e: { r: h.row, c: SUMMARY_COLS - 1 } })),
      ...insightRows.rec.map((r) => ({ s: { r, c: 1 }, e: { r, c: SUMMARY_COLS - 1 } })),
      ...insightRows.legend.map((r) => ({ s: { r, c: 0 }, e: { r, c: SUMMARY_COLS - 1 } })),
      ...kpiSectionRows.map((r) => ({ s: { r, c: 0 }, e: { r, c: SUMMARY_COLS - 1 } })),
      ...kpiWideTextRows.map((r) => ({ s: { r, c: 0 }, e: { r, c: SUMMARY_COLS - 1 } })),
      { s: { r: confidenceRow, c: 0 }, e: { r: confidenceRow, c: SUMMARY_COLS - 1 } },
      ...kpiMerges,
    ];
    wsSummary["!cols"] = [
      { wch: 45 }, { wch: 16 }, { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 13 }, { wch: 12 }, { wch: 13 }, { wch: 14 }, { wch: 50 },
    ];

    const titleCell = wsSummary[XLSX.utils.encode_cell({ r: 0, c: 0 })];
    if (titleCell) titleCell.s = { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "111827" } }, alignment: { horizontal: "center" } };

    catHeaderRows.forEach(({ row, color }) => {
      for (let c = 0; c < SUMMARY_COLS; c++) {
        const addr = XLSX.utils.encode_cell({ r: row, c });
        if (!wsSummary[addr]) wsSummary[addr] = { t: "s", v: "" };
        wsSummary[addr].s = {
          font: { bold: true, color: { rgb: "FFFFFF" } },
          fill: { fgColor: { rgb: color.replace("#", "") } },
          alignment: { horizontal: "center" },
        };
      }
    });

    const lossHeaderSet = new Set(lossHeaderRows);
    [...lossHeaderRows, ...gainHeaderRows].forEach((headerRowIdx) => {
      for (let c = 0; c < SUMMARY_COLS; c++) {
        const addr = XLSX.utils.encode_cell({ r: headerRowIdx, c });
        const cell = wsSummary[addr];
        if (!cell) continue;
        const isLossHeader = lossHeaderSet.has(headerRowIdx);
        cell.s = {
          font: { bold: true, color: { rgb: "FFFFFF" } },
          fill: { fgColor: { rgb: isLossHeader ? "B91C1C" : "047857" } },
          alignment: { horizontal: "center" },
        };
      }
    });

    for (let r = 0; r < insightsFrom; r++) {
      // Price (2) — plain currency.
      const priceAddr = XLSX.utils.encode_cell({ r, c: 2 });
      if (wsSummary[priceAddr] && typeof wsSummary[priceAddr].v === "number") {
        wsSummary[priceAddr].s = { numFmt: "#,##0.00", font: { color: { rgb: "1F2937" } } };
      }
      // Last Wk Units (3), This Wk Units (5) — plain integer counts.
      for (const c of [3, 5]) {
        const addr = XLSX.utils.encode_cell({ r, c });
        if (wsSummary[addr] && typeof wsSummary[addr].v === "number") {
          wsSummary[addr].s = { numFmt: "#,##0", font: { color: { rgb: "1F2937" } } };
        }
      }
      // Last Wk Sales (4), This Wk Sales (6) — plain currency, no red/green (not a delta).
      for (const c of [4, 6]) {
        const addr = XLSX.utils.encode_cell({ r, c });
        if (wsSummary[addr] && typeof wsSummary[addr].v === "number") {
          wsSummary[addr].s = { numFmt: "#,##0.00", font: { color: { rgb: "1F2937" } } };
        }
      }
      // Δ Sales (7), Δ % (8) — signed, red/green.
      for (let c = 7; c <= 8; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = wsSummary[addr];
        if (!cell || typeof cell.v !== "number") continue;
        cell.s = { numFmt: c === 7 ? "#,##0.00" : "0.0%", font: { color: { rgb: cell.v < 0 ? "B91C1C" : "047857" }, bold: true } };
      }
    }

    // ── Styling for the Category Insights block ──
    const setStyle = (r: number, c: number, s: Record<string, unknown>) => {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (!wsSummary[addr]) wsSummary[addr] = { t: "s", v: "" };
      wsSummary[addr].s = s;
    };
    const signed = (r: number, c: number) => {
      const cell = wsSummary[XLSX.utils.encode_cell({ r, c })];
      if (!cell || typeof cell.v !== "number") return;
      cell.s = { numFmt: "0.0%", font: { color: { rgb: cell.v < 0 ? "B91C1C" : "047857" }, bold: true }, alignment: { horizontal: "center" } };
    };
    const plain = (r: number, c: number, numFmt: string) => {
      const cell = wsSummary[XLSX.utils.encode_cell({ r, c })];
      if (!cell || typeof cell.v !== "number") return;
      cell.s = { numFmt, font: { color: { rgb: "1F2937" } }, alignment: { horizontal: "center" } };
    };

    insightRows.title.forEach((r) => {
      for (let c = 0; c < SUMMARY_COLS; c++) {
        setStyle(r, c, { font: { bold: true, sz: 13, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "0F172A" } }, alignment: { horizontal: "center", vertical: "center" } });
      }
    });
    insightRows.header.forEach((r) => {
      for (let c = 0; c < SUMMARY_COLS; c++) {
        setStyle(r, c, { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "4F46E5" } }, alignment: { horizontal: "center", vertical: "center", wrapText: true } });
      }
    });
    insightRows.banner.forEach(({ row, color }) => {
      for (let c = 0; c < SUMMARY_COLS; c++) {
        setStyle(row, c, { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: color.replace("#", "") } }, alignment: { horizontal: "center" } });
      }
    });

    // Overview rows: RevThisWk(1) RevLastWk(2) Growth%(3) Orders(4) Units(5) Contribution%(6) Score(7) Status(8) Reason(9)
    overviewDataRows.forEach((r) => {
      setStyle(r, 0, { font: { bold: true, color: { rgb: "111827" } } });
      plain(r, 1, "#,##0.00");
      plain(r, 2, "#,##0.00");
      signed(r, 3);
      plain(r, 4, "#,##0");
      plain(r, 5, "#,##0");
      const share = wsSummary[XLSX.utils.encode_cell({ r, c: 6 })];
      if (share && typeof share.v === "number") share.s = { numFmt: "0.0%", font: { color: { rgb: "1F2937" } }, alignment: { horizontal: "center" } };
      const scoreCell = wsSummary[XLSX.utils.encode_cell({ r, c: 7 })];
      const statusCell = wsSummary[XLSX.utils.encode_cell({ r, c: 8 })];
      const label = String(statusCell?.v || "");
      const tone = label.includes("Excellent") ? "047857" : label.includes("Stable") ? "B45309" : "B91C1C";
      if (scoreCell) scoreCell.s = { font: { bold: true, color: { rgb: tone } }, alignment: { horizontal: "center" } };
      if (statusCell) statusCell.s = { font: { bold: true, color: { rgb: tone } }, alignment: { horizontal: "center" } };
      setStyle(r, 9, { font: { color: { rgb: "1F2937" } }, alignment: { vertical: "center", wrapText: true } });
      wsSummary["!rows"] = wsSummary["!rows"] || [];
      wsSummary["!rows"][r] = { hpt: 30 };
    });

    // Detail rows: Revenue(2) RevΔ%(3) Units(4) Orders(5) OrdersΔ%(6) Reason(7) Action(8)
    [...insightRows.good, ...insightRows.bad].forEach((r) => {
      const isBad = insightRows.bad.includes(r);
      setStyle(r, 0, { font: { bold: true, color: { rgb: isBad ? "B91C1C" : "047857" } }, alignment: { vertical: "center" } });
      setStyle(r, 1, { font: { bold: true, color: { rgb: "111827" } }, alignment: { vertical: "center", wrapText: true } });
      plain(r, 2, "#,##0.00");
      signed(r, 3);
      plain(r, 4, "#,##0");
      plain(r, 5, "#,##0");
      signed(r, 6);
      for (const c of [7, 8]) setStyle(r, c, { font: { color: { rgb: "1F2937" } }, alignment: { vertical: "center", wrapText: true } });
    });

    insightRows.rec.forEach((r) => {
      setStyle(r, 0, { font: { bold: true, color: { rgb: "4338CA" } }, alignment: { vertical: "center" } });
      setStyle(r, 1, { font: { bold: true, color: { rgb: "3730A3" } }, fill: { fgColor: { rgb: "EEF2FF" } }, alignment: { vertical: "center", wrapText: true } });
    });
    insightRows.legend.forEach((r) => {
      setStyle(r, 0, { font: { italic: true, sz: 9, color: { rgb: "6B7280" } }, alignment: { vertical: "top", wrapText: true } });
      wsSummary["!rows"] = wsSummary["!rows"] || [];
      wsSummary["!rows"][r] = { hpt: 46 };
    });

    // ── Styling for the new Key Metrics / AI Weekly Growth Summary block ──
    kpiSectionRows.forEach((r) => {
      for (let c = 0; c < SUMMARY_COLS; c++) {
        setStyle(r, c, { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "4F46E5" } }, alignment: { horizontal: "center", vertical: "center" } });
      }
    });
    kpiWideTextRows.forEach((r) => {
      setStyle(r, 0, { font: { color: { rgb: "1F2937" } }, alignment: { horizontal: "left", vertical: "center", wrapText: true } });
    });
    kpiLabelRows.forEach((r) => {
      for (let c = 0; c < SUMMARY_COLS; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        if (wsSummary[addr] && wsSummary[addr].v !== "") {
          wsSummary[addr].s = { font: { bold: true, sz: 9, color: { rgb: "6B7280" } }, fill: { fgColor: { rgb: "F3F4F6" } }, alignment: { horizontal: "center", vertical: "center" } };
        }
      }
    });
    const kpiToneColor = { good: "047857", bad: "B91C1C", neutral: "B45309" } as const;
    kpiValueCells.forEach(({ row, col, tone }) => {
      setStyle(row, col, {
        font: { bold: true, sz: 13, color: { rgb: tone ? kpiToneColor[tone] : "111827" } },
        alignment: { horizontal: "center", vertical: "center" },
        border: { bottom: { style: "medium", color: { rgb: "E5E7EB" } } },
      });
    });
    setStyle(confidenceRow, 0, { font: { bold: true, sz: 13, color: { rgb: "3730A3" } }, fill: { fgColor: { rgb: "EEF2FF" } }, alignment: { horizontal: "center", vertical: "center" } });

    XLSX.utils.book_append_sheet(wb, wsSummary, "Growth Summary");
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ── Category Breakdown sheet ──
  // ═══════════════════════════════════════════════════════════════════════
  {
    const catRows = [...categoryAgg.entries()]
      .filter(([name]) => !EXCLUDED_CATEGORIES.has(name))
      .sort((a, b) => b[1].grandSales - a[1].grandSales);
    const grandAllSales = catRows.reduce((a, [, v]) => a + v.grandSales, 0);
    const grandAllUnits = catRows.reduce((a, [, v]) => a + v.grandUnits, 0);

    const CAT_COLS_PER_PERIOD = 3;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const catHeader1: any[] = ["Category"];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const catHeader2: any[] = [""];
    periods.forEach(() => {
      catHeader1.push(...Array(CAT_COLS_PER_PERIOD).fill(""));
      catHeader2.push("Sales", "Units", "Growth %");
    });
    periods.forEach((pd, i) => { catHeader1[1 + i * CAT_COLS_PER_PERIOD] = pd.label; });
    catHeader1.push("", "", "");
    catHeader2.push("Total Sales", "Total Units", "Share %");
    // Enhanced per-category columns — additive only, appended after the existing Totals columns so
    // every column position/format above is untouched.
    const EXTRA_COLS = 6;
    catHeader1.push("", "", "", "", "", "");
    catHeader2.push("Avg Selling Price", "Best Selling Product", "Fastest Growing Product", "Category Health Score", "Category Status", "Business Importance");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const catAoa: any[][] = [catHeader1, catHeader2];
    catRows.forEach(([name, v]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rowData: any[] = [name];
      let prevSales: number | null = null;
      periods.forEach((pd) => {
        const stat = v.periods[pd.label];
        const sales = stat?.sales || 0;
        const units = stat?.units || 0;
        const growth = prevSales !== null && prevSales !== 0 ? (sales - prevSales) / prevSales : "";
        rowData.push(sales, units, growth);
        prevSales = sales;
      });
      rowData.push(v.grandSales, v.grandUnits, grandAllSales ? v.grandSales / grandAllSales : 0);

      const catScore = scoreCategory(name);
      const catDeltas = deltas.filter((d) => d.category === name);
      const bestInCat = [...catDeltas].sort((a, b) => b.thisSales - a.thisSales)[0];
      const fastestInCat = catDeltas.filter((d) => d.lastSales > 0 && d.delta > 0).sort((a, b) => b.pct - a.pct)[0];
      const importance = grandAllSales > 0 && v.grandSales / grandAllSales >= 0.25 ? "High" : grandAllSales > 0 && v.grandSales / grandAllSales >= 0.1 ? "Medium" : "Low";
      rowData.push(
        catScore.units > 0 ? catScore.thisRev / catScore.units : 0,
        bestInCat ? `${bestInCat.name} (${inr(bestInCat.thisSales)})` : "No sales this week",
        fastestInCat ? `${fastestInCat.name} (${pctStr(fastestInCat.pct)})` : "No growth this week",
        `${catScore.score}/100`,
        healthBand(catScore.score).label,
        importance
      );
      catAoa.push(rowData);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const totalRow: any[] = ["TOTAL (All Categories)"];
    let prevTotalPeriodSales: number | null = null;
    periods.forEach((pd) => {
      const sales = catRows.reduce((a, [, v]) => a + (v.periods[pd.label]?.sales || 0), 0);
      const units = catRows.reduce((a, [, v]) => a + (v.periods[pd.label]?.units || 0), 0);
      const growth = prevTotalPeriodSales !== null && prevTotalPeriodSales !== 0 ? (sales - prevTotalPeriodSales) / prevTotalPeriodSales : "";
      totalRow.push(sales, units, growth);
      prevTotalPeriodSales = sales;
    });
    totalRow.push(grandAllSales, grandAllUnits, 1);
    totalRow.push(grandAllUnits > 0 ? grandAllSales / grandAllUnits : 0, "—", "—", `${businessHealthScore}/100`, healthBand(businessHealthScore).label, "—");
    catAoa.push(totalRow);

    const wsCat = XLSX.utils.aoa_to_sheet(catAoa);
    const catTotalCols = 1 + periods.length * CAT_COLS_PER_PERIOD + 3 + EXTRA_COLS;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const catMerges: any[] = [{ s: { r: 0, c: 0 }, e: { r: 1, c: 0 } }];
    periods.forEach((_, i) => {
      const c0 = 1 + i * CAT_COLS_PER_PERIOD;
      catMerges.push({ s: { r: 0, c: c0 }, e: { r: 0, c: c0 + CAT_COLS_PER_PERIOD - 1 } });
    });
    const totalsC0 = 1 + periods.length * CAT_COLS_PER_PERIOD;
    catMerges.push({ s: { r: 0, c: totalsC0 }, e: { r: 0, c: totalsC0 + 2 } });
    const extraC0 = totalsC0 + 3;
    catMerges.push({ s: { r: 0, c: extraC0 }, e: { r: 0, c: extraC0 + EXTRA_COLS - 1 } });
    wsCat["!merges"] = catMerges;
    if (catHeader1[totalsC0] === "") wsCat[XLSX.utils.encode_cell({ r: 0, c: totalsC0 })] = { t: "s", v: "Totals" };
    wsCat[XLSX.utils.encode_cell({ r: 0, c: extraC0 })] = { t: "s", v: "Enhanced Insights" };

    for (let r = 0; r <= 1; r++) {
      for (let c = 0; c < catTotalCols; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        if (!wsCat[addr]) wsCat[addr] = { t: "s", v: "" };
        wsCat[addr].s = {
          font: { bold: true, color: { rgb: "FFFFFF" } },
          fill: { fgColor: { rgb: r === 0 ? "312E81" : "4F46E5" } },
          alignment: { horizontal: "center", vertical: "center" },
          border: { bottom: { style: "medium", color: { rgb: "1E1B4B" } } },
        };
      }
    }

    for (let r = 2; r < catAoa.length; r++) {
      const isTotalRow = r === catAoa.length - 1;
      for (let c = 0; c < catTotalCols; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = wsCat[addr];
        if (!cell) continue;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const style: any = {
          font: { color: { rgb: "1F2937" }, bold: isTotalRow },
          alignment: { vertical: "center" },
          border: { bottom: { style: isTotalRow ? "medium" : "thin", color: { rgb: isTotalRow ? "312E81" : "E5E7EB" } } },
        };

        if (c === 0) {
          style.font = { color: { rgb: "111827" }, bold: true };
        } else if (c < 1 + periods.length * CAT_COLS_PER_PERIOD) {
          const posInPeriod = (c - 1) % CAT_COLS_PER_PERIOD;
          if (posInPeriod === 0) { style.numFmt = "#,##0.00"; style.font = { color: { rgb: "059669" }, bold: true }; }
          if (posInPeriod === 1) style.numFmt = "#,##0";
          if (posInPeriod === 2 && typeof cell.v === "number") {
            style.numFmt = "0.0%";
            if (cell.v > 0) style.font = { color: { rgb: "047857" }, bold: true };
            else if (cell.v < 0) style.font = { color: { rgb: "B91C1C" }, bold: true };
          }
        } else {
          const posInTotals = c - (1 + periods.length * CAT_COLS_PER_PERIOD);
          if (posInTotals === 0) { style.numFmt = "#,##0.00"; style.font = { color: { rgb: "059669" }, bold: true }; }
          if (posInTotals === 1) style.numFmt = "#,##0";
          if (posInTotals === 2) style.numFmt = "0.0%";
          // posInTotals 3 = Avg Selling Price (the other enhanced columns, 4-8, are text/labels
          // and get their own tone-colouring pass below rather than a numFmt here).
          if (posInTotals === 3) { style.numFmt = "#,##0.00"; style.font = { color: { rgb: "059669" }, bold: true }; }
        }
        cell.s = style;
      }
    }

    // ── Tone-colour the enhanced Category Status / Business Importance columns ──
    const statusCol = extraC0 + 4;
    const importanceCol = extraC0 + 5;
    for (let r = 2; r < catAoa.length; r++) {
      const statusCell = wsCat[XLSX.utils.encode_cell({ r, c: statusCol })];
      if (statusCell) {
        const label = String(statusCell.v || "");
        const tone = label.includes("Excellent") ? "047857" : label.includes("Good") ? "2563EB" : label.includes("Average") ? "B45309" : label.includes("Poor") ? "C2410C" : label.includes("Critical") ? "B91C1C" : "1F2937";
        statusCell.s = { font: { bold: true, color: { rgb: tone } }, alignment: { horizontal: "center", vertical: "center" } };
      }
      const importanceCell = wsCat[XLSX.utils.encode_cell({ r, c: importanceCol })];
      if (importanceCell) {
        const label = String(importanceCell.v || "");
        const tone = label === "High" ? "047857" : label === "Medium" ? "B45309" : label === "Low" ? "6B7280" : "1F2937";
        importanceCell.s = { font: { bold: true, color: { rgb: tone } }, alignment: { horizontal: "center", vertical: "center" } };
      }
    }

    const catCols = [{ wch: 24 }];
    periods.forEach(() => { catCols.push({ wch: 13 }, { wch: 9 }, { wch: 10 }); });
    catCols.push({ wch: 13 }, { wch: 11 }, { wch: 9 });
    catCols.push({ wch: 15 }, { wch: 28 }, { wch: 28 }, { wch: 14 }, { wch: 13 }, { wch: 14 });
    wsCat["!cols"] = catCols;
    wsCat["!views"] = [{ state: "frozen", xSplit: 1, ySplit: 2 }];

    XLSX.utils.book_append_sheet(wb, wsCat, "Category Breakdown");
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ── Sales Summary (Enhanced) block, appended below the existing per-product/category grid on ──
  // the Amazon Sales sheet. Appended rather than prepended so none of the grid's existing row
  // indices (headers at rows 0-1, frozen pane, per-cell styling loop) need to shift — `ws` already
  // exists at this point, so these rows are written directly into it via encode_cell, same pattern
  // as every other sheet in this file.
  // Daily figures (Highest/Lowest Revenue Day, Daily Performance) are intentionally not included:
  // this export holds exactly 2 period-level rows per product (this week vs last week), not
  // per-day rows, so a daily breakdown isn't something this dataset can support without inventing
  // numbers — noted below instead of faked.
  // ═══════════════════════════════════════════════════════════════════════
  {
    const salesR0 = aoa.length + 1; // one blank row after the existing grid
    let r = salesR0;
    const salesMerges: { s: { r: number; c: number }; e: { r: number; c: number } }[] = [];
    const setSalesCell = (row: number, col: number, value: unknown, style?: Record<string, unknown>) => {
      const addr = XLSX.utils.encode_cell({ r: row, c: col });
      ws[addr] = { t: typeof value === "number" ? "n" : "s", v: value as string | number };
      if (style) ws[addr].s = style;
    };
    const bannerStyle = { font: { bold: true, sz: 14, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "0F172A" } }, alignment: { horizontal: "center", vertical: "center" } };
    const sectionStyle = { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "4F46E5" } }, alignment: { horizontal: "center", vertical: "center" } };
    const noteStyle = { font: { italic: true, sz: 9, color: { rgb: "6B7280" } }, alignment: { horizontal: "left", vertical: "top", wrapText: true } };

    const pushSalesBanner = (text: string, style: Record<string, unknown>) => {
      salesMerges.push({ s: { r, c: 0 }, e: { r, c: totalCols - 1 } });
      for (let c = 0; c < totalCols; c++) setSalesCell(r, c, c === 0 ? text : "", style);
      r++;
    };
    const pushSalesRow = (label: string, value: string | number, numFmt?: string, tone?: "good" | "bad") => {
      setSalesCell(r, 0, label, { font: { bold: true, color: { rgb: "6B7280" } } });
      setSalesCell(r, 1, value, { font: { bold: true, color: { rgb: tone === "good" ? "047857" : tone === "bad" ? "B91C1C" : "111827" } }, ...(numFmt ? { numFmt } : {}) });
      r++;
    };

    pushSalesBanner(`📈 SALES SUMMARY (ENHANCED) — ${thisLabel} vs ${lastLabel}`, bannerStyle);
    r++;
    pushSalesBanner("EXECUTIVE KPI CARDS", sectionStyle);
    pushSalesRow("Total Revenue (This Wk)", inr(totalThisRev));
    pushSalesRow("Total Revenue (Last Wk)", inr(totalLastRev));
    pushSalesRow("Revenue Growth %", `${arrow(overallGrowth)} ${pctStr(overallGrowth)}`, undefined, overallGrowth >= 0 ? "good" : "bad");
    pushSalesRow("Total Orders (This Wk)", totalThisOrders.toLocaleString("en-IN"));
    pushSalesRow("Total Units (This Wk)", totalThisUnits.toLocaleString("en-IN"));
    pushSalesRow("Average Order Value", inr(avgOrderValue));
    pushSalesRow("Best Selling SKU", bestSellingProduct ? `${bestSellingProduct.name} (${bestSellingProduct.sku})` : "No sales data");
    pushSalesRow("Fastest Growing SKU", fastestGrowingProduct ? `${fastestGrowingProduct.name} (${fastestGrowingProduct.sku})` : "No qualifying SKU");
    pushSalesRow("Revenue Concentration % (Top 5)", barOf(revenueConcentrationPct));
    r++;
    setSalesCell(r, 0, "Daily Performance (Highest/Lowest Revenue Day) is not shown here — this report compares two weekly periods only and does not retain day-level rows.", noteStyle);
    salesMerges.push({ s: { r, c: 0 }, e: { r, c: totalCols - 1 } });
    r += 2;

    pushSalesBanner("TOP 5 PRODUCTS", sectionStyle);
    ["Rank", "Product", "SKU", "Revenue (This Wk)", "Growth %"].forEach((h, c) => setSalesCell(r, c, h, { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "312E81" } }, alignment: { horizontal: "center" } }));
    r++;
    bySalesDesc.slice(0, 5).forEach((d, i) => {
      setSalesCell(r, 0, i + 1, { alignment: { horizontal: "center" } });
      setSalesCell(r, 1, d.name);
      setSalesCell(r, 2, d.sku, { font: { color: { rgb: "4338CA" } } });
      setSalesCell(r, 3, d.thisSales, { numFmt: "#,##0.00", font: { color: { rgb: "059669" }, bold: true } });
      if (d.lastSales > 0) setSalesCell(r, 4, d.pct, { numFmt: "0.0%", font: { color: { rgb: d.pct < 0 ? "B91C1C" : "047857" }, bold: true } });
      else setSalesCell(r, 4, "");
      r++;
    });
    r++;

    pushSalesBanner("BOTTOM 5 PRODUCTS (BY REVENUE, AMONG THIS WEEK'S ACTIVE SKUS)", sectionStyle);
    ["Product", "SKU", "Revenue (This Wk)", "Growth %"].forEach((h, c) => setSalesCell(r, c, h, { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "312E81" } }, alignment: { horizontal: "center" } }));
    r++;
    const activeThisWeek = deltas.filter((d) => d.thisSales > 0).sort((a, b) => a.thisSales - b.thisSales);
    (activeThisWeek.length ? activeThisWeek.slice(0, 5) : [null]).forEach((d) => {
      if (!d) { setSalesCell(r, 0, "No active SKU this week"); r++; return; }
      setSalesCell(r, 0, d.name);
      setSalesCell(r, 1, d.sku, { font: { color: { rgb: "4338CA" } } });
      setSalesCell(r, 2, d.thisSales, { numFmt: "#,##0.00", font: { color: { rgb: "B91C1C" }, bold: true } });
      if (d.lastSales > 0) setSalesCell(r, 3, d.pct, { numFmt: "0.0%", font: { color: { rgb: d.pct < 0 ? "B91C1C" : "047857" }, bold: true } });
      else setSalesCell(r, 3, "");
      r++;
    });
    r++;

    pushSalesBanner("REVENUE DISTRIBUTION — TOP CATEGORIES", sectionStyle);
    catsBySalesDesc.slice(0, 5).forEach((s) => {
      setSalesCell(r, 0, s.cat, { font: { bold: true, color: { rgb: (CATEGORY_COLORS[s.cat] || CATEGORY_COLORS.Other).replace("#", "") } } });
      setSalesCell(r, 1, totalThisRev > 0 ? barOf(s.thisRev / totalThisRev) : "0%");
      r++;
    });

    ws["!merges"] = [...(ws["!merges"] || []), ...salesMerges];
  }

  XLSX.utils.book_append_sheet(wb, ws, "Amazon Sales");

  // ═══════════════════════════════════════════════════════════════════════
  // ── Sheet 4: Executive Dashboard ──
  // ═══════════════════════════════════════════════════════════════════════
  {
    const EX_COLS = 6;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const exAoA: any[][] = [];
    const exMerges: { s: { r: number; c: number }; e: { r: number; c: number } }[] = [];
    const exBannerRows: number[] = [];
    const exSectionRows: number[] = [];
    const exWideTextRows: number[] = [];
    const kpiLabelRows: number[] = [];
    const kpiValueCells: { row: number; col: number; tone?: "good" | "bad" | "neutral" }[] = [];

    const pushBanner = (text: string) => {
      exBannerRows.push(exAoA.length);
      exMerges.push({ s: { r: exAoA.length, c: 0 }, e: { r: exAoA.length, c: EX_COLS - 1 } });
      exAoA.push([text, ...Array(EX_COLS - 1).fill("")]);
    };
    const pushSection = (text: string) => {
      exSectionRows.push(exAoA.length);
      exMerges.push({ s: { r: exAoA.length, c: 0 }, e: { r: exAoA.length, c: EX_COLS - 1 } });
      exAoA.push([text, ...Array(EX_COLS - 1).fill("")]);
    };
    const pushBlank = () => exAoA.push(Array(EX_COLS).fill(""));
    const pushWideText = (text: string) => {
      exWideTextRows.push(exAoA.length);
      exMerges.push({ s: { r: exAoA.length, c: 0 }, e: { r: exAoA.length, c: EX_COLS - 1 } });
      exAoA.push([text, ...Array(EX_COLS - 1).fill("")]);
    };
    // 3 KPI cards per row, each spanning 2 columns x 2 rows (label row, value row).
    const pushKpiRow = (cards: { label: string; value: string; tone?: "good" | "bad" | "neutral" }[]) => {
      const padded = [...cards];
      while (padded.length < 3) padded.push({ label: "", value: "" });
      const labelRow = exAoA.length;
      exAoA.push(Array(EX_COLS).fill(""));
      exAoA.push(Array(EX_COLS).fill(""));
      kpiLabelRows.push(labelRow);
      padded.forEach((c, i) => {
        const c0 = i * 2;
        exMerges.push({ s: { r: labelRow, c: c0 }, e: { r: labelRow, c: c0 + 1 } });
        exMerges.push({ s: { r: labelRow + 1, c: c0 }, e: { r: labelRow + 1, c: c0 + 1 } });
        exAoA[labelRow][c0] = c.label;
        exAoA[labelRow + 1][c0] = c.value;
        kpiValueCells.push({ row: labelRow + 1, col: c0, tone: c.tone });
      });
    };

    pushBanner(`🏢 EXECUTIVE DASHBOARD — ${thisLabel} vs ${lastLabel}`);
    pushBlank();
    pushSection("KEY PERFORMANCE INDICATORS");

    pushKpiRow([
      { label: "Total Revenue (This Wk)", value: inr(totalThisRev) },
      { label: "Total Revenue (Last Wk)", value: inr(totalLastRev) },
      { label: "Revenue Growth %", value: `${arrow(overallGrowth)} ${pctStr(overallGrowth)}`, tone: overallGrowth >= 0 ? "good" : "bad" },
    ]);
    pushBlank();
    pushKpiRow([
      { label: "Total Orders (This Wk)", value: totalThisOrders.toLocaleString("en-IN") },
      { label: "Total Units (This Wk)", value: totalThisUnits.toLocaleString("en-IN") },
      { label: "Avg Order Value", value: inr(avgOrderValue) },
    ]);
    pushBlank();
    pushKpiRow([
      { label: "Best Selling Product", value: bestSellingProduct ? `${bestSellingProduct.name} (${inr(bestSellingProduct.thisSales)})` : "No sales data" },
      { label: "Fastest Growing Product", value: fastestGrowingProduct ? `${fastestGrowingProduct.name} (${pctStr(fastestGrowingProduct.pct)})` : "No qualifying product" },
      { label: "Total Active Products", value: `${activeProducts}` },
    ]);
    pushBlank();
    pushKpiRow([
      { label: "Highest Revenue Category", value: highestRevCategory ? `${highestRevCategory.cat} (${inr(highestRevCategory.thisRev)})` : "—" },
      { label: "Lowest Revenue Category", value: lowestRevCategory ? `${lowestRevCategory.cat} (${inr(lowestRevCategory.thisRev)})` : "—" },
      { label: "Business Health Score", value: `${businessHealthScore}/100 — ${healthBand(businessHealthScore).label}`, tone: businessHealthScore >= 65 ? "good" : businessHealthScore >= 50 ? "neutral" : "bad" },
    ]);
    pushBlank();
    pushKpiRow([
      { label: "Revenue Concentration % (Top 5)", value: barOf(revenueConcentrationPct) },
      { label: "Revenue at Risk %", value: barOf(revenueAtRiskPct), tone: revenueAtRiskPct >= 0.3 ? "bad" : revenueAtRiskPct >= 0.15 ? "neutral" : "good" },
      { label: "Weekly Performance Score", value: `${weeklyPerformanceScore}/100 — ${healthBand(weeklyPerformanceScore).label}`, tone: weeklyPerformanceScore >= 65 ? "good" : weeklyPerformanceScore >= 50 ? "neutral" : "bad" },
    ]);
    pushBlank();

    // ── Executive AI Summary — deterministic, built only from the numbers above; no invented claims. ──
    pushSection("EXECUTIVE AI SUMMARY");
    const summaryLines = [
      `Revenue ${overallGrowth >= 0 ? "increased" : "decreased"} by ${Math.abs(overallGrowth * 100).toFixed(1)}% compared to last week (${inr(totalLastRev)} → ${inr(totalThisRev)}).`,
      `Orders moved from ${totalLastOrders.toLocaleString("en-IN")} to ${totalThisOrders.toLocaleString("en-IN")}, with units ${totalLastUnits.toLocaleString("en-IN")} → ${totalThisUnits.toLocaleString("en-IN")} and an average order value of ${inr(avgOrderValue)}.`,
      highestRevCategory
        ? `Growth was primarily driven by ${highestRevCategory.cat}, contributing ${inr(highestRevCategory.thisRev)} (${pctStr(highestRevCategory.growth)}) this week.`
        : "No category-level sales recorded this week.",
      lowestRevCategory && lowestRevCategory.score < 50
        ? `Demand weakened in ${lowestRevCategory.cat} — health score ${lowestRevCategory.score}/100 (${healthBand(lowestRevCategory.score).label}).`
        : "No category fell into a Poor/Critical health band this week.",
      `Overall weekly performance is rated ${healthBand(weeklyPerformanceScore).label} (${weeklyPerformanceScore}/100).`,
    ];
    summaryLines.forEach((l) => pushWideText(l));
    pushBlank();

    // ── Top highlights / opportunities / risks ──
    pushSection("TOP BUSINESS HIGHLIGHTS");
    (growers.length ? growers.slice(0, 3) : [null]).forEach((d) =>
      pushWideText(d ? `📈 ${d.name} grew ${pctStr(d.pct)} (${inr(d.lastSales)} → ${inr(d.thisSales)})` : "No product grew this week.")
    );
    pushBlank();

    pushSection("TOP OPPORTUNITIES");
    const opportunities: string[] = [];
    if (revenueConcentrationPct >= 0.5) {
      opportunities.push(`Top 5 products carry ${(revenueConcentrationPct * 100).toFixed(0)}% of revenue — developing mid-tier SKUs would reduce concentration risk and unlock incremental growth.`);
    }
    scoredCats.filter((s) => s.growth > 0.1).forEach((s) => opportunities.push(`Scale advertising/inventory in ${s.cat} — growing ${pctStr(s.growth)} this week.`));
    if (opportunities.length === 0) opportunities.push("No standout opportunity signal this week beyond the highlighted top performers above.");
    opportunities.slice(0, 5).forEach((o) => pushWideText(`💡 ${o}`));
    pushBlank();

    pushSection("TOP RISKS");
    const risks: string[] = [];
    if (revenueAtRiskPct >= 0.15) risks.push(`${(revenueAtRiskPct * 100).toFixed(0)}% of this week's revenue comes from products currently declining.`);
    scoredCats.filter((s) => s.score < 50).forEach((s) => risks.push(`${s.cat} is in a ${healthBand(s.score).label} health band (${s.score}/100).`));
    if (risks.length === 0) risks.push("No category or concentration risk crossed this report's warning thresholds this week.");
    risks.slice(0, 5).forEach((r) => pushWideText(`⚠️ ${r}`));
    pushBlank();

    // ── Revenue contribution: Top 10 products ──
    pushSection("REVENUE CONTRIBUTION — TOP 10 PRODUCTS");
    const top10HeaderRow = exAoA.length;
    exAoA.push(["Rank", "Product", "SKU", "Revenue (This Wk)", "Growth %", "Share %"]);
    const top10DataRows: number[] = [];
    bySalesDesc.slice(0, 10).forEach((d, i) => {
      top10DataRows.push(exAoA.length);
      exAoA.push([i + 1, d.name, d.sku, d.thisSales, d.lastSales > 0 ? d.pct : "", totalThisRev > 0 ? d.thisSales / totalThisRev : 0]);
    });
    pushBlank();

    // ── Category contribution ──
    pushSection("CATEGORY CONTRIBUTION");
    const catHeaderRow = exAoA.length;
    exAoA.push(["Category", "Revenue (This Wk)", "Growth %", "Contribution %", "Health Score", "Status"]);
    const catDataRows: number[] = [];
    catsBySalesDesc.forEach((s) => {
      catDataRows.push(exAoA.length);
      exAoA.push([s.cat, s.thisRev, s.lastRev > 0 ? s.growth : "", totalThisRev > 0 ? s.thisRev / totalThisRev : 0, `${s.score}/100`, s.status]);
    });
    pushBlank();

    // ── Business health gauge ──
    pushSection("BUSINESS HEALTH GAUGE");
    const gaugeRow = exAoA.length;
    exMerges.push({ s: { r: gaugeRow, c: 0 }, e: { r: gaugeRow, c: EX_COLS - 1 } });
    exAoA.push([`${healthBand(businessHealthScore).label}  ·  ${businessHealthScore}/100  ·  ${barOf(businessHealthScore / 100, 20)}`, ...Array(EX_COLS - 1).fill("")]);
    pushBlank();

    // ── Weekly executive recommendations ──
    pushSection("WEEKLY EXECUTIVE RECOMMENDATIONS");
    const recommendations: string[] = [];
    scoredCats
      .filter((s) => s.score < 50)
      .forEach((s) => {
        const catDeltas = deltas.filter((d) => d.category === s.cat && d.delta < 0).sort((a, b) => a.delta - b.delta);
        const worst = catDeltas[0];
        if (worst) {
          const dx = diagnose(worst);
          recommendations.push(dx[0]?.action || `Review ${s.cat} — health score ${s.score}/100 with no single clear cause found.`);
        }
      });
    if (revenueConcentrationPct >= 0.5) recommendations.push("Reduce dependency on only a few products by expanding mid-tier SKU marketing.");
    if (revenueAtRiskPct >= 0.3) recommendations.push("Prioritise recovery actions on declining products — they represent a large share of current revenue.");
    if (recommendations.length === 0) recommendations.push("Hold course — no category or concentration risk needs urgent action this week.");
    recommendations.slice(0, 6).forEach((r) => pushWideText(`✅ ${r}`));

    const wsExec = XLSX.utils.aoa_to_sheet(exAoA);
    wsExec["!merges"] = exMerges;
    wsExec["!cols"] = [{ wch: 34 }, { wch: 22 }, { wch: 16 }, { wch: 18 }, { wch: 14 }, { wch: 16 }];

    const setExStyle = (r: number, c: number, s: Record<string, unknown>) => {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (!wsExec[addr]) wsExec[addr] = { t: "s", v: "" };
      wsExec[addr].s = s;
    };

    exBannerRows.forEach((r) => {
      for (let c = 0; c < EX_COLS; c++) {
        setExStyle(r, c, { font: { bold: true, sz: 14, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "0F172A" } }, alignment: { horizontal: "center", vertical: "center" } });
      }
    });
    exSectionRows.forEach((r) => {
      for (let c = 0; c < EX_COLS; c++) {
        setExStyle(r, c, { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "4F46E5" } }, alignment: { horizontal: "center", vertical: "center" } });
      }
    });
    exWideTextRows.forEach((r) => {
      setExStyle(r, 0, { font: { color: { rgb: "1F2937" } }, alignment: { horizontal: "left", vertical: "center", wrapText: true } });
    });
    kpiLabelRows.forEach((r) => {
      for (let c = 0; c < EX_COLS; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        if (wsExec[addr] && wsExec[addr].v !== "") {
          wsExec[addr].s = { font: { bold: true, sz: 9, color: { rgb: "6B7280" } }, fill: { fgColor: { rgb: "F3F4F6" } }, alignment: { horizontal: "center", vertical: "center" } };
        }
      }
    });
    const toneColor = { good: "047857", bad: "B91C1C", neutral: "B45309" } as const;
    kpiValueCells.forEach(({ row, col, tone }) => {
      setExStyle(row, col, {
        font: { bold: true, sz: 13, color: { rgb: tone ? toneColor[tone] : "111827" } },
        fill: { fgColor: { rgb: "FFFFFF" } },
        alignment: { horizontal: "center", vertical: "center" },
        border: { bottom: { style: "medium", color: { rgb: "E5E7EB" } } },
      });
    });
    [top10HeaderRow, catHeaderRow].forEach((r) => {
      for (let c = 0; c < EX_COLS; c++) setExStyle(r, c, { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "312E81" } }, alignment: { horizontal: "center", vertical: "center", wrapText: true } });
    });
    top10DataRows.forEach((r) => {
      setExStyle(r, 3, { numFmt: "#,##0.00", font: { color: { rgb: "059669" }, bold: true }, alignment: { horizontal: "center" } });
      const g = wsExec[XLSX.utils.encode_cell({ r, c: 4 })];
      if (g && typeof g.v === "number") g.s = { numFmt: "0.0%", font: { color: { rgb: g.v < 0 ? "B91C1C" : "047857" }, bold: true }, alignment: { horizontal: "center" } };
      const sh = wsExec[XLSX.utils.encode_cell({ r, c: 5 })];
      if (sh) sh.s = { numFmt: "0.0%", alignment: { horizontal: "center" } };
    });
    catDataRows.forEach((r) => {
      const color = CATEGORY_COLORS[String(wsExec[XLSX.utils.encode_cell({ r, c: 0 })]?.v)] || CATEGORY_COLORS.Other;
      setExStyle(r, 0, { font: { bold: true, color: { rgb: color.replace("#", "") } } });
      setExStyle(r, 1, { numFmt: "#,##0.00", font: { color: { rgb: "059669" }, bold: true }, alignment: { horizontal: "center" } });
      const g = wsExec[XLSX.utils.encode_cell({ r, c: 2 })];
      if (g && typeof g.v === "number") g.s = { numFmt: "0.0%", font: { color: { rgb: g.v < 0 ? "B91C1C" : "047857" }, bold: true }, alignment: { horizontal: "center" } };
      setExStyle(r, 3, { numFmt: "0.0%", alignment: { horizontal: "center" } });
      const statusCell = wsExec[XLSX.utils.encode_cell({ r, c: 5 })];
      const tone = String(statusCell?.v || "").includes("Attention") ? "B91C1C" : String(statusCell?.v || "").includes("Stable") ? "B45309" : "047857";
      setExStyle(r, 4, { font: { bold: true, color: { rgb: tone } }, alignment: { horizontal: "center" } });
      setExStyle(r, 5, { font: { bold: true, color: { rgb: tone } }, alignment: { horizontal: "center" } });
    });
    setExStyle(gaugeRow, 0, { font: { bold: true, sz: 13, color: { rgb: healthBand(businessHealthScore).color } }, alignment: { horizontal: "center", vertical: "center" } });

    XLSX.utils.book_append_sheet(wb, wsExec, "Executive Dashboard");
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ── Sheet 5: CEO Decision Center ──
  // Every recommendation/priority below traces back to diagnose()/scoreCategory() — the same
  // functions the Growth Summary and Executive Dashboard sheets use — so nothing here contradicts
  // what those sheets say. The forecast is explicitly labelled as a naive 2-point trend, not a
  // statistical model, since that's genuinely all two weeks of data supports.
  // ═══════════════════════════════════════════════════════════════════════
  {
    const CEO_COLS = 6;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ceoAoA: any[][] = [];
    const ceoMerges: { s: { r: number; c: number }; e: { r: number; c: number } }[] = [];
    const ceoBannerRows: number[] = [];
    const ceoSectionRows: number[] = [];
    const ceoWideTextRows: number[] = [];

    const pushBanner = (text: string) => {
      ceoBannerRows.push(ceoAoA.length);
      ceoMerges.push({ s: { r: ceoAoA.length, c: 0 }, e: { r: ceoAoA.length, c: CEO_COLS - 1 } });
      ceoAoA.push([text, ...Array(CEO_COLS - 1).fill("")]);
    };
    const pushSection = (text: string) => {
      ceoSectionRows.push(ceoAoA.length);
      ceoMerges.push({ s: { r: ceoAoA.length, c: 0 }, e: { r: ceoAoA.length, c: CEO_COLS - 1 } });
      ceoAoA.push([text, ...Array(CEO_COLS - 1).fill("")]);
    };
    const pushBlank = () => ceoAoA.push(Array(CEO_COLS).fill(""));
    const pushWideText = (text: string) => {
      ceoWideTextRows.push(ceoAoA.length);
      ceoMerges.push({ s: { r: ceoAoA.length, c: 0 }, e: { r: ceoAoA.length, c: CEO_COLS - 1 } });
      ceoAoA.push([text, ...Array(CEO_COLS - 1).fill("")]);
    };

    pushBanner(`🎯 CEO DECISION CENTER — ${thisLabel} vs ${lastLabel}`);
    pushBlank();

    // ── CEO Insights ──
    pushSection("CEO INSIGHTS");
    [
      `Business generated ${inr(totalThisRev)} this week, ${overallGrowth >= 0 ? "up" : "down"} ${pctStr(overallGrowth)} vs ${inr(totalLastRev)} last week.`,
      highestRevCategory ? `${highestRevCategory.cat} is the primary revenue engine at ${inr(highestRevCategory.thisRev)} (${(totalThisRev > 0 ? (highestRevCategory.thisRev / totalThisRev) * 100 : 0).toFixed(0)}% of total).` : "No category data available.",
      `Top 5 products account for ${(revenueConcentrationPct * 100).toFixed(0)}% of revenue — ${revenueConcentrationPct >= 0.5 ? "a concentration level worth actively managing" : "a reasonably diversified base"}.`,
      `Overall business health is ${healthBand(businessHealthScore).label} (${businessHealthScore}/100).`,
    ].forEach((l) => pushWideText(l));
    pushBlank();

    // ── Business Opportunities / Risks ──
    pushSection("BUSINESS OPPORTUNITIES");
    const ceoOpportunities: string[] = [];
    scoredCats.filter((s) => s.growth > 0.1).forEach((s) => ceoOpportunities.push(`Scale ${s.cat} — growing ${pctStr(s.growth)} with health score ${s.score}/100.`));
    if (revenueConcentrationPct < 0.35) ceoOpportunities.push("Revenue is well-diversified across products — a healthy base to layer new SKU launches onto.");
    if (ceoOpportunities.length === 0) ceoOpportunities.push("No standout scale-up signal this week beyond the top performers already listed on the Executive Dashboard.");
    ceoOpportunities.slice(0, 5).forEach((o) => pushWideText(`💡 ${o}`));
    pushBlank();

    pushSection("BUSINESS RISKS");
    const ceoRisks: string[] = [];
    if (revenueAtRiskPct >= 0.15) ceoRisks.push(`${(revenueAtRiskPct * 100).toFixed(0)}% of revenue sits in products that declined this week.`);
    scoredCats.filter((s) => s.score < 50).forEach((s) => ceoRisks.push(`${s.cat} — ${healthBand(s.score).label} (${s.score}/100).`));
    if (revenueConcentrationPct >= 0.5) ceoRisks.push(`Top 5 products carry ${(revenueConcentrationPct * 100).toFixed(0)}% of revenue — losing any one of them would materially hurt total sales.`);
    if (ceoRisks.length === 0) ceoRisks.push("No category or concentration risk crossed this report's warning thresholds this week.");
    ceoRisks.slice(0, 5).forEach((r) => pushWideText(`⚠️ ${r}`));
    pushBlank();

    // ── Revenue dependency analysis ──
    pushSection("REVENUE DEPENDENCY ANALYSIS");
    const top1Pct = totalThisRev > 0 && bySalesDesc[0] ? bySalesDesc[0].thisSales / totalThisRev : 0;
    const topCatPct = totalThisRev > 0 && highestRevCategory ? highestRevCategory.thisRev / totalThisRev : 0;
    let cumRev = 0;
    let pareto80Count = 0;
    for (const d of bySalesDesc) {
      if (cumRev / (totalThisRev || 1) >= 0.8) break;
      cumRev += d.thisSales;
      pareto80Count++;
    }
    [
      ["Single largest product", barOf(top1Pct)],
      ["Top 5 products", barOf(revenueConcentrationPct)],
      ["Single largest category", barOf(topCatPct)],
      ["Products needed to reach 80% of revenue", `${pareto80Count} of ${activeProducts} active products`],
    ].forEach(([label, value]) => ceoAoA.push([label, value, "", "", "", ""]));
    pushBlank();

    // ── Top products driving / losing revenue ──
    pushSection("TOP PRODUCTS DRIVING REVENUE");
    const driveHeaderRow = ceoAoA.length;
    ceoAoA.push(["Product", "SKU", "Revenue (This Wk)", "Cumulative Share %", "", ""]);
    const driveDataRows: number[] = [];
    let cum = 0;
    bySalesDesc.slice(0, 8).forEach((d) => {
      cum += d.thisSales;
      driveDataRows.push(ceoAoA.length);
      ceoAoA.push([d.name, d.sku, d.thisSales, totalThisRev > 0 ? cum / totalThisRev : 0, "", ""]);
    });
    pushBlank();

    pushSection("PRODUCTS LOSING REVENUE");
    const loseHeaderRow = ceoAoA.length;
    ceoAoA.push(["Product", "SKU", "Revenue Δ", "Possible Reason", "", ""]);
    const loseDataRows: number[] = [];
    decliners.slice(0, 8).forEach((d) => {
      const dx = diagnose(d);
      loseDataRows.push(ceoAoA.length);
      ceoAoA.push([d.name, d.sku, d.delta, dx[0]?.reason || "No clear supply-side signal found", "", ""]);
    });
    if (decliners.length === 0) ceoAoA.push(["No product declined this week", "", "", "", "", ""]);
    pushBlank();

    // ── Inventory / Pricing / Advertising recommendations, each pulled straight from diagnose() ──
    const reasonsOfType = (needle: string) =>
      decliners
        .map((d) => ({ d, dx: diagnose(d) }))
        .filter(({ dx }) => dx[0]?.reason.startsWith(needle))
        .sort((a, b) => (b.dx[0]?.impact || 0) - (a.dx[0]?.impact || 0));

    pushSection("INVENTORY RECOMMENDATIONS");
    const lowStock = reasonsOfType("Low Stock");
    if (lowStock.length === 0) pushWideText("No product's decline this week was attributed to low stock.");
    lowStock.slice(0, 5).forEach(({ dx }) => pushWideText(`📦 ${dx[0].action} — lost ~${inr(dx[0].impact)} this week.`));
    pushBlank();

    pushSection("PRICING RECOMMENDATIONS");
    const priceDrops = reasonsOfType("Price Drop");
    if (priceDrops.length === 0) pushWideText("No product's decline this week was attributed to a price drop.");
    priceDrops.slice(0, 5).forEach(({ dx }) => pushWideText(`💰 ${dx[0].action} — lost ~${inr(dx[0].impact)} this week.`));
    pushBlank();

    pushSection("ADVERTISING RECOMMENDATIONS");
    if (!hasAdData) {
      pushWideText("No Sponsored Products data uploaded for this window — advertising recommendations need that export to be generated.");
    } else {
      const adDrops = reasonsOfType("Campaign Performance");
      if (adDrops.length === 0) pushWideText("No product's decline this week was attributed to reduced ad spend.");
      adDrops.slice(0, 5).forEach(({ dx }) => pushWideText(`📣 ${dx[0].action} — lost ~${inr(dx[0].impact)} this week.`));
    }
    pushBlank();

    // ── Products to scale / improve / review / discontinue ──
    pushSection("PRODUCTS TO SCALE");
    (growers.length ? growers.slice(0, 5) : [null]).forEach((d) =>
      pushWideText(d ? `🚀 ${d.name} — grew ${pctStr(d.pct)} (${inr(d.lastSales)} → ${inr(d.thisSales)}). Increase inventory and ad budget.` : "No product qualifies to scale this week.")
    );
    pushBlank();

    const actionable = ["Price Drop", "Low Stock", "High Returns", "Campaign Performance"];
    const withDiagnosis = decliners.map((d) => ({ d, dx: diagnose(d) }));
    const toImprove = withDiagnosis.filter(({ dx }) => dx[0] && actionable.includes(dx[0].reason.split(" — ")[0].split(" (")[0]));
    const toReview = withDiagnosis.filter(({ dx }) => !dx[0] || !actionable.includes(dx[0].reason.split(" — ")[0].split(" (")[0]));

    pushSection("PRODUCTS TO IMPROVE");
    if (toImprove.length === 0) pushWideText("No decliner this week had a clear, fixable cause identified.");
    toImprove.slice(0, 5).forEach(({ d, dx }) => pushWideText(`🔧 ${d.name}: ${dx[0].reason} — ${dx[0].action}`));
    pushBlank();

    pushSection("PRODUCTS TO REVIEW");
    if (toReview.length === 0) pushWideText("Every decliner this week had a clear, identifiable cause — none need open-ended manual review.");
    toReview.slice(0, 5).forEach(({ d, dx }) => pushWideText(`🔍 ${d.name}: ${dx[0]?.reason || "No supply-side signal found"} — recommend a manual traffic/conversion review.`));
    pushBlank();

    pushSection("PRODUCTS TO DISCONTINUE (IF CONSISTENTLY UNDERPERFORMING)");
    pushWideText("Based on 2 weeks of data only — confirm against a longer trend before discontinuing anything.");
    const zeroedOut = deltas.filter((d) => d.thisSales === 0 && d.lastSales > 0).sort((a, b) => b.lastSales - a.lastSales);
    if (zeroedOut.length === 0) pushWideText("No product sold last week but zero this week.");
    zeroedOut.slice(0, 5).forEach((d) => {
      const dx = diagnose(d);
      pushWideText(`🛑 ${d.name} — sold ${inr(d.lastSales)} last week, ₹0 this week. ${dx[0]?.reason || "No cause identified"}.`);
    });
    pushBlank();

    // ── Next week forecast — naive 2-point trend continuation, explicitly labelled as such. ──
    pushSection("NEXT WEEK FORECAST (NAIVE TREND — NOT A STATISTICAL MODEL)");
    const expectedRevenue = totalThisRev * (1 + overallGrowth);
    const expectedOrders = Math.round(totalThisOrders * (1 + ordersGrowthPct));
    const expectedUnits = Math.round(totalThisUnits * (1 + unitsGrowthPct));
    // Confidence is capped low by design (growthConfidencePct, shared with the Growth Summary
    // sheet's own confidence score) — only two weeks of data back this, so it's directional, not
    // predictive. It rises only when most categories agree on direction (growing or declining).
    [
      ["Expected Revenue", inr(expectedRevenue)],
      ["Expected Orders", expectedOrders.toLocaleString("en-IN")],
      ["Expected Units", expectedUnits.toLocaleString("en-IN")],
      ["Expected Growth %", pctStr(overallGrowth)],
      ["Confidence Score", `${growthConfidencePct}% (based on 2 weeks of data — treat as directional)`],
    ].forEach(([label, value]) => ceoAoA.push([label, value, "", "", "", ""]));
    pushBlank();

    // ── Executive action plan — every row traces to a diagnose() finding, prioritised by the ──
    // revenue it accounts for as a share of total revenue this week.
    pushSection("EXECUTIVE ACTION PLAN");
    const planHeaderRow = ceoAoA.length;
    ceoAoA.push(["Priority", "Action", "Product / Category", "Revenue Impact", "", ""]);
    const planDataRows: number[] = [];
    const priorityOf = (impact: number) => {
      const share = totalThisRev > 0 ? impact / totalThisRev : 0;
      if (share >= 0.05) return { label: "Critical", color: "B91C1C" };
      if (share >= 0.02) return { label: "High", color: "C2410C" };
      if (share >= 0.005) return { label: "Medium", color: "B45309" };
      return { label: "Low", color: "6B7280" };
    };
    const actionRows = withDiagnosis
      .filter(({ dx }) => dx.length > 0)
      .map(({ d, dx }) => ({ action: dx[0].action, product: d.name, impact: dx[0].impact }))
      .sort((a, b) => b.impact - a.impact)
      .slice(0, 8);
    actionRows.forEach(({ action, product, impact }) => {
      planDataRows.push(ceoAoA.length);
      ceoAoA.push([priorityOf(impact).label, action, product, impact, "", ""]);
    });
    if (actionRows.length === 0) ceoAoA.push(["Low", "Hold course — no decliner this week needs urgent action", "", "", "", ""]);
    pushBlank();

    // ── Executive closing summary ──
    pushSection("EXECUTIVE CLOSING SUMMARY");
    pushWideText(
      `This week closed at ${inr(totalThisRev)}, ${overallGrowth >= 0 ? "up" : "down"} ${pctStr(overallGrowth)} vs last week, with overall business health rated ${healthBand(businessHealthScore).label}. ` +
        `${highestRevCategory ? `${highestRevCategory.cat} led performance` : "No clear category leader emerged"}${lowestRevCategory && lowestRevCategory.score < 50 ? `, while ${lowestRevCategory.cat} needs attention` : ""}. ` +
        `${actionRows.length > 0 ? `${actionRows.length} action item(s) are flagged below, ranked by revenue impact.` : "No urgent action items were identified this week."}`
    );

    const wsCeo = XLSX.utils.aoa_to_sheet(ceoAoA);
    wsCeo["!merges"] = ceoMerges;
    wsCeo["!cols"] = [{ wch: 34 }, { wch: 22 }, { wch: 20 }, { wch: 18 }, { wch: 14 }, { wch: 14 }];

    const setCeoStyle = (r: number, c: number, s: Record<string, unknown>) => {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (!wsCeo[addr]) wsCeo[addr] = { t: "s", v: "" };
      wsCeo[addr].s = s;
    };

    ceoBannerRows.forEach((r) => {
      for (let c = 0; c < CEO_COLS; c++) setCeoStyle(r, c, { font: { bold: true, sz: 14, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "0F172A" } }, alignment: { horizontal: "center", vertical: "center" } });
    });
    ceoSectionRows.forEach((r) => {
      for (let c = 0; c < CEO_COLS; c++) setCeoStyle(r, c, { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "4F46E5" } }, alignment: { horizontal: "center", vertical: "center" } });
    });
    ceoWideTextRows.forEach((r) => {
      setCeoStyle(r, 0, { font: { color: { rgb: "1F2937" } }, alignment: { horizontal: "left", vertical: "center", wrapText: true } });
    });
    [driveHeaderRow, loseHeaderRow, planHeaderRow].forEach((r) => {
      for (let c = 0; c < CEO_COLS; c++) setCeoStyle(r, c, { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "312E81" } }, alignment: { horizontal: "center", vertical: "center", wrapText: true } });
    });
    driveDataRows.forEach((r) => {
      setCeoStyle(r, 2, { numFmt: "#,##0.00", font: { color: { rgb: "059669" }, bold: true }, alignment: { horizontal: "center" } });
      setCeoStyle(r, 3, { numFmt: "0.0%", alignment: { horizontal: "center" } });
    });
    loseDataRows.forEach((r) => {
      const cell = wsCeo[XLSX.utils.encode_cell({ r, c: 2 })];
      if (cell && typeof cell.v === "number") cell.s = { numFmt: "#,##0.00", font: { color: { rgb: "B91C1C" }, bold: true }, alignment: { horizontal: "center" } };
      setCeoStyle(r, 3, { font: { color: { rgb: "1F2937" } }, alignment: { horizontal: "left", wrapText: true } });
    });
    planDataRows.forEach((r) => {
      const prio = String(wsCeo[XLSX.utils.encode_cell({ r, c: 0 })]?.v || "");
      const tone = prio === "Critical" ? "B91C1C" : prio === "High" ? "C2410C" : prio === "Medium" ? "B45309" : "6B7280";
      setCeoStyle(r, 0, { font: { bold: true, color: { rgb: tone } }, alignment: { horizontal: "center" } });
      setCeoStyle(r, 1, { font: { color: { rgb: "1F2937" } }, alignment: { horizontal: "left", wrapText: true } });
      setCeoStyle(r, 3, { numFmt: "#,##0.00", font: { color: { rgb: "1F2937" } }, alignment: { horizontal: "center" } });
    });

    XLSX.utils.book_append_sheet(wb, wsCeo, "CEO Decision Center");
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ── Notes sheet — carries the same "data_pulled_at" field
  // historicalAnalysisReportExport.ts writes to its own Notes sheet, so a
  // per-SKU mismatch between the two files can be checked against how far
  // apart they were actually generated before it's treated as a bug.
  // ═══════════════════════════════════════════════════════════════════════
  {
    const wsNote = XLSX.utils.aoa_to_sheet([
      ["Amazon Weekly Sales Report"],
      [`Last week: ${lastLabel}    This week: ${thisLabel}`],
      [`Data pulled at: ${dataPulledAt} (compare against the Historical Analysis Report's own "Data pulled at" — a per-SKU difference between the two files is expected, not a bug, when they were generated far enough apart to see different uploads).`],
      [""],
      ["Orders/returns are bucketed by IST calendar day (purchase_datetime / return_date shifted +5:30), matching the Historical Analysis Report's convention, not by the raw UTC date — an order or return from the last ~5.5 hours of the UTC day would otherwise land on the wrong day in one report but not the other."],
      ["Total Orders = Orders − All Returns, left UNCLAMPED — it can go negative for a SKU that had a return recorded this period with no matching order in it (the order belongs to an earlier period). Matches the Historical Analysis Report's 'Final' column, which is unclamped for the same reason."],
    ]);
    wsNote["!cols"] = [{ wch: 110 }];
    if (wsNote.A1) wsNote.A1.s = { font: { bold: true, sz: 13, color: { rgb: "312E81" } } };
    XLSX.utils.book_append_sheet(wb, wsNote, "Notes");
  }

  const filename = `Amazon_Weekly_Sales_Report_${lastWeek.start}_to_${thisWeek.end}.xlsx`;
  return { wb, filename };
}

// Browser entry point (Upload Reports page) — same "this week vs last week" windows the email
// attachment uses (see retailMapBySku's windows in src/pages/api/weekly-report.ts), but triggers a
// real file download instead of a base64 email attachment. Purely client-side: sourced entirely
// from the uploaded Supabase tables, no SellerMate API key needed.
export async function exportWeeklySalesReport(opts?: { endDate?: string }) {
  const isoLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  let end = opts?.endDate;
  if (!end) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    end = isoLocal(d);
  }
  const endD = new Date(`${end}T00:00:00`);
  const thisStart = new Date(endD);
  thisStart.setDate(endD.getDate() - 6);
  const lastEnd = new Date(endD);
  lastEnd.setDate(endD.getDate() - 7);
  const lastStart = new Date(endD);
  lastStart.setDate(endD.getDate() - 13);

  const thisWeek = { start: isoLocal(thisStart), end };
  const lastWeek = { start: isoLocal(lastStart), end: isoLocal(lastEnd) };

  const { wb, filename } = await buildWeeklySalesWorkbookFromHistorical({ thisWeek, lastWeek });
  XLSX.writeFile(wb, filename);
  return { filename, thisWeek, lastWeek };
}
