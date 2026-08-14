"use client";

import { categorizeTitle, CATEGORY_COLORS } from "@/lib/categoryMap";
import { Layers, Trophy, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useState } from "react";
import { useRouter } from "next/navigation";

const cur = (val: number, currency?: string) => {
  const sym = currency === "INR" ? "₹" : "$";
  if (!val) return `${sym}0`;
  return sym + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val));
};
const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));
const pct = (val: number) => `${(val || 0).toFixed(1)}%`;

interface CategoryAgg {
  category: string;
  totalSales: number;
  adSales: number;
  organicSales: number;
  adSpend: number;
  unitsOrdered: number;
  products: number;
}

// Aggregates retail product rows (from get_retail_product_performance) by category.
export function CategoryPerformance({ retailRows, currency, totalAdSpend }: { retailRows: any[]; currency?: string; totalAdSpend?: number }) {
  const router = useRouter();
  const [selectedCat, setSelectedCat] = useState<any | null>(null);

  const byCat = new Map<string, CategoryAgg>();
  for (const r of retailRows || []) {
    const category = categorizeTitle(r.productName, r.asin);
    const agg = byCat.get(category) || {
      category, totalSales: 0, adSales: 0, organicSales: 0, adSpend: 0, unitsOrdered: 0, products: 0,
    };
    const totalSales = r.totalSales || 0;
    const adSales = r.adSales || 0;
    agg.totalSales += totalSales;
    agg.adSales += adSales;
    agg.organicSales += Math.max(0, totalSales - adSales);
    agg.adSpend += r.adSpend || 0;
    agg.unitsOrdered += r.unitsOrdered || 0;
    agg.products += 1;
    byCat.set(category, agg);
  }

  const allCats = [...byCat.values()].sort((a, b) => b.totalSales - a.totalSales);
  if (allCats.length === 0) return null;

  // Proportionally distribute any unattributed campaign spend to align with the main executive KPI card
  if (totalAdSpend && totalAdSpend > 0) {
    const sumAdSpend = allCats.reduce((acc, c) => acc + c.adSpend, 0);
    const diff = totalAdSpend - sumAdSpend;
    if (diff > 0 && sumAdSpend > 0) {
      for (const c of allCats) {
        c.adSpend += diff * (c.adSpend / sumAdSpend);
      }
    }
  }

  // If nothing matched the category file (e.g. a different account), skip the section
  const matchedSales = allCats.filter((c) => c.category !== "Other").reduce((a, c) => a + c.totalSales, 0);
  const grandTotal = allCats.reduce((a, c) => a + c.totalSales, 0);
  if (grandTotal === 0 || matchedSales / grandTotal < 0.2) return null;

  // "Other" is an uncategorized catch-all — don't show it as its own card.
  // Also drop empty categories (e.g. "Discontinued" with ₹0 sales / 0 units /
  // no ad spend) — a 0.0%-share card carries no signal and just adds noise.
  const cats = allCats.filter(
    (c) => c.category !== "Other" && (c.totalSales > 0 || c.unitsOrdered > 0 || c.adSpend > 0)
  );
  if (cats.length === 0) return null;

  const best = cats[0];
  const bestRoas = [...cats].filter((c) => c.adSpend > 0).sort((a, b) => (b.adSales / b.adSpend) - (a.adSales / a.adSpend))[0];

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Layers className="w-4 h-4 text-indigo-500" />
        <h2 className="text-xs font-black uppercase tracking-wider text-slate-400 dark:text-slate-500">Category Performance</h2>
        <span className="text-[10px] bg-indigo-500/10 text-indigo-500 font-bold px-2 py-0.5 rounded-full ml-1">
          Best: {best.category}
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {cats.map((c) => {
          const share = grandTotal ? (c.totalSales / grandTotal) * 100 : 0;
          const roas = c.adSpend > 0 ? c.adSales / c.adSpend : 0;
          const tacos = c.totalSales > 0 ? (c.adSpend / c.totalSales) * 100 : 0;
          const color = CATEGORY_COLORS[c.category] || CATEGORY_COLORS.Other;
          const isBestSales = c === best;
          const isBestRoas = bestRoas && c === bestRoas;
          return (
            <div
              key={c.category}
              onClick={() => setSelectedCat({ ...c, share, roas, tacos, color })}
              className={cn(
                "glass rounded-2xl border p-4 shadow-sm space-y-3 cursor-pointer hover:scale-[1.01] hover:border-indigo-500/40 hover:shadow-md transition-all duration-200",
                isBestSales ? "border-indigo-400/60 ring-1 ring-indigo-400/30" : "border-border"
              )}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: color }} />
                  <p className="font-black text-sm truncate">{c.category}</p>
                </div>
                {isBestSales && (
                  <span className="flex items-center gap-1 text-[9px] font-black text-amber-600 bg-amber-500/10 px-2 py-0.5 rounded-full uppercase tracking-wider flex-shrink-0">
                    <Trophy className="w-3 h-3" /> Best Seller
                  </span>
                )}
                {!isBestSales && isBestRoas && (
                  <span className="text-[9px] font-black text-green-600 bg-green-500/10 px-2 py-0.5 rounded-full uppercase tracking-wider flex-shrink-0">
                    Best ROAS
                  </span>
                )}
              </div>

              <div>
                <p className="text-xl font-black">{cur(c.totalSales, currency)}</p>
                <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Total Sales · {pct(share)} share</p>
                <div className="h-1.5 rounded-full bg-muted mt-1.5 overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${Math.max(2, share)}%`, background: color }} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
                <div>
                  <p className="text-muted-foreground font-bold text-[9px] uppercase tracking-wider">Ad Sales</p>
                  <p className="font-black text-green-600 dark:text-green-400">{cur(c.adSales, currency)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground font-bold text-[9px] uppercase tracking-wider">Organic</p>
                  <p className="font-black text-emerald-600 dark:text-emerald-400">{cur(c.organicSales, currency)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground font-bold text-[9px] uppercase tracking-wider">Ad Spend</p>
                  <p className="font-black">{cur(c.adSpend, currency)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground font-bold text-[9px] uppercase tracking-wider">ROAS / TACOS</p>
                  <p className="font-black">{roas ? roas.toFixed(2) + "x" : "—"} · {pct(tacos)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground font-bold text-[9px] uppercase tracking-wider">Units</p>
                  <p className="font-black">{num(c.unitsOrdered)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground font-bold text-[9px] uppercase tracking-wider">Products</p>
                  <p className="font-black">{num(c.products)}</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Category Performance Detail Modal */}
      {selectedCat && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-in fade-in duration-200">
          <div className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-3xl w-full max-w-lg p-6 shadow-2xl relative space-y-6 animate-in zoom-in-95 duration-250">
            {/* Header */}
            <div className="flex items-center gap-3">
              <span className="w-4 h-4 rounded-full flex-shrink-0" style={{ background: selectedCat.color }} />
              <div>
                <h3 className="text-xl font-black text-slate-850 dark:text-white">{selectedCat.category}</h3>
                <p className="text-[11px] font-bold text-muted-foreground uppercase tracking-widest mt-0.5">Category Performance Insights</p>
              </div>
              <button 
                onClick={() => setSelectedCat(null)}
                className="ml-auto w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 flex items-center justify-center text-slate-400 hover:text-slate-650 transition-colors focus:outline-none cursor-pointer"
              >
                ✕
              </button>
            </div>

            {/* Main Stats Grid */}
            <div className="grid grid-cols-3 gap-4 text-center">
              <div className="bg-slate-50 dark:bg-slate-900/50 border border-slate-100 dark:border-slate-800 p-3 rounded-2xl">
                <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Total Sales</p>
                <p className="text-lg font-extrabold mt-1 text-slate-800 dark:text-white">{cur(selectedCat.totalSales, currency)}</p>
                <span className="text-[10px] font-bold text-slate-400 mt-1 block">{pct(selectedCat.share)} share</span>
              </div>
              <div className="bg-slate-50 dark:bg-slate-900/50 border border-slate-100 dark:border-slate-800 p-3 rounded-2xl">
                <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Ad Sales</p>
                <p className="text-lg font-extrabold mt-1 text-green-600 dark:text-green-400">{cur(selectedCat.adSales, currency)}</p>
                <span className="text-[10px] font-bold text-green-650/70 mt-1 block">{selectedCat.totalSales ? Math.round((selectedCat.adSales / selectedCat.totalSales) * 100) : 0}% share</span>
              </div>
              <div className="bg-slate-50 dark:bg-slate-900/50 border border-slate-100 dark:border-slate-800 p-3 rounded-2xl">
                <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Organic Sales</p>
                <p className="text-lg font-extrabold mt-1 text-emerald-600 dark:text-emerald-400">{cur(selectedCat.organicSales, currency)}</p>
                <span className="text-[10px] font-bold text-emerald-600/70 mt-1 block">{selectedCat.totalSales ? Math.round((selectedCat.organicSales / selectedCat.totalSales) * 100) : 0}% share</span>
              </div>
            </div>

            {/* Sub Stats Details */}
            <div className="space-y-3 bg-slate-50 dark:bg-slate-900/30 p-4.5 rounded-2xl border border-slate-100 dark:border-slate-800 text-xs">
              <div className="flex justify-between items-center pb-2.5 border-b border-slate-200/50 dark:border-slate-800/50">
                <span className="text-slate-500 dark:text-slate-400 font-semibold">Advertising Spend</span>
                <span className="font-extrabold text-slate-800 dark:text-white">{cur(selectedCat.adSpend, currency)}</span>
              </div>
              <div className="flex justify-between items-center pb-2.5 border-b border-slate-200/50 dark:border-slate-800/50">
                <span className="text-slate-500 dark:text-slate-400 font-semibold">Ad ROAS</span>
                <span className="font-extrabold text-indigo-600 dark:text-indigo-400">{selectedCat.roas ? selectedCat.roas.toFixed(2) + "x" : "—"}</span>
              </div>
              <div className="flex justify-between items-center pb-2.5 border-b border-slate-200/50 dark:border-slate-800/50">
                <span className="text-slate-500 dark:text-slate-400 font-semibold">TACOS (Total ACOS)</span>
                <span className="font-extrabold text-amber-600 dark:text-amber-400">{pct(selectedCat.tacos)}</span>
              </div>
              <div className="flex justify-between items-center pb-2.5 border-b border-slate-200/50 dark:border-slate-800/50">
                <span className="text-slate-500 dark:text-slate-400 font-semibold">Units Ordered</span>
                <span className="font-extrabold text-slate-800 dark:text-white">{num(selectedCat.unitsOrdered)} units</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-500 dark:text-slate-400 font-semibold">Catalog Size</span>
                <span className="font-extrabold text-slate-800 dark:text-white">{num(selectedCat.products)} active products</span>
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-3">
              <button 
                onClick={() => setSelectedCat(null)}
                className="flex-1 py-3 border border-slate-200 dark:border-slate-850 hover:bg-slate-50 dark:hover:bg-slate-900 text-slate-700 dark:text-slate-300 font-bold rounded-2xl transition-colors text-xs focus:outline-none cursor-pointer"
              >
                Close
              </button>
              <button 
                onClick={() => {
                  router.push(`/dashboard/products?category=${encodeURIComponent(selectedCat.category)}`);
                  setSelectedCat(null);
                }}
                className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-2xl transition-colors text-xs shadow-md shadow-indigo-600/10 focus:outline-none cursor-pointer flex items-center justify-center gap-1.5"
              >
                View Category Products <ArrowRight size={14} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
