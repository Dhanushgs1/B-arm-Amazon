import * as XLSX from "xlsx";
import { fetchMeeshoOrdersDataInfo } from "@/lib/meeshoBarmOrd";

// What's left of the old Meesho upload helpers. The Meesho Upload page (and
// the barm_meesho_orders / barm_meesho_returns tables it wrote to) was
// removed on 29 Sep 2026 — Meesho orders now come from meesho_barm_ord (see
// meeshoBarmOrd.ts). This file keeps:
//   - toDate(), the flexible date parser several other uploaders import;
//   - the "data on file" caption for the Meesho Overview/Download pages
//     (orders from meesho_barm_ord). The Ads line was removed along with the
//     barm_meesho_ads table, at the seller's request.

export type MeeshoUploadReportType = "orders";

export const MS_REPORT_LABEL: Record<MeeshoUploadReportType, string> = {
  orders: "Meesho Orders / Payments report",
};

// ── value parsing ───────────────────────────────────────────────────────────

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

const MONTH_ABBR: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

// Handles an Excel serial date (cell typed as a date when the sheet came from
// an .xlsx), a plain ISO date, DD/MM/YYYY or MM/DD/YYYY (ambiguous — DD/MM is
// tried first since this seller's other exports are IN-locale), and "13-Aug-26".
export function toDate(v: unknown): string | null {
  if (typeof v === "number" && v > 0) {
    const d = XLSX.SSF.parse_date_code(v);
    if (!d) return null;
    return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  }
  const s = str(v);
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return iso[0];
  // "/" or "-" as always, plus "." — the B-Arm Orders workbook's own title line
  // ("B-arm order19.09.2026") shows the seller writing dates dot-separated, so
  // a hand-typed Date column in that same file is likely to use it too.
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(s);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  const dMonY = /^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/.exec(s);
  if (dMonY) {
    const mon = MONTH_ABBR[dMonY[2].toLowerCase()];
    if (mon) {
      const year = dMonY[3].length === 2 ? `20${dMonY[3]}` : dMonY[3];
      return `${year}-${mon}-${dMonY[1].padStart(2, "0")}`;
    }
  }
  // "Aug 20, 2026" / "August 20 2026" — Flipkart's order-report "Ordered On"
  // column, month name first instead of last.
  const monDY = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (monDY) {
    const mon = MONTH_ABBR[monDY[1].slice(0, 3).toLowerCase()];
    if (mon) return `${monDY[3]}-${mon}-${monDY[2].padStart(2, "0")}`;
  }
  return null;
}

// ── "data on file" summaries ────────────────────────────────────────────────

export interface MeeshoReportDataInfo {
  rowCount: number;
  minDate: string | null;
  maxDate: string | null;
  error?: string;
}

/** Never rejects. */
export async function fetchAllMeeshoReportDataInfo(): Promise<Record<MeeshoUploadReportType, MeeshoReportDataInfo>> {
  const [orders] = await Promise.allSettled([fetchMeeshoOrdersDataInfo()]);
  const settle = (r: PromiseSettledResult<MeeshoReportDataInfo>): MeeshoReportDataInfo =>
    r.status === "fulfilled"
      ? r.value
      : { rowCount: 0, minDate: null, maxDate: null, error: r.reason instanceof Error ? r.reason.message : String(r.reason) };
  return { orders: settle(orders) };
}
