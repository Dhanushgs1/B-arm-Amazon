import * as XLSX from "xlsx-js-style";
import { fetchAllRows, isCancelledOrder, isStandardOrderId, istDayWindowUtc } from "@/lib/amazonReportShared";
import { upsertInChunks } from "@/lib/amazonReportUpload";
import { resolveProductName } from "@/lib/categoryMap";
import { fetchProductMasterNameMap } from "@/lib/productMasterUpload";

// ── Ad Spend Report ──────────────────────────────────────────────────────────
// Cross-marketplace (Amazon + Flipkart + Meesho) ad-spend snapshot: which
// products are burning the most ad budget, at what CPC/ACOS, which advertised
// products carry no live ads on another platform, and which campaigns are
// barely spending anything. Modelled on a hand-built "Ad spend report"
// workbook that pairs a single day's numbers with a trailing date range.
//
// Sourced entirely from manually-uploaded tables — no live API call anywhere.
// Amazon/Flipkart read the same barm_amazon_*/barm_flipkart_* tables the
// Historical Analysis Report reads; Meesho reads barm_meesho_ads/orders,
// populated by the new /dashboard/meesho/upload page (see
// src/lib/meeshoReportUpload.ts) — run scripts/meesho_tables.sql once before
// the first Meesho upload, those two tables don't exist otherwise. Google Ads
// and social-media (Meta) spend are not included — no sample export has been
// seen for either yet, so there's no column layout to build a parser from.
//
// Definitions match historicalAnalysisReportExport.ts / flipkartHistoricalReportExport.ts:
//   Spend(with tax) = raw ad spend x 1.18 (18% GST), applied once after summing
//   CPC  = Spend(with tax) / Orders        (Orders = 0 -> CPC = Spend(with tax))
//   ACOS = CPC / Price
// "Orders" here means units sold of that product in the window (order-report
// quantity, cancelled orders excluded) — not ad-click-attributed units and not
// order records. This is a deliberate choice (see the Notes sheet) so the
// figure means the same thing as the plain-English "Orders" column on the
// hand-built workbook this report is modelled on.

export type Platform = "Amazon" | "Flipkart" | "Meesho";

const GST_MULTIPLIER = 1.18;
// Campaigns spending at or under this on the single reporting day are flagged
// on the "Low Spend Campaigns" sheet as candidates for pausing/pruning.
const LOW_SPEND_THRESHOLD = 50;

function getDateWindow(toDate: string, days: number): { start: string; end: string } {
  const end = new Date(`${toDate}T00:00:00Z`);
  const start = new Date(end.getTime());
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}
// Every ad platform's own "last N days" export reports with roughly a 1-day
// lag (today's spend isn't final/downloadable until tomorrow), so a report
// generated same-day is silently missing its most recent day's spend unless
// that gap is surfaced. This lists every date in [start, endDate] that has
// zero raw ad-spend rows for a platform, so the caller can warn instead of
// quietly under-counting.
function missingDates(datesPresent: Set<string>, start: string, endDate: string): string[] {
  const missing: string[] = [];
  const cur = new Date(`${start}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (cur.getTime() <= end.getTime()) {
    const iso = cur.toISOString().slice(0, 10);
    if (!datesPresent.has(iso)) missing.push(iso);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return missing;
}
function dotDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ── per-product aggregate (raw spend, pre-tax) ──────────────────────────────
interface WindowAgg { spend: number; units: number; }
const emptyAgg = (): WindowAgg => ({ spend: 0, units: 0 });
const spendTax = (a: WindowAgg): number => a.spend * GST_MULTIPLIER;
const computeCpc = (a: WindowAgg): number => (a.units > 0 ? spendTax(a) / a.units : spendTax(a));
const computeAcos = (a: WindowAgg, price: number): number => (price > 0 ? computeCpc(a) / price : 0);

// Platform-wide "Overall sales" figures (units sold + realised sale value) —
// unrelated to ad spend, so kept as its own shape rather than overloading
// WindowAgg.spend to mean two different things depending on context.
interface SalesAgg { units: number; value: number; }
const emptySales = (): SalesAgg => ({ units: 0, value: 0 });

interface ProductRow {
  platform: Platform;
  sku: string;
  name: string;
  price: number;
  day: WindowAgg;
  range: WindowAgg;
}

interface CampaignSpendRow {
  platform: Platform;
  campaign: string;
  spend: number;
}

export interface AdSpendReportOpts {
  /** 'YYYY-MM-DD' — the single reporting day. */
  endDate: string;
  /** Trailing window ending on endDate, inclusive. Defaults to 7 (matches the
   *  hand-built workbook's "Last 7 days" date-range columns). */
  rangeDays?: number;
  accountName?: string;
}

// ── Amazon ───────────────────────────────────────────────────────────────────
async function fetchAmazonProducts(
  range: { start: string; end: string },
  endDate: string
): Promise<{
  products: Map<string, ProductRow>;
  overallDay: SalesAgg;
  overallRange: SalesAgg;
  campaigns: CampaignSpendRow[];
  unmappedSpend: number;
  reportDates: Set<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spRows: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  orderRows: any[];
}> {
  const rangeIst = istDayWindowUtc(range.start, endDate);

  const [spRows, sbRows, sdRows, mapRows, orderRows, priceRows] = await Promise.all([
    fetchAllRows("barm_amazon_sp_advertised_product", (q) => q.gte("report_date", range.start).lte("report_date", endDate)),
    fetchAllRows("barm_amazon_sb_campaign", (q) => q.gte("report_date", range.start).lte("report_date", endDate)),
    fetchAllRows("barm_amazon_sd_campaign", (q) => q.gte("report_date", range.start).lte("report_date", endDate)),
    // No "id" column on this hand-maintained mapping table — order by its
    // natural key instead (fetchAllRows would otherwise error on "id").
    fetchAllRows("barm_amazon_campaign_sku_map", (q) => q, ["campaign_name", "sku"]),
    fetchAllRows("barm_amazon_am_orders", (q) => q.gte("purchase_datetime", rangeIst.gte).lt("purchase_datetime", rangeIst.lt)),
    fetchAllRows("barm_amazon_price_listing", (q) => q),
  ]);

  // Sponsored Brands / Display carry no SKU column — split each campaign's
  // spend across the SKUs mapped to it on the Upload page, same as the
  // Historical Analysis Report.
  const campaignSkuMap = new Map<string, { sku: string; weight: number }[]>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mapRows.forEach((r: any) => {
    const weight = Number(r.weight);
    const list = campaignSkuMap.get(r.campaign_name) || [];
    list.push({ sku: r.sku, weight: Number.isFinite(weight) && weight > 0 ? weight : 1 });
    campaignSkuMap.set(r.campaign_name, list);
  });
  const campaignShares = (campaignName: string): { sku: string; share: number }[] | null => {
    const list = campaignSkuMap.get(campaignName);
    if (!list || !list.length) return null;
    const total = list.reduce((s, e) => s + e.weight, 0);
    if (total <= 0) return null;
    return list.map((e) => ({ sku: e.sku, share: e.weight / total }));
  };

  const priceBySku = new Map<string, number>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  priceRows.forEach((r: any) => { if (r.seller_sku && num(r.price) > 0) priceBySku.set(r.seller_sku, num(r.price)); });

  const nameBySku = new Map<string, string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  orderRows.forEach((r: any) => { if (r.sku && r.product_name && !nameBySku.has(r.sku)) nameBySku.set(r.sku, r.product_name); });
  // A SKU with ad spend but no order in this window has no name from orderRows
  // above — Price (All Listings report) covers every active listing whether
  // or not it sold, so it fills most of that gap. Without this, those rows
  // print the raw SKU code instead of a product name (e.g. "B-INSEM-15CM-KIT-PK5-1").
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  priceRows.forEach((r: any) => { if (r.seller_sku && r.item_name && !nameBySku.has(r.seller_sku)) nameBySku.set(r.seller_sku, r.item_name); });

  const spendBySku = new Map<string, WindowAgg>();
  const ensureSpend = (sku: string): WindowAgg => {
    let a = spendBySku.get(sku);
    if (!a) { a = emptyAgg(); spendBySku.set(sku, a); }
    return a;
  };
  let unmappedSpend = 0;

  const campaignSpendByDay = new Map<string, number>();
  const addCampaignSpend = (campaign: string, spend: number) => {
    if (!campaign) return;
    campaignSpendByDay.set(campaign, (campaignSpendByDay.get(campaign) || 0) + spend);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spRows.forEach((r: any) => {
    if (!r.advertised_sku) return;
    const spend = num(r.spend);
    const a = ensureSpend(r.advertised_sku);
    a.spend += spend;
    if (r.report_date === endDate) addCampaignSpend(r.campaign_name || "", spend);
  });
  [...sbRows, ...sdRows].forEach((r: { campaign_name?: string; spend?: number; report_date?: string }) => {
    const spend = num(r.spend);
    if (r.report_date === endDate) addCampaignSpend(r.campaign_name || "", spend);
    if (spend <= 0) return;
    const shares = campaignShares(r.campaign_name || "");
    if (!shares) { unmappedSpend += spend; return; }
    shares.forEach(({ sku, share }) => { ensureSpend(sku).spend += spend * share; });
  });

  // "day" spend is the same rows filtered to report_date === endDate, summed
  // through the identical apportioning logic — recomputed rather than
  // subtracted, so an unmapped-campaign row never leaks into a SKU's day figure.
  const spendBySkuDay = new Map<string, number>();
  const addDay = (sku: string, spend: number) => spendBySkuDay.set(sku, (spendBySkuDay.get(sku) || 0) + spend);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spRows.filter((r: any) => r.report_date === endDate).forEach((r: any) => { if (r.advertised_sku) addDay(r.advertised_sku, num(r.spend)); });
  [...sbRows, ...sdRows]
    .filter((r: { report_date?: string }) => r.report_date === endDate)
    .forEach((r: { campaign_name?: string; spend?: number }) => {
      const spend = num(r.spend);
      if (spend <= 0) return;
      const shares = campaignShares(r.campaign_name || "");
      if (!shares) return;
      shares.forEach(({ sku, share }) => addDay(sku, spend * share));
    });

  const dayIst = istDayWindowUtc(endDate, endDate);
  const dayGte = Date.parse(dayIst.gte);
  const dayLt = Date.parse(dayIst.lt);

  const unitsBySku = new Map<string, WindowAgg>();
  const ensureUnits = (sku: string): WindowAgg => {
    let a = unitsBySku.get(sku);
    if (!a) { a = emptyAgg(); unitsBySku.set(sku, a); }
    return a;
  };
  const overallDay = emptySales();
  const overallRange = emptySales();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  orderRows.forEach((r: any) => {
    if (!r.sku || isCancelledOrder(r) || !isStandardOrderId(r.amazon_order_id)) return;
    const qty = num(r.quantity);
    const value = num(r.item_price) * qty;
    ensureUnits(r.sku).units += qty;
    overallRange.units += qty;
    overallRange.value += value;
    const ts = Date.parse(String(r.purchase_datetime || ""));
    if (Number.isFinite(ts) && ts >= dayGte && ts < dayLt) {
      overallDay.units += qty;
      overallDay.value += value;
    }
  });

  const skus = new Set<string>([...spendBySku.keys(), ...unitsBySku.keys(), ...priceBySku.keys()].filter(Boolean));
  const products = new Map<string, ProductRow>();
  skus.forEach((sku) => {
    const rangeSpend = spendBySku.get(sku)?.spend || 0;
    const daySpend = spendBySkuDay.get(sku) || 0;
    const rangeUnits = unitsBySku.get(sku)?.units || 0;
    // Day units aren't tracked per-SKU above (only the overall total) — derive
    // them with the same IST-day filter, scoped to this one SKU.
    products.set(sku, {
      platform: "Amazon",
      sku,
      name: nameBySku.get(sku) || resolveProductName(undefined, sku) || sku,
      price: priceBySku.get(sku) || 0,
      day: { spend: daySpend, units: 0 },
      range: { spend: rangeSpend, units: rangeUnits },
    });
  });
  // Fill in day units per SKU (separate pass — keeps the loop above simple).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  orderRows.forEach((r: any) => {
    if (!r.sku || isCancelledOrder(r) || !isStandardOrderId(r.amazon_order_id)) return;
    const ts = Date.parse(String(r.purchase_datetime || ""));
    if (!(Number.isFinite(ts) && ts >= dayGte && ts < dayLt)) return;
    const p = products.get(r.sku);
    if (p) p.day.units += num(r.quantity);
  });

  const campaigns: CampaignSpendRow[] = [...campaignSpendByDay.entries()]
    .filter(([, spend]) => spend > 0)
    .map(([campaign, spend]) => ({ platform: "Amazon" as const, campaign, spend }));

  const reportDates = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [...spRows, ...sbRows, ...sdRows].forEach((r: any) => { if (r.report_date) reportDates.add(r.report_date); });

  return { products, overallDay, overallRange, campaigns, unmappedSpend, reportDates, spRows, orderRows };
}

// ── Flipkart ─────────────────────────────────────────────────────────────────
async function fetchFlipkartProducts(
  range: { start: string; end: string },
  endDate: string
): Promise<{
  products: Map<string, ProductRow>;
  overallDay: SalesAgg;
  overallRange: SalesAgg;
  campaigns: CampaignSpendRow[];
  reportDates: Set<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fsnRows: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  orderRows: any[];
}> {
  const [fsnRows, orderRowsRaw, earnRows, listingRows] = await Promise.all([
    fetchAllRows("barm_flipkart_fsn_report", (q) => q.gte("report_date", range.start).lte("report_date", endDate)),
    fetchAllRows("barm_flipkart_order_report", (q) => q.gte("order_date", range.start).lte("order_date", endDate)),
    fetchAllRows("barm_flipkart_earn_more", (q) => q.gte("order_date", range.start).lte("order_date", endDate)).catch(() => []),
    fetchAllRows("barm_flipkart_listings", (q) => q).catch(() => []),
  ]);

  // Same dedup key the Flipkart Historical Analysis Report uses, for rows
  // already sitting in Supabase from an earlier upload of an overlapping file.
  const seen = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orderRows = (orderRowsRaw as any[]).filter((r) => {
    const key = `${r.order_item_id}|${r.order_item_status}|${r.quantity}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const priceBySku = new Map<string, number>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  listingRows.forEach((r: any) => { if (r.seller_sku_id && num(r.selling_price) > 0) priceBySku.set(r.seller_sku_id, num(r.selling_price)); });
  // Fall back to the window's realised average selling price where there's no
  // listing row, so ACOS still has a denominator.
  const aspAcc = new Map<string, { amount: number; units: number }>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  earnRows.forEach((r: any) => {
    if (!r.sku_id) return;
    const a = aspAcc.get(r.sku_id) || { amount: 0, units: 0 };
    a.amount += num(r.final_sale_amount);
    a.units += num(r.final_sale_units) || num(r.gross_units);
    aspAcc.set(r.sku_id, a);
  });

  const nameBySku = new Map<string, string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fsnRows.forEach((r: any) => { if (r.sku_id && r.product_name && !nameBySku.has(r.sku_id)) nameBySku.set(r.sku_id, r.product_name); });
  orderRows.forEach((r) => { if (r.sku && r.product_title && !nameBySku.has(r.sku)) nameBySku.set(r.sku, r.product_title); });

  const spendBySku = new Map<string, WindowAgg>();
  const spendBySkuDay = new Map<string, number>();
  const campaignSpendDay = new Map<string, number>();
  const ensureSpend = (sku: string): WindowAgg => {
    let a = spendBySku.get(sku);
    if (!a) { a = emptyAgg(); spendBySku.set(sku, a); }
    return a;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fsnRows.forEach((r: any) => {
    if (!r.sku_id) return;
    const spend = num(r.ad_spend);
    ensureSpend(r.sku_id).spend += spend;
    if (r.report_date === endDate) {
      spendBySkuDay.set(r.sku_id, (spendBySkuDay.get(r.sku_id) || 0) + spend);
      if (spend > 0) campaignSpendDay.set(r.campaign_name || "", (campaignSpendDay.get(r.campaign_name || "") || 0) + spend);
    }
  });

  const unitsBySku = new Map<string, WindowAgg>();
  const ensureUnits = (sku: string): WindowAgg => {
    let a = unitsBySku.get(sku);
    if (!a) { a = emptyAgg(); unitsBySku.set(sku, a); }
    return a;
  };
  const overallDay = emptySales();
  const overallRange = emptySales();
  orderRows.forEach((r) => {
    if (!r.sku) return;
    const status = String(r.order_item_status || "").toUpperCase();
    if (status.startsWith("CANCEL")) return;
    const qty = num(r.quantity);
    ensureUnits(r.sku).units += qty;
    overallRange.units += qty;
    if (r.order_date === endDate) overallDay.units += qty;
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  earnRows.forEach((r: any) => {
    if (!r.sku_id) return;
    const amount = num(r.final_sale_amount);
    overallRange.value += amount;
    if (r.order_date === endDate) overallDay.value += amount;
  });

  const skus = new Set<string>([...spendBySku.keys(), ...unitsBySku.keys(), ...priceBySku.keys()].filter(Boolean));
  const products = new Map<string, ProductRow>();
  skus.forEach((sku) => {
    let price = priceBySku.get(sku) || 0;
    if (price <= 0) {
      const a = aspAcc.get(sku);
      if (a && a.units > 0) price = a.amount / a.units;
    }
    products.set(sku, {
      platform: "Flipkart",
      sku,
      name: nameBySku.get(sku) || resolveProductName(undefined, sku) || sku,
      price,
      day: { spend: spendBySkuDay.get(sku) || 0, units: 0 },
      range: { spend: spendBySku.get(sku)?.spend || 0, units: unitsBySku.get(sku)?.units || 0 },
    });
  });
  orderRows.forEach((r) => {
    if (!r.sku || r.order_date !== endDate) return;
    const status = String(r.order_item_status || "").toUpperCase();
    if (status.startsWith("CANCEL")) return;
    const p = products.get(r.sku);
    if (p) p.day.units += num(r.quantity);
  });

  const campaigns: CampaignSpendRow[] = [...campaignSpendDay.entries()]
    .filter(([, spend]) => spend > 0)
    .map(([campaign, spend]) => ({ platform: "Flipkart" as const, campaign, spend }));

  const reportDates = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fsnRows.forEach((r: any) => { if (r.report_date) reportDates.add(r.report_date); });

  return { products, overallDay, overallRange, campaigns, reportDates, fsnRows, orderRows };
}

// ── Meesho ───────────────────────────────────────────────────────────────────
// No native Meesho export has been seen directly — barm_meesho_ads/orders are
// populated by src/lib/meeshoReportUpload.ts from the seller's own
// hand-assembled workbook column names (see that file's header comment). Both
// fetches are wrapped in .catch(() => []) because the two Meesho tables may
// not exist yet (scripts/meesho_tables.sql not run) — that must degrade to
// "no Meesho data" rather than take down the whole report.
async function fetchMeeshoProducts(
  range: { start: string; end: string },
  endDate: string
): Promise<{
  products: Map<string, ProductRow>;
  overallDay: SalesAgg;
  overallRange: SalesAgg;
  campaigns: CampaignSpendRow[];
  reportDates: Set<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adsRows: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  orderRows: any[];
}> {
  const [adsRows, orderRows] = await Promise.all([
    fetchAllRows("barm_meesho_ads", (q) => q.gte("report_date", range.start).lte("report_date", endDate)).catch(() => []),
    fetchAllRows("barm_meesho_orders", (q) => q.gte("order_date", range.start).lte("order_date", endDate)).catch(() => []),
  ]);

  const isCancelled = (status: unknown) => String(status || "").toUpperCase().startsWith("CANCEL");
  // Discounted price (post-commission net) is the closer analog to Amazon's
  // item_price / Flipkart's selling_price; listed price is the fallback for a
  // SKU whose orders never carry a discounted figure.
  const priceOf = (r: { supplier_discounted_price?: unknown; supplier_listed_price?: unknown }) =>
    num(r.supplier_discounted_price) || num(r.supplier_listed_price);

  const nameBySku = new Map<string, string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  orderRows.forEach((r: any) => { if (r.sku && r.product_name && !nameBySku.has(r.sku)) nameBySku.set(r.sku, r.product_name); });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adsRows.forEach((r: any) => { if (r.sku && r.product_name && !nameBySku.has(r.sku)) nameBySku.set(r.sku, r.product_name); });

  const priceBySku = new Map<string, number>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  orderRows.forEach((r: any) => {
    if (!r.sku || priceBySku.has(r.sku)) return;
    const price = priceOf(r);
    if (price > 0) priceBySku.set(r.sku, price);
  });

  const spendBySku = new Map<string, WindowAgg>();
  const spendBySkuDay = new Map<string, number>();
  const campaignSpendDay = new Map<string, number>();
  const ensureSpend = (sku: string): WindowAgg => {
    let a = spendBySku.get(sku);
    if (!a) { a = emptyAgg(); spendBySku.set(sku, a); }
    return a;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adsRows.forEach((r: any) => {
    if (!r.sku) return;
    const spend = num(r.spend);
    ensureSpend(r.sku).spend += spend;
    if (r.report_date === endDate) {
      spendBySkuDay.set(r.sku, (spendBySkuDay.get(r.sku) || 0) + spend);
      if (spend > 0) campaignSpendDay.set(r.campaign_name || "", (campaignSpendDay.get(r.campaign_name || "") || 0) + spend);
    }
  });

  const unitsBySku = new Map<string, WindowAgg>();
  const ensureUnits = (sku: string): WindowAgg => {
    let a = unitsBySku.get(sku);
    if (!a) { a = emptyAgg(); unitsBySku.set(sku, a); }
    return a;
  };
  const overallDay = emptySales();
  const overallRange = emptySales();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  orderRows.forEach((r: any) => {
    if (!r.sku || isCancelled(r.order_status)) return;
    const qty = num(r.quantity);
    const value = priceOf(r) * qty;
    ensureUnits(r.sku).units += qty;
    overallRange.units += qty;
    overallRange.value += value;
    if (r.order_date === endDate) {
      overallDay.units += qty;
      overallDay.value += value;
    }
  });

  const skus = new Set<string>([...spendBySku.keys(), ...unitsBySku.keys(), ...priceBySku.keys()].filter(Boolean));
  const products = new Map<string, ProductRow>();
  skus.forEach((sku) => {
    products.set(sku, {
      platform: "Meesho",
      sku,
      name: nameBySku.get(sku) || resolveProductName(undefined, sku) || sku,
      price: priceBySku.get(sku) || 0,
      day: { spend: spendBySkuDay.get(sku) || 0, units: 0 },
      range: { spend: spendBySku.get(sku)?.spend || 0, units: unitsBySku.get(sku)?.units || 0 },
    });
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  orderRows.forEach((r: any) => {
    if (!r.sku || r.order_date !== endDate || isCancelled(r.order_status)) return;
    const p = products.get(r.sku);
    if (p) p.day.units += num(r.quantity);
  });

  const campaigns: CampaignSpendRow[] = [...campaignSpendDay.entries()]
    .filter(([, spend]) => spend > 0)
    .map(([campaign, spend]) => ({ platform: "Meesho" as const, campaign, spend }));

  const reportDates = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adsRows.forEach((r: any) => { if (r.report_date) reportDates.add(r.report_date); });

  return { products, overallDay, overallRange, campaigns, reportDates, adsRows, orderRows };
}

// ── workbook ─────────────────────────────────────────────────────────────────

function styleHeader(ws: XLSX.WorkSheet, row: number, cols: number, fill: string): void {
  for (let c = 0; c < cols; c++) {
    const addr = XLSX.utils.encode_cell({ r: row, c });
    if (!ws[addr]) ws[addr] = { t: "s", v: "" };
    ws[addr].s = {
      font: { bold: true, color: { rgb: "FFFFFF" }, sz: 10 },
      fill: { fgColor: { rgb: fill } },
      alignment: { horizontal: "center", vertical: "center", wrapText: true },
    };
  }
}
function styleLabel(ws: XLSX.WorkSheet, addr: string, fill: string): void {
  if (!ws[addr]) ws[addr] = { t: "s", v: "" };
  ws[addr].s = { font: { bold: true, color: { rgb: "FFFFFF" }, sz: 11 }, fill: { fgColor: { rgb: fill } } };
}

// Every uploaded row keeps its original file's columns verbatim in a `raw`
// JSONB field (see *ReportUpload.ts) — dumping that, rather than the parsed
// snake_case fields, gives the seller back exactly the sheet shape they
// uploaded (their own headers, their own column order), matching the raw
// "Amazon Spend" / "Flipkart Orders" / etc. sheets in their hand-built
// workbook instead of inventing a different layout.
function rawRowsToSheet(
  wb: XLSX.WorkBook,
  sheetName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rows: any[]
): void {
  const rawRows: Record<string, unknown>[] = rows.map((r) => r?.raw).filter((r): r is Record<string, unknown> => !!r);
  if (!rawRows.length) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["(no data in range)"]]), sheetName);
    return;
  }
  const cols: string[] = [];
  const seen = new Set<string>();
  rawRows.forEach((r) => Object.keys(r).forEach((k) => { if (!seen.has(k)) { seen.add(k); cols.push(k); } }));

  const aoa: (string | number)[][] = [cols];
  rawRows.forEach((r) => {
    aoa.push(
      cols.map((c) => {
        const v = r[c];
        if (v === null || v === undefined) return "";
        return typeof v === "number" || typeof v === "string" ? v : String(v);
      })
    );
  });
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  styleHeader(ws, 0, cols.length, "6B7280");
  ws["!views"] = [{ state: "frozen", ySplit: 1 }];
  ws["!cols"] = cols.map(() => ({ wch: 16 }));
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
}

const PLATFORM_FILL: Record<Platform, string> = { Amazon: "FF9900", Flipkart: "2874F0", Meesho: "9F2089" };
const productAoaRow = (p: ProductRow): (string | number)[] => [
  p.name, p.price,
  round2(p.day.spend), round2(spendTax(p.day)), p.day.units, round2(computeCpc(p.day)), pct(computeAcos(p.day, p.price)),
  round2(p.range.spend), round2(spendTax(p.range)), p.range.units, round2(computeCpc(p.range)), pct(computeAcos(p.range, p.price)),
];
function round2(n: number): number { return Math.round(n * 100) / 100; }
function pct(n: number): number { return Math.round(n * 10000) / 10000; }

// One product's day/range Spend, Spend(with tax), Orders, CPC, ACOS — the same
// five metrics as METRIC_NAMES/productAoaRow above, just as a named object
// instead of a positional row, for the daily email summary (see
// PlatformEmailSummary below) rather than a spreadsheet cell.
export interface ProductMetricBlock {
  spend: number;
  spendTax: number;
  orders: number;
  cpc: number;
  acos: number;
}

// Mirrors exactly the Summary sheet's per-platform block (platform totals +
// its top-N-by-range-spend product shortlist + overall sales), so the daily
// email table and the "Summary" sheet in the attached workbook always agree —
// this is captured from the very same `shortlist`/`rows` computation below,
// not recomputed separately.
export interface PlatformEmailSummary {
  platform: Platform;
  daySpend: number;
  daySpendTax: number;
  rangeSpend: number;
  rangeSpendTax: number;
  overallRangeUnits: number;
  overallRangeValue: number;
  topProducts: { name: string; price: number; day: ProductMetricBlock; range: ProductMetricBlock }[];
}

export interface AdSpendReportResult {
  wb: XLSX.WorkBook;
  filename: string;
  endDate: string;
  rangeStart: string;
  productCount: number;
  platformTotals: { platform: Platform; daySpendTax: number; rangeSpendTax: number }[];
  platformSummaries: PlatformEmailSummary[];
  unmappedAmazonSpend: number;
  lowSpendCampaignCount: number;
  historyRowsSaved: number;
  // Every platform's own ad-spend export lags ~1 day (today's spend isn't
  // downloadable until tomorrow), so a report run same-day is silently short
  // its most recent day unless that gap is surfaced. Only populated for a
  // platform with SOME data in range but a gap inside it — a platform with
  // zero rows at all (Meesho not yet onboarded, say) is a different problem
  // and not reported here.
  incompleteDates: { platform: Platform; missingDates: string[] }[];
}

// Persists one row per product per platform into barm_ad_spend_history (see
// scripts/ad_spend_history_table.sql) — a running record independent of any
// single downloaded .xlsx, queryable/chartable later ("how has this SKU's
// ACOS trended"). Runs on every generation, whether triggered by the Download
// page's "Generate & Download" button or the daily cron
// (src/pages/api/cron/ad-spend-history.ts), so both paths build the same
// history without duplicating this logic. Products with no activity in
// either window are skipped — no point storing an all-zero row every day.
async function saveAdSpendHistory(
  platforms: { platform: Platform; products: Map<string, ProductRow> }[],
  endDate: string,
  rangeStart: string
): Promise<number> {
  const rows: Record<string, unknown>[] = [];
  platforms.forEach(({ platform, products }) => {
    products.forEach((p) => {
      if (spendTax(p.range) <= 0 && p.range.units <= 0) return;
      rows.push({
        report_date: endDate,
        range_start: rangeStart,
        platform,
        sku: p.sku,
        product_name: p.name,
        price: p.price,
        day_spend: round2(p.day.spend),
        day_spend_tax: round2(spendTax(p.day)),
        day_orders: p.day.units,
        day_cpc: round2(computeCpc(p.day)),
        day_acos: pct(computeAcos(p.day, p.price)),
        range_spend: round2(p.range.spend),
        range_spend_tax: round2(spendTax(p.range)),
        range_orders: p.range.units,
        range_cpc: round2(computeCpc(p.range)),
        range_acos: pct(computeAcos(p.range, p.price)),
      });
    });
  });
  if (!rows.length) return 0;
  try {
    await upsertInChunks("barm_ad_spend_history", rows, "report_date,platform,sku");
    return rows.length;
  } catch (err) {
    // A missing table (scripts/ad_spend_history_table.sql not run yet) or a
    // transient Supabase error must not break report generation — the
    // downloaded workbook is unaffected by whether its history got persisted.
    console.error("[adSpendReportExport] Failed to save ad spend history:", err);
    return 0;
  }
}

export async function buildAdSpendReportWorkbook(opts: AdSpendReportOpts): Promise<AdSpendReportResult> {
  const { endDate, accountName } = opts;
  const rangeDays = opts.rangeDays && opts.rangeDays > 0 ? opts.rangeDays : 7;
  const range = getDateWindow(endDate, rangeDays);

  // Fetched once and shared across all three platforms — the seller's own
  // approved SKU -> product name list, checked first before falling back to
  // whatever name shows up on an order/price-listing row (see resolveName).
  const [masterNames, amz, fk, ms] = await Promise.all([
    fetchProductMasterNameMap(),
    fetchAmazonProducts(range, endDate),
    fetchFlipkartProducts(range, endDate),
    fetchMeeshoProducts(range, endDate),
  ]);
  // The master lists one SKU spelling per product (e.g. "B-BULB-...-PK5(FK)"),
  // but ad/order data carries whatever variant spelling that platform export
  // used (e.g. "B-BULB-...-PK5-1") — a real, different string, not a typo. An
  // exact match misses these, so fall back to matching on the SKU's base:
  // strip a trailing platform tag like "(FK)"/"(AM)"/"(MS)" or a trailing
  // "-<digits>" variant suffix, then compare. This only changes which NAME
  // gets displayed — every spend/order figure stays keyed on the exact SKU.
  const skuBase = (sku: string): string =>
    sku.trim().toUpperCase().replace(/\((AM|FK|MS)\)$/i, "").replace(/-\d+$/, "").replace(/[\s_]+/g, "");
  const masterNamesByBase = new Map<string, string>();
  masterNames.forEach((name, sku) => {
    const base = skuBase(sku);
    if (!masterNamesByBase.has(base)) masterNamesByBase.set(base, name);
  });
  const resolveName = (sku: string, fallback: string): string =>
    masterNames.get(sku) || masterNamesByBase.get(skuBase(sku)) || fallback;
  [amz.products, fk.products, ms.products].forEach((products) => {
    products.forEach((p) => { p.name = resolveName(p.sku, p.name); });
  });

  if (!amz.products.size && !fk.products.size && !ms.products.size) {
    throw new Error(
      `No uploaded Amazon, Flipkart or Meesho ad/order data in ${dotDate(range.start)} to ${dotDate(endDate)}. ` +
        `Upload the reports for that period on the Upload pages first.`
    );
  }

  const platforms: { platform: Platform; products: Map<string, ProductRow>; overallDay: SalesAgg; overallRange: SalesAgg; campaigns: CampaignSpendRow[] }[] = [
    { platform: "Amazon", products: amz.products, overallDay: amz.overallDay, overallRange: amz.overallRange, campaigns: amz.campaigns },
    { platform: "Flipkart", products: fk.products, overallDay: fk.overallDay, overallRange: fk.overallRange, campaigns: fk.campaigns },
    { platform: "Meesho", products: ms.products, overallDay: ms.overallDay, overallRange: ms.overallRange, campaigns: ms.campaigns },
  ];

  const incompleteDates: AdSpendReportResult["incompleteDates"] = [
    { platform: "Amazon" as const, reportDates: amz.reportDates },
    { platform: "Flipkart" as const, reportDates: fk.reportDates },
    { platform: "Meesho" as const, reportDates: ms.reportDates },
  ]
    .filter(({ reportDates }) => reportDates.size > 0)
    .map(({ platform, reportDates }) => ({ platform, missingDates: missingDates(reportDates, range.start, endDate) }))
    .filter(({ missingDates }) => missingDates.length > 0);

  const historyRowsSaved = await saveAdSpendHistory(platforms, endDate, range.start);

  const wb = XLSX.utils.book_new();

  // Both sheets below mirror the hand-built "Ad spend report" workbook's own
  // grid exactly (see its Summary/"Ad spend report" sheets): a two-row group
  // header — a spanning date/range label over five repeated Spend/Spend(with
  // tax)/Orders/CPC/ACOS columns, once for the single day and once for the
  // range — then one row per product, with per-platform labels/totals merged
  // down the left (and, on Summary, QTS/Value merged down the right) instead
  // of repeated on every row.
  const dayLabel = dotDate(endDate);
  const rangeLabel = `${dotDate(range.start)} to ${dotDate(endDate)}`;
  const METRIC_NAMES = ["Spend", "Spend(with tax)", "Orders", "CPC", "ACOS"];

  // ── Summary sheet ──
  // 17 columns: A Platform, B/C Ad spend without/with tax (range total), D/E
  // Product/price, F-J day metrics, K-O range metrics, P/Q Overall sales
  // QTS/Value — A,B,C,P,Q merge down across however many product rows that
  // platform gets.
  const SUM_COLS = 17;
  const sumAoa: (string | number)[][] = [
    Array(SUM_COLS).fill(""),
    ["Summary", ...Array(SUM_COLS - 1).fill("")],
    Array(SUM_COLS).fill(""),
    ["Platform", "Ad spend (without tax)", "Ad spend (with tax)", "Best ACOS product", "", dayLabel, "", "", "", "", rangeLabel, "", "", "", "", "Overall sales", ""],
    ["", "", "", "Product", "price", ...METRIC_NAMES, ...METRIC_NAMES, "QTS", "Value"],
  ];
  const sumMerges: XLSX.Range[] = [
    { s: { r: 1, c: 0 }, e: { r: 1, c: SUM_COLS - 1 } },
    { s: { r: 3, c: 0 }, e: { r: 4, c: 0 } }, { s: { r: 3, c: 1 }, e: { r: 4, c: 1 } }, { s: { r: 3, c: 2 }, e: { r: 4, c: 2 } },
    { s: { r: 3, c: 3 }, e: { r: 3, c: 4 } }, { s: { r: 3, c: 5 }, e: { r: 3, c: 9 } }, { s: { r: 3, c: 10 }, e: { r: 3, c: 14 } },
    { s: { r: 3, c: 15 }, e: { r: 3, c: 16 } },
  ];
  const sumHeaderRowsStyled = [3, 4];
  const sumLabelCells: { row: number; platform: Platform }[] = [];
  const platformTotals: AdSpendReportResult["platformTotals"] = [];
  const platformSummaries: PlatformEmailSummary[] = [];
  const TOP_N = 3; // shortlist length — best (lowest) range ACOS first, not highest spend
  platforms.forEach(({ platform, products, overallRange }) => {
    const rows = [...products.values()]
      .filter((p) => spendTax(p.range) > 0)
      .sort((a, b) => computeAcos(a.range, a.price) - computeAcos(b.range, b.price));
    const rangeSpendRaw = rows.reduce((s, p) => s + p.range.spend, 0);
    const daySpendRaw = rows.reduce((s, p) => s + p.day.spend, 0);
    platformTotals.push({ platform, daySpendTax: daySpendRaw * GST_MULTIPLIER, rangeSpendTax: rangeSpendRaw * GST_MULTIPLIER });

    const shortlist = rows.slice(0, TOP_N);
    platformSummaries.push({
      platform,
      daySpend: round2(daySpendRaw),
      daySpendTax: round2(daySpendRaw * GST_MULTIPLIER),
      rangeSpend: round2(rangeSpendRaw),
      rangeSpendTax: round2(rangeSpendRaw * GST_MULTIPLIER),
      overallRangeUnits: overallRange.units,
      overallRangeValue: round2(overallRange.value),
      topProducts: shortlist.map((p) => ({
        name: p.name,
        price: p.price,
        day: { spend: round2(p.day.spend), spendTax: round2(spendTax(p.day)), orders: p.day.units, cpc: round2(computeCpc(p.day)), acos: pct(computeAcos(p.day, p.price)) },
        range: { spend: round2(p.range.spend), spendTax: round2(spendTax(p.range)), orders: p.range.units, cpc: round2(computeCpc(p.range)), acos: pct(computeAcos(p.range, p.price)) },
      })),
    });

    const blockStart = sumAoa.length;
    const blockRows = Math.max(shortlist.length, 1);
    sumLabelCells.push({ row: blockStart, platform });
    if (shortlist.length) {
      shortlist.forEach((p, i) => {
        sumAoa.push([
          // "Ad spend (without/with tax)" here is the SINGLE-DAY total, matching
          // the seller's own manual workbook's Summary sheet convention — the
          // 7-day range total is still shown per-product further right, and is
          // preserved separately in platformTotals.rangeSpendTax for the
          // post-generate toast on the Download page.
          i === 0 ? platform : "", i === 0 ? round2(daySpendRaw) : "", i === 0 ? round2(daySpendRaw * GST_MULTIPLIER) : "",
          ...productAoaRow(p),
          i === 0 ? overallRange.units : "", i === 0 ? round2(overallRange.value) : "",
        ]);
      });
    } else {
      sumAoa.push([platform, 0, 0, "(no ad spend in range)", "", "", "", "", "", "", "", "", "", "", "", overallRange.units, round2(overallRange.value)]);
    }
    if (blockRows > 1) {
      [0, 1, 2, 15, 16].forEach((c) => sumMerges.push({ s: { r: blockStart, c }, e: { r: blockStart + blockRows - 1, c } }));
    }
  });

  const wsSummary = XLSX.utils.aoa_to_sheet(sumAoa);
  wsSummary["!merges"] = sumMerges;
  if (wsSummary["A2"]) wsSummary["A2"].s = { font: { bold: true, sz: 13 } };
  sumHeaderRowsStyled.forEach((row) => styleHeader(wsSummary, row, SUM_COLS, "312E81"));
  sumLabelCells.forEach(({ row, platform }) => styleLabel(wsSummary, XLSX.utils.encode_cell({ r: row, c: 0 }), PLATFORM_FILL[platform]));
  wsSummary["!cols"] = [
    { wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 42 }, { wch: 10 },
    ...Array.from({ length: 10 }, () => ({ wch: 13 })), { wch: 10 }, { wch: 14 },
  ];
  XLSX.utils.book_append_sheet(wb, wsSummary, "Summary");

  // ── Ad spend report sheet (every advertised product, per platform) ──
  // SKU sits ahead of Product Name so a name resolved via a fallback (or one
  // that's just wrong/ambiguous) can always be traced back to the exact SKU
  // the spend/orders were keyed on.
  const DETAIL_COLS = 13;
  const detailAoa: (string | number)[][] = [];
  const detailHeaderRows: number[] = [];
  const detailLabelCells: { addr: string; platform: Platform }[] = [];
  const detailMerges: XLSX.Range[] = [];
  platforms.forEach(({ platform, products }) => {
    const rows = [...products.values()].filter((p) => spendTax(p.range) > 0 || p.range.units > 0).sort((a, b) => spendTax(b.range) - spendTax(a.range));
    detailLabelCells.push({ addr: XLSX.utils.encode_cell({ r: detailAoa.length, c: 0 }), platform });
    detailAoa.push([platform, ...Array(DETAIL_COLS - 1).fill("")]);
    detailAoa.push(Array(DETAIL_COLS).fill(""));
    const groupRow = detailAoa.length;
    detailHeaderRows.push(groupRow);
    detailAoa.push(["SKU", "Product Name", "Price", dayLabel, "", "", "", "", rangeLabel, "", "", "", ""]);
    detailAoa.push(["", "", "", ...METRIC_NAMES, ...METRIC_NAMES]);
    detailMerges.push(
      { s: { r: groupRow, c: 0 }, e: { r: groupRow + 1, c: 0 } },
      { s: { r: groupRow, c: 1 }, e: { r: groupRow + 1, c: 1 } },
      { s: { r: groupRow, c: 2 }, e: { r: groupRow + 1, c: 2 } },
      { s: { r: groupRow, c: 3 }, e: { r: groupRow, c: 7 } },
      { s: { r: groupRow, c: 8 }, e: { r: groupRow, c: 12 } },
    );
    rows.forEach((p) => detailAoa.push([p.sku, ...productAoaRow(p)]));
    if (!rows.length) detailAoa.push(["(no advertised products with activity in range)", ...Array(DETAIL_COLS - 1).fill("")]);
    detailAoa.push([]);
  });
  const wsDetail = XLSX.utils.aoa_to_sheet(detailAoa);
  wsDetail["!merges"] = detailMerges;
  detailLabelCells.forEach(({ addr, platform }) => styleLabel(wsDetail, addr, PLATFORM_FILL[platform]));
  detailHeaderRows.forEach((row) => { styleHeader(wsDetail, row, DETAIL_COLS, "312E81"); styleHeader(wsDetail, row + 1, DETAIL_COLS, "312E81"); });
  wsDetail["!cols"] = [{ wch: 20 }, { wch: 46 }, { wch: 10 }, ...Array.from({ length: DETAIL_COLS - 3 }, () => ({ wch: 13 }))];
  XLSX.utils.book_append_sheet(wb, wsDetail, "Ad spend report");

  // ── Ad Status Report — product name x platform, best-effort name match ──
  // No cross-platform SKU/product mapping exists in this dashboard, so a
  // product is matched across Amazon and Flipkart purely by its (lowercased,
  // trimmed) product name. Two listings with slightly different titles on the
  // two platforms will show as two separate rows rather than one.
  const statusKey = (name: string) => name.trim().toLowerCase();
  const statusNames = new Map<string, string>(); // key -> display name
  const statusHasSpend: Record<Platform, Set<string>> = { Amazon: new Set(), Flipkart: new Set(), Meesho: new Set() };
  platforms.forEach(({ platform, products }) => {
    products.forEach((p) => {
      const key = statusKey(p.name);
      if (!statusNames.has(key)) statusNames.set(key, p.name);
      if (spendTax(p.range) > 0) statusHasSpend[platform].add(key);
    });
  });
  const statusAoa: (string | number)[][] = [["Product", "Amazon", "Flipkart", "Meesho"]];
  [...statusNames.entries()].sort((a, b) => a[1].localeCompare(b[1])).forEach(([key, name]) => {
    statusAoa.push([name, statusHasSpend.Amazon.has(key) ? 1 : 0, statusHasSpend.Flipkart.has(key) ? 1 : 0, statusHasSpend.Meesho.has(key) ? 1 : 0]);
  });
  const wsStatus = XLSX.utils.aoa_to_sheet(statusAoa);
  styleHeader(wsStatus, 0, 4, "312E81");
  wsStatus["!cols"] = [{ wch: 60 }, { wch: 10 }, { wch: 10 }, { wch: 10 }];
  wsStatus["!views"] = [{ state: "frozen", ySplit: 1 }];
  XLSX.utils.book_append_sheet(wb, wsStatus, "Ad Status Report");

  // ── Low Spend Campaigns — single reporting day, both platforms ──
  const lowSpend: CampaignSpendRow[] = [...amz.campaigns, ...fk.campaigns, ...ms.campaigns]
    .filter((c) => c.spend <= LOW_SPEND_THRESHOLD)
    .sort((a, b) => a.spend - b.spend);
  const lowAoa: (string | number)[][] = [["Platform", "Campaign Name", `Spend (${dotDate(endDate)})`]];
  lowSpend.forEach((c) => lowAoa.push([c.platform, c.campaign, round2(c.spend)]));
  if (!lowSpend.length) lowAoa.push(["(no campaigns at or under the threshold)", "", ""]);
  const wsLow = XLSX.utils.aoa_to_sheet(lowAoa);
  styleHeader(wsLow, 0, 3, "6B7280");
  wsLow["!cols"] = [{ wch: 12 }, { wch: 50 }, { wch: 16 }];
  wsLow["!views"] = [{ state: "frozen", ySplit: 1 }];
  XLSX.utils.book_append_sheet(wb, wsLow, "Low Spend Campaigns");

  // ── Raw per-platform sheets — mirrors the hand-built workbook's own
  // Amazon Spend / Amazon orders / Flipkart Spend / Flipkart Orders /
  // Meesho (B Arm) Spend / Meesho (B Arm) orders tabs, so anyone reconciling
  // this report against the raw upload doesn't have to go find the original
  // file — it's sitting right here, unmodified. ──
  rawRowsToSheet(wb, "Amazon Spend", amz.spRows);
  rawRowsToSheet(wb, "Amazon orders", amz.orderRows);
  rawRowsToSheet(wb, "Flipkart Spend", fk.fsnRows);
  rawRowsToSheet(wb, "Flipkart Orders", fk.orderRows);
  rawRowsToSheet(wb, "Meesho (B Arm) Spend", ms.adsRows);
  rawRowsToSheet(wb, "Meesho (B Arm) orders", ms.orderRows);

  // ── B Arm orders — cross-platform Product/Quantity/Price/Sales leaderboard,
  // matching the hand-built workbook's own (empty, in every sample seen)
  // "B Arm orders" tab, but actually populated here from the range window's
  // order data already computed above rather than left blank.
  const bArmAoa: (string | number)[][] = [["Product", "Quantity", "Price", "Sales"]];
  platforms.forEach(({ products }) => {
    [...products.values()]
      .filter((p) => p.range.units > 0)
      .sort((a, b) => b.range.units * b.price - a.range.units * a.price)
      .forEach((p) => bArmAoa.push([p.name, p.range.units, p.price, round2(p.price * p.range.units)]));
  });
  const wsBArm = XLSX.utils.aoa_to_sheet(bArmAoa);
  styleHeader(wsBArm, 0, 4, "6B7280");
  wsBArm["!cols"] = [{ wch: 60 }, { wch: 10 }, { wch: 10 }, { wch: 14 }];
  wsBArm["!views"] = [{ state: "frozen", ySplit: 1 }];
  XLSX.utils.book_append_sheet(wb, wsBArm, "B Arm orders");

  // ── Notes ──
  const wsNotes = XLSX.utils.aoa_to_sheet([
    ["Ad Spend Report — methodology"],
    [""],
    [`Generated for ${accountName || "this account"} · reporting day ${dotDate(endDate)} · range ${dotDate(range.start)} to ${dotDate(endDate)} (${rangeDays} days)`],
    [""],
    ...(incompleteDates.length
      ? [
          [
            "⚠ INCOMPLETE DATA — every platform's own ad-spend export lags about a day (today's spend isn't downloadable until tomorrow). " +
              "The figures below are understated until the missing day(s) are re-uploaded and this report is regenerated:",
          ],
          ...incompleteDates.map(({ platform, missingDates: md }) => [`  ${platform}: no ad-spend rows for ${md.map(dotDate).join(", ")}`]),
          [""],
        ]
      : []),
    ["Spend (with tax) = raw ad spend x 1.18 (18% GST), applied once after summing — never a per-row multiply."],
    ["CPC = Spend(with tax) / Orders. When Orders = 0, CPC = Spend(with tax) (undefined ratio, shown as the spend itself rather than blank)."],
    ["ACOS = CPC / Price."],
    ["\"Orders\" = units sold of that product in the window, from the Orders/Order report, cancelled orders excluded. This is NOT ad-click-attributed units."],
    ["\"Day\" = the single reporting day above. \"Range\" = that day and the", rangeDays - 1, "days before it, inclusive."],
    [""],
    ["Amazon: Sponsored Products spend is per-SKU (barm_amazon_sp_advertised_product). Sponsored Brands/Display spend has no SKU column and is split across the SKUs mapped to that campaign on the Upload page, in proportion to their weight. Unmapped SB/SD spend for the range window: ₹" + round2(amz.unmappedSpend) + " — not attributed to any product below."],
    ["Flipkart: FSN report spend is per-SKU for every campaign type, so no apportioning is needed. Price prefers the Listings snapshot; where a SKU has no listing row, price falls back to the window's realised average selling price (Earn more report)."],
    ["Meesho: Ads report spend is per-SKU. Price uses the Orders report's Supplier Discounted Price (falling back to Supplier Listed Price), since Meesho has no separate listings/price snapshot upload. Column names come from the seller's own workbook, not a native Meesho export seen directly — see src/lib/meeshoReportUpload.ts if a real export's headers turn out to differ."],
    ["Google Ads and social-media (Meta) spend are not included — no sample export has been seen for either, so there's no confirmed column layout to parse."],
    [""],
    ["Ad Status Report matches products across Amazon, Flipkart and Meesho by product NAME only (no cross-platform SKU mapping exists) — two listings with different titles for the same physical product will show as separate rows."],
    [`Low Spend Campaigns lists every campaign spending ₹${LOW_SPEND_THRESHOLD} or less on the single reporting day above, across all platforms, ascending by spend.`],
    [""],
    [`Every product with activity in the range window above was also upserted into the barm_ad_spend_history table (Spend/Orders/CPC/ACOS, day and range) — a running history independent of this file, keyed on (report_date, platform, sku). Rows saved this run: ${historyRowsSaved}.`],
  ]);
  wsNotes["!cols"] = [{ wch: 110 }];
  if (wsNotes["A1"]) wsNotes["A1"].s = { font: { bold: true, sz: 13 } };
  XLSX.utils.book_append_sheet(wb, wsNotes, "Notes");

  const filename = `Ad_Spend_Report_${endDate}.xlsx`;
  return {
    wb,
    filename,
    endDate,
    rangeStart: range.start,
    productCount: amz.products.size + fk.products.size + ms.products.size,
    platformTotals,
    platformSummaries,
    unmappedAmazonSpend: round2(amz.unmappedSpend),
    lowSpendCampaignCount: lowSpend.length,
    historyRowsSaved,
    incompleteDates,
  };
}

export async function exportAdSpendReport(opts: AdSpendReportOpts): Promise<Omit<AdSpendReportResult, "wb">> {
  const { wb, ...stats } = await buildAdSpendReportWorkbook(opts);
  XLSX.writeFile(wb, stats.filename, { bookSST: true, compression: true });
  return stats;
}
