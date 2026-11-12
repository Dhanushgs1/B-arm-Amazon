// Amazon, Flipkart and Meesho figures the same way the B-ARM ERP's "MIS Data's" page counts them
// (user, 12 Nov 2026: the ERP at b-arm.org is the reference). The ERP reads public.mis_datas_mv,
// built from each marketplace's monthly invoice / tax reports:
//   Amazon   amazon_mtr_b2c + amazon_mtr_b2b (Shipment / Refund / FreeReplacement, cancels left out)
//   Flipkart flipkart_monthly_mis_input (Sale / Return / Cancellation / Return Cancellation)
//   Meesho   meesho_tcs_sales_mis_inputs + meesho_tcs_sales_returns_mis_inputs
// and groups lines by report month (invoice_month). Those reports arrive a month at a time, so the
// days after the newest report month still come from the order reports (channelSummary.ts).
//
// Mapping, so whole months equal the ERP's Sales (w/ Tax) and Qty exactly:
//   Sales   = Σ sales_with_tax                 (invoiced value incl. tax, before returns)
//   Units   = Σ quantity of lines with quantity > 0
//   Returns = Σ |quantity| of lines with quantity < 0 (refunds, returns, Flipkart cancellations)
//   Net     = Units − Returns                  (= the ERP's Qty column)
//   Orders  = distinct order ids with a positive-quantity line
// A line counts on its invoice date, kept inside its report month: a refund in the June report for
// a May invoice counts on 1 June, as the ERP's month totals do.

export type MisMarketplace = "Amazon" | "Flipkart" | "Meesho";

export interface MisLine {
  invoice_date: string | null;
  invoice_month: string | null;
  order_id: string | null;
  quantity: number | string | null;
  sales_with_tax: number | string | null;
  returns_with_tax?: number | string | null;
}

export interface MisPeriodTotals {
  sales: number;
  returnsValue: number;
  units: number;
  orders: number;
  allReturns: number;
  netOrders: number;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Last day of the month that starts on `monthStart` (YYYY-MM-01). */
export function monthEnd(monthStart: string): string {
  const [y, m] = monthStart.slice(0, 10).split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${pad(m)}-${pad(last)}`;
}

/** First day of the month holding `day`. */
export const monthStartOf = (day: string) => `${day.slice(0, 7)}-01`;

/** The day a line counts on: its invoice date, kept inside its report month. */
export function effectiveDate(line: Pick<MisLine, "invoice_date" | "invoice_month">): string | null {
  const month = line.invoice_month ? line.invoice_month.slice(0, 10) : null;
  const day = line.invoice_date ? line.invoice_date.slice(0, 10) : null;
  if (!month) return day;
  const end = monthEnd(month);
  if (!day || day < month) return month;
  if (day > end) return end;
  return day;
}

/** Totals for the lines that count inside [start, end]. */
export function summarizeMisLines(lines: MisLine[], start: string, end: string): MisPeriodTotals {
  let sales = 0, returnsValue = 0, units = 0, allReturns = 0;
  const orders = new Set<string>();
  for (const l of lines) {
    const d = effectiveDate(l);
    if (!d || d < start || d > end) continue;
    const q = Number(l.quantity) || 0;
    sales += Number(l.sales_with_tax) || 0;
    returnsValue += Number(l.returns_with_tax) || 0;
    if (q > 0) { units += q; if (l.order_id) orders.add(String(l.order_id)); }
    else if (q < 0) allReturns += -q;
  }
  return { sales, returnsValue, units, orders: orders.size, allReturns, netOrders: units - allReturns };
}

/** How a period splits around the last day the invoice reports cover (`misEnd`). */
export function splitPeriod(start: string, end: string, misEnd: string | null): { mis: { start: string; end: string } | null; orders: { start: string; end: string } | null } {
  if (!misEnd || start > misEnd) return { mis: null, orders: { start, end } };
  if (end <= misEnd) return { mis: { start, end }, orders: null };
  const d = new Date(`${misEnd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  const after = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return { mis: { start, end: misEnd }, orders: { start: after, end } };
}

/** "30 Sep 2026" */
export function dayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return `${d} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${y}`;
}
