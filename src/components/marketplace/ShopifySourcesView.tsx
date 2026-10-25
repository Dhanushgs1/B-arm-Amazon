"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useDashboard } from "@/lib/DashboardContext";
import { KPICard } from "@/components/KPICard";
import { TrendChart } from "@/components/TrendChart";
import { ProductSearchBox } from "@/components/marketplace/ProductSearchBox";
import { fetchShopifyOrders } from "@/lib/shopifyOrders";
import { fetchAllRows } from "@/lib/amazonReportShared";
import { shopifyProductSales, SHOPIFY_SOURCE_LABELS } from "@/lib/shopifyOrderRules";
import { resolveDailySpend, type AdSpendRow, type ResolvedSpend } from "@/lib/adSpendDailyRules";
import { shopifySourceDetail, isPaidSource } from "@/lib/shopifySourceRules";
import { matchesProductQuery } from "@/lib/productSearch";
import { cn } from "@/lib/utils";

const cur = (v: number) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(v || 0))}`;
const cur2 = (v: number) => `₹${new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v || 0)}`;
const num = (v: number) => new Intl.NumberFormat("en-IN").format(Math.round(v || 0));
const pct = (v: number) => `${Math.round((v || 0) * 1000) / 10}%`;
const dot = (iso: string) => iso.split("-").reverse().join(".");
const shortDay = (iso: string) => iso.slice(8, 10) + "." + iso.slice(5, 7);
const time = (ts: string) => new Date(ts).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
const addDays = (iso: string, k: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + k);
  return d.toISOString().slice(0, 10);
};

const SOURCES = ["google_ads", "meta_ads", "google_organic", "direct", "other", "unknown"] as const;
const SOURCE_COLOUR: Record<string, string> = {
  google_ads: "#4285F4", meta_ads: "#0866FF", google_organic: "#34A853", direct: "#8B5CF6", other: "#F59E0B", unknown: "#94A3B8",
};
const SPEND_TABLE: Record<string, string> = { google_ads: "barm_daily_google_ad_spend", meta_ads: "barm_daily_social_media" };

function Card({ title, note, children, className }: { title: string; note?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("glass rounded-2xl border border-border p-5 shadow-sm space-y-3 min-w-0", className)}>
      <h3 className="text-xs font-black uppercase tracking-widest text-muted-foreground">{title}</h3>
      {children}
      {note && <p className="text-[11px] text-muted-foreground">{note}</p>}
    </div>
  );
}

async function loadSpend(source: string, start: string, end: string): Promise<ResolvedSpend> {
  // windows that touch the range, plus a week either side so a missing day can be worked out
  const rows = (await fetchAllRows(SPEND_TABLE[source], (q) => q.lte("report_start", addDays(end, 6)).gte("report_end", addDays(start, -6)))) as AdSpendRow[];
  return resolveDailySpend(rows, start, end);
}

/** The Shopify tab's "Google & Meta" page: where Shopify orders came from (order source from the
 *  order's landing / referring page) next to the Google Ads and Meta spend uploads. */
export function ShopifySourcesView() {
  const router = useRouter();
  const params = useSearchParams();
  const { startDate: start, endDate: end } = useDashboard();
  const requested = params?.get("source") ?? "";
  const selected: string = (SOURCES as readonly string[]).includes(requested) ? requested : "google_ads";
  const [campaignSearch, setCampaignSearch] = useState("");
  const [productSearch, setProductSearch] = useState("");

  const enabled = !!start && !!end;
  const ordersQ = useQuery({ queryKey: ["shopify-orders-all"], queryFn: fetchShopifyOrders });
  const googleQ = useQuery({ queryKey: ["ad-spend", "google_ads", start, end], queryFn: () => loadSpend("google_ads", start, end), enabled });
  const metaQ = useQuery({ queryKey: ["ad-spend", "meta_ads", start, end], queryFn: () => loadSpend("meta_ads", start, end), enabled });

  const pick = (s: string) => {
    setCampaignSearch("");
    setProductSearch("");
    router.replace(`/dashboard/shopify/sources?source=${s}`, { scroll: false });
  };

  if (!enabled || ordersQ.isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-10 justify-center">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading Shopify orders…
      </div>
    );
  }
  if (ordersQ.error || !ordersQ.data) {
    return <p className="text-xs font-semibold text-red-600 dark:text-red-400">Couldn&apos;t load Shopify orders — {ordersQ.error instanceof Error ? ordersQ.error.message : String(ordersQ.error)}</p>;
  }

  const orders = ordersQ.data;
  const spendFor = (s: string): ResolvedSpend | null => (s === "google_ads" ? googleQ.data ?? null : s === "meta_ads" ? metaQ.data ?? null : null);
  const details = SOURCES.map((s) => shopifySourceDetail(orders, s, spendFor(s), start, end));
  const totalSales = details.reduce((t, d) => t + d.sales, 0);
  const detail = details.find((d) => d.source === selected)!;
  const paid = isPaidSource(selected);
  const spendQ = selected === "google_ads" ? googleQ : selected === "meta_ads" ? metaQ : null;
  const label = SHOPIFY_SOURCE_LABELS[selected] ?? selected;
  const colour = SOURCE_COLOUR[selected] ?? "#64748B";
  const derivedDays = detail.spend ? detail.spend.days.filter((d) => d.source === "derived").length : 0;

  const daily = detail.daily.map((d) => ({ ...d, day: shortDay(d.date), spend: d.spend ?? 0 }));
  const products = shopifyProductSales(detail.orders);
  const shownProducts = products.filter((p) => matchesProductQuery(productSearch, p.title, p.skus));
  const campaigns = detail.spend?.campaigns ?? [];
  const shownCampaigns = campaigns.filter((c) => matchesProductQuery(campaignSearch, c.name));

  return (
    <div className="space-y-5">
      {/* every source side by side */}
      <Card title="All order sources" note="Source = where the visit that placed the order came from (ad click IDs such as gclid / fbclid on the landing page, or the referring site). Spend comes from the Google Ads and Meta campaign uploads; ROAS uses only the days whose spend is known. Cancelled orders are not in Sales.">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                <th className="py-2 pr-3 font-black">Source</th>
                <th className="py-2 pr-3 font-black text-right">Orders</th>
                <th className="py-2 pr-3 font-black text-right">Sales</th>
                <th className="py-2 pr-3 font-black text-right">Share</th>
                <th className="py-2 pr-3 font-black text-right">Ad spend</th>
                <th className="py-2 pr-3 font-black text-right">ROAS</th>
                <th className="py-2 font-black text-right">Cost / order</th>
              </tr>
            </thead>
            <tbody>
              {details.filter((d) => d.orders.length || isPaidSource(d.source)).map((d) => (
                <tr
                  key={d.source}
                  onClick={() => pick(d.source)}
                  className={cn("border-b border-border/60 cursor-pointer hover:bg-muted/40", d.source === selected && "bg-muted/60")}
                >
                  <td className="py-2 pr-3 font-bold whitespace-nowrap">
                    <span className="inline-block w-2 h-2 rounded-full mr-2" style={{ background: SOURCE_COLOUR[d.source] }} />
                    {SHOPIFY_SOURCE_LABELS[d.source] ?? d.source}
                  </td>
                  <td className="py-2 pr-3 text-right">{num(d.netOrders)}</td>
                  <td className="py-2 pr-3 text-right font-bold">{cur(d.sales)}</td>
                  <td className="py-2 pr-3 text-right text-muted-foreground">{pct(totalSales ? d.sales / totalSales : 0)}</td>
                  <td className="py-2 pr-3 text-right">{isPaidSource(d.source) ? (d.spend ? cur(d.spend.spend) : "…") : "—"}</td>
                  <td className="py-2 pr-3 text-right font-bold">{d.roas != null ? `${d.roas.toFixed(2)}x` : "—"}</td>
                  <td className="py-2 text-right">{d.costPerOrder != null ? cur(d.costPerOrder) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* source picker */}
      <div className="flex flex-wrap gap-2">
        {SOURCES.filter((s) => isPaidSource(s) || details.find((d) => d.source === s)!.orders.length).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => pick(s)}
            className={cn(
              "px-3.5 py-1.5 rounded-full text-xs font-bold border transition-colors",
              s === selected ? "text-white border-transparent shadow-sm" : "border-border text-muted-foreground hover:text-foreground",
            )}
            style={s === selected ? { background: SOURCE_COLOUR[s] } : undefined}
          >
            {SHOPIFY_SOURCE_LABELS[s] ?? s}
          </button>
        ))}
      </div>

      <div className="space-y-1">
        <h2 className="text-xl font-black tracking-tight" style={{ color: colour }}>{label}</h2>
        <p className="text-[11px] text-muted-foreground">
          {dot(start)} – {dot(end)}
          {paid && detail.spend && (
            <>
              {" "}· Spend known for {detail.spend.coveredDays} of {detail.spend.totalDays} days
              {derivedDays ? ` (${derivedDays} worked out exactly from 7-day reports)` : ""}
              {detail.spend.coveredDays < detail.spend.totalDays ? " — days without a spend report are left out of ROAS and cost per order" : ""}
            </>
          )}
        </p>
        {paid && spendQ?.error && (
          <p className="text-xs font-semibold text-red-600 dark:text-red-400">Couldn&apos;t load {label} spend — {spendQ.error instanceof Error ? spendQ.error.message : String(spendQ.error)}</p>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <KPICard title="Sales" value={cur(detail.sales)} subtitle={`${num(detail.netOrders)} orders · cancelled excluded`} accent="green" />
        <KPICard title="Orders" value={num(detail.netOrders)} subtitle={`AOV ${cur(detail.aov)}`} accent="blue" />
        {paid ? (
          <>
            <KPICard title="Ad Spend" value={detail.spend ? cur(detail.spend.spend) : "…"} subtitle={detail.spend ? `${detail.spend.coveredDays}/${detail.spend.totalDays} days on file` : "Loading…"} accent="pink" />
            <KPICard title="ROAS" value={detail.roas != null ? `${detail.roas.toFixed(2)}x` : "—"} subtitle={`${cur(detail.coveredSales)} sales on those days`} accent="purple" />
            <KPICard title="Cost / Order" value={detail.costPerOrder != null ? cur(detail.costPerOrder) : "—"} subtitle={`${num(detail.coveredNetOrders)} orders on those days`} inverseTrend accent="orange" />
            {selected === "google_ads" ? (
              <KPICard title="Clicks · CPC" value={detail.spend ? num(detail.spend.clicks) : "…"} subtitle={detail.cpc != null ? `CPC ${cur2(detail.cpc)}` : "No clicks on file"} accent="cyan" />
            ) : (
              <KPICard title="Campaigns" value={num(campaigns.length)} subtitle="with spend in these dates" accent="cyan" />
            )}
          </>
        ) : (
          <KPICard title="Share of Sales" value={pct(totalSales ? detail.sales / totalSales : 0)} subtitle="of all Shopify sales" accent="purple" />
        )}
      </div>

      <div className={cn("grid grid-cols-1 gap-4", paid && "lg:grid-cols-2")}>
        <TrendChart title={`Daily Sales from ${label}`} data={daily} dataKey="sales" xAxisKey="day" color={colour} type="area" height={240} valuePrefix="₹" />
        {paid && <TrendChart title={`Daily ${label} Spend`} data={daily} dataKey="spend" xAxisKey="day" color="#EC4899" type="line" height={240} valuePrefix="₹" />}
      </div>

      {paid && (
        <Card title={`${label} Campaigns · ${num(campaigns.length)}`} note="Spend per campaign on the days whose spend is known, from the campaign report uploads (overlapping 7-day and 1-day reports are never added together).">
          {campaigns.length > 0 && <ProductSearchBox value={campaignSearch} onChange={setCampaignSearch} shown={shownCampaigns.length} total={campaigns.length} />}
          {!detail.spend ? (
            <p className="text-xs text-muted-foreground py-2">Loading spend…</p>
          ) : campaigns.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">No {label} spend on file for these dates.</p>
          ) : (
            <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-background">
                  <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                    <th className="py-2 pr-3 font-black">Campaign</th>
                    <th className="py-2 pr-3 font-black text-right">Spend</th>
                    {selected === "google_ads" && <th className="py-2 pr-3 font-black text-right">Clicks</th>}
                    {selected === "google_ads" && <th className="py-2 pr-3 font-black text-right">CPC</th>}
                    <th className="py-2 font-black min-w-[120px]">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {shownCampaigns.map((c) => {
                    const share = detail.spend!.spend ? c.spend / detail.spend!.spend : 0;
                    return (
                      <tr key={c.name} className="border-b border-border/60">
                        <td className="py-2 pr-3 font-semibold min-w-[220px]">{c.name}</td>
                        <td className="py-2 pr-3 text-right font-bold whitespace-nowrap">{cur2(c.spend)}</td>
                        {selected === "google_ads" && <td className="py-2 pr-3 text-right">{num(c.clicks)}</td>}
                        {selected === "google_ads" && <td className="py-2 pr-3 text-right">{c.clicks ? cur2(c.spend / c.clicks) : "—"}</td>}
                        <td className="py-2">
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
                              <div className="h-full rounded-full" style={{ width: `${Math.max(2, share * 100)}%`, background: "#EC4899" }} />
                            </div>
                            <span className="w-11 text-right text-muted-foreground">{pct(share)}</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      <Card title={`Products sold via ${label} · ${num(products.length)}`} note="Item value = price × quantity − line discount (no shipping or tax). Cancelled orders are left out.">
        {products.length > 0 && <ProductSearchBox value={productSearch} onChange={setProductSearch} shown={shownProducts.length} total={products.length} />}
        {products.length === 0 ? (
          <p className="text-xs text-muted-foreground py-2">No {label} orders in these dates.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                  <th className="py-2 pr-3 font-black">Product</th>
                  <th className="py-2 pr-3 font-black">SKU</th>
                  <th className="py-2 pr-3 font-black text-right">Units</th>
                  <th className="py-2 pr-3 font-black text-right">Orders</th>
                  <th className="py-2 font-black text-right">Item value</th>
                </tr>
              </thead>
              <tbody>
                {shownProducts.map((p) => (
                  <tr key={p.title} className="border-b border-border/60">
                    <td className="py-2 pr-3 font-semibold min-w-[220px]">{p.title}</td>
                    <td className="py-2 pr-3 text-muted-foreground whitespace-nowrap">{p.skus.join(", ") || "—"}</td>
                    <td className="py-2 pr-3 text-right">{num(p.units)}</td>
                    <td className="py-2 pr-3 text-right">{num(p.orders)}</td>
                    <td className="py-2 text-right font-bold whitespace-nowrap">{cur(p.itemSales)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title={`${label} Orders · ${num(detail.orders.length)}`}>
        {detail.orders.length === 0 ? (
          <p className="text-xs text-muted-foreground py-2">No {label} orders in these dates.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                  <th className="py-2 pr-3 font-black">Order</th>
                  <th className="py-2 pr-3 font-black">Date</th>
                  <th className="py-2 pr-3 font-black">Items</th>
                  <th className="py-2 pr-3 font-black">Payment</th>
                  <th className="py-2 font-black text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {detail.orders.map((o) => (
                  <tr key={o.order_gid} className={cn("border-b border-border/60 align-top", o.is_cancelled && "opacity-60")}>
                    <td className="py-2 pr-3 font-bold whitespace-nowrap">
                      {o.order_name}
                      {o.is_cancelled && <span className="ml-1.5 px-1.5 py-0.5 rounded bg-red-500/10 text-red-600 dark:text-red-400 text-[9px] font-black uppercase">Cancelled</span>}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">{dot(o.order_date)} <span className="text-muted-foreground">{time(o.order_created_at)}</span></td>
                    <td className="py-2 pr-3 min-w-[220px]">{o.items.map((i) => i.title).filter(Boolean).join(" · ") || "—"}</td>
                    <td className="py-2 pr-3 capitalize">{o.financial_status ?? "—"}</td>
                    <td className={cn("py-2 text-right font-bold", o.is_cancelled && "line-through")}>{cur2(o.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
