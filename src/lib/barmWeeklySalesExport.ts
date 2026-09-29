import * as XLSX from "xlsx-js-style";
import { renderWeeklySalesWorkbook, weeklyPeriods, type WeeklyChannel } from "@/lib/weeklySalesExport";
import { loadBarmSkuPeriodData } from "@/lib/barmSkuPeriodData";
import { meeshoWeeklyWindows } from "@/lib/meeshoWeeklySalesExport";

// BARM Weekly Sales Report — the Amazon Weekly Sales Report's six sheets (Growth Summary,
// Category Breakdown, BARM Sales, Executive Dashboard, CEO Decision Center, Notes) fed with
// barm_online_orders data (barmSkuPeriodData.ts), same approach as the Meesho report.

const BARM_CHANNEL: WeeklyChannel = {
  name: "BARM",
  salesHeader: "Total Sales (Order Total Amount)",
  returnsTracked: false,
  listingCheck: "website listing and search visibility",
  pulledAtNote: (dataPulledAt) => `Data pulled at: ${dataPulledAt}.`,
  methodNotes: [
    "Source (Supabase): barm_online_orders — BARM website orders.",
    "Orders = units ordered, by Order Date. Only 'Received' orders count; rows whose shifted columns say 'cancelled' (Order Total Tax Amount) or 'RETURNED' (COD Fee) are skipped.",
    "Total Sales = Order Total Amount, counted once per order (it includes shipping). A single-product order's total is that product's sale. Multi-product orders can't be split without guessing, so each week's multi-product orders are summed into one 'Multi-product orders (not split)' row, with Price 0. Price = Total Sales ÷ Orders.",
    "All Returns / Customer Returns read 'Not tracked' — barm_online_orders has no returns data — so Total Orders = Orders.",
    "No stock or ad data exists for BARM, so the 'Low Stock' and 'Campaign Performance' reasons never appear. SKUs with no category are listed as 'Uncategorised' instead of being hidden.",
  ],
};

export async function buildBarmWeeklySalesWorkbook(opts: {
  thisWeek: { start: string; end: string };
  lastWeek: { start: string; end: string };
}) {
  const periods = weeklyPeriods(opts.thisWeek, opts.lastWeek);
  const data = await loadBarmSkuPeriodData({ periods });
  if (!data.visibleRows.length) {
    throw new Error(
      `No BARM orders in barm_online_orders for ${opts.lastWeek.start} to ${opts.thisWeek.end}. Pick an end date the table covers.`
    );
  }
  const built = renderWeeklySalesWorkbook({ ...opts, periods, data, channel: BARM_CHANNEL });
  return { ...built, skuCount: data.visibleRows.length };
}

// Browser entry point (BARM Download page). The selected end date is used as-is.
export async function exportBarmWeeklySalesReport(opts?: { endDate?: string }) {
  let end = opts?.endDate;
  if (!end) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    end = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  const { thisWeek, lastWeek } = meeshoWeeklyWindows(end);
  const { wb, filename, skuCount, dataThrough, staleDays } = await buildBarmWeeklySalesWorkbook({ thisWeek, lastWeek });
  XLSX.writeFile(wb, filename);
  return { filename, thisWeek, lastWeek, skuCount, dataThrough, staleDays };
}
