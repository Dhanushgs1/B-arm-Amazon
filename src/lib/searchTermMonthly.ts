// Monthly Search Terms mail (user, 2026-10-16): once a month, on the month's last day, the account's
// Amazon search terms for that calendar month in four sheets — Orders 0, ACOS above 50%, ACOS 25–50%,
// ACOS 13–25%.
//
// Each period is a whole calendar month, 1st to its last day: the 31st in Jan, Mar, May, Jul, Aug, Oct
// and Dec; the 30th in Apr, Jun, Sep and Nov; the 28th (29th in a leap year) in February. The mail goes
// on that last day. Dates are IST calendar dates.
//
// Pure functions only (no imports) so node --test can run them; the API route is
// src/pages/api/search-term-monthly-mail.ts and the Mail tab is on the Search Terms page.

export interface MonthlyPeriod { start: string; end: string; label: string }

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Today's date in IST as YYYY-MM-DD. */
export function istToday(now = new Date()): string {
  return new Date(now.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

/** The calendar month (year, 1-based month): 1st to its last day. */
export function periodForMonth(y: number, m: number): MonthlyPeriod {
  return { start: iso(y, m, 1), end: iso(y, m, daysIn(y, m)), label: `${MONTHS[m - 1]} ${y}` };
}

/** The period (calendar month) a date falls in. */
export function periodContaining(date: string): MonthlyPeriod {
  return periodForMonth(Number(date.slice(0, 4)), Number(date.slice(5, 7)));
}

/** The period whose mail is due on `today` (its last day), or null. */
export function periodDueOn(today: string): MonthlyPeriod | null {
  const p = periodContaining(today);
  return p.end === today ? p : null;
}

/** The most recent period whose mail day has come (today's, or the one before). */
export function latestDuePeriod(today: string): MonthlyPeriod {
  const due = periodDueOn(today);
  if (due) return due;
  const cur = periodContaining(today);
  const before = new Date(Date.parse(cur.start + "T00:00:00Z") - 86_400_000).toISOString().slice(0, 10);
  return periodContaining(before);
}

export interface SearchTermRow {
  searchTerm: string; campaignName: string; adGroupName: string;
  spend: number; sales: number; acos: number | null; orders: number;
  clicks: number; impressions: number; cpc: number; ctr: number;
}

export interface SheetDef { key: string; name: string; title: string; test: (r: SearchTermRow) => boolean }

const hasAcos = (r: SearchTermRow) => r.orders > 0 && r.sales > 0 && r.acos != null;

/** The four sheets, in mail order. ACOS bands do not overlap: 13 ≤ x < 25, 25 ≤ x ≤ 50, x > 50. */
export const SHEETS: SheetDef[] = [
  { key: "orders0", name: "Orders 0", title: "Orders 0 (spend with no order)", test: (r) => r.orders === 0 && r.spend > 0 },
  { key: "acos50", name: "ACOS above 50%", title: "ACOS above 50%", test: (r) => hasAcos(r) && r.acos! > 50 },
  { key: "acos25", name: "ACOS 25-50%", title: "ACOS 25% – 50%", test: (r) => hasAcos(r) && r.acos! >= 25 && r.acos! <= 50 },
  { key: "acos13", name: "ACOS 13-25%", title: "ACOS 13% – 25%", test: (r) => hasAcos(r) && r.acos! >= 13 && r.acos! < 25 },
];

const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

/** SellerMate get_search_term_performance row → SearchTermRow (ACOS recomputed from spend / sales). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toRow(r: any): SearchTermRow {
  const spend = n(r.spend ?? r.cost), sales = n(r.sales), clicks = n(r.clicks), impressions = n(r.impressions);
  return {
    searchTerm: String(r.searchTerm ?? "").trim(), campaignName: String(r.campaignName ?? ""), adGroupName: String(r.adGroupName ?? ""),
    spend, sales, acos: sales > 0 ? (spend / sales) * 100 : null, orders: n(r.orders), clicks, impressions,
    cpc: clicks > 0 ? spend / clicks : 0, ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
  };
}

/** Rows per sheet, highest spend first. */
export function bucketRows(rows: SearchTermRow[]): Record<string, SearchTermRow[]> {
  const out: Record<string, SearchTermRow[]> = {};
  for (const s of SHEETS) out[s.key] = rows.filter(s.test).sort((a, b) => b.spend - a.spend);
  return out;
}

export const dmy = (d: string) => `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;
