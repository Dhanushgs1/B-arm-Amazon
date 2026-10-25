"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { matchesProductQuery } from "@/lib/productSearch";
import { ProductSearchBox } from "@/components/marketplace/ProductSearchBox";
import { Loader2 } from "lucide-react";
import { useDashboard } from "@/lib/DashboardContext";
import { TrendChart } from "@/components/TrendChart";
import { fetchMisFkOrders } from "@/lib/misAdapters";
import { fetchAllRows } from "@/lib/amazonReportShared";
import { flipkartBreakdowns, type FlipkartBreakdownRow, type FlipkartListingRow, type FlipkartSplitRow } from "@/lib/flipkartBreakdownRules";

const cur = (v: number) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(v || 0))}`;
const num = (v: number) => new Intl.NumberFormat("en-IN").format(Math.round(v || 0));
const pct = (v: number) => `${Math.round((v || 0) * 1000) / 10}%`;
const shortDay = (iso: string) => {
  const [, m, d] = iso.split("-");
  return `${d}.${m}`;
};
const FLIPKART = "#2874F0";

function Card({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="glass rounded-2xl border border-border p-5 shadow-sm space-y-3 min-w-0">
      <h3 className="text-xs font-black uppercase tracking-widest text-muted-foreground">{title}</h3>
      {children}
      {note && <p className="text-[11px] text-muted-foreground">{note}</p>}
    </div>
  );
}

function SplitBars({ rows }: { rows: FlipkartSplitRow[] }) {
  if (!rows.length) return <p className="text-xs text-muted-foreground py-2">No orders in the selected dates.</p>;
  return (
    <div className="space-y-2.5">
      {rows.map((r) => (
        <div key={r.key} className={r.counted ? "space-y-1" : "space-y-1 opacity-60"}>
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="font-bold truncate">
              {r.label}
              {!r.counted && <span className="ml-1.5 text-[9px] font-black uppercase text-red-600 dark:text-red-400">not in sales</span>}
            </span>
            <span className="whitespace-nowrap text-muted-foreground">
              {r.counted && <span className="font-bold text-foreground">{cur(r.gross)} · </span>}
              {num(r.units)} {r.units === 1 ? "unit" : "units"} · {pct(r.share)}
            </span>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div className="h-full rounded-full" style={{ width: `${Math.max(2, r.share * 100)}%`, background: r.counted ? FLIPKART : "#94A3B8" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Flipkart tab breakdowns for the selected dates: daily trend, product-wise sales, order status and
 *  fulfilment type. Same rules as the "Sales, Orders & Returns" strip (flipkartBreakdownRules.ts).
 *  Reads only the selected range of fk_orders, once (the table is large). */
export function FlipkartBreakdowns() {
  const { startDate, endDate } = useDashboard();
  const [search, setSearch] = useState("");
  const { data, isLoading, error } = useQuery({
    queryKey: ["flipkart-breakdowns", startDate, endDate],
    enabled: !!startDate && !!endDate,
    queryFn: async () => {
      const [rows, listings] = await Promise.all([
        fetchMisFkOrders((q) => q.gte("order_date", startDate).lte("order_date", endDate)),
        fetchAllRows("barm_flipkart_listings", (q) => q).catch(() => []),
      ]);
      return flipkartBreakdowns(rows as FlipkartBreakdownRow[], listings as FlipkartListingRow[], startDate, endDate);
    },
  });

  if (isLoading || (!data && !error)) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-6 justify-center">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading Flipkart breakdowns…
      </div>
    );
  }
  if (error || !data) {
    return <p className="text-xs font-semibold text-red-600 dark:text-red-400">Couldn&apos;t load Flipkart orders — {error instanceof Error ? error.message : String(error)}</p>;
  }

  const daily = data.daily.map((d) => ({ ...d, day: shortDay(d.date) }));
  const shown = data.products.filter((p) => matchesProductQuery(search, p.title, p.sku));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TrendChart title="Daily Gross Sales (cancelled excluded)" data={daily} dataKey="gross" xAxisKey="day" color={FLIPKART} type="area" height={240} valuePrefix="₹" />
        <TrendChart title="Daily Units" data={daily} dataKey="units" xAxisKey="day" color="#F59E0B" type="line" height={240} />
      </div>

      <Card
        title={`Product-wise Sales · ${num(data.products.length)}`}
        note={`Gross = units × the SKU's selling price in the Flipkart listings (the order report has no prices), before returns — the same basis as Gross Sales above. Cancelled orders are left out.${data.totals.unpricedUnits ? ` ${num(data.totals.unpricedUnits)} units are SKUs with no listing price and add ₹0 (marked "no price").` : ""}`}
      >
        {data.products.length > 0 && <ProductSearchBox value={search} onChange={setSearch} shown={shown.length} total={data.products.length} />}
        {data.products.length === 0 ? (
          <p className="text-xs text-muted-foreground py-2">No Flipkart orders in the selected dates.</p>
        ) : shown.length === 0 ? (
          <p className="text-xs text-muted-foreground py-2">No product matches &ldquo;{search}&rdquo;.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                  <th className="py-2 pr-3 font-black">SKU</th>
                  <th className="py-2 pr-3 font-black">Product</th>
                  <th className="py-2 pr-3 font-black text-right">Units</th>
                  <th className="py-2 pr-3 font-black text-right">Orders</th>
                  <th className="py-2 pr-3 font-black text-right">Gross</th>
                  <th className="py-2 font-black min-w-[120px]">Share</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.sku} className="border-b border-border/60 align-top">
                    <td className="py-2 pr-3 font-semibold whitespace-nowrap">{p.sku}</td>
                    <td className="py-2 pr-3 min-w-[200px] text-muted-foreground">{p.title}</td>
                    <td className="py-2 pr-3 text-right">{num(p.units)}</td>
                    <td className="py-2 pr-3 text-right">{num(p.orders)}</td>
                    <td className="py-2 pr-3 text-right font-bold whitespace-nowrap">
                      {p.priced ? cur(p.gross) : <span className="text-[10px] font-black uppercase text-amber-600 dark:text-amber-400">no price</span>}
                    </td>
                    <td className="py-2">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${Math.max(2, p.share * 100)}%`, background: FLIPKART }} />
                        </div>
                        <span className="w-11 text-right text-muted-foreground">{pct(p.share)}</span>
                      </div>
                    </td>
                  </tr>
                ))}
                {search ? (
                  <tr className="font-black">
                    <td className="py-2 pr-3" colSpan={2}>Total of {num(shown.length)} matching</td>
                    <td className="py-2 pr-3 text-right">{num(shown.reduce((t, p) => t + p.units, 0))}</td>
                    <td className="py-2 pr-3" />
                    <td className="py-2 pr-3 text-right whitespace-nowrap">{cur(shown.reduce((t, p) => t + p.gross, 0))}</td>
                    <td className="py-2 text-right text-muted-foreground">{pct(shown.reduce((t, p) => t + p.share, 0))}</td>
                  </tr>
                ) : (
                  <tr className="font-black">
                    <td className="py-2 pr-3" colSpan={2}>Total</td>
                    <td className="py-2 pr-3 text-right">{num(data.totals.units)}</td>
                    <td className="py-2 pr-3 text-right">{num(data.totals.orders)}</td>
                    <td className="py-2 pr-3 text-right whitespace-nowrap">{cur(data.totals.gross)}</td>
                    <td className="py-2" />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card title="Order Status" note="Units by Flipkart order item status. Cancelled is shown for reference and is not in sales; returned and return-requested items still count in Gross Sales, as above (returns are tracked separately by return date).">
          <SplitBars rows={data.statuses} />
        </Card>
        <Card title="Fulfilment Type" note="Units by who ships the order: Flipkart (FBF) or the seller (Non-FBF). Cancelled excluded.">
          <SplitBars rows={data.fulfilment} />
        </Card>
      </div>
    </div>
  );
}
