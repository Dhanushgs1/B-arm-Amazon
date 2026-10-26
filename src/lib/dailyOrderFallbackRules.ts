// Pure rules for filling the Overall page's Amazon/Flipkart orders from the daily "Last 7 days"
// upload for the days the MIS tables (amazon_orders / fk_orders) don't reach yet — kept
// dependency-free so they can be unit tested directly.
//
// The MIS tables are loaded by an outside feed in batches and lag the seller's own uploads by a few
// days (26 Oct 2026: MIS through 22 Oct, uploads through 25 Oct), so the Overall page read ₹0 for
// Amazon and Flipkart on any day past the last MIS load. The daily-upload mirror tables
// (barm_daily_am_orders / barm_daily_fk_orders — what the Ad Spend Report's Overall sales reads)
// fill only the days AFTER the last MIS day; MIS stays the source for every day it has, so the two
// are never both counted for one day.

const addDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** First day to read from the daily upload, or null when MIS already reaches rangeEnd.
 *  misMaxDate = the newest order date in the MIS table (null = table empty). */
export function dailyFallbackStart(misMaxDate: string | null, rangeStart: string, rangeEnd: string): string | null {
  if (!misMaxDate) return rangeStart;
  const next = addDay(misMaxDate.slice(0, 10));
  if (next > rangeEnd) return null;
  return next > rangeStart ? next : rangeStart;
}

/** A barm_daily_am_orders row in the shape amazonSkuPeriodData.ts reads off an MIS amazon_orders row. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function dailyAmRowAsMis(r: any) {
  const raw = (r.raw as Record<string, unknown>) || {};
  return {
    amazon_order_id: String(r.order_id ?? ""),
    order_item_id: String(raw["order-item-id"] ?? r.id ?? r.order_id ?? ""),
    // report_date is already the IST calendar day of purchase_datetime (verified on 22–25 Oct 2026).
    purchase_date: r.report_date ? String(r.report_date).slice(0, 10) : null,
    purchase_datetime: r.purchase_datetime ? String(r.purchase_datetime) : null,
    order_status: String(r.order_status ?? ""),
    item_status: String(raw["item-status"] ?? r.order_status ?? ""),
    sku: String(r.sku ?? "").trim(),
    product_name: String(r.product_name ?? ""),
    quantity: Number(r.quantity) || 0,
    item_price: Number(r.item_price) || 0,
    raw,
  };
}

/** A barm_daily_fk_orders row in the shape channelSummary.ts reads off an MIS fk_orders row. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function dailyFkRowAsMis(r: any) {
  return {
    order_item_id: String(r.order_item_id ?? "").trim(),
    order_id: String(r.order_id ?? "").trim(),
    order_date: r.report_date ? String(r.report_date).slice(0, 10) : null,
    order_item_status: String(r.order_status ?? ""),
    sku: String(r.sku ?? "").trim(),
    quantity: Number(r.quantity) || 0,
  };
}

/** Drops exact repeat lines (same line item, status and quantity) — the Ad Spend Report's own guard
 *  against a duplicate left in the daily table by an older upload. */
export function dedupeOrderLines<T extends { order_item_id: string; quantity: number }>(rows: T[], status: (r: T) => string): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = `${r.order_item_id}|${status(r)}|${r.quantity}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
