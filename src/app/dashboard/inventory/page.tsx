"use client";

import { useQuery } from "@tanstack/react-query";
import { useDashboard } from "@/lib/DashboardContext";
import { mcpAllInventory, fetchSkuMap } from "@/lib/api";
import { resolveProductName } from "@/lib/categoryMap";
import { DataTable } from "@/components/DataTable";
import { KPICard } from "@/components/KPICard";
import { QueryErrorState } from "@/components/QueryErrorState";
import { fetchAllRows } from "@/lib/amazonReportShared";
import { buildInventory, type FbaReportRow, type InventoryRow } from "@/lib/inventoryStock";
import { InventoryTabs } from "@/components/InventoryTabs";
import { Loader2, PackageOpen, AlertTriangle, CheckCircle, XCircle, CalendarClock, Info } from "lucide-react";

const cur = (val: number, currency?: string) => {
  const sym = currency === "INR" ? "₹" : "$";
  if (!val) return `${sym}0`;
  return sym + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val));
};
const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));

export default function InventoryPage() {
  const { keySlot, account, contextLoading } = useDashboard();

  const { data, isLoading, isError, refetch, dataUpdatedAt } = useQuery({
    queryKey: ["inventory_page", keySlot, account?.id],
    queryFn: async () => {
      const baseArgs = {
        amazon_account_id: account?.id,
        workspace_id: account?.workspace_id,
      };
      // get_inventory paginates with limit/offset (not page_size) — fetch every page,
      // and join SKUs from the product catalog since inventory rows return sku as "".
      // FBA stock comes from Amazon's FBA Inventory report (see src/lib/inventoryStock.ts for why
      // not SellerMate's ledger balance); the fba_by_location view only supplies the ledger date.
      const [items, skuMap, report, ledgerItems] = await Promise.all([
        mcpAllInventory(baseArgs, keySlot),
        fetchSkuMap(baseArgs, keySlot),
        fetchAllRows("barm_amazon_fba_inventory", (q) => q).catch(() => []) as Promise<FbaReportRow[]>,
        mcpAllInventory({ ...baseArgs, view: "fba_by_location" }, keySlot).catch(() => []),
      ]);
      return buildInventory(items, skuMap, report, ledgerItems, resolveProductName);
    },
    enabled: !!account,
  });

  const currency = account?.currency;

  // Compute stock health summaries
  const inventoryItems: InventoryRow[] = data?.rows || [];
  const usesReport = data?.fbaSource === "amazon_report";
  const flagged = inventoryItems.filter((i) => i.fbaNote);
  const totalValue = inventoryItems.reduce((acc: number, item: InventoryRow) => acc + item.totalValue, 0);
  const healthyCount = inventoryItems.filter((item) => item.stockStatus === "Healthy").length;
  const lowStockCount = inventoryItems.filter((item) => item.stockStatus === "Low Stock").length;
  const outOfStockCount = inventoryItems.filter((item) => item.stockStatus === "Out of Stock").length;

  const outOfStockList = inventoryItems.filter((item) => item.stockStatus === "Out of Stock");
  const lowStockList = inventoryItems.filter((item) => item.stockStatus === "Low Stock");

  const columns = [
    {
      key: "mainImageUrl",
      label: "Image",
      sortable: false,
      render: (val: string) => (
        <div className="w-10 h-10 rounded-lg overflow-hidden border border-border bg-muted flex items-center justify-center flex-shrink-0">
          {val ? (
            <img src={val} alt="" className="w-full h-full object-cover" onError={(e: any) => e.target.style.display = 'none'} />
          ) : (
            <PackageOpen className="w-5 h-5 text-muted-foreground" />
          )}
        </div>
      ),
    },
    {
      key: "itemName",
      label: "Product Title",
      sortable: true,
      render: (val: string) => (
        <div className="max-w-[260px]">
          <span className="font-semibold text-foreground text-sm block truncate" title={val}>
            {val || "—"}
          </span>
        </div>
      ),
    },
    {
      key: "skuList",
      label: "SKU / ASIN",
      sortable: true,
      render: (val: string, row: any) => (
        <div className="max-w-[260px]">
          <span className="font-mono text-xs font-bold text-foreground block whitespace-normal break-words" title={val}>
            {val}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">{row.asin || "—"}</span>
        </div>
      ),
    },
    {
      key: "price",
      label: "Price",
      sortable: true,
      render: (val: number) => <span className="font-medium text-foreground">{cur(val, currency)}</span>,
    },
    {
      key: "stockStatus",
      label: "Stock Status",
      sortable: true,
      render: (val: string) => {
        if (val === "Out of Stock") {
          return (
            <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-400 border border-red-200 dark:border-red-900">
              Out of Stock
            </span>
          );
        } else if (val === "Low Stock") {
          return (
            <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-400 border border-yellow-200 dark:border-yellow-900">
              Low Stock
            </span>
          );
        } else {
          return (
            <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-400 border border-green-200 dark:border-green-900">
              Healthy
            </span>
          );
        }
      },
    },
    {
      key: "fbaAvailable",
      label: usesReport ? "FBA Available" : "FBA (ledger)",
      sortable: true,
      render: (val: number | null, row: InventoryRow) => (
        <span className="inline-flex items-center gap-1 font-semibold">
          {val === null ? <span className="text-muted-foreground">—</span> : num(val)}
          {row.fbaNote && <span title={row.fbaNote}><AlertTriangle className="w-3.5 h-3.5 text-amber-500" /></span>}
        </span>
      ),
    },
    { key: "fbaReserved", label: "Reserved", sortable: true, render: (val: number | null) => (val === null ? "—" : num(val)) },
    { key: "fbaInbound", label: "Inbound", sortable: true, render: (val: number | null) => (val === null ? "—" : num(val)) },
    { key: "fbaUnfulfillable", label: "Unfulfillable", sortable: true, render: (val: number | null) => (val === null ? "—" : num(val)) },
    {
      key: "fbmQty",
      label: "FBM Stock",
      sortable: true,
      render: (val: number) => num(val),
    },
    {
      key: "totalQty",
      label: "Sellable Units",
      sortable: true,
      render: (val: number) => (
        <span className="font-bold text-foreground">{num(val)}</span>
      ),
    },
    {
      key: "totalValue",
      label: "Total Value",
      sortable: true,
      render: (val: number) => (
        <span className="font-bold text-green-600 dark:text-green-400">{cur(val, currency)}</span>
      ),
    },
    ...(usesReport ? [{
      key: "ledgerBalance",
      label: "Ledger (SellerMate)",
      sortable: true,
      render: (val: number | null) => <span className="text-muted-foreground" title="SellerMate's Inventory Ledger warehouse balance — reference only, not Available stock (different date and definition).">{val === null ? "—" : num(val)}</span>,
    }] : []),
  ];

  return (
    <div className="space-y-6 pb-10">
      {isError && (
        <QueryErrorState
          compact
          message="Inventory data couldn't load — retry, or the stock levels below may be incomplete rather than genuinely zero."
          onRetry={() => refetch()}
        />
      )}

      <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight mb-0.5">Inventory & Stock</h1>
        <p className="text-muted-foreground text-sm">
          {account?.name} · On-Hand Inventory
        </p>
        {data && (
          <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1 font-semibold text-foreground"><CalendarClock className="w-3.5 h-3.5 text-indigo-500" />
              {usesReport ? <>Data as of {data.reportAsOf ?? "unknown date"} — FBA Available from Amazon&apos;s FBA Inventory report</> : <>Data as of {data.ledgerAsOf ?? "unknown date"} — FBA from SellerMate ledger</>}
            </span>
            <span className="font-semibold text-foreground">Source: {usesReport ? "Amazon FBA Inventory Report" : "SellerMate (no Amazon report on file)"}</span>
            <span>Daily snapshot, not real-time</span>
            {dataUpdatedAt > 0 && <span>Last fetched: {new Date(dataUpdatedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</span>}
            <span>FBM: SellerMate listing sync</span>
            {usesReport && data.ledgerAsOf && <span>Ledger column: SellerMate, as of {data.ledgerAsOf}</span>}
          </p>
        )}
      </div>
      <InventoryTabs />
      </div>

      {data && (data.notes.length > 0 || flagged.length > 0) && (
        <div className="rounded-2xl border border-amber-200 dark:border-amber-900 bg-amber-50/60 dark:bg-amber-950/20 p-3 text-xs space-y-1">
          {data.notes.map((n) => <p key={n} className="flex gap-1.5 font-semibold text-amber-800 dark:text-amber-300"><Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />{n}</p>)}
          {flagged.length > 0 && (
            <p className="flex gap-1.5 text-amber-800 dark:text-amber-300"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              {flagged.length} product(s) need a check — hover the ⚠ in the FBA column: {flagged.slice(0, 6).map((f) => f.skuList).join(" · ")}{flagged.length > 6 ? " …" : ""}
            </p>
          )}
        </div>
      )}

      {contextLoading || isLoading ? (
        <div className="flex h-[400px] items-center justify-center text-muted-foreground flex-col gap-4 glass rounded-2xl border border-border">
          <Loader2 className="w-7 h-7 animate-spin text-primary" />
          <p className="font-semibold text-sm">{contextLoading ? "Connecting..." : "Loading Inventory..."}</p>
        </div>
      ) : (
        <>
          {/* KPI Dashboard */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <KPICard title="Total Value" value={cur(totalValue, currency)} subtitle="Valuation of on-hand inventory" delay={0.05} />
            <KPICard title="Healthy SKUs" value={num(healthyCount)} subtitle="20+ sellable units (FBA Available + FBM)" delay={0.1} />
            <KPICard title="Low Stock SKUs" value={num(lowStockCount)} subtitle="1 - 19 units (need fill)" delay={0.15} />
            <KPICard title="Out of Stock SKUs" value={num(outOfStockCount)} subtitle="0 units (immediate action)" delay={0.2} />
          </div>

          {/* Actionable Alerts Panel */}
          {(outOfStockCount > 0 || lowStockCount > 0) && (
            <div className="glass rounded-2xl border border-border p-5 shadow-sm space-y-3">
              <h3 className="font-bold text-sm flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500" /> Stock Health Insights & Recommendations
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {outOfStockList.slice(0, 3).map((item) => (
                  <div key={item.asin} className="p-3 rounded-xl border border-red-200 dark:border-red-900 bg-red-50/50 dark:bg-red-950/20 text-xs flex gap-2.5 items-start">
                    <XCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="font-bold text-red-800 dark:text-red-400">Out of Stock Alert</p>
                      <p className="font-semibold mt-0.5 truncate max-w-[200px]" title={item.itemName}>{item.itemName}</p>
                      <p className="text-muted-foreground mt-0.5 font-mono text-[10px]">SKU: {item.skuList} · ASIN: {item.asin}</p>
                      <p className="font-bold text-red-700 dark:text-red-500 mt-1.5">Action: Pause active PPC campaigns to save wasted clicks!</p>
                    </div>
                  </div>
                ))}
                {lowStockList.slice(0, 3).map((item) => (
                  <div key={item.asin} className="p-3 rounded-xl border border-yellow-200 dark:border-yellow-900 bg-yellow-50/50 dark:bg-yellow-950/20 text-xs flex gap-2.5 items-start">
                    <AlertTriangle className="w-4 h-4 text-yellow-500 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="font-bold text-yellow-800 dark:text-yellow-400">Low Stock (Need to Fill)</p>
                      <p className="font-semibold mt-0.5 truncate max-w-[200px]" title={item.itemName}>{item.itemName}</p>
                      <p className="text-muted-foreground mt-0.5 font-mono text-[10px]">SKU: {item.skuList} · ASIN: {item.asin} · Qty: {item.totalQty}</p>
                      <p className="font-bold text-yellow-700 dark:text-yellow-500 mt-1.5">Action: Replenish stock within 7 days to avoid BSR drop.</p>
                    </div>
                  </div>
                ))}
                {healthyCount > 0 && (
                  <div className="p-3 rounded-xl border border-green-200 dark:border-green-900 bg-green-50/50 dark:bg-green-950/20 text-xs flex gap-2.5 items-start">
                    <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="font-bold text-green-800 dark:text-green-400">PPC Scaling Opportunity</p>
                      <p className="font-semibold mt-0.5">{healthyCount} products are in healthy state</p>
                      <p className="text-muted-foreground mt-0.5">Sufficient inventory buffer available.</p>
                      <p className="font-bold text-green-700 dark:text-green-500 mt-1.5">Action: Scale up ad budgets on high-converting healthy SKUs.</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          <DataTable data={inventoryItems} columns={columns} defaultSort="totalValue" exportName="inventory" />
        </>
      )}
    </div>
  );
}
