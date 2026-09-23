// supabase/functions/_shared/fbaForecastReportExport.ts
// Orchestrates the FBA Forecast Report: reads the raw ingestion tables
// (barm_fba_daily_sales, barm_fba_stock_snapshot, barm_fba_booked,
// barm_fba_intransit, barm_fba_recently_act), assigns zones, runs the pure
// calculation engine, and builds a fresh .xlsx workbook — the Edge
// Function equivalent of adSpendReportExport.ts's buildAdSpendReportWorkbook.
// See docs/superpowers/specs/2026-09-22-fba-forecast-refresh-design.md for
// the full design.
//
// This file does NOT filter the raw ingestion tables by report_date — they
// are always-latest snapshots maintained entirely by the upload pipeline
// (src/lib/fbaForecastUpload.ts), which already scoped each table's
// contents (30-day window, stock anchor date, month-sheet selection) to
// the report_date the user uploaded against. Only the GENERATED REPORT
// itself (this file's caller) is keyed by report_date.
//
// There is no manual shipment-cap input anywhere in this pipeline — "To Be
// Sent" and "Stock To Be Ordered" are the calculation engine's own
// already-computed need, surfaced directly (see fbaForecastCalc.ts).
import XLSX from "npm:xlsx-js-style@1.2.0";
import { fetchAllRows } from "./deps/amazonReportShared.ts";
import { fetchProductMarketingMap, buildProductMarketingResolver } from "./deps/productMarketingUpload.ts";
import { shipStateToZone, fcToZone } from "./fbaZones.ts";
import { computeFbaAnalysis, type SalesRow, type StockRow, type StatusRow, type FbaAnalysisRow, type StatusCategory } from "./fbaForecastCalc.ts";

interface RawSalesRow { purchase_date: string; product_name: string; sku: string; quantity: number; ship_state: string; }
interface RawStockRow { report_date: string; msku: string; ending_warehouse_balance: number; fulfillment_center: string; }
interface RawStatusRow { sku: string; quantity: number; fc: string; source_month: string; }

async function fetchRawData() {
  const [salesRaw, stockRaw, bookedRaw, intransitRaw, activeRaw] = await Promise.all([
    fetchAllRows("barm_fba_daily_sales", (q) => q) as Promise<RawSalesRow[]>,
    fetchAllRows("barm_fba_stock_snapshot", (q) => q) as Promise<RawStockRow[]>,
    fetchAllRows("barm_fba_booked", (q) => q) as Promise<RawStatusRow[]>,
    fetchAllRows("barm_fba_intransit", (q) => q) as Promise<RawStatusRow[]>,
    fetchAllRows("barm_fba_recently_act", (q) => q) as Promise<RawStatusRow[]>,
  ]);
  return { salesRaw, stockRaw, bookedRaw, intransitRaw, activeRaw };
}

export interface FbaForecastReportResult {
  wb: XLSX.WorkBook;
  skuCount: number;
  zoneCount: number;
  lowStockAlertCount: number;
}

export async function buildFbaForecastReportWorkbook(): Promise<FbaForecastReportResult> {
  const { salesRaw, stockRaw, bookedRaw, intransitRaw, activeRaw } = await fetchRawData();

  const salesRows: SalesRow[] = salesRaw.map((r) => ({ sku: r.sku, zone: shipStateToZone(r.ship_state), quantity: r.quantity }));
  const stockRows: StockRow[] = stockRaw.map((r) => ({ sku: r.msku, zone: fcToZone(r.fulfillment_center), quantity: r.ending_warehouse_balance }));
  // barm_fba_booked / barm_fba_intransit / barm_fba_recently_act are 3
  // separate tables (split at ingestion by STATUS), not one table with a
  // status_category column — tag each with its category here instead.
  const statusRows: StatusRow[] = [
    ...bookedRaw.map((r): StatusRow => ({ sku: r.sku, zone: fcToZone(r.fc), quantity: r.quantity, category: "booked" as StatusCategory })),
    ...intransitRaw.map((r): StatusRow => ({ sku: r.sku, zone: fcToZone(r.fc), quantity: r.quantity, category: "picked_up" as StatusCategory })),
    ...activeRaw.map((r): StatusRow => ({ sku: r.sku, zone: fcToZone(r.fc), quantity: r.quantity, category: "active" as StatusCategory })),
  ];

  // master_product_marketing first, per the app-wide convention (see
  // ppc-dashboard-master-product-marketing-table); falling back to the
  // product name captured on the SKU's own sales rows, then the SKU itself.
  const productNameBySku = new Map<string, string>();
  salesRaw.forEach((r) => { if (r.sku && r.product_name && !productNameBySku.has(r.sku)) productNameBySku.set(r.sku, r.product_name); });
  const marketingMap = await fetchProductMarketingMap();
  const marketingResolver = buildProductMarketingResolver(marketingMap);
  const resolveProductName = (sku: string) => marketingResolver.resolveName(sku, productNameBySku.get(sku) || sku);

  const rows = computeFbaAnalysis(salesRows, stockRows, statusRows, resolveProductName);

  const wb = XLSX.utils.book_new();
  addFbaAnalysisSheet(wb, rows);
  addRawSheet(wb, "30-Day Sales", ["Purchase Date", "Product Name", "SKU", "Quantity", "Ship State", "Zone"],
    salesRaw.map((r) => [r.purchase_date, r.product_name, r.sku, r.quantity, r.ship_state, shipStateToZone(r.ship_state)]));
  addRawSheet(wb, "FBA Stock", ["Report Date", "MSKU", "Fulfillment Center", "Zone", "Ending Warehouse Balance"],
    stockRaw.map((r) => [r.report_date, r.msku, r.fulfillment_center, fcToZone(r.fulfillment_center), r.ending_warehouse_balance]));
  addRawSheet(wb, "Booked", ["SKU", "FC", "Zone", "Quantity", "Source Month"],
    bookedRaw.map((r) => [r.sku, r.fc, fcToZone(r.fc), r.quantity, r.source_month]));
  addRawSheet(wb, "Intransit", ["SKU", "FC", "Zone", "Quantity", "Source Month"],
    intransitRaw.map((r) => [r.sku, r.fc, fcToZone(r.fc), r.quantity, r.source_month]));
  addRawSheet(wb, "Active", ["SKU", "FC", "Zone", "Quantity", "Source Month"],
    activeRaw.map((r) => [r.sku, r.fc, fcToZone(r.fc), r.quantity, r.source_month]));

  const skuCount = new Set(rows.map((r) => r.sku)).size;
  const zoneCount = new Set(rows.map((r) => r.zone)).size;
  const lowStockAlertCount = rows.filter((r) => r.daysUntilStockout !== "--" && r.daysUntilStockout <= 14).length;

  return { wb, skuCount, zoneCount, lowStockAlertCount };
}

const FBA_ANALYSIS_HEADERS: Array<[keyof FbaAnalysisRow, string]> = [
  ["sku", "SKU ID"], ["productName", "Product Name"], ["zone", "Zone"],
  ["sales30d", "30-Day Sales (Zone)"], ["dailyRate", "Daily Rate (Zone)"], ["forecast120dZone", "120-Day Forecast (Zone)"],
  ["totalOrders30dSku", "30-Day Orders (SKU Total)"], ["totalForecast120dSku", "120-Day Forecast (SKU Total)"],
  ["maxForecastPerProduct", "Max Forecast Per Product"], ["minStockNeededZone", "Minimum Stock Needed (Zone)"],
  ["salesPctRegion", "Sales % (Region)"], ["currentStockZone", "Current Stock (Zone)"], ["totalStockSku", "Current Stock (SKU Total)"],
  ["stockNeededZone", "Stock Needed (Zone)"], ["bookedZone", "Booked (Zone)"], ["intransitZone", "Intransit (Zone)"],
  ["bookedPlusIntransitZone", "Booked + Intransit (Zone)"], ["stockNeededAfterInboundZone", "Stock Needed After Inbound (Zone)"],
  ["totalStockNeededAfterInboundSku", "Stock Needed After Inbound (SKU Total)"], ["activeZoneAccumulated", "Active, Last 3 Months (Zone)"],
  ["toBeSentZone", "To Be Sent (Zone)"], ["stockToBeOrderedZone", "Stock To Be Ordered (SKU)"],
  ["daysUntilStockout", "Days Until Stockout (Zone)"],
];

function addFbaAnalysisSheet(wb: XLSX.WorkBook, rows: FbaAnalysisRow[]): void {
  const header = FBA_ANALYSIS_HEADERS.map(([, label]) => label);
  const body = rows.map((r) => FBA_ANALYSIS_HEADERS.map(([key]) => r[key]));
  const ws = XLSX.utils.aoa_to_sheet([header, ...body]);
  XLSX.utils.book_append_sheet(wb, ws, "FBA Analysis");
}

function addRawSheet(wb: XLSX.WorkBook, name: string, header: string[], body: unknown[][]): void {
  const ws = XLSX.utils.aoa_to_sheet([header, ...body]);
  XLSX.utils.book_append_sheet(wb, ws, name);
}
