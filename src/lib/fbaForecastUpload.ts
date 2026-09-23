// Client-side upload functions for the FBA Forecast Report ingestion
// pipeline: parse and clean the 3 raw report types per the confirmed rules,
// then commit them to Supabase via the atomic RPC functions in
// scripts/fba_forecast_tables.sql. This is I/O + cleaning ONLY — no
// forecast/zone/stock-needed calculation happens here (that is a separate,
// explicitly out-of-scope concern for this feature).
//
// Two-phase design (parse-and-clean, then commit) so the Upload page can
// show a preview — total rows, rows that will be kept, and a breakdown of
// rejected-row reasons — before anything is written to Supabase.
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { supabasePublic } from "@/lib/amazonReportUpload";
import {
  classifyStatus,
  detectMonthSheets,
  parseMonthSheetGrid,
  dedupeByIdentityKey,
  fbfIdentityKey,
  cleanDailySalesRow,
  cleanStockSnapshotRow,
  selectStockSnapshotDate,
  parseUsSlashDate,
  type FbfRawRow,
  type DailySalesRejectReason,
  type StockSnapshotRejectReason,
} from "./fbaForecastRules";
import { runBatchedUpload, type BatchedUploadProgress } from "./batchedUpload";

// ── shared helpers ───────────────────────────────────────────────────────

interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

// No explicit `delimiter` option — Papa.parse auto-detects tab vs comma,
// which this feature relies on: the Amazon "All Orders" export
// (172537020718.txt-style) is TAB-delimited, while the FBA stock export
// (172544020718.csv-style) is comma-delimited. `transformHeader` also
// strips a leading UTF-8 BOM (`﻿`) — the stock export's own header
// row starts with one (`﻿Date,FNSKU,...`), which would otherwise
// silently rename the first header to "﻿Date" and fail the required-
// header check.
function parseCsvWithHeaders(file: File): Promise<ParsedCsv> {
  return new Promise((resolve, reject) => {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h: string) => h.replace(/^﻿/, "").trim(),
      complete: (results) => resolve({ headers: results.meta.fields || [], rows: results.data }),
      error: (err: Error) => reject(err),
    });
  });
}

function assertFileExtension(file: File, allowed: string[]): void {
  const lower = file.name.toLowerCase();
  if (!allowed.some((ext) => lower.endsWith(ext))) {
    throw new Error(`"${file.name}" doesn't look like the expected file type — expected one of: ${allowed.join(", ")}.`);
  }
}

function assertHeaders(headers: string[], required: string[], fileLabel: string): void {
  const missing = required.filter((h) => !headers.includes(h));
  if (missing.length) {
    throw new Error(`"${fileLabel}" is missing required column(s): ${missing.join(", ")}.`);
  }
}

export interface ParseCleanResult<Row> {
  cleanedRows: Row[];
  totalRows: number;
  rejectionReasons: Record<string, number>;
}

type UploadHistoryStatus = "success" | "failed" | "partial";

interface UploadHistoryInsert {
  file_name: string;
  target_table: string;
  rows_received: number;
  rows_accepted: number;
  rows_rejected: number;
  status: UploadHistoryStatus;
  rejection_reasons: Record<string, number>;
  error_message?: string;
}

async function recordUploadHistory(row: UploadHistoryInsert): Promise<void> {
  const { error } = await supabasePublic.from("upload_history").insert({
    file_name: row.file_name,
    target_table: row.target_table,
    uploaded_by: "",
    rows_received: row.rows_received,
    rows_accepted: row.rows_accepted,
    rows_rejected: row.rows_rejected,
    status: row.status,
    rejection_reasons: row.rejection_reasons,
    error_message: row.error_message ?? null,
  });
  if (error) throw new Error(`Recording upload_history for ${row.target_table} failed: ${error.message}`);
}

// upload_history is an audit trail, not the primary write — a failure to
// record it must never mask (or throw over) the real commit result.
async function recordUploadHistorySafe(row: UploadHistoryInsert): Promise<void> {
  try {
    await recordUploadHistory(row);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Failed to write upload_history row", err);
  }
}

// ── 1. Daily sales (barm_fba_daily_sales) ───────────────────────────────

const DAILY_SALES_REQUIRED_HEADERS = [
  "amazon-order-id",
  "purchase-date",
  "order-status",
  "fulfillment-channel",
  "product-name",
  "sku",
  "quantity",
  "ship-state",
];

export interface FbaDailySalesCleanedRow {
  purchase_date: string;
  fulfillment_channel: string;
  product_name: string;
  sku: string;
  quantity: number;
  ship_state: string;
}

/**
 * Phase 1: parse + clean the Amazon "All Orders" export — no DB write.
 * `reportDate` MUST be the dashboard's own selected date (`endDate` from
 * `useDashboard()`), never the server's real "today" — it anchors both the
 * "drop today's rows" rule and the trailing 30-day sales window. The
 * `purchase-date` column arrives as a full ISO-8601 timestamp with a UTC
 * offset (e.g. "2026-09-22T07:08:36+00:00") — `.slice(0, 10)` reads off
 * just the date part, same convention as `isoDateOnly` in
 * amazonReportUpload.ts.
 */
export async function parseAndCleanFbaSales30d(file: File, reportDate: string): Promise<ParseCleanResult<FbaDailySalesCleanedRow>> {
  assertFileExtension(file, [".csv", ".txt"]);
  const { headers, rows } = await parseCsvWithHeaders(file);
  assertHeaders(headers, DAILY_SALES_REQUIRED_HEADERS, file.name);

  const rejectionReasons: Record<string, number> = {};
  const cleanedRows: FbaDailySalesCleanedRow[] = [];

  for (const row of rows) {
    const purchaseDate = (row["purchase-date"] || "").trim().slice(0, 10);
    const result = cleanDailySalesRow(
      {
        amazonOrderId: (row["amazon-order-id"] || "").trim(),
        purchaseDate,
        orderStatus: (row["order-status"] || "").trim(),
        fulfillmentChannel: (row["fulfillment-channel"] || "").trim(),
      },
      reportDate
    );
    if (!result.keep) {
      const reason = result.reason as DailySalesRejectReason;
      rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1;
      continue;
    }
    const sku = (row["sku"] || "").trim();
    if (!sku || !purchaseDate) continue; // malformed row (no natural-key value) — silently excluded, not audited

    cleanedRows.push({
      purchase_date: purchaseDate,
      fulfillment_channel: (row["fulfillment-channel"] || "").trim(),
      product_name: (row["product-name"] || "").trim(),
      sku,
      quantity: Number(row["quantity"]) || 0,
      ship_state: (row["ship-state"] || "").trim(),
    });
  }

  return { cleanedRows, totalRows: rows.length, rejectionReasons };
}

const FBA_DAILY_SALES_BATCH_SIZE = 1000;

/**
 * Phase 2: stage the cleaned rows 1,000 at a time (sequentially) under one
 * upload session, then atomically swap them into barm_fba_daily_sales and
 * log the audit row. Sending the whole file in one request was dying in
 * transit ("Failed to fetch"). The swap happens only after every batch is
 * staged and the staged totals match, so barm_fba_daily_sales never holds
 * partial data — see scripts/fba_daily_sales_batched_upload.sql.
 */
export async function commitFbaSales30d(
  fileName: string,
  cleanedRows: FbaDailySalesCleanedRow[],
  totalRows: number,
  rejectionReasons: Record<string, number>,
  onProgress?: (p: BatchedUploadProgress) => void
): Promise<{ rowsAccepted: number }> {
  const targetTable = "barm_fba_daily_sales";
  const sessionId = crypto.randomUUID();
  try {
    await runBatchedUpload(cleanedRows, {
      batchSize: FBA_DAILY_SALES_BATCH_SIZE,
      onProgress,
      stageBatch: async (batchIndex, rows) => {
        const { data, error } = await supabasePublic.rpc("stage_barm_fba_daily_sales_batch", {
          p_session_id: sessionId,
          p_batch_index: batchIndex,
          rows,
        });
        if (error) throw new Error(error.message);
        return Number(data);
      },
      commit: async (expectedRows, expectedBatches) => {
        const { data, error } = await supabasePublic.rpc("commit_barm_fba_daily_sales_session", {
          p_session_id: sessionId,
          p_expected_rows: expectedRows,
          p_expected_batches: expectedBatches,
        });
        if (error) throw new Error(error.message);
        return Number(data);
      },
      // Only a successful commit deletes this session's staged rows.
      isSessionCommitted: async () => {
        const { count, error } = await supabasePublic
          .from("barm_fba_daily_sales_staging")
          .select("*", { count: "exact", head: true })
          .eq("session_id", sessionId);
        if (error) throw new Error(error.message);
        return count === 0;
      },
      discard: async () => {
        const { error } = await supabasePublic.rpc("discard_barm_fba_daily_sales_session", { p_session_id: sessionId });
        if (error) throw new Error(error.message);
      },
    });

    // Independent post-commit check, outside the commit transaction.
    const { count, error: countErr } = await supabasePublic.from(targetTable).select("*", { count: "exact", head: true });
    if (countErr) throw new Error(`Upload committed, but verifying the row count failed: ${countErr.message}`);
    if (count !== cleanedRows.length) {
      throw new Error(`Upload committed, but ${targetTable} has ${count} rows — expected ${cleanedRows.length}.`);
    }

    await recordUploadHistorySafe({
      file_name: fileName,
      target_table: targetTable,
      rows_received: totalRows,
      rows_accepted: cleanedRows.length,
      rows_rejected: totalRows - cleanedRows.length,
      status: "success",
      rejection_reasons: rejectionReasons,
    });
    return { rowsAccepted: cleanedRows.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordUploadHistorySafe({
      file_name: fileName,
      target_table: targetTable,
      rows_received: totalRows,
      rows_accepted: 0,
      rows_rejected: totalRows,
      status: "failed",
      rejection_reasons: rejectionReasons,
      error_message: message,
    });
    throw err;
  }
}

// ── 2. Stock snapshot (barm_fba_stock_snapshot) ─────────────────────────

const STOCK_SNAPSHOT_REQUIRED_HEADERS = ["Date", "FNSKU", "Fulfillment Center", "ASIN", "MSKU", "Disposition", "Ending Warehouse Balance"];

export interface FbaStockSnapshotCleanedRow {
  report_date: string;
  fnsku: string;
  fulfillment_center: string;
  asin: string;
  msku: string;
  disposition: string;
  ending_warehouse_balance: number;
}

/**
 * Phase 1: parse + clean the FBA stock (Custom Report Builder) export — no
 * DB write. `reportDate` MUST be the dashboard's own selected date, never
 * the server's real "today". The report's "anchor date" is the LATEST date
 * on file that is `<=` reportDate (see `selectStockSnapshotDate`), not
 * blindly the file's max date — a stock file can legitimately contain a
 * date after the report the user intends to generate. The "Date" column
 * arrives as US-style `MM/DD/YYYY` (e.g. "09/20/2026"), parsed via
 * `parseUsSlashDate` — a naive `.slice(0, 10)` would silently produce
 * garbage on this format (it is NOT already ISO).
 */
export async function parseAndCleanFbaStockSnapshot(file: File, reportDate: string): Promise<ParseCleanResult<FbaStockSnapshotCleanedRow>> {
  assertFileExtension(file, [".csv", ".txt"]);
  const { headers, rows } = await parseCsvWithHeaders(file);
  assertHeaders(headers, STOCK_SNAPSHOT_REQUIRED_HEADERS, file.name);

  const dates = rows.map((r) => parseUsSlashDate((r["Date"] || "").trim())).filter(Boolean);
  const anchorDate = selectStockSnapshotDate(dates, reportDate);

  const rejectionReasons: Record<string, number> = {};
  const cleanedRows: FbaStockSnapshotCleanedRow[] = [];

  for (const row of rows) {
    const rowDate = parseUsSlashDate((row["Date"] || "").trim());
    const result = cleanStockSnapshotRow(
      {
        reportDate: rowDate,
        fulfillmentCenter: (row["Fulfillment Center"] || "").trim(),
        disposition: (row["Disposition"] || "").trim(),
      },
      anchorDate
    );
    if (!result.keep) {
      const reason = result.reason as StockSnapshotRejectReason;
      rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1;
      continue;
    }
    const msku = (row["MSKU"] || "").trim();
    if (!msku) continue;

    cleanedRows.push({
      report_date: rowDate,
      fnsku: (row["FNSKU"] || "").trim(),
      fulfillment_center: (row["Fulfillment Center"] || "").trim(),
      asin: (row["ASIN"] || "").trim(),
      msku,
      disposition: (row["Disposition"] || "").trim(),
      ending_warehouse_balance: Number(row["Ending Warehouse Balance"]) || 0,
    });
  }

  return { cleanedRows, totalRows: rows.length, rejectionReasons };
}

/** Phase 2: atomically replace barm_fba_stock_snapshot via RPC, then log the audit row. */
export async function commitFbaStockSnapshot(
  fileName: string,
  cleanedRows: FbaStockSnapshotCleanedRow[],
  totalRows: number,
  rejectionReasons: Record<string, number>
): Promise<{ rowsAccepted: number }> {
  const targetTable = "barm_fba_stock_snapshot";
  try {
    const { error } = await supabasePublic.rpc("replace_barm_fba_stock_snapshot", { rows: cleanedRows });
    if (error) throw new Error(error.message);

    await recordUploadHistorySafe({
      file_name: fileName,
      target_table: targetTable,
      rows_received: totalRows,
      rows_accepted: cleanedRows.length,
      rows_rejected: totalRows - cleanedRows.length,
      status: "success",
      rejection_reasons: rejectionReasons,
    });
    return { rowsAccepted: cleanedRows.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordUploadHistorySafe({
      file_name: fileName,
      target_table: targetTable,
      rows_received: totalRows,
      rows_accepted: 0,
      rows_rejected: totalRows,
      status: "failed",
      rejection_reasons: rejectionReasons,
      error_message: message,
    });
    throw err;
  }
}

// ── 3. FBA & FBF Details workbook (barm_fba_booked / intransit / recently_act) ─

export interface FbfCleanedRow {
  source_month: string;
  product: string;
  sku: string;
  quantity: number;
  fc: string;
  booked_date: string | null;
  pickup_date: string | null;
  status_raw: string;
}

export interface ParsedFbfDetails {
  booked: FbfCleanedRow[];
  intransit: FbfCleanedRow[];
  recentlyAct: FbfCleanedRow[];
  monthsFound: string[];
  totalRows: number;
  rejectionReasons: Record<string, number>;
}

/**
 * Phase 1: parse + classify + de-dupe the FBA & FBF Details workbook — no
 * DB write. `reportDate` MUST be the dashboard's own selected date, never
 * the server's real "today" — it drives which 3 month-sheets are read
 * (current month + previous 2, relative to `reportDate`, via
 * `detectMonthSheets`'s injectable `asOf`).
 */
export async function parseAndCleanFbaFbfDetails(file: File, reportDate: string): Promise<ParsedFbfDetails> {
  assertFileExtension(file, [".xlsx", ".xls"]);
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const monthSheets = detectMonthSheets(wb.SheetNames, new Date(`${reportDate}T00:00:00Z`));
  if (monthSheets.length === 0) {
    throw new Error('No "FBA <MONTH><YY>" sheets found in this workbook (e.g. "FBA SEPT26").');
  }

  let totalRows = 0;
  const rejectionReasons: Record<string, number> = {};
  const bookedRaw: (FbfRawRow & { sourceMonth: string })[] = [];
  const intransitRaw: (FbfRawRow & { sourceMonth: string })[] = [];
  const activeRaw: (FbfRawRow & { sourceMonth: string })[] = [];

  for (const { sheetName, sourceMonth } of monthSheets) {
    const ws = wb.Sheets[sheetName];
    const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "", raw: true });
    const rawRows = parseMonthSheetGrid(grid);
    totalRows += rawRows.length;

    for (const r of rawRows) {
      const category = classifyStatus(r.statusRaw);
      if (!category) {
        rejectionReasons.unrecognized_status = (rejectionReasons.unrecognized_status || 0) + 1;
        continue;
      }
      const tagged = { ...r, sourceMonth };
      if (category === "booked") bookedRaw.push(tagged);
      else if (category === "picked_up") intransitRaw.push(tagged);
      else activeRaw.push(tagged);
    }
  }

  // De-dupe WITHIN each category across the combined month sheets — never
  // across categories (a SKU can legitimately be both booked and active for
  // different shipments). See fbfIdentityKey's doc comment for the accepted
  // blank-date limitation of this key.
  const bookedDeduped = dedupeByIdentityKey(bookedRaw, fbfIdentityKey);
  const intransitDeduped = dedupeByIdentityKey(intransitRaw, fbfIdentityKey);
  const activeDeduped = dedupeByIdentityKey(activeRaw, fbfIdentityKey);

  const toRow = (r: FbfRawRow & { sourceMonth: string }): FbfCleanedRow => ({
    source_month: r.sourceMonth,
    product: r.product,
    sku: r.sku,
    quantity: r.quantity,
    fc: r.fc,
    booked_date: r.bookedDate || null,
    pickup_date: r.pickupDate || null,
    status_raw: r.statusRaw,
  });

  return {
    booked: bookedDeduped.map(toRow),
    intransit: intransitDeduped.map(toRow),
    recentlyAct: activeDeduped.map(toRow),
    monthsFound: monthSheets.map((m) => m.sourceMonth),
    totalRows,
    rejectionReasons,
  };
}

/**
 * Phase 2: atomically replaces all 3 tables (barm_fba_booked,
 * barm_fba_intransit, barm_fba_recently_act) via ONE RPC call, then writes 3
 * upload_history rows (one per target table) — a single workbook upload is
 * really 3 independent table writes bundled into one user action.
 * `active_date` is stamped identically on every barm_fba_recently_act row
 * as `reportDate` — the dashboard's own selected date, NOT the server's
 * real "today" and NOT read from the file.
 */
export async function commitFbaFbfDetails(fileName: string, parsed: ParsedFbfDetails, reportDate: string): Promise<{ rowsAccepted: number }> {
  const recentlyActWithDate = parsed.recentlyAct.map((r) => ({ ...r, active_date: reportDate }));
  const totalAccepted = parsed.booked.length + parsed.intransit.length + parsed.recentlyAct.length;

  const logSuccess = () =>
    Promise.all([
      recordUploadHistorySafe({
        file_name: fileName,
        target_table: "barm_fba_booked",
        rows_received: parsed.totalRows,
        rows_accepted: parsed.booked.length,
        rows_rejected: parsed.totalRows - parsed.booked.length,
        status: "success",
        rejection_reasons: parsed.rejectionReasons,
      }),
      recordUploadHistorySafe({
        file_name: fileName,
        target_table: "barm_fba_intransit",
        rows_received: parsed.totalRows,
        rows_accepted: parsed.intransit.length,
        rows_rejected: parsed.totalRows - parsed.intransit.length,
        status: "success",
        rejection_reasons: parsed.rejectionReasons,
      }),
      recordUploadHistorySafe({
        file_name: fileName,
        target_table: "barm_fba_recently_act",
        rows_received: parsed.totalRows,
        rows_accepted: parsed.recentlyAct.length,
        rows_rejected: parsed.totalRows - parsed.recentlyAct.length,
        status: "success",
        rejection_reasons: parsed.rejectionReasons,
      }),
    ]);

  const logFailure = (message: string) =>
    Promise.all(
      (["barm_fba_booked", "barm_fba_intransit", "barm_fba_recently_act"] as const).map((targetTable) =>
        recordUploadHistorySafe({
          file_name: fileName,
          target_table: targetTable,
          rows_received: parsed.totalRows,
          rows_accepted: 0,
          rows_rejected: parsed.totalRows,
          status: "failed",
          rejection_reasons: parsed.rejectionReasons,
          error_message: message,
        })
      )
    );

  try {
    const { error } = await supabasePublic.rpc("replace_fba_fbf_details", {
      booked: parsed.booked,
      intransit: parsed.intransit,
      recently_act: recentlyActWithDate,
    });
    if (error) throw new Error(error.message);

    await logSuccess();
    return { rowsAccepted: totalAccepted };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logFailure(message);
    throw err;
  }
}

// ── "data on file" info for the upload cards ────────────────────────────

export interface FbaDataInfo {
  rowCount: number;
  maxDate: string | null;
}

async function fetchDataInfo(table: string, dateCol: string): Promise<FbaDataInfo> {
  const { count, error: countErr } = await supabasePublic.from(table).select("*", { count: "exact", head: true });
  if (countErr) return { rowCount: 0, maxDate: null };
  const { data, error: maxErr } = await supabasePublic.from(table).select(dateCol).order(dateCol, { ascending: false }).limit(1);
  const maxDate = !maxErr && data && data.length > 0 ? String((data[0] as unknown as Record<string, unknown>)[dateCol]).slice(0, 10) : null;
  return { rowCount: count || 0, maxDate };
}

export async function fetchFbaDailySalesInfo(): Promise<FbaDataInfo> {
  return fetchDataInfo("barm_fba_daily_sales", "purchase_date");
}

export async function fetchFbaStockSnapshotInfo(): Promise<FbaDataInfo> {
  return fetchDataInfo("barm_fba_stock_snapshot", "report_date");
}

export interface FbaFbfDetailsInfo {
  rowCount: number;
  monthsOnFile: string[];
}

export async function fetchFbaFbfDetailsInfo(): Promise<FbaFbfDetailsInfo> {
  const tables = ["barm_fba_booked", "barm_fba_intransit", "barm_fba_recently_act"] as const;
  const counts = await Promise.all(tables.map((t) => supabasePublic.from(t).select("*", { count: "exact", head: true })));
  const monthRows = await Promise.all(tables.map((t) => supabasePublic.from(t).select("source_month")));

  const months = new Set<string>();
  monthRows.forEach(({ data }) => (data || []).forEach((r) => months.add((r as Record<string, unknown>).source_month as string)));

  return {
    rowCount: counts.reduce((sum, { count }) => sum + (count || 0), 0),
    monthsOnFile: [...months].sort(),
  };
}

// ── Recent uploads audit panel ───────────────────────────────────────────

export interface UploadHistoryRow {
  upload_id: number;
  file_name: string;
  target_table: string;
  uploaded_at: string;
  rows_received: number;
  rows_accepted: number;
  rows_rejected: number;
  status: UploadHistoryStatus;
}

export async function fetchRecentUploadHistory(limit = 10): Promise<UploadHistoryRow[]> {
  const { data, error } = await supabasePublic
    .from("upload_history")
    .select("upload_id, file_name, target_table, uploaded_at, rows_received, rows_accepted, rows_rejected, status")
    .order("uploaded_at", { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data || []) as UploadHistoryRow[];
}
