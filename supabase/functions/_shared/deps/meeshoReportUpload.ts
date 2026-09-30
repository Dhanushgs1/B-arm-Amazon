import * as XLSX from "npm:xlsx@0.18.5";

// Deno copy of what the Ad Spend Report still needs from src/lib/meeshoReportUpload.ts: toDate(),
// the flexible date parser. The old Meesho upload helpers that lived here wrote to
// barm_meesho_ads / barm_meesho_orders, both dropped on 29 Sep 2026 (Meesho ads now come from
// barm_daily_ms_barm_ads, orders from meesho_barm_ord — see meeshoBarmOrd.ts), and no Edge
// Function called them, so they were removed.

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
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(s);
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
