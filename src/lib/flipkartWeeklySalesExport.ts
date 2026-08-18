import * as XLSX from "xlsx-js-style";
import { fetchAllRows } from "@/lib/amazonReportShared";
import { categorizeTitle, resolveProductName, CATEGORY_COLORS } from "@/lib/categoryMap";

// Flipkart's SKU-wise weekly report: last week vs this week, one row per SKU.
//
// Built from the FOUR Flipkart exports that are actually uploaded — Order
// report, Returns report, Listings snapshot and FSN (ad) report — and
// deliberately NOT from Earn More. That matters, because it changes what the
// revenue column can honestly claim:
//
//   Flipkart's order export carries NO monetary columns at all. There is no
//   per-order price, no line total, nothing. Only Earn More has real money on
//   it. So "Sales (Price x Orders)" here is a COMPUTED figure: the listing
//   price multiplied by units ordered. It is named that way in the header, on
//   purpose — calling it "Total Sales" would read as realised revenue, and it
//   isn't. It ignores per-order discounts, offers and settlement deductions,
//   so it runs high against what actually landed in the bank.
//
//   The same Price x units basis is what the Flipkart Analysis report already
//   uses for acos, and what the seller's own workbook uses, so the two agree.
//
// Amazon's equivalent (weeklySalesExport.ts) CAN report true revenue because
// Amazon's Orders export carries item_price. Don't copy this file's approach
// there.

interface PeriodWindow {
  label: string;
  start: string;
  end: string;
}

interface PeriodStats {
  orders: number;
  returns: number;
  totalOrders: number;
  price: number;
  computedSales: number;
  adSpendTax: number;
}

interface ProductRow {
  sku: string;
  name: string;
  periods: Record<string, PeriodStats>;
  grandComputedSales: number;
}

const GST_MULTIPLIER = 1.18;
const EXCLUDED_CATEGORIES = new Set(["Discontinued", "Other"]);

function fmtDot(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}
function weekLabel(start: string, end: string): string {
  return `${fmtDot(start)}-${fmtDot(end)}`;
}
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function buildFlipkartWeeklySalesWorkbook(opts: {
  thisWeek: { start: string; end: string };
  lastWeek: { start: string; end: string };
}) {
  const { thisWeek, lastWeek } = opts;
  const periods: PeriodWindow[] = [
    { label: weekLabel(lastWeek.start, lastWeek.end), start: lastWeek.start, end: lastWeek.end },
    { label: weekLabel(thisWeek.start, thisWeek.end), start: thisWeek.start, end: thisWeek.end },
  ];
  const periodForDate = (dayIso: string): PeriodWindow | undefined =>
    periods.find((p) => dayIso >= p.start && dayIso <= p.end);

  // One fetch across the combined 2-week span; each period is a filter over it.
  // Listings is a current snapshot with no date column, so it is fetched whole.
  const [orderRows, returnRows, listingRows, fsnRows] = await Promise.all([
    fetchAllRows("barm_flipkart_order_report", (q) => q.gte("order_date", lastWeek.start).lte("order_date", thisWeek.end)),
    fetchAllRows("barm_flipkart_returns", (q) =>
      q.gte("return_requested_date", lastWeek.start).lte("return_requested_date", thisWeek.end)
    ).catch(() => []),
    fetchAllRows("barm_flipkart_listings", (q) => q).catch(() => []),
    fetchAllRows("barm_flipkart_fsn_report", (q) => q.gte("report_date", lastWeek.start).lte("report_date", thisWeek.end)).catch(
      () => []
    ),
  ]);

  if (!orderRows.length) {
    throw new Error(
      `No uploaded Flipkart Order report data in ${fmtDot(lastWeek.start)} to ${fmtDot(thisWeek.end)}. ` +
        `Upload the Order report for that period first, or pick an end date the uploaded data covers.`
    );
  }

  // How far the uploaded orders actually reach. If they stop before the end of
  // "this week", the current week is measured over fewer days than the one it
  // is compared against, and every Growth % reads catastrophically negative for
  // no reason other than missing data. That is worth shouting about: a -84%
  // that is really "we only uploaded 2 of 7 days" would otherwise be read as a
  // collapse in demand.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orderDates = (orderRows as any[]).map((r) => String(r.order_date || "").slice(0, 10)).filter(Boolean).sort();
  const dataThrough = orderDates.length ? orderDates[orderDates.length - 1] : null;
  const staleDays = dataThrough
    ? Math.max(0, Math.round((Date.parse(`${thisWeek.end}T00:00:00Z`) - Date.parse(`${dataThrough}T00:00:00Z`)) / 86_400_000))
    : 0;

  // ── Listings snapshot: price, stock and the cleanest product title we have ──
  const priceBySku = new Map<string, number>();
  const stockBySku = new Map<string, number>();
  const nameBySku = new Map<string, string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (listingRows as any[]).forEach((r) => {
    const sku = String(r.seller_sku_id || "").trim();
    if (!sku) return;
    const price = num(r.selling_price);
    if (price > 0 && !priceBySku.has(sku)) priceBySku.set(sku, price);
    if (!stockBySku.has(sku)) stockBySku.set(sku, num(r.stock_count));
    if (r.product_title && !nameBySku.has(sku)) nameBySku.set(sku, String(r.product_title));
  });
  const hasListings = priceBySku.size > 0;

  // Order report titles fill in for SKUs the listings snapshot doesn't cover.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (orderRows as any[]).forEach((r) => {
    const sku = String(r.sku || "").trim();
    if (sku && r.product_title && !nameBySku.has(sku)) nameBySku.set(sku, String(r.product_title));
  });

  const statsBySkuPeriod = new Map<string, Map<string, { orders: number; returns: number; adSpendTax: number }>>();
  const ensureStat = (sku: string, label: string) => {
    let m = statsBySkuPeriod.get(sku);
    if (!m) { m = new Map(); statsBySkuPeriod.set(sku, m); }
    let s = m.get(label);
    if (!s) { s = { orders: 0, returns: 0, adSpendTax: 0 }; m.set(label, s); }
    return s;
  };

  // Orders — units, not order records, and cancelled lines excluded: a
  // cancelled order never sold, so counting it would inflate both Orders and
  // the computed sales figure. Same rule as the Flipkart Analysis report.
  const hasReturnsReport = returnRows.length > 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (orderRows as any[]).forEach((r) => {
    const sku = String(r.sku || "").trim();
    if (!sku || !r.order_date) return;
    const pd = periodForDate(String(r.order_date).slice(0, 10));
    if (!pd) return;
    const status = String(r.order_item_status || "").toUpperCase();
    if (status.startsWith("CANCEL")) return;
    const s = ensureStat(sku, pd.label);
    s.orders += num(r.quantity);
    // Without a Returns report the order report's own RETURNED status is the
    // only return signal there is; with one, returns come from it instead so
    // the same physical return isn't counted twice.
    if (!hasReturnsReport && status === "RETURNED") s.returns += num(r.quantity);
  });

  if (hasReturnsReport) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (returnRows as any[]).forEach((r) => {
      const sku = String(r.sku || "").trim();
      if (!sku || !r.return_requested_date) return;
      const pd = periodForDate(String(r.return_requested_date).slice(0, 10));
      if (!pd) return;
      ensureStat(sku, pd.label).returns += num(r.quantity);
    });
  }

  // Ad spend per SKU per week, from the FSN report. Spend+Tax applies the same
  // 18% GST the Analysis report and the seller's workbook use.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fsnRows as any[]).forEach((r) => {
    const sku = String(r.sku_id || "").trim();
    if (!sku || !r.report_date) return;
    const pd = periodForDate(String(r.report_date).slice(0, 10));
    if (!pd) return;
    ensureStat(sku, pd.label).adSpendTax += num(r.ad_spend) * GST_MULTIPLIER;
  });

  const products = new Map<string, ProductRow>();
  statsBySkuPeriod.forEach((periodMap, sku) => {
    const rawName = nameBySku.get(sku) || sku;
    const p: ProductRow = {
      sku,
      name: resolveProductName(rawName, sku) || rawName,
      periods: {},
      grandComputedSales: 0,
    };
    const price = priceBySku.get(sku) || 0;
    periods.forEach((pd) => {
      const raw = periodMap.get(pd.label);
      if (!raw) return;
      const totalOrders = Math.max(0, raw.orders - raw.returns);
      const computedSales = price * raw.orders;
      p.periods[pd.label] = {
        orders: raw.orders,
        returns: raw.returns,
        totalOrders,
        price,
        computedSales,
        adSpendTax: raw.adSpendTax,
      };
      p.grandComputedSales += computedSales;
    });
    products.set(sku, p);
  });

  const rows = [...products.values()].sort((a, b) => b.grandComputedSales - a.grandComputedSales);

  const catBySku = new Map<string, string>();
  const categoryRank = new Map<string, number>();
  {
    const catSales = new Map<string, number>();
    rows.forEach((p) => {
      const cat = categorizeTitle(p.name, undefined, p.sku);
      catBySku.set(p.sku, cat);
      catSales.set(cat, (catSales.get(cat) || 0) + p.grandComputedSales);
    });
    [...catSales.entries()].sort((a, b) => b[1] - a[1]).forEach(([name], i) => categoryRank.set(name, i));
  }

  const visibleRows = rows.filter((p) => !EXCLUDED_CATEGORIES.has(catBySku.get(p.sku) || "Other"));
  const rowsByCategory = [...visibleRows].sort((a, b) => {
    const ra = categoryRank.get(catBySku.get(a.sku) || "") ?? 999;
    const rb = categoryRank.get(catBySku.get(b.sku) || "") ?? 999;
    if (ra !== rb) return ra - rb;
    return b.grandComputedSales - a.grandComputedSales;
  });

  // ═══════════════════════════════════════════════════════════════════════
  // "Flipkart Sales" sheet — Product / SKU / Category, then 7 columns per week.
  // ═══════════════════════════════════════════════════════════════════════
  const COLS_PER_PERIOD = 7;
  const LEAD_COLS = 3;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const headerRow1: any[] = ["Product", "SKU", "Category"];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const headerRow2: any[] = ["", "", ""];
  periods.forEach(() => {
    headerRow1.push(...Array(COLS_PER_PERIOD).fill(""));
    headerRow2.push("Orders", "Returns", "Total Orders", "Price", "Sales (Price x Orders)", "Ad Spend+Tax", "Growth %");
  });
  periods.forEach((pd, i) => { headerRow1[LEAD_COLS + i * COLS_PER_PERIOD] = pd.label; });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aoa: any[][] = [headerRow1, headerRow2];
  const categoryChangeRows = new Set<number>();

  let prevCat: string | null = null;
  rowsByCategory.forEach((p) => {
    const cat = catBySku.get(p.sku) || "Other";
    if (cat !== prevCat) { categoryChangeRows.add(aoa.length); prevCat = cat; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rowData: any[] = [p.name, p.sku, cat];
    let prevSales: number | null = null;
    periods.forEach((pd) => {
      const stat = p.periods[pd.label];
      const orders = stat?.orders || 0;
      const returns = stat?.returns || 0;
      const totalOrders = stat?.totalOrders || 0;
      const price = stat?.price || 0;
      const sales = stat?.computedSales || 0;
      const adSpendTax = stat?.adSpendTax || 0;
      const growth = prevSales !== null && prevSales !== 0 ? (sales - prevSales) / prevSales : "";
      rowData.push(orders, returns, totalOrders, price, sales, adSpendTax, growth);
      prevSales = sales;
    });
    aoa.push(rowData);
  });

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const totalCols = LEAD_COLS + periods.length * COLS_PER_PERIOD;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const merges: any[] = [
    { s: { r: 0, c: 0 }, e: { r: 1, c: 0 } },
    { s: { r: 0, c: 1 }, e: { r: 1, c: 1 } },
    { s: { r: 0, c: 2 }, e: { r: 1, c: 2 } },
  ];
  periods.forEach((_, i) => {
    const c0 = LEAD_COLS + i * COLS_PER_PERIOD;
    merges.push({ s: { r: 0, c: c0 }, e: { r: 0, c: c0 + COLS_PER_PERIOD - 1 } });
  });
  ws["!merges"] = merges;

  for (let r = 0; r <= 1; r++) {
    for (let c = 0; c < totalCols; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (!ws[addr]) ws[addr] = { t: "s", v: "" };
      ws[addr].s = {
        font: { bold: true, color: { rgb: "FFFFFF" } },
        fill: { fgColor: { rgb: r === 0 ? "0F4C81" : "1D6FA5" } },
        alignment: { horizontal: "center", vertical: "center", wrapText: true },
        border: { bottom: { style: "medium", color: { rgb: "0B3A63" } } },
      };
    }
  }

  for (let r = 2; r < aoa.length; r++) {
    const isGroupStart = categoryChangeRows.has(r) && r > 2;
    for (let c = 0; c < totalCols; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (!cell) continue;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const style: any = {
        font: { color: { rgb: "1F2937" } },
        alignment: { vertical: "center" },
        border: {
          bottom: { style: "thin", color: { rgb: "E5E7EB" } },
          ...(isGroupStart ? { top: { style: "medium", color: { rgb: "BFDBFE" } } } : {}),
        },
      };

      if (c === 0) {
        style.font = { color: { rgb: "111827" }, bold: true };
      } else if (c === 1) {
        style.font = { color: { rgb: "1D4ED8" }, bold: true };
      } else if (c === 2) {
        const catColor = CATEGORY_COLORS[String(cell.v)] || CATEGORY_COLORS.Other;
        style.font = { color: { rgb: catColor.replace("#", "") }, bold: true };
      } else {
        const pos = (c - LEAD_COLS) % COLS_PER_PERIOD;
        if (pos === 3 || pos === 5) style.numFmt = "#,##0.00";       // Price, Ad Spend+Tax
        else if (pos === 4) {                                         // Sales (Price x Orders)
          style.numFmt = "#,##0.00";
          style.font = { color: { rgb: "059669" }, bold: true };
        } else if (pos === 6 && typeof cell.v === "number") {         // Growth %
          style.numFmt = "0.0%";
          if (cell.v > 0) style.font = { color: { rgb: "047857" }, bold: true };
          else if (cell.v < 0) style.font = { color: { rgb: "B91C1C" }, bold: true };
        } else {
          style.numFmt = "#,##0";
        }
      }
      cell.s = style;
    }
  }

  const wscols = [{ wch: 42 }, { wch: 22 }, { wch: 20 }];
  periods.forEach(() => {
    wscols.push({ wch: 9 }, { wch: 9 }, { wch: 12 }, { wch: 10 }, { wch: 20 }, { wch: 13 }, { wch: 10 });
  });
  ws["!cols"] = wscols;
  ws["!views"] = [{ state: "frozen", xSplit: 3, ySplit: 2 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Flipkart Sales");

  // ── Notes — states what each column is and, more importantly, what the sales
  //    figure is NOT, so nobody reconciles it against a settlement statement
  //    and concludes the report is wrong.
  const notes: string[][] = [
    ["Flipkart Weekly Sales Report (SKU-wise)"],
    [`Last week: ${fmtDot(lastWeek.start)} to ${fmtDot(lastWeek.end)}`],
    [`This week: ${fmtDot(thisWeek.start)} to ${fmtDot(thisWeek.end)}`],
    [""],
    ...(staleDays > 0
      ? [[`⚠ READ THIS FIRST — the uploaded Order report only reaches ${fmtDot(dataThrough!)}, but "this week" runs to ${fmtDot(thisWeek.end)}. So this week is measured over ${7 - staleDays} day(s) of data against a full 7 for last week, and EVERY Growth % below is therefore far more negative than reality. This is missing data, not falling demand. Either upload the newer Order report, or set the dashboard end date to ${fmtDot(dataThrough!)} and regenerate.`]]
      : []),
    ["Built entirely from uploaded Flipkart exports — the live API is never called. Sources: Order report (Orders), Returns report (Returns), Listings snapshot (Price), FSN report (Ad Spend+Tax)."],
    ["'Sales (Price x Orders)' is COMPUTED, not realised revenue. Flipkart's order export carries no monetary columns at all, so there is no per-order price to sum — only the Earn More report has real money on it, and it is not used here. This column multiplies the CURRENT listing price by units ordered, so it ignores per-order discounts, offers and settlement deductions and will read HIGH against what actually landed in the bank. Use it for week-over-week direction, not for accounting."],
    ["Growth % compares this week's 'Sales (Price x Orders)' against last week's. It is blank for the first week, which has nothing to compare against."],
    ["Orders = SUM OF UNITS ordered (quantity), not the number of order records. CANCELLED lines are excluded: they never sold, so counting them would inflate both Orders and the sales figure."],
    [hasReturnsReport
      ? "Returns come from the uploaded Returns report, by Return Requested Date — which is why a return can belong to an order placed before this window, and Returns can exceed Orders for a SKU."
      : "No Returns report uploaded for this window, so Returns fall back to the Order report's own RETURNED status. Upload the Returns report for a fuller picture (it tracks in-transit returns the order report still shows as pending)."],
    ["Total Orders = Orders - Returns."],
    [hasListings
      ? "Price and the sales figure come from the uploaded Listings snapshot. It is a CURRENT snapshot with no date column, so it is the price as of the upload, not necessarily the price during these weeks."
      : "⚠ NO Listings snapshot uploaded — Price reads 0 for every SKU, so 'Sales (Price x Orders)' and Growth % are 0 throughout and are NOT usable in this file. Upload the Listings export and regenerate."],
    ["Ad Spend+Tax = FSN report ad spend x 1.18 (18% GST), the same basis the Flipkart Analysis report uses."],
    ["Discontinued and uncategorised SKUs are excluded from the sheet."],
  ];
  const wsNotes = XLSX.utils.aoa_to_sheet(notes);
  wsNotes["!cols"] = [{ wch: 150 }];
  notes.forEach((_, i) => {
    const addr = XLSX.utils.encode_cell({ r: i, c: 0 });
    if (!wsNotes[addr]) return;
    wsNotes[addr].s = {
      font: { bold: i === 0, sz: i === 0 ? 13 : 10, color: { rgb: i === 0 ? "0F4C81" : "1F2937" } },
      alignment: { vertical: "top", wrapText: true },
    };
  });
  XLSX.utils.book_append_sheet(wb, wsNotes, "Notes");

  const filename = `Flipkart_Weekly_Sales_Report_${lastWeek.start}_to_${thisWeek.end}.xlsx`;
  return { wb, filename, skuCount: rows.length, hasListings, dataThrough, staleDays };
}

// Browser entry point (Flipkart Download page) — same "this week vs last week"
// windows as the Amazon report, sourced from the uploaded Flipkart tables.
// Client-side only; no API key needed.
export async function exportFlipkartWeeklySalesReport(opts?: { endDate?: string }) {
  const isoLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  let end = opts?.endDate;
  if (!end) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    end = isoLocal(d);
  }
  const endD = new Date(`${end}T00:00:00`);
  const thisStart = new Date(endD);
  thisStart.setDate(endD.getDate() - 6);
  const lastEnd = new Date(endD);
  lastEnd.setDate(endD.getDate() - 7);
  const lastStart = new Date(endD);
  lastStart.setDate(endD.getDate() - 13);

  const thisWeek = { start: isoLocal(thisStart), end };
  const lastWeek = { start: isoLocal(lastStart), end: isoLocal(lastEnd) };

  const { wb, filename, skuCount, hasListings, dataThrough, staleDays } = await buildFlipkartWeeklySalesWorkbook({ thisWeek, lastWeek });
  XLSX.writeFile(wb, filename);
  return { filename, thisWeek, lastWeek, skuCount, hasListings, dataThrough, staleDays };
}
