// Pure aggregation behind the weekly email's KPI block (src/pages/api/weekly-report.ts), kept
// dependency-free so it can be unit tested directly.

type AdRow = { report_date?: string; spend?: unknown; sales?: unknown; sales_7d?: unknown; sales_14d?: unknown };

/** Week totals across Sponsored Products, Brands and Display. Every ad-report row is ONE day's
 *  figures — sales_7d / sales_14d are the attributed sales for that day's clicks, not a rolling
 *  total — so spend and sales are both summed over every day in [start, end]. Reading sales off the
 *  end date's rows alone (the previous behaviour) undercounted Ad Sales ~4x and inflated ACOS to
 *  ~150%; the attached Weekly Sales workbook already summed every day. `spSpendDivisor` is the
 *  orphan-campaign spend share applied to each SP row (1 = plain sum). */
export function weekAdKpis(
  spRows: AdRow[], sbRows: AdRow[], sdRows: AdRow[], start: string, end: string,
  spSpendDivisor: (r: AdRow) => number = () => 1
): { spend: number; adSales: number } {
  const n = (v: unknown) => Number(v) || 0;
  const inRange = (r: AdRow) => !!r.report_date && r.report_date >= start && r.report_date <= end;
  const sp = spRows.filter(inRange), sb = sbRows.filter(inRange), sd = sdRows.filter(inRange);
  const spend =
    sp.reduce((s, r) => s + n(r.spend) / spSpendDivisor(r), 0) +
    sb.reduce((s, r) => s + n(r.spend), 0) +
    sd.reduce((s, r) => s + n(r.spend), 0);
  const adSales =
    sp.reduce((s, r) => s + n(r.sales_7d), 0) +
    sb.reduce((s, r) => s + n(r.sales), 0) +
    sd.reduce((s, r) => s + n(r.sales_14d), 0);
  return { spend, adSales };
}

export const roasOf = (a: { spend: number; adSales: number }) => (a.spend > 0 ? a.adSales / a.spend : 0);
export const acosPctOf = (a: { spend: number; adSales: number }) => (a.adSales > 0 ? (a.spend / a.adSales) * 100 : 0);

type PeriodStat = { orders: number; totalSales: number };
export type ProductPeriods = { sku: string; name: string; category: string; periods: Record<string, PeriodStat | undefined> };

/** One week's per-product figures from the workbook's own rows: sales is the workbook's Total
 *  Sales (net of returns), units its Orders. */
export function productMapForPeriod(products: ProductPeriods[], label: string): Map<string, { name: string; sku: string; category: string; sales: number; units: number }> {
  const out = new Map<string, { name: string; sku: string; category: string; sales: number; units: number }>();
  for (const p of products) {
    const s = p.periods[label];
    if (!s) continue;
    out.set(p.sku, { name: p.name, sku: p.sku, category: p.category, sales: s.totalSales, units: s.orders });
  }
  return out;
}
