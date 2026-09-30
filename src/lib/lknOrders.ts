import { mcp } from "@/lib/api";

// LKN-only (keySlot "A") get_orders_report helpers. Barm (slot "B") keeps its own
// path in dashboard/page.tsx and must not be routed through here.
//
// How get_orders_report really filters, verified live against LKN (26–28 Sep 2026):
//   - end_date is INCLUSIVE, on UTC calendar days of purchaseDate. The response's
//     echoed `createdBefore` (end_date at 00:00) is misleading: 26→27 = 393 orders,
//     27→28 = 426, 26→28 = 612 — only inclusive days add up (26:186, 27:207, 28:219).
//     The old "+1 day, end is exclusive" logic therefore summed one extra whole day.
//   - start_date === end_date always returns 0 orders, even on days with sales.
//   - Raw order rows carry no amount — only numberOfItemsShipped/Unshipped.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function shiftYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

// Calendar date (YYYY-MM-DD) of a UTC timestamp as seen in Asia/Kolkata.
function istYmd(isoUtc: string): string {
  return new Date(new Date(isoUtc).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

interface Base {
  amazon_account_id?: string;
  workspace_id?: string;
}

interface StateRow {
  state: string;
  totalOrders: number;
  totalValue: number;
  currencyCode?: string;
}

export interface LknOrdersSummary {
  summary: { totalOrders: number; totalValue: number; topStates: StateRow[] };
}

const summaryCall = (base: Base, start: string, end: string, slot: string) =>
  mcp("get_orders_report", { ...base, start_date: start, end_date: end, top_states: 100 }, slot);

// Order value + state breakdown for [start, end] (UTC days — amounts only exist on
// SellerMate's summary, so this cannot be IST-exact; expect a <1% boundary gap vs
// Seller Central). A single day can't be asked for directly (start === end → 0), so
// it is taken as the difference of two real, non-degenerate summaries:
//   {d-2, d-1, d} − {d-2, d-1} = {d}
export async function fetchLknOrdersSummary(base: Base, start: string, end: string, slot: string): Promise<LknOrdersSummary> {
  if (start !== end) {
    const res = await summaryCall(base, start, end, slot);
    return {
      summary: {
        totalOrders: res.summary?.totalOrders || 0,
        totalValue: res.summary?.totalValue || 0,
        topStates: res.summary?.topStates || [],
      },
    };
  }

  const anchor = shiftYmd(start, -2);
  const [withDay, withoutDay] = await Promise.all([
    summaryCall(base, anchor, end, slot),
    summaryCall(base, anchor, shiftYmd(start, -1), slot),
  ]);

  const before = new Map<string, StateRow>();
  for (const s of withoutDay.summary?.topStates || []) before.set(s.state, s);
  const topStates: StateRow[] = (withDay.summary?.topStates || [])
    .map((s: StateRow) => {
      const b = before.get(s.state);
      return {
        ...s,
        totalOrders: s.totalOrders - (b?.totalOrders || 0),
        totalValue: s.totalValue - (b?.totalValue || 0),
      };
    })
    .filter((s: StateRow) => s.totalOrders > 0);

  return {
    summary: {
      totalOrders: Math.max(0, (withDay.summary?.totalOrders || 0) - (withoutDay.summary?.totalOrders || 0)),
      totalValue: Math.max(0, (withDay.summary?.totalValue || 0) - (withoutDay.summary?.totalValue || 0)),
      topStates,
    },
  };
}

// IST-exact order count and units for [start, end]. Pulls raw rows for UTC days
// start-1 … end (which fully covers IST start 00:00 → end 23:59:59, since IST day d
// is UTC d-1 18:30 → d 18:30), then keeps only orders whose purchaseDate falls on
// an IST date inside the range. Units = numberOfItemsShipped + numberOfItemsUnshipped.
export async function fetchLknOrderUnitsIst(base: Base, start: string, end: string, slot: string): Promise<{ orders: number; units: number }> {
  const PAGE_SIZE = 500;
  const args = { ...base, start_date: shiftYmd(start, -1), end_date: end, include_orders: true, top_states: 1, page_size: PAGE_SIZE };

  const first = await mcp("get_orders_report", { ...args, page: 0 }, slot);
  const rows: any[] = [...(first.orders || [])];
  const totalPages = Math.min(first.pagination?.totalPages || 1, 60);

  const pages = Array.from({ length: Math.max(0, totalPages - 1) }, (_, i) => i + 1);
  const BATCH = 6;
  for (let i = 0; i < pages.length; i += BATCH) {
    const results = await Promise.all(
      pages.slice(i, i + BATCH).map((page) =>
        mcp("get_orders_report", { ...args, page }, slot).then((res) => res.orders || [])
      )
    );
    for (const r of results) rows.push(...r);
  }

  // Pages aren't guaranteed stable across calls — dedupe on the order id so a row
  // repeated across two pages isn't counted twice.
  const seen = new Set<string>();
  let orders = 0;
  let units = 0;
  for (const o of rows) {
    if (!o.purchaseDate) continue;
    if (o.amazonOrderId) {
      if (seen.has(o.amazonOrderId)) continue;
      seen.add(o.amazonOrderId);
    }
    const d = istYmd(o.purchaseDate);
    if (d < start || d > end) continue;
    orders += 1;
    units += (o.numberOfItemsShipped || 0) + (o.numberOfItemsUnshipped || 0);
  }
  return { orders, units };
}
