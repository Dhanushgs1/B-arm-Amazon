import * as XLSX from "xlsx-js-style";
import { renderWeeklySalesWorkbook, weeklyPeriods, type WeeklyChannel } from "@/lib/weeklySalesExport";
import { loadMeeshoSkuPeriodData } from "@/lib/meeshoSkuPeriodData";

// Meesho Weekly Sales Report — calculated and laid out exactly like the Amazon Weekly Sales
// Report (the seller's instruction, 29 Sep 2026): same six sheets (Growth Summary, Category
// Breakdown, Meesho Sales, Executive Dashboard, CEO Decision Center, Notes) and the same formulas,
// by running Meesho's per-SKU data (meeshoSkuPeriodData.ts) through weeklySalesExport.ts's own
// sheet builder. The Meesho Sales sheet shows both Gross (Quantity × Supplier Listed Price) and
// Net (Price × Total Orders) sales; Growth % and every decision use Net.

const MEESHO_CHANNEL: WeeklyChannel = {
  name: "Meesho",
  grossSalesHeader: "Total Sales (Quantity × Supplier Listed Price)",
  salesHeader: "Net Sales (Price × Total Orders)",
  totalRow: true,
  revenueLabel: "Net Sales",
  listingCheck: "listing status and search visibility",
  pulledAtNote: (dataPulledAt) => `Data pulled at: ${dataPulledAt}.`,
  methodNotes: [
    "Sources (Supabase): meesho_barm_ord (Orders, Price), meesho_barm_return_intransit / _ofd / _delivered (Returns), barm_daily_ms_barm_ads (ad spend/clicks, used only for the 'Campaign Performance' reason).",
    "Orders = units ordered, by Order Date, every status except CANCELLED. meesho_barm_ord holds repeat loads of the same file, so each Sub Order No is counted once, at its latest status.",
    "All Returns = every return in the three return tables (in transit, out for delivery, delivered), each Suborder Number once, by Return Created Date — customer returns AND courier RTO. Customer Returns = only the 'Customer Return' type (courier RTO excluded).",
    "Total Orders = Orders − All Returns, floored at 0 per SKU (a return can land in a week with no matching order — the order belongs to an earlier week).",
    "GROSS vs NET: 'Total Sales (Quantity × Supplier Listed Price)' is GROSS — every non-cancelled order row's Quantity × Supplier Listed Price (Incl. GST + Commission), before returns. 'Net Sales (Price × Total Orders)' is NET — Price × Total Orders, i.e. after returns. Price = Gross ÷ Orders (average listed price per unit). The gap between the two is the value of the week's returns.",
    "Growth %, the health scores and every recommendation (Growth Summary, Category Breakdown, Executive Dashboard, CEO Decision Center) use NET sales; those sheets call it 'Net Sales' and show Gross alongside for reference.",
    "Meesho has no stock data here, so the 'Low Stock' reason never appears. Discontinued and uncategorised SKUs are excluded, as in the Amazon report.",
  ],
};

export function meeshoWeeklyWindows(end: string) {
  const isoLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const endD = new Date(`${end}T00:00:00`);
  const shift = (days: number) => { const d = new Date(endD); d.setDate(endD.getDate() - days); return isoLocal(d); };
  return { thisWeek: { start: shift(6), end }, lastWeek: { start: shift(13), end: shift(7) } };
}

export async function buildMeeshoWeeklySalesWorkbook(opts: {
  thisWeek: { start: string; end: string };
  lastWeek: { start: string; end: string };
}) {
  const periods = weeklyPeriods(opts.thisWeek, opts.lastWeek);
  const data = await loadMeeshoSkuPeriodData({ periods });
  if (!data.visibleRows.some((p) => Object.values(p.periods).some((s) => s.orders > 0))) {
    throw new Error(
      `No Meesho orders in meesho_barm_ord for ${opts.lastWeek.start} to ${opts.thisWeek.end}. Pick an end date the table covers.`
    );
  }
  const built = renderWeeklySalesWorkbook({ ...opts, periods, data, channel: MEESHO_CHANNEL });
  return { ...built, skuCount: data.visibleRows.length };
}

// Browser entry point (Meesho Download page). The selected end date is used as-is.
export async function exportMeeshoWeeklySalesReport(opts?: { endDate?: string }) {
  let end = opts?.endDate;
  if (!end) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    end = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  const { thisWeek, lastWeek } = meeshoWeeklyWindows(end);
  const { wb, filename, skuCount, dataThrough, staleDays } = await buildMeeshoWeeklySalesWorkbook({ thisWeek, lastWeek });
  XLSX.writeFile(wb, filename);
  return { filename, thisWeek, lastWeek, skuCount, dataThrough, staleDays };
}
