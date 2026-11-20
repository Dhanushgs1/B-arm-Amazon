// Amazon Seller Flex customer shipments (FC Forecast tab, 2026-11-20). Parses the
// "VSNC-CUSTOMER_SHIPMENTS-ALL-<from>-<to>.csv" export into barm_sellerflex_shipments rows.
// Dependency-light (papaparse only, no "@/" imports) so it runs under plain node for tests and scripts.
//   - sku = the "MSKU" column (the CSV's "SKU" column is Amazon's internal id).
//   - Dates look like "17-Nov-2026".
//   - A (Shipment ID, MSKU) repeated in one file keeps the LAST row — same key the table upserts on,
//     so re-uploading an overlapping range updates statuses instead of double counting.

import Papa from "papaparse";

export type SellerFlexRow = {
  shipment_id: string;
  sku: string;
  asin: string;
  customer_order_id: string;
  units: number;
  status: string;
  shipment_creation_date: string;
  channel: string;
  raw: Record<string, string>;
};

/** Same rule as SQL fc_norm_sku(): drop invisible marks (U+200B–U+200F, U+FEFF), trim, lowercase. */
export function normalizeSku(s: string): string {
  return String(s ?? "").replace(/[​-‏﻿]/g, "").trim().toLowerCase();
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

function parseDay(v: string): string | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(String(v ?? "").trim());
  const mon = m && MONTHS[m[2].toLowerCase()];
  return m && mon ? `${m[3]}-${mon}-${m[1].padStart(2, "0")}` : null;
}

export function parseSellerFlexCsv(text: string): { rows: SellerFlexRow[]; minDate: string | null; maxDate: string | null; skipped: number } {
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim() });
  const byKey = new Map<string, SellerFlexRow>();
  let skipped = 0;
  for (const r of parsed.data) {
    const shipment_id = String(r["Shipment ID"] ?? "").trim();
    const sku = String(r["MSKU"] ?? "").replace(/[​-‏﻿]/g, "").trim();
    const day = parseDay(r["Shipment Creation Date"]);
    if (!shipment_id || !sku || !day) { skipped++; continue; }
    const units = Number.parseInt(String(r["Units"] ?? "").trim(), 10);
    byKey.set(`${shipment_id}|${sku}`, {
      shipment_id,
      sku,
      asin: String(r["ASIN"] ?? "").trim(),
      customer_order_id: String(r["Customer Order ID"] ?? "").trim(),
      units: Number.isFinite(units) ? units : 0,
      status: String(r["Status"] ?? "").trim(),
      shipment_creation_date: day,
      channel: String(r["Channel"] ?? "").trim(),
      raw: r,
    });
  }
  const rows = [...byKey.values()];
  const days = rows.map((r) => r.shipment_creation_date).sort();
  return { rows, minDate: days[0] ?? null, maxDate: days[days.length - 1] ?? null, skipped };
}
