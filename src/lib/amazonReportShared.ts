import { supabasePublic } from "@/lib/amazonReportUpload";

// Small helpers shared by every report that reads the manually-uploaded Amazon
// tables (barm_amazon_*) — split out from historicalAnalysisReportExport.ts so
// analysisReportExport.ts can use the same tables/filters without the two
// files importing each other (fetchFullCatalog/fetchInventoryByLocation/
// fcToState already flow the other way, analysisReportExport.ts -> here would
// have made that a cycle).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchAllRows(table: string, apply: (q: any) => any): Promise<any[]> {
  const all: unknown[] = [];
  const PAGE = 1000;
  let from = 0;
  for (let i = 0; i < 200; i++) {
    const { data, error } = await apply(supabasePublic.from(table).select("*")).range(from, from + PAGE - 1);
    if (error) throw new Error(`Fetch ${table} failed: ${error.message}`);
    const rows = data || [];
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
