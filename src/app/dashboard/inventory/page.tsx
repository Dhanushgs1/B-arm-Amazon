"use client";

import { useQuery } from "@tanstack/react-query";
import { useDashboard } from "@/lib/DashboardContext";
import { mcp } from "@/lib/api";
import { DataTable } from "@/components/DataTable";
import { Loader2, PackageOpen } from "lucide-react";

const cur = (val: number, currency?: string) => {
  const sym = currency === "INR" ? "₹" : "$";
  if (!val) return `${sym}0`;
  return sym + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val));
};
const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));

export default function InventoryPage() {
  const { keySlot, account, contextLoading } = useDashboard();

  const { data, isLoading } = useQuery({
    queryKey: ["inventory_page", keySlot, account?.id],
    queryFn: async () => {
      const res = await mcp("get_inventory", {
        amazon_account_id: account?.id,
        workspace_id: account?.workspace_id,
        page_size: 200,
      }, keySlot);
      
      const items = res.items || [];
      return items.map((i: any) => {
        const fbmQty = i.fbm?.quantity || 0;
        const fbaQty = i.fba?.endingWarehouseBalance || 0;
        const totalQty = fbmQty + fbaQty;
        const totalValue = totalQty * (i.price || 0);
        return {
          ...i,
          fbmQty,
          fbaQty,
          totalQty,
          totalValue,
        };
      });
    },
    enabled: !!account,
  });

  const currency = account?.currency;

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
      render: (val: string, row: any) => (
        <div className="max-w-[280px]">
          <span className="font-semibold text-foreground text-sm block truncate" title={val}>
            {val || "—"}
          </span>
          <span className="text-[10px] text-muted-foreground font-mono">
            ASIN: {row.asin || "—"} | SKU: {row.sku || "—"}
          </span>
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
        <DataTable data={data || []} columns={columns} defaultSort="totalValue" />
      )}
    </div>
  );
}
