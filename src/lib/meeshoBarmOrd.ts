import { fetchAllRows } from "@/lib/amazonReportShared";
import { sharedFetch } from "@/lib/sharedFetch";

// Meesho orders now come from the Supabase table meesho_barm_ord (filled
// outside this app), replacing the old /dashboard/meesho/upload page's
// barm_meesho_orders — by the seller's instruction of 29 Sep 2026.
//
// meesho_barm_ord keeps Meesho's raw workbook column names as text, and the
// same file lands in it more than once (one batch per created_at), so each
// Sub Order No appears several times with its status as of that batch. The
// rows are normalised here to the barm_meesho_orders shape the reports were
// written against (order_status, sub_order_no, order_date, sku, quantity,
// supplier_listed_price, …) and deduped to each sub-order's latest batch.

export const MEESHO_ORDERS_TABLE = "meesho_barm_ord";

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// "Order Date" arrives either as ISO ("2026-07-01") or as "31-Jul" with no
// year. A yearless date takes its batch's created_at year, stepping back a
// year when that would put the order after the batch was loaded (a
// December order loaded in January).
export function parseMeeshoOrderDate(value: unknown, createdAt: unknown): string | null {
  const s = String(value ?? "").trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dm = s.match(/^(\d{1,2})-([A-Za-z]{3})/);
  if (!dm || !MONTHS[dm[2].toLowerCase()]) return null;
  const loaded = String(createdAt ?? "").slice(0, 10);
  let year = Number(loaded.slice(0, 4)) || new Date().getUTCFullYear();
  const mmdd = `${String(MONTHS[dm[2].toLowerCase()]).padStart(2, "0")}-${dm[1].padStart(2, "0")}`;
  if (loaded && `${year}-${mmdd}` > loaded) year -= 1;
  return `${year}-${mmdd}`;
}

const numOrNull = (v: unknown): number | null => {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return String(v ?? "").trim() !== "" && Number.isFinite(n) ? n : null;
};

export interface MeeshoOrderRow {
  order_status: string;
  sub_order_no: string;
  order_date: string | null;
  customer_state: string;
  product_name: string;
  sku: string;
  size: string;
  quantity: number | null;
  supplier_listed_price: number | null;
  supplier_discounted_price: number | null;
  packet_id: string;
  created_at: string;
  /** The source row's own columns (minus id/created_at) — the report's raw-dump sheet reads this. */
  raw: Record<string, unknown>;
}

/** Every Meesho order in meesho_barm_ord, one row per Sub Order No (latest batch wins). */
export function fetchMeeshoOrderRows(): Promise<MeeshoOrderRow[]> {
  return sharedFetch(MEESHO_ORDERS_TABLE, loadMeeshoOrderRows);
}

async function loadMeeshoOrderRows(): Promise<MeeshoOrderRow[]> {
  const raw = await fetchAllRows(MEESHO_ORDERS_TABLE, (q) => q);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const latest = new Map<string, any>();
  raw.forEach((r) => {
    const key = String(r["Sub Order No"] ?? "").trim();
    if (!key) return;
    const prev = latest.get(key);
    if (!prev || String(r.created_at ?? "") > String(prev.created_at ?? "")) latest.set(key, r);
  });
  return [...latest.values()].map((r) => ({
    order_status: String(r["Reason for Credit Entry"] ?? "").trim(),
    sub_order_no: String(r["Sub Order No"]).trim(),
    order_date: parseMeeshoOrderDate(r["Order Date"], r.created_at),
    customer_state: String(r["Customer State"] ?? ""),
    product_name: String(r["Product Name"] ?? ""),
    sku: String(r["SKU"] ?? "").trim(),
    size: String(r["Size"] ?? ""),
    quantity: numOrNull(r["Quantity"]),
    supplier_listed_price: numOrNull(r["Supplier Listed Price (Incl. GST + Commission)"]),
    supplier_discounted_price: numOrNull(r["Supplier Discounted Price (Incl GST and Commision)"]),
    packet_id: String(r["Packet Id"] ?? ""),
    created_at: String(r.created_at ?? ""),
    raw: Object.fromEntries(Object.entries(r).filter(([k]) => k !== "id" && k !== "created_at")),
  }));
}

/** Orders on file, for the Meesho Overview/Download "Data on file" captions. Never rejects. */
export async function fetchMeeshoOrdersDataInfo(): Promise<{ rowCount: number; minDate: string | null; maxDate: string | null; error?: string }> {
  try {
    const dates = (await fetchMeeshoOrderRows()).map((r) => r.order_date).filter((d): d is string => !!d).sort();
    return { rowCount: dates.length, minDate: dates[0] ?? null, maxDate: dates[dates.length - 1] ?? null };
  } catch (e) {
    return { rowCount: 0, minDate: null, maxDate: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Meesho orders with order_date in [start, end] (inclusive, YYYY-MM-DD). */
export async function fetchMeeshoOrderRowsInRange(start: string, end: string): Promise<MeeshoOrderRow[]> {
  const rows = await fetchMeeshoOrderRows();
  return rows.filter((r) => r.order_date && r.order_date >= start && r.order_date <= end);
}

// ── Returns ────────────────────────────────────────────────────────────────
// Meesho returns live in three tables, one per stage of the return, filled
// outside this app like meesho_barm_ord: in transit -> out for delivery ->
// delivered back to the seller. A return moves forward through them, so the
// same Suborder Number shows up in more than one table (and, like the orders
// table, once per load batch). Each suborder is counted once, at its
// furthest stage.

export const MEESHO_RETURN_TABLES = [
  { table: "meesho_barm_return_intransit", stage: "In Transit", rank: 1 },
  { table: "meesho_barm_return_ofd", stage: "Out for Delivery", rank: 2 },
  { table: "meesho_barm_return_delivered", stage: "Delivered", rank: 3 },
] as const;

const RETURN_DATE_COLUMNS = ["Dispatch Date", "Return Created Date", "Expected Delivery Date", "Delivered Date"];

export interface MeeshoReturnRow {
  sub_order_no: string;
  sku: string;
  product_name: string;
  quantity: number;
  return_created_date: string | null;
  type_of_return: string;
  stage: string;
}

// Some early load batches wrote their dates as YYYY-DD-MM ("2026-27-07").
// A batch is treated as day-first when any of its date cells has a "month"
// above 12; otherwise its dates are read as ISO.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dayFirstBatches(rows: any[]): Set<string> {
  const out = new Set<string>();
  rows.forEach((r) => {
    for (const col of RETURN_DATE_COLUMNS) {
      const m = String(r[col] ?? "").match(/^\d{4}-(\d{2})-\d{2}/);
      if (m && Number(m[1]) > 12) out.add(String(r.created_at ?? ""));
    }
  });
  return out;
}

function readReturnDate(value: unknown, dayFirst: boolean): string | null {
  const m = String(value ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [, y, a, b] = m;
  const [mm, dd] = dayFirst ? [b, a] : [a, b];
  return Number(mm) >= 1 && Number(mm) <= 12 ? `${y}-${mm}-${dd}` : null;
}

/** Every Meesho return across the three stage tables, one row per Suborder Number. */
export function fetchMeeshoReturnRows(): Promise<MeeshoReturnRow[]> {
  return sharedFetch("meesho_barm_return_*", loadMeeshoReturnRows);
}

async function loadMeeshoReturnRows(): Promise<MeeshoReturnRow[]> {
  const tables = await Promise.all(MEESHO_RETURN_TABLES.map((t) => fetchAllRows(t.table, (q) => q)));
  const best = new Map<string, { row: MeeshoReturnRow; rank: number; createdAt: string }>();
  MEESHO_RETURN_TABLES.forEach((t, i) => {
    const rows = tables[i];
    const dayFirst = dayFirstBatches(rows);
    rows.forEach((r) => {
      const sub = String(r["Suborder Number"] ?? "").trim();
      if (!sub) return;
      const createdAt = String(r.created_at ?? "");
      const prev = best.get(sub);
      if (prev && (prev.rank > t.rank || (prev.rank === t.rank && prev.createdAt >= createdAt))) return;
      best.set(sub, {
        rank: t.rank,
        createdAt,
        row: {
          sub_order_no: sub,
          sku: String(r["SKU"] ?? "").trim(),
          product_name: String(r["Product Name"] ?? ""),
          quantity: numOrNull(r["Qty"]) ?? 1,
          return_created_date: readReturnDate(r["Return Created Date"], dayFirst.has(createdAt)),
          type_of_return: String(r["Type of Return"] ?? ""),
          stage: t.stage,
        },
      });
    });
  });
  return [...best.values()].map((b) => b.row);
}
