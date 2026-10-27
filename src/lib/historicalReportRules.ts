// Pure rules for the Amazon Historical Analysis Report (historicalAnalysisReportExport.ts), kept free
// of "@/" imports so they can be unit-tested directly with node --test.

// ── Order-status refresh ────────────────────────────────────────────────────
// The MIS amazon_orders table keeps each order line exactly as it was on the day its batch was
// loaded (26 Sep, 8 / 9 / 17 / 23 Oct 2026, ...) and later batches never update older lines. A line
// loaded while still "Pending" stays Pending forever there, even after Amazon cancels it — six such
// lines in 23 Sep – 22 Oct 2026 were counted as sold. The Orders upload card
// (barm_amazon_am_orders) holds a later full Amazon orders export for the same lines.
//
// Only the STATUS is refreshed, and only from a card row for the same order + SKU whose Amazon
// "last-updated-date" is strictly later than the MIS row's. No line is added or removed, quantities
// and dates never change, and a cancellation is never inferred — it must be in Amazon's own export.

/** True for a row from the Orders upload card itself. Rows the daily combined "Last 7 days" upload
 *  wrote into barm_amazon_am_orders before 27 Oct 2026 carry that workbook's extra derived columns
 *  ("Date ", "IST with Time", "is-prime ") and are left out (source rule, 27 Oct 2026). */
export function isOrdersCardRow(r: { raw?: Record<string, unknown> | null }): boolean {
  const raw = r.raw || {};
  return !("IST with Time" in raw) && !("Date " in raw);
}

export interface OrderLine {
  amazon_order_id: string;
  sku: string;
  order_status: string;
  item_status?: string;
  raw?: Record<string, unknown> | null;
}

export interface RefreshedOrderStatus {
  amazon_order_id: string;
  sku: string;
  from: string;
  to: string;
  misUpdated: string;
  cardUpdated: string;
}

const lastUpdatedMs = (r: OrderLine): number => {
  const v = r.raw?.["last-updated-date"];
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : NaN;
};

export function refreshOrderStatuses<T extends OrderLine>(misRows: T[], cardRows: OrderLine[]): { rows: T[]; refreshed: RefreshedOrderStatus[] } {
  const latest = new Map<string, OrderLine>();
  for (const c of cardRows) {
    if (!c.amazon_order_id || !c.sku || !isOrdersCardRow(c)) continue;
    const t = lastUpdatedMs(c);
    if (!Number.isFinite(t)) continue;
    const k = `${c.amazon_order_id}|${c.sku}`;
    const cur = latest.get(k);
    if (!cur || t > lastUpdatedMs(cur)) latest.set(k, c);
  }
  const refreshed: RefreshedOrderStatus[] = [];
  const rows = misRows.map((m) => {
    const c = latest.get(`${m.amazon_order_id}|${m.sku}`);
    if (!c) return m;
    const misT = lastUpdatedMs(m);
    const cardT = lastUpdatedMs(c);
    // A MIS row with no readable last-updated-date is never overwritten: there is no evidence the
    // card row is the newer of the two.
    if (!Number.isFinite(misT) || !(cardT > misT)) return m;
    if (c.order_status === m.order_status && (c.item_status ?? m.item_status) === m.item_status) return m;
    refreshed.push({
      amazon_order_id: m.amazon_order_id,
      sku: m.sku,
      from: m.order_status,
      to: c.order_status,
      misUpdated: String(m.raw?.["last-updated-date"] ?? ""),
      cardUpdated: String(c.raw?.["last-updated-date"] ?? ""),
    });
    return { ...m, order_status: c.order_status, item_status: c.item_status ?? m.item_status };
  });
  return { rows, refreshed };
}

// ── Order-status history (barm_amazon_order_status_history) ────────────────
// Each Orders card upload also appends the status Amazon reported for every line to this table, one
// row per (order, SKU, last-updated-date, status). Unlike barm_amazon_am_orders it is never pruned to
// the latest file's date range, so a status survives later uploads of other ranges. Re-uploading the
// same file produces the same keys, so it adds nothing.

export interface OrderStatusHistoryRow {
  amazon_order_id: string;
  sku: string;
  order_status: string;
  item_status: string | null;
  quantity: number | null;
  purchase_date: string | null;
  last_updated_at: string;
  source: string;
  source_file: string | null;
}

export const ORDER_STATUS_HISTORY_KEY = "amazon_order_id,sku,last_updated_at,order_status";

/** History rows for one Orders card upload — rows without a readable last-updated-date or status are
 *  skipped (no evidence of when the status applied); duplicate keys within the file collapse to one. */
export function orderStatusHistoryRows(
  uploadRows: { amazon_order_id?: string | null; sku?: string | null; order_status?: string | null; item_status?: string | null; quantity?: number | null; purchase_date?: string | null; raw?: Record<string, unknown> | null }[],
  sourceFile: string | null,
): OrderStatusHistoryRow[] {
  const byKey = new Map<string, OrderStatusHistoryRow>();
  for (const r of uploadRows) {
    const lu = r.raw?.["last-updated-date"];
    const t = typeof lu === "string" ? Date.parse(lu) : NaN;
    if (!r.amazon_order_id || !r.sku || !r.order_status || !Number.isFinite(t)) continue;
    const row: OrderStatusHistoryRow = {
      amazon_order_id: r.amazon_order_id,
      sku: r.sku,
      order_status: r.order_status,
      item_status: r.item_status || null,
      quantity: r.quantity ?? null,
      purchase_date: r.purchase_date || null,
      last_updated_at: new Date(t).toISOString(),
      source: "Orders card upload",
      source_file: sourceFile,
    };
    byKey.set(`${row.amazon_order_id}|${row.sku}|${row.last_updated_at}|${row.order_status}`, row);
  }
  return [...byKey.values()];
}

/** A stored history row in the shape refreshOrderStatuses compares (status + Amazon last-updated-date). */
export function historyRowAsOrderLine(h: { amazon_order_id: string; sku: string; order_status: string; item_status?: string | null; last_updated_at: string }): OrderLine {
  return { amazon_order_id: h.amazon_order_id, sku: h.sku, order_status: h.order_status, item_status: h.item_status ?? undefined, raw: { "last-updated-date": h.last_updated_at } };
}

// ── UNRESOLVED_SOURCE_DATA ──────────────────────────────────────────────────
// An order line still "Pending" in the newest stored data well after it was placed may have been
// shipped or cancelled since — the stored exports can't tell. It is counted as an order (no
// cancellation is ever inferred) and listed so the reader knows the status is unconfirmed until a newer
// Amazon All Orders export is uploaded.

export const UNRESOLVED_SOURCE_DATA = "UNRESOLVED_SOURCE_DATA";

export interface UnresolvedOrderLine {
  flag: typeof UNRESOLVED_SOURCE_DATA;
  amazon_order_id: string;
  sku: string;
  quantity: number;
  order_status: string;
  purchase_day: string;
  last_updated: string;
}

/** Counted (not-cancelled) order lines still Pending whose IST purchase day is at least `minAgeDays`
 *  before `endDate`. `purchaseDay` returns the line's IST calendar day ("YYYY-MM-DD"). */
export function unresolvedPendingOrderLines<T extends OrderLine & { quantity?: number }>(
  rows: T[],
  endDate: string,
  purchaseDay: (r: T) => string | null,
  isCounted: (r: T) => boolean,
  minAgeDays = 7,
): UnresolvedOrderLine[] {
  const cutoff = new Date(`${endDate}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - minAgeDays);
  const cutoffDay = cutoff.toISOString().slice(0, 10);
  const out: UnresolvedOrderLine[] = [];
  for (const r of rows) {
    if (!isCounted(r) || !/^pending/i.test(String(r.order_status || "").trim())) continue;
    const day = purchaseDay(r);
    if (!day || day > cutoffDay) continue;
    out.push({ flag: UNRESOLVED_SOURCE_DATA, amazon_order_id: r.amazon_order_id, sku: r.sku, quantity: r.quantity || 0, order_status: r.order_status, purchase_day: day, last_updated: String(r.raw?.["last-updated-date"] ?? "") });
  }
  return out.sort((a, b) => a.sku.localeCompare(b.sku) || a.purchase_day.localeCompare(b.purchase_day));
}

// ── Returns capped at the ordered quantity ──────────────────────────────────
// Business rule (27 Oct 2026): AM + FBA + SellerFlex returns are added together, but an order line
// never counts more returned units than were ordered. Amazon can list two return requests for one
// line (order 406-8999386-7559512: 2 units + 1 unit on a 2-unit order), so the raw sum can overshoot.
// The ordered quantity comes only from data already in hand — the AM return row's own "Order
// quantity", or that order line in the orders data. When neither is known the line is not capped:
// no quantity is invented.

export interface ReturnLine {
  orderId: string;
  sku: string;
  qty: number;
  /** Ordered quantity carried on the return row itself (AM returns), when present. */
  orderedQty?: number;
}

export interface CappedReturn { orderId: string; sku: string; returned: number; ordered: number }

export function capReturnsAtOrderedQuantity(
  lines: ReturnLine[],
  orderedByLine: Map<string, number>,
): { bySku: Map<string, number>; capped: CappedReturn[] } {
  const groups = new Map<string, { orderId: string; sku: string; qty: number; ordered: number }>();
  lines.forEach((l, i) => {
    if (!l.sku) return;
    // A return with no order id can't be matched to an order line, so it stands alone, uncapped.
    const key = l.orderId ? `${l.orderId}|${l.sku}` : `#${i}`;
    const g = groups.get(key) || { orderId: l.orderId, sku: l.sku, qty: 0, ordered: 0 };
    g.qty += l.qty || 0;
    if ((l.orderedQty ?? 0) > g.ordered) g.ordered = l.orderedQty ?? 0;
    groups.set(key, g);
  });
  const bySku = new Map<string, number>();
  const capped: CappedReturn[] = [];
  groups.forEach((g) => {
    const ordered = Math.max(g.ordered, (g.orderId && orderedByLine.get(`${g.orderId}|${g.sku}`)) || 0);
    const counted = ordered > 0 ? Math.min(g.qty, ordered) : g.qty;
    if (counted < g.qty) capped.push({ orderId: g.orderId, sku: g.sku, returned: g.qty, ordered });
    bySku.set(g.sku, (bySku.get(g.sku) || 0) + counted);
  });
  return { bySku, capped };
}

// ── Inventory-ledger balances ───────────────────────────────────────────────
// One pass over the latest ledger row per SKU + location, grouped two ways at once:
//  - stateBalances by STATE (fcToState) — joined against order ship_state in Key Insights, so it
//    must stay state-grained;
//  - areaBalances by the seller's own FC AREA (fcToAreaManual: BANGALORE, HYDERABAD, JAIPUR,
//    LUCKNOW, AHMEDABAD, PATNA, ...) — the columns of their hand-built FBA status pivot, used for the
//    FBA status sheet and the Analysis report's Available / Not Available columns.
// A location whose latest balance is 0 is still registered (a literal 0 = "reported, currently not
// available"), so "never stocked there" stays distinguishable as an absent key.

export interface LedgerSkuBalances {
  fbaTotal: number;
  stateBalances: Map<string, number>;
  areaBalances: Map<string, number>;
}

export interface LedgerBalanceRow {
  ledger_date: string;
  msku: string;
  location: string;
  fnsku?: string | null;
  ending_balance: number;
}

// Alternative to carryForwardLedgerBalances (not the default): the stock figures describe
// ONE snapshot — every row dated asOf, nothing carried forward from older dates. A location
// missing from that snapshot contributes no balance. Several FNSKUs at the same MSKU and location are separate inventory and are summed;
// an identical (msku, location, fnsku) repeated on the same date is one line and is
// counted once. Returns one row per msku|location.
export function snapshotLedgerBalances(
  rows: Iterable<LedgerBalanceRow>,
  asOf: string | null,
): LedgerBalanceRow[] {
  if (!asOf) return [];
  const seenLine = new Set<string>();
  const byLocation = new Map<string, LedgerBalanceRow>();
  for (const r of rows) {
    if (r.ledger_date !== asOf || !r.msku) continue;
    const lineKey = `${r.msku}|${r.location}|${r.fnsku ?? ""}`;
    if (seenLine.has(lineKey)) continue;
    seenLine.add(lineKey);
    const locKey = `${r.msku}|${r.location}`;
    const cur = byLocation.get(locKey);
    if (cur) cur.ending_balance += r.ending_balance || 0;
    else byLocation.set(locKey, { ledger_date: asOf, msku: r.msku, location: r.location, ending_balance: r.ending_balance || 0 });
  }
  return [...byLocation.values()];
}

// The original rule, kept so the two methods can be compared on the same source data:
// the latest row per msku|location dated on or before asOf, so a location missing from
// the newest snapshot keeps its last reported balance (often a stale 0). If nothing is
// dated on or before asOf, only the asOf rows are used. Ties keep the first row seen.
export function carryForwardLedgerBalances(
  rows: Iterable<LedgerBalanceRow>,
  asOf: string | null,
): LedgerBalanceRow[] {
  if (!asOf) return [];
  const all = [...rows];
  const inScope = all.filter((r) => r.ledger_date && r.ledger_date <= asOf);
  const effective = inScope.length ? inScope : all.filter((r) => r.ledger_date === asOf);
  const latest = new Map<string, LedgerBalanceRow>();
  for (const r of effective) {
    if (!r.msku) continue;
    const key = `${r.msku}|${r.location}`;
    const cur = latest.get(key);
    if (!cur || r.ledger_date > cur.ledger_date) latest.set(key, r);
  }
  return [...latest.values()];
}

export type LedgerBalanceMode = "snapshot" | "carry_forward";

// An unmapped SB/SD bucket row with no spend in either window carries no figures and
// is not a SKU; the manual workbook has none. Real mapped rows are never affected.
export function isEmptyUnmappedRow(isUnmapped: boolean, spendTaxA: number, spendTaxB: number): boolean {
  return isUnmapped && !(spendTaxA > 0) && !(spendTaxB > 0);
}

export function ledgerBalancesBySku(
  latestRows: Iterable<{ msku: string; location: string; ending_balance: number }>,
  toState: (fc: string) => string,
  toArea: (fc: string) => string,
): { bySku: Map<string, LedgerSkuBalances>; states: Set<string>; areas: Set<string> } {
  const bySku = new Map<string, LedgerSkuBalances>();
  const states = new Set<string>();
  const areas = new Set<string>();
  for (const r of latestRows) {
    if (!r.msku) continue;
    const bal = r.ending_balance || 0;
    let s = bySku.get(r.msku);
    if (!s) { s = { fbaTotal: 0, stateBalances: new Map(), areaBalances: new Map() }; bySku.set(r.msku, s); }
    if (bal > 0) s.fbaTotal += bal;
    const state = toState(r.location);
    const area = toArea(r.location);
    s.stateBalances.set(state, (s.stateBalances.get(state) || 0) + bal);
    s.areaBalances.set(area, (s.areaBalances.get(area) || 0) + bal);
    states.add(state);
    areas.add(area);
  }
  return { bySku, states, areas };
}
