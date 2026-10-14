// Plain-language wording for the Master Product Summary popup. Presentation only: every sentence is
// built from numbers seasonalAnalytics already computed (metrics, analysis, stockCoverage,
// contributionSummary) — nothing here recalculates sales, growth, seasonality or status.

import { RULES, type Analysis, type MarketplaceSlice, type Metrics, type Seasonality, type Status, type StockCoverage } from "./seasonalAnalytics.ts";

const num = (v: number, dp = 1) => Number(v.toFixed(dp)).toLocaleString("en-IN");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FULL_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const day = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;

export const UNAVAILABLE = "Data unavailable";
/** "32.4 units/day", "0 units/day", or "Data unavailable" — missing is never shown as zero. */
export const perDay = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? UNAVAILABLE : `${num(v)} units/day`);
export const units = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? UNAVAILABLE : `${num(v, 0)} units`);
const andList = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

export const PLAIN_STATUS: Record<Status, string> = {
  "HIGH GROWTH": "Growing Fast",
  "UNUSUAL SPIKE": "Sudden Spike",
  "DEMAND DROP": "Sales Falling",
  "UNUSUAL DECLINE": "Sudden Drop",
  "SEASONAL HIGH": "Seasonal High",
  "SEASONAL LOW": "Seasonal Low",
  STABLE: "Stable",
  "LOW VOLUME": "Low Sales",
  "INSUFFICIENT DATA": "Not Enough Data",
};

const UP: Status[] = ["HIGH GROWTH", "UNUSUAL SPIKE", "SEASONAL HIGH"];
const DOWN: Status[] = ["DEMAND DROP", "UNUSUAL DECLINE", "SEASONAL LOW"];

/** "Sales are 85% higher than usual" — growthPct is the recent 30 days vs the overall average. */
export function salesChangeText(growthPct: number | null): string {
  if (growthPct === null || !Number.isFinite(growthPct)) return "Not enough history to compare";
  const p = Math.round(growthPct);
  return p === 0 ? "Sales are the same as usual" : `Sales are ${Math.abs(p)}% ${p > 0 ? "higher" : "lower"} than usual`;
}

export function seasonalityText(s: Seasonality): string {
  if (!s.determinable) return "Not enough history to confirm a seasonal pattern.";
  const full = (k: number) => FULL_MONTHS[k - 1];
  const hi = s.recurringHigh.map(full), lo = s.recurringLow.map(full);
  if (!hi.length && !lo.length) return "No clear seasonal pattern found.";
  const parts = [hi.length ? `sales usually increase during ${andList(hi)}` : "", lo.length ? `sales usually drop during ${andList(lo)}` : ""].filter(Boolean);
  return `Seasonal pattern detected: ${parts.join("; ")}.`;
}

export function stockLeft(c: StockCoverage): { value: string; sub: string; low: boolean } {
  switch (c.kind) {
    case "ok":
      return {
        value: `${num(c.days)} days`,
        sub: c.stock <= 0 ? "Out of stock" : `at current sales rate (${num(c.stock, 0)} ÷ ${num(c.salesPerDay)})`,
        low: c.days < RULES.lowStockCoverDays,
      };
    case "no-sales": return { value: "Stock coverage unavailable", sub: "No sales — coverage cannot be calculated", low: false };
    case "no-sales-data": return { value: "Stock coverage unavailable", sub: "Current sales data unavailable", low: false };
    case "no-stock-data": return { value: "Stock coverage unavailable", sub: "Stock data unavailable", low: false };
    case "scope-mismatch": return { value: "Stock coverage unavailable", sub: "Stock is shared across marketplaces — select all marketplaces", low: false };
  }
}

/** One short sentence answering "Why is this happening?". Uses the drivers classify() actually found. */
export function whyText(a: Analysis): string {
  const r = a.likelyReason;
  const found: string[] = [];
  if (/seasonal/i.test(r) && (a.status === "SEASONAL HIGH" || a.status === "SEASONAL LOW")) found.push(a.status === "SEASONAL HIGH" ? "This is the usual busy season for this product." : "This is the usual quiet season for this product.");
  if (/low inventory/.test(r)) found.push("Sales may be held back by low stock.");
  if (/improved stock availability/.test(r)) found.push("Sales picked up once stock was available again.");
  if (/increased advertising/.test(r)) found.push("Sales rose at the same time as advertising spend went up.");
  if (/decreased advertising/.test(r)) found.push("Sales fell at the same time as advertising spend went down.");
  if (found.length) return found.join(" ");
  switch (a.status) {
    case "HIGH GROWTH": return "Sales have been consistently higher than usual.";
    case "UNUSUAL SPIKE": return "Sales jumped recently, but not for long enough to call it a trend.";
    case "DEMAND DROP": return "Sales have been consistently lower than usual.";
    case "UNUSUAL DECLINE": return "Sales dropped recently, but not for long enough to call it a trend.";
    case "SEASONAL HIGH": return "This is the usual busy season for this product.";
    case "SEASONAL LOW": return "This is the usual quiet season for this product.";
    case "STABLE": return "Sales are in line with usual levels.";
    case "LOW VOLUME": return "This product sells too few units to show a reliable trend.";
    default: return "There is not enough sales history yet to judge the trend.";
  }
}

/** Direct business recommendation. Stock urgency uses the same StockCoverage as the "Stock Left" card. */
export function recommendationText(a: Analysis, c: StockCoverage | null): string[] {
  const out: string[] = [];
  if (c?.kind === "ok" && c.days < RULES.lowStockCoverDays) {
    out.push(c.stock <= 0
      ? "Out of stock — reorder now."
      : `Reorder now — only about ${num(c.days, 0)} day${Math.round(c.days) === 1 ? "" : "s"} of stock remain${Math.round(c.days) === 1 ? "s" : ""} at the current sales rate.`);
  }
  switch (a.status) {
    case "HIGH GROWTH": case "SEASONAL HIGH": out.push("Sales are growing strongly — keep enough stock available."); break;
    case "UNUSUAL SPIKE": out.push("Sales jumped suddenly — make sure it lasts before ordering extra stock."); break;
    case "DEMAND DROP": case "UNUSUAL DECLINE": out.push("Sales are falling — check stock, price and advertising."); break;
    case "SEASONAL LOW": out.push("Sales are in their usual seasonal dip — avoid over-stocking."); break;
    case "STABLE": out.push("Sales are stable — continue monitoring."); break;
    case "LOW VOLUME": out.push("Sales are low — review only if this product is important to you."); break;
    default: out.push("Not enough history yet — check again in a few weeks.");
  }
  if (a.peakApproaching) out.push("A usually busy month is coming up — check stock early.");
  return out;
}

/** "What we found" bullets. `stock`/`coverage` are omitted for a single SKU (stock is product-level). */
export function findings(m: Metrics, a: Analysis, opts: { stock?: number | null; coverage?: StockCoverage; driver?: { sku: string; sharePct: number } | null } = {}): string[] {
  const out: string[] = [];
  out.push(m.currentAvg === null ? "Current sales: data unavailable." : `Sales are currently ${perDay(m.currentAvg)}.`);
  out.push(m.baseline === null ? "Usual sales: data unavailable." : `Usual sales (overall average) are ${perDay(m.baseline)}.`);
  if (m.peakMonth && m.peakMonthRate !== null) out.push(`Best month was ${FULL_MONTHS[Number(m.peakMonth.slice(5, 7)) - 1]} ${m.peakMonth.slice(0, 4)}: ${units(m.peakMonthUnits)}, about ${perDay(m.peakMonthRate)}.`);
  if (m.recentAvg !== null && m.growthPct !== null) out.push(`Recent sales (last ${RULES.recentDays} days) are ${perDay(m.recentAvg)} — ${salesChangeText(m.growthPct).replace(/^Sales are /, "")}.`);
  const up = UP.includes(a.status), down = DOWN.includes(a.status);
  if ((up || down) && m.changeStart) out.push(`The ${up ? "increase" : "decrease"} started around ${day(m.changeStart)}.`);
  if (up && m.weeksUp > 0) out.push(`Sales were well above usual in ${m.weeksUp} of the last 4 weeks.`);
  if (down && m.weeksDown > 0) out.push(`Sales were well below usual in ${m.weeksDown} of the last 4 weeks.`);
  if (opts.driver) out.push(`${opts.driver.sku} accounts for ${opts.driver.sharePct}% of the change.`);
  if (opts.coverage) {
    out.push(opts.stock === null || opts.stock === undefined ? "Stock data unavailable." : `Current stock is ${units(opts.stock)}.`);
    const c = opts.coverage;
    if (c.kind === "ok") out.push(c.stock <= 0 ? "The product is out of stock." : `At the current sales rate, about ${num(c.days)} days of stock remain.`);
    else if (c.kind !== "no-stock-data") out.push(`Stock coverage unavailable — ${stockLeft(c).sub.toLowerCase()}.`);
  }
  out.push(a.seasonality.determinable ? seasonalityText(a.seasonality) : "Seasonality cannot be confirmed yet because there is not enough historical data.");
  return out;
}

// ── Marketplace comparison ──────────────────────────────────────────────────────────────────────

export type MarketplaceTrend = "up" | "down" | "steady" | "low";
/** Same status rules as the product, applied per marketplace. */
export const trendOf = (s: Status): MarketplaceTrend => (UP.includes(s) ? "up" : DOWN.includes(s) ? "down" : s === "STABLE" ? "steady" : "low");

export interface MarketplaceInsight {
  kind: "mixed" | "only-up" | "only-down" | "all-up" | "all-down";
  text: string;
  up: string[];
  down: string[];
}

const growthTag = (x: MarketplaceSlice) => (x.growth === null ? x.marketplace : `${x.marketplace} (${x.growth > 0 ? "+" : ""}${Math.round(x.growth)}%)`);

/** "Selling well on Amazon (+120%) but falling on Flipkart (−45%)." — null when there is nothing to compare. */
export function marketplaceInsight(slices: MarketplaceSlice[]): MarketplaceInsight | null {
  const judged = slices.filter((x) => trendOf(x.status) !== "low");
  if (judged.length < 2) return null;
  const up = judged.filter((x) => trendOf(x.status) === "up"), down = judged.filter((x) => trendOf(x.status) === "down");
  const steady = judged.filter((x) => trendOf(x.status) === "steady");
  const names = { up: up.map((x) => x.marketplace), down: down.map((x) => x.marketplace) };
  const list = (xs: MarketplaceSlice[]) => andList(xs.map(growthTag));
  const plain = (xs: MarketplaceSlice[]) => andList(xs.map((x) => x.marketplace));
  if (up.length && down.length) return { kind: "mixed", text: `Selling well on ${list(up)} but falling on ${list(down)}.`, ...names };
  if (up.length === judged.length) return { kind: "all-up", text: `Growing on every marketplace: ${list(up)}.`, ...names };
  if (down.length === judged.length) return { kind: "all-down", text: `Falling on every marketplace: ${list(down)}.`, ...names };
  if (up.length) return { kind: "only-up", text: `Growing only on ${list(up)} — steady on ${plain(steady)}.`, ...names };
  if (down.length) return { kind: "only-down", text: `Falling only on ${list(down)} — steady on ${plain(steady)}.`, ...names };
  return null;
}
