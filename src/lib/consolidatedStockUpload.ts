// Uploads and reads for the Consolidated Stock Sheet (src/lib/consolidatedStock.ts).
//   barm_godown_stock    one row per master product per godown upload (snapshot_date = latest block)
//   barm_godown_daily    daily Stock Out etc. per product; re-uploading a date overwrites it
// Stock Purchase and Components are never uploaded and never read live: they come from the weekly
// Monday 10:00 IST snapshot (supabase/migrations/20261013120000_barm_weekly_restock_snapshot.sql), fixed
// for the week (user, 2026-10-13):
//   barm_weekly_snapshot_runs        one row per Monday: 'ok' / 'failed', when it was captured
//   barm_weekly_rfq_snapshot         product_forecast_rfq_v per product: in transit, order placed, Suggested RFQ
//   barm_weekly_component_snapshot   components_sheet rows: required qty, component stock

import * as XLSX from "xlsx";
import { supabasePublic } from "@/lib/amazonReportUpload";
import { fetchAllRows } from "@/lib/amazonReportShared";
import { currentGodownName } from "@/lib/godownProductAliases";
import { chunk } from "@/lib/amazonOrderUploadRules";
import {
  parseGodownSheet, buildConsolidated, weeklyInputs, mondayOf, istToday, CONSOLIDATED_DAYS,
  type GodownProduct, type ConsolidatedRow, type ComponentNeed, type WeeklyRfqRow, type WeeklyComponentRow,
} from "@/lib/consolidatedStock";

const findSheet = (wb: XLSX.WorkBook, re: RegExp) => {
  const name = wb.SheetNames.find((n) => re.test(n.trim()));
  return name ? wb.Sheets[name] : undefined;
};
const rowsOf = (ws: XLSX.WorkSheet | undefined) => (ws ? XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, raw: true }) : []);

async function upsert(table: string, rows: Record<string, unknown>[], onConflict: string) {
  for (const part of chunk(rows, 500)) {
    const { error } = await supabasePublic.from(table).upsert(part, { onConflict });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

/** "Combined godown stock sheet as on DD.MM.YYYY.xlsx" → stock snapshot + daily movement. */
export async function uploadGodownWorkbook(file: File) {
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const fc = findSheet(wb, /^fc stock sheet$/i);
  if (!fc) throw new Error('No "FC Stock sheet" tab in this file — upload the Combined godown stock sheet.');
  const parsed = parseGodownSheet(rowsOf(fc), rowsOf(findSheet(wb, /^discontinued products$/i)));
  const now = new Date().toISOString();
  await upsert("barm_godown_stock", parsed.products.map((p) => ({
    snapshot_date: parsed.snapshotDate, product: p.product, current_stock: p.currentStock, inbound_shipped: p.inboundShipped,
    unfulfillable: p.unfulfillable, warehouse: p.warehouse, qc_godown: p.qcGodown, packing_godown: p.packingGodown,
    sku_rows: p.skuRows, discontinued: p.discontinued, uploaded_at: now,
  })), "snapshot_date,product");
  await upsert("barm_godown_daily", parsed.daily.map((d) => ({
    stock_date: d.date, product: d.product, opening: d.opening, stock_in: d.stockIn, stock_out: d.stockOut, closing: d.closing, uploaded_at: now,
  })), "stock_date,product");
  return { snapshotDate: parsed.snapshotDate, products: parsed.products.length, days: new Set(parsed.daily.map((d) => d.date)).size, warnings: parsed.warnings };
}

export interface WeeklySnapshotInfo {
  weekStart: string;                          // the Monday whose copy applies to the picked date
  status: "ok" | "missing" | "failed";
  capturedAt: string | null;
  error: string | null;
}

export interface ConsolidatedData {
  snapshotDate: string | null;
  uploadedAt: string | null;
  dates: string[];
  rows: ConsolidatedRow[];
  combos: ComponentNeed[];
  weekly: WeeklySnapshotInfo | null;
}

/** Selected columns of a table, paged (PostgREST caps a response at 1000 rows). */
async function readAll(table: string, columns: string, order: string[], filter: (q: any) => any = (q) => q): Promise<Record<string, unknown>[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += 1000) {
    let q = filter(supabasePublic.from(table).select(columns));
    for (const c of order) q = q.order(c, { ascending: true });
    const { data, error } = await q.range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as unknown as Record<string, unknown>[]));
    if (!data || data.length < 1000) return out;
  }
}

/** The Monday snapshot for `weekStart`. Missing or failed: no inputs at all, so the sheet never mixes
 *  current numbers into a week (the page and the Excel export say so). */
async function fetchWeeklyInputs(weekStart: string) {
  const { data: run, error } = await supabasePublic.from("barm_weekly_snapshot_runs")
    .select("status,captured_at,last_error").eq("week_start", weekStart).maybeSingle();
  // Unreadable (e.g. the snapshot tables are not set up yet): the sheet still loads, with the warning.
  if (error) return { inputs: [], combos: [], weekly: { weekStart, status: "failed", capturedAt: null, error: `snapshot unavailable: ${error.message}` } as WeeklySnapshotInfo };
  if (!run || run.status !== "ok") {
    return { inputs: [], combos: [], weekly: { weekStart, status: run ? "failed" : "missing", capturedAt: null, error: run?.last_error ?? null } as WeeklySnapshotInfo };
  }
  const byWeek = (q: any) => q.eq("week_start", weekStart); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [rfq, components] = await Promise.all([
    readAll("barm_weekly_rfq_snapshot", "product,stock_intransit,order_placed,suggested_rfq", ["product"], byWeek),
    readAll("barm_weekly_component_snapshot", "source_id,component,required_qty,component_stock", ["source_id"], byWeek),
  ]);
  const { inputs, combos } = weeklyInputs(rfq as unknown as WeeklyRfqRow[], components as unknown as WeeklyComponentRow[]);
  return { inputs, combos, weekly: { weekStart, status: "ok", capturedAt: run.captured_at, error: null } as WeeklySnapshotInfo };
}

/** barm_godown_daily rows before `from` with something shipped — date, product and Stock Out only. */
async function readShippedBefore(from: string): Promise<{ stock_date: string; product: string; stock_out: number }[]> {
  const base = () => supabasePublic.from("barm_godown_daily").select("stock_date,product,stock_out", { count: "exact" })
    .lt("stock_date", from).gt("stock_out", 0).order("stock_date").order("product");
  const first = await base().range(0, 999);
  if (first.error) throw new Error(`barm_godown_daily: ${first.error.message}`);
  const pages = Math.ceil((first.count ?? 0) / 1000);
  const rest: (typeof first.data)[] = [];
  for (let i = 1; i < pages; i += 8) {   // 8 pages at a time
    rest.push(...await Promise.all(Array.from({ length: Math.min(8, pages - i) }, async (_, j) => {
      const { data, error } = await base().range((i + j) * 1000, (i + j) * 1000 + 999);
      if (error) throw new Error(`barm_godown_daily: ${error.message}`);
      return data;
    })));
  }
  return [first.data ?? [], ...rest.map((d) => d ?? [])].flat() as { stock_date: string; product: string; stock_out: number }[];
}

/** The sheet as on `asOf` (the top bar's date; today in IST when empty): the last 10 godown days on
 *  or before it, current stock from the latest godown upload on or before it, and Stock Purchase /
 *  Components from that week's Monday snapshot. */
export async function fetchConsolidated(asOf?: string): Promise<ConsolidatedData> {
  const pick = async (before: boolean) => {
    let q = supabasePublic.from("barm_godown_stock").select("snapshot_date");
    if (asOf) q = before ? q.lte("snapshot_date", asOf) : q.gt("snapshot_date", asOf);
    const { data, error } = await q.order("snapshot_date", { ascending: !before }).limit(1);
    if (error) throw new Error(`barm_godown_stock: ${error.message}`);
    return (data?.[0]?.snapshot_date as string | undefined) ?? null;
  };
  // Stock from the latest upload on or before the date; a date before the first upload uses the next
  // upload (its sheet carries ~31 earlier days), and the page labels which date the stock is from.
  const snapshotDate = (await pick(true)) ?? (asOf ? await pick(false) : null);
  if (!snapshotDate) return { snapshotDate: null, uploadedAt: null, dates: [], rows: [], combos: [], weekly: null };
  // Days run up to the latest godown day on or before the picked date (a later upload can hold
  // days after this snapshot; a date past the last upload falls back to its last day).
  const { data: lastDay } = await supabasePublic.from("barm_godown_daily").select("stock_date")
    .lte("stock_date", asOf ?? snapshotDate).order("stock_date", { ascending: false }).limit(1);
  const to = lastDay?.[0]?.stock_date as string | undefined;
  if (!to) return { snapshotDate: null, uploadedAt: null, dates: [], rows: [], combos: [], weekly: null };
  const from = new Date(Date.parse(to + "T00:00:00Z") - 40 * 86_400_000).toISOString().slice(0, 10);
  const [stock, recent, older, live] = await Promise.all([
    fetchAllRows("barm_godown_stock", (q) => q.eq("snapshot_date", snapshotDate), "product"),
    fetchAllRows("barm_godown_daily", (q) => q.gte("stock_date", from).lte("stock_date", to), ["stock_date", "product"]),
    // Earlier days only matter for Peak sales, so only the days something shipped (all of history once
    // the file's older days are imported: ~80k rows, so its pages are read in parallel).
    readShippedBefore(from),
    fetchWeeklyInputs(mondayOf(asOf ?? istToday())),
  ]);
  const products: GodownProduct[] = stock.map((s) => ({
    product: s.product, currentStock: Number(s.current_stock) || 0, inboundShipped: Number(s.inbound_shipped) || 0,
    unfulfillable: Number(s.unfulfillable) || 0, warehouse: Number(s.warehouse) || 0, qcGodown: Number(s.qc_godown) || 0,
    packingGodown: Number(s.packing_godown) || 0, skuRows: Number(s.sku_rows) || 0, discontinued: !!s.discontinued,
  }));
  const { dates, rows } = buildConsolidated(
    products,
    // renamed products (src/lib/godownProductAliases.ts) count under their current name
    [...older, ...recent].map((d) => ({ date: d.stock_date, product: currentGodownName(d.product), stockOut: Number(d.stock_out) || 0 })),
    live.inputs,
    CONSOLIDATED_DAYS,
    live.combos,
  );
  return { snapshotDate, uploadedAt: stock[0]?.uploaded_at ?? null, dates, rows, combos: live.combos, weekly: live.weekly };
}
