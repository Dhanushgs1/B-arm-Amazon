"use client";

import { useState, useEffect } from "react";
import { Download, Loader2 } from "lucide-react";
import { useDashboard } from "@/lib/DashboardContext";
import { exportToExcel } from "@/lib/excelExport";
import { fetchShopifyOrdersDataInfo, fetchShopifyOrdersInRange, shopifyTotals } from "@/lib/shopifyOrders";

// Mirrors /dashboard/barm/reports. One row per Shopify order (test orders excluded) for the dates
// selected at the top of the dashboard; cancelled orders stay in the file, marked, with Sales 0.
export default function ShopifyReportsPage() {
  const { startDate, endDate } = useDashboard();
  const [info, setInfo] = useState<Awaited<ReturnType<typeof fetchShopifyOrdersDataInfo>> | null>(null);
  const [generating, setGenerating] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetchShopifyOrdersDataInfo().then(setInfo);
  }, []);

  const handleDownload = async () => {
    setGenerating(true);
    setMsg(null);
    setFailed(false);
    try {
      const orders = await fetchShopifyOrdersInRange(startDate, endDate);
      if (!orders.length) throw new Error(`no Shopify orders between ${startDate} and ${endDate}.`);
      const rows = orders.map((o) => ({
        order_name: o.order_name,
        order_date: o.order_date,
        status: o.is_cancelled ? "Cancelled" : "Active",
        items: o.items.map((i) => `${i.title ?? ""}${i.variant_title ? ` (${i.variant_title})` : ""} × ${i.quantity}`).join("; "),
        skus: o.items.map((i) => i.sku ?? "").filter(Boolean).join("; "),
        quantity: o.item_quantity,
        financial_status: o.financial_status ?? "",
        fulfillment_status: o.fulfillment_status ?? "unfulfilled",
        subtotal: o.subtotal,
        discounts: o.discounts,
        shipping: o.shipping,
        tax: o.tax,
        total: o.total,
        sales: o.is_cancelled ? 0 : o.total,
      }));
      const filename = `Shopify_Orders_${startDate}_to_${endDate}`;
      exportToExcel(
        rows,
        [
          { key: "order_name", label: "Order" },
          { key: "order_date", label: "Order Date (IST)" },
          { key: "status", label: "Status" },
          { key: "items", label: "Items" },
          { key: "skus", label: "SKU" },
          { key: "quantity", label: "Quantity" },
          { key: "financial_status", label: "Payment Status" },
          { key: "fulfillment_status", label: "Fulfilment Status" },
          { key: "subtotal", label: "Subtotal" },
          { key: "discounts", label: "Discounts" },
          { key: "shipping", label: "Shipping" },
          { key: "tax", label: "Tax" },
          { key: "total", label: "Order Total" },
          { key: "sales", label: "Sales (excl. cancelled)" },
        ],
        filename
      );
      const t = shopifyTotals(orders);
      setMsg(
        `Downloaded ${filename}.xlsx — ${t.orders} orders (${t.cancelled} cancelled, ${t.netOrders} net), Sales ₹${t.sales.toLocaleString("en-IN", { minimumFractionDigits: 2 })}.`
      );
    } catch (err) {
      setFailed(true);
      setMsg("Failed: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="space-y-8 pb-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight mb-0.5">Download</h1>
        <p className="text-muted-foreground text-sm">Shopify · Download and export order reports</p>
      </div>

      <div className="glass rounded-2xl border border-border p-6 shadow-sm">
        <h3 className="font-bold text-sm mb-1">Shopify Orders (order-wise)</h3>
        <p className="text-xs text-muted-foreground mb-4">
          One row per Shopify order for the dates selected at the top of the dashboard ({startDate || "?"} to{" "}
          {endDate || "?"}), with its items, statuses and totals. Cancelled orders are kept and marked, with Sales 0;
          Shopify test orders are left out.
        </p>
        <button
          onClick={handleDownload}
          disabled={generating || !startDate || !endDate}
          className="px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-bold rounded-lg transition-colors flex items-center gap-2 shadow-md disabled:opacity-50"
        >
          {generating ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Generating…
            </>
          ) : (
            <>
              <Download size={14} /> Download Orders
            </>
          )}
        </button>
        {msg && <p className={`text-xs mt-3 font-semibold ${failed ? "text-red-600 dark:text-red-400" : ""}`}>{msg}</p>}
        <p className="text-xs text-muted-foreground mt-3">
          {!info
            ? "Checking what's on file…"
            : info.error
            ? `Couldn't check — ${info.error}`
            : info.orderCount
            ? `Shopify Orders: ${info.minDate ?? "?"} to ${info.maxDate ?? "?"} (${info.orderCount.toLocaleString("en-IN")} orders)`
            : "No Shopify orders yet"}
        </p>
      </div>
    </div>
  );
}
