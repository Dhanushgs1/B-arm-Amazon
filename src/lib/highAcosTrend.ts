// High ACOS trend — the daily "High ACOS" email (sheet "Mail to be triggered", row 2): every
// campaign whose ACOS over the last 7 days is above the Settings threshold (default 14%), with its
// ACOS for each of those 7 days side by side so the reader can see whether it is getting better or
// worse, not just a single number.
//
// Source: SellerMate get_campaign_performance, one call per day (the same single-day call the
// Overview KPI cards trust), all statuses — a campaign paused mid-week still spent on its earlier
// days. SellerMate's most recent day can be partial, which the email footnote says.
//
// Pure aggregation (buildAcosTrend) is separate from the fetch so it can be tested offline.

/** Campaigns below this 7-day spend are left out: a single ₹30 click with no sale would otherwise
 *  read as a "no sales" campaign and bury the ones actually costing money. */
export const HIGH_ACOS_MIN_SPEND = 200;
export const HIGH_ACOS_DEFAULT_THRESHOLD = 14;
export const HIGH_ACOS_DAYS = 7;

export interface DayCampaignRow {
  campaignId?: string | number;
  campaignName: string;
  spend?: number;
  sales?: number;
  orders?: number;
}

export interface AcosDay {
  date: string;
  spend: number;
  sales: number;
  /** null = no spend that day (nothing to measure); Infinity is never used — see noSales. */
  acos: number | null;
  /** Spent money that day with zero attributed sales. */
  noSales: boolean;
}

export interface AcosTrendRow {
  campaignId: string;
  name: string;
  days: AcosDay[];
  spend: number;
  sales: number;
  orders: number;
  /** 7-day ACOS in %, null when there were no sales at all (spend with no sales). */
  acos: number | null;
  daysAbove: number;
  /** Last 3 days' ACOS vs the 4 days before them. */
  trend: "worse" | "better" | "flat" | "new";
}

// Rounded to 2 decimals so float noise (980 / 7000 * 100 = 14.000000000000002) never pushes a
// campaign sitting exactly at the threshold over it.
const acosOf = (spend: number, sales: number) => (sales > 0 ? Math.round((spend / sales) * 10_000) / 100 : null);

function trendOf(days: AcosDay[], threshold: number): AcosTrendRow["trend"] {
  const sum = (xs: AcosDay[]) => xs.reduce((a, d) => ({ spend: a.spend + d.spend, sales: a.sales + d.sales }), { spend: 0, sales: 0 });
  const early = sum(days.slice(0, days.length - 3));
  const late = sum(days.slice(-3));
  if (early.spend <= 0) return "new";
  // No-sales windows compare as "very high" rather than as missing.
  const a = early.sales > 0 ? (early.spend / early.sales) * 100 : 999;
  const b = late.sales > 0 ? (late.spend / late.sales) * 100 : late.spend > 0 ? 999 : a;
  // Moves smaller than a quarter of the threshold (3.5 points at 14%) read as noise.
  const band = Math.max(2, threshold / 4);
  return b > a + band ? "worse" : b < a - band ? "better" : "flat";
}

/** perDay: one entry per date, oldest first, each holding that day's campaign rows. */
export function buildAcosTrend(
  perDay: { date: string; rows: DayCampaignRow[] }[],
  threshold = HIGH_ACOS_DEFAULT_THRESHOLD,
  minSpend = HIGH_ACOS_MIN_SPEND,
): AcosTrendRow[] {
  const byId = new Map<string, { name: string; days: Map<string, { spend: number; sales: number; orders: number }> }>();
  for (const { date, rows } of perDay) {
    for (const r of rows) {
      if (!r.campaignName) continue;
      const id = String(r.campaignId ?? r.campaignName);
      let c = byId.get(id);
      if (!c) { c = { name: r.campaignName, days: new Map() }; byId.set(id, c); }
      const d = c.days.get(date) || { spend: 0, sales: 0, orders: 0 };
      d.spend += Number(r.spend) || 0;
      d.sales += Number(r.sales) || 0;
      d.orders += Number(r.orders) || 0;
      c.days.set(date, d);
    }
  }

  const out: AcosTrendRow[] = [];
  for (const [campaignId, c] of byId) {
    const days: AcosDay[] = perDay.map(({ date }) => {
      const d = c.days.get(date) || { spend: 0, sales: 0, orders: 0 };
      return { date, spend: d.spend, sales: d.sales, acos: d.spend > 0 ? acosOf(d.spend, d.sales) : null, noSales: d.spend > 0 && d.sales <= 0 };
    });
    const spend = days.reduce((a, d) => a + d.spend, 0);
    const sales = days.reduce((a, d) => a + d.sales, 0);
    const orders = [...c.days.values()].reduce((a, d) => a + d.orders, 0);
    if (spend < minSpend) continue;
    const acos = acosOf(spend, sales);
    if (acos !== null && acos <= threshold) continue;
    out.push({
      campaignId, name: c.name, days, spend, sales, orders, acos,
      daysAbove: days.filter((d) => d.noSales || (d.acos !== null && d.acos > threshold)).length,
      trend: trendOf(days, threshold),
    });
  }
  // Biggest spend first: that is where the over-threshold ACOS costs the most.
  return out.sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name));
}

/** The last `n` complete IST dates ending yesterday, oldest first (YYYY-MM-DD). */
export function lastIstDates(n = HIGH_ACOS_DAYS, now = new Date()): string[] {
  const istToday = new Date(now.getTime() + 5.5 * 3_600_000);
  istToday.setUTCHours(0, 0, 0, 0);
  const out: string[] = [];
  for (let i = n; i >= 1; i--) out.push(new Date(istToday.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  return out;
}

/** CSV of every row (the email body may stop early to stay under Gmail's clipping size). */
export function acosTrendCsv(rows: AcosTrendRow[], dates: string[]): string {
  const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const cell = (d: AcosDay) => (d.noSales ? "No sales" : d.acos === null ? "" : d.acos.toFixed(1));
  const lines = [
    ["Campaign", ...dates.map((d) => `ACOS % ${d}`), "7-day ACOS %", "7-day spend", "7-day sales", "Orders", "Days above limit", "Trend"].map(q).join(","),
    ...rows.map((r) => [r.name, ...r.days.map(cell), r.acos === null ? "No sales" : r.acos.toFixed(1), r.spend.toFixed(2), r.sales.toFixed(2), r.orders, r.daysAbove, r.trend].map(q).join(",")),
  ];
  return "﻿" + lines.join("\r\n");
}
