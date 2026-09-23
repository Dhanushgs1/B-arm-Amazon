import * as XLSX from "xlsx-js-style";
import { fetchAllRows, isCancelledOrder, isStandardOrderId, istDayWindowUtc } from "@/lib/amazonReportShared";
import { upsertInChunks } from "@/lib/amazonReportUpload";
import { toDate as parseFlexibleDate } from "@/lib/meeshoReportUpload";
import { resolveProductName } from "@/lib/categoryMap";
import { fetchProductMasterMap, buildProductMasterResolver } from "@/lib/productMasterUpload";
import { fetchMasterSkuidMap, buildMasterSkuidResolver, fetchMasterSkuidAmazonCatalog, fetchMasterSkuidsByName, gstMultiplierFromTax, DEFAULT_GST_MULTIPLIER } from "@/lib/masterProductSkuid";
import { fetchProductMarketingMap, buildProductMarketingResolver } from "@/lib/productMarketingUpload";
import { SITE_URL } from "@/lib/siteUrl";

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
//   Spend(with tax) = raw ad spend x (1 + that product's own GST rate), applied
//                      once after summing raw spend for the window — never a
//                      per-row multiply. The rate comes from master_product_skuid's
//                      per-SKU Tax column (most products are 5%, not the flat 18%
//                      every report assumed before this was wired in); a SKU with
//                      no Tax on file falls back to DEFAULT_GST_MULTIPLIER (18%).
//   CPC  = Spend(with tax) / Orders        (Orders = 0 -> CPC = Spend(with tax))
//   ACOS = Spend (WITHOUT tax) / that SKU's own ad-attributed sales figure, when one is on
//          file for this window — Amazon's raw Sponsored Products Spend / "7 Day Total Sales"
//          straight off the ad platform's own export whenever that SKU has a Sponsored Products
//          row on file (per the seller's explicit request that ACOS match Amazon's own raw
//          export number-for-number, even though that can disagree sharply with the Orders/CPC
//          columns beside it), or Flipkart's ads-export "Total Revenue" / Meesho's ad-attributed
//          order count x price otherwise (see computeAcos's adAttributedSales/adSales/adOrders
//          branches). Falls back to Spend (WITHOUT tax) / Total Sales — real per-order revenue,
//          NOT CPC/Price, which is tax-inclusive — only when none of the above is on file at all
//          (an Amazon SKU with no Sponsored Products row, i.e. SB/SD-only spend; or a Flipkart/
//          Meesho product with no ad-attributed sales data of its own).
// "Orders" here means units sold of that product in the window (order-report
// quantity, cancelled orders excluded) — not ad-click-attributed units and not
// order records. This is a deliberate choice (see the Notes sheet) so the
// figure means the same thing as the plain-English "Orders" column on the
// hand-built workbook this report is modelled on.

export type Platform = "Amazon" | "Flipkart" | "Meesho";

// Campaigns spending at or under this on the single reporting day are flagged
// on the "Low Spend Campaigns" sheet as candidates for pausing/pruning.
const LOW_SPEND_THRESHOLD = 50;
// A product needs more than this much range spend to be eligible for either
// ACOS shortlist (Summary's "Worst ACOS product" or the Worst ACOS Products
// sheet) — a separate, higher bar than LOW_SPEND_THRESHOLD above, since a
// barely-cleared low-spend campaign can still show a misleading ACOS.
const ACOS_SHORTLIST_MIN_SPEND = 100;

export function getDateWindow(toDate: string, days: number): { start: string; end: string } {
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
// gstMultiplier travels with the aggregate (set once per product from its own
// master_product_skuid Tax rate — see the tagging pass in
// generateAdSpendReportWorkbook below) rather than living as a single global
// constant, since different products carry different real GST slabs (5%/18%/0%).
// adAttributedSpend/adAttributedSales carry Amazon's own Sponsored Products
// numbers (raw spend and "7 Day Total Sales", both un-adjusted for GST) for
// the ACOS column specifically — per the seller's explicit request that ACOS
// match Amazon's own ad-attributed report number-for-number, even though that
// number can read very differently from this report's Orders/CPC (which stay
// on real order-report units — see computeAcos below and its call sites).
// Left undefined for a SKU with no Sponsored Products row at all (e.g.
// SB/SD-only spend, or Flipkart/Meesho), so computeAcos falls back to the
// real-order-based formula for it instead of reading as a false 0% ACOS.
// revenue: real per-order revenue for this SKU/window — SUM(item-price x quantity) for Amazon,
// SUM(Invoice Amount) for Flipkart, over non-cancelled order rows. Plainly additive across a
// merged product's SKU variants (groupProductsByName just sums it, no dead-spend-style special
// case — unlike adAttributedSpend/Sales, real order revenue from two different real SKUs of one
// product is honestly combinable). Left undefined for Meesho, which still uses the flat
// Price x units estimate everywhere (Summary sheet, SKU Wise Report) per the seller's choice.
// adOrders: ad-attributed order/unit count, for the SKU Wise Report's "Total Ad Orders" column —
// Meesho: "Orders by ad" straight off its own ad report (barm_meesho_ads), i.e. ad-attributed
// order count (Meesho's ad export has no ₹ sales figure the way Amazon's does, only this count) —
// also what Summary's "Ad Sales" column for Meesho multiplies by price, and computeAcos's real
// fallback denominator for Meesho, since Meesho never sets adSales. Amazon: Sponsored Products'
// own "7 Day Total Orders (#)" (orders_7d), gated behind the same hasSpRow check as
// adAttributedSpend/Sales (left undefined for an SB/SD-only SKU, same reasoning as those two) —
// inert for ACOS itself, since computeAcos's adAttributedSales branch already resolves Amazon's
// ACOS first. Flipkart: ads-export direct_units_sold + indirect_units_sold, always defined (never
// gated) since Flipkart's own adSales is always defined too and always wins computeAcos's
// adSalesFigure ternary — also purely a display figure here, inert for ACOS. Plainly additive
// across a merged product's SKU variants, same reasoning as revenue above.
// adSales: Flipkart-only — "Total Revenue" straight off its own ads export (fsnRows,
// barm_flipkart_fsn_report), i.e. the ad platform's own reported revenue for that SKU/window.
// Deliberately separate from adAttributedSpend/adAttributedSales (which drive Amazon's ACOS
// formula in computeAcos) — Flipkart's ACOS stays on the real-order CPC/Price formula per the
// existing design, this field is display-only for Summary's Ad Sales column. Also separate from
// revenue (real per-order revenue from FK ord) — the two can legitimately differ, same as
// Amazon's attributed sales vs. its real order revenue can. Plainly additive across a merged
// product's SKU variants, same reasoning as revenue/adOrders above.
export interface WindowAgg { spend: number; units: number; gstMultiplier?: number; adAttributedSpend?: number; adAttributedSales?: number; revenue?: number; adOrders?: number; adSales?: number; }
const emptyAgg = (): WindowAgg => ({ spend: 0, units: 0 });
export const spendTax = (a: WindowAgg): number => a.spend * (a.gstMultiplier ?? DEFAULT_GST_MULTIPLIER);
export const computeCpc = (a: WindowAgg): number => (a.units > 0 ? spendTax(a) / a.units : spendTax(a));
// Ad Status Report's per-platform 1/0 indicator: real Sales/Orders (a.units) only — per the
// seller's explicit instruction, ad Spend alone must never mark a platform "live" here. A product
// can have real ad spend with zero orders that window; this must read as 0, not 1.
export const adStatusHasSales = (a: WindowAgg): boolean => a.units > 0;
// ACOS = Ad Spend / Ad-Attributed Sales, final answer, per the seller's explicit instruction
// after reconciling a real example against raw data ("Chewy tube (Green - Spiral model)",
// Flipkart, 11-to-17-09-2026: Spend 1,504.01 / Ad Sales 7,587 = 19.8%, matching the seller's own
// manual math exactly). Every platform prefers its own ad-attributed sales figure whenever one is
// on file: Amazon's raw Sponsored Products spend/sales (adAttributedSpend/adAttributedSales, no
// GST added, matching the raw export exactly), Flipkart's ads-export "Total Revenue" (adSales), or
// Meesho's ad-attributed order count x price (adOrders x price — Meesho's ad export has no
// currency sales figure directly, only that count, same convention the Summary sheet's own
// summaryAcosCell already used for Flipkart/Meesho). Only when NONE of these are on file at all
// (Amazon SB/SD-only spend with no Sponsored Products row, e.g.) does it fall back to an
// ESTIMATED/PROXY ACOS: raw spend, no GST, over this window's own Total Sales figure (real
// per-order revenue where it's tracked, i.e. Amazon/Flipkart's `revenue`; the flat Price x units
// estimate otherwise, i.e. Meesho, which never populates `revenue` on its WindowAgg).
//
// History: this same ad-attributed-sales branch was added (6f32888), reverted (cd333b5, on the
// grounds that Flipkart/Meesho's ad-attributed revenue is legitimately zero far more often than
// real per-order revenue is, and folding it into this shared function blanked the ACOS column on
// the majority of Ad spend report/SKU Wise Report rows), and is now restored here as the seller's
// own final, explicit call once they'd seen exactly that trade-off spelled out: a SKU with real
// orders but zero ad-attributed sales that window WILL show a blank ACOS here — that is the
// intended reading of "ad spend / ad-attributed sales", not a defect.
//
// The sentinel below is deliberately reused (not Infinity/NaN) for internal comparisons — sorting
// "worst ACOS first" and the Action Sheet's >14% threshold both still want a very-high-but-finite
// number here, since ad spend with zero/unknown sales in a window is exactly the kind of row those
// should surface. Only the user-visible cell/JSON writers (acosCell below) treat it specially,
// blanking it out instead of showing "999%".
export const ACOS_UNDEFINED_SENTINEL = 9.99;
// Real-Orders gate (a.units, the same denominator computeCpc itself uses — NOT Total Ad Orders/
// a.adOrders), per the seller's explicit, later instruction, confirmed a second time after being
// shown it overrides the earlier Amazon exception on purpose: whenever a SKU/window's real Orders
// are 0, ACOS is ALWAYS CPC/Price — never the blank sentinel, and never the Ad Spend/Ad-Attributed
// Sales ratio, even for a genuine Amazon Sponsored Products row or real Flipkart/Meesho ad-order
// data on file for that same SKU/window. This deliberately supersedes the "Amazon's own SP-row
// check always wins" rule from the previous version of this function — confirmed directly with the
// seller (a real SP row with adOrders===0 used to correctly stay blank; it now computes CPC/Price
// instead, on purpose). CPC here is exactly computeCpc(a) — when a.units===0, that's already just
// spendTax(a) (Spend WITH tax), so "CPC = Spend(with tax)" for a zero-Orders row falls out of the
// existing computeCpc definition rather than needing a second formula. Spend=0 (and therefore
// CPC=0) correctly reads as ACOS=0%, not the sentinel — only genuinely unpriced (no listingPrice
// and no price) rows with real spend still fall back to the sentinel, since there's truly nothing
// to divide by. Only when real Orders ARE > 0 does the ad-attribution-preferred logic below run,
// completely unchanged from before this instruction.
export const computeAcos = (a: WindowAgg, price: number, listingPrice?: number): number => {
  if (a.units === 0) {
    const p = listingPrice && listingPrice > 0 ? listingPrice : price;
    if (!p || p <= 0) return a.spend > 0 ? ACOS_UNDEFINED_SENTINEL : 0;
    const cpc = computeCpc(a);
    return cpc > 0 ? cpc / p : 0;
  }
  // Orders > 0 below this point — completely unchanged from before this instruction.
  // Amazon: a real Sponsored Products row always wins.
  if (a.adAttributedSales !== undefined) {
    const spend = a.adAttributedSpend ?? 0;
    return a.adAttributedSales > 0 ? spend / a.adAttributedSales : spend > 0 ? ACOS_UNDEFINED_SENTINEL : 0;
  }
  // Flipkart/Meesho: only a genuine ad-attributed-orders count this window counts as "has ad data".
  if ((a.adOrders ?? 0) > 0) {
    const adSalesFigure = a.adSales !== undefined ? a.adSales : a.adOrders! * price;
    return adSalesFigure > 0 ? a.spend / adSalesFigure : a.spend > 0 ? ACOS_UNDEFINED_SENTINEL : 0;
  }
  // Real Orders exist but no ad-attribution data of any kind -> CPC/Price, per the seller's
  // confirmed instruction, replacing the old real-revenue-proxy fallback entirely.
  const p = listingPrice && listingPrice > 0 ? listingPrice : price;
  if (!p || p <= 0) return a.spend > 0 ? ACOS_UNDEFINED_SENTINEL : 0;
  return computeCpc(a) / p;
};

// Action Sheet only. computeAcos's Sponsored Products branch deliberately keeps a real SP row
// with exactly zero attributed sales this window as the ACOS_UNDEFINED_SENTINEL (a genuinely
// unknown ratio, blanked by acosCell) — correct for Summary/Ad spend report/SKU Wise Report, which
// show it as an honest blank rather than guess. The Action Sheet is different: it's a worksheet
// built to be ACTED on, and per the seller's explicit report against a real export (a Suture
// thread-KT row: Orders 1, Spend without tax ₹436.86, Price ₹721, Total Sales ₹721 — a fully
// computable 60.59% — still rendered as the sentinel's literal "999%"), a SKU with real
// Orders/Spend/Price/Total Sales on file should never show that raw sentinel: it reads as a data
// error, not a signal to act on, and (via actionFor below) was also corrupting the recommended
// bid-cut text with a fabricated "7-day ACOS 999%". So here, ANY non-positive Sponsored Products
// attribution (undefined OR present-but-zero) falls back to the same Spend(no tax)/Total Sales
// proxy computeAcos's own SB/SD-only branch already uses — only when that fallback's own
// denominator (Total Sales) is itself 0 does this still return the sentinel, exactly the
// "genuinely nothing to compute from" case the existing >14% threshold check was written to keep
// surfacing (see its own comment below).
export function actionSheetAcos(a: WindowAgg, price: number): number {
  if (a.adAttributedSales !== undefined && a.adAttributedSales > 0) {
    return (a.adAttributedSpend ?? 0) / a.adAttributedSales;
  }
  const totalSales = a.revenue ?? a.units * price;
  if (totalSales > 0) return a.spend / totalSales;
  return a.spend > 0 ? ACOS_UNDEFINED_SENTINEL : 0;
}

// Platform-wide "Overall sales" figures (units sold + realised sale value) —
// unrelated to ad spend, so kept as its own shape rather than overloading
// WindowAgg.spend to mean two different things depending on context.
interface SalesAgg { units: number; value: number; }
const emptySales = (): SalesAgg => ({ units: 0, value: 0 });

export interface ProductRow {
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

// Multiple SKU codes for the same physical product are normal — a product can
// carry several SKU variants (different pack sizes, a re-listing, a spelling
// change) that the product-master table (see resolveName below) already maps
// to one approved product name. Without this, each SKU variant printed as its
// own report row with that same name repeated 4-5x instead of one combined
// row. `p.name` has already been resolved against the master table by the
// time this runs, so grouping on it (rather than on raw SKU) merges every SKU
// variant of one product into a single row, summing its spend/units. The
// merged row keeps every contributing SKU (comma-joined) so it can still be
// traced back to the exact SKUs behind the numbers.
// A SKU code carrying either of these two suffixes is the exact same physical SKU as its base
// counterpart, just tagged for a reason internal to the seller's own listing/master-table setup:
//   - "(Old)" (e.g. "B-CT-Y(Old)") is the same SKU as its current, un-tagged counterpart
//     ("B-CT-Y") — the master table just renamed the product at some point (e.g. "Chewy tube
//     (Yellow)" became "Chewy tube (Yellow) - Spiral model") without changing the underlying SKU.
//   - "-S" (e.g. "A015-S", "B-CT-G-BUMP-S") has no entry of its own in master_product_skuid at
//     all, so it resolves through a different fallback path than its base SKU ("A015",
//     "B-CT-G-BUMP") and lands on a different display name — splitting one product into two
//     incomplete rows even though it's the identical physical SKU.
// Stripped here so groupProductsByName can recognize either overlap and fold the tagged row into
// the base one, instead of printing two near-duplicate rows for one product — per the seller's
// explicit instruction that same name OR same SKU (after stripping either suffix) means one row.
const stripLegacySkuSuffix = (sku: string): string =>
  sku.trim().toLowerCase().replace(/\s*\(old\)\s*$/i, "").replace(/-s$/i, "");
const isLiveSku = (sku: string): boolean => sku.trim().toLowerCase() === stripLegacySkuSuffix(sku);

// Sums two WindowAgg.adAttributedSpend/adAttributedSales values across a merge, keeping the
// "undefined = no Sponsored Products row on file" distinction from computeAcos intact: only
// when both sides are undefined does the merged value stay undefined (falls back to the
// real-order ACOS formula), otherwise a missing side counts as 0 spend/sales contributed.
// Used for BOTH the single reporting day and the range/week window — a product with 2+ SKU/
// ad-group variants gets its day ACOS from the plain total of every variant's own attributed
// spend and sales that day, exactly like the range window already worked and exactly like Spend/
// Orders/CPC already do elsewhere on this same row. (An earlier version of this function picked a
// single "worst" raw row instead of summing, to make day ACOS match one exact row of Amazon's raw
// per-campaign export — reverted per the seller's explicit request: summing is the "obviously
// correct" reading of a merged row's own displayed Spend total, and a displayed Spend that's a sum
// across every variant next to an ACOS computed from only one of them read as self-contradictory,
// which mattered more than preserving an exact single-row match once a product spans more than one
// SKU/ad-group that day.)
const sumOptional = (a?: number, b?: number): number | undefined =>
  a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);

export function groupProductsByName(
  products: ProductRow[],
  // name -> Platform -> full master SKU list (fetchMasterSkuidsByName). When a
  // grouped row's resolved name+platform has an entry here, its "SKU(s)" list
  // comes from the master instead of the window's own transactional SKUs —
  // the master's list is the complete, stable set (e.g. all 5 known variants
  // of a product), while the window-derived set only ever contains whichever
  // SKUs actually had ad spend or orders in that specific day/range.
  masterSkuidsByName?: Map<string, Map<string, string[]>>,
  // sku -> master_product_skuid's own "Product Name" (fetchMasterSkuidMap). A product's own
  // display name (p.name) goes through a resolver chain — master_product_marketing first,
  // then master_product_skuid, then barm_product_master, then a raw fallback — so two sibling
  // SKUs of the exact same physical product can land on two DIFFERENT final display names if
  // only one of them has a master_product_marketing entry. Grouping on p.name alone then prints
  // that one product as two separate rows, each with an incomplete SKU subset and therefore
  // wrong Spend/Orders/ACOS. This second identity source lets the union-find below fold those
  // apart-by-name groups back together whenever master_product_skuid says their SKUs belong to
  // the same product, regardless of what each one's own resolved display name ended up being.
  skuToMasterSkuidName?: Map<string, string>
): ProductRow[] {
  const byName = new Map<string, ProductRow & { skuSet: Set<string> }>();
  products.forEach((p) => {
    const key = p.name.trim().toLowerCase();
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, { ...p, day: { ...p.day }, range: { ...p.range }, skuSet: new Set([p.sku]) });
      return;
    }
    existing.day.spend += p.day.spend;
    existing.day.units += p.day.units;
    existing.day.revenue = sumOptional(existing.day.revenue, p.day.revenue);
    existing.day.adOrders = sumOptional(existing.day.adOrders, p.day.adOrders);
    existing.day.adSales = sumOptional(existing.day.adSales, p.day.adSales);
    existing.day.adAttributedSpend = sumOptional(existing.day.adAttributedSpend, p.day.adAttributedSpend);
    existing.day.adAttributedSales = sumOptional(existing.day.adAttributedSales, p.day.adAttributedSales);
    existing.range.spend += p.range.spend;
    existing.range.units += p.range.units;
    existing.range.revenue = sumOptional(existing.range.revenue, p.range.revenue);
    existing.range.adOrders = sumOptional(existing.range.adOrders, p.range.adOrders);
    existing.range.adSales = sumOptional(existing.range.adSales, p.range.adSales);
    existing.range.adAttributedSpend = sumOptional(existing.range.adAttributedSpend, p.range.adAttributedSpend);
    existing.range.adAttributedSales = sumOptional(existing.range.adAttributedSales, p.range.adAttributedSales);
    if (!existing.price && p.price) existing.price = p.price;
    existing.skuSet.add(p.sku);
  });

  // Second pass — fold one name-group into another when a SKU in one, once its
  // "(Old)" tag is stripped, matches a SKU in the other: same physical product,
  // just renamed in the master table, so it must not print as two rows. Union-
  // find over the name-keys above, joined whenever a normalized SKU is shared.
  const parent = new Map<string, string>([...byName.keys()].map((k) => [k, k]));
  const find = (k: string): string => {
    let root = k;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = k;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const skuNormToKeys = new Map<string, string[]>();
  byName.forEach((group, key) => {
    group.skuSet.forEach((s) => {
      const norm = stripLegacySkuSuffix(s);
      skuNormToKeys.set(norm, [...(skuNormToKeys.get(norm) ?? []), key]);
    });
  });
  skuNormToKeys.forEach((keys) => {
    for (let i = 1; i < keys.length; i++) {
      const ra = find(keys[0]);
      const rb = find(keys[i]);
      if (ra !== rb) parent.set(ra, rb);
    }
  });

  // Third union rule — fold groups together whenever a SKU in each carries the same
  // master_product_skuid "Product Name", even though their own resolved p.name strings
  // differ (see skuToMasterSkuidName's param comment above). Same union-find machinery,
  // just keyed on the master table's identity instead of a normalized SKU string.
  if (skuToMasterSkuidName) {
    const masterNameToKeys = new Map<string, string[]>();
    byName.forEach((group, key) => {
      group.skuSet.forEach((s) => {
        const masterName = skuToMasterSkuidName.get(s)?.trim().toLowerCase();
        if (!masterName) return;
        masterNameToKeys.set(masterName, [...(masterNameToKeys.get(masterName) ?? []), key]);
      });
    });
    masterNameToKeys.forEach((keys) => {
      for (let i = 1; i < keys.length; i++) {
        const ra = find(keys[0]);
        const rb = find(keys[i]);
        if (ra !== rb) parent.set(ra, rb);
      }
    });
  }

  const merged = new Map<string, ProductRow & { skuSet: Set<string>; hasLiveSku: boolean }>();
  byName.forEach((group, key) => {
    const root = find(key);
    const groupHasLive = [...group.skuSet].some(isLiveSku);
    const existing = merged.get(root);
    if (!existing) {
      merged.set(root, { ...group, day: { ...group.day }, range: { ...group.range }, skuSet: new Set(group.skuSet), hasLiveSku: groupHasLive });
      return;
    }
    existing.day.spend += group.day.spend;
    existing.day.units += group.day.units;
    existing.day.revenue = sumOptional(existing.day.revenue, group.day.revenue);
    existing.day.adOrders = sumOptional(existing.day.adOrders, group.day.adOrders);
    existing.day.adSales = sumOptional(existing.day.adSales, group.day.adSales);
    existing.day.adAttributedSpend = sumOptional(existing.day.adAttributedSpend, group.day.adAttributedSpend);
    existing.day.adAttributedSales = sumOptional(existing.day.adAttributedSales, group.day.adAttributedSales);
    existing.range.spend += group.range.spend;
    existing.range.units += group.range.units;
    existing.range.revenue = sumOptional(existing.range.revenue, group.range.revenue);
    existing.range.adOrders = sumOptional(existing.range.adOrders, group.range.adOrders);
    existing.range.adSales = sumOptional(existing.range.adSales, group.range.adSales);
    existing.range.adAttributedSpend = sumOptional(existing.range.adAttributedSpend, group.range.adAttributedSpend);
    existing.range.adAttributedSales = sumOptional(existing.range.adAttributedSales, group.range.adAttributedSales);
    if (!existing.price && group.price) existing.price = group.price;
    group.skuSet.forEach((s) => existing.skuSet.add(s));
    // Prefer the currently-active (non-"(Old)") naming as the merged row's display name — an
    // all-"(Old)" group only keeps its own name if the group it merged with has no live SKU either.
    if (!existing.hasLiveSku && groupHasLive) {
      existing.name = group.name;
      existing.hasLiveSku = true;
    }
  });

  return [...merged.values()].map(({ skuSet, hasLiveSku, ...p }) => {
    const masterSkus = masterSkuidsByName?.get(p.name.trim().toLowerCase())?.get(p.platform);
    const sku = masterSkus && masterSkus.length ? [...masterSkus].sort().join(", ") : [...skuSet].join(", ");
    return { ...p, sku };
  });
}

export interface AdSpendReportOpts {
  /** 'YYYY-MM-DD' — the single reporting day. */
  endDate: string;
  /** Trailing window ending on endDate, inclusive. Defaults to 7 (matches the
   *  hand-built workbook's "Last 7 days" date-range columns). */
  rangeDays?: number;
  accountName?: string;
}

// Amazon/Flipkart order data used to come straight from barm_amazon_am_orders
// / barm_flipkart_order_report, then got redirected to the external MIS
// (SellerMate) pipeline tables via misAdapters.ts's fetchMisAmazonOrders/
// fetchMisFkOrders. That pipeline lags real uploads by days — verified
// directly against Supabase: its amazon_orders/fk_orders tables stopped
// syncing at 27 Aug while the seller's own "Last 7 days" workbook already
// covered through 31 Aug — so Overall sales went blank for every day past
// whatever the MIS pipeline last synced. Reading straight from
// barm_daily_am_orders/barm_daily_fk_orders instead — the per-sheet archival
// mirror combinedAdSpendUpload.ts's one-file upload writes on every run —
// keeps this report in step with whatever was actually uploaded. Trade-off:
// a standalone per-report Orders upload (not the one-file workbook) does NOT
// reach these two mirror tables, only the real barm_amazon_am_orders/
// barm_flipkart_order_report ones — so Overall sales here still needs the
// one-file "Last 7 days" upload to run, not just any Orders upload.
async function fetchDailyAmazonOrders(range: { start: string; end: string }, endDate: string) {
  // Ordered by (report_date, id) instead of fetchAllRows's default "id" — report_date has its own
  // index (barm_daily_am_orders_date_idx) and is what this query filters on, so Postgres can
  // satisfy the ORDER BY directly from that index scan. Ordering by "id" instead forced a separate
  // Sort over every row in the date range on each paginated page, which grew slow enough to hit a
  // statement timeout as the table grew with months of daily uploads. "id" stays as a tiebreaker
  // for .range() pagination stability, same reasoning as fetchAllRows's own comment on ordering.
  const rows = await fetchAllRows(
    "barm_daily_am_orders",
    (q) => q.gte("report_date", range.start).lte("report_date", endDate),
    ["report_date", "id"]
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (rows as any[]).map((r) => {
    const raw = (r.raw as Record<string, unknown>) || {};
    return {
      amazon_order_id: r.order_id,
      order_item_id: String(raw["order-item-id"] ?? r.order_id),
      purchase_datetime: r.purchase_datetime,
      order_status: r.order_status,
      item_status: raw["item-status"] ?? r.order_status,
      sku: r.sku,
      product_name: r.product_name,
      quantity: r.quantity,
      item_price: r.item_price,
      raw,
    };
  });
}

// A handful of rows from an old (since-fixed) upload bug have a null
// report_date in barm_daily_fk_orders despite a perfectly good "Ordered On"
// value sitting in raw — recovered here so those orders aren't silently
// dropped. (Confirmed those nulls only affect a couple of days from a mid-
// August upload; current/recent report windows are unaffected.)
async function fetchDailyFlipkartOrders(range: { start: string; end: string }, endDate: string) {
  // See fetchDailyAmazonOrders's comment — same fix, ordered by the indexed report_date column
  // (barm_daily_fk_orders_date_idx) instead of "id" to avoid the same statement-timeout risk.
  const rows = await fetchAllRows(
    "barm_daily_fk_orders",
    (q) => q.gte("report_date", range.start).lte("report_date", endDate),
    ["report_date", "id"]
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (rows as any[]).map((r) => {
    const raw = (r.raw as Record<string, unknown>) || {};
    return {
      order_item_id: r.order_item_id,
      order_id: r.order_id,
      order_date: r.report_date || parseFlexibleDate(raw["Ordered On"]),
      order_item_status: r.order_status,
      sku: r.sku,
      fsn: r.fsn,
      product_title: r.product_name,
      quantity: r.quantity,
      raw,
    };
  });
}

// ── Amazon ───────────────────────────────────────────────────────────────────
export async function fetchAmazonProducts(
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
  revenueRangeBySku: Map<string, number>;
}> {
  const [spRows, sbRows, sdRows, mapRows, orderRowsRaw, priceRows] = await Promise.all([
    fetchAllRows("barm_amazon_sp_advertised_product", (q) => q.gte("report_date", range.start).lte("report_date", endDate)),
    fetchAllRows("barm_amazon_sb_campaign", (q) => q.gte("report_date", range.start).lte("report_date", endDate)),
    fetchAllRows("barm_amazon_sd_campaign", (q) => q.gte("report_date", range.start).lte("report_date", endDate)),
    // No "id" column on this hand-maintained mapping table — order by its
    // natural key instead (fetchAllRows would otherwise error on "id").
    fetchAllRows("barm_amazon_campaign_sku_map", (q) => q, ["campaign_name", "sku"]),
    fetchDailyAmazonOrders(range, endDate),
    fetchAllRows("barm_amazon_price_listing", (q) => q),
  ]);
  // Amazon's own orders export can carry a literal duplicate line (every
  // column identical), and a duplicate could already be sitting in Supabase
  // from an upload made before combinedAdSpendUpload.ts's replaceRangeRows
  // started deduping exact-duplicate rows on insert — filtered here
  // defensively (same natural key Flipkart's fetchFlipkartProducts already
  // uses below) so a leftover duplicate doesn't double-count units sold until
  // the next full re-upload flushes it out of the table.
  const seenOrderRow = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orderRows = (orderRowsRaw as any[]).filter((r) => {
    const key = `${r.order_item_id}|${r.item_status}|${r.quantity}`;
    if (seenOrderRow.has(key)) return false;
    seenOrderRow.add(key);
    return true;
  });

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

  // Per the seller's explicit choice, Amazon SP spend is always the plain sum of the
  // raw export's own Spend column, per SKU — no correction applied for deleted/archived
  // campaigns whose rows come back with campaign_name and ad_group_name both blank
  // (Amazon repeats that campaign's full daily spend on every SKU it used to target once
  // it's gone, rather than splitting it across them). An earlier version of this code
  // divided such rows evenly across same-day/same-spend clusters to avoid double-counting
  // that repetition, but the seller asked for the report to always match a straight sum
  // of the raw file instead, even though that means a re-surfaced deleted campaign can
  // inflate the total.
  // Amazon's own ad-attributed spend/sales (raw "Spend" and "7 Day Total
  // Sales" columns, un-adjusted for GST), tracked alongside the real-order
  // aggregate above purely so the ACOS column can match the raw Sponsored
  // Products export number-for-number — see computeAcos's adAttributedSales
  // branch. Sponsored Products only (sbRows/sdRows carry no per-SKU sales
  // figure), matching the raw file this is meant to reproduce, which is
  // itself a Sponsored Products Advertised Product report.
  const adSpendRangeBySku = new Map<string, number>();
  const adSalesRangeBySku = new Map<string, number>();
  const adSpendDayBySku = new Map<string, number>();
  const adSalesDayBySku = new Map<string, number>();
  // SKU Wise Report's "Total Ad Orders" column: Amazon's own raw Sponsored Products "7 Day Total
  // Orders (#)" (orders_7d), already stored per-row on barm_amazon_sp_advertised_product but never
  // read anywhere in this function before — summed the same way as adSpend/adSalesRangeBySku above.
  const adOrdersRangeBySku = new Map<string, number>();
  const adOrdersDayBySku = new Map<string, number>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spRows.forEach((r: any) => {
    if (!r.advertised_sku) return;
    const spend = num(r.spend);
    const a = ensureSpend(r.advertised_sku);
    a.spend += spend;
    if (r.report_date === endDate) addCampaignSpend(r.campaign_name || "", spend);

    const sku = r.advertised_sku;
    const sales7d = num(r.sales_7d);
    const orders7d = num(r.orders_7d);
    adSpendRangeBySku.set(sku, (adSpendRangeBySku.get(sku) || 0) + spend);
    adSalesRangeBySku.set(sku, (adSalesRangeBySku.get(sku) || 0) + sales7d);
    adOrdersRangeBySku.set(sku, (adOrdersRangeBySku.get(sku) || 0) + orders7d);
    if (r.report_date === endDate) {
      // A single SKU can itself carry 2+ Sponsored Products rows for the exact same day (seen in
      // practice as a second, otherwise-blank row — no campaign/ad-group/sales columns — sitting
      // alongside the real one). Summed here exactly like the range-window maps two lines above —
      // per the seller's explicit request, day ACOS for a SKU/product is the plain total of every
      // one of its rows' spend and sales that day, matching its own displayed (summed) Spend cell.
      adSpendDayBySku.set(sku, (adSpendDayBySku.get(sku) || 0) + spend);
      adSalesDayBySku.set(sku, (adSalesDayBySku.get(sku) || 0) + sales7d);
      adOrdersDayBySku.set(sku, (adOrdersDayBySku.get(sku) || 0) + orders7d);
    }
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
  // SKU Wise Report's own "Total Sales" column, per the seller's explicit request: real
  // per-order revenue (SUM of item-price x quantity across this SKU's own order rows in the
  // range window) instead of one flat listing Price x total range units — the flat-price
  // version was only ever an estimate and could disagree with what the SKU actually sold for
  // across the week (discounts, mid-week price changes). Scoped to the exact same
  // non-cancelled/standard-order-ID rows as unitsBySku just below, so Total Sales and Orders
  // on that sheet always describe the same set of real sales.
  const revenueBySku = new Map<string, number>();
  const overallDay = emptySales();
  const overallRange = emptySales();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  orderRows.forEach((r: any) => {
    const qty = num(r.quantity);
    // Overall sales QTS/Value: a straight SUM of the Order report's own
    // Quantity/item-price columns for the window — unrelated to ad data, and
    // with no status filter (matches the seller's own manual workbook, which
    // SUMs every order status as-is rather than excluding cancelled/pending
    // ones — those net out on their own once the order settles).
    overallRange.units += qty;
    overallRange.value += num(r.item_price);
    const ts = Date.parse(String(r.purchase_datetime || ""));
    if (Number.isFinite(ts) && ts >= dayGte && ts < dayLt) {
      overallDay.units += qty;
      overallDay.value += num(r.item_price);
    }

    // Per-SKU Orders (feeds the Ad spend report's per-product Orders/CPC/ACOS
    // columns) stays scoped to real, non-cancelled sales — ad-attribution
    // math, a different question from the Overall sales total above.
    if (!r.sku || isCancelledOrder(r) || !isStandardOrderId(r.amazon_order_id)) return;
    ensureUnits(r.sku).units += qty;
    // item-price is already that line's full total (verified against AM ord: a qty-2 row's
    // item-price is exactly double a qty-1 row's, for the same SKU) — never multiply by qty here.
    revenueBySku.set(r.sku, (revenueBySku.get(r.sku) || 0) + num(r.item_price));
  });

  const skus = new Set<string>([...spendBySku.keys(), ...unitsBySku.keys(), ...priceBySku.keys()].filter(Boolean));
  const products = new Map<string, ProductRow>();
  skus.forEach((sku) => {
    const rangeSpend = spendBySku.get(sku)?.spend || 0;
    const daySpend = spendBySkuDay.get(sku) || 0;
    const rangeUnits = unitsBySku.get(sku)?.units || 0;
    // adAttributedSpend/Sales stay undefined for a SKU with no Sponsored
    // Products row at all (SB/SD-only spend) rather than defaulting to 0, so
    // computeAcos falls back to the real-order formula for it instead of
    // reading as a false 0% ACOS.
    const hasSpRow = adSalesRangeBySku.has(sku) || adSpendRangeBySku.has(sku);
    // Day units aren't tracked per-SKU above (only the overall total) — derive
    // them with the same IST-day filter, scoped to this one SKU.
    products.set(sku, {
      platform: "Amazon",
      sku,
      name: resolveProductName(nameBySku.get(sku), sku) || nameBySku.get(sku) || sku,
      price: priceBySku.get(sku) || 0,
      day: {
        spend: daySpend,
        units: 0,
        revenue: 0,
        // adOrders (Sponsored Products' own "7 Day Total Orders") is gated behind the same hasSpRow
        // check as adAttributedSpend/Sales below, not set unconditionally: computeAcos's Amazon
        // branch (adAttributedSales !== undefined) already short-circuits before ever inspecting
        // adOrders whenever hasSpRow is true, so this only matters for an SB/SD-only SKU (no SP
        // row) — there it MUST stay undefined so computeAcos falls through to its real-revenue
        // fallback, not a false adOrders=0-driven blank.
        ...(hasSpRow ? { adAttributedSpend: adSpendDayBySku.get(sku) || 0, adAttributedSales: adSalesDayBySku.get(sku) || 0, adOrders: adOrdersDayBySku.get(sku) || 0 } : {}),
      },
      range: {
        spend: rangeSpend,
        units: rangeUnits,
        revenue: revenueBySku.get(sku) || 0,
        ...(hasSpRow ? { adAttributedSpend: adSpendRangeBySku.get(sku) || 0, adAttributedSales: adSalesRangeBySku.get(sku) || 0, adOrders: adOrdersRangeBySku.get(sku) || 0 } : {}),
      },
    });
  });
  // Fill in day units/revenue per SKU (separate pass — keeps the loop above simple).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  orderRows.forEach((r: any) => {
    if (!r.sku || isCancelledOrder(r) || !isStandardOrderId(r.amazon_order_id)) return;
    const ts = Date.parse(String(r.purchase_datetime || ""));
    if (!(Number.isFinite(ts) && ts >= dayGte && ts < dayLt)) return;
    const p = products.get(r.sku);
    if (!p) return;
    const qty = num(r.quantity);
    p.day.units += qty;
    // item-price is already that line's full total — never multiply by qty (see revenueBySku above).
    p.day.revenue = (p.day.revenue || 0) + num(r.item_price);
  });

  const campaigns: CampaignSpendRow[] = [...campaignSpendByDay.entries()]
    .filter(([, spend]) => spend > 0)
    .map(([campaign, spend]) => ({ platform: "Amazon" as const, campaign, spend }));

  const reportDates = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [...spRows, ...sbRows, ...sdRows].forEach((r: any) => { if (r.report_date) reportDates.add(r.report_date); });

  return { products, overallDay, overallRange, campaigns, unmappedSpend, reportDates, spRows, orderRows, revenueRangeBySku: revenueBySku };
}

// Amazon's current live listing price, straight off barm_amazon_price_listing (scripts/
// price_listing_tables.sql) — used ONLY as computeAcos's new listingPrice argument for the
// zero-Total-Ad-Orders ACOS gate (see computeAcos's own comment). Kept as its own fetch/map,
// separate from fetchAmazonProducts's own priceBySku (which drives ProductRow.price, the display
// Price column, and can in principle be overridden by a merge/seed step before it reaches a
// computeAcos call site) — a listing-table miss here must fall back to whatever `price` argument
// the caller already has, not silently read as 0.
export async function fetchAmazonListingPriceMap(): Promise<Map<string, number>> {
  const rows = await fetchAllRows("barm_amazon_price_listing", (q) => q);
  const map = new Map<string, number>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (rows as any[]).forEach((r) => { if (r.seller_sku && num(r.price) > 0) map.set(r.seller_sku, num(r.price)); });
  return map;
}

// ── Flipkart ─────────────────────────────────────────────────────────────────
// A Flipkart order row's own real revenue for the window, with a fallback for when the uploaded
// order report has no Invoice Amount at all: some Flipkart "Orders" exports are a logistics/
// returns-style report (delivery SLAs, dispatch dates, cancellation reasons) with no price/amount
// column under any name, rather than the report type this was designed against — confirmed directly
// against Supabase, not a parsing bug (raw genuinely has no such field on those rows). Mirrors the
// existing Meesho exception's pattern (see fetchMeeshoProducts below / this file's Notes-sheet
// comment): real order-report data wins when present, a live/current listing-table price fills the
// gap only for what it doesn't have. Exported as its own pure function — both call sites below run
// through it so they can't drift, and it's directly unit-testable without a live Supabase fetch.
export function flipkartRowRevenue(rawInvoiceAmount: number, quantity: number, listingPrice: number | undefined): number {
  if (rawInvoiceAmount > 0) return rawInvoiceAmount;
  return quantity * (listingPrice && listingPrice > 0 ? listingPrice : 0);
}
export async function fetchFlipkartProducts(
  range: { start: string; end: string },
  endDate: string,
  // Current live selling price per SKU (barm_flipkart_listings — the same map fetched by
  // fetchFlipkartListingPriceMap below, which also builds computeAcos's new listingPrice
  // argument), reused here ONLY as flipkartRowRevenue's fallback for a row with no real Invoice
  // Amount — never touches this function's own `price` variable (still real-invoice-average first,
  // falling through to priceBySku/priceListBySku/aspAcc exactly as before), which stays the
  // separate, existing "display Price" concern. Defaults to an empty map (not required) so an
  // existing caller that doesn't have this map handy (e.g. the Daily Ad Spend Insights page) still
  // compiles and behaves exactly as before — an empty map's .get() is always undefined, same as
  // the fallback never firing.
  flipkartListingPriceMap: Map<string, number> = new Map()
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
  revenueRangeBySku: Map<string, number>;
}> {
  const [fsnRows, orderRowsRaw, earnRows, listingRows, priceListRows] = await Promise.all([
    fetchAllRows("barm_flipkart_fsn_report", (q) => q.gte("report_date", range.start).lte("report_date", endDate)),
    fetchDailyFlipkartOrders(range, endDate),
    fetchAllRows("barm_flipkart_earn_more", (q) => q.gte("order_date", range.start).lte("order_date", endDate)).catch(() => []),
    fetchAllRows("barm_flipkart_listings", (q) => q).catch(() => []),
    // flipkart_price_list (scripts/flipkart_price_list_table.sql) holds the
    // seller's own manual master-price-list workbook, filtered to the
    // Flipkart-tagged rows — a fallback below barm_flipkart_listings (which
    // stays authoritative when Flipkart's own official Listings export has
    // been uploaded) for a SKU neither that table nor real orders cover yet.
    // Wrapped in .catch(() => []) like the tables above: if this table
    // hasn't been created yet, Flipkart just falls through to the existing
    // Earn More ASP fallback rather than breaking the report.
    fetchAllRows("flipkart_price_list", (q) => q).catch(() => []),
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
  const priceListBySku = new Map<string, number>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  priceListRows.forEach((r: any) => { if (r.sku_id && num(r.price) > 0) priceListBySku.set(r.sku_id, num(r.price)); });
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
  // Summary sheet's "Ad Sales" column for Flipkart, per the seller's explicit request: the ads
  // export's own "Total Revenue" figure (fsnRows.total_revenue) — the ad platform's own reported
  // revenue, not the real per-order revenue used for Total Sales (see revenueBySku below).
  const adSalesRangeBySku = new Map<string, number>();
  const adSalesDayBySku = new Map<string, number>();
  // SKU Wise Report's "Total Ad Orders" column: Flipkart's own ads-export ad-attributed unit
  // count — direct_units_sold + indirect_units_sold, already stored per-row on
  // barm_flipkart_fsn_report but never read anywhere in this function before. Always defined
  // (never gated like Amazon's adOrders above) since Flipkart's WindowAgg always sets adSales too,
  // which computeAcos's adSalesFigure ternary already prefers over adOrders unconditionally — this
  // is purely a display figure here, inert for ACOS.
  const adOrdersRangeBySku = new Map<string, number>();
  const adOrdersDayBySku = new Map<string, number>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fsnRows.forEach((r: any) => {
    if (!r.sku_id) return;
    const spend = num(r.ad_spend);
    ensureSpend(r.sku_id).spend += spend;
    const adSales = num(r.total_revenue);
    const adOrders = num(r.direct_units_sold) + num(r.indirect_units_sold);
    adSalesRangeBySku.set(r.sku_id, (adSalesRangeBySku.get(r.sku_id) || 0) + adSales);
    adOrdersRangeBySku.set(r.sku_id, (adOrdersRangeBySku.get(r.sku_id) || 0) + adOrders);
    if (r.report_date === endDate) {
      spendBySkuDay.set(r.sku_id, (spendBySkuDay.get(r.sku_id) || 0) + spend);
      if (spend > 0) campaignSpendDay.set(r.campaign_name || "", (campaignSpendDay.get(r.campaign_name || "") || 0) + spend);
      adSalesDayBySku.set(r.sku_id, (adSalesDayBySku.get(r.sku_id) || 0) + adSales);
      adOrdersDayBySku.set(r.sku_id, (adOrdersDayBySku.get(r.sku_id) || 0) + adOrders);
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
  // Real per-unit price each SKU actually sold for this window, straight from its own
  // Invoice Amount rows — the seller's explicit preference over the static
  // barm_flipkart_listings snapshot below, which goes stale between re-uploads (found via
  // Chewy tube green- Pack of 2: listed ₹345 in barm_flipkart_listings vs a real ₹351
  // Invoice Amount on every one of its orders this window). Used as the primary Flipkart
  // price source; the listing price / Earn More average only fill in for a SKU with no
  // real (non-cancelled) orders in this window.
  const invoiceAcc = new Map<string, { amount: number; units: number }>();
  // Overall Sales Value / Total Sales revenue, WITH the barm_flipkart_listings fallback (see
  // flipkartRowRevenue above) for a row whose order report has no Invoice Amount at all — kept as
  // its own accumulator, separate from invoiceAcc just above/below, which must stay real-Invoice-
  // Amount-only: invoiceAcc alone drives this SKU's own display Price a few lines down, and that
  // must not absorb this per-row fallback (only Overall Sales Value/Total Sales should) per the
  // seller's explicit instruction that this fallback stay scoped to the Value/revenue figures.
  const rangeRevenueBySku = new Map<string, number>();
  orderRows.forEach((r) => {
    const qty = num(r.quantity);
    // Overall sales QTS/Value: a straight SUM of the Order report's own
    // Quantity/Invoice Amount columns for the window — unrelated to ad data
    // or the separate Earn More report, and with no status filter (matches
    // the seller's own manual workbook, which SUMs every order status as-is).
    // Invoice Amount isn't a structured column on barm_flipkart_order_report
    // (see FlipkartOrderRow in flipkartReportUpload.ts) — every original
    // column from the upload survives in this row's own `raw` JSONB, so it's
    // read from there instead.
    const invoiceAmount = num((r as { raw?: Record<string, unknown> }).raw?.["Invoice Amount"]);
    // See flipkartRowRevenue's own comment — falls back to qty x this row's SKU's current
    // barm_flipkart_listings price only when this row itself has no real Invoice Amount.
    const revenueAmount = flipkartRowRevenue(invoiceAmount, qty, flipkartListingPriceMap.get(r.sku || ""));
    overallRange.units += qty;
    overallRange.value += revenueAmount;
    if (r.order_date === endDate) {
      overallDay.units += qty;
      overallDay.value += revenueAmount;
    }

    // Per-SKU Orders (feeds the Ad spend report's per-product Orders/CPC/ACOS
    // columns) stays scoped to real, non-cancelled sales — a different
    // question from the Overall sales total above.
    if (!r.sku) return;
    const status = String(r.order_item_status || "").toUpperCase();
    if (status.startsWith("CANCEL")) return;
    ensureUnits(r.sku).units += qty;
    if (qty > 0 && invoiceAmount > 0) {
      const acc = invoiceAcc.get(r.sku) || { amount: 0, units: 0 };
      acc.amount += invoiceAmount;
      acc.units += qty;
      invoiceAcc.set(r.sku, acc);
    }
    if (qty > 0 && revenueAmount > 0) {
      rangeRevenueBySku.set(r.sku, (rangeRevenueBySku.get(r.sku) || 0) + revenueAmount);
    }
  });

  const skus = new Set<string>([...spendBySku.keys(), ...unitsBySku.keys(), ...priceBySku.keys()].filter(Boolean));
  const products = new Map<string, ProductRow>();
  skus.forEach((sku) => {
    const inv = invoiceAcc.get(sku);
    let price = inv && inv.units > 0 ? inv.amount / inv.units : 0;
    if (price <= 0) price = priceBySku.get(sku) || 0;
    if (price <= 0) price = priceListBySku.get(sku) || 0;
    if (price <= 0) {
      const a = aspAcc.get(sku);
      if (a && a.units > 0) price = a.amount / a.units;
    }
    products.set(sku, {
      platform: "Flipkart",
      sku,
      name: resolveProductName(nameBySku.get(sku), sku) || nameBySku.get(sku) || sku,
      price,
      day: { spend: spendBySkuDay.get(sku) || 0, units: 0, revenue: 0, adSales: adSalesDayBySku.get(sku) || 0, adOrders: adOrdersDayBySku.get(sku) || 0 },
      range: { spend: spendBySku.get(sku)?.spend || 0, units: unitsBySku.get(sku)?.units || 0, revenue: rangeRevenueBySku.get(sku) || 0, adSales: adSalesRangeBySku.get(sku) || 0, adOrders: adOrdersRangeBySku.get(sku) || 0 },
    });
  });
  orderRows.forEach((r) => {
    if (!r.sku || r.order_date !== endDate) return;
    const status = String(r.order_item_status || "").toUpperCase();
    if (status.startsWith("CANCEL")) return;
    const p = products.get(r.sku);
    if (!p) return;
    const qty = num(r.quantity);
    p.day.units += qty;
    // Same Invoice-Amount-missing fallback as the range window above (see flipkartRowRevenue).
    const invoiceAmount = num((r as { raw?: Record<string, unknown> }).raw?.["Invoice Amount"]);
    p.day.revenue = (p.day.revenue || 0) + flipkartRowRevenue(invoiceAmount, qty, flipkartListingPriceMap.get(r.sku));
  });

  const campaigns: CampaignSpendRow[] = [...campaignSpendDay.entries()]
    .filter(([, spend]) => spend > 0)
    .map(([campaign, spend]) => ({ platform: "Flipkart" as const, campaign, spend }));

  const reportDates = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fsnRows.forEach((r: any) => { if (r.report_date) reportDates.add(r.report_date); });

  // SKU Wise Report's "Total Sales" per the seller's explicit request: real per-order revenue
  // (with the barm_flipkart_listings fallback above) instead of flat Price x range units —
  // rangeRevenueBySku already sums exactly this across each SKU's own non-cancelled order rows in
  // this window, reused directly here rather than re-summing orderRows.
  const revenueRangeBySku = rangeRevenueBySku;
  return { products, overallDay, overallRange, campaigns, reportDates, fsnRows, orderRows, revenueRangeBySku };
}

// Flipkart's current live listing price, straight off barm_flipkart_listings (scripts/
// price_listing_tables.sql) — used both as computeAcos's new listingPrice argument (the zero-Total-
// Ad-Orders ACOS gate, see computeAcos's own comment) and as fetchFlipkartProducts's own Invoice-
// Amount-missing revenue fallback (see flipkartRowRevenue above). Kept as its own fetch/map for the
// same reason as fetchAmazonListingPriceMap: a miss here must fall back to whatever the caller
// already has (computeAcos's `price` argument, or 0 for flipkartRowRevenue), not read as 0 outright.
export async function fetchFlipkartListingPriceMap(): Promise<Map<string, number>> {
  const rows = await fetchAllRows("barm_flipkart_listings", (q) => q);
  const map = new Map<string, number>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (rows as any[]).forEach((r) => { if (r.seller_sku_id && num(r.selling_price) > 0) map.set(r.seller_sku_id, num(r.selling_price)); });
  return map;
}

// ── Meesho ───────────────────────────────────────────────────────────────────
// No native Meesho export has been seen directly — barm_meesho_ads/orders are
// populated by src/lib/meeshoReportUpload.ts from the seller's own
// hand-assembled workbook column names (see that file's header comment). All
// three fetches are wrapped in .catch(() => []) because their tables may not
// exist yet (scripts/meesho_tables.sql / scripts/meesho_price_marketing_table.sql
// not run) — that must degrade to "no Meesho data" / "no marketing price"
// rather than take down the whole report.
export async function fetchMeeshoProducts(
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
  revenueRangeBySku: Map<string, number>;
}> {
  const [adsRows, orderRows, marketingRows] = await Promise.all([
    fetchAllRows("barm_meesho_ads", (q) => q.gte("report_date", range.start).lte("report_date", endDate)).catch(() => []),
    fetchAllRows("barm_meesho_orders", (q) => q.gte("order_date", range.start).lte("order_date", endDate)).catch(() => []),
    // meesho_price_marketing (scripts/meesho_price_marketing_table.sql) holds
    // the live scraped Meesho listing price per SKU — the same role
    // barm_amazon_price_listing/barm_flipkart_listings play for the other two
    // platforms. Wrapped in .catch(() => []) like the tables above: if this
    // table hasn't been created yet, Meesho just falls all the way back to
    // its old order-derived price below rather than breaking the report.
    fetchAllRows("meesho_price_marketing", (q) => q).catch(() => []),
  ]);

  const isCancelled = (status: unknown) => String(status || "").toUpperCase().startsWith("CANCEL");
  // Order-derived fallback price, used only for a SKU meesho_price_marketing
  // doesn't have a price for yet (not scraped, or currently out of stock on
  // Meesho). Discounted price (post-commission net) is the closer analog to
  // Amazon's item_price / Flipkart's selling_price; listed price is the
  // fallback for a SKU whose orders never carry a discounted figure.
  const orderPriceOf = (r: { supplier_discounted_price?: unknown; supplier_listed_price?: unknown }) =>
    num(r.supplier_discounted_price) || num(r.supplier_listed_price);

  const nameBySku = new Map<string, string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  orderRows.forEach((r: any) => { if (r.sku && r.product_name && !nameBySku.has(r.sku)) nameBySku.set(r.sku, r.product_name); });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adsRows.forEach((r: any) => { if (r.sku && r.product_name && !nameBySku.has(r.sku)) nameBySku.set(r.sku, r.product_name); });

  // Price precedence: meesho_price_marketing's live listing price first
  // (independent of whether the SKU had any orders in this window, same as
  // Amazon/Flipkart's listing tables), then each SKU's own order rows as a
  // fallback for SKUs not in that table yet.
  const priceBySku = new Map<string, number>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  marketingRows.forEach((r: any) => {
    const price = num(r.price);
    if (r.sku_id && price > 0) priceBySku.set(r.sku_id, price);
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  orderRows.forEach((r: any) => {
    if (!r.sku || priceBySku.has(r.sku)) return;
    const price = orderPriceOf(r);
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
  // Summary sheet's "Ad Sales" column for Meesho, per the seller's explicit request: "Orders by
  // ad" straight off Meesho's own ad report (its export has no ₹ sales figure the way Amazon's
  // does), multiplied by price when the Summary sheet is built below.
  const adOrdersRangeBySku = new Map<string, number>();
  const adOrdersDayBySku = new Map<string, number>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adsRows.forEach((r: any) => {
    if (!r.sku) return;
    const spend = num(r.spend);
    ensureSpend(r.sku).spend += spend;
    const adOrders = num(r.orders_by_ad);
    adOrdersRangeBySku.set(r.sku, (adOrdersRangeBySku.get(r.sku) || 0) + adOrders);
    if (r.report_date === endDate) {
      spendBySkuDay.set(r.sku, (spendBySkuDay.get(r.sku) || 0) + spend);
      if (spend > 0) campaignSpendDay.set(r.campaign_name || "", (campaignSpendDay.get(r.campaign_name || "") || 0) + spend);
      adOrdersDayBySku.set(r.sku, (adOrdersDayBySku.get(r.sku) || 0) + adOrders);
    }
  });

  const unitsBySku = new Map<string, WindowAgg>();
  const ensureUnits = (sku: string): WindowAgg => {
    let a = unitsBySku.get(sku);
    if (!a) { a = emptyAgg(); unitsBySku.set(sku, a); }
    return a;
  };
  // SKU Wise Report's "Total Sales" per the seller's explicit request: real per-order revenue
  // instead of flat Price x range units — see the Amazon/Flipkart fetch functions' matching
  // comment. Scoped to the same non-cancelled rows as unitsBySku just below.
  const revenueBySku = new Map<string, number>();
  const overallDay = emptySales();
  const overallRange = emptySales();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  orderRows.forEach((r: any) => {
    const qty = num(r.quantity);
    // Order Value (feeds Overall Sales QTS/Value below and revenueBySku, the
    // SKU Wise Report's "Total Sales" column) — per the seller's explicit,
    // later instruction: Quantity x this row's own "Supplier Listed Price
    // (Incl. GST + Commission)" ONLY. Deliberately NOT priceBySku (which
    // still prefers meesho_price_marketing's live price, falling back to
    // orderPriceOf's discounted-then-listed precedence) and NOT Supplier
    // Discounted Price — the seller confirmed Listed Price is the direct,
    // primary source for this one calculation, full stop, superseding the
    // earlier "prefer the live scraped price" rule that priceBySku still
    // implements for other uses below (the display "Price" column and the
    // ACOS CPC/Price fallback both still use priceBySku/meesho_price_marketing
    // as before — only this Order Value figure changed).
    const price = num(r.supplier_listed_price);
    const value = price * qty;
    overallRange.units += qty;
    overallRange.value += value;
    if (r.order_date === endDate) {
      overallDay.units += qty;
      overallDay.value += value;
    }

    // Per-SKU Orders (feeds the Ad spend report's per-product columns) stays
    // scoped to real, non-cancelled sales — a different question from the
    // Overall sales total above.
    if (!r.sku || isCancelled(r.order_status)) return;
    ensureUnits(r.sku).units += qty;
    revenueBySku.set(r.sku, (revenueBySku.get(r.sku) || 0) + value);
  });

  const skus = new Set<string>([...spendBySku.keys(), ...unitsBySku.keys(), ...priceBySku.keys()].filter(Boolean));
  const products = new Map<string, ProductRow>();
  skus.forEach((sku) => {
    products.set(sku, {
      platform: "Meesho",
      sku,
      name: resolveProductName(nameBySku.get(sku), sku) || nameBySku.get(sku) || sku,
      price: priceBySku.get(sku) || 0,
      day: { spend: spendBySkuDay.get(sku) || 0, units: 0, adOrders: adOrdersDayBySku.get(sku) || 0 },
      range: { spend: spendBySku.get(sku)?.spend || 0, units: unitsBySku.get(sku)?.units || 0, adOrders: adOrdersRangeBySku.get(sku) || 0 },
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

  return { products, overallDay, overallRange, campaigns, reportDates, adsRows, orderRows, revenueRangeBySku: revenueBySku };
}

// ── Social Media (Meta Ads) ──────────────────────────────────────────────────
// Lightweight add-on, NOT a full `Platform` — Meta ad spend only feeds one
// extra Summary-sheet row (see the "Social Media" row built in
// buildAdSpendReportWorkbook below), not its own Ad spend report / SKU Wise
// Report / Ad Status Report / Action Sheet / Low Spend Campaigns entries —
// there's exactly one product running Meta ads today and no per-SKU campaign
// breakdown the way the three real platforms above have, so those sheets
// don't have anything meaningful to add for it (per the seller's own choice).
//
// Every uploaded row (see socialMediaReportUpload.ts) carries its own
// [report_start, report_end] window rather than a single report_date, since
// Meta's own export can be either a single day or a multi-day range — and in
// practice the same campaign can end up with BOTH a daily row (today's
// export) and a wider row covering the whole trailing week for the very same
// days (a "last 7 days" export pulled separately), which must never both be
// summed for the same campaign or the range total would double-count. So the
// range total is resolved per campaign: a row whose window exactly matches
// [range.start, endDate] is that campaign's authoritative whole-window total
// and wins outright over any narrower row for the same campaign (which is
// necessarily a subset of it); only when no such row exists does it fall
// back to summing whatever narrower (typically daily) rows that campaign has
// inside the window. The single reporting day's own figure only ever comes
// from a literal daily row for that exact date — a range row can't tell us
// one day's specific share of its total.
async function fetchSocialMediaAdSpend(
  range: { start: string; end: string },
  endDate: string
): Promise<{ daySpend: number; rangeSpend: number }> {
  const rows = (await fetchAllRows(
    "barm_daily_social_media",
    (q) => q.lte("report_start", endDate).gte("report_end", range.start)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ).catch(() => [])) as any[];

  const daySpend = rows
    .filter((r) => r.report_start === endDate && r.report_end === endDate)
    .reduce((s, r) => s + num(r.spend), 0);

  const byCampaign = new Map<string, typeof rows>();
  rows
    .filter((r) => r.report_start >= range.start && r.report_end <= endDate) // fully inside the window only
    .forEach((r) => {
      const list = byCampaign.get(r.campaign_name) ?? [];
      list.push(r);
      byCampaign.set(r.campaign_name, list);
    });
  let rangeSpend = 0;
  byCampaign.forEach((campaignRows) => {
    const wideRow = campaignRows.find((r) => r.report_start === range.start && r.report_end === endDate);
    rangeSpend += wideRow ? num(wideRow.spend) : campaignRows.reduce((s, r) => s + num(r.spend), 0);
  });

  return { daySpend: round2(daySpend), rangeSpend: round2(rangeSpend) };
}

// ── Google (direct/website) orders ──────────────────────────────────────────
// Like Social Media above, a lightweight add-on, NOT a real `Platform` — this
// channel has no ad campaign export of any kind (no Spend/CPC/ACOS to show),
// only realised Orders and Sales (Quantity x Price), from the seller's own
// hand-kept "B-Arm Orders" workbook (see googleOrdersUpload.ts). Feeds one
// extra Summary-sheet row and a small Product/Quantity/Price/Sales section
// at the end of the "Ad spend report" sheet — never the SKU Wise Report, Ad
// Status Report, Action Sheet or Low Spend Campaigns, none of which have
// anything meaningful to add for a channel with no ad spend.
//
// Day + range split (fixed — this channel used to return only a single
// [range.start, range.end] total with no day/range distinction, and that
// range total was written straight into the Summary sheet's "Overall sales
// (<single day>)" column: a real SKU with 7 days of orders printed as if it
// were one day's sales, exactly the "Overall sales written as the 7-day
// range instead of the single reporting day" defect class the Ad Spend
// Report reconciliation skill already documents for the other platforms —
// Google just never got the same fix). `perProduct` stays scoped to the
// full range (unchanged) since the Ad spend report sheet's Google detail
// table is meant to list every product active across the window, not just
// today's; only the Summary sheet's own Total Orders/Total Sales (both the
// day block and the range block) and Overall Sales QTS/Value change.
async function fetchGoogleOrders(range: { start: string; end: string }, endDate: string): Promise<{
  perProduct: { name: string; quantity: number; price: number }[];
  dayUnits: number;
  dayValue: number;
  rangeUnits: number;
  rangeValue: number;
}> {
  const rows = (await fetchAllRows("barm_daily_google_orders", (q) =>
    q.gte("order_date", range.start).lte("order_date", range.end)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ).catch(() => [])) as any[];
  const byProduct = new Map<string, { quantity: number; priceSum: number; priceCount: number }>();
  let dayUnits = 0;
  let dayValue = 0;
  let rangeUnits = 0;
  let rangeValue = 0;
  rows.forEach((r) => {
    const name = r.product_name || "(no product name)";
    const qty = num(r.quantity);
    const price = num(r.price);
    const value = qty * price;
    rangeUnits += qty;
    rangeValue += value;
    if (r.order_date === endDate) {
      dayUnits += qty;
      dayValue += value;
    }
    const acc = byProduct.get(name) || { quantity: 0, priceSum: 0, priceCount: 0 };
    acc.quantity += qty;
    if (price > 0) { acc.priceSum += price; acc.priceCount += 1; }
    byProduct.set(name, acc);
  });
  const perProduct = [...byProduct.entries()]
    .map(([name, acc]) => ({ name, quantity: acc.quantity, price: acc.priceCount ? acc.priceSum / acc.priceCount : 0 }))
    .sort((a, b) => b.quantity * b.price - a.quantity * a.price);
  return {
    perProduct,
    dayUnits, dayValue: Math.round(dayValue * 100) / 100,
    rangeUnits, rangeValue: Math.round(rangeValue * 100) / 100,
  };
}

// ── workbook ─────────────────────────────────────────────────────────────────

function styleHeader(ws: XLSX.WorkSheet, row: number, cols: number, fill: string, colStart = 0): void {
  for (let c = colStart; c < colStart + cols; c++) {
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
const CURRENCY_FMT = '"₹"#,##0.00';
const PERCENT_FMT = "0%";
// Every value in this workbook is written as a plain number — Excel shows it
// as a bare decimal (0.7645, 16778.91) unless a display format is set on the
// cell. Applies one to every numeric cell in the given columns, over
// [rowStart, rowEnd) — currency (₹#,##0.00) or percent (0%), matching the
// hand-built workbook's own formatting.
function applyNumberFormats(ws: XLSX.WorkSheet, rowStart: number, rowEnd: number, colFormats: Record<number, string>): void {
  for (let r = rowStart; r < rowEnd; r++) {
    for (const [colStr, fmt] of Object.entries(colFormats)) {
      const addr = XLSX.utils.encode_cell({ r, c: Number(colStr) });
      const cell = ws[addr];
      if (cell && typeof cell.v === "number") cell.z = fmt;
    }
  }
}

// Strips a ```json ... ``` fence if Gemini wrapped its answer in one — same helper as
// uploadAcosAlert.ts's extractJsonBlock, duplicated here rather than imported since that file is
// written for the browser-side upload flow (relative fetch() calls) and this one runs server-side.
function extractJsonBlock(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  return fenced ? fenced[1] : text;
}

// Direct server-side call to the Gemini API — mirrors src/app/api/gemini-insights/route.ts's
// model cascade and generationConfig exactly, but calls generativelanguage.googleapis.com
// directly instead of going through that route: this code runs inside buildAdSpendReportWorkbook,
// which has no request host to build a relative-fetch URL from (it's a plain lib function, not an
// API handler) and also runs on the unattended daily cron with no browser origin at all. Returns
// null (never throws) on any failure so a Gemini outage never breaks report generation.
async function callGeminiText(prompt: string): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const models = ["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-2.0-flash"];
  for (const model of models) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 2048, temperature: 0.5, thinkingConfig: { thinkingBudget: 256 } },
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!response.ok) continue; // 404 (retired model)/429 (rate limit)/other — try the next model
      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) return text;
    } catch {
      // Timeout or network failure on this model — try the next one.
    }
  }
  return null;
}

// Optimization suggestions (Amazon + Flipkart) — one Gemini call per platform covering every
// campaign whose trailing-7-day ACOS exceeds 14% (same threshold as the Action Sheet), then
// patches those campaigns' products' actionRows entries with the real suggestion in place of the
// generic tiered text. Amazon's version is sourced from barm_amazon_sp_advertised_product (the
// same table/fields uploadAcosAlert.ts's weekly high-ACOS email already uses), Flipkart's from
// barm_flipkart_fsn_report — both carry ad-group and SKU detail, so a suggestion can name a
// specific ad group. Neither can name an actual search term/keyword to negate: no search-term-
// level report is uploaded for Flipkart anywhere in this dashboard, and Amazon's real keyword
// data only exists live in SellerMate, which this server-side report code has no access to (only
// an interactive chat session can pull that, on request — see the Action Sheet's own comment).
const OPT_MIN_SPEND = 100;
const OPT_ACOS_THRESHOLD = 0.14;
interface OptAdGroupAgg { name: string; spend: number; revenue: number; units: number; skus: Map<string, number> }
interface OptCampaignAgg { name: string; spend: number; revenue: number; units: number; adGroups: Map<string, OptAdGroupAgg> }

// Which campaign a SKU is associated with, scanning EVERY row across the full 7-day range (not
// just one day) — deliberately separate from aggregateForOptimization's campaign-level spend/
// revenue analysis below, which must stay scoped to a single day for Amazon (see
// enrichAmazonActionRows's own comment on why summing sales_7d/orders_7d across days would
// double-count). Summing each row's own per-day `spend` field across many days is safe here since
// that field isn't a rolling window — this only decides identity ("which campaign"), not amounts.
// Without this, a SKU whose only Sponsored Products spend fell on a day other than the report's
// end date never matched any campaign at all, showing "no matching campaign found" even though a
// real one exists in the uploaded data — this is exactly that gap, closed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildSkuCampaignMap(rows: any[], f: { campaign: string; sku: string; spend: string }): Map<string, string> {
  const bySku = new Map<string, Map<string, number>>();
  rows.forEach((r) => {
    const campaignName: string = r[f.campaign];
    const sku: string = r[f.sku];
    if (!campaignName || !sku) return;
    const perCampaign = bySku.get(sku) || new Map<string, number>();
    perCampaign.set(campaignName, (perCampaign.get(campaignName) || 0) + num(r[f.spend]));
    bySku.set(sku, perCampaign);
  });
  const result = new Map<string, string>();
  bySku.forEach((perCampaign, sku) => {
    let best: string | null = null;
    let bestSpend = -1;
    perCampaign.forEach((spend, name) => { if (spend > bestSpend) { bestSpend = spend; best = name; } });
    if (best) result.set(sku, best);
  });
  return result;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function aggregateForOptimization(rows: any[], f: { campaign: string; adGroup: string; sku: string; spend: string; revenue: string; units: string[] }): Map<string, OptCampaignAgg> {
  const campaigns = new Map<string, OptCampaignAgg>();
  rows.forEach((r) => {
    const campaignName: string = r[f.campaign];
    if (!campaignName) return;
    const spend = num(r[f.spend]);
    const revenue = num(r[f.revenue]);
    const units = f.units.reduce((s, field) => s + num(r[field]), 0);
    let c = campaigns.get(campaignName);
    if (!c) { c = { name: campaignName, spend: 0, revenue: 0, units: 0, adGroups: new Map() }; campaigns.set(campaignName, c); }
    c.spend += spend; c.revenue += revenue; c.units += units;
    const agName: string = r[f.adGroup] || "(no ad group)";
    let ag = c.adGroups.get(agName);
    if (!ag) { ag = { name: agName, spend: 0, revenue: 0, units: 0, skus: new Map() }; c.adGroups.set(agName, ag); }
    ag.spend += spend; ag.revenue += revenue; ag.units += units;
    const sku = r[f.sku];
    if (sku) ag.skus.set(sku, (ag.skus.get(sku) || 0) + spend);
  });
  return campaigns;
}

async function enrichOptimizationActionRows(
  actionRows: { platform: Platform; name: string; sku: string; campaign?: string; acos: number; action: string }[],
  platform: Platform,
  campaigns: Map<string, OptCampaignAgg>,
  skuToCampaignName: Map<string, string>,
  platformLabel: string,
  searchTermTool: string
): Promise<void> {
  // Same sentinel convention as computeAcos/actionSheetAcos above: a real campaign/ad-group with
  // spend but zero attributed revenue is a genuinely unknown ratio, not a literal 999% — see
  // acosLabel below, which is what actually reaches the seller-visible suggestion text and the
  // Gemini prompt (an AI asked to reason about a fabricated "999%" tends to echo it back verbatim).
  const acosOf = (c: OptCampaignAgg) => (c.revenue > 0 ? c.spend / c.revenue : c.spend > 0 ? ACOS_UNDEFINED_SENTINEL : 0);
  const acosLabel = (frac: number): string => (frac === ACOS_UNDEFINED_SENTINEL ? "unavailable" : `${Math.round(frac * 100)}%`);
  const flagged = [...campaigns.values()]
    .filter((c) => c.spend >= OPT_MIN_SPEND && acosOf(c) >= OPT_ACOS_THRESHOLD)
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 15); // caps prompt size/cost — the daily cron runs this unattended every day

  const suggestionByCampaign = new Map<string, string>();
  // Rule-based fallback first (same shape/spirit as uploadAcosAlert.ts's fallbackSuggestion) —
  // Gemini's answer merges on top of this below, so a Gemini outage/bad response never leaves a
  // flagged campaign with no suggestion at all.
  flagged.forEach((c) => {
    const worst = [...c.adGroups.values()].sort((a, b) => b.spend - a.spend)[0];
    const acosFrac = acosOf(c);
    // The bid-cut tier still treats "unknown" as the worst case (real spend, no signal at all) —
    // only the DISPLAYED number changes; Math.round(9.99 * 100) already clears the 90 bar below.
    const cut = Math.round(acosFrac * 100) >= 90 ? 50 : Math.round(acosFrac * 100) >= 60 ? 35 : 20;
    // Zero units sold on real spend is the worst case — call for the maximum bid cut rather than
    // saying "pause", per the seller's explicit instruction that this sheet always give a concrete
    // % to act on, never a blanket pause instruction.
    const pauseNote = worst && worst.units === 0 ? ` Cut this ad group's bids as close to 80% as the platform allows — zero units sold on ₹${round2(worst.spend)} spend.` : "";
    suggestionByCampaign.set(
      c.name,
      `Cut bids ${cut}% on ad group "${worst?.name || c.name}" (ACOS ${acosLabel(acosFrac)}, ₹${round2(worst?.spend ?? c.spend)} spend).${pauseNote} Open that ad group's search-term report in ${searchTermTool} first to add negative keywords for zero-conversion terms.`
    );
  });

  if (flagged.length) {
    const promptLines = flagged
      .map((c) => {
        const topAdGroups = [...c.adGroups.values()].sort((a, b) => b.spend - a.spend).slice(0, 5);
        const agLines = topAdGroups
          .map((ag) => {
            const agAcosFrac = ag.revenue > 0 ? ag.spend / ag.revenue : ag.spend > 0 ? ACOS_UNDEFINED_SENTINEL : 0;
            const topSkus = [...ag.skus.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([sku]) => sku);
            return `    - Ad group "${ag.name}" (top SKUs: ${topSkus.join(", ") || "n/a"}): spend ₹${round2(ag.spend)}, revenue ₹${round2(ag.revenue)}, ACOS ${acosLabel(agAcosFrac)}, units sold ${ag.units}`;
          })
          .join("\n");
        return `- Campaign "${c.name}": spend ₹${round2(c.spend)}, revenue ₹${round2(c.revenue)}, ACOS ${acosLabel(acosOf(c))}, units sold ${c.units}\n  Ad groups within this campaign:\n${agLines}`;
      })
      .join("\n");
    const prompt =
      `You are a ${platformLabel} PPC analyst. Over the trailing 7 days, these campaigns exceeded the 14% ACOS threshold, broken down by ad group and top SKU:\n\n${promptLines}\n\n` +
      `Return ONLY a JSON object, no markdown fences, no text outside the JSON, of this exact shape:\n` +
      `{"campaigns":[{"name":"<exact campaign name as given above>","suggestion":"<1-2 sentences: a specific bid or budget cut % on a named ad group — never tell the seller to pause or stop a campaign, always give a concrete % cut instead (use an aggressive cut like 70-80% for an ad group with 0 units sold); end by naming which ad group to open ${searchTermTool}'s search-term report for first to add negative keywords — never invent a specific search term or keyword, since none is available in this data>"}]}\n` +
      `Include every one of the ${flagged.length} campaigns listed above, using their exact name string.`;

    try {
      const geminiText = await callGeminiText(prompt);
      if (geminiText) {
        const parsed = JSON.parse(extractJsonBlock(geminiText));
        const entries: Array<{ name?: string; suggestion?: string }> = parsed?.campaigns || [];
        entries.forEach((e) => {
          if (e.name && e.suggestion && suggestionByCampaign.has(e.name)) suggestionByCampaign.set(e.name, e.suggestion);
        });
      }
    } catch {
      // JSON.parse or fetch failure — the rule-based suggestionByCampaign map stands as-is.
    }
  }

  actionRows.forEach((r) => {
    if (r.platform !== platform) return;
    const skus = r.sku ? r.sku.split(",").map((s) => s.trim()).filter(Boolean) : [];
    let bestCampaign: string | null = null;
    for (const sku of skus) {
      const hit = skuToCampaignName.get(sku);
      if (hit) { bestCampaign = hit; break; }
    }
    if (!bestCampaign) return; // no identity match anywhere in the range — leave the product-ACOS fallback set earlier
    r.campaign = bestCampaign;
    const suggestion = suggestionByCampaign.get(bestCampaign);
    if (suggestion) {
      r.action = suggestion;
      return;
    }
    // Campaign identified, but its own aggregate spend/ACOS didn't clear the analysis threshold
    // (or fell outside the top-15 prompt cap) — name it rather than claim no match was found.
    // r.acos is already actionSheetAcos's own value (real fallback wherever one's computable) —
    // acosLabel only still matters for the rare residual case where even that's unavailable.
    const acosPct = Math.round(r.acos * 100);
    const cut = acosPct >= 90 ? 50 : acosPct >= 60 ? 35 : 20;
    r.action = `Cut bids ~${cut}% on campaign "${bestCampaign}" (this SKU's 7-day ACOS ${acosLabel(r.acos)}). Open ${searchTermTool}'s search-term report for this campaign to add negative keywords for zero-conversion terms.`;
  });
}

async function enrichFlipkartActionRows(
  actionRows: { platform: Platform; name: string; sku: string; campaign?: string; acos: number; action: string }[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fsnRows: any[]
): Promise<void> {
  const campaigns = aggregateForOptimization(fsnRows, {
    campaign: "campaign_name", adGroup: "adgroup_name", sku: "sku_id",
    spend: "ad_spend", revenue: "total_revenue", units: ["direct_units_sold", "indirect_units_sold"],
  });
  // fsnRows already spans the full 7-day range (see fetchFlipkartAdSpendData) — no day-filtering
  // to widen here, unlike Amazon below.
  const skuToCampaignName = buildSkuCampaignMap(fsnRows, { campaign: "campaign_name", sku: "sku_id", spend: "ad_spend" });
  await enrichOptimizationActionRows(actionRows, "Flipkart", campaigns, skuToCampaignName, "Flipkart Ads", "Flipkart Ads Manager");
}

// Amazon's sp_advertised_product carries Amazon's own trailing-7-day sales_7d/orders_7d per row
// (as of that row's report_date), not a per-day figure — summing those across multiple days'
// rows would multiply-count the same rolling window. Scoped to report_date === endDate only, so
// each campaign/ad-group/SKU's sales_7d/orders_7d is read exactly once, already representing the
// trailing 7 days as of the report's own end date (spend on that row is that single day's spend,
// same mismatched-but-intentional pairing uploadAcosAlert.ts's ACOS calc already relies on).
// SB/SD campaign reports are excluded — they carry no ad-group/SKU column (see uploadAcosAlert.ts's
// file header), so a suggestion for them couldn't name anything more specific than sp_advertised_
// product already does, and are usually the smaller share of total Amazon ad spend anyway.
async function enrichAmazonActionRows(
  actionRows: { platform: Platform; name: string; sku: string; campaign?: string; acos: number; action: string }[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spRows: any[],
  endDate: string
): Promise<void> {
  const dayRows = spRows.filter((r) => r.report_date === endDate);
  const campaigns = aggregateForOptimization(dayRows, {
    campaign: "campaign_name", adGroup: "ad_group_name", sku: "advertised_sku",
    spend: "spend", revenue: "sales_7d", units: ["orders_7d"],
  });
  // Identity mapping (which campaign is this SKU in) scans the FULL spRows across all 7 days, not
  // just endDate — a SKU whose only spend fell on an earlier day in the range still resolves to
  // its real campaign this way, even though its severity/Gemini analysis above stays day-scoped.
  const skuToCampaignName = buildSkuCampaignMap(spRows, { campaign: "campaign_name", sku: "advertised_sku", spend: "spend" });
  await enrichOptimizationActionRows(actionRows, "Amazon", campaigns, skuToCampaignName, "Amazon Ads", "Amazon Ads Console");
}

// Every uploaded row keeps its original file's columns verbatim in a `raw`
// JSONB field (see *ReportUpload.ts) — dumping that, rather than the parsed
// snake_case fields, gives the seller back exactly the sheet shape they
// uploaded (their own headers, their own column order), matching the raw
// "Amazon Spend" / "Flipkart Orders" / etc. sheets in their hand-built
// workbook instead of inventing a different layout.
// Product/Quantity/Price/Sales leaderboard written one blank column to the
// right of a raw dump sheet's own columns (see rawRowsToSheet's sideBlock
// param) — matches the seller's own hand-built workbook's Meesho orders tab,
// which pairs the raw export with exactly this per-product summary on the
// same sheet rather than a separate one.
interface SideBlock {
  header: (string | number)[];
  rows: (string | number)[][];
  /** Column indexes within `rows` (0-based, relative to the block's own
   *  first column) that hold currency values — Price/Sales here — so they
   *  get the same ₹ format the rest of the report uses. */
  currencyCols: number[];
}

function rawRowsToSheet(
  wb: XLSX.WorkBook,
  sheetName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rows: any[],
  sideBlock?: SideBlock
): void {
  const rawRows: Record<string, unknown>[] = rows.map((r) => r?.raw).filter((r): r is Record<string, unknown> => !!r);
  const writeSideBlock = (ws: XLSX.WorkSheet, colStart: number) => {
    if (!sideBlock) return;
    XLSX.utils.sheet_add_aoa(ws, [sideBlock.header, ...sideBlock.rows], { origin: { r: 0, c: colStart } });
    styleHeader(ws, 0, sideBlock.header.length, "6B7280", colStart);
    applyNumberFormats(
      ws, 1, sideBlock.rows.length + 1,
      Object.fromEntries(sideBlock.currencyCols.map((c) => [colStart + c, CURRENCY_FMT]))
    );
    if (!ws["!cols"]) ws["!cols"] = [];
    const wsCols = ws["!cols"] as { wch: number }[];
    while (wsCols.length < colStart) wsCols.push({ wch: 16 });
    wsCols.push({ wch: 40 }, ...sideBlock.header.slice(1).map(() => ({ wch: 12 })));
  };
  if (!rawRows.length) {
    const ws = XLSX.utils.aoa_to_sheet([["(no data in range)"]]);
    writeSideBlock(ws, 2);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    return;
  }
  const cols: string[] = [];
  const seen = new Set<string>();
  rawRows.forEach((r) => Object.keys(r).forEach((k) => { if (!seen.has(k)) { seen.add(k); cols.push(k); } }));

  // A column named e.g. "Date"/"Order Date"/"Start Date" whose raw value is a plain number is an
  // Excel date SERIAL (the sheet cell was typed as a date when the seller's file was uploaded,
  // and the upload parser stored that serial number as-is into this row's `raw` JSONB rather than
  // converting it) — written straight into a new cell with no date number format, it displays as
  // a bare integer like "46276" instead of a date. Amazon's own "purchase-date" is unaffected
  // (already an ISO string in `raw`, not a number) — this only fires for a genuinely numeric date
  // cell. Confirmed against this exact bug: 46276/46282 parse to 2026-09-11/2026-09-17, this
  // report's own date window, not some unrelated number that happens to share a "date" header.
  const DATE_HEADER_RE = /date/i;
  // Flipkart's "Invoice Date (mm/dd/yy)" column is a special case within that: whenever the
  // seller's uploaded file had that cell typed as a genuine Excel date (rather than left as plain
  // text like "09/13/26"), day and month come out swapped — proven by cross-checking against the
  // same row's "Dispatch by date": every single numeric-typed cell in this column, 234/234 in one
  // report, has its month matching Dispatch's DAY instead of its month once mapped this way, e.g.
  // a real 11-Sep dispatch stores as the serial for 9-Nov (day 11/month 9 read back as day 9/month
  // 11). That happens upstream, in whatever tool auto-converted the seller's ambiguous "9/11/26"
  // text into a real Date cell using day-first instead of month-first — not in our upload code,
  // which never reinterprets an already-numeric cell's value. Swapping day/month back on read (and
  // reformatting the still-plain-text cells the same way, since they're already correct as
  // stored) keeps this one column internally consistent instead of half dash-DD-MM/half
  // slash-MM-DD.
  const SWAPPED_DM_HEADER_RE = /\(mm\/dd\/yy\)/i;
  const excelSerialToDmy = (v: number, swapDayMonth: boolean): string | null => {
    // Guarded, not called blind: a formatting nicety must never crash report generation over it —
    // worse than leaving the original bare-number cell in place, which is what a null return does.
    try {
      const d = XLSX.SSF?.parse_date_code(v);
      if (!d || !d.y) return null;
      const day = swapDayMonth ? d.m : d.d;
      const month = swapDayMonth ? d.d : d.m;
      return `${String(day).padStart(2, "0")}-${String(month).padStart(2, "0")}-${d.y}`;
    } catch {
      return null;
    }
  };
  // "9/13/26" -> "13-09-2026" (already correct day/month order per this column's own MM/DD/YY
  // convention, just reformatted to match the numeric cells above and the rest of this report).
  const mdyTextToDmy = (v: string): string | null => {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(v.trim());
    if (!m) return null;
    const [, mm, dd, yy] = m;
    return `${dd.padStart(2, "0")}-${mm.padStart(2, "0")}-20${yy}`;
  };

  const aoa: (string | number | null)[][] = [cols];
  rawRows.forEach((r) => {
    aoa.push(
      cols.map((c) => {
        const v = r[c];
        if (v === null || v === undefined) return "";
        if (typeof v === "number" && DATE_HEADER_RE.test(c)) {
          const formatted = excelSerialToDmy(v, SWAPPED_DM_HEADER_RE.test(c));
          if (formatted) return formatted;
        }
        if (typeof v === "string" && SWAPPED_DM_HEADER_RE.test(c)) {
          const formatted = mdyTextToDmy(v);
          if (formatted) return formatted;
        }
        return typeof v === "number" || typeof v === "string" ? v : String(v);
      })
    );
  });
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  styleHeader(ws, 0, cols.length, "6B7280");
  ws["!views"] = [{ state: "frozen", ySplit: 1 }];
  ws["!cols"] = cols.map(() => ({ wch: 16 }));
  // Amazon's own export has ACOS/Conversion Rate/CTR as a plain fraction (0.15 for 15%), which the
  // upload parser stores as-is into `raw` — reads back here as a bare "0.15" with no format applied,
  // instead of the "15.00%" it showed in the seller's original upload. ROAS/ROI are deliberately left
  // alone: those are genuine ratios (Sales/Spend), not percentages, so "1.58" is already correct.
  const PERCENT_HEADER_RE = /ACOS|Conversion Rate|Click-?Thru Rate|\bCTR\b/i;
  const percentCols: Record<number, string> = {};
  cols.forEach((c, i) => { if (PERCENT_HEADER_RE.test(c)) percentCols[i] = "0.00%"; });
  if (Object.keys(percentCols).length) applyNumberFormats(ws, 1, aoa.length, percentCols);
  writeSideBlock(ws, cols.length + 1);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
}

const PLATFORM_FILL: Record<Platform, string> = { Amazon: "FF9900", Flipkart: "2874F0", Meesho: "9F2089" };
// listingPrice: this SKU's current live listing-table price (Amazon: barm_amazon_price_listing,
// Flipkart: barm_flipkart_listings — see fetchAmazonListingPriceMap/fetchFlipkartListingPriceMap),
// threaded through to computeAcos's own listingPrice parameter untouched. Omitted for Meesho (no
// listing table exists) and for a merged multi-SKU row whose comma-joined p.sku isn't a key in
// either map — both cases fall back to computeAcos's own `price` argument automatically.
const productAoaRow = (p: ProductRow, listingPrice?: number): (string | number | null)[] => [
  p.name, p.price,
  round2(p.day.spend), round2(spendTax(p.day)), p.day.units, round2(computeCpc(p.day)), acosCell(p.day, p.price, listingPrice),
  round2(p.range.spend), round2(spendTax(p.range)), p.range.units, round2(computeCpc(p.range)), acosCell(p.range, p.price, listingPrice),
];
function round2(n: number): number { return Math.round(n * 100) / 100; }
function pct(n: number): number { return Math.round(n * 10000) / 10000; }
// Every user-visible ACOS cell/field goes through this instead of computeAcos(...)
// directly: the ACOS_UNDEFINED_SENTINEL means "ad spend with zero attributed sales", a
// genuinely undefined ratio, and rendering it as "999%" reads as a data error rather than
// "no signal" — this blanks it out (null: an empty xlsx cell, an empty DB column, and a
// dash in the email template) instead, matching the raw Sponsored Products export's own
// convention of leaving ACOS blank when Total Sales is 0. The Action Sheet's own >14%
// threshold check still uses computeAcos's raw sentinel value directly (a genuinely
// unknown ACOS with real spend should still clear that bar) — but see acosSortRank
// below for every "worst ACOS first" ordering, which treats it differently.
export function acosCell(a: WindowAgg, price: number, listingPrice?: number): number | null {
  const v = computeAcos(a, price, listingPrice);
  return v === ACOS_UNDEFINED_SENTINEL ? null : pct(v);
}
// Summary sheet ACOS for Flipkart/Meesho only, per the seller's explicit request: instead of
// the CPC/Price fallback computeAcos falls back to for these two platforms everywhere else
// (Ad spend report, SKU Wise Report), the Summary sheet computes their ACOS directly as
// Ad Spend / Ad Sales — the same Ad Sales figure already shown in Summary's own Ad Sales
// column — for both the day and range blocks. Amazon needs no separate path here since
// computeAcos already resolves to this same Spend/AdSales ratio for Amazon via its
// adAttributedSales branch. Same blanking convention as acosCell: zero Ad Sales with real
// spend is a genuinely undefined ratio (blank cell), zero Ad Sales with zero spend is 0%.
function summaryAcosCell(spend: number, adSales: number): number | null {
  return adSales > 0 ? pct(spend / adSales) : spend > 0 ? null : 0;
}
// "Worst ACOS first" sort ordering only (the Summary sheet's per-platform shortlist, the
// email's top-3 table, and the full Ad spend report tab's row order) — a known, finite
// ACOS ranks ABOVE the sentinel here, not below. A blank "Amazon attributed zero sales"
// row is genuinely less informative than a concrete 136%, so burying every real number
// under a pile of blanks (the sentinel is numerically huge) defeats the point of a
// worst-first list. The Action Sheet's own threshold check is unaffected — it doesn't
// sort, it just filters every product against >14% independently of this ranking.
export function acosSortRank(a: WindowAgg, price: number, listingPrice?: number): number {
  const v = computeAcos(a, price, listingPrice);
  return v === ACOS_UNDEFINED_SENTINEL ? -1 : v;
}

// One product's day/range Spend, Spend(with tax), Orders, CPC, ACOS — the same
// five metrics as METRIC_NAMES/productAoaRow above, just as a named object
// instead of a positional row, for the daily email summary (see
// PlatformEmailSummary below) rather than a spreadsheet cell.
export interface ProductMetricBlock {
  spend: number;
  spendTax: number;
  orders: number;
  cpc: number;
  // null when computeAcos hit the ACOS_UNDEFINED_SENTINEL (ad spend with zero
  // attributed sales) — see acosCell. Renders as a blank cell/dash, never "999%".
  acos: number | null;
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
  overallDayUnits: number;
  overallDayValue: number;
  overallRangeUnits: number;
  overallRangeValue: number;
  topProducts: { name: string; price: number; day: ProductMetricBlock; range: ProductMetricBlock }[];
  // Every product with any range spend (not just the top-3 shortlist), sorted worst-day-ACOS-first —
  // same population and order as topProducts, just unsliced. Mirrors the full per-platform
  // "Here is the Amazon/Flipkart platform's ad spend report" tables in the manual daily mail,
  // which list every advertised product rather than only the top 3.
  allProducts: { name: string; price: number; day: ProductMetricBlock; range: ProductMetricBlock }[];
}

// Same shape as one PlatformEmailSummary row, minus the shortlist/allProducts fields (there's
// only ever the one product) — kept as its own type instead of widening Platform/PlatformEmailSummary
// to include "Social Media", since it's deliberately not a real platform (see the comment where
// socialMediaRow is built in buildAdSpendReportWorkbook).
export interface SocialMediaEmailSummary {
  daySpend: number;
  daySpendTax: number;
  product: string;
  price: number;
  day: ProductMetricBlock;
  range: ProductMetricBlock;
}

// Google (direct/website) orders — no day/range split (unlike Social Media): the source workbook
// only compiles as one batch per upload, so this is just the two totals, already scoped to the
// report's date range by fetchGoogleOrders, that the Summary sheet's Google row shows in its
// QTS/Value columns.
export interface GoogleEmailSummary {
  totalUnits: number;
  totalValue: number;
}

export interface AdSpendReportResult {
  wb: XLSX.WorkBook;
  filename: string;
  endDate: string;
  rangeStart: string;
  productCount: number;
  platformTotals: { platform: Platform; daySpendTax: number; rangeSpendTax: number }[];
  platformSummaries: PlatformEmailSummary[];
  // null when there's no Social Media spend for this window — same condition that skips the
  // Summary sheet's own "Social Media" row.
  socialMediaSummary: SocialMediaEmailSummary | null;
  // null when there's no Google Orders data on file at all — same condition that skips the
  // Summary sheet's own "Google" row.
  googleSummary: GoogleEmailSummary | null;
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
  rangeStart: string,
  listingPriceFor: (platform: Platform, sku: string) => number | undefined
): Promise<number> {
  const rows: Record<string, unknown>[] = [];
  platforms.forEach(({ platform, products }) => {
    products.forEach((p) => {
      if (spendTax(p.range) <= 0 && p.range.units <= 0) return;
      const listingPrice = listingPriceFor(platform, p.sku);
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
        day_acos: acosCell(p.day, p.price, listingPrice),
        range_spend: round2(p.range.spend),
        range_spend_tax: round2(spendTax(p.range)),
        range_orders: p.range.units,
        range_cpc: round2(computeCpc(p.range)),
        range_acos: acosCell(p.range, p.price, listingPrice),
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

  // Amazon/Flipkart's current live listing-table prices — fetched ahead of everything else below
  // since fetchFlipkartProducts itself now needs flipkartListingPriceMap (its Invoice-Amount-
  // missing revenue fallback, see flipkartRowRevenue's own comment) as an argument, not just this
  // function's own later computeAcos call sites (the zero-Total-Ad-Orders ACOS gate).
  const [amazonListingPriceMap, flipkartListingPriceMap] = await Promise.all([
    fetchAmazonListingPriceMap(),
    fetchFlipkartListingPriceMap(),
  ]);
  // Fetched once and shared across all three platforms — the seller's own
  // approved SKU -> product name list, checked first before falling back to
  // whatever name shows up on an order/price-listing row (see resolveName).
  const [master, masterSkuid, masterSkuidCatalog, masterSkuidsByName, productMarketing, amz, fk, ms, socialMedia, googleOrders] = await Promise.all([
    fetchProductMasterMap(),
    fetchMasterSkuidMap(),
    fetchMasterSkuidAmazonCatalog(),
    fetchMasterSkuidsByName(),
    fetchProductMarketingMap(),
    fetchAmazonProducts(range, endDate),
    fetchFlipkartProducts(range, endDate, flipkartListingPriceMap),
    fetchMeeshoProducts(range, endDate),
    fetchSocialMediaAdSpend(range, endDate),
    fetchGoogleOrders(range, endDate),
  ]);
  // Per-platform listing-price lookup for every computeAcos call site below (via acosCell/
  // acosSortRank's own listingPrice parameter) — Meesho has no listing table, so it's omitted
  // there and computeAcos's own gate falls back to its `price` argument, unchanged from before
  // this feature. A merged multi-SKU row's comma-joined p.sku (see groupProductsByName) is never a
  // key in either map, so it degrades the same way — falls back to `price`, not a crash or a 0.
  const listingPriceFor = (platform: Platform, sku: string): number | undefined =>
    platform === "Amazon" ? amazonListingPriceMap.get(sku) : platform === "Flipkart" ? flipkartListingPriceMap.get(sku) : undefined;
  // The master lists one SKU spelling per product (e.g. "B-BULB-...-PK5(FK)"),
  // but ad/order data carries whatever variant spelling that platform export
  // used (e.g. "B-BULB-...-PK5-1") — a real, different string, not a typo.
  // buildProductMasterResolver falls back to matching on the SKU's base (see
  // skuBase in productMasterUpload.ts) for these. This only changes which
  // NAME gets displayed — every spend/order figure stays keyed on the exact SKU.
  // master_product_marketing is the marketing team's freshest, most current master — checked
  // first; master_product_skuid and barm_product_master only fill in a SKU it doesn't have.
  const { resolveName: resolveBarmName } = buildProductMasterResolver(master);
  const { resolveName: resolveSkuidName, resolveTax: resolveSkuidTax } = buildMasterSkuidResolver(masterSkuid);
  const { resolveName: resolveMarketingName } = buildProductMarketingResolver(productMarketing);
  const resolveName = (sku: string, fallback: string) =>
    resolveMarketingName(sku, resolveSkuidName(sku, resolveBarmName(sku, fallback)));
  // sku -> master_product_skuid's own "Product Name", passed to every groupProductsByName call
  // below as its third argument so sibling SKUs of one product never split into separate report
  // rows just because only some of them have a master_product_marketing entry (see
  // groupProductsByName's skuToMasterSkuidName param comment for the full explanation).
  const skuToMasterSkuidName = new Map<string, string>([...masterSkuid.entries()].map(([sku, entry]) => [sku, entry.name]));
  [amz.products, fk.products, ms.products].forEach((products) => {
    products.forEach((p) => {
      p.name = resolveName(p.sku, p.name);
      // Tagged onto both windows here, once per product, rather than looked up
      // inside spendTax on every call — the same SKU's rate never changes
      // within a single report run.
      const gst = gstMultiplierFromTax(resolveSkuidTax(p.sku));
      p.day.gstMultiplier = gst;
      p.range.gstMultiplier = gst;
    });
  });

  // Seed a zero-activity row for every known Amazon catalog SKU with no spend/order data at all
  // this window, so "B Arm orders" (the one sheet here that isn't ad-spend-scoped — see its own
  // comment) can show what ISN'T selling, at the bottom. Flipkart/Meesho aren't seeded — there's
  // no equivalent full-catalog source for them yet. The ad-spend-scoped sheets (Ad spend report,
  // Low Spend Campaigns) deliberately still exclude these: they proved a real "purely-organic
  // rows inflate Orders" bug when zero-spend rows were included, so this doesn't touch them.
  masterSkuidCatalog.forEach((entry) => {
    if (amz.products.has(entry.sku)) return;
    amz.products.set(entry.sku, {
      platform: "Amazon",
      sku: entry.sku,
      name: resolveName(entry.sku, entry.name),
      price: 0,
      day: { spend: 0, units: 0, gstMultiplier: gstMultiplierFromTax(resolveSkuidTax(entry.sku)) },
      range: { spend: 0, units: 0, gstMultiplier: gstMultiplierFromTax(resolveSkuidTax(entry.sku)) },
    });
  });

  if (!amz.products.size && !fk.products.size && !ms.products.size) {
    throw new Error(
      `No uploaded Amazon, Flipkart or Meesho ad/order data in ${dotDate(range.start)} to ${dotDate(endDate)}. ` +
        `Upload the reports for that period on the Upload pages first.`
    );
  }

  const platforms: { platform: Platform; products: Map<string, ProductRow>; overallDay: SalesAgg; overallRange: SalesAgg; campaigns: CampaignSpendRow[]; revenueRangeBySku: Map<string, number> }[] = [
    { platform: "Amazon", products: amz.products, overallDay: amz.overallDay, overallRange: amz.overallRange, campaigns: amz.campaigns, revenueRangeBySku: amz.revenueRangeBySku },
    { platform: "Flipkart", products: fk.products, overallDay: fk.overallDay, overallRange: fk.overallRange, campaigns: fk.campaigns, revenueRangeBySku: fk.revenueRangeBySku },
    { platform: "Meesho", products: ms.products, overallDay: ms.overallDay, overallRange: ms.overallRange, campaigns: ms.campaigns, revenueRangeBySku: ms.revenueRangeBySku },
  ];

  const incompleteDates: AdSpendReportResult["incompleteDates"] = [
    { platform: "Amazon" as const, reportDates: amz.reportDates },
    { platform: "Flipkart" as const, reportDates: fk.reportDates },
    { platform: "Meesho" as const, reportDates: ms.reportDates },
  ]
    .filter(({ reportDates }) => reportDates.size > 0)
    .map(({ platform, reportDates }) => ({ platform, missingDates: missingDates(reportDates, range.start, endDate) }))
    .filter(({ missingDates }) => missingDates.length > 0);

  const historyRowsSaved = await saveAdSpendHistory(platforms, endDate, range.start, listingPriceFor);

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
  // 21 columns: A Platform, B/C Ad spend without/with tax (range total), D/E
  // Product/price, F-L day metrics, M-S range metrics — both blocks now
  // Spend, Spend(with tax), Total Orders, Total Sales, CPC, ACOS, Ad Sales
  // (Total Sales is real per-order revenue for Amazon/Flipkart (see
  // WindowAgg.revenue), the flat Price x Total Orders estimate for Meesho
  // per the seller's choice; Ad Sales is Amazon's own ad-attributed Sales
  // figure — computeAcos's adAttributedSales — blank for Flipkart/Meesho,
  // which have no such data; both added at the seller's explicit request,
  // in both the day and range blocks), T/U Overall sales QTS/Value (single
  // reporting day, matching the dayLabel header — NOT the 7-day range, see
  // the day-vs-range note where these cells are written below) —
  // A,B,C,T,U merge down across however many product rows that platform gets.
  const SUM_COLS = 21;
  // Both the day and range blocks get the extra Total Sales/Ad Sales columns here — the "Ad
  // spend report" sheet's day/range blocks still use the shared METRIC_NAMES/productAoaRow
  // below, unchanged, so that sheet's layout isn't affected by this Summary-only addition.
  const SUMMARY_METRIC_NAMES = ["Spend", "Spend(with tax)", "Total Orders", "Total Sales", "CPC", "ACOS", "Ad Sales"];
  const sumAoa: (string | number | null)[][] = [
    Array(SUM_COLS).fill(""),
    ["Summary", ...Array(SUM_COLS - 1).fill("")],
    Array(SUM_COLS).fill(""),
    ["Platform", "Ad spend (without tax)", "Ad spend (with tax)", "Worst ACOS product", "", dayLabel, "", "", "", "", "", "", rangeLabel, "", "", "", "", "", "", `Overall sales (${dayLabel})`, ""],
    ["", "", "", "Product", "price", ...SUMMARY_METRIC_NAMES, ...SUMMARY_METRIC_NAMES, "QTS", "Value"],
  ];
  const sumMerges: XLSX.Range[] = [
    { s: { r: 1, c: 0 }, e: { r: 1, c: SUM_COLS - 1 } },
    { s: { r: 3, c: 0 }, e: { r: 4, c: 0 } }, { s: { r: 3, c: 1 }, e: { r: 4, c: 1 } }, { s: { r: 3, c: 2 }, e: { r: 4, c: 2 } },
    { s: { r: 3, c: 3 }, e: { r: 3, c: 4 } }, { s: { r: 3, c: 5 }, e: { r: 3, c: 11 } }, { s: { r: 3, c: 12 }, e: { r: 3, c: 18 } },
    { s: { r: 3, c: 19 }, e: { r: 3, c: 20 } },
  ];
  const sumHeaderRowsStyled = [3, 4];
  const sumLabelCells: { row: number; platform: Platform }[] = [];
  const platformTotals: AdSpendReportResult["platformTotals"] = [];
  const platformSummaries: PlatformEmailSummary[] = [];
  // Action Sheet — every product whose trailing 7-day (range) ACOS clears 14%, tiered into a
  // recommended action by how bad it is: 14-25% ACOS is early warning ("Monitor"), 25-50% is a
  // real problem ("Reduce bid"), above 50% is urgent ("Reduce bid urgently"). No tier ever says
  // "Pause" — the seller explicitly asked that every row carry a concrete bid-cut % to act on
  // instead of a blanket pause instruction (this reverses an earlier version of this sheet that
  // did use "Pause" wording for the worst tier). Range ACOS specifically (not the
  // single reporting day) per the seller's request — a one-day spike is noisy, and this sheet
  // should reflect the week-long picture (the Summary sheet nearby still shows both Day and Range
  // ACOS per product unchanged). Flipkart rows get their generic tier text replaced below with a
  // real per-campaign Gemini suggestion where one's available — see "Flipkart Optimization
  // suggestions" further down. Amazon has no automated equivalent: real keyword-level bid/negative
  // -keyword suggestions there only exist via SellerMate's live API, which this server-side report
  // code has no access to (only an interactive chat session can pull that, on request).
  const ACTION_ACOS_THRESHOLD = 0.14;
  const actionRows: { platform: Platform; name: string; sku: string; campaign?: string; price: number; spend: number; spendTax: number; orders: number; acos: number; action: string }[] = [];
  // Fallback action for a row with no matched campaign (see enrichOptimizationActionRows below,
  // which overwrites this with a campaign-specific suggestion when one is found) — still gives a
  // concrete bid-cut % based on the SKU's own 7-day ACOS, rather than leaving it a vague tier label,
  // per the seller's own request that every row carry a number.
  const bidCutPct = (acosPct: number): number => (acosPct >= 90 ? 50 : acosPct >= 60 ? 35 : 20);
  const actionFor = (acosFrac: number): string => {
    const note = "No matching campaign found in the uploaded ad data to confirm which ad group/keyword to open.";
    // The residual sentinel — actionSheetAcos still returns it, but only when even the Spend/Total
    // Sales fallback's own denominator is 0 (no order data at all this window to estimate from) —
    // gets an honest "ACOS unavailable" instead of a fabricated "(7-day ACOS 999%)"; the row still
    // clears the >14% threshold and needs a bid cut, so the highest tier still applies.
    if (acosFrac === ACOS_UNDEFINED_SENTINEL) {
      return `Reduce bid urgently — cut bids ~50% (7-day ACOS unavailable — real ad spend with no order data to estimate sales from this window). ${note}`;
    }
    const acosPct = Math.round(acosFrac * 100);
    const cut = bidCutPct(acosPct);
    if (acosPct > 50) return `Reduce bid urgently — cut bids ~${cut}% (7-day ACOS ${acosPct}%). ${note}`;
    if (acosPct > 25) return `Reduce bid ~${cut}% (7-day ACOS ${acosPct}%). ${note}`;
    return `Monitor / review keywords — trim bids ~${cut}% (7-day ACOS ${acosPct}%). ${note}`;
  };
  const TOP_N = 3; // shortlist length — worst (highest) DAY ACOS first, matching the visible ACOS column, not range ACOS or spend
  platforms.forEach(({ platform, products, overallDay, overallRange }) => {
    // All products with any spend at all — totals must include every rupee,
    // not just the ones that clear the shortlist bar below. Grouped by
    // resolved product name first, so a product's 4-5 SKU variants sum into
    // one row instead of showing up as separate near-duplicate rows.
    const rows = groupProductsByName([...products.values()], undefined, skuToMasterSkuidName).filter((p) => spendTax(p.range) > 0);
    rows.forEach((p) => {
      const rangeAcos = actionSheetAcos(p.range, p.price);
      if (rangeAcos > ACTION_ACOS_THRESHOLD) {
        actionRows.push({
          platform,
          name: p.name,
          sku: p.sku,
          price: p.price,
          // Spend/Orders here are the 7-day range, matching the ACOS column's window — showing
          // the single reporting day's spend (which can be ₹0 for a SKU with no activity today
          // but real ad spend earlier in the week) produced rows reading "₹0.00 spend, 91% ACOS",
          // which looked wrong even though it wasn't. The Summary sheet nearby still has the
          // single-day figures.
          spend: round2(p.range.spend),
          spendTax: round2(spendTax(p.range)),
          orders: p.range.units,
          acos: pct(rangeAcos),
          action: actionFor(rangeAcos),
        });
      }
    });
    const rangeSpendRaw = rows.reduce((s, p) => s + p.range.spend, 0);
    const daySpendRaw = rows.reduce((s, p) => s + p.day.spend, 0);
    // Summed from each product's own already-tax-adjusted spendTax() rather than
    // (blended raw total x one flat rate) — products on the same platform can carry
    // different real GST rates, so there's no single multiplier that applies to a
    // combined sum across all of them.
    const daySpendTaxTotal = rows.reduce((s, p) => s + spendTax(p.day), 0);
    const rangeSpendTaxTotal = rows.reduce((s, p) => s + spendTax(p.range), 0);
    platformTotals.push({ platform, daySpendTax: daySpendTaxTotal, rangeSpendTax: rangeSpendTaxTotal });

    // A product that's barely spent anything can show a misleadingly great
    // (or terrible) ACOS from sheer small-sample noise — one lucky/unlucky
    // sale swings the ratio wildly. Require real spend before a product is
    // eligible for "worst ACOS," so the shortlist highlights genuine problem
    // products, not noise.
    const shortlist = rows
      .filter((p) => spendTax(p.range) > ACOS_SHORTLIST_MIN_SPEND)
      .sort((a, b) => acosSortRank(b.day, b.price, listingPriceFor(platform, b.sku)) - acosSortRank(a.day, a.price, listingPriceFor(platform, a.sku)))
      .slice(0, TOP_N);
    platformSummaries.push({
      platform,
      daySpend: round2(daySpendRaw),
      daySpendTax: round2(daySpendTaxTotal),
      rangeSpend: round2(rangeSpendRaw),
      rangeSpendTax: round2(rangeSpendTaxTotal),
      overallDayUnits: overallDay.units,
      overallDayValue: round2(overallDay.value),
      overallRangeUnits: overallRange.units,
      overallRangeValue: round2(overallRange.value),
      topProducts: shortlist.map((p) => {
        const listingPrice = listingPriceFor(platform, p.sku);
        return {
          name: p.name,
          price: p.price,
          day: { spend: round2(p.day.spend), spendTax: round2(spendTax(p.day)), orders: p.day.units, cpc: round2(computeCpc(p.day)), acos: acosCell(p.day, p.price, listingPrice) },
          range: { spend: round2(p.range.spend), spendTax: round2(spendTax(p.range)), orders: p.range.units, cpc: round2(computeCpc(p.range)), acos: acosCell(p.range, p.price, listingPrice) },
        };
      }),
      allProducts: [...rows]
        .sort((a, b) => acosSortRank(b.day, b.price, listingPriceFor(platform, b.sku)) - acosSortRank(a.day, a.price, listingPriceFor(platform, a.sku)))
        .map((p) => {
          const listingPrice = listingPriceFor(platform, p.sku);
          return {
            name: p.name,
            price: p.price,
            day: { spend: round2(p.day.spend), spendTax: round2(spendTax(p.day)), orders: p.day.units, cpc: round2(computeCpc(p.day)), acos: acosCell(p.day, p.price, listingPrice) },
            range: { spend: round2(p.range.spend), spendTax: round2(spendTax(p.range)), orders: p.range.units, cpc: round2(computeCpc(p.range)), acos: acosCell(p.range, p.price, listingPrice) },
          };
        }),
    });

    const blockStart = sumAoa.length;
    const blockRows = Math.max(shortlist.length, 1);
    sumLabelCells.push({ row: blockStart, platform });
    if (shortlist.length) {
      shortlist.forEach((p, i) => {
        // Total Sales, per the seller's explicit request: Amazon/Flipkart use real per-order
        // revenue (WindowAgg.revenue — see fetchAmazonProducts/fetchFlipkartProducts and
        // groupProductsByName's plain sum of it across a product's SKU variants); Meesho stays
        // on the flat Price x Orders(units) estimate, same as the B Arm orders / Meesho
        // leaderboard sheets elsewhere in this workbook. Computed once for the day's Orders and
        // once for the range's, so each block gets its own Total Sales next to its own Orders count.
        const dayTotalSales = platform === "Meesho" ? round2(p.price * p.day.units) : round2(p.day.revenue || 0);
        const rangeTotalSales = platform === "Meesho" ? round2(p.price * p.range.units) : round2(p.range.revenue || 0);
        // Ad Sales, per the seller's explicit request: Amazon uses its own ad-attributed Sales
        // figure (the same adAttributedSales computeAcos uses for Amazon's ACOS); Flipkart uses
        // its own ads export's "Total Revenue" figure (WindowAgg.adSales, from fsnRows —
        // deliberately NOT the real per-order revenue used for Total Sales above, since this
        // column is meant to mirror the ad platform's own reported number, same idea as Amazon's);
        // Meesho uses its own ad report's "Orders by ad" count x Price (Meesho's ad export has no
        // ₹ sales figure the way Amazon's/Flipkart's do, only an ad-attributed order count).
        const dayAdSales =
          platform === "Amazon" ? (p.day.adAttributedSales !== undefined ? round2(p.day.adAttributedSales) : null)
          : platform === "Flipkart" ? round2(p.day.adSales || 0)
          : round2((p.day.adOrders || 0) * p.price);
        const rangeAdSales =
          platform === "Amazon" ? (p.range.adAttributedSales !== undefined ? round2(p.range.adAttributedSales) : null)
          : platform === "Flipkart" ? round2(p.range.adSales || 0)
          : round2((p.range.adOrders || 0) * p.price);
        // Summary sheet's own ACOS cells: Amazon keeps computeAcos's existing
        // adAttributedSales-based ratio (acosCell); Flipkart/Meesho use Spend/Ad Sales directly
        // here (summaryAcosCell), overriding the CPC/Price fallback acosCell would otherwise
        // fall back to for them — Summary-sheet-only, the Ad spend report and SKU Wise Report
        // sheets' ACOS columns for Flipkart/Meesho are untouched.
        const listingPrice = listingPriceFor(platform, p.sku);
        const daySummaryAcos = platform === "Amazon" ? acosCell(p.day, p.price, listingPrice) : summaryAcosCell(round2(p.day.spend), dayAdSales as number);
        const rangeSummaryAcos = platform === "Amazon" ? acosCell(p.range, p.price, listingPrice) : summaryAcosCell(round2(p.range.spend), rangeAdSales as number);
        sumAoa.push([
          // "Ad spend (without/with tax)" here is the SINGLE-DAY total, matching
          // the seller's own manual workbook's Summary sheet convention — the
          // 7-day range total is still shown per-product further right, and is
          // preserved separately in platformTotals.rangeSpendTax for the
          // post-generate toast on the Download page.
          i === 0 ? platform : "", i === 0 ? round2(daySpendRaw) : "", i === 0 ? round2(daySpendTaxTotal) : "",
          p.name, p.price,
          round2(p.day.spend), round2(spendTax(p.day)), p.day.units, dayTotalSales, round2(computeCpc(p.day)), daySummaryAcos, dayAdSales,
          round2(p.range.spend), round2(spendTax(p.range)), p.range.units, rangeTotalSales, round2(computeCpc(p.range)), rangeSummaryAcos, rangeAdSales,
          // Overall sales QTS/Value is the SINGLE reporting day's total (matches
          // the dayLabel header above), not the 7-day range — the seller's own
          // manual workbook tracks this figure daily, not as a weekly rollup.
          // The range total is still available per-platform in platformTotals /
          // platformSummaries.overallRangeUnits/-Value for the emailed summary.
          i === 0 ? overallDay.units : "", i === 0 ? round2(overallDay.value) : "",
        ]);
      });
    } else {
      sumAoa.push([platform, 0, 0, "(no ad spend in range)", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", overallDay.units, round2(overallDay.value)]);
    }
    if (blockRows > 1) {
      [0, 1, 2, 19, 20].forEach((c) => sumMerges.push({ s: { r: blockStart, c }, e: { r: blockStart + blockRows - 1, c } }));
    }
  });

  // Social Media (Meta Ads) — one extra Summary row, added only when there's actually spend to
  // show (an empty/not-yet-uploaded barm_daily_social_media leaves the Summary sheet unchanged).
  // Orders/CPC/ACOS are cross-referenced from the Amazon platform's own already-computed product
  // rows for the one product currently running Meta ads — per the seller's explicit choice, since
  // Meta's campaign name alone ("Peak flow meter - <date>") doesn't distinguish the with-BLE vs
  // without-BLE SKU families, and only the without-BLE listing is what these campaigns promote.
  // Overall sales QTS/Value is left blank here — that sale is already counted once under Amazon's
  // own Overall Sales, so repeating it would double-count.
  let socialMediaRow: number | null = null;
  let socialMediaSummary: SocialMediaEmailSummary | null = null;
  if (socialMedia.daySpend > 0 || socialMedia.rangeSpend > 0) {
    const SOCIAL_MEDIA_PRODUCT_NAME = "Sonmol Peak Flow meter (without BLE)";
    const amazonRowsForSocial = groupProductsByName([...amz.products.values()], undefined, skuToMasterSkuidName);
    const socialProduct = amazonRowsForSocial.find((p) => p.name.trim().toLowerCase() === SOCIAL_MEDIA_PRODUCT_NAME.toLowerCase());
    const price = socialProduct?.price ?? 0;
    // This is a real Amazon SKU (see socialProduct above), so it gets the same listing-price
    // lookup as every other Amazon computeAcos call site — dayAgg/rangeAgg below never carry an
    // adOrders field, so they always take the new CPC/listingPrice-or-price gate regardless.
    const listingPrice = socialProduct ? amazonListingPriceMap.get(socialProduct.sku) : undefined;
    const dayAgg: WindowAgg = { spend: socialMedia.daySpend, units: socialProduct?.day.units ?? 0 };
    const rangeAgg: WindowAgg = { spend: socialMedia.rangeSpend, units: socialProduct?.range.units ?? 0 };
    socialMediaRow = sumAoa.length;
    sumAoa.push([
      "Social Media",
      round2(socialMedia.daySpend), round2(spendTax(dayAgg)),
      socialProduct?.name ?? SOCIAL_MEDIA_PRODUCT_NAME, price,
      round2(dayAgg.spend), round2(spendTax(dayAgg)), dayAgg.units, round2(price * dayAgg.units), round2(computeCpc(dayAgg)), acosCell(dayAgg, price, listingPrice), null,
      round2(rangeAgg.spend), round2(spendTax(rangeAgg)), rangeAgg.units, round2(price * rangeAgg.units), round2(computeCpc(rangeAgg)), acosCell(rangeAgg, price, listingPrice), null,
      "", "",
    ]);
    // Same figures as the Summary-sheet row above, reshaped for the emailed daily digest (see
    // buildAdSpendDailyHtml in supabase/functions/send-ad-spend-email/index.ts), which renders
    // this as one more row directly below Meesho's, per the seller's explicit request.
    socialMediaSummary = {
      daySpend: round2(socialMedia.daySpend),
      daySpendTax: round2(spendTax(dayAgg)),
      product: socialProduct?.name ?? SOCIAL_MEDIA_PRODUCT_NAME,
      price,
      day: { spend: round2(dayAgg.spend), spendTax: round2(spendTax(dayAgg)), orders: dayAgg.units, cpc: round2(computeCpc(dayAgg)), acos: acosCell(dayAgg, price, listingPrice) },
      range: { spend: round2(rangeAgg.spend), spendTax: round2(spendTax(rangeAgg)), orders: rangeAgg.units, cpc: round2(computeCpc(rangeAgg)), acos: acosCell(rangeAgg, price, listingPrice) },
    };
  }

  // Google (direct/website) orders — one extra Summary row, same lightweight treatment as Social
  // Media above, added only when there's actually data on file. Ad spend/CPC/ACOS columns are left
  // at 0/blank throughout (this channel has no ad campaign data at all — see fetchGoogleOrders).
  // Total Orders/Total Sales are shown for BOTH the day block and the range block (same shape as
  // every real platform's row), and Overall Sales QTS/Value are the SINGLE reporting day's total —
  // fixed from the previous version, which put the 7-day range total in that last column, mislabeled
  // under the single-day "Overall sales (<date>)" header (see fetchGoogleOrders's own comment).
  let googleRow: number | null = null;
  let googleSummary: GoogleEmailSummary | null = null;
  if (googleOrders.rangeUnits > 0 || googleOrders.rangeValue > 0) {
    googleRow = sumAoa.length;
    sumAoa.push([
      "Google",
      0, 0,
      "(Orders/Sales only — no ad spend data)", "",
      0, 0, googleOrders.dayUnits, round2(googleOrders.dayValue), "", "", "",
      0, 0, googleOrders.rangeUnits, round2(googleOrders.rangeValue), "", "", "",
      googleOrders.dayUnits, round2(googleOrders.dayValue),
    ]);
    // Same figures, reshaped for the emailed daily digest (see buildAdSpendDailyHtml in
    // supabase/functions/send-ad-spend-email/index.ts), which renders this as one more row
    // directly below Social Media's, per the same pattern. Day totals, matching the fix above —
    // the digest is headlined by the single reporting day, same as every other platform's summary.
    googleSummary = { totalUnits: googleOrders.dayUnits, totalValue: round2(googleOrders.dayValue) };
  }

  // Optimization suggestions (Gemini) — replaces the Action Sheet's generic tiered text with a
  // real per-campaign bid-cut/negative-keyword recommendation, for both Amazon and Flipkart rows,
  // matching the seller's own request. One Gemini call per platform covers every flagged campaign
  // at once (not one call per product) to keep this affordable and fast on the unattended daily
  // cron. See enrichOptimizationActionRows's own comment for exactly what data each is sourced from.
  await enrichAmazonActionRows(actionRows, amz.spRows, endDate);
  await enrichFlipkartActionRows(actionRows, fk.fsnRows);

  const wsSummary = XLSX.utils.aoa_to_sheet(sumAoa);
  wsSummary["!merges"] = sumMerges;
  if (wsSummary["A2"]) wsSummary["A2"].s = { font: { bold: true, sz: 13 } };
  sumHeaderRowsStyled.forEach((row) => styleHeader(wsSummary, row, SUM_COLS, "312E81"));
  sumLabelCells.forEach(({ row, platform }) => styleLabel(wsSummary, XLSX.utils.encode_cell({ r: row, c: 0 }), PLATFORM_FILL[platform]));
  // Clicking the "Amazon"/"Flipkart"/"Meesho" platform cell opens the live
  // Daily Ad Spend dashboard page (same cross-platform data this report is
  // built from) — a hyperlink, not just a styled label, so the seller can
  // jump from the static Excel snapshot straight to the always-current view.
  sumLabelCells.forEach(({ row, platform }) => {
    const addr = XLSX.utils.encode_cell({ r: row, c: 0 });
    const cell = wsSummary[addr];
    if (!cell) return;
    cell.l = { Target: `${SITE_URL}/dashboard/daily-ad-spend`, Tooltip: `Open ${platform} in the Daily Ad Spend dashboard` };
  });
  // Social Media isn't a real `Platform` (see the comment where socialMediaRow is built), so it's
  // styled directly here instead of through sumLabelCells/PLATFORM_FILL — same bold-label
  // treatment, a Meta-blue fill, no dashboard hyperlink (there's no dedicated Social Media page).
  if (socialMediaRow !== null) styleLabel(wsSummary, XLSX.utils.encode_cell({ r: socialMediaRow, c: 0 }), "1877F2");
  // Google isn't a real `Platform` either (see the comment where googleRow is built) — same
  // treatment as Social Media above, Google's own brand blue, no dashboard hyperlink (there's no
  // dedicated Google analytics page, just the /dashboard/google/upload upload page).
  if (googleRow !== null) styleLabel(wsSummary, XLSX.utils.encode_cell({ r: googleRow, c: 0 }), "4285F4");
  wsSummary["!cols"] = [
    { wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 60 }, { wch: 10 },
    { wch: 13 }, { wch: 13 }, { wch: 13 }, { wch: 24 }, { wch: 13 }, { wch: 13 }, { wch: 13 }, // day block: Spend, Spend(with tax), Total Orders, Total Sales (wider header), CPC, ACOS, Ad Sales
    { wch: 13 }, { wch: 13 }, { wch: 13 }, { wch: 24 }, { wch: 13 }, { wch: 13 }, { wch: 13 }, // range block: same shape
    { wch: 10 }, { wch: 14 },
  ];
  applyNumberFormats(wsSummary, 5, sumAoa.length, {
    1: CURRENCY_FMT, 2: CURRENCY_FMT, 4: CURRENCY_FMT, 5: CURRENCY_FMT, 6: CURRENCY_FMT,
    8: CURRENCY_FMT, 9: CURRENCY_FMT, 10: PERCENT_FMT, 11: CURRENCY_FMT,
    12: CURRENCY_FMT, 13: CURRENCY_FMT, 15: CURRENCY_FMT, 16: CURRENCY_FMT, 17: PERCENT_FMT, 18: CURRENCY_FMT,
    20: CURRENCY_FMT,
  });
  // Long titles (a SKU with no product-master entry falls back to the raw
  // marketing title) need to wrap within the column instead of overflowing
  // or reading as clipped — same fix applied to the Ad spend report sheet's
  // Product Name column below.
  for (let r = 5; r < sumAoa.length; r++) {
    const addr = XLSX.utils.encode_cell({ r, c: 3 });
    if (wsSummary[addr]) wsSummary[addr].s = { alignment: { wrapText: true, vertical: "top" } };
  }
  XLSX.utils.book_append_sheet(wb, wsSummary, "Summary");

  // ── Ad spend report sheet (every advertised product, per platform) ──
  // SKU sits ahead of Product Name so a name resolved via a fallback (or one
  // that's just wrong/ambiguous) can always be traced back to the exact SKU
  // the spend/orders were keyed on.
  const DETAIL_COLS = 13;
  const detailAoa: (string | number | null)[][] = [];
  const detailHeaderRows: number[] = [];
  const detailLabelCells: { addr: string; platform: Platform }[] = [];
  const detailMerges: XLSX.Range[] = [];
  platforms.forEach(({ platform, products }) => {
    // Sorted by day ACOS descending (worst first) — same metric/direction as the Summary
    // sheet's "Worst ACOS product" shortlist, so a reader doesn't have to reconcile two
    // different orderings for the same numbers across sheets.
    // Grouped by resolved product name first — a product's 4-5 SKU variants
    // (per the product-master table) merge into one row with summed spend/
    // orders, instead of printing once per SKU with the name repeated.
    // Scoped to products with actual ad spend in the range — same bar the
    // Summary sheet's per-platform totals already use. A product that only
    // ever sold organically (₹0 spend, real order units) previously still
    // printed here with Spend/CPC/ACOS all reading 0, which isn't an "ad"
    // row at all: against a hand-built reference report, these purely-organic
    // rows were the single biggest source of mismatch — they inflated this
    // sheet's Orders total ~40-60% above what an ad-spend-only view shows.
    const rows = groupProductsByName([...products.values()], masterSkuidsByName, skuToMasterSkuidName)
      .filter((p) => spendTax(p.range) > 0)
      .sort((a, b) => acosSortRank(b.day, b.price, listingPriceFor(platform, b.sku)) - acosSortRank(a.day, a.price, listingPriceFor(platform, a.sku)));
    detailLabelCells.push({ addr: XLSX.utils.encode_cell({ r: detailAoa.length, c: 0 }), platform });
    detailAoa.push([platform, ...Array(DETAIL_COLS - 1).fill("")]);
    detailAoa.push(Array(DETAIL_COLS).fill(""));
    const groupRow = detailAoa.length;
    detailHeaderRows.push(groupRow);
    detailAoa.push(["SKU(s)", "Product Name", "Price", dayLabel, "", "", "", "", rangeLabel, "", "", "", ""]);
    detailAoa.push(["", "", "", ...METRIC_NAMES, ...METRIC_NAMES]);
    detailMerges.push(
      { s: { r: groupRow, c: 0 }, e: { r: groupRow + 1, c: 0 } },
      { s: { r: groupRow, c: 1 }, e: { r: groupRow + 1, c: 1 } },
      { s: { r: groupRow, c: 2 }, e: { r: groupRow + 1, c: 2 } },
      { s: { r: groupRow, c: 3 }, e: { r: groupRow, c: 7 } },
      { s: { r: groupRow, c: 8 }, e: { r: groupRow, c: 12 } },
    );
    rows.forEach((p) => detailAoa.push([p.sku, ...productAoaRow(p, listingPriceFor(platform, p.sku))]));
    if (!rows.length) detailAoa.push(["(no advertised products with activity in range)", ...Array(DETAIL_COLS - 1).fill("")]);
    detailAoa.push([]);
  });

  // Google (direct/website) orders — appended as its own small Product/Quantity/Price/Sales
  // section, same shape as the "B Arm orders"/"Meesho (B Arm) orders" leaderboards elsewhere in
  // this workbook, rather than forced into the ad-spend column layout above: Spend/CPC/ACOS don't
  // exist for this channel, and every platform block above is filtered to spend > 0 (every Google
  // row would fail that and print as "no advertised products with activity"). Scoped to this
  // report's date/range window by order_date, same as fetchGoogleOrders's Summary-row figures.
  let googleDetailLabelRow: number | null = null;
  let googleDetailHeaderRow: number | null = null;
  if (googleOrders.perProduct.length) {
    googleDetailLabelRow = detailAoa.length;
    detailAoa.push(["Google"]);
    googleDetailHeaderRow = detailAoa.length;
    detailAoa.push(["Product", "Quantity", "Price", "Sales"]);
    googleOrders.perProduct.forEach((p) => detailAoa.push([p.name, p.quantity, round2(p.price), round2(p.quantity * p.price)]));
    detailAoa.push([]);
  }

  const wsDetail = XLSX.utils.aoa_to_sheet(detailAoa);
  wsDetail["!merges"] = detailMerges;
  detailLabelCells.forEach(({ addr, platform }) => styleLabel(wsDetail, addr, PLATFORM_FILL[platform]));
  detailHeaderRows.forEach((row) => { styleHeader(wsDetail, row, DETAIL_COLS, "312E81"); styleHeader(wsDetail, row + 1, DETAIL_COLS, "312E81"); });
  if (googleDetailLabelRow !== null) styleLabel(wsDetail, XLSX.utils.encode_cell({ r: googleDetailLabelRow, c: 0 }), "4285F4");
  if (googleDetailHeaderRow !== null) styleHeader(wsDetail, googleDetailHeaderRow, 4, "312E81");
  wsDetail["!cols"] = [{ wch: 30 }, { wch: 60 }, { wch: 10 }, ...Array.from({ length: DETAIL_COLS - 3 }, () => ({ wch: 13 }))];
  applyNumberFormats(wsDetail, 0, detailAoa.length, {
    2: CURRENCY_FMT, 3: CURRENCY_FMT, 4: CURRENCY_FMT, 6: CURRENCY_FMT, 7: PERCENT_FMT,
    8: CURRENCY_FMT, 9: CURRENCY_FMT, 11: CURRENCY_FMT, 12: PERCENT_FMT,
  });
  // Long titles (a SKU with no product-master entry falls back to the raw
  // marketing title) need to wrap within the column instead of overflowing —
  // same for the SKU(s) column now that a merged product row can list several
  // comma-joined SKU variants.
  for (let r = 0; r < detailAoa.length; r++) {
    [0, 1].forEach((c) => {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (wsDetail[addr] && wsDetail[addr].v) wsDetail[addr].s = { ...wsDetail[addr].s, alignment: { wrapText: true, vertical: "top" } };
    });
  }
  XLSX.utils.book_append_sheet(wb, wsDetail, "Ad spend report");

  // ── SKU Wise Report — flat, per-SKU (ungrouped) listing across all platforms ──
  // Unlike "Ad spend report" above (which merges every SKU variant of a product into one row via
  // groupProductsByName), this sheet keeps one row per actual SKU — added alongside it at the
  // seller's request, not replacing it, so a SKU's own individual numbers can be sorted/filtered
  // directly by Platform or Price. Every metric is split into its own single-day and 7-day-range
  // pair of columns (same dayLabel/rangeLabel two-row header pattern as the Ad spend report sheet
  // above), per the seller's explicit request that this sheet stop being range-only. Total Sales:
  // Amazon/Flipkart use real per-order revenue (WindowAgg.revenue — SUM(item-price x quantity) /
  // SUM(Invoice Amount) across this SKU's own non-cancelled order rows); Meesho stays on the flat
  // Price x Orders(units) estimate, at the seller's explicit choice (also still what the B Arm
  // orders / Meesho leaderboard sheets elsewhere in this workbook use). ACOS uses the same
  // computeAcos as every other sheet (Ad Spend / Ad-Attributed Sales when on file, falling back to
  // Total Sales otherwise — see computeAcos's own comment). Total Ad Sales / Total Ad Orders are
  // each platform's own ad-attributed sales/orders figures — the same ones ACOS is computed from —
  // surfaced here directly so a reader can see the ACOS denominator, not just the ratio: Amazon's
  // Sponsored Products "7 Day Total Sales"/"7 Day Total Orders" (blank when a SKU has no Sponsored
  // Products row at all, i.e. SB/SD-only spend, matching Amazon's own raw export convention);
  // Flipkart's ads-export "Total Revenue"/direct+indirect Units Sold; Meesho's ad report's own
  // "Orders by ad" count, and that count x Price for Ad Sales (Meesho's ad export has no ₹ sales
  // figure directly).
  const SKU_WISE_METRIC_NAMES = ["Spend (without tax)", "Spend (with tax)", "Orders", "Total Sales", "CPC", "ACOS", "Total Ad Sales", "Total Ad Orders"];
  const SKU_WISE_COLS = 3 + SKU_WISE_METRIC_NAMES.length * 2;
  const skuWiseRows: (string | number | null)[][] = [];
  platforms.forEach(({ platform, products, revenueRangeBySku }) => {
    [...products.values()]
      .filter((p) => spendTax(p.range) > 0)
      .forEach((p) => {
        // Meesho stays on the old flat Price x range-Orders estimate, per the seller's explicit
        // choice — only Amazon/Flipkart use the real per-order revenue sum above. Day uses
        // p.day.revenue directly (Amazon/Flipkart) — the same field revenueRangeBySku's range
        // figure is itself sourced from, just not exposed as its own returned Map for the day window.
        const dayTotalSales = platform === "Meesho" ? p.price * p.day.units : p.day.revenue || 0;
        const rangeTotalSales = platform === "Meesho" ? p.price * p.range.units : revenueRangeBySku.get(p.sku) || 0;
        const dayAdSales =
          platform === "Amazon" ? (p.day.adAttributedSales !== undefined ? round2(p.day.adAttributedSales) : null)
          : platform === "Flipkart" ? round2(p.day.adSales || 0)
          : round2((p.day.adOrders || 0) * p.price);
        const rangeAdSales =
          platform === "Amazon" ? (p.range.adAttributedSales !== undefined ? round2(p.range.adAttributedSales) : null)
          : platform === "Flipkart" ? round2(p.range.adSales || 0)
          : round2((p.range.adOrders || 0) * p.price);
        const dayAdOrders = platform === "Amazon" ? (p.day.adOrders !== undefined ? p.day.adOrders : null) : p.day.adOrders || 0;
        const rangeAdOrders = platform === "Amazon" ? (p.range.adOrders !== undefined ? p.range.adOrders : null) : p.range.adOrders || 0;
        // This sheet is ungrouped (one row per real SKU, unlike Ad spend report's merged rows
        // above), so p.sku is always a single exact SKU and always a valid key into the maps.
        const listingPrice = listingPriceFor(platform, p.sku);
        skuWiseRows.push([
          p.sku, platform, p.price,
          round2(p.day.spend), round2(spendTax(p.day)), p.day.units, round2(dayTotalSales), round2(computeCpc(p.day)), acosCell(p.day, p.price, listingPrice), dayAdSales, dayAdOrders,
          round2(p.range.spend), round2(spendTax(p.range)), p.range.units, round2(rangeTotalSales), round2(computeCpc(p.range)), acosCell(p.range, p.price, listingPrice), rangeAdSales, rangeAdOrders,
        ]);
      });
  });
  // Highest range Total Sales first, across every platform — the point of a flat, per-SKU sheet is
  // to see top sellers regardless of which platform they're on. Index 14 = range Total Sales,
  // per SKU_WISE_METRIC_NAMES's position in the range block (cols 11-18, Total Sales is 4th).
  const SKU_WISE_RANGE_TOTAL_SALES_COL = 3 + SKU_WISE_METRIC_NAMES.length + SKU_WISE_METRIC_NAMES.indexOf("Total Sales");
  skuWiseRows.sort((a, b) => Number(b[SKU_WISE_RANGE_TOTAL_SALES_COL]) - Number(a[SKU_WISE_RANGE_TOTAL_SALES_COL]));
  const skuWiseAoa: (string | number | null)[][] = [
    ["", "", "", dayLabel, "", "", "", "", "", "", "", rangeLabel, "", "", "", "", "", "", ""],
    ["SKU ID", "Platform", "Price", ...SKU_WISE_METRIC_NAMES, ...SKU_WISE_METRIC_NAMES],
    ...skuWiseRows,
  ];
  const wsSkuWise = XLSX.utils.aoa_to_sheet(skuWiseAoa);
  wsSkuWise["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 1, c: 0 } },
    { s: { r: 0, c: 1 }, e: { r: 1, c: 1 } },
    { s: { r: 0, c: 2 }, e: { r: 1, c: 2 } },
    { s: { r: 0, c: 3 }, e: { r: 0, c: 2 + SKU_WISE_METRIC_NAMES.length } },
    { s: { r: 0, c: 3 + SKU_WISE_METRIC_NAMES.length }, e: { r: 0, c: 2 + SKU_WISE_METRIC_NAMES.length * 2 } },
  ];
  styleHeader(wsSkuWise, 0, SKU_WISE_COLS, "312E81");
  styleHeader(wsSkuWise, 1, SKU_WISE_COLS, "312E81");
  wsSkuWise["!views"] = [{ state: "frozen", ySplit: 2 }];
  wsSkuWise["!cols"] = [
    { wch: 24 }, { wch: 10 }, { wch: 10 },
    ...Array.from({ length: SKU_WISE_METRIC_NAMES.length * 2 }, () => ({ wch: 14 })),
  ];
  const dayBlockStart = 3;
  const rangeBlockStart = 3 + SKU_WISE_METRIC_NAMES.length;
  applyNumberFormats(wsSkuWise, 2, skuWiseAoa.length, {
    2: CURRENCY_FMT,
    [dayBlockStart]: CURRENCY_FMT, [dayBlockStart + 1]: CURRENCY_FMT, [dayBlockStart + 3]: CURRENCY_FMT,
    [dayBlockStart + 4]: CURRENCY_FMT, [dayBlockStart + 5]: PERCENT_FMT, [dayBlockStart + 6]: CURRENCY_FMT,
    [rangeBlockStart]: CURRENCY_FMT, [rangeBlockStart + 1]: CURRENCY_FMT, [rangeBlockStart + 3]: CURRENCY_FMT,
    [rangeBlockStart + 4]: CURRENCY_FMT, [rangeBlockStart + 5]: PERCENT_FMT, [rangeBlockStart + 6]: CURRENCY_FMT,
  });
  if (!skuWiseRows.length) XLSX.utils.sheet_add_aoa(wsSkuWise, [["(no advertised SKUs with activity in range)"]], { origin: { r: 2, c: 0 } });
  XLSX.utils.book_append_sheet(wb, wsSkuWise, "SKU Wise Report");

  // ── Ad Status Report — product name x platform, best-effort name match ──
  // No cross-platform SKU/product mapping exists in this dashboard, so a
  // product is matched across Amazon and Flipkart purely by its (lowercased,
  // trimmed) product name. Two listings with slightly different titles on the
  // two platforms will show as two separate rows rather than one. 1/0 per
  // platform means "this platform has real Sales/Orders on this product this
  // range" (adStatusHasSales, i.e. a.units > 0) — NOT Spend and not raw
  // Impressions. A product with real ad spend but zero orders that window
  // reads as 0 here, per the seller's explicit instruction that spend alone
  // must never mark a platform "live".
  const statusKey = (name: string) => name.trim().toLowerCase();
  const statusNames = new Map<string, string>(); // key -> display name
  const statusHasSales: Record<Platform, Set<string>> = { Amazon: new Set(), Flipkart: new Set(), Meesho: new Set() };
  platforms.forEach(({ platform, products }) => {
    products.forEach((p) => {
      const key = statusKey(p.name);
      if (!statusNames.has(key)) statusNames.set(key, p.name);
      if (adStatusHasSales(p.range)) statusHasSales[platform].add(key);
    });
  });
  const statusAoa: (string | number)[][] = [["Product", "Amazon", "Flipkart", "Meesho"]];
  // Live-everywhere products first (3 platforms → 2 → 1 → 0), alphabetical within each
  // count so a reader scans down to find where a product with fewer live platforms sits,
  // rather than hunting alphabetically through all 273 rows for the ones running nowhere.
  const liveCount = (key: string) =>
    (statusHasSales.Amazon.has(key) ? 1 : 0) + (statusHasSales.Flipkart.has(key) ? 1 : 0) + (statusHasSales.Meesho.has(key) ? 1 : 0);
  [...statusNames.entries()]
    .sort((a, b) => liveCount(b[0]) - liveCount(a[0]) || a[1].localeCompare(b[1]))
    .forEach(([key, name]) => {
      statusAoa.push([name, statusHasSales.Amazon.has(key) ? 1 : 0, statusHasSales.Flipkart.has(key) ? 1 : 0, statusHasSales.Meesho.has(key) ? 1 : 0]);
    });
  const wsStatus = XLSX.utils.aoa_to_sheet(statusAoa);
  styleHeader(wsStatus, 0, 4, "312E81");
  wsStatus["!cols"] = [{ wch: 60 }, { wch: 10 }, { wch: 10 }, { wch: 10 }];
  wsStatus["!views"] = [{ state: "frozen", ySplit: 1 }];
  XLSX.utils.book_append_sheet(wb, wsStatus, "Ad Status Report");

  // ── Action Sheet — products over the 14% trailing-7-day ACOS threshold, worst first.
  // Spend/Orders/ACOS are ALL the 7-day range window here (unlike every other sheet's "Spend
  // (date)" columns, which are the single reporting day) — showing the single day's spend/orders
  // next to a 7-day ACOS produced rows like "₹0.00 spend, 91% ACOS" for a SKU with no activity
  // today but real spend earlier in the week, which read as wrong even though it wasn't. The
  // Summary sheet nearby is where the single-day figures still live.
  // Campaign Name + SKU ID replace the Product column (per the seller's own request) — Campaign
  // Name comes from enrichOptimizationActionRows's sku->campaign resolution above and is only
  // populated for rows that matched a real campaign in the uploaded ad-spend data; a row with no
  // match (e.g. Meesho, which has no campaign data in this app at all, or a SKU that didn't appear
  // in any campaign row) shows "-" rather than a guessed campaign name.
  const actionAoa: (string | number)[][] = [
    ["Platform", "Campaign Name", "SKU ID", "Price", `Spend (${dotDate(range.start)} to ${dotDate(endDate)})`, `Spend with tax (${dotDate(range.start)} to ${dotDate(endDate)})`, "Orders", `ACOS (${dotDate(range.start)} to ${dotDate(endDate)})`, "Recommended Action"],
  ];
  [...actionRows]
    .sort((a, b) => b.acos - a.acos)
    .forEach((r) => actionAoa.push([
      r.platform, r.campaign || "-", r.sku, r.price, r.spend, r.spendTax, r.orders,
      // The residual sentinel (see actionSheetAcos) blanks here instead of rendering as a literal
      // "999%" — same convention acosCell uses everywhere else in this workbook.
      r.acos === pct(ACOS_UNDEFINED_SENTINEL) ? "" : r.acos,
      r.action,
    ]));
  if (!actionRows.length) actionAoa.push(["(no products over the 14% 7-day ACOS threshold)", "", "", "", "", "", "", "", ""]);
  const wsAction = XLSX.utils.aoa_to_sheet(actionAoa);
  styleHeader(wsAction, 0, 9, "B91C1C");
  wsAction["!cols"] = [{ wch: 12 }, { wch: 34 }, { wch: 20 }, { wch: 10 }, { wch: 14 }, { wch: 16 }, { wch: 10 }, { wch: 16 }, { wch: 32 }];
  wsAction["!views"] = [{ state: "frozen", ySplit: 1 }];
  applyNumberFormats(wsAction, 1, actionAoa.length, { 3: CURRENCY_FMT, 4: CURRENCY_FMT, 5: CURRENCY_FMT, 7: PERCENT_FMT });
  XLSX.utils.book_append_sheet(wb, wsAction, "Action Sheet");

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
  applyNumberFormats(wsLow, 1, lowAoa.length, { 2: CURRENCY_FMT });
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
  // Meesho orders also gets a Product/Quantity/Price/Sales leaderboard next to
  // the raw dump — same shape and formula (Sales = Price x range Quantity) as
  // the cross-platform "B Arm orders" sheet below, scoped to just Meesho here,
  // matching the seller's own hand-built workbook's Meesho orders tab.
  const meeshoLeaderboardRows = groupProductsByName([...ms.products.values()], undefined, skuToMasterSkuidName)
    .filter((p) => p.range.units > 0)
    .sort((a, b) => b.range.units * b.price - a.range.units * a.price)
    .map((p): (string | number)[] => [p.name, p.range.units, p.price, round2(p.price * p.range.units)]);
  rawRowsToSheet(wb, "Meesho (B Arm) orders", ms.orderRows, {
    header: ["Product", "Quantity", "Price", "Sales"],
    rows: meeshoLeaderboardRows,
    currencyCols: [2, 3],
  });

  // ── B Arm orders — cross-platform Product/Quantity/Price/Sales leaderboard,
  // matching the hand-built workbook's own (empty, in every sample seen)
  // "B Arm orders" tab, but actually populated here from the range window's
  // order data already computed above rather than left blank.
  const bArmAoa: (string | number)[][] = [["Product", "Quantity", "Price", "Sales"]];
  const bArmZeroRows: (string | number)[][] = [];
  platforms.forEach(({ products }) => {
    const grouped = groupProductsByName([...products.values()], undefined, skuToMasterSkuidName);
    grouped
      .filter((p) => p.range.units > 0)
      .sort((a, b) => b.range.units * b.price - a.range.units * a.price)
      .forEach((p) => bArmAoa.push([p.name, p.range.units, p.price, round2(p.price * p.range.units)]));
    // Amazon catalog SKUs seeded above with zero orders this window — held back from the main
    // leaderboard and appended after every platform's real activity below, so a reader sees "who's
    // actually selling" first and "not selling at all" as a distinct trailing block, not mixed in.
    grouped
      .filter((p) => p.range.units === 0)
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((p) => bArmZeroRows.push([p.name, p.range.units, p.price, round2(p.price * p.range.units)]));
  });
  bArmAoa.push(...bArmZeroRows);
  const wsBArm = XLSX.utils.aoa_to_sheet(bArmAoa);
  styleHeader(wsBArm, 0, 4, "6B7280");
  wsBArm["!cols"] = [{ wch: 60 }, { wch: 10 }, { wch: 10 }, { wch: 14 }];
  wsBArm["!views"] = [{ state: "frozen", ySplit: 1 }];
  applyNumberFormats(wsBArm, 1, bArmAoa.length, { 2: CURRENCY_FMT, 3: CURRENCY_FMT });
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
    ["Spend (with tax) = raw ad spend x (1 + that product's GST rate), applied once after summing — never a per-row multiply. Rate comes from the product master's Tax column per SKU (18% used when a SKU has none on file)."],
    ["CPC = Spend(with tax) / Orders. When Orders = 0, CPC = Spend(with tax) (undefined ratio, shown as the spend itself rather than blank)."],
    ["ACOS = Spend (without tax) / that SKU's own ad-attributed sales, when on file for this window: for Amazon, whenever a SKU has a Sponsored Products row on file, that's Amazon's own raw Sponsored Products Spend / \"7 Day Total Sales\" directly from the ad export (no GST added) — matching Amazon's own report number-for-number rather than this sheet's real-order-based Orders/CPC; for Flipkart, its ads-export \"Total Revenue\"; for Meesho, its ad-attributed order count x price. Falls back to Spend (without tax) / Total Sales — real per-order revenue, never CPC/Price, which is tax-inclusive — only when none of the above is on file at all (an Amazon SKU with no Sponsored Products row, i.e. SB/SD-only spend; or a Flipkart/Meesho product with no ad-attributed sales data of its own)."],
    ["\"Orders\" = units sold of that product in the window, from the Orders/Order report, cancelled orders excluded. This is NOT ad-click-attributed units."],
    ["\"Day\" = the single reporting day above. \"Range\" = that day and the", rangeDays - 1, "days before it, inclusive."],
    [""],
    ["Amazon: Sponsored Products spend is per-SKU (barm_amazon_sp_advertised_product). Sponsored Brands/Display spend has no SKU column and is split across the SKUs mapped to that campaign on the Upload page, in proportion to their weight. Unmapped SB/SD spend for the range window: ₹" + round2(amz.unmappedSpend) + " — not attributed to any product below."],
    ["Flipkart: FSN report spend is per-SKU for every campaign type, so no apportioning is needed. Price prefers the Listings snapshot; where a SKU has no listing row, price falls back to the window's realised average selling price (Earn more report)."],
    ["Meesho: Ads report spend is per-SKU. Price prefers meesho_price_marketing's live scraped Meesho listing price; a SKU not in that table yet (or out of stock there) falls back to the Orders report's Supplier Discounted Price (else Supplier Listed Price). Overall sales QTS/Value uses that same price (Orders x price, per SKU), matching the seller's own manual workbook. Column names come from the seller's own workbook, not a native Meesho export seen directly — see src/lib/meeshoReportUpload.ts if a real export's headers turn out to differ."],
    ["Google Ads and social-media (Meta) spend are not included — no sample export has been seen for either, so there's no confirmed column layout to parse."],
    [""],
    ["Ad Status Report matches products across Amazon, Flipkart and Meesho by product NAME only (no cross-platform SKU mapping exists) — two listings with different titles for the same physical product will show as separate rows."],
    ["Action Sheet lists every SKU whose trailing 7-day ACOS is above 14%, worst first (identified by Campaign Name + SKU ID, not product name; Spend/Spend with tax/Orders/ACOS are all the 7-day range here, unlike every other sheet's single-day figures). Every row carries a concrete bid-cut %: rows matched to a real campaign in the uploaded Amazon/Flipkart ad data get one sized to that campaign's own ad-group/SKU performance (AI-assisted); unmatched rows (e.g. Meesho, which has no campaign data in this app, or a SKU that matched no campaign) get one computed from the SKU's own 7-day ACOS instead (20%/35%/50% cut for 14-60%/60-90%/90%+ ACOS). No specific search-term/keyword name is ever invented — that data isn't captured anywhere in this app; only a live SellerMate pull (Amazon only, on request) has real keyword-level detail."],
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
    socialMediaSummary,
    googleSummary,
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
