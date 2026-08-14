// The proxy's upstream fetch to SellerMate occasionally has its connection reset mid-flight
// under load (surfaces as "Internal Proxy Error: terminated") — a transient network blip, not a
// real failure. Reports that fan out dozens of concurrent calls (see amazonSalesExport.ts) hit
// this often enough that one retry attempt turns a failed export into a successful one.
const RETRYABLE_ERROR_PATTERN = /internal proxy error/i;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [500, 1500];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function mcp(tool: string, args: any = {}, slot: string = "A") {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await fetch("/api/tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, args, slot }),
    });

    let data;
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = { raw: text };
    }

    if (res.ok) return data;

    const message: string = (data && (data.error || data.message)) || "API error from " + tool;
    lastError = new Error(message);
    if (!RETRYABLE_ERROR_PATTERN.test(message) || attempt === MAX_ATTEMPTS - 1) {
      throw lastError;
    }
    await sleep(RETRY_DELAYS_MS[attempt] || RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]);
  }
  throw lastError;
}

// Fetch every page of a performance tool that uses page/page_size + pagination.hasMore.
export async function mcpAllPages(tool: string, args: any, slot: string, maxPages: number = 24) {
  const all: any[] = [];
  for (let page = 0; page < maxPages; page++) {
    const res = await mcp(tool, { ...args, page, page_size: 500 }, slot);
    const rows = res.data || [];
    all.push(...rows);
    if (!res.pagination?.hasMore || rows.length === 0) break;
  }
  return all;
}

// Fetch every inventory item (get_inventory paginates with limit/offset, max limit 200).
// Dedupe by ASIN — the backend's page ordering isn't guaranteed stable across calls,
// so consecutive pages can return the same ASIN twice.
export async function mcpAllInventory(args: any, slot: string) {
  const seen = new Set<string>();
  const all: any[] = [];
  let offset = 0;
  for (let i = 0; i < 10; i++) {
    const res = await mcp("get_inventory", { ...args, limit: 200, offset }, slot);
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

// Fetch every target (list_targets returns rows under "targets", not "data",
// and paginates with page/page_size like mcpAllPages but a different response shape).
// Page 0 tells us the total, then the remaining pages are fetched in parallel —
// large accounts have 40+ pages and sequential fetching takes minutes.
export async function mcpAllTargets(args: any, slot: string, maxPages: number = 24) {
  const PAGE_SIZE = 500;
  const first = await mcp("list_targets", { ...args, page: 0, page_size: PAGE_SIZE }, slot);
  const all: any[] = [...(first.targets || [])];
  const totalPages = Math.min(first.pagination?.totalPages || 1, maxPages);
  if (totalPages <= 1) return all;

  // Fetch remaining pages concurrently — all in one parallel batch for speed.
  const pages = Array.from({ length: totalPages - 1 }, (_, i) => i + 1);
  const BATCH = 10;
  for (let i = 0; i < pages.length; i += BATCH) {
    const batch = pages.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map((page) =>
        mcp("list_targets", { ...args, page, page_size: PAGE_SIZE }, slot)
          .then((res) => res.targets || [])
          .catch(() => [])
      )
    );
    for (const rows of results) all.push(...rows);
  }
  return all;
}

// Fetch every negative target (list_negative_targets returns rows under
// "negativeTargets" with the standard page/page_size pagination block).
export async function mcpAllNegatives(args: any, slot: string, maxPages: number = 10) {
  const all: any[] = [];
  for (let page = 0; page < maxPages; page++) {
    const res = await mcp("list_negative_targets", { ...args, page, page_size: 500 }, slot);
    const rows = res.negativeTargets || [];
    all.push(...rows);
    if (!res.pagination?.hasMore || rows.length === 0) break;
  }
  return all;
}

// ---------------------------------------------------------------------------
// Unified Performance Trends (daily) — REAL per-day data for the overview chart.
//
// Two genuinely per-day sources are merged by date:
//   1. get_hourly_performance(level=campaign, group_by=["date"]) — one row per
//      day with real ad spend (cost), ad sales, ROAS and ACOS. (ONE call.)
//      NOTE: its acos is a DECIMAL fraction (0.1877), so we ×100 to a percentage.
//   2. get_orders_report per day (summary only) — summary.totalValue is the true
//      total order revenue for that day (organic + ads) = "Overall Sales".
//      One light call per day, fired in parallel batches.
//
// The aggregate performance tools (get_targeting_performance etc.) only support
// week/month grouping — there is NO daily grouping — which is why the chart used
// to show weekly buckets with a broken (never-populated) Overall Sales line.
// ---------------------------------------------------------------------------

export interface UnifiedTrendPoint {
  rawDate: string;     // YYYY-MM-DD — kept for weekly/monthly bucketing
  date: string;        // display label, e.g. "17 Jun"
  overallSales: number;
  sales: number;       // ad-attributed sales
  spend: number;       // ad spend
  roas: number;
  acos: number;        // percentage (already ×100)
  units: number;
}

function fmtDayLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", { month: "short", day: "numeric" });
}

interface UnifiedTrendArgs {
  amazon_account_id?: string;
  workspace_id?: string;
  start_date: string;
  end_date: string;
}

export async function fetchUnifiedDailyTrend(args: UnifiedTrendArgs, slot: string): Promise<UnifiedTrendPoint[]> {
  const { amazon_account_id, workspace_id, start_date, end_date } = args;
  const base = { amazon_account_id, workspace_id };

  // 1. Daily ad metrics — a single hourly call rolled up to one row per day.
  //    Accurate for every day EXCEPT the most recent one or two: the hourly
  //    report syncs a day behind, so the latest day can come back at a small
  //    fraction of its true spend/sales (step 3 reconciles that).
  const hourly = await mcp("get_hourly_performance", {
    level: "campaign",
    ...base,
    start_date,
    end_date,
    group_by: ["date"],
  }, slot);

  const adRows: any[] = (hourly.rows || [])
    .filter((r: any) => r.date)
    .sort((a: any, b: any) => (a.date < b.date ? -1 : 1));

  const dates: string[] = adRows.map((r) => r.date);

  // 2. Daily Overall Sales (retail total, organic + ads) from
  //    get_retail_product_performance — the SAME source as the "Total Sales" KPI
  //    card, so the chart and the KPI agree. We used to use get_orders_report,
  //    but that sync-lags badly: some days (incl. recent ones) come back as ₹0
  //    while retail has the real figure. One light call per day, batched.
  const overallByDate: Record<string, number> = {};
  const BATCH = 8;
  for (let i = 0; i < dates.length; i += BATCH) {
    const batch = dates.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map((d) =>
        mcp("get_retail_product_performance", { ...base, start_date: d, end_date: d, page_size: 1 }, slot)
          .then((res) => ({ d, v: res.summary?.totalSales ?? null }))
          .catch(() => ({ d, v: null as number | null }))
      )
    );
    for (const { d, v } of results) {
      if (v !== null) overallByDate[d] = v;
    }
  }

  // 3. Reconcile the trailing 1-2 days' AD metrics against
  //    get_campaign_performance (single day) — the authoritative daily ad source
  //    the KPI cards use. Only override when campaign spend is clearly higher
  //    than the hourly figure (i.e. hourly under-reported that lagging day);
  //    complete days are left on their accurate hourly numbers.
  const adOverride: Record<string, { sales: number; spend: number; roas: number; acos: number }> = {};
  const tail = dates.slice(-2);
  await Promise.all(
    tail.map((d) =>
      mcp("get_campaign_performance", { ...base, start_date: d, end_date: d, page_size: 1 }, slot)
        .then((res) => {
          const s = res.summary || {};
          adOverride[d] = {
            sales: s.totalSales || 0,
            spend: s.totalSpend || 0,
            roas: s.overallRoas || 0,
            acos: s.overallAcos || 0, // already a percentage
          };
        })
        .catch(() => {})
    )
  );

  return adRows.map((r) => {
    const ov = adOverride[r.date];
    const hourlySpend = r.cost || 0;
    // Trust campaign_performance for a trailing day only when it reports
    // meaningfully more spend than hourly (the lagging-day signature).
    const useOverride = !!ov && ov.spend > hourlySpend * 1.15;

    const adSales = useOverride ? ov!.sales : (r.sales || 0);
    const spend = useOverride ? ov!.spend : hourlySpend;
    const roas = useOverride ? ov!.roas : (r.roas || 0);
    const acos = useOverride ? ov!.acos : (r.acos || 0) * 100;

    const reported = r.date in overallByDate ? overallByDate[r.date] : adSales;
    // Overall Sales (retail total) can never be LESS than ad-attributed sales —
    // ad sales is a subset of it. Floor at adSales as a last-resort guard for a
    // day whose retail call failed entirely.
    const overall = Math.max(reported, adSales);

    return {
      rawDate: r.date,
      date: fmtDayLabel(r.date),
      overallSales: overall,
      sales: adSales,
      spend,
      roas,
      acos,
      units: r.unitsOrdered || 0,
    };
  });
}

// Roll daily points up to weekly (Mon-anchored) or monthly buckets. Additive
// metrics are summed; ROAS/ACOS are recomputed from the bucket totals so they
// stay correct (you cannot average ratios).
export function aggregateTrend(
  daily: UnifiedTrendPoint[],
  granularity: "daily" | "weekly" | "monthly"
): UnifiedTrendPoint[] {
  if (granularity === "daily") return daily;

  const buckets = new Map<string, { key: string; label: string; rawDate: string; overallSales: number; sales: number; spend: number; units: number }>();

  for (const p of daily) {
    const [y, m, d] = p.rawDate.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    let key: string;
    let label: string;
    let anchor: string;

    if (granularity === "weekly") {
      // Anchor to the Monday of that week.
      const day = dt.getDay(); // 0 Sun .. 6 Sat
      const diff = (day + 6) % 7; // days since Monday
      const monday = new Date(y, m - 1, d - diff);
      const mm = String(monday.getMonth() + 1).padStart(2, "0");
      const dd = String(monday.getDate()).padStart(2, "0");
      anchor = `${monday.getFullYear()}-${mm}-${dd}`;
      key = anchor;
      label = monday.toLocaleDateString("en-IN", { month: "short", day: "numeric" });
    } else {
      anchor = `${y}-${String(m).padStart(2, "0")}-01`;
      key = `${y}-${String(m).padStart(2, "0")}`;
      label = dt.toLocaleDateString("en-IN", { month: "short", year: "numeric" });
    }

    const b = buckets.get(key) || { key, label, rawDate: anchor, overallSales: 0, sales: 0, spend: 0, units: 0 };
    b.overallSales += p.overallSales;
    b.sales += p.sales;
    b.spend += p.spend;
    b.units += p.units;
    buckets.set(key, b);
  }

  return Array.from(buckets.values())
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map((b) => ({
      rawDate: b.rawDate,
      date: b.label,
      overallSales: b.overallSales,
      sales: b.sales,
      spend: b.spend,
      roas: b.spend ? b.sales / b.spend : 0,
      acos: b.sales ? (b.spend / b.sales) * 100 : 0,
      units: b.units,
    }));
}

// Build ASIN -> SKU list map from the product catalog (one ASIN can have FBA + FBM SKUs).
// list_product_catalog paginates with limit/offset, max limit 200.
export async function fetchSkuMap(args: any, slot: string): Promise<Record<string, string[]>> {
  const map: Record<string, string[]> = {};
  let offset = 0;
  for (let i = 0; i < 10; i++) {
    const res = await mcp("list_product_catalog", { ...args, limit: 200, offset }, slot);
    const products = res.products || [];
    for (const p of products) {
      if (!p.asin || !p.sku) continue;
      if (!map[p.asin]) map[p.asin] = [];
      if (!map[p.asin].includes(p.sku)) map[p.asin].push(p.sku);
    }
    offset += products.length;
    if (products.length === 0 || offset >= (res.total || 0)) break;
  }
  return map;
}
