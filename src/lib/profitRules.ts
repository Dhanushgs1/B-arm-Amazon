// Rules for the "Profit & actions" page (pure, unit tested).
//
// Profit (the B-ARM ERP's figures, per report month): revenue and cost excl. tax and the margin
// between them, as its MIS Data's page shows them; minus ad spend excl. GST for the same month =
// profit after ads. Months the ERP has not received yet have no profit figure.
//
// Product actions (last 30 days): each product gets the most urgent of
//   Restock        sells, and its FBA stock is 0 or lasts under RESTOCK_DAYS at the current rate
//   Cut ads        ACOS is above the product's break-even ACOS (ads cost more than the margin they
//                  bring), or ad spend of at least NO_SALES_SPEND with no ad sales
//   Check quality  return rate at least QUALITY_RETURN_PCT on at least QUALITY_MIN_UNITS units
//   Raise ads      ACOS below half the break-even ACOS, sales not falling, stock for 45+ days
// Break-even ACOS = margin ÷ sales incl. tax (the ERP's figures for the product): at that ACOS the
// ad spend eats the whole margin on the sales the ads bring.

export interface ErpProfit {
  months: { month: string; marketplace: string; units: number; salesWithTax: number; revenue: number; cost: number; margin: number; linesWithoutCost: number }[];
  skus: { month: string; marketplace: string; sku: string; name: string; units: number; salesWithTax: number; revenue: number; cost: number; margin: number; noCost: boolean }[];
}
export interface ProductAd { channel: "amazon" | "flipkart" | "meesho"; sku: string; spend: number; sales: number; orders: number }

export const RESTOCK_DAYS = 21;
export const NO_SALES_SPEND = 500;
export const QUALITY_RETURN_PCT = 15;
export const QUALITY_MIN_UNITS = 10;
export const RAISE_STOCK_DAYS = 45;

export interface MonthProfit {
  month: string;
  marketplace: string;
  revenue: number;
  cost: number;
  margin: number;
  marginPct: number | null;
  /** Ad spend excl. GST for the month; null = no ad data for it. */
  adSpend: number | null;
  profitAfterAds: number | null;
  linesWithoutCost: number;
}

/** Profit per month and marketplace; `adSpendByMonth` keys are "YYYY-MM-01|Amazon". */
export function profitByMonth(erp: ErpProfit, adSpendByMonth: Map<string, number>): MonthProfit[] {
  return erp.months.map((m) => {
    const ad = adSpendByMonth.get(`${m.month}|${m.marketplace}`);
    const adSpend = ad === undefined ? null : ad;
    return {
      month: m.month, marketplace: m.marketplace, revenue: m.revenue, cost: m.cost, margin: m.margin,
      marginPct: m.revenue > 0 ? (m.margin / m.revenue) * 100 : null,
      adSpend, profitAfterAds: adSpend === null ? null : m.margin - adSpend, linesWithoutCost: m.linesWithoutCost,
    };
  });
}

/** Break-even ACOS per channel + SKU over every ERP month (null when the product has no cost on file). */
export function breakEvenAcos(erp: ErpProfit): Map<string, number | null> {
  const acc = new Map<string, { margin: number; sales: number; noCost: boolean }>();
  for (const s of erp.skus) {
    const k = `${s.marketplace.toLowerCase()}|${s.sku}`;
    const a = acc.get(k) ?? { margin: 0, sales: 0, noCost: false };
    a.margin += s.margin; a.sales += s.salesWithTax; a.noCost ||= s.noCost;
    acc.set(k, a);
  }
  return new Map([...acc].map(([k, a]) => [k, a.noCost || a.sales <= 0 ? null : (a.margin / a.sales) * 100]));
}

export type Action = "Restock" | "Cut ads" | "Check quality" | "Raise ads";
export interface ActionInput {
  units: number;
  revenue: number;
  growthPct: number | null;
  returnRatePct: number | null;
  stock: number | null;
  daysOfCover: number | null;
  adSpend: number;
  adSales: number;
  breakEvenAcos: number | null;
}
export interface ActionResult { action: Action | null; reason: string; acos: number | null }

const pct1 = (v: number) => `${v.toFixed(1)}%`;

export function productAction(p: ActionInput): ActionResult {
  const acos = p.adSales > 0 ? (p.adSpend / p.adSales) * 100 : null;
  if (p.units > 0 && p.stock !== null && (p.stock === 0 || (p.daysOfCover !== null && p.daysOfCover < RESTOCK_DAYS))) {
    return { action: "Restock", acos, reason: p.stock === 0 ? `0 in FBA while still selling (${p.units} units in 30 days)` : `about ${Math.floor(p.daysOfCover!)} days of FBA stock left` };
  }
  if (p.adSpend >= NO_SALES_SPEND && p.adSales === 0) return { action: "Cut ads", acos, reason: `₹${Math.round(p.adSpend).toLocaleString("en-IN")} ad spend with no ad sales` };
  if (acos !== null && p.breakEvenAcos !== null && acos > p.breakEvenAcos) {
    return { action: "Cut ads", acos, reason: `ACOS ${pct1(acos)} is above its break-even ${pct1(p.breakEvenAcos)}: ads cost more than the margin they bring` };
  }
  if (p.returnRatePct !== null && p.returnRatePct >= QUALITY_RETURN_PCT && p.units >= QUALITY_MIN_UNITS) {
    return { action: "Check quality", acos, reason: `${pct1(p.returnRatePct)} of units returned` };
  }
  if (acos !== null && p.breakEvenAcos !== null && acos < p.breakEvenAcos / 2 && (p.growthPct === null || p.growthPct >= 0) && (p.daysOfCover === null || p.daysOfCover >= RAISE_STOCK_DAYS)) {
    return { action: "Raise ads", acos, reason: `ACOS ${pct1(acos)} is well under its break-even ${pct1(p.breakEvenAcos)}, sales steady or rising` };
  }
  return { action: null, acos, reason: "" };
}

/** Ad spend excl. GST per report month ("YYYY-MM-01") and marketplace, from daily series. */
export function adSpendByMonth(dates: string[], ads: { id: string; spend: (number | null)[] }[]): Map<string, number> {
  const name: Record<string, string> = { amazon: "Amazon", flipkart: "Flipkart", meesho: "Meesho" };
  const out = new Map<string, number>();
  for (const a of ads) {
    const m = name[a.id];
    if (!m) continue;
    a.spend.forEach((v, i) => {
      if (v === null) return;
      const k = `${dates[i].slice(0, 7)}-01|${m}`;
      out.set(k, (out.get(k) ?? 0) + v);
    });
  }
  return out;
}
