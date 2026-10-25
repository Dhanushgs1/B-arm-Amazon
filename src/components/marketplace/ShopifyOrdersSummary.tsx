"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useDashboard } from "@/lib/DashboardContext";
import { KPICard } from "@/components/KPICard";
import { fetchShopifySummary } from "@/lib/shopifyOrders";
import { ShopifyBreakdowns } from "@/components/marketplace/ShopifyBreakdowns";
import { cn } from "@/lib/utils";

const cur = (v: number) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(v || 0))}`;
const cur2 = (v: number) => `₹${new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v || 0)}`;
const num = (v: number) => new Intl.NumberFormat("en-IN").format(Math.round(v || 0));
const growth = (now: number, before: number): number | undefined =>
  before > 0 ? Math.round(((now - before) / before) * 1000) / 10 : undefined;
const dot = (isoDate: string) => isoDate.split("-").reverse().join(".");
const time = (ts: string) =>
  new Date(ts).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });

// Shopify's version of ChannelSummaryStrip (same cards and layout) plus the selected range's order
// list. Its own strip because Shopify counts cancellations, not returns, and AOV divides by Net
// Orders — see shopifyOrders.ts for the rules.
export function ShopifyOrdersSummary() {
  const { startDate, endDate } = useDashboard();
  const { data, isLoading, error } = useQuery({
    queryKey: ["shopify-summary", startDate, endDate],
    queryFn: () => fetchShopifySummary(startDate, endDate),
    enabled: !!startDate && !!endDate,
  });

  return (
    <>
      <div className="glass rounded-2xl border border-border p-5 shadow-sm space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-xs font-black uppercase tracking-widest text-muted-foreground">Summary</h3>
          {data && (
            <span className="text-[11px] text-muted-foreground">
              {dot(data.currentRange.start)} – {dot(data.currentRange.end)} · vs {dot(data.previousRange.start)} – {dot(data.previousRange.end)}
            </span>
          )}
        </div>

        {(isLoading || (!data && !error)) && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-6 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading Shopify summary…
          </div>
        )}
        {error && (
          <p className="text-xs font-semibold text-red-600 dark:text-red-400">
            Couldn&apos;t load the summary — {error instanceof Error ? error.message : String(error)}
          </p>
        )}

        {data && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
              <KPICard
                title="Sales"
                value={cur(data.current.sales)}
                subtitle={`Last period ${cur(data.previous.sales)}`}
                trend={growth(data.current.sales, data.previous.sales)}
                accent="green"
              />
              <KPICard
                title="Orders"
                value={num(data.current.orders)}
                subtitle={`${num(data.current.units)} units in net orders`}
                trend={growth(data.current.orders, data.previous.orders)}
                accent="blue"
              />
              <KPICard
                title="Cancelled"
                value={num(data.current.cancelled)}
                subtitle="Kept in the list, not in Sales"
                trend={growth(data.current.cancelled, data.previous.cancelled)}
                inverseTrend
                accent="orange"
              />
              <KPICard
                title="Net Orders"
                value={num(data.current.netOrders)}
                subtitle="Orders − Cancelled"
                trend={growth(data.current.netOrders, data.previous.netOrders)}
                accent="cyan"
              />
              <KPICard
                title="Avg Order Value"
                value={cur(data.current.aov)}
                subtitle="Sales ÷ Net Orders"
                trend={growth(data.current.aov, data.previous.aov)}
                accent="purple"
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              From Shopify order webhooks (barm_shopify_orders_v2). Sales = order total incl. tax and shipping, cancelled
              orders excluded; Shopify test orders are never counted. Dates are the order&apos;s creation day in India time.
              {data.dataThrough && data.dataThrough < data.currentRange.end
                ? ` Latest order is from ${dot(data.dataThrough)}.`
                : ""}
            </p>
          </>
        )}
      </div>

      {data && <ShopifyBreakdowns orders={data.orders} start={data.currentRange.start} end={data.currentRange.end} />}

      {data && (
        <div className="glass rounded-2xl border border-border p-5 shadow-sm">
          <h3 className="text-xs font-black uppercase tracking-widest text-muted-foreground mb-3">
            Orders · {num(data.orders.length)}
          </h3>
          {data.orders.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4">No Shopify orders in the selected dates.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                    <th className="py-2 pr-3 font-black">Order</th>
                    <th className="py-2 pr-3 font-black">Date</th>
                    <th className="py-2 pr-3 font-black">Items</th>
                    <th className="py-2 pr-3 font-black text-right">Qty</th>
                    <th className="py-2 pr-3 font-black">Payment</th>
                    <th className="py-2 pr-3 font-black">Fulfilment</th>
                    <th className="py-2 pr-3 font-black text-right">Shipping</th>
                    <th className="py-2 font-black text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {[...data.orders].reverse().map((o) => (
                    <tr key={o.order_gid} className={cn("border-b border-border/60 align-top", o.is_cancelled && "opacity-60")}>
                      <td className="py-2 pr-3 font-bold whitespace-nowrap">
                        {o.order_name}
                        {o.is_cancelled && (
                          <span className="ml-1.5 px-1.5 py-0.5 rounded bg-red-500/10 text-red-600 dark:text-red-400 text-[9px] font-black uppercase">
                            Cancelled
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {dot(o.order_date)} <span className="text-muted-foreground">{time(o.order_created_at)}</span>
                      </td>
                      <td className="py-2 pr-3 min-w-[220px]">
                        {o.items.map((i, idx) => (
                          <div key={idx}>
                            {i.title}
                            {i.variant_title ? <span className="text-muted-foreground"> · {i.variant_title}</span> : null}
                            {o.items.length > 1 ? <span className="text-muted-foreground"> × {i.quantity}</span> : null}
                          </div>
                        ))}
                      </td>
                      <td className="py-2 pr-3 text-right">{num(o.item_quantity)}</td>
                      <td className="py-2 pr-3 capitalize">{o.financial_status ?? "—"}</td>
                      <td className="py-2 pr-3 capitalize">{o.fulfillment_status ?? "unfulfilled"}</td>
                      <td className="py-2 pr-3 text-right">{cur2(o.shipping)}</td>
                      <td className={cn("py-2 text-right font-bold", o.is_cancelled && "line-through")}>{cur2(o.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </>
  );
}
