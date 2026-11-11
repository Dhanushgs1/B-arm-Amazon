import { supabasePublic } from "@/lib/supabasePublic";
import { withDbSlot } from "@/lib/dbConcurrency";
import { isCourierRtoReturnType } from "@/lib/amazonSpendRules";

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
export async function fetchAllRows(table: string, apply: (q: any) => any, orderBy: string | string[] = "id", columns = "*"): Promise<any[]> {
  const PAGE = 1000;
  const orderCols = Array.isArray(orderBy) ? orderBy : [orderBy];

  // One request, with the retry this codebase already uses for the project's brief
  // "statement timeout" blips: without it, one blip on any single page throws and (since every
  // report fetches its tables inside a Promise.all) takes the ENTIRE report down. Every request
  // also waits for a slot (dbConcurrency.ts) so a page that loads several marketplaces at once
  // cannot pile dozens of reads onto the database together.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const run = async (build: () => any): Promise<{ rows: any[]; count: number | null }> => {
    let error: { message: string } | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the query builder is untyped here (apply: any)
      const res: any = await withDbSlot(() => build());
      error = res.error;
      if (!error) return { rows: res.data || [], count: typeof res.count === "number" ? res.count : null };
      if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
    throw new Error(`Fetch ${table} failed: ${error?.message}`);
  };
  // Paging is only stable with a sort on a unique column: without it Postgres does not guarantee
  // the same row order across separate requests, so later pages can silently skip and repeat rows
  // (that surfaced as corrupted week-over-week totals on tables that cross the 1000-row boundary).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ordered = (q: any) => orderCols.reduce((qq, col) => qq.order(col, { ascending: true }), q);

  // ── Sorted by id (the default): "continue after the last id" ──────────────────────────────────
  // Each page starts where the previous one stopped. The older "skip N rows" form made the database
  // walk and discard every earlier row again on every page, so page 7 cost seven pages of work and
  // was the one that ran past the 3-second limit. Same rows, same order.
  if (orderCols.length === 1 && orderCols[0] === "id") {
    const all: unknown[] = [];
    let lastId: unknown = null;
    for (let i = 0; i < 400; i++) {
      const { rows } = await run(() => {
        const q = ordered(apply(supabasePublic.from(table).select(columns)));
        return (lastId === null ? q : q.gt("id", lastId)).limit(PAGE);
      });
      all.push(...rows);
      if (rows.length < PAGE) return all;
      const next = rows[rows.length - 1]?.id;
      if (next === undefined || next === null) break; // "id" not in the selected columns: page by offset below
      lastId = next;
    }
    if (lastId !== null) return all;
  }

  // ── Any other sort: by offset. The first request also returns how many rows match, so the
  // remaining pages are requested together (WAVE at a time) and none past the end. Pages are
  // appended in offset order, so the result is in the same order as before.
  const WAVE = 4;
  const page = (from: number, withCount = false) =>
    run(() => ordered(apply(supabasePublic.from(table).select(columns, withCount ? { count: "exact" } : undefined))).range(from, from + PAGE - 1));
  const all: unknown[] = [];
  const first = await page(0, true);
  all.push(...first.rows);
  if (first.rows.length < PAGE) return all;
  const lastPage = first.count === null ? 199 : Math.max(0, Math.ceil(first.count / PAGE) - 1);
  for (let next = 1; next <= lastPage; next += WAVE) {
    const width = Math.min(WAVE, lastPage - next + 1);
    const pages = await Promise.all(Array.from({ length: width }, (_, k) => page((next + k) * PAGE)));
    let ended = false;
    for (const { rows } of pages) {
      if (ended) break; // pages after a short one are past the end of the data
      all.push(...rows);
      if (rows.length < PAGE) ended = true;
    }
    if (ended) break;
  }
  return all;
}

/**
 * Inclusive [start, end] date windows of at most `chunkDays` days each, covering the range exactly once.
 * Dates are 'YYYY-MM-DD'. An empty array when end is before start.
 */
export function dateChunks(start: string, end: string, chunkDays: number): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  if (!start || !end || start > end || chunkDays < 1) return out;
  const addDays = (iso: string, n: number) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  let cur = start;
  while (cur <= end) {
    const last = addDays(cur, chunkDays - 1);
    const chunkEnd = last < end ? last : end;
    out.push({ start: cur, end: chunkEnd });
    cur = addDays(chunkEnd, 1);
  }
  return out;
}

/**
 * fetchAllRows, split into date windows on `dateCol`. Each request filters on one window, so Postgres can use the
 * date index and only read that window's rows. Same rows as one unchunked fetch over [start, end]; windows are disjoint
 * and cover the range once, so no row is repeated or skipped.
 */
export async function fetchAllRowsByDateChunks(
  table: string,
  dateCol: string,
  start: string,
  end: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extra: (q: any) => any = (q) => q,
  chunkDays = 7,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
  const out: unknown[] = [];
  for (const c of dateChunks(start, end, chunkDays)) {
    // Order by the date column first, then id. Ordering by id alone lets Postgres walk the primary key and filter by
    // date, which is slow for every page; (date, id) lets it use the date index and sort within the window. Both
    // columns together are unique, so paging stays stable.
    const rows = await fetchAllRows(table, (q) => extra(q).gte(dateCol, c.start).lte(dateCol, c.end), [dateCol, "id"]);
    out.push(...rows);
  }
  return out;
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
// AM returns (Seller Central return-requests export) signal the same thing via "Return type":
// "Undelivered", "Rejected" and "Undelivered/Rejected" are all courier RTO (Rejected by the seller's
// decision of 24 Sep 2026, matching FBA's UNDELIVERABLE_REFUSED). SellerFlex's "UNDELIVERED" too.
export function isGenuineAmReturn(r: { return_type?: string }): boolean {
  return !isCourierRtoReturnType(r.return_type);
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
