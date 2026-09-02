import * as XLSX from "xlsx-js-style";
import { mcp } from "@/lib/api";
import { categorizeTitle, resolveProductName, CATEGORY_COLORS } from "@/lib/categoryMap";
import { fetchProductMasterMap, buildProductMasterResolver } from "@/lib/productMasterUpload";
import { fetchMasterSkuidMap, buildMasterSkuidResolver } from "@/lib/masterProductSkuid";
import { fetchProductMarketingMap, buildProductMarketingResolver } from "@/lib/productMarketingUpload";

// SellerMate's get_retail_product_performance rejects start_date === end_date outright, so a
// single calendar day can't be queried directly. "daily" instead uses a cumulative-prefix trick:
// fetch Query(anchor, day_k) for every day (anchor = 2 days before the range, always valid since
// it's never equal to day_k), then day_k's real total = CUM(day_k) - CUM(day_{k-1}) per ASIN —
// the shared "anchor..day_{k-1}" portion cancels out. Verified against real account data: this
// reconciles exactly with directly-queried multi-day windows. The most recent 1-2 days can still
// look artificially low — that's Amazon's own reporting sync lag, not a bug in this math.
export type SalesReportGranularity = "daily" | "weekly" | "monthly";

// Everything below is transport-agnostic: it just needs something that can call a SellerMate
// tool and return its JSON. The browser calls through the /api/tool proxy (see
// exportAmazonSalesReport); server code (scheduled emails) calls SellerMate directly with an API
// key (see buildAmazonSalesWorkbookForAccount) — same report-building logic either way.
type ToolCaller = (tool: string, args: any) => Promise<any>;

interface PeriodBucket {
  label: string;
  start: string;
  end: string;
  // False when this bucket was clipped short by the selected end date (e.g. the trailing
  // week/month of the range only has 2 days of data) — such a bucket reads as a huge fake
  // "decline" against a full-length neighbour, so the growth summary skips comparing it.
  isFull: boolean;
}

interface PeriodStats {
  orders: number;
  allReturns: number; // every return Amazon reports, including courier RTO/undeliverable — what Total Orders is based on
  returns: number; // genuine customer returns only (courier RTO excluded)
  totalOrders: number;
  price: number;
  totalSales: number;
}

interface ProductRow {
  asin: string;
  name: string;
  sku: string;
  periods: Record<string, PeriodStats>;
  grandTotalSales: number;
}

function fmtDot(d: Date) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

function toIso(d: Date) {
  return d.toISOString().slice(0, 10);
}

// Split [startDate, endDate] (YYYY-MM-DD) into consecutive buckets per the requested granularity.
function buildPeriods(startDate: string, endDate: string, granularity: SalesReportGranularity): PeriodBucket[] {
  const periods: PeriodBucket[] = [];
  const start = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");

  if (granularity === "daily") {
    // Amazon's own reporting sync typically finalizes a day's figures 24-48h later, so the most
    // recent 2 calendar days are marked "not full" — they still show in the data table, but the
    // growth summary skips them rather than reading a sync-lag dip as a fake sales decline.
    const today = new Date();
    const reliableCutoff = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - 2 * 86400000;
    let cursor = start;
    while (cursor <= end) {
      periods.push({ label: fmtDot(cursor), start: toIso(cursor), end: toIso(cursor), isFull: cursor.getTime() <= reliableCutoff });
      cursor = new Date(cursor.getTime() + 86400000);
    }
  } else if (granularity === "weekly") {
    let cursor = start;
    while (cursor <= end) {
      // Align each bucket's natural end to the Sunday of ITS calendar week (ISO
      // Monday-Sunday), not a flat +6-day offset from wherever the cursor happens
      // to land. A mid-week cursor (only possible for the very first bucket, if
      // the selected start date isn't a Monday) still ends on that week's Sunday,
      // which snaps every following bucket onto a real Monday-Sunday week.
      const dow = cursor.getUTCDay(); // 0=Sun..6=Sat
      const daysToSunday = (7 - dow) % 7;
      const naturalWeekEnd = new Date(cursor.getTime() + daysToSunday * 86400000);
      const weekEnd = new Date(Math.min(naturalWeekEnd.getTime(), end.getTime()));
      periods.push({
        label: `${fmtDot(cursor)}-${fmtDot(weekEnd)}`,
        start: toIso(cursor),
        end: toIso(weekEnd),
        isFull: weekEnd.getTime() === naturalWeekEnd.getTime(),
      });
      cursor = new Date(weekEnd.getTime() + 86400000);
    }
    // Drop a trailing week that hasn't actually finished yet — clipped short by
    // the selected end date (e.g. the current in-progress week, today being
    // mid-week). Showing a 1-2 day "week" next to full 7-day weeks reads as a
    // fake crash in sales, so it's dropped entirely rather than just flagged.
    // Keep at least one bucket so a range narrower than a week doesn't vanish.
    if (periods.length > 1 && !periods[periods.length - 1].isFull) {
      periods.pop();
    }
  } else {
    // monthly — split on calendar month boundaries, clipped to the requested range
    let cursor = start;
    while (cursor <= end) {
      const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
      const bucketEnd = new Date(Math.min(monthEnd.getTime(), end.getTime()));
      periods.push({
        label: `${fmtDot(cursor)}-${fmtDot(bucketEnd)}`,
        start: toIso(cursor),
        end: toIso(bucketEnd),
        // Also require the bucket to start on the 1st — otherwise the very first bucket of a
        // mid-month-start range (e.g. 17 Jun–30 Jun) would end exactly on a month boundary and
        // wrongly look "full" despite covering under half the month.
        isFull: cursor.getUTCDate() === 1 && bucketEnd.getTime() === monthEnd.getTime(),
      });
      cursor = new Date(bucketEnd.getTime() + 86400000);
    }
  }
  return periods;
}

async function fetchAllRetail(call: ToolCaller, args: any) {
  const all: any[] = [];
  for (let page = 0; page < 20; page++) {
    const res = await call("get_retail_product_performance", { ...args, page, page_size: 500 });
    const rows = res.data || [];
    all.push(...rows);
    if (!res.pagination?.hasMore || rows.length === 0) break;
  }
  return all;
}

// get_fba_customer_returns (proxied through SellerMate) surfaces no dedicated per-line return
// ID — only orderId/asin/sku/returnDate/quantity/reason/detailedDisposition/customerComments
// (see productsWorkbookExport.ts's Returns sheet columns for the full field set this API gives
// us). So a return record's identity is the combination of every one of those fields together,
// never a single field alone — two genuinely distinct returns can share the same SKU, the same
// date, or the same quantity, so deduping on any one of those would silently drop real returns.
// Two records only collide here when they match on all of them, which is what an exact-duplicate
// row (e.g. the same page re-served twice) looks like.
function returnRecordKey(r: any): string {
  return [
    r.orderId ?? "",
    r.asin ?? "",
    r.sku ?? "",
    r.returnDate ?? "",
    r.quantity ?? "",
    r.reason ?? "",
    r.detailedDisposition ?? "",
    r.customerComments ?? "",
  ].join("|");
}

async function fetchAllReturns(call: ToolCaller, args: any) {
  // get_fba_customer_returns rejects start_date === end_date outright — a monthly/weekly bucket
  // can collapse to a single day (e.g. a narrow selected range, or a trailing partial period), so
  // widen the query by a day either side and filter the result back down to the real window.
  let { start_date, end_date } = args;
  let exactDay: string | null = null;
  if (start_date === end_date) {
    exactDay = start_date;
    const d = new Date(start_date + "T00:00:00Z");
    start_date = toIso(new Date(d.getTime() - 86400000));
    end_date = toIso(new Date(d.getTime() + 86400000));
  }

  // Dedup incrementally as each page arrives (against everything seen on every earlier page in
  // this fetch, not just the previous one) rather than after the fact — so a page that repeats or
  // overlaps an earlier one, from a pagination bug or an upstream retry re-serving the same page,
  // is caught and attributed to the page it came from instead of silently inflating the total.
  const seen = new Set<string>();
  const all: any[] = [];
  let rawCount = 0;
  for (let page = 0; page < 20; page++) {
    const res = await call("get_fba_customer_returns", { ...args, start_date, end_date, page, page_size: 500 });
    const rows = res.order_returns || [];
    rawCount += rows.length;
    let pageDuplicates = 0;
    for (const r of rows) {
      const key = returnRecordKey(r);
      if (seen.has(key)) { pageDuplicates++; continue; }
      seen.add(key);
      all.push(r);
    }
    if (pageDuplicates > 0) {
      console.warn(
        `[amazonSalesExport] fetchAllReturns: page ${page} carried ${pageDuplicates} return record(s) already seen on an earlier page in this fetch (${start_date}..${end_date}) — dropped.`
      );
    }
    if (!res.pagination?.hasMore || rows.length === 0) break;
  }
  const duplicateCount = rawCount - all.length;
  console.info(
    `[amazonSalesExport] fetchAllReturns(${start_date}..${end_date}): ${rawCount} raw return record(s) fetched, ${all.length} unique, ${duplicateCount} duplicate(s) removed.`
  );

  // Every return Amazon reports (genuine customer returns + courier RTO/undeliverable) —
  // callers split these into "All Returns" vs "Customer Returns" via isGenuineReturn below.
  return exactDay ? all.filter((r: any) => String(r.returnDate || "").slice(0, 10) === exactDay) : all;
}

// A courier RTO / refused-delivery "return" (reason starts with UNDELIVERABLE) means the package
// never actually reached the customer — it isn't a genuine product return. Same filter as the
// Products page export (see products/page.tsx's genuineReturns).
function isGenuineReturn(r: any) {
  return !String(r.reason || "").toUpperCase().startsWith("UNDELIVERABLE");
}

async function fetchFullCatalog(call: ToolCaller, args: any) {
  const all: any[] = [];
  let offset = 0;
  for (let i = 0; i < 30; i++) {
    const res = await call("list_product_catalog", { ...args, limit: 200, offset, include_suppressed: true });
    const page = res.products || [];
    all.push(...page);
    offset += page.length;
    if (page.length < 200 || offset >= (res.total || 0)) break;
  }
  return all;
}

async function fetchAllInventory(call: ToolCaller, args: any) {
  const seen = new Set<string>();
  const all: any[] = [];
  let offset = 0;
  for (let i = 0; i < 10; i++) {
    const res = await call("get_inventory", { ...args, limit: 200, offset });
    const items = res.items || [];
    for (const item of items) {
      if (item.asin && seen.has(item.asin)) continue;
      if (item.asin) seen.add(item.asin);
      all.push(item);
    }
    if (items.length === 0 || offset + items.length >= (res.total || 0)) break;
    offset += 200;
  }
  return all;
}

async function fetchPeriod(call: ToolCaller, baseArgs: any, period: PeriodBucket) {
  const periodArgs = { ...baseArgs, start_date: period.start, end_date: period.end };
  const [retailRows, returnRows] = await Promise.all([
    fetchAllRetail(call, periodArgs),
    fetchAllReturns(call, periodArgs),
  ]);
  return { period, retailRows, returnRows };
}

// Per-ASIN daily retail stats via a cumulative-prefix trick (see the SalesReportGranularity
// comment for why): fetch Query(anchor, day_k) for every day, then diff consecutive cumulative
// totals. One extra call (the anchor..day_{-1} baseline) plus one call per day — far cheaper
// than a naive 3-calls-per-day subtraction, and mathematically exact either way.
async function fetchDailyRetailByAsin(call: ToolCaller, baseArgs: any, days: PeriodBucket[]) {
  const n = days.length;
  const anchor = new Date(days[0].start + "T00:00:00Z");
  anchor.setUTCDate(anchor.getUTCDate() - 2);
  const anchorIso = toIso(anchor);
  const baseline = new Date(anchor.getTime() + 86400000); // anchor + 1 day

  // cumEnds[0] = baseline (the "day -1" reference point); cumEnds[k+1] = days[k]'s date
  const cumEnds = [baseline, ...days.map((d) => new Date(d.start + "T00:00:00Z"))];

  const BATCH = 6;
  const cumRows: any[][] = new Array(cumEnds.length);
  for (let i = 0; i < cumEnds.length; i += BATCH) {
    const idxBatch = Array.from({ length: Math.min(BATCH, cumEnds.length - i) }, (_, j) => i + j);
    const results = await Promise.all(
      idxBatch.map((idx) =>
        fetchAllRetail(call, { ...baseArgs, start_date: anchorIso, end_date: toIso(cumEnds[idx]) }).catch(() => [])
      )
    );
    idxBatch.forEach((idx, j) => { cumRows[idx] = results[j]; });
  }

  const cumMaps = cumRows.map((rows) => {
    const m = new Map<string, { totalSales: number; unitsOrdered: number }>();
    rows.forEach((r: any) => {
      if (!r.asin) return;
      m.set(r.asin, { totalSales: r.totalSales || 0, unitsOrdered: r.unitsOrdered || 0 });
    });
    return m;
  });

  const allAsins = new Set<string>();
  cumMaps.forEach((m) => m.forEach((_v, asin) => allAsins.add(asin)));

  // asin -> (day label -> stats)
  const dailyByAsin = new Map<string, Map<string, { orders: number; totalSales: number; price: number }>>();
  allAsins.forEach((asin) => {
    const perDay = new Map<string, { orders: number; totalSales: number; price: number }>();
    for (let k = 0; k < n; k++) {
      const prev = cumMaps[k].get(asin) || { totalSales: 0, unitsOrdered: 0 };
      const curr = cumMaps[k + 1].get(asin) || { totalSales: 0, unitsOrdered: 0 };
      const totalSales = Math.max(0, curr.totalSales - prev.totalSales);
      const orders = Math.max(0, curr.unitsOrdered - prev.unitsOrdered);
      perDay.set(days[k].label, { orders, totalSales, price: orders ? totalSales / orders : 0 });
    }
    dailyByAsin.set(asin, perDay);
  });

  return dailyByAsin;
}

// Returns are additive by nature (each return has its own date), so — unlike retail sales —
// they don't need the cumulative-prefix trick: one call over the whole range, bucketed by day.
// get_fba_customer_returns rejects start_date === end_date too (a single-day daily report calls
// this with startDate === endDate), so widen a single-day query by 1 day either side — harmless
// since results are bucketed by their actual returnDate afterward anyway, not by the query window.
async function fetchReturnsByDay(call: ToolCaller, baseArgs: any, startDate: string, endDate: string) {
  let queryStart = startDate, queryEnd = endDate;
  if (queryStart === queryEnd) {
    const d = new Date(queryStart + "T00:00:00Z");
    queryStart = toIso(new Date(d.getTime() - 86400000));
    queryEnd = toIso(new Date(d.getTime() + 86400000));
  }
  const rows = await fetchAllReturns(call, { ...baseArgs, start_date: queryStart, end_date: queryEnd });
  const allByDayAsin = new Map<string, Map<string, number>>(); // dayIso -> (asin -> count), every return
  const genuineByDayAsin = new Map<string, Map<string, number>>(); // dayIso -> (asin -> count), courier RTO excluded
  rows.forEach((r: any) => {
    if (!r.asin || !r.returnDate) return;
    const dayIso = String(r.returnDate).slice(0, 10);
    const qty = r.quantity || 1;
    if (!allByDayAsin.has(dayIso)) allByDayAsin.set(dayIso, new Map());
    const allMap = allByDayAsin.get(dayIso)!;
    allMap.set(r.asin, (allMap.get(r.asin) || 0) + qty);
    if (isGenuineReturn(r)) {
      if (!genuineByDayAsin.has(dayIso)) genuineByDayAsin.set(dayIso, new Map());
      const genuineMap = genuineByDayAsin.get(dayIso)!;
      genuineMap.set(r.asin, (genuineMap.get(r.asin) || 0) + qty);
    }
  });
  return { allByDayAsin, genuineByDayAsin };
}

// Amazon-only sales report (Orders / Returns / Total Orders / Price / Total Sales / Growth% per
// product per period) — mirrors the layout of the legacy "REVENUE" workbook's Amazon Sales sheet,
// sourced live from the SellerMate API, with the Flipkart column blocks dropped entirely.
// Ends with an auto-computed Top Losers / Top Gainers summary comparing the last two periods —
// the legacy sheet's manually-typed reasons (negative reviews, competitor pressure) aren't
// derivable from the API, so only signals we can actually verify (low stock, a returns spike, a
// price drop) are surfaced; everything else is left for the reader to annotate.
//
// Pure builder — takes a ToolCaller so it works from the browser or a server cron alike. Returns
// the workbook + filename without writing anything; callers decide whether to trigger a browser
// download (XLSX.writeFile) or turn it into a Buffer for an email attachment (XLSX.write).
async function buildAmazonSalesWorkbook(opts: {
  call: ToolCaller;
  accountId: string | undefined;
  workspaceId: string | undefined;
  startDate: string;
  endDate: string;
  granularity: SalesReportGranularity;
}) {
  const { call, accountId, workspaceId, endDate, granularity } = opts;
  let { startDate } = opts;
  const baseArgs = { amazon_account_id: accountId, workspace_id: workspaceId };

  // Daily reports need at least 2 CONSECUTIVE full (already-synced) days to produce a Growth
  // Summary — a narrow selection (e.g. a single day, or just yesterday+today) can otherwise land
  // entirely inside Amazon's ~48h reporting sync-lag window and come back as "unavailable" with
  // all-zero rows. Widen the fetch window under the hood (like the weekly email always auto-pairs
  // "this vs last") so there's a real comparison, without requiring the user to pick a wider range.
  if (granularity === "daily") {
    const minStart = new Date(endDate + "T00:00:00Z");
    minStart.setUTCDate(minStart.getUTCDate() - 2);
    const minStartIso = toIso(minStart);
    if (minStartIso < startDate) startDate = minStartIso;
  }

  const periods = buildPeriods(startDate, endDate, granularity);

  const [catalog, inventory, productMarketing, productMaster, masterSkuid] = await Promise.all([
    fetchFullCatalog(call, baseArgs),
    fetchAllInventory(call, baseArgs).catch(() => []),
    fetchProductMarketingMap(),
    fetchProductMasterMap(),
    fetchMasterSkuidMap(),
  ]);
  const { resolveName: resolveMarketingName, resolveCategory: resolveMarketingCategory } = buildProductMarketingResolver(productMarketing);
  const { resolveName: resolveBarmName, resolveCategory: resolveBarmCategory } = buildProductMasterResolver(productMaster);
  const { resolveName: resolveSkuidName, resolveCategory: resolveSkuidCategory } = buildMasterSkuidResolver(masterSkuid);
  // master_product_marketing is the marketing team's freshest, most current master — checked
  // first; master_product_skuid and barm_product_master only fill in a SKU it doesn't have.
  const resolveMasterName = (sku: string, fallback: string) =>
    resolveMarketingName(sku, resolveSkuidName(sku, resolveBarmName(sku, fallback)));
  const resolveMasterCategory = (sku: string, fallback: string) =>
    resolveMarketingCategory(sku, resolveSkuidCategory(sku, resolveBarmCategory(sku, fallback)));

  // list_product_catalog is the reliable source for SKU — get_inventory's sku field comes back
  // blank for some accounts (seen on B-ARM), so catalog is read first and inventory is only a
  // fallback for whichever ASINs catalog didn't cover.
  const nameByAsin = new Map<string, string>();
  const skuByAsin = new Map<string, string>();
  catalog.forEach((c: any) => {
    if (c.asin && !nameByAsin.has(c.asin)) nameByAsin.set(c.asin, c.itemName || c.asin);
    if (c.asin && c.sku && !skuByAsin.has(c.asin)) skuByAsin.set(c.asin, c.sku);
  });

  const stockByAsin = new Map<string, number>();
  inventory.forEach((i: any) => {
    if (!i.asin) return;
    const stock = (i.fba?.endingWarehouseBalance || 0) + (i.fbm?.quantity || 0);
    stockByAsin.set(i.asin, (stockByAsin.get(i.asin) || 0) + stock);
    if (i.sku && !skuByAsin.has(i.asin)) skuByAsin.set(i.asin, i.sku);
  });

  const productsByAsin = new Map<string, ProductRow>();
  const ensureProduct = (asin: string) => {
    let p = productsByAsin.get(asin);
    if (!p) {
      p = { asin, name: nameByAsin.get(asin) || asin, sku: skuByAsin.get(asin) || "", periods: {}, grandTotalSales: 0 };
      productsByAsin.set(asin, p);
    }
    return p;
  };

  // Seed every catalog product so zero-sale periods still show a row (per catalog visibility).
  catalog.forEach((c: any) => {
    if (c.asin) ensureProduct(c.asin);
  });

  if (granularity === "daily") {
    // Daily can't query single days directly — use the cumulative-prefix trick for retail sales,
    // and a single whole-range call for returns (bucketed by day client-side).
    const [dailyByAsin, { allByDayAsin, genuineByDayAsin }] = await Promise.all([
      fetchDailyRetailByAsin(call, baseArgs, periods),
      fetchReturnsByDay(call, baseArgs, startDate, endDate),
    ]);

    dailyByAsin.forEach((perDay, asin) => {
      const p = ensureProduct(asin);
      periods.forEach((pd) => {
        const stat = perDay.get(pd.label);
        if (!stat) return;
        const allReturns = allByDayAsin.get(pd.start)?.get(asin) || 0;
        const returns = genuineByDayAsin.get(pd.start)?.get(asin) || 0;
        p.periods[pd.label] = {
          orders: stat.orders,
          allReturns,
          returns,
          totalOrders: Math.max(0, stat.orders - allReturns),
          price: stat.price,
          totalSales: stat.totalSales,
        };
        p.grandTotalSales += stat.totalSales;
      });
    });
  } else {
    // Fetch periods in small concurrent batches — a long date range can mean dozens of buckets,
    // and sequential fetching would take minutes.
    const BATCH = 5;
    for (let i = 0; i < periods.length; i += BATCH) {
      const batch = periods.slice(i, i + BATCH);
      const results = await Promise.all(batch.map((p) => fetchPeriod(call, baseArgs, p)));
      results.forEach(({ period, retailRows, returnRows }) => {
        const allReturnsByAsin = new Map<string, number>();
        const genuineReturnsByAsin = new Map<string, number>();
        returnRows.forEach((r: any) => {
          if (!r.asin) return;
          const qty = r.quantity || 1;
          allReturnsByAsin.set(r.asin, (allReturnsByAsin.get(r.asin) || 0) + qty);
          if (isGenuineReturn(r)) genuineReturnsByAsin.set(r.asin, (genuineReturnsByAsin.get(r.asin) || 0) + qty);
        });

        retailRows.forEach((r: any) => {
          if (!r.asin) return;
          const p = ensureProduct(r.asin);
          if (!nameByAsin.has(r.asin) && r.productName) p.name = r.productName;
          const orders = r.unitsOrdered || 0;
          const allReturns = allReturnsByAsin.get(r.asin) || 0;
          const returns = genuineReturnsByAsin.get(r.asin) || 0;
          const totalSales = r.totalSales || 0;
          const price = r.averageSellingPrice || (orders ? totalSales / orders : 0);
          p.periods[period.label] = {
            orders,
            allReturns,
            returns,
            totalOrders: Math.max(0, orders - allReturns),
            price,
            totalSales,
          };
          p.grandTotalSales += totalSales;
        });
      });
    }
  }

  // Prefer the seller's own approved Product Master name (matched by SKU) over both the raw
  // catalog/listing title and the older hand-maintained SKU_NAME_MAP in categoryMap.ts — Product
  // Master is the one the seller's team actually curates and approves, so it wins when present;
  // categoryMap.ts's SKU_NAME_MAP only fills in SKUs the master hasn't been updated with yet.
  productsByAsin.forEach((p) => {
    p.name = resolveMasterName(p.sku, resolveProductName(p.name, p.sku) || p.name);
  });

  const rows = [...productsByAsin.values()].sort((a, b) => b.grandTotalSales - a.grandTotalSales);

  // Discontinued (retired SKUs) and Other (unclassified — usually a stale ASIN with no catalog
  // title to categorize) are noise for reporting purposes: excluded from every sheet in this
  // workbook (Amazon Sales, Category Breakdown, Growth Summary) rather than just hidden/zeroed.
  const EXCLUDED_CATEGORIES = new Set(["Discontinued", "Other"]);

  // ── Category/Department aggregation — same per-product per-period data, grouped by
  // department (Gynaecology / Pulmonology / Occupational Therapy / General / Other). Product
  // Master's own Category column wins when the SKU is in it (same seller-curated priority as the
  // name resolution above); categoryMap.ts's SKU_CATEGORY_MAP / title fuzzy-match only fills in
  // SKUs the master doesn't have a category for yet — so departments can be tracked
  // period-over-period without opening the full per-product sheet. ──
  const categoryAgg = new Map<string, { periods: Record<string, { sales: number; units: number }>; grandSales: number; grandUnits: number }>();
  const catByAsin = new Map<string, string>();
  rows.forEach((p) => {
    const cat = resolveMasterCategory(p.sku, categorizeTitle(p.name, p.asin, p.sku));
    catByAsin.set(p.asin, cat);
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

  const visibleRows = rows.filter((p) => !EXCLUDED_CATEGORIES.has(catByAsin.get(p.asin) || "Other"));

  // Row order for the main sheet: grouped by department (highest-selling department first,
  // matching the Category Breakdown sheet), then by each product's own sales within that group —
  // so the per-SKU data reads "category-wise" while staying at full product granularity.
  const categoryRank = new Map<string, number>();
  [...categoryAgg.entries()]
    .sort((a, b) => b[1].grandSales - a[1].grandSales)
    .forEach(([name], i) => categoryRank.set(name, i));
  const rowsByCategory = [...visibleRows].sort((a, b) => {
    const ra = categoryRank.get(catByAsin.get(a.asin) || "") ?? 999;
    const rb = categoryRank.get(catByAsin.get(b.asin) || "") ?? 999;
    if (ra !== rb) return ra - rb;
    return b.grandTotalSales - a.grandTotalSales;
  });

  // ── Build the main data sheet ──
  // Column 0 = Product, column 1 = SKU, column 2 = Category (department), then 7 columns per
  // period (Orders, All Returns, Customer Returns, Total Orders, Price, Total Sales, Growth %).
  // All Returns is every return Amazon reports; Customer Returns excludes courier RTO/undeliverable
  // "returns" (see isGenuineReturn) — Total Orders subtracts All Returns, since an RTO'd order
  // never became a real sale either even though the customer didn't reject it. Rows are grouped by department
  // (rowsByCategory) so the sheet reads "category-wise" while staying at full product/SKU granularity.
  const COLS_PER_PERIOD = 7;
  const LEAD_COLS = 3; // Product, SKU, Category
  const headerRow1: any[] = ["Product", "SKU", "Category"];
  const headerRow2: any[] = ["", "", ""];
  periods.forEach(() => {
    headerRow1.push(...Array(COLS_PER_PERIOD).fill(""));
    headerRow2.push("Orders", "All Returns", "Customer Returns", "Total Orders", "Price", "Total Sales", "Growth %");
  });
  periods.forEach((pd, i) => {
    headerRow1[LEAD_COLS + i * COLS_PER_PERIOD] = pd.label;
  });

  const aoa: any[][] = [headerRow1, headerRow2];
  const categoryChangeRows = new Set<number>(); // aoa row indices where a new department group starts

  let prevCat: string | null = null;
  rowsByCategory.forEach((p) => {
    const cat = catByAsin.get(p.asin) || "Other";
    if (cat !== prevCat) { categoryChangeRows.add(aoa.length); prevCat = cat; }
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

  const dataRowCount = aoa.length - 2;
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const totalCols = LEAD_COLS + periods.length * COLS_PER_PERIOD;

  const merges: any[] = [
    { s: { r: 0, c: 0 }, e: { r: 1, c: 0 } },
    { s: { r: 0, c: 1 }, e: { r: 1, c: 1 } },
    { s: { r: 0, c: 2 }, e: { r: 1, c: 2 } },
  ];
  periods.forEach((_, i) => {
    const c0 = LEAD_COLS + i * COLS_PER_PERIOD;
    merges.push({ s: { r: 0, c: c0 }, e: { r: 0, c: c0 + COLS_PER_PERIOD - 1 } });
  });

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
    // A thicker top border marks where one department's group of rows ends and the next begins.
    const isGroupStart = categoryChangeRows.has(r) && r > 2;
    for (let c = 0; c < totalCols; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (!cell) continue;

      let style: any = {
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

  // ── Growth summary: Top Losers / Top Gainers comparing the last two FULL periods ──
  // A trailing period clipped short by the selected end date (e.g. a 2-day "week" at the
  // end of the range) would otherwise look like a fake ~80% decline against a full-length
  // neighbour, so we walk back to the last pair of periods that are both full-length.
  let cmpEnd = periods.length - 1;
  while (cmpEnd > 0 && !(periods[cmpEnd].isFull && periods[cmpEnd - 1].isFull)) cmpEnd--;

  if (cmpEnd > 0) {
    const lastLabel = periods[cmpEnd].label;
    const prevLabel = periods[cmpEnd - 1].label;

    type Delta = { name: string; sku: string; units: number; price: number; delta: number; pct: number; reason: string; category: string };
    const deltas: Delta[] = visibleRows
      .map((p) => {
        const last = p.periods[lastLabel];
        const prev = p.periods[prevLabel];
        if (!last && !prev) return null;
        const lastSales = last?.totalSales || 0;
        const prevSales = prev?.totalSales || 0;
        if (lastSales === 0 && prevSales === 0) return null;
        const delta = lastSales - prevSales;
        const pct = prevSales !== 0 ? delta / prevSales : lastSales > 0 ? 1 : 0;
        const stock = stockByAsin.get(p.asin);
        const returnsJump = (last?.returns || 0) - (prev?.returns || 0);
        const priceDropPct = prev?.price ? (last?.price || 0) / prev.price - 1 : 0;
        let reason = "";
        if (delta < 0) {
          if (stock !== undefined && stock < 15) reason = `Low stock (${stock} units on hand) — check replenishment`;
          else if (returnsJump >= 3) reason = `Returns jumped by ${returnsJump} vs previous period`;
        } else if (delta > 0) {
          if (priceDropPct <= -0.05) reason = `Price dropped ${Math.abs(priceDropPct * 100).toFixed(0)}% — likely drove growth`;
        }
        // Units Sold / Price reflect the latest period (lastLabel) — the current snapshot the
        // Δ columns are measured against.
        const units = last?.orders || 0;
        const price = last?.price || 0;
        return { name: p.name, sku: p.sku, units, price, delta, pct, reason, category: catByAsin.get(p.asin) || "Other" };
      })
      .filter((d): d is Delta => d !== null);

    const TOP_N = 5;

    // Category order matches Category Breakdown (highest-selling department first); only
    // categories that actually have a comparable product get a section.
    const categoriesInOrder = [...categoryAgg.entries()]
      .filter(([name]) => !EXCLUDED_CATEGORIES.has(name))
      .sort((a, b) => b[1].grandSales - a[1].grandSales)
      .map(([name]) => name)
      .filter((name) => deltas.some((d) => d.category === name));

    const sAoA: any[][] = [[`Growth Summary — ${lastLabel} vs ${prevLabel}`, "", "", "", "", "", ""], []];
    const catHeaderRows: { row: number; color: string }[] = [];
    const lossHeaderRows: number[] = [];
    const gainHeaderRows: number[] = [];

    categoriesInOrder.forEach((cat) => {
      const catDeltas = deltas.filter((d) => d.category === cat);
      const losers = catDeltas.filter((d) => d.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, TOP_N);
      const gainers = catDeltas.filter((d) => d.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, TOP_N);
      if (losers.length === 0 && gainers.length === 0) return;

      catHeaderRows.push({ row: sAoA.length, color: CATEGORY_COLORS[cat] || CATEGORY_COLORS.Other });
      sAoA.push([cat, "", "", "", "", "", ""]);

      lossHeaderRows.push(sAoA.length);
      sAoA.push(["Top 5 Worst", "SKU", "Units Sold", "Price", "Δ Sales", "Δ %", "Possible Reason (add your own note if blank)"]);
      if (losers.length > 0) losers.forEach((d) => sAoA.push([d.name, d.sku, d.units, d.price, d.delta, d.pct, d.reason]));
      else sAoA.push(["No decline this period", "", "", "", "", "", ""]);
      sAoA.push([]);

      gainHeaderRows.push(sAoA.length);
      sAoA.push(["Top 5 Best", "SKU", "Units Sold", "Price", "Δ Sales", "Δ %", "Possible Reason (add your own note if blank)"]);
      if (gainers.length > 0) gainers.forEach((d) => sAoA.push([d.name, d.sku, d.units, d.price, d.delta, d.pct, d.reason]));
      else sAoA.push(["No growth this period", "", "", "", "", "", ""]);
      sAoA.push([]);
    });

    const wsSummary = XLSX.utils.aoa_to_sheet(sAoA);
    wsSummary["!merges"] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 6 } },
      ...catHeaderRows.map((h) => ({ s: { r: h.row, c: 0 }, e: { r: h.row, c: 6 } })),
    ];
    wsSummary["!cols"] = [{ wch: 45 }, { wch: 16 }, { wch: 11 }, { wch: 11 }, { wch: 14 }, { wch: 10 }, { wch: 50 }];

    const titleCell = wsSummary[XLSX.utils.encode_cell({ r: 0, c: 0 })];
    if (titleCell) titleCell.s = { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "111827" } }, alignment: { horizontal: "center" } };

    catHeaderRows.forEach(({ row, color }) => {
      for (let c = 0; c < 7; c++) {
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
      for (let c = 0; c < 7; c++) {
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

    for (let r = 0; r < sAoA.length; r++) {
      // Units Sold (2) / Price (3): plain formatting, no sign-based coloring.
      const unitsAddr = XLSX.utils.encode_cell({ r, c: 2 });
      if (wsSummary[unitsAddr] && typeof wsSummary[unitsAddr].v === "number") {
        wsSummary[unitsAddr].s = { numFmt: "#,##0", font: { color: { rgb: "1F2937" } } };
      }
      const priceAddr = XLSX.utils.encode_cell({ r, c: 3 });
      if (wsSummary[priceAddr] && typeof wsSummary[priceAddr].v === "number") {
        wsSummary[priceAddr].s = { numFmt: "#,##0.00", font: { color: { rgb: "1F2937" } } };
      }
      // Δ Sales (4) / Δ % (5): colored red/green by sign, as before.
      for (let c = 4; c <= 5; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = wsSummary[addr];
        if (!cell || typeof cell.v !== "number") continue;
        cell.s = { numFmt: c === 4 ? "#,##0.00" : "0.0%", font: { color: { rgb: cell.v < 0 ? "B91C1C" : "047857" }, bold: true } };
      }
    }

    XLSX.utils.book_append_sheet(wb, wsSummary, "Growth Summary");
  } else {
    const wsNote = XLSX.utils.aoa_to_sheet([
      ["Growth Summary unavailable"],
      [`The selected date range doesn't contain two full, equal-length ${granularity === "daily" ? "days" : granularity === "weekly" ? "weeks" : "months"} to compare — pick a wider range to see Top Losers/Gainers.`],
    ]);
    wsNote["!cols"] = [{ wch: 90 }];
    XLSX.utils.book_append_sheet(wb, wsNote, "Growth Summary");
  }

  // ── Category Breakdown sheet — one row per department, columns mirror the main sheet's
  // period layout (Sales / Units / Growth %) plus range totals and each department's share
  // of overall sales. ──
  {
    const catRows = [...categoryAgg.entries()]
      .filter(([name]) => !EXCLUDED_CATEGORIES.has(name))
      .sort((a, b) => b[1].grandSales - a[1].grandSales);
    const grandAllSales = catRows.reduce((a, [, v]) => a + v.grandSales, 0);
    const grandAllUnits = catRows.reduce((a, [, v]) => a + v.grandUnits, 0);

    const CAT_COLS_PER_PERIOD = 3; // Sales, Units, Growth %
    const catHeader1: any[] = ["Category"];
    const catHeader2: any[] = [""];
    periods.forEach(() => {
      catHeader1.push(...Array(CAT_COLS_PER_PERIOD).fill(""));
      catHeader2.push("Sales", "Units", "Growth %");
    });
    periods.forEach((pd, i) => { catHeader1[1 + i * CAT_COLS_PER_PERIOD] = pd.label; });
    catHeader1.push("", "", "");
    catHeader2.push("Total Sales", "Total Units", "Share %");

    const catAoa: any[][] = [catHeader1, catHeader2];
    catRows.forEach(([name, v]) => {
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

        let style: any = {
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

  if (granularity === "daily") {
    const wsInfo = XLSX.utils.aoa_to_sheet([
      ["Note"],
      ["The most recent 1–2 days in this report can show unusually low or zero sales — that's Amazon's own reporting sync lag, not a drop in real sales. Figures for a given day typically finalize within 24–48 hours."],
    ]);
    wsInfo["!cols"] = [{ wch: 100 }];
    XLSX.utils.book_append_sheet(wb, wsInfo, "Notes");
  }

  const gLabel = granularity === "daily" ? "Daily" : granularity === "weekly" ? "Weekly" : "Monthly";
  const filename = `Amazon_${gLabel}_Sales_Report_${startDate}_to_${endDate}.xlsx`;
  return { wb, filename, productCount: visibleRows.length, periodCount: periods.length, dataRowCount };
}

// Browser entry point (used by the Reports page) — fetches through the /api/tool proxy with the
// account's keySlot, then triggers a real file download.
export async function exportAmazonSalesReport(opts: {
  account: { id?: string; workspace_id?: string; name?: string } | null | undefined;
  keySlot: string;
  startDate: string;
  endDate: string;
  granularity: SalesReportGranularity;
}) {
  const { account, keySlot, startDate, endDate, granularity } = opts;
  const call: ToolCaller = (tool, args) => mcp(tool, args, keySlot);
  const { wb, filename, ...stats } = await buildAmazonSalesWorkbook({
    call, accountId: account?.id, workspaceId: account?.workspace_id, startDate, endDate, granularity,
  });
  XLSX.writeFile(wb, filename);
  return stats;
}

// Server entry point (used by the scheduled-email cron in instrumentation.ts) — calls SellerMate
// directly with an API key, and hands back the raw workbook so the caller can turn it into a
// Buffer (XLSX.write(wb, { type: "buffer", bookType: "xlsx" })) for a nodemailer attachment.
export async function buildAmazonSalesWorkbookForAccount(opts: {
  apiKey: string;
  accountId: string;
  workspaceId: string;
  startDate: string;
  endDate: string;
  granularity: SalesReportGranularity;
}) {
  const SELLERMATE_BASE_URL = "https://api.sellermate.ai/public/v1/tools";
  const call: ToolCaller = async (tool, args) => {
    const r = await fetch(`${SELLERMATE_BASE_URL}/${tool}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": opts.apiKey },
      body: JSON.stringify(args),
    });
    if (!r.ok) throw new Error(`${tool}: ${await r.text()}`);
    return r.json();
  };
  return buildAmazonSalesWorkbook({
    call, accountId: opts.accountId, workspaceId: opts.workspaceId,
    startDate: opts.startDate, endDate: opts.endDate, granularity: opts.granularity,
  });
}
