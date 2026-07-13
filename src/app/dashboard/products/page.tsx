"use client";

import { useQuery } from "@tanstack/react-query";
import { useDashboard } from "@/lib/DashboardContext";
import { mcp } from "@/lib/api";
import { DataTable } from "@/components/DataTable";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const cur = (val: number, currency?: string) => {
  const sym = currency === "INR" ? "₹" : "$";
  if (!val) return `${sym}0`;
  return sym + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val));
};
const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));
const pct = (val: number) => `${(val || 0).toFixed(2)}%`;

export default function ProductsPage() {
  const { keySlot, startDate, endDate, account, contextLoading, setSelectedAsin } = useDashboard();

  const { data, isLoading } = useQuery({
    queryKey: ["products_tab", keySlot, account?.id, startDate, endDate],
    queryFn: async () => {
      const res = await mcp("get_advertised_product_performance", {
        amazon_account_id: account?.id,
        workspace_id: account?.workspace_id,
        start_date: startDate,
        end_date: endDate,
        page_size: 500,
      }, keySlot);
      return res.data || res.products || [];
    },
    enabled: !!account,
  });

  const currency = account?.currency;

  const columns = [
    {
      key: "adAsin",
      label: "ASIN",
      sortable: true,
      render: (val: string, row: any) => (
        <button
          onClick={() => setSelectedAsin(val || row.asin)}
          className="font-mono font-bold text-primary hover:underline text-xs text-left focus:outline-none"
        >
          {val || row.asin || "—"}
        </button>
      ),
    },
    {
      key: "adProductName",
      label: "Product Name",
      sortable: true,
      render: (val: string, row: any) => (
        <button
          onClick={() => setSelectedAsin(row.adAsin || row.asin)}
          className="font-semibold text-foreground hover:text-primary text-left text-sm block max-w-[280px] truncate focus:outline-none"
          title={val}
        >
          {val || "—"}
        </button>
      ),
    },
    {
      key: "spend",
      label: "Spend",
      sortable: true,
      render: (val: number) => <span className="font-medium text-foreground">{cur(val, currency)}</span>,
    },
    {
      key: "sales",
      label: "Sales",
      sortable: true,
      render: (val: number) => <span className="text-green-600 dark:text-green-400 font-bold">{cur(val, currency)}</span>,
    },
    {
      key: "acos",
      label: "ACOS",
      sortable: true,
      render: (val: number) => (
        <span className={cn("px-2 py-0.5 rounded-full text-xs font-bold", val && val < 20 ? "bg-green-500/10 text-green-700 dark:text-green-400" : val && val > 40 ? "bg-red-500/10 text-red-700 dark:text-red-400" : "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400")}>
          {val ? pct(val) : "—"}
        </span>
      ),
    },
    {
      key: "roas",
      label: "ROAS",
      sortable: true,
      render: (val: number) => <span className="font-semibold">{val ? val.toFixed(2) : "—"}</span>,
    },
    {
      key: "impressions",
      label: "Impressions",
      sortable: true,
      render: (val: number) => num(val),
    },
    {
      key: "clicks",
      label: "Clicks",
      sortable: true,
      render: (val: number) => num(val),
    },
    {
      key: "orders",
      label: "Orders",
      sortable: true,
      render: (val: number) => num(val),
    },
    {
      key: "ctr",
      label: "CTR",
      sortable: true,
      render: (val: number) => val ? pct(val) : "—",
    },
    {
      key: "cpc",
      label: "CPC",
      sortable: true,
      render: (val: number) => cur(val, currency),
    },
  ];

  return (
    <div className="space-y-6 pb-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight mb-0.5">Advertised Products</h1>
        <p className="text-muted-foreground text-sm">
          {account?.name} · {startDate} → {endDate}
        </p>
      </div>

      {contextLoading || isLoading ? (
        <div className="flex h-[400px] items-center justify-center text-muted-foreground flex-col gap-4 glass rounded-2xl border border-border">
          <Loader2 className="w-7 h-7 animate-spin text-primary" />
          <p className="font-semibold text-sm">{contextLoading ? "Connecting..." : "Loading Products..."}</p>
        </div>
      ) : (
        <DataTable data={data || []} columns={columns} defaultSort="spend" />
      )}
    </div>
  );
}
