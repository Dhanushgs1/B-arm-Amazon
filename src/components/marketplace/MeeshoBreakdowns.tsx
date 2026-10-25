"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { matchesProductQuery } from "@/lib/productSearch";
import { ProductSearchBox } from "@/components/marketplace/ProductSearchBox";
import { Loader2 } from "lucide-react";
import { useDashboard } from "@/lib/DashboardContext";
import { TrendChart } from "@/components/TrendChart";
import { fetchMeeshoOrderRows } from "@/lib/meeshoBarmOrd";
import { meeshoBreakdowns, type MeeshoSplitRow } from "@/lib/meeshoBreakdownRules";

const cur = (v: number) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(v || 0))}`;
const num = (v: number) => new Intl.NumberFormat("en-IN").format(Math.round(v || 0));
const pct = (v: number) => `${Math.round((v || 0) * 1000) / 10}%`;
const shortDay = (iso: string) => {
  const [, m, d] = iso.split("-");
  return `${d}.${m}`;
};
const MEESHO = "#9F2089";

function Card({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="glass rounded-2xl border border-border p-5 shadow-sm space-y-3 min-w-0">
      <h3 className="text-xs font-black uppercase tracking-widest text-muted-foreground">{title}</h3>
      {children}
      {note && <p className="text-[11px] text-muted-foreground">{note}</p>}
    </div>
  );
}

function SplitBars({ rows, limit }: { rows: MeeshoSplitRow[]; limit?: number }) {
  if (!rows.length) return <p className="text-xs text-muted-foreground py-2">No orders in the selected dates.</p>;
  const shown = limit ? rows.slice(0, limit) : rows;
  return (
    <div className="space-y-2.5">
      {shown.map((r) => (
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
            <div className="h-full rounded-full" style={{ width: `${Math.max(2, r.share * 100)}%`, background: r.counted ? MEESHO : "#94A3B8" }} />
          </div>
        </div>
      ))}
      {limit && rows.length > limit && <p className="text-[11px] text-muted-foreground">+ {rows.length - limit} more</p>}
    </div>
  );
}

/** Meesho tab breakdowns for the selected dates: daily trend, product-wise sales, order status and
 *  customer state. Same rules as the Meesho summary above (meeshoBreakdownRules.ts), so its units and
 *  gross equal the summary's Orders and Gross Sales. */
export function MeeshoBreakdowns() {
  const { startDate, endDate } = useDashboard();
  const [search, setSearch] = useState("");
  const { data: rows, isLoading, error } = useQuery({ queryKey: ["meesho-order-rows"], queryFn: fetchMeeshoOrderRows });

  if (isLoading || (!rows && !error)) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-6 justify-center">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading Meesho breakdowns…
      </div>
    );
  }
  if (error || !rows) {
    return <p className="text-xs font-semibold text-red-600 dark:text-red-400">Couldn&apos;t load Meesho orders — {error instanceof Error ? error.message : String(error)}</p>;
  }
  if (!startDate || !endDate) return null;

  const b = meeshoBreakdowns(rows, startDate, endDate);
  const daily = b.daily.map((d) => ({ ...d, day: shortDay(d.date) }));
  const shown = b.products.filter((p) => matchesProductQuery(search, p.name, p.sku));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TrendChart title="Daily Gross Sales (cancelled excluded)" data={daily} dataKey="gross" xAxisKey="day" color={MEESHO} type="area" height={240} valuePrefix="₹" />
        <TrendChart title="Daily Units" data={daily} dataKey="units" xAxisKey="day" color="#6366F1" type="line" height={240} />
      </div>

      <Card
        title={`Product-wise Sales · ${num(b.products.length)}`}
        note="Gross = quantity × supplier listed price (a row without a price uses the SKU's latest listed price), before returns — the same basis as Gross Sales in the summary. Cancelled orders are left out."
      >
        {b.products.length > 0 && <ProductSearchBox value={search} onChange={setSearch} shown={shown.length} total={b.products.length} />}
        {b.products.length === 0 ? (
          <p className="text-xs text-muted-foreground py-2">No Meesho orders in the selected dates.</p>
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
                    <td className="py-2 pr-3 min-w-[200px] text-muted-foreground">{p.name}</td>
                    <td className="py-2 pr-3 text-right">{num(p.units)}</td>
                    <td className="py-2 pr-3 text-right">{num(p.orders)}</td>
                    <td className="py-2 pr-3 text-right font-bold whitespace-nowrap">{cur(p.gross)}</td>
                    <td className="py-2">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${Math.max(2, p.share * 100)}%`, background: MEESHO }} />
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
                    <td className="py-2 pr-3 text-right">{num(b.totals.units)}</td>
                    <td className="py-2 pr-3 text-right">{num(b.totals.orders)}</td>
                    <td className="py-2 pr-3 text-right whitespace-nowrap">{cur(b.totals.gross)}</td>
                    <td className="py-2" />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card title="Order Status" note="Units by Meesho order status. Cancelled is shown for reference and is not in sales; RTO and returned orders still count in Gross Sales, as in the summary (returns are tracked separately by return date).">
          <SplitBars rows={b.statuses} />
        </Card>
        <Card title="Top Customer States" note="Gross sales by the customer's state (cancelled excluded). State only — no names or addresses.">
          <SplitBars rows={b.states} limit={10} />
        </Card>
      </div>
    </div>
  );
}
