"use client";

import { useQuery } from "@tanstack/react-query";
import { useDashboard } from "@/lib/DashboardContext";
import { mcp, mcpAllInventory } from "@/lib/api";
import { X, Loader2, Sparkles, Box, TrendingUp, RefreshCw, AlertTriangle } from "lucide-react";
import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { resolveProductName } from "@/lib/categoryMap";
import { fetchAllRows } from "@/lib/amazonReportShared";
import { buildInventory, type FbaReportRow } from "@/lib/inventoryStock";

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
  const [loadingProgress, setLoadingProgress] = useState<number>(0);
  const [insightError, setInsightError] = useState<string>("");

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedAsin(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setSelectedAsin]);

  useEffect(() => {
    setActiveTab("overview");
    setGeminiInsights("");
    setInsightError("");
  }, [selectedAsin]);

  const baseArgs = {
    amazon_account_id: account?.id,
    workspace_id: account?.workspace_id,
    start_date: startDate,
    end_date: endDate,
  };

  // 1. Advertised product performance
  const { data: productPerfData, isLoading: perfLoading } = useQuery({
    queryKey: ["product_detail_perf", keySlot, account?.id, selectedAsin, startDate, endDate],
    queryFn: () => mcp("get_advertised_product_performance", { ...baseArgs, page_size: 500 }, keySlot),
    enabled: !!account && !!selectedAsin,
  });

  // 2. Inventory data — get_inventory paginates with limit/offset (max 200), not
  // page_size, so a single call only returns the first ~50 items. mcpAllInventory
  // walks every page so the clicked ASIN is actually found regardless of its position.
  const { data: inventoryItems, isLoading: invLoading } = useQuery({
    queryKey: ["product_detail_inventory", keySlot, account?.id],
    queryFn: () => mcpAllInventory({ amazon_account_id: account?.id, workspace_id: account?.workspace_id }, keySlot),
    enabled: !!account && !!selectedAsin,
  });

  // 3. Campaign performance for this ASIN
  const { data: campaignPerfData } = useQuery({
    queryKey: ["product_campaign_perf", keySlot, account?.id, selectedAsin, startDate, endDate],
    queryFn: () => mcp("get_campaign_performance", { ...baseArgs, page_size: 100 }, keySlot),
    enabled: !!account && !!selectedAsin && activeTab === "insights",
  });

  const productPerf = (productPerfData?.data || []).find((p: any) => p.adAsin === selectedAsin || p.asin === selectedAsin);
  const inventoryItem = (inventoryItems || []).find((i: any) => i.asin === selectedAsin);

  // Stock uses the same definition as the Inventory page (src/lib/inventoryStock.ts): FBA Available,
  // Inbound, Reserved, Unfulfillable from Amazon's FBA Inventory report. SellerMate does not send
  // inbound/reserved at all — reading fba.inTransitOrWorking / pendingCustomerOrderQuantity from it
  // showed "0 units" for every product.
  const { data: fbaReport } = useQuery({
    queryKey: ["fba_inventory_report"],
    queryFn: () => fetchAllRows("barm_amazon_fba_inventory", (q) => q).catch(() => []) as Promise<FbaReportRow[]>,
    enabled: !!selectedAsin,
  });
  const stockResult = inventoryItems ? buildInventory(inventoryItems, {}, fbaReport || []) : null;
  const stockRow = stockResult?.rows.find((r) => r.asin === selectedAsin) ?? null;
  const stock = {
    fba: stockRow?.fbaAvailable ?? 0,
    fbaKnown: stockRow?.fbaAvailable !== null && stockRow?.fbaAvailable !== undefined,
    fbm: stockRow?.fbmQty ?? 0,
  };
  const qty = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${num(v)} units`);
  const displayName = resolveProductName(productPerf?.adProductName || inventoryItem?.itemName, inventoryItem?.sku)
    || productPerf?.adProductName || inventoryItem?.itemName || selectedAsin;

  const topCampaigns = (campaignPerfData?.campaigns || [])
    .sort((a: any, b: any) => (b.spend || 0) - (a.spend || 0))
    .slice(0, 5);

  const generateInstantFallback = () => {
    const fbaQty = stock.fba;
    const fbmQty = stock.fbm;
    const totalStock = fbaQty + fbmQty;
    const spendVal = productPerf?.spend || 0;
    const salesVal = productPerf?.sales || 0;
    const ordersVal = productPerf?.orders || 0;
    const acosVal = productPerf?.acos || 0;
    const roasVal = productPerf?.roas || 0;
    const clicksVal = productPerf?.clicks || 0;
    const price = inventoryItem?.price || 0;

    const daysOfStock = ordersVal && totalStock ? Math.round(totalStock / (ordersVal / 30)) : null;

    let verdict = `This ASIN generated ${cur(salesVal, account?.currency)} in ad sales from ${cur(spendVal, account?.currency)} spend across ${num(ordersVal)} orders.`;
    if (acosVal > 35) {
      verdict += ` ACOS is currently high at ${pct(acosVal)}, which means advertising costs are eating into margins.`;
    } else if (roasVal > 4) {
      verdict += ` Strong profitability with a ROAS of ${roasVal.toFixed(2)}x and healthy ACOS of ${pct(acosVal)}.`;
    } else {
      verdict += ` Performance is moderate with ACOS at ${pct(acosVal)} and ROAS at ${roasVal.toFixed(2)}x.`;
    }

    let campaignRec = `Active in ${topCampaigns.length || 1} campaigns.`;
    if (acosVal > 35) {
      campaignRec += ` Reduce bids on non-converting targets by 15-25% to bring ACOS below 30%.`;
    } else if (roasVal > 4) {
      campaignRec += ` Increase budgets on top converting campaigns to scale ad revenue further.`;
    } else {
      campaignRec += ` Optimize bids towards high-conversion search terms to improve efficiency.`;
    }

    let invAlert = `Total on-hand stock: ${num(totalStock)} units (FBA: ${num(fbaQty)}, FBM: ${num(fbmQty)}) valued at ${cur(totalStock * price, account?.currency)}.`;
    if (daysOfStock && daysOfStock < 30) {
      invAlert += ` ⚠ Stock alert: Only ~${daysOfStock} days of inventory left based on run-rate. Initiate replenishment immediately.`;
    } else {
      invAlert += ` Stock level is healthy for current demand.`;
    }

    let actions = `- Lower bids on keywords with high spend and zero orders.\n- ${daysOfStock && daysOfStock < 30 ? "Replenish FBA stock immediately to avoid stockout penalty." : "Monitor top search terms for exact match scaling."}\n- Review product detail page conversion rate (CVR: ${productPerf?.clicks ? pct((ordersVal / clicksVal) * 100) : "—"}).`;

    return `1. PERFORMANCE VERDICT\n${verdict}\n\n2. CAMPAIGN RECOMMENDATIONS\n${campaignRec}\n\n3. INVENTORY ALERT\n${invAlert}\n\n4. TOP 3 ACTION ITEMS\n${actions}`;
  };

  const generateInsights = async () => {
    setLoadingInsights(true);
    setLoadingProgress(10);
    setGeminiInsights("");
    setInsightError("");

    const progressInterval = setInterval(() => {
      setLoadingProgress((prev) => {
        if (prev >= 92) return prev;
        if (prev < 40) return prev + 15;
        if (prev < 75) return prev + 10;
        return prev + 5;
      });
    }, 400);

    const fbaQty = stock.fba;
    const fbmQty = stock.fbm;
    const totalStock = fbaQty + fbmQty;
    const price = inventoryItem?.price || 0;
    const daysOfStock = productPerf?.orders && totalStock ? Math.round(totalStock / (productPerf.orders / 30)) : null;

    const campaignLines = topCampaigns.length > 0
      ? topCampaigns.map((c: any) =>
          `  - ${c.campaignName || "Campaign"}: Spend ${cur(c.spend || 0, account?.currency)}, Sales ${cur(c.totalSales || 0, account?.currency)}, ACOS ${pct(c.acos || 0)}, ROAS ${(c.roas || 0).toFixed(2)}x`
        ).join("\n")
      : "  - Campaign data loading or not linked";

    const prompt = `You are an Amazon PPC analyst. Analyze this REAL data for an Amazon product and give sharp, actionable insights. Be direct and concise.

PRODUCT: ${displayName}
ASIN: ${selectedAsin}
Period: ${startDate} to ${endDate}

== AD PERFORMANCE ==
- Ad Spend: ${cur(productPerf?.spend || 0, account?.currency)}
- Ad Sales: ${cur(productPerf?.sales || 0, account?.currency)}
- Orders: ${num(productPerf?.orders || 0)}
- Clicks: ${num(productPerf?.clicks || 0)}
- Impressions: ${num(productPerf?.impressions || 0)}
- ACOS: ${pct(productPerf?.acos || 0)} ${(productPerf?.acos || 0) > 30 ? "(HIGH)" : "(Good)"}
- ROAS: ${(productPerf?.roas || 0).toFixed(2)}x

== INVENTORY ==
- Selling Price: ${cur(price, account?.currency)}
- Total Stock: ${num(totalStock)} units (FBA: ${num(fbaQty)}, FBM: ${num(fbmQty)})
- Est. Days Left: ${daysOfStock ? daysOfStock + " days" : "unknown"}

== TOP CAMPAIGNS ==
${campaignLines}

Provide analysis in 4 clear sections using bullet points:
1. PERFORMANCE VERDICT
2. CAMPAIGN RECOMMENDATIONS
3. INVENTORY ALERT
4. TOP 3 ACTION ITEMS`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    try {
      const response = await fetch("/api/gemini-insights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      clearInterval(progressInterval);
      setLoadingProgress(100);

      const resText = await response.text();
      let data: any = {};
      try {
        data = JSON.parse(resText);
      } catch {
        data = { error: `Server error (${response.status})` };
      }

      if (!response.ok) {
        throw new Error(data.error || `API error ${response.status}`);
      }

      setGeminiInsights(data.text || generateInstantFallback());
    } catch (e: any) {
      clearTimeout(timeoutId);
      clearInterval(progressInterval);
      setLoadingProgress(100);
      console.warn("Gemini fetch timed out or failed, using instant telemetry insights:", e);
      setGeminiInsights(generateInstantFallback());
    } finally {
      setLoadingInsights(false);
    }
  };

  useEffect(() => {
    if (activeTab === "insights" && !geminiInsights && !loadingInsights) {
      generateInsights();
    }
  }, [activeTab]);

  if (!selectedAsin) return null;

  const currency = account?.currency;
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
  const fbaQty = stock.fba;
  const fbmQty = stock.fbm;
  const totalStock = fbaQty + fbmQty;
  const price = inventoryItem?.price || 0;
  const totalValue = totalStock * price;

  const tabs = [
    { id: "overview", label: "Overview", icon: TrendingUp },
    { id: "inventory", label: "Inventory", icon: Box },
    { id: "insights", label: "AI Insights", icon: Sparkles },
  ];

  const formatInsights = (text: string) => {
    const lines = text.split("\n");
    return lines.map((line, i) => {
      if (/^#{1,3}\s/.test(line) || /^[1-4]\.\s/.test(line) || /^[📊🎯📦⚡]/.test(line)) {
        return (
          <p key={i} className="font-extrabold text-foreground text-sm mt-4 mb-1.5 first:mt-0 flex items-center gap-1.5">
            {line.replace(/^#+\s/, "")}
          </p>
        );
      }
      if (line.startsWith("- ") || line.startsWith("• ") || line.startsWith("* ")) {
        return (
          <p key={i} className="text-xs text-foreground/90 pl-3 border-l-2 border-primary/40 py-1 my-1">
            {line.replace(/^[-•*]\s/, "")}
          </p>
        );
      }
      if (line.trim() === "") return <div key={i} className="h-1" />;
      return <p key={i} className="text-xs text-muted-foreground leading-relaxed">{line}</p>;
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-sm transition-opacity duration-300">
      <div className="absolute inset-0" onClick={() => setSelectedAsin(null)} />
      <div className="relative w-full max-w-3xl h-full bg-background border-l border-border shadow-2xl flex flex-col z-10 animate-in slide-in-from-right duration-300">
        {/* Header */}
        <div className="p-6 border-b border-border flex items-center justify-between bg-card/30">
          <div className="min-w-0 flex items-start gap-4">
            {inventoryItem?.mainImageUrl && (
              <img src={inventoryItem.mainImageUrl} alt="" className="w-12 h-12 rounded-lg object-cover border border-border flex-shrink-0 bg-white" />
            )}
            <div className="min-w-0">
              <span className="text-xs text-muted-foreground font-mono">ASIN: {selectedAsin}</span>
              <h2 className="text-base font-bold tracking-tight truncate text-foreground pr-4" title={displayName}>
                {displayName || "Advertised Product"}
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

        {/* Tabs */}
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
                  isActive ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {perfLoading || invLoading ? (
            <div className="flex h-[300px] items-center justify-center flex-col gap-4 text-muted-foreground">
              <Loader2 className="w-7 h-7 animate-spin text-primary" />
              <p className="font-semibold text-sm">Loading product details...</p>
            </div>
          ) : (
            <>
              {activeTab === "overview" && (
                <div className="space-y-6">
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                    {[
                      { label: "Spend", val: cur(spend, currency) },
                      { label: "Sales", val: cur(sales, currency), green: true },
                      { label: "Orders", val: num(orders) },
                      { label: "ACOS", val: pct(acos), red: acos > 30 },
                      { label: "ROAS", val: roas ? roas.toFixed(2) + "x" : "—" },
                      { label: "CTR", val: pct(ctr) },
                      { label: "CPC", val: cur(cpc, currency) },
                      { label: "CVR", val: pct(cvr) },
                      { label: "Clicks", val: num(clicks) },
                      { label: "Impressions", val: num(impressions) },
                    ].map((s) => (
                      <div key={s.label} className="glass p-4 rounded-xl border border-border">
                        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{s.label}</p>
                        <p className={cn("text-lg font-black mt-1", s.green ? "text-green-600 dark:text-green-400" : s.red ? "text-red-500" : "text-foreground")}>{s.val}</p>
                      </div>
                    ))}
                  </div>
                  <div className="glass rounded-xl border border-border overflow-hidden">
                    <div className="p-4 border-b border-border bg-card/20">
                      <h3 className="font-bold text-sm">Product Catalog Details</h3>
                    </div>
                    <table className="w-full text-left text-xs divide-y divide-border">
                      <tbody className="divide-y divide-border bg-card/5">
                        {[
                          ["ASIN", selectedAsin],
                          ["Seller SKU", inventoryItem?.sku || "—"],
                          ["Selling Price", cur(price, currency)],
                          ["Inventory Status", totalStock > 20 ? "In Stock" : totalStock > 0 ? "Low Stock" : "Out of Stock"],
                          ["Total On-Hand Stock", num(totalStock) + " units"],
                        ].map(([k, v]) => (
                          <tr key={k} className="hover:bg-muted/10 transition-colors">
                            <td className="px-4 py-3 font-semibold text-muted-foreground w-1/3">{k}</td>
                            <td className="px-4 py-3 font-bold font-mono">{v}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {activeTab === "inventory" && (
                <div className="space-y-6">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="glass p-4 rounded-xl border border-border">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{stockResult?.fbaSource === "amazon_report" ? "FBA Available" : "FBA (ledger)"}</p>
                      <p className="text-lg font-black mt-1 text-foreground">{stock.fbaKnown ? `${num(fbaQty)} units` : "—"}</p>
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
                  {stockRow && (
                    <div className="glass rounded-xl border border-border overflow-hidden">
                      <div className="p-4 border-b border-border bg-card/20">
                        <h3 className="font-bold text-sm">FBA Detailed Stock</h3>
                      </div>
                      <table className="w-full text-left text-xs divide-y divide-border">
                        <tbody className="divide-y divide-border bg-card/5">
                          <tr className="hover:bg-muted/10 transition-colors">
                            <td className="px-4 py-3 font-semibold text-muted-foreground w-1/3">Available</td>
                            <td className="px-4 py-3 font-bold">{qty(stockRow.fbaAvailable)}</td>
                          </tr>
                          <tr className="hover:bg-muted/10 transition-colors">
                            <td className="px-4 py-3 font-semibold text-muted-foreground">Inbound (working + shipped + receiving)</td>
                            <td className="px-4 py-3 font-bold">{qty(stockRow.fbaInbound)}</td>
                          </tr>
                          <tr className="hover:bg-muted/10 transition-colors">
                            <td className="px-4 py-3 font-semibold text-muted-foreground">Reserved</td>
                            <td className="px-4 py-3 font-bold">{qty(stockRow.fbaReserved)}</td>
                          </tr>
                          <tr className="hover:bg-muted/10 transition-colors">
                            <td className="px-4 py-3 font-semibold text-muted-foreground">Unfulfillable</td>
                            <td className="px-4 py-3 font-bold">{qty(stockRow.fbaUnfulfillable)}</td>
                          </tr>
                          <tr className="hover:bg-muted/10 transition-colors">
                            <td className="px-4 py-3 font-semibold text-muted-foreground">Ledger balance (SellerMate, reference)</td>
                            <td className="px-4 py-3 text-muted-foreground">{qty(stockRow.ledgerBalance)}{stockResult?.ledgerAsOf ? ` · ${stockResult.ledgerAsOf}` : ""}</td>
                          </tr>
                          <tr className="hover:bg-muted/10 transition-colors">
                            <td className="px-4 py-3 font-semibold text-muted-foreground">Data as of</td>
                            <td className="px-4 py-3 text-muted-foreground">{stockResult?.fbaSource === "amazon_report" ? `${stockResult.reportAsOf ?? "unknown"} (Amazon FBA Inventory report, daily snapshot)` : "SellerMate ledger — Amazon report not on file for this account"}{stockRow.fbaNote ? ` · ${stockRow.fbaNote}` : ""}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {activeTab === "insights" && (
                <div className="space-y-4">
                  {/* Header */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-primary font-bold text-sm">
                      <Sparkles className="w-4 h-4" />
                      <span>Gemini AI Analysis</span>
                      <span className="text-[10px] text-muted-foreground font-normal bg-muted px-2 py-0.5 rounded-full">Real data</span>
                    </div>
                    {geminiInsights && !loadingInsights && (
                      <button
                        onClick={generateInsights}
                        className="flex items-center gap-1.5 text-[11px] font-bold text-muted-foreground hover:text-primary transition-colors"
                      >
                        <RefreshCw className="w-3 h-3" /> Regenerate
                      </button>
                    )}
                  </div>

                  {/* Percentage Progress Loading */}
                  {loadingInsights && (
                    <div className="glass rounded-xl border border-border py-12 px-6 text-center flex flex-col items-center justify-center gap-4 max-w-md mx-auto">
                      <div className="relative w-14 h-14 flex items-center justify-center">
                        <div className="absolute inset-0 rounded-full border-4 border-primary/20 animate-ping opacity-20" />
                        <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center border border-primary/30">
                          <Sparkles className="w-6 h-6 text-primary animate-pulse" />
                        </div>
                      </div>
                      <div className="space-y-2 w-full">
                        <div className="flex justify-between items-center text-xs font-bold px-1">
                          <span className="text-foreground">Gemini is analyzing product data...</span>
                          <span className="text-primary font-mono font-extrabold">{loadingProgress}%</span>
                        </div>
                        <div className="w-full bg-muted h-3 rounded-full overflow-hidden p-0.5 border border-border shadow-inner">
                          <div 
                            className="bg-gradient-to-r from-indigo-500 via-purple-500 to-cyan-400 h-full rounded-full transition-all duration-300 ease-out shadow-sm"
                            style={{ width: `${loadingProgress}%` }}
                          />
                        </div>
                      </div>
                      <p className="text-[11px] text-muted-foreground font-medium">
                        {loadingProgress < 35 ? "Gathering performance & stock telemetry..." : loadingProgress < 75 ? "Evaluating ACOS, ROAS & conversion efficiency..." : "Formulating optimization recommendations..."}
                      </p>
                    </div>
                  )}

                  {/* Error / Fallback */}
                  {insightError && !loadingInsights && (
                    <div className="glass rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50/50 dark:bg-amber-950/20 p-5 flex flex-col gap-3">
                      <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 font-bold text-sm">
                        <AlertTriangle className="w-4 h-4" />
                        Live API Timeout — Telemetry AI Analysis
                      </div>
                      <p className="text-xs text-muted-foreground">{insightError}</p>
                      <button
                        onClick={generateInsights}
                        className="self-start flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-lg text-xs font-bold hover:opacity-90 transition-opacity"
                      >
                        <RefreshCw className="w-3 h-3" /> Retry Gemini
                      </button>
                    </div>
                  )}

                  {/* Insights */}
                  {geminiInsights && !loadingInsights && (
                    <div className="glass rounded-xl border border-border p-5 space-y-1">
                      {formatInsights(geminiInsights)}
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
