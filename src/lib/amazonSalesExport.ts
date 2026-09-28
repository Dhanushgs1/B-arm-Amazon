import * as XLSX from "xlsx-js-style";
import { CATEGORY_COLORS } from "@/lib/categoryMap";
import { buildPeriods, type SalesReportGranularity } from "@/lib/salesReportPeriods";
import { loadAmazonSkuPeriodData, EXCLUDED_CATEGORIES } from "@/lib/amazonSkuPeriodData";
export type { SalesReportGranularity };

function fmtDot(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

// Amazon-only sales report (Orders / All Returns / Customer Returns / Total Orders / Price / Total
// Sales / Growth % per SKU per period) — mirrors the layout of the legacy "REVENUE" workbook's
// Amazon Sales sheet, with the Flipkart column blocks dropped entirely. Ends with an auto-computed
// Top Losers / Top Gainers summary comparing the last two full periods — the legacy sheet's
// manually-typed reasons (negative reviews, competitor pressure) aren't derivable from the data, so
// only signals we can actually verify (low stock, a returns spike, a price drop) are surfaced.
//
// Sourced only from the app's synced MIS tables via loadAmazonSkuPeriodData — the same per-SKU
// figures as the Weekly Sales Report (IST day bucketing; returns = AM + FBA + SellerFlex; Total
// Orders = Orders − All Returns; Total Sales = Price × Total Orders; courier RTO excluded from
// Customer Returns). It used to call SellerMate live (get_retail_product_performance, which
// over-reports this account's sales ~1.7–2.2x, plus FBA-only returns bucketed by UTC day), and was
// ASIN-grain; it is now SKU-grain.
//
// Returns the workbook + filename without writing anything; callers decide whether to trigger a
// browser download (XLSX.writeFile) or turn it into a Buffer for an email attachment (XLSX.write).
export async function buildAmazonSalesWorkbook(opts: {
  startDate: string;
  endDate: string;
  granularity: SalesReportGranularity;
}) {
  const { startDate, endDate, granularity } = opts;

  // The selected range is used exactly as given — buildPeriods tiles [startDate, endDate] with no
  // widening or trimming. A selection too narrow to hold two full periods has no Growth Summary.
  const periods = buildPeriods(startDate, endDate, granularity);

  const {
    dataPulledAt, dataThrough, returnCoverageWarnings,
    visibleRows, rowsByCategory, catBySku, categoryAgg, stockOf,
  } = await loadAmazonSkuPeriodData({ periods, includeAds: false });

  // A period running past the last synced order day is measured over fewer days than its
  // neighbour, so its "decline" is missing data — keep it in the table but out of the comparison.
  if (dataThrough) periods.forEach((pd) => { if (pd.end > dataThrough) pd.isFull = false; });

  // ── Build the main data sheet ──
  // Column 0 = Product, column 1 = SKU, column 2 = Category (department), then 7 columns per
  // period (Orders, All Returns, Customer Returns, Total Orders, Price, Total Sales, Growth %).
  // All Returns is every AM + FBA + SellerFlex return; Customer Returns excludes courier RTO /
  // undeliverable / rejected parcels — Total Orders subtracts All Returns, since an RTO'd order
  // never became a real sale either. Rows are grouped by department
  // (rowsByCategory) so the sheet reads "category-wise" while staying at full product/SKU granularity.
  const COLS_PER_PERIOD = 7;
  const LEAD_COLS = 3; // Product, SKU, Category
  const headerRow1: any[] = ["Product", "SKU", "Category"];
  const headerRow2: any[] = ["", "", ""];
  periods.forEach(() => {
    headerRow1.push(...Array(COLS_PER_PERIOD).fill(""));
    headerRow2.push("Orders", "All Returns", "Customer Returns", "Total Orders", "Price", "Total Sales", "Growth %");
  });
  periods.forEach((pd, i) => {
    headerRow1[LEAD_COLS + i * COLS_PER_PERIOD] = pd.label;
  });

  const aoa: any[][] = [headerRow1, headerRow2];
  const categoryChangeRows = new Set<number>(); // aoa row indices where a new department group starts

  let prevCat: string | null = null;
  rowsByCategory.forEach((p) => {
    const cat = catBySku.get(p.sku) || "Other";
    if (cat !== prevCat) { categoryChangeRows.add(aoa.length); prevCat = cat; }
    const rowData: any[] = [p.name, p.sku, cat];
    let prevTotalSales: number | null = null;
    periods.forEach((pd) => {
      const stat = p.periods[pd.label];
      const orders = stat?.orders || 0;
      const allReturns = stat?.allReturns || 0;
      const returns = stat?.returns || 0;
      const totalOrders = stat?.totalOrders || 0;
      const price = stat?.price || 0;
      const totalSales = stat?.totalSales || 0;
      const growth = prevTotalSales !== null && prevTotalSales !== 0 ? (totalSales - prevTotalSales) / prevTotalSales : "";
      rowData.push(orders, allReturns, returns, totalOrders, price, totalSales, growth);
      prevTotalSales = totalSales;
    });
    aoa.push(rowData);
  });

  const dataRowCount = aoa.length - 2;
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const totalCols = LEAD_COLS + periods.length * COLS_PER_PERIOD;

  const merges: any[] = [
    { s: { r: 0, c: 0 }, e: { r: 1, c: 0 } },
    { s: { r: 0, c: 1 }, e: { r: 1, c: 1 } },
    { s: { r: 0, c: 2 }, e: { r: 1, c: 2 } },
  ];
  periods.forEach((_, i) => {
    const c0 = LEAD_COLS + i * COLS_PER_PERIOD;
    merges.push({ s: { r: 0, c: c0 }, e: { r: 0, c: c0 + COLS_PER_PERIOD - 1 } });
  });

  for (let r = 0; r <= 1; r++) {
    for (let c = 0; c < totalCols; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (!ws[addr]) ws[addr] = { t: "s", v: "" };
      ws[addr].s = {
        font: { bold: true, color: { rgb: "FFFFFF" } },
        fill: { fgColor: { rgb: r === 0 ? "312E81" : "4F46E5" } },
        alignment: { horizontal: "center", vertical: "center" },
        border: { bottom: { style: "medium", color: { rgb: "1E1B4B" } } },
      };
    }
  }

  for (let r = 2; r < aoa.length; r++) {
    // A thicker top border marks where one department's group of rows ends and the next begins.
    const isGroupStart = categoryChangeRows.has(r) && r > 2;
    for (let c = 0; c < totalCols; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (!cell) continue;

      let style: any = {
        font: { color: { rgb: "1F2937" } },
        alignment: { vertical: "center" },
        border: {
          bottom: { style: "thin", color: { rgb: "E5E7EB" } },
          ...(isGroupStart ? { top: { style: "medium", color: { rgb: "C7D2FE" } } } : {}),
        },
      };

      if (c === 0) {
        style.font = { color: { rgb: "111827" }, bold: true };
      } else if (c === 1) {
        style.font = { color: { rgb: "4338CA" }, bold: true };
      } else if (c === 2) {
        const catColor = CATEGORY_COLORS[String(cell.v)] || CATEGORY_COLORS.Other;
        style.font = { color: { rgb: catColor.replace("#", "") }, bold: true };
      } else {
        const posInPeriod = (c - LEAD_COLS) % COLS_PER_PERIOD;
        if (posInPeriod === 4) style.numFmt = "#,##0.00"; // Price
        if (posInPeriod === 5) {
          style.numFmt = "#,##0.00"; // Total Sales
          style.font = { color: { rgb: "059669" }, bold: true };
        }
        if (posInPeriod === 6 && typeof cell.v === "number") {
          style.numFmt = "0.0%";
          if (cell.v > 0) style.font = { color: { rgb: "047857" }, bold: true };
          else if (cell.v < 0) style.font = { color: { rgb: "B91C1C" }, bold: true };
        }
      }
      cell.s = style;
    }
  }

  const wscols = [{ wch: 42 }, { wch: 16 }, { wch: 20 }];
  periods.forEach(() => {
    wscols.push({ wch: 10 }, { wch: 11 }, { wch: 15 }, { wch: 12 }, { wch: 10 }, { wch: 13 }, { wch: 10 });
  });
  ws["!cols"] = wscols;
  ws["!views"] = [{ state: "frozen", xSplit: 3, ySplit: 2 }];

  const wb = XLSX.utils.book_new();

  // ── Growth summary: Top Losers / Top Gainers comparing the last two FULL periods ──
  // A trailing period clipped short by the selected end date (e.g. a 2-day "week" at the
  // end of the range) would otherwise look like a fake ~80% decline against a full-length
  // neighbour, so we walk back to the last pair of periods that are both full-length.
  let cmpEnd = periods.length - 1;
  while (cmpEnd > 0 && !(periods[cmpEnd].isFull && periods[cmpEnd - 1].isFull)) cmpEnd--;

  if (cmpEnd > 0) {
    const lastLabel = periods[cmpEnd].label;
    const prevLabel = periods[cmpEnd - 1].label;

    type Delta = { name: string; sku: string; units: number; price: number; delta: number; pct: number; reason: string; category: string };
    const deltas: Delta[] = visibleRows
      .map((p) => {
        const last = p.periods[lastLabel];
        const prev = p.periods[prevLabel];
        if (!last && !prev) return null;
        const lastSales = last?.totalSales || 0;
        const prevSales = prev?.totalSales || 0;
        if (lastSales === 0 && prevSales === 0) return null;
        const delta = lastSales - prevSales;
        const pct = prevSales !== 0 ? delta / prevSales : lastSales > 0 ? 1 : 0;
        const stock = stockOf(p.sku);
        const returnsJump = (last?.returns || 0) - (prev?.returns || 0);
        const priceDropPct = prev?.price ? (last?.price || 0) / prev.price - 1 : 0;
        let reason = "";
        if (delta < 0) {
          if (stock !== undefined && stock < 15) reason = `Low stock (${stock} units on hand) — check replenishment`;
          else if (returnsJump >= 3) reason = `Returns jumped by ${returnsJump} vs previous period`;
        } else if (delta > 0) {
          if (priceDropPct <= -0.05) reason = `Price dropped ${Math.abs(priceDropPct * 100).toFixed(0)}% — likely drove growth`;
        }
        // Units Sold / Price reflect the latest period (lastLabel) — the current snapshot the
        // Δ columns are measured against.
        const units = last?.orders || 0;
        const price = last?.price || 0;
        return { name: p.name, sku: p.sku, units, price, delta, pct, reason, category: catBySku.get(p.sku) || "Other" };
      })
      .filter((d): d is Delta => d !== null);

    const TOP_N = 5;

    // Category order matches Category Breakdown (highest-selling department first); only
    // categories that actually have a comparable product get a section.
    const categoriesInOrder = [...categoryAgg.entries()]
      .filter(([name]) => !EXCLUDED_CATEGORIES.has(name))
      .sort((a, b) => b[1].grandSales - a[1].grandSales)
      .map(([name]) => name)
      .filter((name) => deltas.some((d) => d.category === name));

    const sAoA: any[][] = [[`Growth Summary — ${lastLabel} vs ${prevLabel}`, "", "", "", "", "", ""], []];
    const catHeaderRows: { row: number; color: string }[] = [];
    const lossHeaderRows: number[] = [];
    const gainHeaderRows: number[] = [];

    categoriesInOrder.forEach((cat) => {
      const catDeltas = deltas.filter((d) => d.category === cat);
      const losers = catDeltas.filter((d) => d.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, TOP_N);
      const gainers = catDeltas.filter((d) => d.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, TOP_N);
      if (losers.length === 0 && gainers.length === 0) return;

      catHeaderRows.push({ row: sAoA.length, color: CATEGORY_COLORS[cat] || CATEGORY_COLORS.Other });
      sAoA.push([cat, "", "", "", "", "", ""]);

      lossHeaderRows.push(sAoA.length);
      sAoA.push(["Top 5 Worst", "SKU", "Units Sold", "Price", "Δ Sales", "Δ %", "Possible Reason (add your own note if blank)"]);
      if (losers.length > 0) losers.forEach((d) => sAoA.push([d.name, d.sku, d.units, d.price, d.delta, d.pct, d.reason]));
      else sAoA.push(["No decline this period", "", "", "", "", "", ""]);
      sAoA.push([]);

      gainHeaderRows.push(sAoA.length);
      sAoA.push(["Top 5 Best", "SKU", "Units Sold", "Price", "Δ Sales", "Δ %", "Possible Reason (add your own note if blank)"]);
      if (gainers.length > 0) gainers.forEach((d) => sAoA.push([d.name, d.sku, d.units, d.price, d.delta, d.pct, d.reason]));
      else sAoA.push(["No growth this period", "", "", "", "", "", ""]);
      sAoA.push([]);
    });

    const wsSummary = XLSX.utils.aoa_to_sheet(sAoA);
    wsSummary["!merges"] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 6 } },
      ...catHeaderRows.map((h) => ({ s: { r: h.row, c: 0 }, e: { r: h.row, c: 6 } })),
    ];
    wsSummary["!cols"] = [{ wch: 45 }, { wch: 16 }, { wch: 11 }, { wch: 11 }, { wch: 14 }, { wch: 10 }, { wch: 50 }];

    const titleCell = wsSummary[XLSX.utils.encode_cell({ r: 0, c: 0 })];
    if (titleCell) titleCell.s = { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "111827" } }, alignment: { horizontal: "center" } };

    catHeaderRows.forEach(({ row, color }) => {
      for (let c = 0; c < 7; c++) {
        const addr = XLSX.utils.encode_cell({ r: row, c });
        if (!wsSummary[addr]) wsSummary[addr] = { t: "s", v: "" };
        wsSummary[addr].s = {
          font: { bold: true, color: { rgb: "FFFFFF" } },
          fill: { fgColor: { rgb: color.replace("#", "") } },
          alignment: { horizontal: "center" },
        };
      }
    });

    const lossHeaderSet = new Set(lossHeaderRows);
    [...lossHeaderRows, ...gainHeaderRows].forEach((headerRowIdx) => {
      for (let c = 0; c < 7; c++) {
        const addr = XLSX.utils.encode_cell({ r: headerRowIdx, c });
        const cell = wsSummary[addr];
        if (!cell) continue;
        const isLossHeader = lossHeaderSet.has(headerRowIdx);
        cell.s = {
          font: { bold: true, color: { rgb: "FFFFFF" } },
          fill: { fgColor: { rgb: isLossHeader ? "B91C1C" : "047857" } },
          alignment: { horizontal: "center" },
        };
      }
    });

    for (let r = 0; r < sAoA.length; r++) {
      // Units Sold (2) / Price (3): plain formatting, no sign-based coloring.
      const unitsAddr = XLSX.utils.encode_cell({ r, c: 2 });
      if (wsSummary[unitsAddr] && typeof wsSummary[unitsAddr].v === "number") {
        wsSummary[unitsAddr].s = { numFmt: "#,##0", font: { color: { rgb: "1F2937" } } };
      }
      const priceAddr = XLSX.utils.encode_cell({ r, c: 3 });
      if (wsSummary[priceAddr] && typeof wsSummary[priceAddr].v === "number") {
        wsSummary[priceAddr].s = { numFmt: "#,##0.00", font: { color: { rgb: "1F2937" } } };
      }
      // Δ Sales (4) / Δ % (5): colored red/green by sign, as before.
      for (let c = 4; c <= 5; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = wsSummary[addr];
        if (!cell || typeof cell.v !== "number") continue;
        cell.s = { numFmt: c === 4 ? "#,##0.00" : "0.0%", font: { color: { rgb: cell.v < 0 ? "B91C1C" : "047857" }, bold: true } };
      }
    }

    XLSX.utils.book_append_sheet(wb, wsSummary, "Growth Summary");
  } else {
    const wsNote = XLSX.utils.aoa_to_sheet([
      ["Growth Summary unavailable"],
      [`The selected date range doesn't contain two full, equal-length ${granularity === "daily" ? "days" : granularity === "weekly" ? "weeks" : "months"} to compare — pick a wider range to see Top Losers/Gainers.`],
    ]);
    wsNote["!cols"] = [{ wch: 90 }];
    XLSX.utils.book_append_sheet(wb, wsNote, "Growth Summary");
  }

  // ── Category Breakdown sheet — one row per department, columns mirror the main sheet's
  // period layout (Sales / Units / Growth %) plus range totals and each department's share
  // of overall sales. ──
  {
    const catRows = [...categoryAgg.entries()]
      .filter(([name]) => !EXCLUDED_CATEGORIES.has(name))
      .sort((a, b) => b[1].grandSales - a[1].grandSales);
    const grandAllSales = catRows.reduce((a, [, v]) => a + v.grandSales, 0);
    const grandAllUnits = catRows.reduce((a, [, v]) => a + v.grandUnits, 0);

    const CAT_COLS_PER_PERIOD = 3; // Sales, Units, Growth %
    const catHeader1: any[] = ["Category"];
    const catHeader2: any[] = [""];
    periods.forEach(() => {
      catHeader1.push(...Array(CAT_COLS_PER_PERIOD).fill(""));
      catHeader2.push("Sales", "Units", "Growth %");
    });
    periods.forEach((pd, i) => { catHeader1[1 + i * CAT_COLS_PER_PERIOD] = pd.label; });
    catHeader1.push("", "", "");
    catHeader2.push("Total Sales", "Total Units", "Share %");

    const catAoa: any[][] = [catHeader1, catHeader2];
    catRows.forEach(([name, v]) => {
      const rowData: any[] = [name];
      let prevSales: number | null = null;
      periods.forEach((pd) => {
        const stat = v.periods[pd.label];
        const sales = stat?.sales || 0;
        const units = stat?.units || 0;
        const growth = prevSales !== null && prevSales !== 0 ? (sales - prevSales) / prevSales : "";
        rowData.push(sales, units, growth);
        prevSales = sales;
      });
      rowData.push(v.grandSales, v.grandUnits, grandAllSales ? v.grandSales / grandAllSales : 0);
      catAoa.push(rowData);
    });

    const totalRow: any[] = ["TOTAL (All Categories)"];
    let prevTotalPeriodSales: number | null = null;
    periods.forEach((pd) => {
      const sales = catRows.reduce((a, [, v]) => a + (v.periods[pd.label]?.sales || 0), 0);
      const units = catRows.reduce((a, [, v]) => a + (v.periods[pd.label]?.units || 0), 0);
      const growth = prevTotalPeriodSales !== null && prevTotalPeriodSales !== 0 ? (sales - prevTotalPeriodSales) / prevTotalPeriodSales : "";
      totalRow.push(sales, units, growth);
      prevTotalPeriodSales = sales;
    });
    totalRow.push(grandAllSales, grandAllUnits, 1);
    catAoa.push(totalRow);

    const wsCat = XLSX.utils.aoa_to_sheet(catAoa);
    const catTotalCols = 1 + periods.length * CAT_COLS_PER_PERIOD + 3;

    const catMerges: any[] = [{ s: { r: 0, c: 0 }, e: { r: 1, c: 0 } }];
    periods.forEach((_, i) => {
      const c0 = 1 + i * CAT_COLS_PER_PERIOD;
      catMerges.push({ s: { r: 0, c: c0 }, e: { r: 0, c: c0 + CAT_COLS_PER_PERIOD - 1 } });
    });
    const totalsC0 = 1 + periods.length * CAT_COLS_PER_PERIOD;
    catMerges.push({ s: { r: 0, c: totalsC0 }, e: { r: 0, c: totalsC0 + 2 } });
    wsCat["!merges"] = catMerges;
    if (catHeader1[totalsC0] === "") wsCat[XLSX.utils.encode_cell({ r: 0, c: totalsC0 })] = { t: "s", v: "Totals" };

    for (let r = 0; r <= 1; r++) {
      for (let c = 0; c < catTotalCols; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        if (!wsCat[addr]) wsCat[addr] = { t: "s", v: "" };
        wsCat[addr].s = {
          font: { bold: true, color: { rgb: "FFFFFF" } },
          fill: { fgColor: { rgb: r === 0 ? "312E81" : "4F46E5" } },
          alignment: { horizontal: "center", vertical: "center" },
          border: { bottom: { style: "medium", color: { rgb: "1E1B4B" } } },
        };
      }
    }

    for (let r = 2; r < catAoa.length; r++) {
      const isTotalRow = r === catAoa.length - 1;
      for (let c = 0; c < catTotalCols; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = wsCat[addr];
        if (!cell) continue;

        let style: any = {
          font: { color: { rgb: "1F2937" }, bold: isTotalRow },
          alignment: { vertical: "center" },
          border: { bottom: { style: isTotalRow ? "medium" : "thin", color: { rgb: isTotalRow ? "312E81" : "E5E7EB" } } },
        };

        if (c === 0) {
          style.font = { color: { rgb: "111827" }, bold: true };
        } else if (c < 1 + periods.length * CAT_COLS_PER_PERIOD) {
          const posInPeriod = (c - 1) % CAT_COLS_PER_PERIOD;
          if (posInPeriod === 0) { style.numFmt = "#,##0.00"; style.font = { color: { rgb: "059669" }, bold: true }; }
          if (posInPeriod === 1) style.numFmt = "#,##0";
          if (posInPeriod === 2 && typeof cell.v === "number") {
            style.numFmt = "0.0%";
            if (cell.v > 0) style.font = { color: { rgb: "047857" }, bold: true };
            else if (cell.v < 0) style.font = { color: { rgb: "B91C1C" }, bold: true };
          }
        } else {
          const posInTotals = c - (1 + periods.length * CAT_COLS_PER_PERIOD);
          if (posInTotals === 0) { style.numFmt = "#,##0.00"; style.font = { color: { rgb: "059669" }, bold: true }; }
          if (posInTotals === 1) style.numFmt = "#,##0";
          if (posInTotals === 2) style.numFmt = "0.0%";
        }
        cell.s = style;
      }
    }

    const catCols = [{ wch: 24 }];
    periods.forEach(() => { catCols.push({ wch: 13 }, { wch: 9 }, { wch: 10 }); });
    catCols.push({ wch: 13 }, { wch: 11 }, { wch: 9 });
    wsCat["!cols"] = catCols;
    wsCat["!views"] = [{ state: "frozen", xSplit: 1, ySplit: 2 }];

    XLSX.utils.book_append_sheet(wb, wsCat, "Category Breakdown");
  }

  XLSX.utils.book_append_sheet(wb, ws, "Amazon Sales");
  // Where the figures come from, how far the synced data reaches, and any source that stops short
  // of the selected end date (missing days read as zero sales/returns, not as a real drop).
  const staleOrders = dataThrough && dataThrough < endDate
    ? [`⚠ READ THIS FIRST — the synced Orders data only reaches ${fmtDot(dataThrough)}, but this report runs to ${fmtDot(endDate)}. Days after ${fmtDot(dataThrough)} show no orders because they are not synced yet, not because nothing sold; those periods are left out of the Growth Summary.`]
    : [];
  const wsInfo = XLSX.utils.aoa_to_sheet([
    ["Note"],
    ...staleOrders.map((w) => [w]),
    ...returnCoverageWarnings.map((w) => [w]),
    [`Source: the app's synced Amazon Orders and AM / FBA / SellerFlex Returns tables (not SellerMate), bucketed by IST calendar day. Orders data through ${dataThrough ? fmtDot(dataThrough) : "—"}. Data pulled at ${dataPulledAt}.`],
    ["Total Orders = Orders − All Returns; Total Sales = Price × Total Orders. A return whose order fell in an earlier period can make a period's Total Orders negative."],
  ]);
  wsInfo["!cols"] = [{ wch: 120 }];
  XLSX.utils.book_append_sheet(wb, wsInfo, "Notes");

  const gLabel = granularity === "daily" ? "Daily" : granularity === "weekly" ? "Weekly" : "Monthly";
  const filename = `Amazon_${gLabel}_Sales_Report_${startDate}_to_${endDate}.xlsx`;
  return { wb, filename, productCount: visibleRows.length, periodCount: periods.length, dataRowCount, dataThrough };
}

// Browser entry point (used by the Reports page) — builds the workbook and triggers a download.
export async function exportAmazonSalesReport(opts: { startDate: string; endDate: string; granularity: SalesReportGranularity }) {
  const { wb, filename, ...stats } = await buildAmazonSalesWorkbook(opts);
  XLSX.writeFile(wb, filename);
  return stats;
}
