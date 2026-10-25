"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { TrendChart } from "@/components/TrendChart";
import { matchesProductQuery } from "@/lib/productSearch";
import { ProductSearchBox } from "@/components/marketplace/ProductSearchBox";
import {
  shopifyDailySeries,
  shopifyFulfilmentSplit,
  shopifyPaymentSplit,
  shopifyProductSales,
  shopifySourceSplit,
  type ShopifyOrder,
  type ShopifySplitRow,
} from "@/lib/shopifyOrderRules";

const cur = (v: number) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(v || 0))}`;
const num = (v: number) => new Intl.NumberFormat("en-IN").format(Math.round(v || 0));
const pct = (v: number) => `${Math.round((v || 0) * 1000) / 10}%`;
const shortDay = (iso: string) => {
  const [, m, d] = iso.split("-");
  return `${d}.${m}`;
};

const SPLIT_COLOURS: Record<string, string> = {
  paid: "#10B981",
  pending: "#F59E0B",
  authorized: "#6366F1",
  partially_paid: "#A855F7",
  partially_refunded: "#F97316",
  refunded: "#EF4444",
  voided: "#64748B",
  fulfilled: "#10B981",
  partial: "#A855F7",
  unfulfilled: "#94A3B8",
  restocked: "#64748B",
  google_ads: "#4285F4",
  meta_ads: "#0866FF",
  google_organic: "#34A853",
  direct: "#8B5CF6",
  other: "#F59E0B",
  unknown: "#94A3B8",
};

function Card({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="glass rounded-2xl border border-border p-5 shadow-sm space-y-3 min-w-0">
      <h3 className="text-xs font-black uppercase tracking-widest text-muted-foreground">{title}</h3>
      {children}
      {note && <p className="text-[11px] text-muted-foreground">{note}</p>}
    </div>
  );
}

function SplitBars({ rows, hrefFor }: { rows: ShopifySplitRow[]; hrefFor?: (key: string) => string }) {
  if (!rows.length) return <p className="text-xs text-muted-foreground py-2">No net orders in the selected dates.</p>;
  return (
    <div className="space-y-2.5">
      {rows.map((r) => {
        const body = (
        <div className="space-y-1">
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="font-bold truncate">
              {r.label}
              {hrefFor && <ChevronRight className="inline w-3 h-3 ml-0.5 text-muted-foreground" />}
            </span>
            <span className="whitespace-nowrap text-muted-foreground">
              <span className="font-bold text-foreground">{cur(r.sales)}</span> · {num(r.orders)} {r.orders === 1 ? "order" : "orders"} · {pct(r.share)}
            </span>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div className="h-full rounded-full" style={{ width: `${Math.max(2, r.share * 100)}%`, background: SPLIT_COLOURS[r.key] ?? "#94A3B8" }} />
          </div>
        </div>
        );
        return hrefFor ? (
          <Link key={r.key} href={hrefFor(r.key)} className="block rounded-lg -mx-2 px-2 py-1 hover:bg-muted/50 transition-colors">
            {body}
          </Link>
        ) : (
          <div key={r.key}>{body}</div>
        );
      })}
    </div>
  );
}

/** The Shopify tab's breakdowns for the selected dates: daily trend, product-wise sales, payment &
 *  fulfilment status and order source. Rules (cancelled orders left out, etc.) live in
 *  shopifyOrderRules.ts and are unit tested there. */
export function ShopifyBreakdowns({ orders, start, end }: { orders: ShopifyOrder[]; start: string; end: string }) {
  const daily = shopifyDailySeries(orders, start, end).map((d) => ({ ...d, day: shortDay(d.date) }));
  const [search, setSearch] = useState("");
  const products = shopifyProductSales(orders);
  const itemTotal = products.reduce((t, p) => t + p.itemSales, 0);
  const shown = products.filter((p) => matchesProductQuery(search, p.title, p.skus));

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TrendChart title="Daily Sales (net of cancellations)" data={daily} dataKey="sales" xAxisKey="day" color="#5E8E3E" type="area" height={240} valuePrefix="₹" />
        <TrendChart title="Daily Net Orders" data={daily} dataKey="netOrders" xAxisKey="day" color="#6366F1" type="line" height={240} />
      </div>

      <Card
        title={`Product-wise Sales · ${num(products.length)}`}
        note="Item value = price × quantity − line discount, without shipping or tax, so it is lower than order Sales. Cancelled orders are left out. Products are grouped by name because some share a placeholder SKU."
      >
        {products.length > 0 && <ProductSearchBox value={search} onChange={setSearch} shown={shown.length} total={products.length} />}
        {products.length === 0 ? (
          <p className="text-xs text-muted-foreground py-2">No net orders in the selected dates.</p>
        ) : shown.length === 0 ? (
          <p className="text-xs text-muted-foreground py-2">No product matches &ldquo;{search}&rdquo;.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                  <th className="py-2 pr-3 font-black">Product</th>
                  <th className="py-2 pr-3 font-black">SKU</th>
                  <th className="py-2 pr-3 font-black text-right">Units</th>
                  <th className="py-2 pr-3 font-black text-right">Orders</th>
                  <th className="py-2 pr-3 font-black text-right">Item value</th>
                  <th className="py-2 font-black min-w-[120px]">Share</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.title} className="border-b border-border/60 align-top">
                    <td className="py-2 pr-3 font-semibold min-w-[220px]">{p.title}</td>
                    <td className="py-2 pr-3 text-muted-foreground whitespace-nowrap">{p.skus.join(", ") || "—"}</td>
                    <td className="py-2 pr-3 text-right">{num(p.units)}</td>
                    <td className="py-2 pr-3 text-right">{num(p.orders)}</td>
                    <td className="py-2 pr-3 text-right font-bold whitespace-nowrap">{cur(p.itemSales)}</td>
                    <td className="py-2">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
                          <div className="h-full rounded-full bg-[#5E8E3E]" style={{ width: `${Math.max(2, p.share * 100)}%` }} />
                        </div>
                        <span className="w-11 text-right text-muted-foreground">{pct(p.share)}</span>
                      </div>
                    </td>
                  </tr>
                ))}
                <tr className="font-black">
                  <td className="py-2 pr-3" colSpan={2}>{search ? `Total of ${num(shown.length)} matching` : "Total"}</td>
                  <td className="py-2 pr-3 text-right">{num(shown.reduce((t, p) => t + p.units, 0))}</td>
                  <td className="py-2 pr-3" />
                  <td className="py-2 pr-3 text-right whitespace-nowrap">{cur(search ? shown.reduce((t, p) => t + p.itemSales, 0) : itemTotal)}</td>
                  <td className="py-2 text-right text-muted-foreground">{search ? pct(shown.reduce((t, p) => t + p.share, 0)) : ""}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card title="Payment" note="Net orders by Shopify payment status. Pending is mostly cash on delivery not yet collected.">
          <SplitBars rows={shopifyPaymentSplit(orders)} />
        </Card>
        <Card title="Fulfilment" note="Net orders by fulfilment status. Shopify sends no status until an order ships, so that shows as Unfulfilled.">
          <SplitBars rows={shopifyFulfilmentSplit(orders)} />
        </Card>
        <Card title="Order Source" note="Where the visit that placed the order came from, read from the order's landing and referring page (ad click IDs such as gclid / fbclid). Only the label is shown.">
          <SplitBars rows={shopifySourceSplit(orders)} hrefFor={(k) => `/dashboard/shopify/sources?source=${k}`} />
          <Link href="/dashboard/shopify/sources" className="inline-flex items-center gap-1 text-[11px] font-bold text-indigo-600 dark:text-indigo-400 hover:underline">
            Google &amp; Meta details (spend, ROAS, campaigns) <ChevronRight className="w-3 h-3" />
          </Link>
        </Card>
      </div>
    </>
  );
}
