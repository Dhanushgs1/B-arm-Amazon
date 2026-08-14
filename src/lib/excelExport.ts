import * as XLSX from "xlsx-js-style";

interface ColumnDef {
  key: string;
  label: string;
  exportValue?: (val: any, row: any) => any;
}

// Builds one styled worksheet from tabular data — split out of exportToExcel so a caller that
// needs a multi-sheet workbook (e.g. the Products page's Products/Returns/Growth export) can
// reuse the exact same header/number/color styling per sheet instead of duplicating it.
export function buildStyledSheet(data: any[], columns: ColumnDef[]) {
  // Filter out any columns that don't have a label or we don't want to export
  const exportCols = columns.filter(c => c.label && c.key);

  // 1. Create headers
  const aoa: any[][] = [];
  aoa.push(exportCols.map(c => c.label));

  // 2. Create data rows
  data.forEach(row => {
    const rowData = exportCols.map(c => {
      const val = c.exportValue ? c.exportValue(row[c.key], row) : row[c.key];
      return val ?? "";
    });
    aoa.push(rowData);
  });

  // 3. Create sheet
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // 4. Style header row
  for (let C = 0; C < exportCols.length; C++) {
    const cellAddr = XLSX.utils.encode_cell({ r: 0, c: C });
    if (!ws[cellAddr]) continue;
    ws[cellAddr].s = {
      font: { bold: true, color: { rgb: "FFFFFF" } },
      fill: { fgColor: { rgb: "4F46E5" } }, // Indigo background
      alignment: { horizontal: "center", vertical: "center" },
      border: { bottom: { style: "medium", color: { rgb: "312E81" } } }
    };
  }

  // 5. Style data rows
  for (let R = 1; R <= data.length; R++) {
    const row = data[R - 1]; // original row data
    for (let C = 0; C < exportCols.length; C++) {
      const cellAddr = XLSX.utils.encode_cell({ r: R, c: C });
      if (!ws[cellAddr]) continue;
      
      const col = exportCols[C];
      const val = col.exportValue ? col.exportValue(row[col.key], row) : row[col.key];

      let cellStyle: any = { 
        font: { color: { rgb: "1F2937" } }, 
        alignment: { vertical: "center" },
        border: { bottom: { style: "thin", color: { rgb: "E5E7EB" } } }
      };

      // Number formatting for currencies and percentages
      if (typeof val === 'number') {
        if (col.key === "acos" || col.key === "ctr" || col.key === "cvr" || col.key === "returnRate" || col.label.includes("%")) {
           cellStyle.numFmt = "0.00%";
           ws[cellAddr].v = val / 100; // xlsx treats 1 as 100%
        } else if (col.key === "spend" || col.key === "sales" || col.key === "cpc" || col.key === "averageSellingPrice") {
           cellStyle.numFmt = "#,##0.00";
        }
      }

      // Coloring logic based on column key
      if (col.key === "acos" && typeof val === "number") {
        if (val < 20) {
          cellStyle.font = { color: { rgb: "047857" }, bold: true }; // Emerald
          cellStyle.fill = { fgColor: { rgb: "D1FAE5" } };
        } else if (val > 40) {
          cellStyle.font = { color: { rgb: "B91C1C" }, bold: true }; // Red
          cellStyle.fill = { fgColor: { rgb: "FEE2E2" } };
        } else {
          cellStyle.font = { color: { rgb: "B45309" }, bold: true }; // Amber
          cellStyle.fill = { fgColor: { rgb: "FEF3C7" } };
        }
      } 
      else if (col.key === "roas" && typeof val === "number") {
        if (val > 5) {
          cellStyle.font = { color: { rgb: "047857" }, bold: true }; // Emerald
          cellStyle.fill = { fgColor: { rgb: "D1FAE5" } };
        } else if (val > 3) {
          cellStyle.font = { color: { rgb: "1D4ED8" }, bold: true }; // Blue
          cellStyle.fill = { fgColor: { rgb: "DBEAFE" } };
        } else if (val > 0) {
          cellStyle.font = { color: { rgb: "B45309" }, bold: true }; // Amber
          cellStyle.fill = { fgColor: { rgb: "FEF3C7" } };
        }
      }
      else if (col.key === "sales" && val > 0) {
        cellStyle.font = { color: { rgb: "059669" }, bold: true }; // Emerald
      }
      else if (col.key === "spend") {
        cellStyle.font = { color: { rgb: "111827" }, bold: true }; // Bold black
      }

      ws[cellAddr].s = cellStyle;
    }
  }

  // Set column widths based on headers
  const wscols = exportCols.map(c => ({ wch: Math.max(12, c.label.length + 5) }));
  // Make skuIds and campaign/adgroup wider
  const longCols = ["campaignName", "adGroupName", "itemName", "skus", "searchTerm"];
  for (let i = 0; i < exportCols.length; i++) {
    if (longCols.includes(exportCols[i].key)) {
      wscols[i] = { wch: 35 };
    }
  }
  ws["!cols"] = wscols;

  return ws;
}

export function exportToExcel(data: any[], columns: ColumnDef[], filename: string): void {
  const ws = buildStyledSheet(data, columns);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Data");
  XLSX.writeFile(wb, `${filename}.xlsx`);
}
