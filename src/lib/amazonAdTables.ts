import { fetchAllRows } from "@/lib/amazonReportShared";
import { sharedFetch } from "@/lib/sharedFetch";

// The Sponsored Products / Brands / Display card tables for a date range, read ONCE and shared.
// The Amazon Overview and the Overall page each asked for the same three tables several times per
// load (this period, the previous period, and both together): nine reads where three do.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AdTableRows = { sp: any[]; sb: any[]; sd: any[] };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const between = (start: string, end: string) => (q: any) => q.gte("report_date", start).lte("report_date", end);

// Every column except `raw`, plus the one value the ad rules read out of raw: whether the source
// row has a "Date" column (isSpCardRow). raw is an array when the SP card merged several lines, so
// the value is read from both shapes.
const SP_COLUMNS =
  "id,report_date,portfolio_name,currency,campaign_name,ad_group_name,country,advertised_sku,advertised_asin," +
  "impressions,clicks,ctr,cpc,spend,sales_7d,acos,roas,orders_7d,units_7d,conversion_rate_7d," +
  "advertised_sku_units_7d,other_sku_units_7d,advertised_sku_sales_7d,other_sku_sales_7d,created_at," +
  "raw_date:raw->Date,raw_date_0:raw->0->Date";

// Rebuilds the small part of `raw` the rules look at, so they run unchanged.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withSlimRaw(r: any) {
  const { raw_date, raw_date_0, ...rest } = r;
  const date = raw_date ?? raw_date_0;
  return { ...rest, raw: date !== null && date !== undefined ? { Date: date } : {} };
}

export function loadAmazonAdTables(start: string, end: string): Promise<AdTableRows> {
  return sharedFetch(`amazon-ad-tables:${start}:${end}`, async () => {
    const [sp, sb, sd] = await Promise.all([
      fetchAllRows("barm_amazon_sp_advertised_product", between(start, end), "id", SP_COLUMNS).then((rows) => rows.map(withSlimRaw)),
      fetchAllRows("barm_amazon_sb_campaign", between(start, end)),
      fetchAllRows("barm_amazon_sd_campaign", between(start, end)),
    ]);
    return { sp, sb, sd };
  }, 120_000);
}

/** The rows of an already-loaded range that fall inside [start, end]. */
export function adTablesWithin(t: AdTableRows, start: string, end: string): AdTableRows {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const keep = (r: any) => { const d = String(r.report_date ?? "").slice(0, 10); return d >= start && d <= end; };
  return { sp: t.sp.filter(keep), sb: t.sb.filter(keep), sd: t.sd.filter(keep) };
}
