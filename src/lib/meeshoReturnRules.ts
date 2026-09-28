// Pure rules for the Returns sheets of the seller's Meesho raw workbook — kept dependency-free so
// they can be unit tested directly. The workbook is ONE upload on the Meesho Upload page's single
// card (meeshoReportUpload.ts's uploadMeeshoFile): its "Orders" sheet goes to barm_meesho_orders
// and its three return sheets — "Returns In Transit", "Returns Delivered", "Returns OFD", told apart
// by meeshoFileRules.ts — go to barm_meesho_returns (scripts/meesho_returns_table.sql), one row per
// Suborder Number.

type RawRow = Record<string, unknown>;

export type MeeshoReturnStage = "In Transit" | "Out for Delivery" | "Delivered";

// A return only moves forward (In Transit -> OFD -> Delivered), so when the same suborder shows up
// on two sheets the later stage is the current one.
const STAGE_RANK: Record<MeeshoReturnStage, number> = { "In Transit": 1, "Out for Delivery": 2, Delivered: 3 };

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v).trim();
  // Meesho writes a literal "null" / "NA" into empty text cells.
  return s.toLowerCase() === "null" || s === "NA" ? "" : s;
}
function int(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(str(v).replace(/[^0-9.eE+-]/g, ""));
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/** Excel serial day number (the workbook's date cells) or an ISO / DD-MM-YYYY string -> "YYYY-MM-DD".
 *  Serial days count from 1899-12-30 and carry no timezone, so the calendar day is read as-is. */
export function meeshoDate(v: unknown): string | null {
  if (typeof v === "number" && v > 0) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86_400_000);
    return d.toISOString().slice(0, 10);
  }
  const s = str(v);
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return iso[0];
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(s);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  return null;
}

function makePicker(row: RawRow) {
  const normalized = new Map<string, string>();
  Object.keys(row).forEach((k) => normalized.set(k.replace(/\s+/g, " ").trim().toLowerCase(), k));
  return (...candidates: string[]): unknown => {
    for (const c of candidates) {
      const hit = normalized.get(c.toLowerCase());
      if (hit !== undefined) return row[hit];
    }
    return "";
  };
}

export interface MeeshoReturnRow {
  sub_order_no: string;
  order_number: string;
  product_name: string;
  sku: string;
  variation: string;
  category: string;
  quantity: number;
  dispatch_date: string | null;
  return_created_date: string | null;
  type_of_return: string;
  sub_type: string;
  return_stage: MeeshoReturnStage;
  return_status: string;
  expected_delivery_date: string | null;
  delivered_date: string | null;
  courier_partner: string;
  awb_number: string;
  return_price_type: string;
  return_reason: string;
  detailed_return_reason: string;
  raw: RawRow;
}

export function mapMeeshoReturnRow(row: RawRow, stage: MeeshoReturnStage, sheetName: string): MeeshoReturnRow | null {
  const p = makePicker(row);
  const subOrderNo = str(p("Suborder Number", "Sub Order No"));
  if (!subOrderNo) return null;
  return {
    sub_order_no: subOrderNo,
    // "Order Number" is a 18-digit number Excel has already rounded; the suborder's own prefix is exact.
    order_number: subOrderNo.split("_")[0],
    product_name: str(p("Product Name")),
    // Some rows carry a leading space (" B-SENBR") — trimmed so they join to the Orders sheet's SKU.
    sku: str(p("SKU")),
    variation: str(p("Variation")),
    category: str(p("Category")),
    quantity: int(p("Qty", "Quantity")),
    dispatch_date: meeshoDate(p("Dispatch Date")),
    return_created_date: meeshoDate(p("Return Created Date")),
    type_of_return: str(p("Type of Return")),
    sub_type: str(p("Sub Type")),
    return_stage: stage,
    // The Delivered sheet has no Status column — being on it is the status.
    return_status: stage === "Delivered" ? "Delivered" : str(p("Status")),
    expected_delivery_date: meeshoDate(p("Expected Delivery Date")),
    delivered_date: meeshoDate(p("Delivered Date")),
    courier_partner: str(p("Courier Partner")),
    awb_number: str(p("AWB Number")),
    return_price_type: str(p("Return Price Type")),
    return_reason: str(p("Return Reason")),
    detailed_return_reason: str(p("Detailed Return Reason")),
    raw: { sheet: sheetName, ...row },
  };
}

/** One row per suborder, keeping the furthest stage. A single upsert batch must not name the same
 *  sub_order_no twice (Postgres rejects it), so this also guards against a return listed on two sheets. */
export function dedupeReturnsByStage(rows: MeeshoReturnRow[]): MeeshoReturnRow[] {
  const bySub = new Map<string, MeeshoReturnRow>();
  for (const r of rows) {
    const prev = bySub.get(r.sub_order_no);
    if (!prev || STAGE_RANK[r.return_stage] >= STAGE_RANK[prev.return_stage]) bySub.set(r.sub_order_no, r);
  }
  return [...bySub.values()];
}
