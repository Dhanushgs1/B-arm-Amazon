// Builds the executive dashboard's dataset on the server. Every figure comes from the same loaders
// the rest of the dashboard uses, so the executive page and the channel pages cannot disagree:
//   Amazon    loadAmazonSkuPeriodData   (MIS orders + daily upload; gross = price × units, as the Overview)
//   Flipkart  loadFlipkartOrderData     (listing price × units, as the Flipkart Overview)
//   Meesho    loadMeeshoSkuPeriodData   (gross = Quantity × Supplier Listed Price)
//   Shopify   fetchShopifyOrders        (order totals of non-cancelled orders)
//   Ads       loadMarketplaceAds / loadSpendWindows (as the Overall page)
// A source that fails is listed in `errors` and its series are left empty — never filled with zeros.

import { loadAmazonSkuPeriodData, type PeriodWindow } from "@/lib/amazonSkuPeriodData";
import { loadMeeshoSkuPeriodData } from "@/lib/meeshoSkuPeriodData";
import { loadFlipkartOrderData, isCountedFlipkartLine } from "@/lib/channelSummary";
import { fetchShopifyOrders } from "@/lib/shopifyOrders";
import { fetchBarmOnlineOrders } from "@/lib/barmOnlineOrders";
import { supabasePublic } from "@/lib/supabasePublic";
import { shopifyCompleteFrom } from "./analytics";
import { loadMarketplaceAds, loadSpendWindows } from "@/lib/overallData";
import { resolveDailySpend } from "@/lib/adSpendDailyRules";
import { fetchAllRows } from "@/lib/amazonReportShared";
import { DEFAULT_GST_MULTIPLIER } from "@/lib/masterProductSkuid";
import { addDaysIso } from "@/lib/bi/forecast";
import { effectiveDate, monthStartOf, dayLabel, type MisMarketplace } from "@/lib/misInvoiceRules";
import { loadMisProductLines, misCoverage, type MisProductLine } from "@/lib/misInvoiceData";
import type { BiAdChannel, BiCampaign, BiChannel, BiDataset, BiIntervals, BiProduct, BiStock, BiWarehouseStock, SalesChannelId, Series } from "@/lib/bi/types";

/** First day the order history covers (Amazon and Flipkart MIS start on 15 Apr 2026). */
export const HISTORY_START = "2026-04-15";
const PRODUCT_DAYS = 120;

const istYesterday = () => addDaysIso(new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10), -1);

function dayRange(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end && out.length < 1000; d = addDaysIso(d, 1)) out.push(d);
  return out;
}

type DayAgg = Map<string, { revenue: number; units: number; returns: number }>;
type SkuDayAgg = Map<string, { name: string; category: string | null; days: Map<string, { units: number; revenue: number; returns: number }> }>;

/** A channel series: null before its first day with data and after its last; 0 on covered days without sales. */
function toChannel(id: SalesChannelId, label: string, basis: string, returnsTracked: boolean, dates: string[], agg: DayAgg, dataThrough: string | null): BiChannel {
  const withSales = [...agg.entries()].filter(([, v]) => v.units > 0 || v.revenue > 0).map(([d]) => d).sort();
  const first = withSales[0] ?? null;
  const last = dataThrough ?? withSales[withSales.length - 1] ?? null;
  const covered = (d: string) => !!first && !!last && d >= first && d <= last;
  const pick = (k: "revenue" | "units" | "returns"): Series => dates.map((d) => (covered(d) ? agg.get(d)?.[k] ?? 0 : null));
  return { id, label, basis, firstDate: first, dataThrough: last, revenue: pick("revenue"), units: pick("units"), returns: pick("returns"), returnsTracked };
}

function toProducts(channel: SalesChannelId, agg: SkuDayAgg, productDates: string[]): BiProduct[] {
  const out: BiProduct[] = [];
  for (const [sku, v] of agg) {
    const units = productDates.map((d) => v.days.get(d)?.units ?? 0);
    if (!units.some((u) => u > 0)) continue;
    out.push({
      channel, sku, name: v.name || sku, category: v.category,
      units, revenue: productDates.map((d) => v.days.get(d)?.revenue ?? 0), returns: productDates.map((d) => v.days.get(d)?.returns ?? 0),
    });
  }
  return out;
}

function addTo(agg: DayAgg, d: string, revenue: number, units: number, returns: number) {
  const cur = agg.get(d) || { revenue: 0, units: 0, returns: 0 };
  cur.revenue += revenue; cur.units += units; cur.returns += returns;
  agg.set(d, cur);
}
function addSku(agg: SkuDayAgg, sku: string, name: string, category: string | null, d: string, units: number, revenue: number, returns: number) {
  let s = agg.get(sku);
  if (!s) { s = { name, category, days: new Map() }; agg.set(sku, s); }
  if (!s.name && name) s.name = name;
  if (!s.category && category) s.category = category;
  const cur = s.days.get(d) || { units: 0, revenue: 0, returns: 0 };
  cur.units += units; cur.revenue += revenue; cur.returns += returns;
  s.days.set(d, cur);
}

// Period loaders (Amazon, Meesho) take one period per day: the same rules as their weekly reports,
// split by day.
async function fromPeriodLoader(kind: "amazon" | "meesho", periods: PeriodWindow[], productFrom: string) {
  const data = kind === "amazon"
    ? await loadAmazonSkuPeriodData({ periods, includeAds: false, includeStock: false, fillFromDailyUpload: true })
    : await loadMeeshoSkuPeriodData({ periods });
  const daily: DayAgg = new Map();
  const skus: SkuDayAgg = new Map();
  for (const p of data.visibleRows) {
    for (const pd of periods) {
      const s = p.periods[pd.label];
      if (!s) continue;
      const revenue = kind === "amazon" ? s.price * s.orders : s.grossSales ?? 0;
      if (!s.orders && !revenue && !s.allReturns) continue;
      addTo(daily, pd.label, revenue, s.orders, s.allReturns);
      if (pd.label >= productFrom) addSku(skus, p.sku, p.name, data.catBySku?.get(p.sku) ?? null, pd.label, s.orders, revenue, s.allReturns);
    }
  }
  // Units the report rules leave out: SKUs whose category is "Other" (no master mapping) or
  // "Discontinued" (the same rule as the weekly reports). Counted for the last 30 days so the page can say so.
  const last30 = new Set(periods.slice(-30).map((p) => p.label));
  let excludedUnits = 0;
  for (const [cat, c] of data.categoryAgg) {
    if (cat !== "Other" && cat !== "Discontinued") continue;
    for (const [label, v] of Object.entries(c.periods)) if (last30.has(label)) excludedUnits += v.units;
  }
  return { daily, skus, dataThrough: data.dataThrough ? String(data.dataThrough).slice(0, 10) : null, excludedUnits };
}

async function flipkart(start: string, end: string, productFrom: string) {
  const { orderRows, returnRows, priceBySku, dataThrough } = await loadFlipkartOrderData(start, end);
  const daily: DayAgg = new Map();
  const skus: SkuDayAgg = new Map();
  for (const r of orderRows) {
    const d = r.order_date ? String(r.order_date).slice(0, 10) : null;
    if (!d || d < start || d > end || !isCountedFlipkartLine(r)) continue;
    const qty = Number(r.quantity) || 0;
    const sku = String(r.sku || "").trim();
    const revenue = qty * (priceBySku.get(sku) || 0);
    addTo(daily, d, revenue, qty, 0);
    if (d >= productFrom && sku) addSku(skus, sku, String((r as { product_title?: string }).product_title || sku), null, d, qty, revenue, 0);
  }
  for (const r of returnRows) {
    const d = r.return_requested_date ? String(r.return_requested_date).slice(0, 10) : null;
    if (!d || d < start || d > end) continue;
    const qty = Number(r.quantity) || 0;
    addTo(daily, d, 0, 0, qty);
    const sku = String(r.sku || "").trim();
    if (d >= productFrom && sku) addSku(skus, sku, "", null, d, 0, 0, qty);
  }
  return { daily, skus, dataThrough, unpriced: [...new Set(orderRows.filter((r) => !priceBySku.has(String(r.sku || "").trim())).map((r) => String(r.sku || "").trim()))].length };
}

/** A calendar day from the formats the website tables use: "DD-MM-YYYY hh:mm:ss", "DD.MM.YYYY" or ISO. */
export function parseDay(v: unknown): string | null {
  const s = String(v ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{4})/);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12 || Number(m[1]) < 1 || Number(m[1]) > 31) return null;
  return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

// B-ARM's own website before the move to Shopify: barm_online_orders (with the B-ARM Overview's rules:
// Received orders only, Order Total Amount once per order), barm_offline_orders (units only — the
// table has no prices) and barm_website_returns (by received date).
async function barmWebsite(start: string, end: string, productFrom: string) {
  const [online, offline, returns] = await Promise.all([
    fetchBarmOnlineOrders(),
    fetchAllRows("barm_offline_orders", (q) => q),
    fetchAllRows("barm_website_returns", (q) => q),
  ]);
  const daily: DayAgg = new Map();
  const skus: SkuDayAgg = new Map();
  const saleDays: string[] = [];
  for (const o of online) {
    const d = o.order_date;
    if (d < start || d > end) continue;
    const qty = o.lines.reduce((s, l) => s + l.quantity, 0);
    addTo(daily, d, o.total, qty, 0); saleDays.push(d);
    // a multi-product order's total is not split across its products (the B-ARM Overview's rule)
    if (d >= productFrom) for (const l of o.lines) addSku(skus, l.sku, l.name || l.sku, null, d, l.quantity, o.lines.length === 1 ? o.total : 0, 0);
  }
  let offlineUnits = 0;
  for (const r of offline as Record<string, unknown>[]) {
    const d = parseDay(r["Date"]);
    const qty = Number(r["Quantity"]) || 0;
    if (!d || d < start || d > end || qty <= 0) continue;
    const revenue = Number(r["Total Price"]) || 0;
    addTo(daily, d, revenue, qty, 0); saleDays.push(d); offlineUnits += qty;
    const sku = String(r["SKU ID"] ?? "").trim();
    if (d >= productFrom && sku) addSku(skus, sku, String(r["Product"] ?? "") || sku, null, d, qty, revenue, 0);
  }
  let returnUnits = 0;
  for (const r of returns as Record<string, unknown>[]) {
    const d = parseDay(r.received_date) ?? parseDay(r.order_date);
    const qty = Number(r.quantity) || 0;
    if (!d || d < start || d > end || qty <= 0) continue;
    addTo(daily, d, 0, 0, qty); returnUnits += qty;
    const sku = String(r.sku_id ?? "").trim();
    if (d >= productFrom && sku && skus.has(sku)) addSku(skus, sku, "", null, d, 0, 0, qty);
  }
  const last = saleDays.sort().pop() ?? null;
  const onlineThrough = online.map((o) => o.order_date).sort().pop() ?? null;
  return { daily, skus, dataThrough: last, onlineThrough, offlineUnits, returnUnits, orders: online.length };
}

/** Warehouse stock per master product: current_stock's "Final Stock in Warehouse", replaced by
 *  current_stock_override where someone has edited it. */
async function warehouseStock(): Promise<BiWarehouseStock[]> {
  const [cur, ovr] = await Promise.all([fetchAllRows("current_stock", (q) => q), fetchAllRows("current_stock_override", (q) => q, "product")]);
  const out = new Map<string, BiWarehouseStock>();
  for (const r of cur as Record<string, unknown>[]) {
    const product = String(r["Product name"] ?? "").trim();
    if (!product) continue;
    out.set(product.toLowerCase(), { product, stock: Number(r["Final Stock in Warehouse"]) || 0, source: "current_stock", asOf: r.created_at ? String(r.created_at).slice(0, 10) : null });
  }
  for (const r of ovr as Record<string, unknown>[]) {
    const product = String(r.product ?? "").trim();
    if (!product) continue;
    out.set(product.toLowerCase(), { product, stock: Number(r.stock) || 0, source: "override", asOf: r.edited_at ? String(r.edited_at).slice(0, 10) : null });
  }
  return [...out.values()];
}

/** The report window from the single row of Intervals. */
async function intervals(): Promise<BiIntervals | null> {
  const { data, error } = await supabasePublic.from("Intervals").select("*").order("id", { ascending: false }).limit(1);
  if (error) throw new Error(`Intervals: ${error.message}`);
  const r = data?.[0] as Record<string, unknown> | undefined;
  if (!r) return null;
  const v = { from30: parseDay(r["From Date 30D"]), to30: parseDay(r["To Date 30D"]), from7: parseDay(r["From Date 7D"]), to7: parseDay(r["To Date 7D"]) };
  if (!v.from30 || !v.to30 || !v.from7 || !v.to7 || v.from30 > v.to30 || v.from7 > v.to7) return null;
  return { from30: v.from30, to30: v.to30, from7: v.from7, to7: v.to7, setAt: r.created_at ? String(r.created_at).slice(0, 10) : null };
}

async function shopify(start: string, end: string, productFrom: string) {
  const all = await fetchShopifyOrders();
  const completeFrom = shopifyCompleteFrom(all);
  const orders = completeFrom ? all.filter((o) => o.order_date >= completeFrom) : all;
  const daily: DayAgg = new Map();
  const skus: SkuDayAgg = new Map();
  for (const o of orders) {
    if (o.order_date < start || o.order_date > end || o.is_cancelled) continue;
    addTo(daily, o.order_date, o.total, o.item_quantity, 0);
    if (o.order_date >= productFrom) for (const it of o.items) {
      const sku = String(it.sku || it.title || "").trim();
      if (sku) addSku(skus, sku, it.title || sku, null, o.order_date, Number(it.quantity) || 0, Number(it.line_total) || 0, 0);
    }
  }
  return { daily, skus, orders, completeFrom, skippedOrders: all.length - orders.length };
}

function adSeries(dates: string[], rows: { date: string; spend: number; sales: number }[]) {
  const by = new Map<string, { spend: number; sales: number }>();
  for (const r of rows) {
    const d = String(r.date).slice(0, 10);
    const cur = by.get(d) || { spend: 0, sales: 0 };
    cur.spend += r.spend; cur.sales += r.sales;
    by.set(d, cur);
  }
  const days = [...by.keys()].sort();
  const first = days[0], last = days[days.length - 1];
  const inside = (d: string) => !!first && d >= first && d <= last;
  return {
    // a day inside the range with no report row is missing, not zero spend
    spend: dates.map((d) => (inside(d) ? by.get(d)?.spend ?? null : null)),
    sales: dates.map((d) => (inside(d) ? by.get(d)?.sales ?? null : null)),
    adsThrough: last ?? null,
  };
}

// Incremental refresh. Re-reading seven months of orders and ads takes 1–2 minutes on this
// database, but orders older than a few weeks no longer change. So between full builds only the
// last ORDER_REFRESH_DAYS of orders and ADS_REFRESH_DAYS of ads are re-read, and older days are
// copied from the previous build. A full re-read runs at least every FULL_REBUILD_HOURS, and
// whenever the previous build had a failed source.
// ── B-ARM ERP invoice figures ─────────────────────────────────────────────────
// For the days the ERP's monthly invoice reports cover, Amazon / Flipkart / Meesho revenue, units
// and returns are the ERP's (as its "MIS Data's" page and the Overall page show them); other days
// stay from the order reports. Rules: misInvoiceRules.ts.
type MisKey = "amazon" | "flipkart" | "meesho";
const MIS_NAME: Record<MisKey, MisMarketplace> = { amazon: "Amazon", flipkart: "Flipkart", meesho: "Meesho" };

async function loadMis(key: MisKey, refreshFrom: string, prevCov: { start: string; end: string } | null | undefined) {
  const cov = await misCoverage(MIS_NAME[key]);
  if (!cov) return { cov: null, from: null, lines: [] as MisProductLine[] };
  // re-read only recent months when the previous build used the same ERP months; all of them otherwise
  const same = !!prevCov && prevCov.start === cov.start && prevCov.end === cov.end;
  const from = same ? (refreshFrom > cov.start ? refreshFrom : cov.start) : cov.start;
  if (from > cov.end) return { cov, from: null, lines: [] as MisProductLine[] };
  return { cov, from, lines: await loadMisProductLines(MIS_NAME[key], from, cov.end) };
}

/** Replace the days [from, cov.end] of a channel (and its products) with the ERP's figures. */
function applyMis(src: { daily: DayAgg; skus: SkuDayAgg }, lines: MisProductLine[], from: string, to: string, productFrom: string) {
  for (const d of [...src.daily.keys()]) if (d >= from && d <= to) src.daily.delete(d);
  for (const s of src.skus.values()) for (const d of [...s.days.keys()]) if (d >= from && d <= to) s.days.delete(d);
  for (const l of lines) {
    const d = effectiveDate(l);
    if (!d || d < from || d > to) continue;
    const q = Number(l.quantity) || 0;
    const revenue = Number(l.sales_with_tax) || 0;
    const units = q > 0 ? q : 0;
    const returns = q < 0 ? -q : 0;
    addTo(src.daily, d, revenue, units, returns);
    const sku = String(l.sku || "").trim();
    if (d >= productFrom && sku) addSku(src.skus, sku, String(l.product_name || ""), l.category && l.category !== "Unmapped" ? l.category : null, d, units, revenue, returns);
  }
}

export const ORDER_REFRESH_DAYS = 35;
export const ADS_REFRESH_DAYS = 100; // the campaign table needs ~60 days before the last ads day
export const FULL_REBUILD_HOURS = 24;

export function canBuildIncrementally(prev: BiDataset | null | undefined, now = Date.now()): prev is BiDataset {
  if (!prev || prev.errors.length || !prev.dates.length || prev.dates[0] !== HISTORY_START || !prev.misCoverage) return false;
  const full = Date.parse(prev.fullBuiltAt ?? "");
  return Number.isFinite(full) && now - full < FULL_REBUILD_HOURS * 3_600_000;
}

/** Copy a channel's days before `before` (and its products' days) from the previous build. */
function seedFromPrevious(prev: BiDataset, id: SalesChannelId, before: string, productFrom: string, src: { daily: DayAgg; skus: SkuDayAgg }) {
  const ch = prev.channels.find((c) => c.id === id);
  if (ch) prev.dates.forEach((d, i) => {
    if (d >= before || ch.revenue[i] === null) return;
    addTo(src.daily, d, ch.revenue[i] ?? 0, ch.units[i] ?? 0, ch.returns[i] ?? 0);
  });
  for (const p of prev.products) {
    if (p.channel !== id) continue;
    prev.productDates.forEach((d, i) => {
      if (d >= before || d < productFrom || (!p.units[i] && !p.revenue[i] && !p.returns[i])) return;
      addSku(src.skus, p.sku, p.name, p.category, d, p.units[i], p.revenue[i], p.returns[i]);
    });
  }
}

export async function buildBiDataset(previous?: BiDataset | null): Promise<BiDataset> {
  const asOf = istYesterday();
  const dates = dayRange(HISTORY_START, asOf);
  const productDates = dates.slice(-PRODUCT_DAYS);
  const productFrom = productDates[0];
  const periods: PeriodWindow[] = dates.map((d) => ({ label: d, start: d, end: d }));
  const inc = canBuildIncrementally(previous) ? previous : null;
  const orderFrom = inc ? addDaysIso(asOf, -(ORDER_REFRESH_DAYS - 1)) : HISTORY_START;
  const adsFrom = inc ? addDaysIso(asOf, -(ADS_REFRESH_DAYS - 1)) : HISTORY_START;
  const errors: BiDataset["errors"] = [];
  const notes: string[] = [];
  // One retry per source: this database has short bursts of statement timeouts under load, and a
  // second attempt a few seconds later usually succeeds. A source that fails twice is reported.
  const timings: Record<string, number> = {};
  const attempt = async <T,>(source: string, run: () => Promise<T>): Promise<T | null> => {
    const t0 = Date.now();
    try { return await run(); } catch {
      await new Promise((r) => setTimeout(r, 3000));
      try { return await run(); } catch (e) { errors.push({ source, message: e instanceof Error ? e.message : String(e) }); return null; }
    } finally { timings[source] = Math.round((Date.now() - t0) / 100) / 10; }
  };

  // The three large order reads run one after another, not together: run in parallel they compete
  // for this busy database and push each other past its 3-second statement limit. The light reads
  // (Shopify, ads, stock) run alongside them.
  const misCov: NonNullable<BiDataset["misCoverage"]> = {};
  const heavy = (async () => {
    const amazon = await attempt("Amazon orders", () => fromPeriodLoader("amazon", periods.filter((p) => p.label >= orderFrom), productFrom));
    const flip = await attempt("Flipkart orders", () => flipkart(orderFrom, asOf, productFrom));
    if (inc) {
      if (amazon) seedFromPrevious(inc, "amazon", orderFrom, productFrom, amazon);
      if (flip) seedFromPrevious(inc, "flipkart", orderFrom, productFrom, flip);
    }
    const meesho = await attempt("Meesho orders", () => fromPeriodLoader("meesho", periods, productFrom));
    // the ERP's invoice figures replace the days its reports cover (one marketplace at a time)
    for (const [key, src] of [["amazon", amazon], ["flipkart", flip], ["meesho", meesho]] as const) {
      if (!src) continue;
      const m = await attempt(`B-ARM ERP invoices (${MIS_NAME[key]})`, () => loadMis(key, monthStartOf(orderFrom), inc?.misCoverage?.[key]));
      if (!m) continue;
      misCov[key] = m.cov;
      if (m.cov && m.from) applyMis(src, m.lines, m.from, m.cov.end, productFrom);
    }
    return [amazon, flip, meesho] as const;
  })();
  const [[am, fk, ms], sh, web, wh, iv, adAm, adFk, adMs, gWin, mWin, stockRows] = await Promise.all([
    heavy,
    attempt("Shopify orders", () => shopify(HISTORY_START, asOf, productFrom)),
    attempt("B-ARM website orders", () => barmWebsite(HISTORY_START, asOf, productFrom)),
    attempt("Warehouse stock", warehouseStock),
    attempt("Intervals", intervals),
    attempt("Amazon ads", () => loadMarketplaceAds("amazon", adsFrom, asOf)),
    attempt("Flipkart ads", () => loadMarketplaceAds("flipkart", adsFrom, asOf)),
    attempt("Meesho ads", () => loadMarketplaceAds("meesho", adsFrom, asOf)),
    attempt("Google Ads spend", () => loadSpendWindows("google", HISTORY_START, asOf)),
    attempt("Meta Ads spend", () => loadSpendWindows("meta", HISTORY_START, asOf)),
    attempt("Amazon FBA stock", () => fetchAllRows("barm_amazon_fba_inventory", (q) => q, "id", "id,sku,product_name,afn_fulfillable_quantity,snapshot_date,created_at")),
  ]);

  const empty: DayAgg = new Map();
  const erp = (key: MisKey, other: string) => {
    const c = misCov[key];
    return c ? `${dayLabel(c.start)} – ${dayLabel(c.end)}: B-ARM ERP invoiced sales incl. tax, before returns (as its MIS Data's page). Other days: ${other}` : other;
  };
  const channels: BiChannel[] = [
    toChannel("amazon", "Amazon", erp("amazon", "order item price × units, cancelled excluded (as the Amazon Overview)"), true, dates, am?.daily ?? empty, am?.dataThrough ?? null),
    toChannel("flipkart", "Flipkart", erp("flipkart", "listing price × units, computed (as the Flipkart Overview)"), true, dates, fk?.daily ?? empty, fk?.dataThrough ?? null),
    toChannel("meesho", "Meesho", erp("meesho", "quantity × supplier listed price, before returns (as the Meesho Overview)"), true, dates, ms?.daily ?? empty, ms?.dataThrough ?? null),
    toChannel("shopify", "Shopify", "Order totals of non-cancelled orders, incl. shipping and tax", false, dates, sh?.daily ?? empty, null),
    // still active: offline orders keep coming after the website moved to Shopify
    toChannel("barm", "B-ARM website & offline", "Old website (WooCommerce) order totals of Received orders, plus offline orders (units only — no prices on file)", true, dates, web?.daily ?? empty, web?.dataThrough ?? null),
  ];
  for (const [label, src] of [["Amazon", am], ["Meesho", ms]] as const) {
    if (src && src.excludedUnits > 0) notes.push(`${label}: ${Math.round(src.excludedUnits).toLocaleString("en-IN")} units sold in the last 30 days are in products with no category ("Other") or marked Discontinued, and are left out — the same rule as the ${label} Overview and weekly report. Map these SKUs in Master to include them.`);
  }
  if (sh && sh.skippedOrders > 0) notes.push(`Shopify: order history before ${sh.completeFrom!.split("-").reverse().join(".")} has gaps in the order numbers (orders before the webhooks went live were only partly back-filled), so Shopify is counted from that date. ${sh.skippedOrders} earlier orders are left out.`);
  if (web) notes.push(`B-ARM website: website orders (barm_online_orders) run to ${web.onlineThrough ? web.onlineThrough.split("-").reverse().join(".") : "—"}, when the site moved to Shopify; since then this channel is offline orders only. Offline orders (barm_offline_orders, ${web.offlineUnits.toLocaleString("en-IN")} units) have no prices, so they add units but no revenue. Returns come from barm_website_returns (${web.returnUnits} units).`);
  if (wh && wh.length === 0) notes.push("Warehouse stock: current_stock and current_stock_override can only be read by signed-in database users, so the dashboard (public key) gets no rows. The warehouse column stays empty until read access is granted — a database security change, held with Phase 6.");
  if (fk && fk.unpriced > 0) notes.push(`Flipkart: ${fk.unpriced} SKUs have no listing price, so their units add ₹0 to Flipkart revenue.`);

  const products: BiProduct[] = [
    ...(am ? toProducts("amazon", am.skus, productDates) : []),
    ...(fk ? toProducts("flipkart", fk.skus, productDates) : []),
    ...(ms ? toProducts("meesho", ms.skus, productDates) : []),
    ...(sh ? toProducts("shopify", sh.skus, productDates) : []),
    ...(web ? toProducts("barm", web.skus, productDates) : []),
  ];

  // ads
  const ads: BiAdChannel[] = [];
  const marketAds: [BiAdChannel["id"], string, typeof adAm, string][] = [
    ["amazon", "Amazon Ads", adAm, "Sales the Amazon ads reports attribute to ads (7/14-day)"],
    ["flipkart", "Flipkart Ads", adFk, "Revenue the Flipkart ads report attributes to ads"],
    ["meesho", "Meesho Ads", adMs, "Ad orders × the product's average Meesho price (estimated)"],
  ];
  for (const [id, label, rows, basis] of marketAds) {
    if (!rows) continue;
    const s = adSeries(dates, rows);
    // days before the re-read range come from the previous build (same dates from HISTORY_START)
    const p = inc?.ads.find((a) => a.id === id);
    if (p) dates.forEach((d, i) => { if (d < adsFrom && i < p.spend.length) { s.spend[i] = p.spend[i]; s.sales[i] = p.sales[i]; } });
    ads.push({ id, label, spend: s.spend, sales: s.sales, adsThrough: s.adsThrough ?? p?.adsThrough ?? null, salesBasis: basis });
  }
  for (const [id, label, win, channel] of [["google", "Google Ads", gWin, "google_ads"], ["meta", "Meta Ads", mWin, "meta_ads"]] as const) {
    if (!win) continue;
    const resolved = resolveDailySpend(win, HISTORY_START, asOf);
    const spendByDay = new Map(resolved.days.filter((d) => d.source && d.spend !== null).map((d) => [d.date, d.spend as number]));
    const salesByDay = new Map<string, number>();
    for (const o of sh?.orders ?? []) if (!o.is_cancelled && o.ad_channel === channel) salesByDay.set(o.order_date, (salesByDay.get(o.order_date) || 0) + o.total);
    const days = [...spendByDay.keys()].sort();
    ads.push({
      id, label, adsThrough: days[days.length - 1] ?? null,
      spend: dates.map((d) => (spendByDay.has(d) ? spendByDay.get(d)! : null)),
      // sales unknown before the Shopify history is complete
      sales: dates.map((d) => (spendByDay.has(d) && sh && (!sh.completeFrom || d >= sh.completeFrom) ? salesByDay.get(d) ?? 0 : null)),
      salesBasis: sh ? `Shopify orders whose visit came from ${label}` : "Shopify orders unavailable",
    });
  }

  // campaigns: last 30 days of each marketplace's ads, ending on the earliest last ads day among them
  const lastAdDays = ads.filter((a) => ["amazon", "flipkart", "meesho"].includes(a.id) && a.adsThrough).map((a) => a.adsThrough!).sort();
  const cEnd = lastAdDays[0] ?? asOf;
  const campaignWindow = { start: addDaysIso(cEnd, -29), end: cEnd, prevStart: addDaysIso(cEnd, -59), prevEnd: addDaysIso(cEnd, -30) };
  const campaigns: BiCampaign[] = [];
  for (const [id, , rows] of marketAds) {
    if (!rows) continue;
    const by = new Map<string, BiCampaign>();
    for (const r of rows) {
      const d = String(r.date).slice(0, 10);
      const cur = d >= campaignWindow.start && d <= campaignWindow.end;
      const prev = d >= campaignWindow.prevStart && d <= campaignWindow.prevEnd;
      if (!cur && !prev) continue;
      const c = by.get(r.name) || { channel: id, name: r.name, spend: 0, sales: 0, orders: 0, prevSpend: 0, prevSales: 0 };
      if (cur) { c.spend += r.spend; c.sales += r.sales; c.orders += r.orders; } else { c.prevSpend += r.spend; c.prevSales += r.sales; }
      by.set(r.name, c);
    }
    campaigns.push(...by.values());
  }
  if (lastAdDays.length && lastAdDays[lastAdDays.length - 1] !== cEnd) notes.push(`Campaign figures cover ${campaignWindow.start} to ${cEnd}, the last day every marketplace's ads are uploaded for.`);

  // stock (Amazon FBA "Available" from the latest uploaded FBA Inventory report)
  const stock: BiStock[] = [];
  if (stockRows) {
    const bySku = new Map<string, BiStock>();
    for (const r of stockRows as { sku?: string; product_name?: string; afn_fulfillable_quantity?: number; snapshot_date?: string; created_at?: string }[]) {
      const sku = String(r.sku || "").trim();
      if (!sku) continue;
      const cur = bySku.get(sku) || { sku, name: String(r.product_name || sku), available: 0, asOf: r.snapshot_date || (r.created_at ? String(r.created_at).slice(0, 10) : null) };
      cur.available += Number(r.afn_fulfillable_quantity) || 0;
      bySku.set(sku, cur);
    }
    stock.push(...bySku.values());
  }

  if (!channels.some((c) => c.id === "shopify" && c.firstDate)) notes.push("Shopify order history is not available.");
  notes.push("Year-on-year comparisons start in April 2027: order history begins on 15 Apr 2026.");

  return {
    generatedAt: new Date().toISOString(), asOf, dates, channels, productDates, products, ads,
    misCoverage: misCov, campaignWindow, campaigns, timings, buildKind: inc ? "incremental" : "full", fullBuiltAt: inc ? inc.fullBuiltAt : new Date().toISOString(), stock, warehouse: wh ?? [], intervals: iv ?? null, gstMultiplier: DEFAULT_GST_MULTIPLIER, errors, notes,
  };
}
