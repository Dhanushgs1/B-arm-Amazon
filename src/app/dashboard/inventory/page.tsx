"use client";

import { useQuery } from "@tanstack/react-query";
import { useDashboard } from "@/lib/DashboardContext";
import { mcpAllInventory, fetchSkuMap } from "@/lib/api";
import { resolveProductName } from "@/lib/categoryMap";
import { DataTable } from "@/components/DataTable";
import { KPICard } from "@/components/KPICard";
import { QueryErrorState } from "@/components/QueryErrorState";
import { Loader2, PackageOpen, AlertTriangle, CheckCircle, XCircle } from "lucide-react";

const cur = (val: number, currency?: string) => {
  const sym = currency === "INR" ? "₹" : "$";
  if (!val) return `${sym}0`;
  return sym + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val));
};
const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));

export default function InventoryPage() {
  const { keySlot, account, contextLoading } = useDashboard();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["inventory_page", keySlot, account?.id],
    queryFn: async () => {
      const baseArgs = {
        amazon_account_id: account?.id,
        workspace_id: account?.workspace_id,
      };
      // get_inventory paginates with limit/offset (not page_size) — fetch every page,
      // and join SKUs from the product catalog since inventory rows return sku as "".
      const [items, skuMap] = await Promise.all([
        mcpAllInventory(baseArgs, keySlot),
        fetchSkuMap(baseArgs, keySlot),
      ]);

      return items.map((i: any) => {
        const fbmQty = i.fbm?.quantity || 0;
        const fbaQty = i.fba?.endingWarehouseBalance || 0;
        const totalQty = fbmQty + fbaQty;
        const totalValue = totalQty * (i.price || 0);
        const stockStatus = totalQty === 0 ? "Out of Stock" : totalQty < 20 ? "Low Stock" : "Healthy";
        const skus = i.sku ? [i.sku] : (skuMap[i.asin] || []);
        const skuList = skus.join(", ");
        return {
          ...i,
          itemName: resolveProductName(i.itemName, skuList) || i.itemName,
          skuList: skuList || "—",
          fbmQty,
          fbaQty,
          totalQty,
          totalValue,
          stockStatus,
        };
      });
    },
    enabled: !!account,
  });

  const currency = account?.currency;

  // Compute stock health summaries
  const inventoryItems = data || [];
  const totalValue = inventoryItems.reduce((acc: number, item: any) => acc + item.totalValue, 0);
  const healthyCount = inventoryItems.filter((item: any) => item.stockStatus === "Healthy").length;
  const lowStockCount = inventoryItems.filter((item: any) => item.stockStatus === "Low Stock").length;
  const outOfStockCount = inventoryItems.filter((item: any) => item.stockStatus === "Out of Stock").length;

  const outOfStockList = inventoryItems.filter((item: any) => item.stockStatus === "Out of Stock");
  const lowStockList = inventoryItems.filter((item: any) => item.stockStatus === "Low Stock");

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
      key: "fbaQty",
      label: "FBA Stock",
      sortable: true,
      render: (val: number) => num(val),
    },
    {
      key: "fbmQty",
      label: "FBM Stock",
      sortable: true,
      render: (val: number) => num(val),
    },
    {
      key: "totalQty",
      label: "Total Units",
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

      <div>
        <h1 className="text-2xl font-bold tracking-tight mb-0.5">Inventory & Stock</h1>
        <p className="text-muted-foreground text-sm">
          {account?.name} · On-Hand Inventory
        </p>
      </div>

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
            <KPICard title="Healthy SKUs" value={num(healthyCount)} subtitle="20+ units buffer" delay={0.1} />
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
                {outOfStockList.slice(0, 3).map((item: any) => (
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
                {lowStockList.slice(0, 3).map((item: any) => (
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
