import * as XLSX from "xlsx-js-style";
import { renderWeeklySalesWorkbook, weeklyPeriods, type WeeklyChannel } from "@/lib/weeklySalesExport";
import { loadMeeshoSkuPeriodData } from "@/lib/meeshoSkuPeriodData";

// Meesho Weekly Sales Report — calculated and laid out exactly like the Amazon Weekly Sales
// Report (the seller's instruction, 29 Sep 2026): same six sheets (Growth Summary, Category
// Breakdown, Meesho Sales, Executive Dashboard, CEO Decision Center, Notes) and the same formulas —
// except Total Sales, which is Quantity × Supplier Listed Price per the seller —
// by running Meesho's per-SKU data (meeshoSkuPeriodData.ts) through weeklySalesExport.ts's own
// sheet builder.

const MEESHO_CHANNEL: WeeklyChannel = {
  name: "Meesho",
  salesHeader: "Total Sales (Quantity × Supplier Listed Price)",
  listingCheck: "listing status and search visibility",
  pulledAtNote: (dataPulledAt) => `Data pulled at: ${dataPulledAt}.`,
  methodNotes: [
    "Sources (Supabase): meesho_barm_ord (Orders, Price), meesho_barm_return_intransit / _ofd / _delivered (Returns), barm_daily_ms_barm_ads (ad spend/clicks, used only for the 'Campaign Performance' reason).",
    "Orders = units ordered, by Order Date, every status except CANCELLED. meesho_barm_ord holds repeat loads of the same file, so each Sub Order No is counted once, at its latest status.",
    "All Returns = every return in the three return tables (in transit, out for delivery, delivered), each Suborder Number once, by Return Created Date — customer returns AND courier RTO. Customer Returns = only the 'Customer Return' type (courier RTO excluded).",
    "Total Orders = Orders − All Returns, left UNCLAMPED — it can go negative for a SKU that had a return recorded this period with no matching order in it (the order belongs to an earlier period). Same rule as the Amazon report.",
    "Total Sales = Quantity × Supplier Listed Price (Incl. GST + Commission), summed over that week's non-cancelled order rows (the seller's rule — returns do NOT reduce it, unlike the Amazon report's Price × Total Orders). Price = Total Sales ÷ Orders. Growth % compares Total Sales week over week.",
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
