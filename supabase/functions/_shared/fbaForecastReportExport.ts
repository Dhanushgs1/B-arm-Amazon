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
// The manual FBA analysis sheet is reference data, never an upload: its
// SKU × zone list is stored permanently in barm_fba_manual_plan, and column
// X (stock ready to send) is kept per SKU in barm_fba_sku_stock_to_send,
// edited on the FBA page. Together they drive the row list and the "to be
// sent" / "stock to be ordered" formulas exactly as in that sheet (see
// fbaForecastPlan.ts and fbaForecastCalc.ts).
import XLSX from "npm:xlsx-js-style@1.2.0";
import { fetchAllRows } from "./deps/amazonReportShared.ts";
import { fetchProductMarketingMap, buildProductMarketingResolver } from "./deps/productMarketingUpload.ts";
import { shipStateToZone, fcToZone } from "./fbaZones.ts";
import { computeFbaAnalysis, type SalesRow, type StockRow, type StatusRow, type StatusCategory } from "./fbaForecastCalc.ts";
import { buildPlan, type RawPlanRow, type RawSkuStockToSend } from "./fbaForecastPlan.ts";
import { buildFbaForecastLayout } from "./fbaForecastReportLayout.ts";

interface RawSalesRow { purchase_date: string; fulfillment_channel: string | null; product_name: string; sku: string; quantity: number; ship_state: string; }
interface RawStockRow { report_date: string; fnsku: string | null; asin: string | null; msku: string; disposition: string | null; ending_warehouse_balance: number; fulfillment_center: string; }
interface RawStatusRow { product: string | null; sku: string; quantity: number; fc: string; status_raw: string | null; booked_date: string | null; pickup_date: string | null; source_month: string; active_date?: string | null; }

async function fetchRawData() {
  const [salesRaw, stockRaw, bookedRaw, intransitRaw, activeRaw, planRaw, xRaw] = await Promise.all([
    fetchAllRows("barm_fba_daily_sales", (q) => q) as Promise<RawSalesRow[]>,
    fetchAllRows("barm_fba_stock_snapshot", (q) => q) as Promise<RawStockRow[]>,
    fetchAllRows("barm_fba_booked", (q) => q) as Promise<RawStatusRow[]>,
    fetchAllRows("barm_fba_intransit", (q) => q) as Promise<RawStatusRow[]>,
    fetchAllRows("barm_fba_recently_act", (q) => q) as Promise<RawStatusRow[]>,
    // Reference data: the manual sheet's permanent SKU × zone list, and the
    // latest saved column X per SKU (edited on the FBA page).
    fetchAllRows("barm_fba_manual_plan", (q) => q, ["row_order", "id"]) as Promise<RawPlanRow[]>,
    fetchAllRows("barm_fba_sku_stock_to_send", (q) => q, "sku") as Promise<RawSkuStockToSend[]>,
  ]);
  return { salesRaw, stockRaw, bookedRaw, intransitRaw, activeRaw, planRaw, xRaw };
}

export interface FbaForecastReportResult {
  wb: XLSX.WorkBook;
  skuCount: number;
  zoneCount: number;
  lowStockAlertCount: number;
}

/** `reportDate` is passed through to the layout only — the raw tables are
 *  never filtered by it (see the file comment above). */
export async function buildFbaForecastReportWorkbook(reportDate: string | null = null): Promise<FbaForecastReportResult> {
  const { salesRaw, stockRaw, bookedRaw, intransitRaw, activeRaw, planRaw, xRaw } = await fetchRawData();
  const plan = buildPlan(planRaw, xRaw);

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

  const rows = computeFbaAnalysis(salesRows, stockRows, statusRows, resolveProductName, plan);

  const zoneStatus = (r: RawStatusRow) => ({ ...r, zone: fcToZone(r.fc) });
  const wb = buildFbaForecastLayout({
    reportDate,
    rows,
    sales: salesRaw.map((r) => ({ ...r, zone: shipStateToZone(r.ship_state) })),
    stock: stockRaw.map((r) => ({ ...r, zone: fcToZone(r.fulfillment_center) })),
    booked: bookedRaw.map(zoneStatus),
    intransit: intransitRaw.map(zoneStatus),
    active: activeRaw.map(zoneStatus),
  });

  const skuCount = new Set(rows.map((r) => r.sku)).size;
  const zoneCount = new Set(rows.map((r) => r.zone)).size;
  const lowStockAlertCount = rows.filter((r) => r.daysUntilStockout !== "--" && r.daysUntilStockout <= 14).length;

  return { wb, skuCount, zoneCount, lowStockAlertCount };
}
