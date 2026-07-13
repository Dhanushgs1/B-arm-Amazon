"use client";

import { useQuery } from "@tanstack/react-query";
import { useDashboard } from "@/lib/DashboardContext";
import { mcp } from "@/lib/api";
import { X, Loader2, Sparkles, Box, TrendingUp, HelpCircle } from "lucide-react";
import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";

const cur = (val: number, currency?: string) => {
  const sym = currency === "INR" ? "₹" : "$";
  if (!val) return `${sym}0`;
  return sym + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val));
};
const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));
const pct = (val: number) => `${(val || 0).toFixed(2)}%`;

export function ProductDetailDrawer() {
  const { selectedAsin, setSelectedAsin, keySlot, account, startDate, endDate } = useDashboard();
  const [activeTab, setActiveTab] = useState<string>("overview");
  const [geminiInsights, setGeminiInsights] = useState<string>("");
  const [loadingInsights, setLoadingInsights] = useState<boolean>(false);

  // Close on Escape key press
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedAsin(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setSelectedAsin]);

  // Reset tab when ASIN changes
  useEffect(() => {
    setActiveTab("overview");
    setGeminiInsights("");
  }, [selectedAsin]);

  const baseArgs = {
    amazon_account_id: account?.id,
    workspace_id: account?.workspace_id,
    start_date: startDate,
    end_date: endDate,
  };

  // 1. Fetch advertised product performance to get stats
  const { data: productPerfData, isLoading: perfLoading } = useQuery({
    queryKey: ["product_detail_perf", keySlot, account?.id, selectedAsin, startDate, endDate],
    queryFn: () => mcp("get_advertised_product_performance", { ...baseArgs, page_size: 500 }, keySlot),
    enabled: !!account && !!selectedAsin,
  });

  // 2. Fetch inventory data to get stock levels
  const { data: inventoryData, isLoading: invLoading } = useQuery({
    queryKey: ["product_detail_inventory", keySlot, account?.id, selectedAsin],
    queryFn: () => mcp("get_inventory", { amazon_account_id: account?.id, workspace_id: account?.workspace_id, page_size: 500 }, keySlot),
    enabled: !!account && !!selectedAsin,
  });

  // Find target items
  const productPerf = (productPerfData?.data || []).find((p: any) => p.adAsin === selectedAsin || p.asin === selectedAsin);
  const inventoryItem = (inventoryData?.items || []).find((i: any) => i.asin === selectedAsin);

  // 3. Generate Gemini Insights on demand
  const generateInsights = async () => {
    if (!productPerf) return;
    setLoadingInsights(true);
    setGeminiInsights("");
    try {
      const fbaQty = inventoryItem?.fba?.endingWarehouseBalance || 0;
      const fbmQty = inventoryItem?.fbm?.quantity || 0;
      const totalStock = fbaQty + fbmQty;

      const prompt = `Analyze this Amazon product performance and stock details:
- Product ASIN: ${selectedAsin}
- Product Name: ${productPerf.adProductName || inventoryItem?.itemName || "—"}
- Ad Spend: ${cur(productPerf.spend, account?.currency)}
- Ad Sales: ${cur(productPerf.sales, account?.currency)}
- Orders: ${num(productPerf.orders)}
- Clicks: ${num(productPerf.clicks)}
- Impressions: ${num(productPerf.impressions)}
- ACOS: ${pct(productPerf.acos)}
- ROAS: ${productPerf.roas?.toFixed(2)}x
- Total Stock: ${num(totalStock)} units (FBA: ${num(fbaQty)}, FBM: ${num(fbmQty)})
- Selling Price: ${cur(inventoryItem?.price || 0, account?.currency)}

Provide:
1. Executive performance summary (Is this product converting well, and is its ACOS/ROAS healthy?).
2. Stock & Inventory strategy (Is it at risk of stock-out based on sales volume?).
3. Actionable advertising tips (Scale up spend, pause target keywords, optimize landing page detail).
Write directly and professionally in bullet points.`;

      const response = await fetch("/api/gemini-insights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt })
      });

      if (!response.ok) throw new Error("Gemini API proxy call failed");
      const data = await response.json();
      setGeminiInsights(data.text || "No insights generated.");
    } catch (e: any) {
      console.error(e);
      setGeminiInsights("Failed to load Gemini insights. Verify your Google AI Studio project status or API key permissions.");
    } finally {
      setLoadingInsights(false);
    }
  };

  useEffect(() => {
    if (activeTab === "insights" && !geminiInsights && productPerf) {
      generateInsights();
    }
  }, [activeTab, productPerf]);

  if (!selectedAsin) return null;

  const currency = account?.currency;

  // Overview Stats
  const spend = productPerf?.spend || 0;
  const sales = productPerf?.sales || 0;
  const orders = productPerf?.orders || 0;
  const clicks = productPerf?.clicks || 0;
  const impressions = productPerf?.impressions || 0;
  const acos = productPerf?.acos || 0;
  const roas = productPerf?.roas || 0;
  const ctr = impressions ? (clicks / impressions) * 100 : 0;
  const cpc = clicks ? spend / clicks : 0;
  const cvr = clicks ? (orders / clicks) * 100 : 0;

  // Inventory Stats
  const fbaQty = inventoryItem?.fba?.endingWarehouseBalance || 0;
  const fbmQty = inventoryItem?.fbm?.quantity || 0;
  const totalStock = fbaQty + fbmQty;
  const price = inventoryItem?.price || 0;
  const totalValue = totalStock * price;

  const tabs = [
    { id: "overview", label: "Overview", icon: TrendingUp },
    { id: "inventory", label: "Inventory", icon: Box },
    { id: "insights", label: "AI Insights", icon: Sparkles },
  ];

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-sm transition-opacity duration-300">
      {/* Click Outside to Close */}
      <div className="absolute inset-0" onClick={() => setSelectedAsin(null)} />

      {/* Drawer Panel */}
      <div className="relative w-full max-w-3xl h-full bg-background border-l border-border shadow-2xl flex flex-col z-10 animate-in slide-in-from-right duration-300">
        {/* Header */}
        <div className="p-6 border-b border-border flex items-center justify-between bg-card/30">
          <div className="min-w-0 flex items-start gap-4">
            {inventoryItem?.mainImageUrl && (
              <img src={inventoryItem.mainImageUrl} alt="" className="w-12 h-12 rounded-lg object-cover border border-border flex-shrink-0 bg-white" />
            )}
            <div className="min-w-0">
              <span className="text-xs text-muted-foreground font-mono">
                ASIN: {selectedAsin}
              </span>
              <h2 className="text-base font-bold tracking-tight truncate text-foreground pr-4" title={productPerf?.adProductName || inventoryItem?.itemName}>
                {productPerf?.adProductName || inventoryItem?.itemName || "Advertised Product"}
              </h2>
            </div>
          </div>
          <button
            onClick={() => setSelectedAsin(null)}
            className="w-8 h-8 rounded-full border border-border flex items-center justify-center hover:bg-muted text-muted-foreground transition-colors flex-shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="px-6 border-b border-border flex gap-1 bg-card/10 overflow-x-auto whitespace-nowrap">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "flex items-center gap-2 px-4 py-3 text-xs font-bold border-b-2 transition-all duration-200",
                  isActive
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {perfLoading || invLoading ? (
            <div className="flex h-[300px] items-center justify-center flex-col gap-4 text-muted-foreground">
              <Loader2 className="w-7 h-7 animate-spin text-primary" />
              <p className="font-semibold text-sm">Loading product details...</p>
            </div>
          ) : (
            <>
              {/* Tab Contents */}
              {activeTab === "overview" && (
                <div className="space-y-6">
                  {/* KPI Stats */}
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                    <div className="glass p-4 rounded-xl border border-border">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Spend</p>
                      <p className="text-lg font-black mt-1 text-foreground">{cur(spend, currency)}</p>
                    </div>
                    <div className="glass p-4 rounded-xl border border-border">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Sales</p>
                      <p className="text-lg font-black mt-1 text-green-600 dark:text-green-400">{cur(sales, currency)}</p>
                    </div>
                    <div className="glass p-4 rounded-xl border border-border">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Orders</p>
                      <p className="text-lg font-black mt-1 text-foreground">{num(orders)}</p>
                    </div>
                    <div className="glass p-4 rounded-xl border border-border">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">ACOS</p>
                      <p className="text-lg font-black mt-1 text-foreground">{pct(acos)}</p>
                    </div>
                    <div className="glass p-4 rounded-xl border border-border">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">ROAS</p>
                      <p className="text-lg font-black mt-1 text-foreground">{roas ? roas.toFixed(2) : "—"}</p>
                    </div>
                    <div className="glass p-4 rounded-xl border border-border">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">CTR</p>
                      <p className="text-lg font-black mt-1 text-foreground">{pct(ctr)}</p>
                    </div>
                    <div className="glass p-4 rounded-xl border border-border">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">CPC</p>
                      <p className="text-lg font-black mt-1 text-foreground">{cur(cpc, currency)}</p>
                    </div>
                    <div className="glass p-4 rounded-xl border border-border">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">CVR</p>
                      <p className="text-lg font-black mt-1 text-foreground">{pct(cvr)}</p>
                    </div>
                    <div className="glass p-4 rounded-xl border border-border">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Clicks</p>
                      <p className="text-lg font-black mt-1 text-foreground">{num(clicks)}</p>
                    </div>
                    <div className="glass p-4 rounded-xl border border-border">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Impressions</p>
                      <p className="text-lg font-black mt-1 text-foreground">{num(impressions)}</p>
                    </div>
                  </div>

                  {/* Settings Table */}
                  <div className="glass rounded-xl border border-border overflow-hidden">
                    <div className="p-4 border-b border-border bg-card/20">
                      <h3 className="font-bold text-sm">Product Catalog Details</h3>
                    </div>
                    <table className="w-full text-left text-xs divide-y divide-border">
                      <tbody className="divide-y divide-border bg-card/5">
                        <tr className="hover:bg-muted/10 transition-colors">
                          <td className="px-4 py-3 font-semibold text-muted-foreground w-1/3">ASIN</td>
                          <td className="px-4 py-3 font-mono font-bold">{selectedAsin}</td>
                        </tr>
                        <tr className="hover:bg-muted/10 transition-colors">
                          <td className="px-4 py-3 font-semibold text-muted-foreground">Seller SKU</td>
                          <td className="px-4 py-3 font-mono font-bold">{inventoryItem?.sku || "—"}</td>
                        </tr>
                        <tr className="hover:bg-muted/10 transition-colors">
                          <td className="px-4 py-3 font-semibold text-muted-foreground">Selling Price</td>
                          <td className="px-4 py-3 font-bold">{cur(price, currency)}</td>
                        </tr>
                        <tr className="hover:bg-muted/10 transition-colors">
                          <td className="px-4 py-3 font-semibold text-muted-foreground">Inventory Status</td>
                          <td className="px-4 py-3 font-bold">
                            <span className={cn("px-2 py-0.5 rounded-full text-[10px] font-bold uppercase", totalStock > 20 ? "bg-green-500/10 text-green-600" : totalStock > 0 ? "bg-yellow-500/10 text-yellow-600" : "bg-red-500/10 text-red-600")}>
                              {totalStock > 20 ? "In Stock" : totalStock > 0 ? "Low Stock" : "Out of Stock"}
                            </span>
                          </td>
                        </tr>
                        <tr className="hover:bg-muted/10 transition-colors">
                          <td className="px-4 py-3 font-semibold text-muted-foreground">Total On-Hand Stock</td>
                          <td className="px-4 py-3 font-bold">{num(totalStock)} units</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {activeTab === "inventory" && (
                <div className="space-y-6">
                  {/* Stock Breakdown */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="glass p-4 rounded-xl border border-border">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">FBA Warehouse Balance</p>
                      <p className="text-lg font-black mt-1 text-foreground">{num(fbaQty)} units</p>
                    </div>
                    <div className="glass p-4 rounded-xl border border-border">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">FBM Merchant Stock</p>
                      <p className="text-lg font-black mt-1 text-foreground">{num(fbmQty)} units</p>
                    </div>
                    <div className="glass p-4 rounded-xl border border-border">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Estimated Stock Value</p>
                      <p className="text-lg font-black mt-1 text-emerald-600 dark:text-emerald-400">{cur(totalValue, currency)}</p>
                    </div>
                  </div>

                  {/* FBA Warehouse Details */}
                  {inventoryItem?.fba && (
                    <div className="glass rounded-xl border border-border overflow-hidden">
                      <div className="p-4 border-b border-border bg-card/20">
                        <h3 className="font-bold text-sm">FBA Detailed Stock</h3>
                      </div>
                      <table className="w-full text-left text-xs divide-y divide-border">
                        <tbody className="divide-y divide-border bg-card/5">
                          <tr className="hover:bg-muted/10 transition-colors">
                            <td className="px-4 py-3 font-semibold text-muted-foreground w-1/3">Warehouse Balance</td>
                            <td className="px-4 py-3 font-bold">{num(inventoryItem.fba.endingWarehouseBalance)} units</td>
                          </tr>
                          <tr className="hover:bg-muted/10 transition-colors">
                            <td className="px-4 py-3 font-semibold text-muted-foreground">In Transit</td>
                            <td className="px-4 py-3 font-bold">{num(inventoryItem.fba.inTransitOrWorking)} units</td>
                          </tr>
                          <tr className="hover:bg-muted/10 transition-colors">
                            <td className="px-4 py-3 font-semibold text-muted-foreground">Customer Orders Reserved</td>
                            <td className="px-4 py-3 font-bold">{num(inventoryItem.fba.pendingCustomerOrderQuantity)} units</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {activeTab === "insights" && (
                <div className="glass rounded-xl border border-border p-5 space-y-4">
                  <div className="flex items-center gap-2 text-primary font-bold text-sm">
                    <Sparkles className="w-4 h-4" />
                    <span>Gemini AI Analysis</span>
                  </div>
                  {loadingInsights ? (
                    <div className="py-12 text-center text-muted-foreground flex flex-col items-center justify-center gap-3">
                      <Loader2 className="w-6 h-6 animate-spin text-primary" />
                      <p className="text-xs font-semibold">Gemini is analyzing your product stats...</p>
                    </div>
                  ) : (
                    <div className="text-xs leading-relaxed text-foreground space-y-3 whitespace-pre-line font-medium opacity-90">
                      {geminiInsights}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
