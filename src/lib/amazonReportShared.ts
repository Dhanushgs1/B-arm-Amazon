import { supabasePublic } from "@/lib/amazonReportUpload";

// Small helpers shared by every report that reads the manually-uploaded Amazon
// tables (barm_amazon_*) — split out from historicalAnalysisReportExport.ts so
// analysisReportExport.ts can use the same tables/filters without the two
// files importing each other (fetchFullCatalog/fetchInventoryByLocation/
// fcToState already flow the other way, analysisReportExport.ts -> here would
// have made that a cycle).

/**
 * Page through a whole table.
 *
 * `orderBy` is the column (or columns) used to make pagination deterministic;
 * it must be UNIQUE across the rows being fetched. Defaults to "id", which
 * every barm_* upload table has — except the two hand-maintained mapping
 * tables, which are keyed by their natural columns instead. Passing a column
 * that doesn't exist makes PostgREST reject the request outright ("column ...
 * does not exist"), and because callers fetch inside a Promise.all that
 * rejection takes the entire report down — so the default is not safe to
 * assume blindly.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchAllRows(table: string, apply: (q: any) => any, orderBy: string | string[] = "id"): Promise<any[]> {
  const all: unknown[] = [];
  const PAGE = 1000;
  const orderCols = Array.isArray(orderBy) ? orderBy : [orderBy];
  let from = 0;
  for (let i = 0; i < 200; i++) {
    // .range() pagination is only stable when paired with .order() on a
    // unique column — without it, Postgres/PostgREST doesn't guarantee the
    // same row order across separate paginated requests, so pages taken more
    // than ~1000 rows into a table can silently skip and re-return rows. That
    // surfaced as corrupted week-over-week totals on tables that cross the
    // 1000-row page boundary.
    let q = apply(supabasePublic.from(table).select("*"));
    for (const col of orderCols) q = q.order(col, { ascending: true });
    // Same "brief statement timeout blips against this project's DB" this
    // codebase already retries in emailSettingsStore.ts's readEmailSettings —
    // without a retry here, one transient blip on any single page throws and
    // (since every report fetches its tables inside a Promise.all) takes the
    // ENTIRE report down, exactly as seen in production on amazon_orders for
    // both the Weekly Sales Report and the Historical Analysis Report.
    let error: { message: string } | null = null;
    let rows: unknown[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await q.range(from, from + PAGE - 1);
      error = res.error;
      if (!error) {
        rows = res.data || [];
        break;
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
    if (error) throw new Error(`Fetch ${table} failed: ${error.message}`);
    all.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// A cancelled order was never sold, so it must not count towards Orders — the
// Orders export keeps those rows, and including them inflates Orders (and so
// depresses ACOS/TACOS, whose denominators are built from it).
export function isCancelledOrder(r: { order_status?: string }): boolean {
  return String(r.order_status || "").trim().toLowerCase().startsWith("cancel");
}

// A normal Amazon.in order ID is "NNN-NNNNNNN-NNNNNNN" (e.g.
// 402-1234567-1234567). A small minority of rows instead carry an "S02-"
// prefix (in this account's export, always paired with an unusual
// order-status like "Shipping" instead of "Shipped") — verified directly
// against the seller's own workbook: every single "S02-" order across the
// whole 30-day window (53 rows) is absent from their Orders sheet, with zero
// exceptions, so their own process treats these as not-a-real-sale and
// excludes them the same way a cancelled order is excluded.
export function isStandardOrderId(orderId: string | undefined): boolean {
  return /^\d{3}-\d{7}-\d{7}$/.test(String(orderId || "").trim());
}

// Same courier-RTO exclusion the live report uses for FBA customer returns
// (an UNDELIVERABLE/refused parcel never reached the customer).
export function isGenuineFbaReturn(r: { reason?: string }): boolean {
  return !String(r.reason || "").toUpperCase().startsWith("UNDELIVERABLE");
}
// AM returns (Seller Central return-requests export) signals the same thing
// via "Return type" = "Undelivered" instead of a reason-code prefix.
export function isGenuineAmReturn(r: { return_type?: string }): boolean {
  return String(r.return_type || "").toLowerCase() !== "undelivered";
}

// Amazon's Orders/FBA-returns exports carry a timestamp (with time-of-day) in
// UTC, but the seller buckets it into a calendar day by IST (UTC+5:30) first —
// their own "AM orders" sheet has a derived "IST with Time" column doing
// exactly this (`= <UTC datetime> + TIME(5,30,0)`) before anything gets
// pivoted by day. Truncating the UTC instant directly (no offset) puts any
// order/return from ~18:30 UTC onward on the wrong (earlier) calendar day —
// confirmed against the seller's own workbook: this exact IST-shift closed
// every remaining Orders/Returns discrepancy (140/140 SKUs matched).
//
// Returns the half-open UTC instant range for the IST calendar-day window
// [start, end] (inclusive), so a `timestamptz` column can be filtered with a
// single .gte/.lt pair without needing to shift each row into JS first.
export function istDayWindowUtc(start: string, end: string): { gte: string; lt: string } {
  const prevDay = (iso: string): string => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  };
  // 00:00 IST on `start` = 18:30 UTC the day before; 00:00 IST on the day
  // AFTER `end` (the exclusive upper bound) = 18:30 UTC on `end` itself.
  return { gte: `${prevDay(start)}T18:30:00.000Z`, lt: `${end}T18:30:00.000Z` };
}

// Buckets a single raw UTC timestamp into its IST calendar day ("YYYY-MM-DD") —
// the per-row counterpart to istDayWindowUtc's range, for callers that fetch a
// wider span in one query and then need to sort individual rows into narrower
// periods in memory (e.g. weeklySalesExport.ts's last-week/this-week split).
// Bucketing by the raw UTC date instead (`isoString.slice(0,10)`) puts any
// order/return from ~18:30 UTC onward on the wrong (earlier) calendar day —
// the same drift istDayWindowUtc's own comment documents.
export function istDateOnly(utcIso: string): string {
  const d = new Date(utcIso);
  d.setUTCMinutes(d.getUTCMinutes() + 330);
  return d.toISOString().slice(0, 10);
}

// barm_amazon_sp_advertised_product rows for a deleted/archived Sponsored Products campaign come
// back with campaign_name AND ad_group_name both blank — Amazon can no longer break that
// campaign's spend down per SKU once it's gone, so its export repeats the SAME full daily spend
// figure on every advertised SKU the campaign used to target, rather than splitting it across them
// (confirmed against the seller's own uploaded "Last 7 days" workbook and the full available
// history: the exact same set of SKUs recurs every single day sharing one identical spend value
// that itself changes day to day, tracking one underlying campaign's real daily spend — not
// coincidence). Summed naively — whether per SKU or into a flat platform total — that inflates
// spend by however many SKUs/rows shared it. Shared here so every report that reads this table
// detects and corrects the same pattern the same way, instead of each carrying its own copy.
//
// Returns a per-row divisor: 1 for any row with a real campaign_name or ad_group_name (never
// touches attributed spend, including legitimate multi-SKU SB/SD spend apportioned by weight
// elsewhere), or the cluster size for a blank-identity row that shares an exact spend value with
// other blank-identity rows on the same report_date.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildOrphanSpendDivisor(rows: any[]): (r: any) => number {
  const clusterSize = new Map<string, number>();
  rows.forEach((r) => {
    if (r.campaign_name || r.ad_group_name || !r.advertised_sku) return;
    const spend = Number(r.spend) || 0;
    const key = `${r.report_date}|${spend.toFixed(6)}`;
    clusterSize.set(key, (clusterSize.get(key) || 0) + 1);
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (r: any): number => {
    if (r.campaign_name || r.ad_group_name) return 1;
    const spend = Number(r.spend) || 0;
    return clusterSize.get(`${r.report_date}|${spend.toFixed(6)}`) || 1;
  };
}
