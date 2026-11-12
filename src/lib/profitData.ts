// Readers for the "Profit & actions" page (server side; the browser calls them through
// /api/data/loader — see viaServer.ts). Rules: profitRules.ts.
//
//   loadErpProfit()       the B-ARM ERP's lines (mis_datas_mv: revenue and cost excl. tax, margin,
//                         from its monthly invoice reports) summed per month, marketplace and SKU
//   loadProductAds(s, e)  ad spend / ad sales per SKU for [s, e]:
//                           Amazon   Sponsored Products card rows by advertised SKU, plus Brand / Display
//                                    campaign spend spread over the SKUs mapped to each campaign (the
//                                    Upload page mapping — the same rule as the Ad Spend / Historical reports)
//                           Flipkart barm_daily_fk_ads by SKU, campaign performance for days before it began
//                           Meesho   barm_daily_ms_barm_ads by SKU (sales = ad orders × average price)

import { fetchAllRows } from "@/lib/amazonReportShared";
import { inBrowser, viaServer } from "@/lib/viaServer";
import { loadAmazonAdTables } from "@/lib/amazonAdTables";
import { amazonCardSpendRows, brandDisplayAdRows } from "@/lib/amazonAdSourceRules";
import { fkDailyFirstDay, loadMarketplaceAds } from "@/lib/overallData";
import type { ErpProfit, ProductAd } from "@/lib/profitRules";

const MARKETS = ["Amazon", "Flipkart", "Meesho"] as const;
const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const addDays = (iso: string, k: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); };

export async function loadErpProfit(): Promise<ErpProfit> {
  if (inBrowser()) return viaServer<ErpProfit>("loadErpProfit", []);
  const rows = await fetchAllRows(
    "mis_datas_mv",
    (q) => q.in("marketplace", [...MARKETS]),
    "line_uid",
    "line_uid,marketplace,invoice_month,sku,product_name,quantity,net_sales_with_tax,revenue_excl_tax,cost_excl_tax,margin",
  );
  const months = new Map<string, ErpProfit["months"][number]>();
  const skus = new Map<string, ErpProfit["skus"][number]>();
  for (const r of rows as Record<string, unknown>[]) {
    const month = String(r.invoice_month ?? "").slice(0, 10);
    const market = String(r.marketplace);
    if (!month) continue;
    const qty = n(r.quantity), rev = n(r.revenue_excl_tax), cost = n(r.cost_excl_tax), margin = n(r.margin), gross = n(r.net_sales_with_tax);
    const noCost = qty > 0 && cost === 0;
    const mk = `${month}|${market}`;
    const m = months.get(mk) ?? { month, marketplace: market, units: 0, salesWithTax: 0, revenue: 0, cost: 0, margin: 0, linesWithoutCost: 0 };
    m.units += qty; m.salesWithTax += gross; m.revenue += rev; m.cost += cost; m.margin += margin; if (noCost) m.linesWithoutCost++;
    months.set(mk, m);
    const sku = String(r.sku ?? "").trim();
    if (!sku) continue;
    const sk = `${mk}|${sku}`;
    const s = skus.get(sk) ?? { month, marketplace: market, sku, name: String(r.product_name ?? "") || sku, units: 0, salesWithTax: 0, revenue: 0, cost: 0, margin: 0, noCost: false };
    s.units += qty; s.salesWithTax += gross; s.revenue += rev; s.cost += cost; s.margin += margin; if (noCost) s.noCost = true;
    if (!s.name && r.product_name) s.name = String(r.product_name);
    skus.set(sk, s);
  }
  return { months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)), skus: [...skus.values()] };
}

export async function loadProductAds(start: string, end: string): Promise<ProductAd[]> {
  if (inBrowser()) return viaServer<ProductAd[]>("loadProductAds", [start, end]);
  const out = new Map<string, ProductAd>();
  const add = (channel: ProductAd["channel"], sku: string, spend: number, sales: number, orders: number) => {
    const s = sku.trim();
    if (!s || (!spend && !sales && !orders)) return;
    const k = `${channel}|${s}`;
    const a = out.get(k) ?? { channel, sku: s, spend: 0, sales: 0, orders: 0 };
    a.spend += spend; a.sales += sales; a.orders += orders;
    out.set(k, a);
  };

  const [amz, map, fkDaily, fkFirst, ms] = await Promise.all([
    loadAmazonAdTables(start, end),
    fetchAllRows("barm_amazon_campaign_sku_map", (q) => q, ["campaign_name", "sku"]).catch(() => []),
    fetchAllRows("barm_daily_fk_ads", (q) => q.gte("report_date", start).lte("report_date", end)),
    fkDailyFirstDay(),
    loadMarketplaceAds("meesho", start, end),
  ]);
  // Amazon
  const { spRows, campaignRows } = amazonCardSpendRows(amz.sp, amz.sb, amz.sd);
  for (const r of spRows) add("amazon", String(r.advertised_sku ?? ""), n(r.spend), n(r.sales_7d), n(r.orders_7d));
  for (const r of brandDisplayAdRows(campaignRows, map as Record<string, unknown>[], () => undefined)) add("amazon", String(r.advertised_sku ?? ""), n(r.spend), 0, 0);
  // Flipkart
  for (const r of fkDaily as Record<string, unknown>[]) add("flipkart", String(r.sku ?? ""), n(r.ad_spend), n(r.revenue), n(r.units_sold));
  if (fkFirst && start < fkFirst) {
    const older = await fetchAllRows("barm_flipkart_campaign_performance", (q) => q.gte("report_date", start).lte("report_date", end < fkFirst ? end : addDays(fkFirst, -1)));
    for (const r of older as Record<string, unknown>[]) add("flipkart", String(r.sku_id ?? ""), n(r.ad_spend), n(r.total_revenue_rs), n(r.total_orders));
  }
  // Meesho (rows are per SKU: id = SKU)
  for (const r of ms) add("meesho", r.id, r.spend, r.sales, r.orders);
  return [...out.values()];
}
