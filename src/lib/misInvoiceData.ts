// Reads the B-ARM ERP's invoice lines (public.mis_datas_mv, the source of its "MIS Data's" page) for
// the overview strips (channelSummary.ts) and the Business overview (bi/dataset.ts). Rules for
// counting them: misInvoiceRules.ts.

import { fetchAllRows } from "@/lib/amazonReportShared";
import { supabasePublic } from "@/lib/supabasePublic";
import { monthEnd, monthStartOf, type MisCoverage, type MisLine, type MisMarketplace } from "@/lib/misInvoiceRules";

export interface MisProductLine extends MisLine {
  sku: string | null;
  product_name: string | null;
  category: string | null;
}

async function edgeMonth(m: MisMarketplace, ascending: boolean): Promise<string | null> {
  for (let i = 0; ; i++) {
    const { data, error } = await supabasePublic.from("mis_datas_mv").select("invoice_month").eq("marketplace", m).order("invoice_month", { ascending }).limit(1);
    if (!error) return (data?.[0] as { invoice_month?: string } | undefined)?.invoice_month?.slice(0, 10) ?? null;
    if (i >= 3) throw new Error(`ERP invoice data (${m}): ${error.message}`);
    await new Promise((r) => setTimeout(r, 1500 * (i + 1))); // this database has bursts of statement timeouts
  }
}

const coverageCache = new Map<MisMarketplace, { at: number; value: Promise<MisCoverage | null> }>();

/** Last invoice day on file in the ERP's newest report month (null when none can be read). */
async function lastDayIn(m: MisMarketplace, month: string): Promise<string | null> {
  for (let i = 0; ; i++) {
    const { data, error } = await supabasePublic.from("mis_datas_mv").select("invoice_date").eq("marketplace", m).eq("invoice_month", month).order("invoice_date", { ascending: false }).limit(1);
    if (!error) return (data?.[0] as { invoice_date?: string } | undefined)?.invoice_date?.slice(0, 10) ?? null;
    if (i >= 3) throw new Error(`ERP invoice data (${m}): ${error.message}`);
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
}

/** First and last day the ERP's invoice reports cover for a marketplace. Earlier report months count
 *  in full; the newest one runs to its last invoice day on file, so a month uploaded part-way (e.g.
 *  October to the 15th) leaves the later days to the order reports instead of showing zeros. A new
 *  month (e.g. October) is picked up by itself once the ERP has it: this is re-read every 30 minutes. */
export function misCoverage(m: MisMarketplace): Promise<MisCoverage | null> {
  const hit = coverageCache.get(m);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.value;
  const value = (async () => {
    const first = await edgeMonth(m, true);
    const last = await edgeMonth(m, false);
    if (!first || !last) return null;
    const full = monthEnd(last);
    const lastDay = await lastDayIn(m, last);
    // a last day inside the month ends coverage there; anything else (none, or a date outside it) keeps the whole month
    const end = lastDay && lastDay >= last && lastDay < full ? lastDay : full;
    return { start: first, end };
  })();
  coverageCache.set(m, { at: Date.now(), value });
  value.catch(() => coverageCache.delete(m));
  return value;
}

const COLS = "line_uid,invoice_date,invoice_month,order_id,quantity,sales_with_tax,returns_with_tax";

/** The ERP's lines for the report months touching [start, end]. */
export function loadMisLines(m: MisMarketplace, start: string, end: string): Promise<MisLine[]> {
  return fetchAllRows("mis_datas_mv", (q) => q.eq("marketplace", m).gte("invoice_month", monthStartOf(start)).lte("invoice_month", monthStartOf(end)), "line_uid", COLS) as Promise<MisLine[]>;
}

/** As loadMisLines, with each line's SKU, product name and category. */
export function loadMisProductLines(m: MisMarketplace, start: string, end: string): Promise<MisProductLine[]> {
  return fetchAllRows("mis_datas_mv", (q) => q.eq("marketplace", m).gte("invoice_month", monthStartOf(start)).lte("invoice_month", monthStartOf(end)), "line_uid", `${COLS},sku,product_name,category`) as Promise<MisProductLine[]>;
}
