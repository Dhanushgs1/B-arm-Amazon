import * as XLSX from "xlsx-js-style";
import { fetchAllRows, isGenuineAmReturn, isGenuineFbaReturn } from "@/lib/historicalAnalysisReportExport";
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

function nextDayIsoUtc(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const EXCLUDED_CATEGORIES = new Set(["Discontinued", "Other"]);

export async function buildWeeklySalesWorkbookFromHistorical(opts: {
  thisWeek: { start: string; end: string };
  lastWeek: { start: string; end: string };
}) {
  const { thisWeek, lastWeek } = opts;
  const periods: PeriodWindow[] = [
    { label: weekLabel(lastWeek.start, lastWeek.end), start: lastWeek.start, end: lastWeek.end },
    { label: weekLabel(thisWeek.start, thisWeek.end), start: thisWeek.start, end: thisWeek.end },
  ];
  const periodForDate = (dayIso: string): PeriodWindow | undefined =>
    periods.find((p) => dayIso >= p.start && dayIso <= p.end);

  // Fetch every relevant row once across the combined 2-week span, split by date in memory below —
  // same "fetch once, filter twice" approach historicalAnalysisReportExport.ts uses for its 30/7-day windows.
  const [orderRows, amReturnRows, fbaReturnRows, priceListingRows, ledgerRows, adRows] = await Promise.all([
    fetchAllRows("barm_amazon_am_orders", (q) => q.gte("purchase_date", lastWeek.start).lte("purchase_date", thisWeek.end)),
    fetchAllRows("barm_amazon_am_returns", (q) => q.gte("return_request_date", lastWeek.start).lte("return_request_date", thisWeek.end)),
    fetchAllRows("barm_amazon_fba_returns", (q) =>
      q.gte("return_date", `${lastWeek.start}T00:00:00Z`).lt("return_date", `${nextDayIsoUtc(thisWeek.end)}T00:00:00Z`)
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
    if (!r.sku || !r.purchase_date) return;
    const pd = periodForDate(String(r.purchase_date).slice(0, 10));
    if (!pd) return;
    if (r.product_name && !nameBySku.has(r.sku)) nameBySku.set(r.sku, r.product_name);
    // A cancelled order never became revenue. Amazon still exports a row for it, usually with no
    // quantity but occasionally carrying a price — counting those added phantom sales.
    if (String(r.order_status || "").toLowerCase().startsWith("cancelled")) return;
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
    const pd = periodForDate(String(r.return_date).slice(0, 10));
    if (!pd) return;
    const qty = r.quantity || 0;
    const s = ensurePeriodStat(r.sku, pd.label);
    s.allReturns += qty;
    if (isGenuineFbaReturn(r)) s.returns += qty;
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
      const totalOrders = Math.max(0, raw.orders - raw.allReturns);
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

    const TOP_N = 5;
    const categoriesInOrder = [...categoryAgg.entries()]
      .filter(([name]) => !EXCLUDED_CATEGORIES.has(name))
      .sort((a, b) => b[1].grandSales - a[1].grandSales)
      .map(([name]) => name)
      .filter((name) => deltas.some((d) => d.category === name));

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
    // Everything here is derived from the same two-period data already loaded; nothing is
    // fetched again and no other sheet is touched. Reasons are only ever claimed when the
    // underlying signal exists — see diagnose() — so a category with no ad or stock data
    // simply shows fewer of them rather than a plausible-sounding guess.
    // ═════════════════════════════════════════════════════════════════════
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

    // Health score, 0–100, from four weighted components. Stated in the sheet's own legend so a
    // reader never has to ask where the number came from.
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

    const insightRows = { title: [] as number[], header: [] as number[], banner: [] as { row: number; color: string }[], good: [] as number[], bad: [] as number[], rec: [] as number[], legend: [] as number[] };
    const totalThisRev = categoriesInOrder.reduce((a, cat) => a + scoreCategory(cat).thisRev, 0);

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
    sAoA.push(["Category", "Revenue (This Wk)", "Revenue Growth %", "Orders", "Units Sold", "Contribution %", "Health Score", "Status", "", ""]);
    const scored = categoriesInOrder.map((cat) => ({ cat, ...scoreCategory(cat) }));
    scored.forEach((s) => {
      overviewDataRows.push(sAoA.length);
      sAoA.push([
        s.cat, s.thisRev, s.lastRev > 0 ? s.growth : "", s.orders, s.units,
        totalThisRev > 0 ? s.thisRev / totalThisRev : 0, `${s.score}/100`, s.status, "", "",
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
    ];
    wsSummary["!cols"] = [
      { wch: 45 }, { wch: 16 }, { wch: 11 }, { wch: 12 }, { wch: 13 }, { wch: 12 }, { wch: 13 }, { wch: 14 }, { wch: 10 }, { wch: 50 },
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

    // Overview rows: Revenue(1) Growth%(2) Orders(3) Units(4) Contribution%(5) Score(6) Status(7)
    overviewDataRows.forEach((r) => {
      setStyle(r, 0, { font: { bold: true, color: { rgb: "111827" } } });
      plain(r, 1, "#,##0.00");
      signed(r, 2);
      plain(r, 3, "#,##0");
      plain(r, 4, "#,##0");
      const share = wsSummary[XLSX.utils.encode_cell({ r, c: 5 })];
      if (share && typeof share.v === "number") share.s = { numFmt: "0.0%", font: { color: { rgb: "1F2937" } }, alignment: { horizontal: "center" } };
      const scoreCell = wsSummary[XLSX.utils.encode_cell({ r, c: 6 })];
      const statusCell = wsSummary[XLSX.utils.encode_cell({ r, c: 7 })];
      const label = String(statusCell?.v || "");
      const tone = label.includes("Excellent") ? "047857" : label.includes("Stable") ? "B45309" : "B91C1C";
      if (scoreCell) scoreCell.s = { font: { bold: true, color: { rgb: tone } }, alignment: { horizontal: "center" } };
      if (statusCell) statusCell.s = { font: { bold: true, color: { rgb: tone } }, alignment: { horizontal: "center" } };
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
    catAoa.push(totalRow);

    const wsCat = XLSX.utils.aoa_to_sheet(catAoa);
    const catTotalCols = 1 + periods.length * CAT_COLS_PER_PERIOD + 3;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const catMerges: any[] = [{ s: { r: 0, c: 0 }, e: { r: 1, c: 0 } }];
    periods.forEach((_, i) => {
      const c0 = 1 + i * CAT_COLS_PER_PERIOD;
      catMerges.push({ s: { r: 0, c: c0 }, e: { r: 0, c: c0 + CAT_COLS_PER_PERIOD - 1 } });
    });
    const totalsC0 = 1 + periods.length * CAT_COLS_PER_PERIOD;
    catMerges.push({ s: { r: 0, c: totalsC0 }, e: { r: 0, c: totalsC0 + 2 } });
    wsCat["!merges"] = catMerges;
    if (catHeader1[totalsC0] === "") wsCat[XLSX.utils.encode_cell({ r: 0, c: totalsC0 })] = { t: "s", v: "Totals" };

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
        }
        cell.s = style;
      }
    }

    const catCols = [{ wch: 24 }];
    periods.forEach(() => { catCols.push({ wch: 13 }, { wch: 9 }, { wch: 10 }); });
    catCols.push({ wch: 13 }, { wch: 11 }, { wch: 9 });
    wsCat["!cols"] = catCols;
    wsCat["!views"] = [{ state: "frozen", xSplit: 1, ySplit: 2 }];

    XLSX.utils.book_append_sheet(wb, wsCat, "Category Breakdown");
  }

  XLSX.utils.book_append_sheet(wb, ws, "Amazon Sales");

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
