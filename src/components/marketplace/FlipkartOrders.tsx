"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2, Info } from "lucide-react";
import { useDashboard } from "@/lib/DashboardContext";
import { DataTable } from "@/components/DataTable";
import { fetchFlipkartOrders } from "@/lib/flipkartData";
import { cn } from "@/lib/utils";

const cur = (val: number) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val || 0))}`;

// Flipkart order statuses vary; colour the common ones, grey-out the rest.
const statusStyle = (s: string) => {
  const v = (s || "").toUpperCase();
  if (v.includes("DELIVER")) return "text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30";
  if (v.includes("TRANSIT") || v.includes("SHIP")) return "text-blue-600 bg-blue-50 dark:bg-blue-950/30";
  if (v.includes("RTO") || v.includes("RETURN")) return "text-red-600 bg-red-50 dark:bg-red-950/30";
  if (v.includes("CANCEL")) return "text-slate-500 bg-slate-100 dark:bg-slate-800";
  return "text-amber-600 bg-amber-50 dark:bg-amber-950/30";
};

export function FlipkartOrders() {
  const { loggedInUser, startDate, endDate } = useDashboard();

  const { data, isLoading } = useQuery({
    queryKey: ["flipkart-orders", loggedInUser, startDate, endDate],
    queryFn: () => fetchFlipkartOrders(loggedInUser, startDate, endDate),
    enabled: !!startDate && !!endDate,
  });

  if (isLoading || !data) {
    return (
      <div className="flex h-[60vh] items-center justify-center flex-col gap-4 text-muted-foreground">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <p className="font-semibold text-sm">Loading Flipkart orders...</p>
      </div>
    );
  }

  const { min, max } = data.availableRange;

  return (
    <div className="space-y-6 pb-12">
      <div className="space-y-1 border-b border-slate-200/50 dark:border-slate-800/50 pb-4">
        <h1 className="text-3xl font-black tracking-tight text-slate-900 dark:text-white">Flipkart Orders</h1>
        <p className="text-slate-500 dark:text-slate-400 text-xs">{data.rows.length} orders · {startDate} – {endDate}</p>
      </div>

      {data.rows.length === 0 && (
        <div className="rounded-2xl border border-amber-300/40 bg-amber-50 dark:bg-amber-950/20 px-4 py-3 text-xs font-semibold text-amber-700 dark:text-amber-300 flex items-start gap-2.5">
          <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>
            No order-level records for this date range. Order-level data comes from Orders&nbsp;P&amp;L uploads in the Flipkart Hub.
            {min && max ? <> Available range: <strong>{min} → {max}</strong>. Pick a date range inside that window to see orders.</> : <> Upload an Orders P&amp;L file to populate this page.</>}
          </span>
        </div>
      )}

      <DataTable
        data={data.rows}
        exportName="flipkart_orders"
        defaultSort="date"
        disablePagination={false}
        pageSize={50}
        columns={[
          { key: "orderId", label: "Order Item ID", sortable: true },
          { key: "date", label: "Date", sortable: true },
          { key: "product", label: "Product", sortable: true },
          { key: "qty", label: "Qty", sortable: true, summable: true },
          { key: "amount", label: "Net Sales", sortable: true, summable: true, render: (v) => cur(v) },
          { key: "fulfillment", label: "Fulfilment", sortable: true },
          { key: "zone", label: "Zone", sortable: true },
          {
            key: "status",
            label: "Status",
            sortable: true,
            render: (v) => <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded-full", statusStyle(v))}>{v}</span>,
          },
        ]}
      />
    </div>
  );
}
