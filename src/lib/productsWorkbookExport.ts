import * as XLSX from "xlsx-js-style";
import { buildStyledSheet } from "@/lib/excelExport";
import { CATEGORY_COLORS } from "@/lib/categoryMap";

export interface GrowthRow {
  name: string;
  sku: string;
  curSales: number;
  prevSales: number;
  growthPct: number;
}

export interface CategoryGrowth {
  category: string;
  gainers: GrowthRow[];
  losers: GrowthRow[];
}

function styleHeaderRow(ws: XLSX.WorkSheet, row: number, cols: number, fill = "4F46E5") {
  for (let c = 0; c < cols; c++) {
    const addr = XLSX.utils.encode_cell({ r: row, c });
    if (!ws[addr]) ws[addr] = { t: "s", v: "" };
    ws[addr].s = {
      font: { bold: true, color: { rgb: "FFFFFF" } },
      fill: { fgColor: { rgb: fill } },
      alignment: { horizontal: "center", vertical: "center" },
    };
  }
}

// Builds the three-sheet "Products" workbook: the on-screen product table, genuine (non-courier)
// FBA customer returns, and a per-category Top 5 / Worst 5 sales-growth breakdown vs the prior
// equal-length period.
export function exportProductsWorkbook(opts: {
  products: any[];
  columns: { key: string; label: string }[];
  returns: any[];
  growthByCategory: CategoryGrowth[];
  growthAvailable: boolean;
  growthPeriodLabel: string;
  filename: string;
}) {
  const { products, columns, returns, growthByCategory, growthAvailable, growthPeriodLabel, filename } = opts;
  const wb = XLSX.utils.book_new();

  // ── Products sheet — same columns/styling as the on-screen table ──
  const wsProducts = buildStyledSheet(products, columns);
  XLSX.utils.book_append_sheet(wb, wsProducts, "Products");

  // ── Returns sheet — genuine customer returns only (courier/undeliverable-RTO already excluded
  // by the caller before this is built) ──
  const returnCols = [
    { key: "returnDate", label: "Return Date" },
    { key: "orderId", label: "Order ID" },
    { key: "asin", label: "ASIN" },
    { key: "sku", label: "SKU" },
    { key: "productName", label: "Product" },
    { key: "quantity", label: "Qty" },
    { key: "reason", label: "Reason" },
    { key: "detailedDisposition", label: "Disposition" },
    { key: "customerComments", label: "Customer Comments" },
  ];
  const wsReturns = buildStyledSheet(returns, returnCols);
  XLSX.utils.book_append_sheet(wb, wsReturns, "Returns");

  // ── Growth sheet — per category, Top 5 gainers / Worst 5 decliners by Total Sales growth % ──
  const growthAoa: any[][] = [];
  const numberRowStyles: { row: number; growthCol: number }[] = [];
  const sectionHeaderRows: { row: number; isGain: boolean }[] = [];
  const categoryTitleRows: { row: number; category: string }[] = [];

  if (!growthAvailable) {
    growthAoa.push(["Growth analysis unavailable"]);
    growthAoa.push(["The selected date range is a single day, so there's no equal-length prior period to compare against — pick a wider range to see category growth."]);
  } else {
    growthAoa.push([`Category Growth — ${growthPeriodLabel}`, "", "", "", ""]);
    growthAoa.push([]);
    growthByCategory.forEach(({ category, gainers, losers }) => {
      categoryTitleRows.push({ row: growthAoa.length, category });
      growthAoa.push([category]);

      sectionHeaderRows.push({ row: growthAoa.length, isGain: true });
      growthAoa.push(["Top 5 Gainers", "SKU", "Current Sales", "Previous Sales", "Growth %"]);
      if (gainers.length === 0) {
        growthAoa.push(["No products with sales growth in this category"]);
      } else {
        gainers.forEach((g) => {
          numberRowStyles.push({ row: growthAoa.length, growthCol: 4 });
          growthAoa.push([g.name, g.sku, g.curSales, g.prevSales, g.growthPct]);
        });
      }
      growthAoa.push([]);

      sectionHeaderRows.push({ row: growthAoa.length, isGain: false });
      growthAoa.push(["Worst 5 (Decline)", "SKU", "Current Sales", "Previous Sales", "Growth %"]);
      if (losers.length === 0) {
        growthAoa.push(["No products with a sales decline in this category"]);
      } else {
        losers.forEach((g) => {
          numberRowStyles.push({ row: growthAoa.length, growthCol: 4 });
          growthAoa.push([g.name, g.sku, g.curSales, g.prevSales, g.growthPct]);
        });
      }
      growthAoa.push([]);
    });
  }

  const wsGrowth = XLSX.utils.aoa_to_sheet(growthAoa);
  wsGrowth["!cols"] = [{ wch: 45 }, { wch: 18 }, { wch: 15 }, { wch: 15 }, { wch: 10 }];

  if (growthAvailable) {
    const titleAddr = XLSX.utils.encode_cell({ r: 0, c: 0 });
    if (wsGrowth[titleAddr]) {
      wsGrowth[titleAddr].s = { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "111827" } } };
    }
    categoryTitleRows.forEach(({ row, category }) => {
      const addr = XLSX.utils.encode_cell({ r: row, c: 0 });
      if (!wsGrowth[addr]) return;
      const color = (CATEGORY_COLORS[category] || CATEGORY_COLORS.Other).replace("#", "");
      wsGrowth[addr].s = { font: { bold: true, color: { rgb: color } }, alignment: { vertical: "center" } };
    });
    sectionHeaderRows.forEach(({ row, isGain }) => styleHeaderRow(wsGrowth, row, 5, isGain ? "047857" : "B91C1C"));
    numberRowStyles.forEach(({ row, growthCol }) => {
      for (let c = 2; c <= 3; c++) {
        const addr = XLSX.utils.encode_cell({ r: row, c });
        if (wsGrowth[addr] && typeof wsGrowth[addr].v === "number") {
          wsGrowth[addr].s = { numFmt: "#,##0.00", font: { color: { rgb: "1F2937" } } };
        }
      }
      const gAddr = XLSX.utils.encode_cell({ r: row, c: growthCol });
      if (wsGrowth[gAddr] && typeof wsGrowth[gAddr].v === "number") {
        const val = wsGrowth[gAddr].v as number;
        wsGrowth[gAddr].s = { numFmt: "0.0%", font: { color: { rgb: val < 0 ? "B91C1C" : "047857" }, bold: true } };
      }
    });
  }

  XLSX.utils.book_append_sheet(wb, wsGrowth, "Growth");

  XLSX.writeFile(wb, `${filename}.xlsx`);
}
