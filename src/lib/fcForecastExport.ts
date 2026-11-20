// FC Forecast xlsx download (2026-11-20), in the client's sheet layout:
//   FORECAST SHEET — PRODUCT NAME | peak data in 3 months | last 30 days | max | Minimum stock needed
//   DETAIL         — the three blocks (date ranges in the headers) and the last-30-day channel split
//   UNMAPPED SKUS  — SKUs sold in the 90 days that map to no product

import * as XLSX from "xlsx";
import { blocks, fcFileName, rangeLabel, FC_CHANNEL_LABEL, type FcRow, type FcUnmapped } from "./fcForecastRules.ts";

export function fcWorkbook(rows: FcRow[], unmapped: FcUnmapped[], asOf: string): XLSX.WorkBook {
  const b = blocks(asOf);
  const wb = XLSX.utils.book_new();
  const forecast = [
    ["PRODUCT NAME", "peak data in 3 months", "last 30 days", "max", "Minimum stock needed"],
    ...rows.map((r) => [r.product, r.peak, r.last30, r.max_units, r.min_stock]),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(forecast), "FORECAST SHEET");
  const detail = [
    [
      "PRODUCT NAME",
      `Block 3 (${rangeLabel(b.b3)})`, `Block 2 (${rangeLabel(b.b2)})`, `Block 1 = last 30 days (${rangeLabel(b.b1)})`,
      "Peak", "Max", "Minimum stock needed",
      ...["amazon", "flipkart", "meesho", "website", "sellerflex"].map((c) => `${FC_CHANNEL_LABEL[c]} (last 30 days)`),
    ],
    ...rows.map((r) => [
      r.product, r.block3, r.block2, r.block1, r.peak, r.max_units, r.min_stock,
      r.ch_amazon, r.ch_flipkart, r.ch_meesho, r.ch_website, r.ch_sellerflex,
    ]),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(detail), "DETAIL");
  const um = [
    ["SKU", "Channel", "Units (90 days)", "Title"],
    ...unmapped.map((u) => [u.sku, FC_CHANNEL_LABEL[u.channel] ?? u.channel, u.units_90d, u.sample_title ?? ""]),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(um), "UNMAPPED SKUS");
  return wb;
}

/** Builds the workbook and starts the browser download. */
export function exportFcWorkbook(rows: FcRow[], unmapped: FcUnmapped[], asOf: string): void {
  XLSX.writeFile(fcWorkbook(rows, unmapped, asOf), fcFileName(asOf));
}
