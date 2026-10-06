"use client";

// Live Inventory — SellerMate only (never the uploaded Amazon report; that is the Inventory page).
// Every value is exactly what SellerMate returns; a field SellerMate does not provide is shown "—".

import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDashboard } from "@/lib/DashboardContext";
import { InventoryTabs } from "@/components/InventoryTabs";
import { KPICard } from "@/components/KPICard";
import { QueryErrorState } from "@/components/QueryErrorState";
import { resolveProductName } from "@/lib/categoryMap";
import type { LiveInventoryResult, LiveProduct } from "@/lib/sellerMateLiveInventory";
import { Loader2, PackageOpen, RefreshCw, ChevronDown, ChevronRight, Search, CalendarClock, Info, Warehouse, Database } from "lucide-react";

const fmt = (v: number | null | undefined) => (v === null || v === undefined ? "—" : new Intl.NumberFormat("en-IN").format(v));
const money = (v: number | null | undefined, currency?: string) =>
  v === null || v === undefined ? "—" : (currency === "INR" ? "₹" : "$") + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(v);
const dateIn = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—");

type LiveResponse = LiveInventoryResult & { requested?: { asins: number; catalogRows: number; missingFromInventoryList: number } };
type SortKey = "fba" | "fbm" | "title" | "warehouses" | "price";

export default function LiveInventoryPage() {
  const { keySlot, account, contextLoading } = useDashboard();
  const [view, setView] = useState<"products" | "warehouses">("products");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [openWh, setOpenWh] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "fba", dir: -1 });
  const [limit, setLimit] = useState(50);

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery<LiveResponse>({
    queryKey: ["live_inventory", keySlot, account?.id],
    queryFn: async () => {
      const qs = new URLSearchParams({ slot: keySlot, workspace_id: account?.workspace_id ?? "", amazon_account_id: account?.id ?? "" });
      const res = await fetch(`/api/live-inventory?${qs}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      return body as LiveResponse;
    },
    enabled: !!account,
    staleTime: 0, // live view: always re-ask SellerMate when the page opens
  });

  const name = (p: LiveProduct) => resolveProductName(p.title, p.skus.map((s) => s.sku).join(", ")) || p.title || "—";
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = (data?.products ?? []).filter((p) => !q || p.asin.toLowerCase().includes(q) || (p.title ?? "").toLowerCase().includes(q) || name(p).toLowerCase().includes(q) || p.skus.some((s) => s.sku.toLowerCase().includes(q) || (s.fnsku ?? "").toLowerCase().includes(q)));
    const val = (p: LiveProduct): number | string => sort.key === "fba" ? p.fbaWarehouseBalance ?? -1 : sort.key === "fbm" ? p.fbmQuantity ?? -1 : sort.key === "warehouses" ? p.warehouseCount : sort.key === "price" ? p.price ?? -1 : name(p);
    return [...list].sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * sort.dir; });
  }, [data, search, sort]);

  const totals = useMemo(() => {
    const p = data?.products ?? [];
    return {
      fba: p.reduce((a, x) => a + (x.fbaWarehouseBalance ?? 0), 0),
      fbm: p.reduce((a, x) => a + (x.fbmQuantity ?? 0), 0),
      inStock: p.filter((x) => x.stockStatus === "In stock").length,
    };
  }, [data]);

  const thProps = { sort, setSort };

  return (
    <div className="space-y-6 pb-10">
      {isError && <QueryErrorState compact message={`Live Inventory couldn't load from SellerMate: ${(error as Error)?.message ?? "unknown error"}`} onRetry={() => refetch()} />}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight mb-0.5">Live Inventory</h1>
          <p className="text-muted-foreground text-sm">{account?.name} · straight from SellerMate</p>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1 font-semibold text-foreground"><Database className="w-3.5 h-3.5 text-indigo-500" /> Source: SellerMate</span>
            <span className="inline-flex items-center gap-1"><CalendarClock className="w-3.5 h-3.5" /> Data as of: {data?.ledgerDates.length ? data.ledgerDates.join(", ") : "—"} (SellerMate ledger date)</span>
            <span>Last fetched: {dateIn(data?.fetchedAt)}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <InventoryTabs />
          <button onClick={() => refetch()} disabled={isFetching || !account} className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-bold hover:bg-muted disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      </div>

      {contextLoading || isLoading ? (
        <div className="flex h-[400px] items-center justify-center text-muted-foreground flex-col gap-4 glass rounded-2xl border border-border">
          <Loader2 className="w-7 h-7 animate-spin text-primary" />
          <p className="font-semibold text-sm">{contextLoading ? "Connecting..." : "Loading every product from SellerMate..."}</p>
        </div>
      ) : data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <KPICard title="Products (ASINs)" value={fmt(data.counts.asins)} subtitle={`${fmt(data.counts.catalogSkus)} SKUs in SellerMate catalog`} delay={0.05} />
            <KPICard title="FBA Warehouse Units" value={fmt(totals.fba)} subtitle="SellerMate FBA total (ledger)" delay={0.1} />
            <KPICard title="FBM Units" value={fmt(totals.fbm)} subtitle="SellerMate FBM quantity" delay={0.15} />
            <KPICard title="Amazon Warehouses" value={fmt(data.warehouses.length)} subtitle={`${fmt(data.counts.warehouseEntries)} SKU × warehouse rows`} delay={0.2} />
            <KPICard title="Products In Stock" value={fmt(totals.inStock)} subtitle="FBA or FBM above 0 (derived)" delay={0.25} />
          </div>

          <div className="rounded-2xl border border-border bg-muted/30 p-3 text-xs space-y-1">
            <p className="flex gap-1.5"><Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-indigo-500" />
              <span>SellerMate provides the FBA <b>warehouse balance</b> (Amazon Inventory Ledger, daily) per warehouse, and the FBM quantity. It does <b>not</b> provide Available, Reserved, Inbound or Unfulfillable — those columns show “—”. For Amazon&apos;s Available/Inbound figures use the Inventory tab (uploaded report).</span></p>
            <p className="flex gap-1.5"><Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-indigo-500" />
              <span>SellerMate returns two FBA figures: its product total and its warehouse-wise rows. They differ for some products (highlighted) — the warehouse rows also carry damaged/defective units, and SellerMate keeps one stock condition per warehouse. Both are shown exactly as SellerMate sends them.</span></p>
            {data.notes.map((n) => <p key={n} className="flex gap-1.5 text-amber-800 dark:text-amber-300"><Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /><span>{n}</span></p>)}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="inline-flex rounded-lg border border-border p-0.5 text-xs font-bold">
              <button onClick={() => setView("products")} className={`rounded-md px-3 py-1.5 ${view === "products" ? "bg-indigo-600 text-white" : "text-muted-foreground"}`}>Products ({fmt(data.products.length)})</button>
              <button onClick={() => setView("warehouses")} className={`rounded-md px-3 py-1.5 ${view === "warehouses" ? "bg-indigo-600 text-white" : "text-muted-foreground"}`}><Warehouse className="inline w-3.5 h-3.5 mr-1" />Warehouses ({fmt(data.warehouses.length)})</button>
            </div>
            {view === "products" && (
              <label className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-muted-foreground" />
                <input value={search} onChange={(e) => { setSearch(e.target.value); setLimit(50); }} placeholder="Search name, ASIN, SKU or FNSKU" className="w-72 rounded-lg border border-border bg-background py-2 pl-8 pr-2 text-xs" />
              </label>
            )}
          </div>

          {view === "products" ? (
            <div className="glass rounded-2xl border border-border overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1250px] text-xs">
                  <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="w-8" /><th className="px-3 py-2.5 text-left">Image</th>
                      <Th {...thProps} k="title">Product / ASIN</Th>
                      <th className="px-3 py-2.5 text-left">SKUs</th>
                      <Th {...thProps} k="fba" right>FBA Balance (SellerMate total)</Th>
                      <th className="px-3 py-2.5 text-right" title="Sum of SellerMate's warehouse-wise rows for this product">Warehouse-wise Total</th>
                      <Th {...thProps} k="fbm" right>FBM Qty</Th>
                      <th className="px-3 py-2.5 text-right">Available</th>
                      <th className="px-3 py-2.5 text-right">Reserved</th>
                      <th className="px-3 py-2.5 text-right">Inbound</th>
                      <th className="px-3 py-2.5 text-right">Unfulfillable</th>
                      <Th {...thProps} k="price" right>Price</Th>
                      <Th {...thProps} k="warehouses" right>Warehouses</Th>
                      <th className="px-3 py-2.5 text-left">Ledger Date</th>
                      <th className="px-3 py-2.5 text-left">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, limit).map((p) => {
                      const isOpen = open === p.asin;
                      return (
                        <Fragment key={p.asin}>
                          <tr onClick={() => setOpen(isOpen ? null : p.asin)} className="cursor-pointer border-t border-border/60 hover:bg-muted/30 align-top">
                            <td className="pl-3 pt-4 text-muted-foreground">{isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</td>
                            <td className="px-3 py-2">
                              <div className="w-10 h-10 rounded-lg overflow-hidden border border-border bg-muted flex items-center justify-center">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                {p.imageUrl ? <img src={p.imageUrl} alt="" className="w-full h-full object-cover" /> : <PackageOpen className="w-5 h-5 text-muted-foreground" />}
                              </div>
                            </td>
                            <td className="px-3 py-2 max-w-[280px]"><p className="font-semibold text-sm truncate" title={p.title ?? ""}>{name(p)}</p><p className="font-mono text-[10px] text-muted-foreground">{p.asin}</p></td>
                            <td className="px-3 py-2 max-w-[220px]">
                              <div className="flex flex-wrap gap-1">{p.skus.length ? p.skus.map((s) => (
                                <span key={s.sku} className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px]">{s.sku}{s.channel && <span className={`ml-1 font-sans font-bold ${s.channel === "FBA" ? "text-indigo-600 dark:text-indigo-400" : "text-amber-700 dark:text-amber-400"}`}>{s.channel}</span>}</span>
                              )) : <NA />}</div>
                            </td>
                            <td className="px-3 py-2 text-right font-bold tabular-nums">{fmt(p.fbaWarehouseBalance)}</td>
                            <td className={`px-3 py-2 text-right tabular-nums ${p.warehouseTotal !== null && p.fbaWarehouseBalance !== null && p.warehouseTotal !== p.fbaWarehouseBalance ? "font-bold text-amber-700 dark:text-amber-400" : ""}`}>{fmt(p.warehouseTotal)}</td>
                            <td className="px-3 py-2 text-right font-bold tabular-nums">{fmt(p.fbmQuantity)}</td>
                            <td className="px-3 py-2 text-right"><NA /></td>
                            <td className="px-3 py-2 text-right"><NA /></td>
                            <td className="px-3 py-2 text-right"><NA /></td>
                            <td className="px-3 py-2 text-right"><NA /></td>
                            <td className="px-3 py-2 text-right tabular-nums">{money(p.price, account?.currency)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{p.warehouseCount || "—"}</td>
                            <td className="px-3 py-2">{p.ledgerDate ?? "—"}</td>
                            <td className="px-3 py-2">
                              <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold ${p.stockStatus === "In stock" ? "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-400" : p.stockStatus === "Out of stock" ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-400" : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400"}`} title="Derived: FBA warehouse balance or FBM quantity above 0">{p.stockStatus}</span>
                              {p.notes.map((n) => <p key={n} className="mt-1 max-w-[180px] text-[10px] text-amber-700 dark:text-amber-400">{n}</p>)}
                            </td>
                          </tr>
                          {isOpen && (
                            <tr className="bg-muted/20">
                              <td colSpan={15} className="px-6 py-3">
                                <table className="w-full table-fixed text-[11px]">
                                  <colgroup><col className="w-[150px]" /><col className="w-[64px]" /><col className="w-[110px]" /><col className="w-[90px]" /><col className="w-[100px]" /><col className="w-[96px]" /><col className="w-[80px]" /><col /></colgroup>
                                  <thead className="text-[9px] uppercase tracking-wider text-muted-foreground">
                                    <tr><th className="py-1 px-2 text-left">SKU</th><th className="px-2 text-left">Channel</th><th className="px-2 text-left">FNSKU</th><th className="px-2 text-right">Listing Qty (catalog)</th><th className="px-2 text-right">FBA Warehouse Balance</th><th className="px-2 text-left">Ledger Date</th><th className="px-2 text-left">Catalog Status</th><th className="px-2 text-left">Warehouse-wise (location: units)</th></tr>
                                  </thead>
                                  <tbody>
                                    {p.skus.map((s) => (
                                      <tr key={s.sku} className="border-t border-border/50 align-top">
                                        <td className="py-1.5 px-2 font-mono font-semibold break-all">{s.sku}{!s.inCatalog && <span className="ml-1 font-sans text-[9px] text-amber-700">{s.catalogAsin ? `catalogued under ${s.catalogAsin}` : "not in catalog"}</span>}</td>
                                        <td className="px-2">{s.channel ?? "—"}</td>
                                        <td className="px-2 font-mono break-all">{s.fnsku ?? "—"}</td>
                                        <td className="px-2 text-right tabular-nums">{fmt(s.listingQuantity)}</td>
                                        <td className="px-2 text-right tabular-nums font-bold">{fmt(s.fbaWarehouseBalance)}</td>
                                        <td className="px-2 whitespace-nowrap">{s.ledgerDate ?? "—"}</td>
                                        <td className="px-2">{s.catalogStatus ?? "—"}</td>
                                        <td className="px-2">
                                          {s.warehouses.length ? (
                                            <div className="flex flex-wrap gap-1">{s.warehouses.map((w) => <span key={w.location} className="rounded bg-background border border-border px-1.5 py-0.5 tabular-nums">{w.location}: <b>{fmt(w.units)}</b></span>)}</div>
                                          ) : <span className="text-muted-foreground">No FBA warehouse rows</span>}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                                {p.warehouseTotal !== null && <p className="mt-2 text-[10px] text-muted-foreground">Warehouse rows total {fmt(p.warehouseTotal)} · SellerMate FBA total {fmt(p.fbaWarehouseBalance)}</p>}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                    {!rows.length && <tr><td colSpan={15} className="px-4 py-10 text-center text-muted-foreground">No products match.</td></tr>}
                  </tbody>
                </table>
              </div>
              {rows.length > limit && <button onClick={() => setLimit((n) => n + 100)} className="w-full border-t border-border py-2 text-xs font-bold text-indigo-600 hover:bg-muted/40 dark:text-indigo-400">Show more ({rows.length - limit} remaining)</button>}
            </div>
          ) : (
            <div className="glass rounded-2xl border border-border overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr><th className="w-8" /><th className="px-3 py-2.5 text-left">Warehouse (FC)</th><th className="px-3 py-2.5 text-right">Units (warehouse balance)</th><th className="px-3 py-2.5 text-right">SKUs</th><th className="px-3 py-2.5 text-right">Products</th></tr>
                </thead>
                <tbody>
                  {data.warehouses.map((w) => {
                    const isOpen = openWh === w.location;
                    const items = isOpen ? data.products.flatMap((p) => p.skus.flatMap((s) => s.warehouses.filter((x) => x.location === w.location).map((x) => ({ p, s, x })))).sort((a, b) => (b.x.units ?? 0) - (a.x.units ?? 0)) : [];
                    return (
                      <Fragment key={w.location}>
                        <tr onClick={() => setOpenWh(isOpen ? null : w.location)} className="cursor-pointer border-t border-border/60 hover:bg-muted/30">
                          <td className="pl-3 text-muted-foreground">{isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</td>
                          <td className="px-3 py-2 font-mono font-bold">{w.location}</td>
                          <td className="px-3 py-2 text-right font-bold tabular-nums">{fmt(w.units)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{fmt(w.skuCount)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{fmt(w.asinCount)}</td>
                        </tr>
                        {isOpen && (
                          <tr className="bg-muted/20"><td colSpan={5} className="px-6 py-2">
                            <table className="w-full text-[11px]"><tbody>
                              {items.map(({ p, s, x }) => (
                                <tr key={s.sku} className="border-t border-border/50"><td className="py-1 font-mono">{s.sku}</td><td className="truncate max-w-[360px]">{name(p)}</td><td className="font-mono text-muted-foreground">{p.asin}</td><td className="text-right font-bold tabular-nums">{fmt(x.units)}</td><td className="pl-4 text-muted-foreground">{x.asOfDate ?? "—"}</td></tr>
                              ))}
                            </tbody></table>
                          </td></tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            Loaded {fmt(data.counts.asins)} products · {fmt(data.counts.catalogSkus)} catalog SKUs · {fmt(data.counts.fbaSkuRows)} FBA SKU rows · {fmt(data.counts.warehouseEntries)} warehouse entries · {fmt(data.counts.duplicateRowsRemoved)} duplicate rows from SellerMate removed. Every product is requested by ASIN, so none are lost to SellerMate&apos;s unstable paging.
          </p>
        </>
      )}
    </div>
  );
}

type SortState = { key: SortKey; dir: 1 | -1 };
function Th({ k, children, right, sort, setSort }: { k?: SortKey; children: React.ReactNode; right?: boolean; sort: SortState; setSort: (f: (s: SortState) => SortState) => void }) {
  return (
    <th onClick={k ? () => setSort((s) => ({ key: k, dir: s.key === k ? (s.dir === 1 ? -1 : 1) : -1 })) : undefined}
      className={`px-3 py-2.5 ${right ? "text-right" : "text-left"} ${k ? "cursor-pointer select-none" : ""} ${k && sort.key === k ? "text-foreground" : ""}`}>
      {children}{k && sort.key === k ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
    </th>
  );
}

function NA() {
  return <span className="text-muted-foreground" title="SellerMate does not provide this field">—</span>;
}
