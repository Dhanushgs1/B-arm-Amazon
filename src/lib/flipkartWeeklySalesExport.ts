import * as XLSX from "xlsx-js-style";
import { fetchAllRows } from "@/lib/amazonReportShared";
import { fetchMisFkOrders, fetchMisFkReturns } from "@/lib/misAdapters";
import { categorizeTitle, resolveProductName, CATEGORY_COLORS } from "@/lib/categoryMap";
import { fetchMasterSkuidMap, buildMasterSkuidResolver, gstMultiplierFromTax } from "@/lib/masterProductSkuid";
import { fetchProductMarketingMap, buildProductMarketingResolver } from "@/lib/productMarketingUpload";

// Flipkart's SKU-wise weekly report: last week vs this week, one row per SKU.
//
// Built from the FOUR Flipkart exports that are actually uploaded — Order
// report, Returns report, Listings snapshot and FSN (ad) report — and
// deliberately NOT from Earn More. That matters, because it changes what the
// revenue column can honestly claim:
//
//   Flipkart's order export carries NO monetary columns at all. There is no
//   per-order price, no line total, nothing. Only Earn More has real money on
//   it. So "Sales (Price x Orders)" here is a COMPUTED figure: the listing
//   price multiplied by units ordered. It is named that way in the header, on
//   purpose — calling it "Total Sales" would read as realised revenue, and it
//   isn't. It ignores per-order discounts, offers and settlement deductions,
//   so it runs high against what actually landed in the bank.
//
//   The same Price x units basis is what the Flipkart Analysis report already
//   uses for acos, and what the seller's own workbook uses, so the two agree.
//
// Amazon's equivalent (weeklySalesExport.ts) CAN report true revenue because
// Amazon's Orders export carries item_price. Don't copy this file's approach
// there.

interface PeriodWindow {
  label: string;
  start: string;
  end: string;
}

interface PeriodStats {
  orders: number;
  returns: number;
  totalOrders: number;
  price: number;
  computedSales: number;
  adSpendTax: number;
}

interface ProductRow {
  sku: string;
  name: string;
  periods: Record<string, PeriodStats>;
  grandComputedSales: number;
}

const EXCLUDED_CATEGORIES = new Set(["Discontinued", "Other"]);

function fmtDot(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}
function weekLabel(start: string, end: string): string {
  return `${fmtDot(start)}-${fmtDot(end)}`;
}
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function buildFlipkartWeeklySalesWorkbook(opts: {
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

  // One fetch across the combined 2-week span; each period is a filter over it.
  // Listings is a current snapshot with no date column, so it is fetched whole.
  const [orderRows, returnRows, listingRows, fsnRows, masterSkuid, productMarketing] = await Promise.all([
    fetchMisFkOrders((q) => q.gte("order_date", lastWeek.start).lte("order_date", thisWeek.end)),
    fetchMisFkReturns((q) =>
      q.gte("return_requested_date", lastWeek.start).lte("return_requested_date", thisWeek.end)
    ).catch(() => []),
    fetchAllRows("barm_flipkart_listings", (q) => q).catch(() => []),
    fetchAllRows("barm_flipkart_fsn_report", (q) => q.gte("report_date", lastWeek.start).lte("report_date", thisWeek.end)).catch(
      () => []
    ),
    fetchMasterSkuidMap(),
    fetchProductMarketingMap(),
  ]);
  const { resolveName: resolveSkuidNameRaw } = buildMasterSkuidResolver(masterSkuid);
  const { resolveName: resolveMarketingName } = buildProductMarketingResolver(productMarketing);
  // master_product_marketing is the marketing team's freshest, most current master — checked
  // first; master_product_skuid only fills in a SKU it doesn't have.
  const resolveSkuidName = (sku: string, fallback: string) => resolveMarketingName(sku, resolveSkuidNameRaw(sku, fallback));

  if (!orderRows.length) {
    throw new Error(
      `No uploaded Flipkart Order report data in ${fmtDot(lastWeek.start)} to ${fmtDot(thisWeek.end)}. ` +
        `Upload the Order report for that period first, or pick an end date the uploaded data covers.`
    );
  }

  // How far the uploaded orders actually reach. If they stop before the end of
  // "this week", the current week is measured over fewer days than the one it
  // is compared against, and every Growth % reads catastrophically negative for
  // no reason other than missing data. That is worth shouting about: a -84%
  // that is really "we only uploaded 2 of 7 days" would otherwise be read as a
  // collapse in demand.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orderDates = (orderRows as any[]).map((r) => String(r.order_date || "").slice(0, 10)).filter(Boolean).sort();
  const dataThrough = orderDates.length ? orderDates[orderDates.length - 1] : null;
  const staleDays = dataThrough
    ? Math.max(0, Math.round((Date.parse(`${thisWeek.end}T00:00:00Z`) - Date.parse(`${dataThrough}T00:00:00Z`)) / 86_400_000))
    : 0;

  // ── Listings snapshot: price, stock and the cleanest product title we have ──
  const priceBySku = new Map<string, number>();
  const stockBySku = new Map<string, number>();
  const nameBySku = new Map<string, string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (listingRows as any[]).forEach((r) => {
    const sku = String(r.seller_sku_id || "").trim();
    if (!sku) return;
    const price = num(r.selling_price);
    if (price > 0 && !priceBySku.has(sku)) priceBySku.set(sku, price);
    if (!stockBySku.has(sku)) stockBySku.set(sku, num(r.stock_count));
    if (r.product_title && !nameBySku.has(sku)) nameBySku.set(sku, String(r.product_title));
  });
  const hasListings = priceBySku.size > 0;

  // Order report titles fill in for SKUs the listings snapshot doesn't cover.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (orderRows as any[]).forEach((r) => {
    const sku = String(r.sku || "").trim();
    if (sku && r.product_title && !nameBySku.has(sku)) nameBySku.set(sku, String(r.product_title));
  });

  const statsBySkuPeriod = new Map<string, Map<string, { orders: number; returns: number; adSpendTax: number }>>();
  const ensureStat = (sku: string, label: string) => {
    let m = statsBySkuPeriod.get(sku);
    if (!m) { m = new Map(); statsBySkuPeriod.set(sku, m); }
    let s = m.get(label);
    if (!s) { s = { orders: 0, returns: 0, adSpendTax: 0 }; m.set(label, s); }
    return s;
  };

  // Orders — units, not order records, and cancelled lines excluded: a
  // cancelled order never sold, so counting it would inflate both Orders and
  // the computed sales figure. Same rule as the Flipkart Analysis report.
  const hasReturnsReport = returnRows.length > 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (orderRows as any[]).forEach((r) => {
    const sku = String(r.sku || "").trim();
    if (!sku || !r.order_date) return;
    const pd = periodForDate(String(r.order_date).slice(0, 10));
    if (!pd) return;
    const status = String(r.order_item_status || "").toUpperCase();
    if (status.startsWith("CANCEL")) return;
    const s = ensureStat(sku, pd.label);
    s.orders += num(r.quantity);
    // Without a Returns report the order report's own RETURNED status is the
    // only return signal there is; with one, returns come from it instead so
    // the same physical return isn't counted twice.
    if (!hasReturnsReport && status === "RETURNED") s.returns += num(r.quantity);
  });

  if (hasReturnsReport) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (returnRows as any[]).forEach((r) => {
      const sku = String(r.sku || "").trim();
      if (!sku || !r.return_requested_date) return;
      const pd = periodForDate(String(r.return_requested_date).slice(0, 10));
      if (!pd) return;
      ensureStat(sku, pd.label).returns += num(r.quantity);
    });
  }

  // Ad spend per SKU per week, from the FSN report. Spend+Tax applies that
  // SKU's own GST rate from the product master (18% used when a SKU has none
  // on file) — most products are actually 5%, not the flat 18% this used to
  // apply to everyone.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fsnRows as any[]).forEach((r) => {
    const sku = String(r.sku_id || "").trim();
    if (!sku || !r.report_date) return;
    const pd = periodForDate(String(r.report_date).slice(0, 10));
    if (!pd) return;
    ensureStat(sku, pd.label).adSpendTax += num(r.ad_spend) * gstMultiplierFromTax();
  });
  // Clicks per SKU per week, from the same FSN report — used only by the Growth
  // Summary/CEO Decision Center "Campaign Performance" diagnosis (Executive
  // Dashboard/Category Breakdown/Flipkart Sales don't need it), kept in a
  // separate map rather than widening PeriodStats since nothing else reads it.
  const clicksBySkuPeriod = new Map<string, Map<string, number>>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fsnRows as any[]).forEach((r) => {
    const sku = String(r.sku_id || "").trim();
    if (!sku || !r.report_date) return;
    const pd = periodForDate(String(r.report_date).slice(0, 10));
    if (!pd) return;
    let m = clicksBySkuPeriod.get(sku);
    if (!m) { m = new Map(); clicksBySkuPeriod.set(sku, m); }
    m.set(pd.label, (m.get(pd.label) || 0) + num(r.clicks));
  });
  const clicksOf = (sku: string, label: string) => clicksBySkuPeriod.get(sku)?.get(label) || 0;
  const hasAdData = fsnRows.length > 0;

  const products = new Map<string, ProductRow>();
  statsBySkuPeriod.forEach((periodMap, sku) => {
    const rawName = nameBySku.get(sku) || sku;
    // master_product_skuid's curated name wins over both the categoryMap.ts
    // hardcoded fallback and the raw listing/order title — same priority
    // every other report gives it (see masterProductSkuid.ts's header comment).
    const p: ProductRow = {
      sku,
      name: resolveSkuidName(sku, resolveProductName(rawName, sku) || rawName),
      periods: {},
      grandComputedSales: 0,
    };
    const price = priceBySku.get(sku) || 0;
    periods.forEach((pd) => {
      const raw = periodMap.get(pd.label);
      if (!raw) return;
      const totalOrders = Math.max(0, raw.orders - raw.returns);
      const computedSales = price * raw.orders;
      p.periods[pd.label] = {
        orders: raw.orders,
        returns: raw.returns,
        totalOrders,
        price,
        computedSales,
        adSpendTax: raw.adSpendTax,
      };
      p.grandComputedSales += computedSales;
    });
    products.set(sku, p);
  });

  const rows = [...products.values()].sort((a, b) => b.grandComputedSales - a.grandComputedSales);

  const catBySku = new Map<string, string>();
  const categoryRank = new Map<string, number>();
  {
    const catSales = new Map<string, number>();
    rows.forEach((p) => {
      const cat = categorizeTitle(p.name, undefined, p.sku);
      catBySku.set(p.sku, cat);
      catSales.set(cat, (catSales.get(cat) || 0) + p.grandComputedSales);
    });
    [...catSales.entries()].sort((a, b) => b[1] - a[1]).forEach(([name], i) => categoryRank.set(name, i));
  }

  const visibleRows = rows.filter((p) => !EXCLUDED_CATEGORIES.has(catBySku.get(p.sku) || "Other"));
  const rowsByCategory = [...visibleRows].sort((a, b) => {
    const ra = categoryRank.get(catBySku.get(a.sku) || "") ?? 999;
    const rb = categoryRank.get(catBySku.get(b.sku) || "") ?? 999;
    if (ra !== rb) return ra - rb;
    return b.grandComputedSales - a.grandComputedSales;
  });

  // ═══════════════════════════════════════════════════════════════════════
  // ── Category aggregation — same per-product per-period data, grouped by department.
  //    Feeds the "Category Breakdown" sheet below. Mirrors weeklySalesExport.ts's
  //    categoryAgg (Amazon), reading Flipkart's computedSales instead of totalSales.
  // ═══════════════════════════════════════════════════════════════════════
  const categoryAgg = new Map<string, { periods: Record<string, { sales: number; units: number }>; grandSales: number; grandUnits: number }>();
  visibleRows.forEach((p) => {
    const cat = catBySku.get(p.sku) || "Other";
    let c = categoryAgg.get(cat);
    if (!c) { c = { periods: {}, grandSales: 0, grandUnits: 0 }; categoryAgg.set(cat, c); }
    periods.forEach((pd) => {
      const stat = p.periods[pd.label];
      if (!stat) return;
      const cur = c!.periods[pd.label] || { sales: 0, units: 0 };
      cur.sales += stat.computedSales;
      cur.units += stat.orders;
      c!.periods[pd.label] = cur;
      c!.grandSales += stat.computedSales;
      c!.grandUnits += stat.orders;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // ── Shared per-SKU/category deltas — computed once here (not inside any one
  // sheet's block) so Growth Summary, Category Breakdown, Executive Dashboard and
  // CEO Decision Center all read the exact same numbers. Ported from
  // weeklySalesExport.ts's identical block (Amazon); "sales" here is the same
  // COMPUTED price×orders figure as the "Flipkart Sales" sheet — never real
  // settled revenue — so every label below says "Sales", never "Revenue".
  // ═══════════════════════════════════════════════════════════════════════
  const lastLabel = periods[0].label;
  const thisLabel = periods[1].label;

  type Delta = {
    name: string; sku: string; price: number;
    lastUnits: number; lastSales: number; thisUnits: number; thisSales: number;
    delta: number; pct: number; reason: string; category: string;
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
      const lastSales = last?.computedSales || 0;
      const prevSales = prev?.computedSales || 0;
      if (lastSales === 0 && prevSales === 0) return null;
      const delta = lastSales - prevSales;
      const pct = prevSales !== 0 ? delta / prevSales : lastSales > 0 ? 1 : 0;
      const stock = stockBySku.has(p.sku) ? stockBySku.get(p.sku) || 0 : undefined;
      const returnsJump = (last?.returns || 0) - (prev?.returns || 0);

      const lastUnits = prev?.orders || 0;
      const thisUnits = last?.orders || 0;
      const lastPrice = prev?.price || 0;
      const thisPrice = last?.price || 0;
      const unitPct = lastUnits > 0 ? (thisUnits - lastUnits) / lastUnits : null;
      const pricePct = lastUnits > 0 && thisUnits > 0 && lastPrice > 0 ? (thisPrice - lastPrice) / lastPrice : null;
      const move = (v: number) => (Math.abs(v) < 0.03 ? "flat" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(0)}%`);
      const driver =
        unitPct === null ? "" : pricePct === null ? `Units ${move(unitPct)}` : `Units ${move(unitPct)}, price ${move(pricePct)}`;

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
      return {
        name: p.name, sku: p.sku, price,
        lastUnits: prev?.orders || 0, lastSales: prevSales,
        thisUnits: last?.orders || 0, thisSales: lastSales,
        delta, pct, reason, category: catBySku.get(p.sku) || "Other",
        lastOrders: prev?.totalOrders || 0, thisOrders: last?.totalOrders || 0,
        lastPrice, thisPrice,
        stock, returnsJump, thisReturns: last?.returns || 0,
        lastSpend: prev?.adSpendTax || 0, thisSpend: last?.adSpendTax || 0,
        lastClicks: clicksOf(p.sku, lastLabel), thisClicks: clicksOf(p.sku, thisLabel),
      };
    })
    .filter((d): d is Delta => d !== null);

  const categoriesInOrder = [...categoryAgg.entries()]
    .filter(([name]) => !EXCLUDED_CATEGORIES.has(name))
    .sort((a, b) => b[1].grandSales - a[1].grandSales)
    .map(([name]) => name)
    .filter((name) => deltas.some((d) => d.category === name));

  type Diagnosis = { reason: string; action: string; impact: number };

  // Candidate explanations for one product's decline, ranked by the sales they
  // plausibly account for. Ported verbatim from weeklySalesExport.ts (Amazon) —
  // the function is marketplace-agnostic, operating only on generic Delta fields.
  const diagnose = (d: Delta): Diagnosis[] => {
    const out: Diagnosis[] = [];
    const bothSold = d.lastUnits > 0 && d.thisUnits > 0;
    const priceLoss = bothSold ? d.thisUnits * Math.max(0, d.lastPrice - d.thisPrice) : 0;
    const volumeLoss = d.lastPrice > 0 ? Math.max(0, d.lastUnits - d.thisUnits) * d.lastPrice : 0;
    const pricePct = bothSold && d.lastPrice > 0 ? d.thisPrice / d.lastPrice - 1 : 0;
    const units = (n: number) => `${n} unit${n === 1 ? "" : "s"}`;

    if (priceLoss > 0 && pricePct <= -0.05) {
      out.push({
        reason: `Price Drop — listing price ${(pricePct * 100).toFixed(0)}% (₹${Math.round(d.lastPrice)} → ₹${Math.round(d.thisPrice)})`,
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
    if (d.thisSales === 0 && d.lastSales > 0 && (d.stock === undefined || d.stock >= 15)) {
      out.push({
        reason: "Listing Issue — no sales at all this week while stock was available",
        action: `Check ${d.name}'s listing status and search visibility`,
        impact: d.lastSales,
      });
    }
    if (out.length === 0 && volumeLoss > 0) {
      const steady = d.stock === undefined ? "price steady, stock not tracked" : "price and stock steady";
      out.push({
        reason: `Demand Softness — units ${d.lastUnits} → ${d.thisUnits} with ${steady}`,
        action: `Review traffic and conversion for ${d.name} — no supply-side cause found`,
        impact: volumeLoss,
      });
    }
    return out.sort((a, b) => b.impact - a.impact);
  };

  // Health score, 0–100 — identical weighting/thresholds to weeklySalesExport.ts (Amazon):
  //   Sales growth 40 — flat scores 20; +20% or better 40; −20% or worse 0
  //   Growing share  20 — share of the category's products whose sales grew
  //   Returns rate   20 — 0% scores 20; 10% or worse scores 0
  //   Stock cover    20 — share of category sales from products not flagged low stock
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const scoreCategory = (cat: string) => {
    const ds = deltas.filter((d) => d.category === cat);
    const thisRev = ds.reduce((a, d) => a + d.thisSales, 0);
    const lastRev = ds.reduce((a, d) => a + d.lastSales, 0);
    const growth = lastRev > 0 ? thisRev / lastRev - 1 : 0;
    const units = ds.reduce((a, d) => a + d.thisUnits, 0);
    // No distinct-order-id tracking in Flipkart's data (unlike Amazon) — "orders" here is
    // the sum of each SKU's own Total Orders, same basis the "Flipkart Sales" sheet uses.
    const orders = ds.reduce((a, d) => a + d.thisOrders, 0);
    const returns = ds.reduce((a, d) => a + d.thisReturns, 0);

    const growthPts = 40 * clamp01((growth + 0.2) / 0.4);
    const growers = ds.filter((d) => d.delta > 0).length;
    const breadthPts = ds.length > 0 ? 20 * (growers / ds.length) : 10;
    const returnRate = units > 0 ? returns / units : 0;
    const returnPts = 20 * clamp01(1 - returnRate / 0.1);
    const known = ds.filter((d) => d.stock !== undefined);
    const healthyRev = known.filter((d) => (d.stock as number) >= 15).reduce((a, d) => a + d.thisSales, 0);
    const knownRev = known.reduce((a, d) => a + d.thisSales, 0);
    const stockPts = knownRev > 0 ? 20 * (healthyRev / knownRev) : 10;

    const score = Math.round(growthPts + breadthPts + returnPts + stockPts);
    const status = score >= 75 ? "🟢 Excellent" : score >= 50 ? "🟡 Stable" : "🔴 Needs Attention";
    return { thisRev, lastRev, growth, units, orders, score, status };
  };

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
  // ── Shared whole-business metrics/helpers — used by every sheet below. Ported
  // from weeklySalesExport.ts (Amazon); "Rev"/"Sales" variable names below are
  // internal only — every user-visible label built from them says "Sales", not
  // "Revenue" (see the file header comment on why).
  // ═══════════════════════════════════════════════════════════════════════
  const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
  const pctStr = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;
  const arrow = (v: number) => (v > 0.02 ? "▲" : v < -0.02 ? "▼" : "▬");
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
  const totalThisOrders = deltas.reduce((a, d) => a + d.thisOrders, 0);
  const totalLastOrders = deltas.reduce((a, d) => a + d.lastOrders, 0);
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
  const weeklyPerformanceScore = Math.round(100 * clamp01((overallGrowth + 0.3) / 0.6));
  const growingCatsCount = scoredCats.filter((s) => s.growth > 0).length;
  const decliningCatsCount = scoredCats.filter((s) => s.growth < 0).length;
  const growthConsistency = scoredCats.length > 0 ? Math.max(growingCatsCount, decliningCatsCount) / scoredCats.length : 0;
  const growthConfidencePct = Math.round(30 + growthConsistency * 40);
  const SALES_CAVEAT =
    "\"Sales\" below = current listing price × units ordered (computed), not settled revenue — see the Notes sheet for why.";

  // ═══════════════════════════════════════════════════════════════════════
  // "Flipkart Sales" sheet — Product / SKU / Category, then 7 columns per week.
  // ═══════════════════════════════════════════════════════════════════════
  const COLS_PER_PERIOD = 7;
  const LEAD_COLS = 3;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const headerRow1: any[] = ["Product", "SKU", "Category"];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const headerRow2: any[] = ["", "", ""];
  periods.forEach(() => {
    headerRow1.push(...Array(COLS_PER_PERIOD).fill(""));
    headerRow2.push("Orders", "Returns", "Total Orders", "Price", "Sales (Price x Orders)", "Ad Spend+Tax", "Growth %");
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
    let prevSales: number | null = null;
    periods.forEach((pd) => {
      const stat = p.periods[pd.label];
      const orders = stat?.orders || 0;
      const returns = stat?.returns || 0;
      const totalOrders = stat?.totalOrders || 0;
      const price = stat?.price || 0;
      const sales = stat?.computedSales || 0;
      const adSpendTax = stat?.adSpendTax || 0;
      const growth = prevSales !== null && prevSales !== 0 ? (sales - prevSales) / prevSales : "";
      rowData.push(orders, returns, totalOrders, price, sales, adSpendTax, growth);
      prevSales = sales;
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
        fill: { fgColor: { rgb: r === 0 ? "0F4C81" : "1D6FA5" } },
        alignment: { horizontal: "center", vertical: "center", wrapText: true },
        border: { bottom: { style: "medium", color: { rgb: "0B3A63" } } },
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
          ...(isGroupStart ? { top: { style: "medium", color: { rgb: "BFDBFE" } } } : {}),
        },
      };

      if (c === 0) {
        style.font = { color: { rgb: "111827" }, bold: true };
      } else if (c === 1) {
        style.font = { color: { rgb: "1D4ED8" }, bold: true };
      } else if (c === 2) {
        const catColor = CATEGORY_COLORS[String(cell.v)] || CATEGORY_COLORS.Other;
        style.font = { color: { rgb: catColor.replace("#", "") }, bold: true };
      } else {
        const pos = (c - LEAD_COLS) % COLS_PER_PERIOD;
        if (pos === 3 || pos === 5) style.numFmt = "#,##0.00";       // Price, Ad Spend+Tax
        else if (pos === 4) {                                         // Sales (Price x Orders)
          style.numFmt = "#,##0.00";
          style.font = { color: { rgb: "059669" }, bold: true };
        } else if (pos === 6 && typeof cell.v === "number") {         // Growth %
          style.numFmt = "0.0%";
          if (cell.v > 0) style.font = { color: { rgb: "047857" }, bold: true };
          else if (cell.v < 0) style.font = { color: { rgb: "B91C1C" }, bold: true };
        } else {
          style.numFmt = "#,##0";
        }
      }
      cell.s = style;
    }
  }

  const wscols = [{ wch: 42 }, { wch: 22 }, { wch: 20 }];
  periods.forEach(() => {
    wscols.push({ wch: 9 }, { wch: 9 }, { wch: 12 }, { wch: 10 }, { wch: 20 }, { wch: 13 }, { wch: 10 });
  });
  ws["!cols"] = wscols;
  ws["!views"] = [{ state: "frozen", xSplit: 3, ySplit: 2 }];

  const wb = XLSX.utils.book_new();

  // ═══════════════════════════════════════════════════════════════════════
  // ── Growth Summary — always compares the two periods directly (last week vs this week).
  //    Ported from weeklySalesExport.ts's identical sheet (Amazon); every "Revenue" label
  //    there is "Sales" here, since Flipkart's figure is computed, not realised — see
  //    SALES_CAVEAT above and the Notes sheet.
  // ═══════════════════════════════════════════════════════════════════════
  {
    const TOP_N = 5;
    const SUMMARY_COLS = 10;
    const blankRow = () => Array(SUMMARY_COLS).fill("");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sAoA: any[][] = [
      [`Growth Summary — ${lastLabel} vs ${thisLabel}`, ...Array(SUMMARY_COLS - 1).fill("")],
      [SALES_CAVEAT, ...Array(SUMMARY_COLS - 1).fill("")],
      [],
    ];
    const caveatRow = 1;
    const catHeaderRows: { row: number; color: string }[] = [];
    const lossHeaderRows: number[] = [];
    const gainHeaderRows: number[] = [];
    const colHeader = (label: string) => [
      label, "SKU", "Price", "Last Wk Units", "Last Wk Sales", "This Wk Units", "This Wk Sales", "Δ Sales", "Δ %",
      "Possible Reason (add your own note if blank)",
    ];

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
      { label: "Sales Growth %", value: `${arrow(overallGrowth)} ${pctStr(overallGrowth)}`, tone: overallGrowth >= 0 ? "good" : "bad" },
      { label: "Sales Difference", value: `${totalThisRev - totalLastRev >= 0 ? "+" : ""}${inr(totalThisRev - totalLastRev)}`, tone: totalThisRev >= totalLastRev ? "good" : "bad" },
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
      { label: "Sales Concentration % (Top 5)", value: barOf(revenueConcentrationPct) },
      { label: "Sales at Risk %", value: barOf(revenueAtRiskPct), tone: revenueAtRiskPct >= 0.3 ? "bad" : revenueAtRiskPct >= 0.15 ? "neutral" : "good" },
    ]);
    sAoA.push(blankRow());

    pushKpiSection("AI WEEKLY GROWTH SUMMARY");
    [
      `Sales ${overallGrowth >= 0 ? "increased" : "decreased"} by ${Math.abs(overallGrowth * 100).toFixed(1)}% compared to last week (${inr(totalLastRev)} → ${inr(totalThisRev)}).`,
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
      { label: "Sales", v: overallGrowth },
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
    if (revenueAtRiskPct >= 0.15) kpiRisks.push(`${(revenueAtRiskPct * 100).toFixed(0)}% of this week's sales come from declining products.`);
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

    const insightRows = { title: [] as number[], header: [] as number[], banner: [] as { row: number; color: string }[], good: [] as number[], bad: [] as number[], rec: [] as number[], legend: [] as number[] };
    const insightsFrom = sAoA.length;
    const overviewDataRows: number[] = [];

    sAoA.push(blankRow());
    insightRows.title.push(sAoA.length);
    sAoA.push(["CATEGORY INSIGHTS", ...Array(SUMMARY_COLS - 1).fill("")]);
    sAoA.push(blankRow());

    insightRows.header.push(sAoA.length);
    sAoA.push(["Category", "Sales (This Wk)", "Sales (Last Wk)", "Sales Growth %", "Orders", "Units Sold", "Contribution %", "Health Score", "Status", "Reason for Change"]);
    const scored = categoriesInOrder.map((cat) => ({ cat, ...scoreCategory(cat) }));
    scored.forEach((s) => {
      overviewDataRows.push(sAoA.length);
      sAoA.push([
        s.cat, s.thisRev, s.lastRev, s.lastRev > 0 ? s.growth : "", s.orders, s.units,
        totalThisRev > 0 ? s.thisRev / totalThisRev : 0, `${s.score}/100`, s.status, changeReason(s.cat, s),
      ]);
    });
    sAoA.push(blankRow());

    scored.forEach((s) => {
      const ds = deltas.filter((d) => d.category === s.cat);
      if (ds.length === 0) return;
      const best = [...ds].sort((a, b) => b.delta - a.delta)[0];
      const worst = [...ds].sort((a, b) => a.delta - b.delta)[0];

      insightRows.banner.push({ row: sAoA.length, color: CATEGORY_COLORS[s.cat] || CATEGORY_COLORS.Other });
      sAoA.push([`${s.cat} — ${s.status}  ·  Health ${s.score}/100`, ...Array(SUMMARY_COLS - 1).fill("")]);

      insightRows.header.push(sAoA.length);
      sAoA.push(["Focus", "Product", "Sales", "Sales Δ %", "Units Sold", "Orders", "Orders Δ %", "AI Possible Reason", "Recommended Action", ""]);

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
      "How to read this: Health Score = sales growth (40) + share of products growing (20) + returns rate (20) + stock cover (20). 🟢 75+ Excellent · 🟡 50–74 Stable · 🔴 under 50 Needs Attention. Reasons are ranked by the sales each explains, and are only shown when the data supports them.",
      ...Array(SUMMARY_COLS - 1).fill(""),
    ]);

    const wsSummary = XLSX.utils.aoa_to_sheet(sAoA);
    wsSummary["!merges"] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: SUMMARY_COLS - 1 } },
      { s: { r: caveatRow, c: 0 }, e: { r: caveatRow, c: SUMMARY_COLS - 1 } },
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
    const caveatCell = wsSummary[XLSX.utils.encode_cell({ r: caveatRow, c: 0 })];
    if (caveatCell) caveatCell.s = { font: { italic: true, sz: 10, color: { rgb: "92400E" } }, fill: { fgColor: { rgb: "FEF3C7" } }, alignment: { horizontal: "center" } };

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
      const priceAddr = XLSX.utils.encode_cell({ r, c: 2 });
      if (wsSummary[priceAddr] && typeof wsSummary[priceAddr].v === "number") {
        wsSummary[priceAddr].s = { numFmt: "#,##0.00", font: { color: { rgb: "1F2937" } } };
      }
      for (const c of [3, 5]) {
        const addr = XLSX.utils.encode_cell({ r, c });
        if (wsSummary[addr] && typeof wsSummary[addr].v === "number") {
          wsSummary[addr].s = { numFmt: "#,##0", font: { color: { rgb: "1F2937" } } };
        }
      }
      for (const c of [4, 6]) {
        const addr = XLSX.utils.encode_cell({ r, c });
        if (wsSummary[addr] && typeof wsSummary[addr].v === "number") {
          wsSummary[addr].s = { numFmt: "#,##0.00", font: { color: { rgb: "1F2937" } } };
        }
      }
      for (let c = 7; c <= 8; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = wsSummary[addr];
        if (!cell || typeof cell.v !== "number") continue;
        cell.s = { numFmt: c === 7 ? "#,##0.00" : "0.0%", font: { color: { rgb: cell.v < 0 ? "B91C1C" : "047857" }, bold: true } };
      }
    }

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
  // ── Category Breakdown sheet — ported near-verbatim from weeklySalesExport.ts
  //    (Amazon); already used "Sales"/"Units" wording, not "Revenue", so no
  //    label changes were needed here.
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
          fill: { fgColor: { rgb: r === 0 ? "0F4C81" : "1D6FA5" } },
          alignment: { horizontal: "center", vertical: "center" },
          border: { bottom: { style: "medium", color: { rgb: "0B3A63" } } },
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
          border: { bottom: { style: isTotalRow ? "medium" : "thin", color: { rgb: isTotalRow ? "0B3A63" : "E5E7EB" } } },
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
          if (posInTotals === 3) { style.numFmt = "#,##0.00"; style.font = { color: { rgb: "059669" }, bold: true }; }
        }
        cell.s = style;
      }
    }

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

  XLSX.utils.book_append_sheet(wb, ws, "Flipkart Sales");

  // ═══════════════════════════════════════════════════════════════════════
  // ── Executive Dashboard — ported from weeklySalesExport.ts (Amazon), "Revenue"
  //    labels renamed to "Sales" throughout.
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
    pushWideText(SALES_CAVEAT);
    pushBlank();
    pushSection("KEY PERFORMANCE INDICATORS");

    pushKpiRow([
      { label: "Total Sales (This Wk)", value: inr(totalThisRev) },
      { label: "Total Sales (Last Wk)", value: inr(totalLastRev) },
      { label: "Sales Growth %", value: `${arrow(overallGrowth)} ${pctStr(overallGrowth)}`, tone: overallGrowth >= 0 ? "good" : "bad" },
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
      { label: "Highest Sales Category", value: highestRevCategory ? `${highestRevCategory.cat} (${inr(highestRevCategory.thisRev)})` : "—" },
      { label: "Lowest Sales Category", value: lowestRevCategory ? `${lowestRevCategory.cat} (${inr(lowestRevCategory.thisRev)})` : "—" },
      { label: "Business Health Score", value: `${businessHealthScore}/100 — ${healthBand(businessHealthScore).label}`, tone: businessHealthScore >= 65 ? "good" : businessHealthScore >= 50 ? "neutral" : "bad" },
    ]);
    pushBlank();
    pushKpiRow([
      { label: "Sales Concentration % (Top 5)", value: barOf(revenueConcentrationPct) },
      { label: "Sales at Risk %", value: barOf(revenueAtRiskPct), tone: revenueAtRiskPct >= 0.3 ? "bad" : revenueAtRiskPct >= 0.15 ? "neutral" : "good" },
      { label: "Weekly Performance Score", value: `${weeklyPerformanceScore}/100 — ${healthBand(weeklyPerformanceScore).label}`, tone: weeklyPerformanceScore >= 65 ? "good" : weeklyPerformanceScore >= 50 ? "neutral" : "bad" },
    ]);
    pushBlank();

    pushSection("EXECUTIVE AI SUMMARY");
    const summaryLines = [
      `Sales ${overallGrowth >= 0 ? "increased" : "decreased"} by ${Math.abs(overallGrowth * 100).toFixed(1)}% compared to last week (${inr(totalLastRev)} → ${inr(totalThisRev)}).`,
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

    pushSection("TOP BUSINESS HIGHLIGHTS");
    (growers.length ? growers.slice(0, 3) : [null]).forEach((d) =>
      pushWideText(d ? `📈 ${d.name} grew ${pctStr(d.pct)} (${inr(d.lastSales)} → ${inr(d.thisSales)})` : "No product grew this week.")
    );
    pushBlank();

    pushSection("TOP OPPORTUNITIES");
    const opportunities: string[] = [];
    if (revenueConcentrationPct >= 0.5) {
      opportunities.push(`Top 5 products carry ${(revenueConcentrationPct * 100).toFixed(0)}% of sales — developing mid-tier SKUs would reduce concentration risk and unlock incremental growth.`);
    }
    scoredCats.filter((s) => s.growth > 0.1).forEach((s) => opportunities.push(`Scale advertising/inventory in ${s.cat} — growing ${pctStr(s.growth)} this week.`));
    if (opportunities.length === 0) opportunities.push("No standout opportunity signal this week beyond the highlighted top performers above.");
    opportunities.slice(0, 5).forEach((o) => pushWideText(`💡 ${o}`));
    pushBlank();

    pushSection("TOP RISKS");
    const risks: string[] = [];
    if (revenueAtRiskPct >= 0.15) risks.push(`${(revenueAtRiskPct * 100).toFixed(0)}% of this week's sales come from products currently declining.`);
    scoredCats.filter((s) => s.score < 50).forEach((s) => risks.push(`${s.cat} is in a ${healthBand(s.score).label} health band (${s.score}/100).`));
    if (risks.length === 0) risks.push("No category or concentration risk crossed this report's warning thresholds this week.");
    risks.slice(0, 5).forEach((r) => pushWideText(`⚠️ ${r}`));
    pushBlank();

    pushSection("SALES CONTRIBUTION — TOP 10 PRODUCTS");
    const top10HeaderRow = exAoA.length;
    exAoA.push(["Rank", "Product", "SKU", "Sales (This Wk)", "Growth %", "Share %"]);
    const top10DataRows: number[] = [];
    bySalesDesc.slice(0, 10).forEach((d, i) => {
      top10DataRows.push(exAoA.length);
      exAoA.push([i + 1, d.name, d.sku, d.thisSales, d.lastSales > 0 ? d.pct : "", totalThisRev > 0 ? d.thisSales / totalThisRev : 0]);
    });
    pushBlank();

    pushSection("CATEGORY CONTRIBUTION");
    const catHeaderRow = exAoA.length;
    exAoA.push(["Category", "Sales (This Wk)", "Growth %", "Contribution %", "Health Score", "Status"]);
    const catDataRows: number[] = [];
    catsBySalesDesc.forEach((s) => {
      catDataRows.push(exAoA.length);
      exAoA.push([s.cat, s.thisRev, s.lastRev > 0 ? s.growth : "", totalThisRev > 0 ? s.thisRev / totalThisRev : 0, `${s.score}/100`, s.status]);
    });
    pushBlank();

    pushSection("BUSINESS HEALTH GAUGE");
    const gaugeRow = exAoA.length;
    exMerges.push({ s: { r: gaugeRow, c: 0 }, e: { r: gaugeRow, c: EX_COLS - 1 } });
    exAoA.push([`${healthBand(businessHealthScore).label}  ·  ${businessHealthScore}/100  ·  ${barOf(businessHealthScore / 100, 20)}`, ...Array(EX_COLS - 1).fill("")]);
    pushBlank();

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
    if (revenueAtRiskPct >= 0.3) recommendations.push("Prioritise recovery actions on declining products — they represent a large share of current sales.");
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
      for (let c = 0; c < EX_COLS; c++) setExStyle(r, c, { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "0F4C81" } }, alignment: { horizontal: "center", vertical: "center", wrapText: true } });
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
  // ── CEO Decision Center — ported from weeklySalesExport.ts (Amazon), "Revenue"
  //    labels renamed to "Sales" throughout; advertising section checks Flipkart's
  //    own hasAdData (FSN report) instead of Amazon's Sponsored Products data.
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
    pushWideText(SALES_CAVEAT);
    pushBlank();

    pushSection("CEO INSIGHTS");
    [
      `Business generated ${inr(totalThisRev)} in sales this week, ${overallGrowth >= 0 ? "up" : "down"} ${pctStr(overallGrowth)} vs ${inr(totalLastRev)} last week.`,
      highestRevCategory ? `${highestRevCategory.cat} is the primary sales engine at ${inr(highestRevCategory.thisRev)} (${(totalThisRev > 0 ? (highestRevCategory.thisRev / totalThisRev) * 100 : 0).toFixed(0)}% of total).` : "No category data available.",
      `Top 5 products account for ${(revenueConcentrationPct * 100).toFixed(0)}% of sales — ${revenueConcentrationPct >= 0.5 ? "a concentration level worth actively managing" : "a reasonably diversified base"}.`,
      `Overall business health is ${healthBand(businessHealthScore).label} (${businessHealthScore}/100).`,
    ].forEach((l) => pushWideText(l));
    pushBlank();

    pushSection("BUSINESS OPPORTUNITIES");
    const ceoOpportunities: string[] = [];
    scoredCats.filter((s) => s.growth > 0.1).forEach((s) => ceoOpportunities.push(`Scale ${s.cat} — growing ${pctStr(s.growth)} with health score ${s.score}/100.`));
    if (revenueConcentrationPct < 0.35) ceoOpportunities.push("Sales are well-diversified across products — a healthy base to layer new SKU launches onto.");
    if (ceoOpportunities.length === 0) ceoOpportunities.push("No standout scale-up signal this week beyond the top performers already listed on the Executive Dashboard.");
    ceoOpportunities.slice(0, 5).forEach((o) => pushWideText(`💡 ${o}`));
    pushBlank();

    pushSection("BUSINESS RISKS");
    const ceoRisks: string[] = [];
    if (revenueAtRiskPct >= 0.15) ceoRisks.push(`${(revenueAtRiskPct * 100).toFixed(0)}% of sales sit in products that declined this week.`);
    scoredCats.filter((s) => s.score < 50).forEach((s) => ceoRisks.push(`${s.cat} — ${healthBand(s.score).label} (${s.score}/100).`));
    if (revenueConcentrationPct >= 0.5) ceoRisks.push(`Top 5 products carry ${(revenueConcentrationPct * 100).toFixed(0)}% of sales — losing any one of them would materially hurt total sales.`);
    if (ceoRisks.length === 0) ceoRisks.push("No category or concentration risk crossed this report's warning thresholds this week.");
    ceoRisks.slice(0, 5).forEach((r) => pushWideText(`⚠️ ${r}`));
    pushBlank();

    pushSection("SALES DEPENDENCY ANALYSIS");
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
      ["Products needed to reach 80% of sales", `${pareto80Count} of ${activeProducts} active products`],
    ].forEach(([label, value]) => ceoAoA.push([label, value, "", "", "", ""]));
    pushBlank();

    pushSection("TOP PRODUCTS DRIVING SALES");
    const driveHeaderRow = ceoAoA.length;
    ceoAoA.push(["Product", "SKU", "Sales (This Wk)", "Cumulative Share %", "", ""]);
    const driveDataRows: number[] = [];
    let cum = 0;
    bySalesDesc.slice(0, 8).forEach((d) => {
      cum += d.thisSales;
      driveDataRows.push(ceoAoA.length);
      ceoAoA.push([d.name, d.sku, d.thisSales, totalThisRev > 0 ? cum / totalThisRev : 0, "", ""]);
    });
    pushBlank();

    pushSection("PRODUCTS LOSING SALES");
    const loseHeaderRow = ceoAoA.length;
    ceoAoA.push(["Product", "SKU", "Sales Δ", "Possible Reason", "", ""]);
    const loseDataRows: number[] = [];
    decliners.slice(0, 8).forEach((d) => {
      const dx = diagnose(d);
      loseDataRows.push(ceoAoA.length);
      ceoAoA.push([d.name, d.sku, d.delta, dx[0]?.reason || "No clear supply-side signal found", "", ""]);
    });
    if (decliners.length === 0) ceoAoA.push(["No product declined this week", "", "", "", "", ""]);
    pushBlank();

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
      pushWideText("No FSN (ad) report uploaded for this window — advertising recommendations need that export to be generated.");
    } else {
      const adDrops = reasonsOfType("Campaign Performance");
      if (adDrops.length === 0) pushWideText("No product's decline this week was attributed to reduced ad spend.");
      adDrops.slice(0, 5).forEach(({ dx }) => pushWideText(`📣 ${dx[0].action} — lost ~${inr(dx[0].impact)} this week.`));
    }
    pushBlank();

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

    pushSection("NEXT WEEK FORECAST (NAIVE TREND — NOT A STATISTICAL MODEL)");
    const expectedRevenue = totalThisRev * (1 + overallGrowth);
    const expectedOrders = Math.round(totalThisOrders * (1 + ordersGrowthPct));
    const expectedUnits = Math.round(totalThisUnits * (1 + unitsGrowthPct));
    [
      ["Expected Sales", inr(expectedRevenue)],
      ["Expected Orders", expectedOrders.toLocaleString("en-IN")],
      ["Expected Units", expectedUnits.toLocaleString("en-IN")],
      ["Expected Growth %", pctStr(overallGrowth)],
      ["Confidence Score", `${growthConfidencePct}% (based on 2 weeks of data — treat as directional)`],
    ].forEach(([label, value]) => ceoAoA.push([label, value, "", "", "", ""]));
    pushBlank();

    pushSection("EXECUTIVE ACTION PLAN");
    const planHeaderRow = ceoAoA.length;
    ceoAoA.push(["Priority", "Action", "Product / Category", "Sales Impact", "", ""]);
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

    pushSection("EXECUTIVE CLOSING SUMMARY");
    pushWideText(
      `This week closed at ${inr(totalThisRev)}, ${overallGrowth >= 0 ? "up" : "down"} ${pctStr(overallGrowth)} vs last week, with overall business health rated ${healthBand(businessHealthScore).label}. ` +
        `${highestRevCategory ? `${highestRevCategory.cat} led performance` : "No clear category leader emerged"}${lowestRevCategory && lowestRevCategory.score < 50 ? `, while ${lowestRevCategory.cat} needs attention` : ""}. ` +
        `${actionRows.length > 0 ? `${actionRows.length} action item(s) are flagged below, ranked by sales impact.` : "No urgent action items were identified this week."}`
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
      for (let c = 0; c < CEO_COLS; c++) setCeoStyle(r, c, { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "0F4C81" } }, alignment: { horizontal: "center", vertical: "center", wrapText: true } });
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

  // ── Notes — states what each column is and, more importantly, what the sales
  //    figure is NOT, so nobody reconciles it against a settlement statement
  //    and concludes the report is wrong.
  const notes: string[][] = [
    ["Flipkart Weekly Sales Report (SKU-wise)"],
    [`Last week: ${fmtDot(lastWeek.start)} to ${fmtDot(lastWeek.end)}`],
    [`This week: ${fmtDot(thisWeek.start)} to ${fmtDot(thisWeek.end)}`],
    [""],
    ...(staleDays > 0
      ? [[`⚠ READ THIS FIRST — the uploaded Order report only reaches ${fmtDot(dataThrough!)}, but "this week" runs to ${fmtDot(thisWeek.end)}. So this week is measured over ${Math.max(0, 7 - staleDays)} day(s) of data against a full 7 for last week, and EVERY Growth % below is therefore far more negative than reality. This is missing data, not falling demand. Either upload the newer Order report, or set the dashboard end date to ${fmtDot(dataThrough!)} and regenerate.`]]
      : []),
    ["Built entirely from uploaded Flipkart exports — the live API is never called. Sources: Order report (Orders), Returns report (Returns), Listings snapshot (Price), FSN report (Ad Spend+Tax)."],
    ["'Sales (Price x Orders)' is COMPUTED, not realised revenue. Flipkart's order export carries no monetary columns at all, so there is no per-order price to sum — only the Earn More report has real money on it, and it is not used here. This column multiplies the CURRENT listing price by units ordered, so it ignores per-order discounts, offers and settlement deductions and will read HIGH against what actually landed in the bank. Use it for week-over-week direction, not for accounting."],
    ["Growth % compares this week's 'Sales (Price x Orders)' against last week's. It is blank for the first week, which has nothing to compare against."],
    ["Orders = SUM OF UNITS ordered (quantity), not the number of order records. CANCELLED lines are excluded: they never sold, so counting them would inflate both Orders and the sales figure."],
    [hasReturnsReport
      ? "Returns come from the uploaded Returns report, by Return Requested Date — which is why a return can belong to an order placed before this window, and Returns can exceed Orders for a SKU."
      : "No Returns report uploaded for this window, so Returns fall back to the Order report's own RETURNED status. Upload the Returns report for a fuller picture (it tracks in-transit returns the order report still shows as pending)."],
    ["Total Orders = Orders - Returns."],
    [hasListings
      ? "Price and the sales figure come from the uploaded Listings snapshot. It is a CURRENT snapshot with no date column, so it is the price as of the upload, not necessarily the price during these weeks."
      : "⚠ NO Listings snapshot uploaded — Price reads 0 for every SKU, so 'Sales (Price x Orders)' and Growth % are 0 throughout and are NOT usable in this file. Upload the Listings export and regenerate."],
    ["Ad Spend+Tax = FSN report ad spend x (1 + that SKU's GST rate), from the product master's per-SKU Tax column (18% used when a SKU has none on file), the same basis the Flipkart Analysis report uses."],
    ["Discontinued and uncategorised SKUs are excluded from the sheet."],
    [""],
    ["Growth Summary / Category Breakdown / Executive Dashboard / CEO Decision Center — added to match the Amazon Weekly Sales Report's format. Every 'Sales' figure in these sheets is the SAME computed price x orders basis as the 'Flipkart Sales' sheet above, not realised revenue — see the caveat restated at the top of each sheet. All scores, health bands and recommended actions compare only the two weeks shown, same as the Amazon report's equivalent sheets."],
    ["'Campaign Performance' reasoning in Growth Summary / CEO Decision Center uses ad spend and clicks from the FSN report; it is skipped entirely (no fabricated numbers) for a window with no uploaded FSN report."],
  ];
  const wsNotes = XLSX.utils.aoa_to_sheet(notes);
  wsNotes["!cols"] = [{ wch: 150 }];
  notes.forEach((_, i) => {
    const addr = XLSX.utils.encode_cell({ r: i, c: 0 });
    if (!wsNotes[addr]) return;
    wsNotes[addr].s = {
      font: { bold: i === 0, sz: i === 0 ? 13 : 10, color: { rgb: i === 0 ? "0F4C81" : "1F2937" } },
      alignment: { vertical: "top", wrapText: true },
    };
  });
  XLSX.utils.book_append_sheet(wb, wsNotes, "Notes");

  const filename = `Flipkart_Weekly_Sales_Report_${lastWeek.start}_to_${thisWeek.end}.xlsx`;
  return { wb, filename, skuCount: rows.length, hasListings, dataThrough, staleDays };
}

// Browser entry point (Flipkart Download page) — same "this week vs last week"
// windows as the Amazon report, sourced from the uploaded Flipkart tables.
// Client-side only; no API key needed.
export async function exportFlipkartWeeklySalesReport(opts?: { endDate?: string }) {
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

  const { wb, filename, skuCount, hasListings, dataThrough, staleDays } = await buildFlipkartWeeklySalesWorkbook({ thisWeek, lastWeek });
  XLSX.writeFile(wb, filename);
  return { filename, thisWeek, lastWeek, skuCount, hasListings, dataThrough, staleDays };
}
