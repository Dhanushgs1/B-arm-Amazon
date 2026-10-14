// Uploads and reads for the Consolidated Stock Sheet (src/lib/consolidatedStock.ts).
//   barm_godown_stock    one row per master product per godown upload (snapshot_date = latest block)
//   barm_godown_daily    daily Stock Out etc. per product; re-uploading a date overwrites it
// Stock Purchase and Components are never read live. They come from whichever is newer for the picked
// date (user, 2026-10-14): the restock upload (the tool's "Stock Purchase Sheet.xlsx" /
// "Components Sheet.xlsx", given every Friday) or the weekly Monday 10:00 IST snapshot
// (supabase/migrations/20261013120000_barm_weekly_restock_snapshot.sql):
//   barm_restock_inputs              Stock Purchase Sheet upload, per product (snapshot_date = IST upload date)
//   barm_restock_component_inputs    Components Sheet upload, row for row
//   barm_weekly_snapshot_runs        one row per Monday: 'ok' / 'failed', when it was captured
//   barm_weekly_rfq_snapshot         product_forecast_rfq_v per product: in transit, order placed, Suggested RFQ
//   barm_weekly_component_snapshot   components_sheet rows: required qty, component stock

import * as XLSX from "xlsx";
import { supabasePublic } from "@/lib/amazonReportUpload";
import { fetchAllRows } from "@/lib/amazonReportShared";
import { currentGodownName } from "@/lib/godownProductAliases";
import { chunk } from "@/lib/amazonOrderUploadRules";
import {
  parseGodownSheet, buildConsolidated, weeklyInputs, mondayOf, istToday, parseRestockRows, newerRestockSource, CONSOLIDATED_DAYS,
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

/** Where one restock input came from (newest of the Friday upload and the Monday snapshot). */
export interface RestockSource { from: "snapshot" | "upload" | "none"; date: string | null; at: string | null }

export interface WeeklySnapshotInfo {
  weekStart: string;                          // the Monday whose copy applies to the picked date
  status: "ok" | "missing" | "failed";        // the snapshot's, or "ok" once both inputs have a source
  capturedAt: string | null;
  error: string | null;
  purchase: RestockSource;                    // in transit, order placed, Suggested RFQ
  components: RestockSource;                  // combo stock to buy
}

/** The tool's "Stock Purchase Sheet.xlsx" or "Components Sheet.xlsx" (told apart by headers). An upload
 *  replaces every row of today's (IST) date for that file. */
export async function uploadRestockWorkbook(file: File) {
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  let parsed: ReturnType<typeof parseRestockRows> | null = null, lastError: unknown = null;
  for (const name of wb.SheetNames) {
    try { parsed = parseRestockRows(rowsOf(wb.Sheets[name])); break; } catch (e) { lastError = e; }
  }
  if (!parsed) throw lastError instanceof Error ? lastError : new Error("Not a restock file.");
  const date = istToday(), now = new Date().toISOString();
  const table = parsed.kind === "purchase" ? "barm_restock_inputs" : "barm_restock_component_inputs";
  const { error } = await supabasePublic.from(table).delete().eq("snapshot_date", date);
  if (error) throw new Error(`${table}: ${error.message}`);
  if (parsed.kind === "purchase") {
    await upsert(table, parsed.rfq.map((r) => ({
      snapshot_date: date, product: r.product, stock_intransit: r.stock_intransit, order_placed: r.order_placed, purchase_qty: r.suggested_rfq, uploaded_at: now,
    })), "snapshot_date,product");
  } else {
    await upsert(table, parsed.components.map((c, i) => ({
      snapshot_date: date, row_no: i + 1, component: c.component, product: c.product, qty_per_unit: c.qty_per_unit, rfq: c.rfq,
      required_qty: c.required_qty, component_stock: c.component_stock, uploaded_at: now,
    })), "snapshot_date,row_no");
  }
  return { kind: parsed.kind, date, rows: parsed.kind === "purchase" ? parsed.rfq.length : parsed.components.length };
}

/** The latest upload of `table` on or before `asOf`: its date and when it was uploaded. */
async function latestUpload(table: string, asOf: string): Promise<{ date: string; uploadedAt: string } | null> {
  const { data, error } = await supabasePublic.from(table).select("snapshot_date,uploaded_at")
    .lte("snapshot_date", asOf).order("snapshot_date", { ascending: false }).order("uploaded_at", { ascending: false }).limit(1);
  if (error) return null; // unreadable: fall back to the snapshot
  return data?.[0] ? { date: data[0].snapshot_date as string, uploadedAt: data[0].uploaded_at as string } : null;
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
  if (error) return { rfq: [], components: [], snap: { weekStart, status: "failed" as const, capturedAt: null, error: `snapshot unavailable: ${error.message}` } };
  if (!run || run.status !== "ok") {
    return { rfq: [], components: [], snap: { weekStart, status: (run ? "failed" : "missing") as "failed" | "missing", capturedAt: null, error: (run?.last_error as string | null) ?? null } };
  }
  const byWeek = (q: any) => q.eq("week_start", weekStart); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [rfq, components] = await Promise.all([
    readAll("barm_weekly_rfq_snapshot", "product,stock_intransit,order_placed,suggested_rfq", ["product"], byWeek),
    readAll("barm_weekly_component_snapshot", "source_id,component,required_qty,component_stock", ["source_id"], byWeek),
  ]);
  return { rfq: rfq as unknown as WeeklyRfqRow[], components: components as unknown as WeeklyComponentRow[], snap: { weekStart, status: "ok" as const, capturedAt: run.captured_at as string, error: null } };
}

/** Restock inputs for `asOf`: per file, the newer of its latest upload (on or before the date) and the
 *  week's Monday snapshot (user, 2026-10-14). */
async function fetchRestockInputs(asOf: string) {
  const [{ rfq, components, snap }, upPurchase, upComponents] = await Promise.all([
    fetchWeeklyInputs(mondayOf(asOf)),
    latestUpload("barm_restock_inputs", asOf),
    latestUpload("barm_restock_component_inputs", asOf),
  ]);
  const snapRef = snap.status === "ok" ? { capturedAt: snap.capturedAt } : null;
  async function pick<T>(up: { date: string; uploadedAt: string } | null, snapRows: T[], read: (date: string) => Promise<T[]>): Promise<{ rows: T[]; source: RestockSource }> {
    const which = newerRestockSource(snapRef, up);
    if (which === "upload") return { rows: await read(up!.date), source: { from: "upload", date: up!.date, at: up!.uploadedAt } };
    if (which === "snapshot") return { rows: snapRows, source: { from: "snapshot", date: snap.weekStart, at: snap.capturedAt } };
    return { rows: [], source: { from: "none", date: null, at: null } };
  }
  const byDate = (date: string) => (q: any) => q.eq("snapshot_date", date); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [p, c] = await Promise.all([
    pick(upPurchase, rfq, async (date) => (await readAll("barm_restock_inputs", "product,stock_intransit,order_placed,purchase_qty", ["product"], byDate(date)))
      .map((r) => ({ product: String(r.product), stock_intransit: r.stock_intransit, order_placed: r.order_placed, suggested_rfq: r.purchase_qty }))),
    pick(upComponents, components, async (date) => (await readAll("barm_restock_component_inputs", "row_no,component,required_qty,component_stock", ["row_no"], byDate(date))) as unknown as WeeklyComponentRow[]),
  ]);
  const { inputs, combos } = weeklyInputs(p.rows, c.rows);
  const covered = p.source.from !== "none" && c.source.from !== "none";
  const weekly: WeeklySnapshotInfo = { ...snap, status: covered ? "ok" : snap.status, purchase: p.source, components: c.source };
  return { inputs, combos, weekly };
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
 *  Components from the newer of the restock upload and that week's Monday snapshot. */
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
    fetchRestockInputs(asOf ?? istToday()),
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
