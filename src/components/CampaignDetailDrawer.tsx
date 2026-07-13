"use client";

import { useQuery } from "@tanstack/react-query";
import { useDashboard } from "@/lib/DashboardContext";
import { mcp } from "@/lib/api";
import { X, Loader2, Target, KeyRound, Search, Package, TrendingUp, Sparkles, HelpCircle, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";

const cur = (val: number, currency?: string) => {
  const sym = currency === "INR" ? "₹" : "$";
  if (!val) return `${sym}0`;
  return sym + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val));
};
const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));
const pct = (val: number) => `${(val || 0).toFixed(2)}%`;

export function CampaignDetailDrawer() {
  const { selectedCampaignName, setSelectedCampaignName, keySlot, account, startDate, endDate } = useDashboard();
  const [activeTab, setActiveTab] = useState<string>("overview");
  const [geminiInsights, setGeminiInsights] = useState<string>("");
  const [loadingInsights, setLoadingInsights] = useState<boolean>(false);

  // Sorting state
  const [sortField, setSortField] = useState<string>("spend");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

  // Close on Escape key press
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedCampaignName(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setSelectedCampaignName]);

  // Reset tab and sorting when campaign changes
  useEffect(() => {
    setActiveTab("overview");
    setGeminiInsights("");
    setSortField("spend");
    setSortOrder("desc");
  }, [selectedCampaignName]);

  // Reset sorting when active tab changes
  useEffect(() => {
    setSortField("spend");
    setSortOrder("desc");
  }, [activeTab]);

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortOrder("desc");
    }
  };

  const getSortedData = (data: any[]) => {
    return [...data].sort((a, b) => {
      let valA = a[sortField];
      let valB = b[sortField];

      // Custom selector for fields that might map differently
      if (sortField === "placementClassification") {
        valA = a.placementClassification || a.placement || "";
        valB = b.placementClassification || b.placement || "";
      } else if (sortField === "adAsin") {
        valA = a.adAsin || a.asin || "";
        valB = b.adAsin || b.asin || "";
      }

      if (valA === undefined || valA === null) return sortOrder === "desc" ? 1 : -1;
      if (valB === undefined || valB === null) return sortOrder === "desc" ? -1 : 1;

      if (typeof valA === "string") {
        return sortOrder === "asc"
          ? valA.localeCompare(valB)
          : valB.localeCompare(valA);
      } else {
        return sortOrder === "asc" ? valA - valB : valB - valA;
      }
    });
  };

  const baseArgs = {
    amazon_account_id: account?.id,
    workspace_id: account?.workspace_id,
    start_date: startDate,
    end_date: endDate,
  };

  // 1. Fetch campaigns to find settings and performance
  const { data: campaignPerfData, isLoading: cpLoading } = useQuery({
    queryKey: ["campaign_detail_perf", keySlot, account?.id, selectedCampaignName, startDate, endDate],
    queryFn: () => mcp("get_campaign_performance", { ...baseArgs, page_size: 500 }, keySlot),
    enabled: !!account && !!selectedCampaignName,
  });

  const { data: campaignListData } = useQuery({
    queryKey: ["campaign_detail_list", keySlot, account?.id, selectedCampaignName],
    queryFn: () => mcp("list_campaigns", { amazon_account_id: account?.id, workspace_id: account?.workspace_id, page_size: 500 }, keySlot),
    enabled: !!account && !!selectedCampaignName,
  });

  // Find target campaign
  const campaignPerf = (campaignPerfData?.data || []).find((c: any) => c.campaignName === selectedCampaignName);
  const campaignMeta = (campaignListData?.campaigns || []).find((c: any) => c.name === selectedCampaignName);

  // 2. Fetch Placement data
  const { data: placementsData, isLoading: placementsLoading } = useQuery({
    queryKey: ["campaign_detail_placements", keySlot, account?.id, campaignMeta?.campaignId, startDate, endDate],
    queryFn: () => mcp("get_placement_performance", {
      ...baseArgs,
      campaign_ids: campaignMeta?.campaignId ? [campaignMeta.campaignId] : undefined,
      page_size: 500
    }, keySlot),
    enabled: !!account && !!selectedCampaignName && !!campaignMeta?.campaignId && activeTab === "placements",
  });
  const filteredPlacements = placementsData?.placements || placementsData?.data || [];

  // 3. Fetch Product data
  const { data: productsData, isLoading: productsLoading } = useQuery({
    queryKey: ["campaign_detail_products", keySlot, account?.id, campaignMeta?.campaignId, startDate, endDate],
    queryFn: () => mcp("get_advertised_product_performance", {
      ...baseArgs,
      campaign_ids: campaignMeta?.campaignId ? [campaignMeta.campaignId] : undefined,
      page_size: 500
    }, keySlot),
    enabled: !!account && !!selectedCampaignName && !!campaignMeta?.campaignId && activeTab === "products",
  });
  const filteredProducts = productsData?.data || [];

  // 4. Fetch Keywords data
  const { data: keywordsData, isLoading: keywordsLoading } = useQuery({
    queryKey: ["campaign_detail_keywords", keySlot, account?.id, campaignMeta?.campaignId, startDate, endDate],
    queryFn: () => mcp("get_targeting_performance", {
      ...baseArgs,
      campaign_ids: campaignMeta?.campaignId ? [campaignMeta.campaignId] : undefined,
      page_size: 500
    }, keySlot),
    enabled: !!account && !!selectedCampaignName && !!campaignMeta?.campaignId && activeTab === "keywords",
  });
  const filteredKeywords = keywordsData?.data || [];

  // 5. Fetch Search Terms data
  const { data: searchTermsData, isLoading: searchTermsLoading } = useQuery({
    queryKey: ["campaign_detail_searchterms", keySlot, account?.id, campaignMeta?.campaignId, startDate, endDate],
    queryFn: () => mcp("get_search_term_performance", {
      ...baseArgs,
      campaign_ids: campaignMeta?.campaignId ? [campaignMeta.campaignId] : undefined,
      group_by: ["searchTerm", "campaignName"],
      page_size: 500
    }, keySlot),
    enabled: !!account && !!selectedCampaignName && !!campaignMeta?.campaignId && activeTab === "searchterms",
  });
  const filteredSearchTerms = searchTermsData?.data || [];

  // 6. Generate Gemini Insights on demand
  const generateInsights = async () => {
    if (!campaignPerf) return;
    setLoadingInsights(true);
    setGeminiInsights("");
    try {
      const prompt = `Analyze this Amazon PPC campaign performance and provide deep insights:
- Campaign Name: ${selectedCampaignName}
- Spend: ${cur(campaignPerf.spend, account?.currency)}
- Sales: ${cur(campaignPerf.sales, account?.currency)}
- Orders: ${num(campaignPerf.orders)}
- Clicks: ${num(campaignPerf.clicks)}
- Impressions: ${num(campaignPerf.impressions)}
- ACOS: ${pct(campaignPerf.acos)}
- ROAS: ${campaignPerf.roas?.toFixed(2)}x

Provide:
1. Executive performance summary (Is this campaign performing well?).
2. Keyword Match / Bid adjustment advice.
3. Actionable next steps (Scale budget, lower bids, search for negatives).
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
    if (activeTab === "insights" && !geminiInsights && campaignPerf) {
      generateInsights();
    }
  }, [activeTab, campaignPerf]);

  if (!selectedCampaignName) return null;

  const currency = account?.currency;

  // Overview Stats
  const spend = campaignPerf?.spend || 0;
  const sales = campaignPerf?.sales || 0;
  const orders = campaignPerf?.orders || 0;
  const clicks = campaignPerf?.clicks || 0;
  const impressions = campaignPerf?.impressions || 0;
  const acos = campaignPerf?.acos || 0;
  const roas = campaignPerf?.roas || 0;
  const ctr = impressions ? (clicks / impressions) * 100 : 0;
  const cpc = clicks ? spend / clicks : 0;
  const cvr = clicks ? (orders / clicks) * 100 : 0;

  const tabs = [
    { id: "overview", label: "Overview", icon: TrendingUp },
    { id: "placements", label: "Placements", icon: Target },
    { id: "products", label: "Products", icon: Package },
    { id: "keywords", label: "Keywords", icon: KeyRound },
    { id: "searchterms", label: "Search Terms", icon: Search },
    { id: "insights", label: "AI Insights", icon: Sparkles },
  ];

  // Reusable Sortable Column Header Component
  const SortableHeader = ({ field, label }: { field: string; label: string }) => {
    const isSorted = sortField === field;
    return (
      <th
        onClick={() => handleSort(field)}
        className="px-4 py-2 cursor-pointer hover:bg-muted/50 transition-colors select-none text-[10px] font-bold uppercase tracking-wider text-muted-foreground"
      >
        <div className="flex items-center gap-1">
          <span>{label}</span>
          {isSorted ? (
            sortOrder === "asc" ? <ArrowUp className="w-3 h-3 text-primary flex-shrink-0" /> : <ArrowDown className="w-3 h-3 text-primary flex-shrink-0" />
          ) : (
            <ArrowUpDown className="w-3 h-3 text-muted-foreground/30 hover:text-muted-foreground flex-shrink-0" />
          )}
        </div>
      </th>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-sm transition-opacity duration-300">
      {/* Click Outside to Close */}
      <div className="absolute inset-0" onClick={() => setSelectedCampaignName(null)} />

      {/* Drawer Panel */}
      <div className="relative w-full max-w-4xl h-full bg-background border-l border-border shadow-2xl flex flex-col z-10 animate-in slide-in-from-right duration-300">
        {/* Header */}
        <div className="p-6 border-b border-border flex items-center justify-between bg-card/30">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className={cn("px-2 py-0.5 rounded-full text-[10px] font-bold uppercase", campaignMeta?.state === "ENABLED" ? "bg-green-500/10 text-green-600" : "bg-yellow-500/10 text-yellow-600")}>
                {campaignMeta?.state || "ENABLED"}
              </span>
              <span className="text-xs text-muted-foreground font-mono">
                ID: {campaignMeta?.campaignId || "—"}
              </span>
            </div>
            <h2 className="text-xl font-bold tracking-tight truncate text-foreground pr-4" title={selectedCampaignName}>
              {selectedCampaignName}
            </h2>
          </div>
          <button
            onClick={() => setSelectedCampaignName(null)}
            className="w-8 h-8 rounded-full border border-border flex items-center justify-center hover:bg-muted text-muted-foreground transition-colors"
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
          {cpLoading || !campaignMeta?.campaignId ? (
            <div className="flex h-[300px] items-center justify-center flex-col gap-4 text-muted-foreground">
              <Loader2 className="w-7 h-7 animate-spin text-primary" />
              <p className="font-semibold text-sm">Loading campaign details...</p>
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
                      <h3 className="font-bold text-sm">Campaign Settings</h3>
                    </div>
                    <table className="w-full text-left text-xs divide-y divide-border">
                      <tbody className="divide-y divide-border bg-card/5">
                        <tr className="hover:bg-muted/10 transition-colors">
                          <td className="px-4 py-3 font-semibold text-muted-foreground w-1/3">Campaign ID</td>
                          <td className="px-4 py-3 font-mono font-bold">{campaignMeta?.campaignId || "—"}</td>
                        </tr>
                        <tr className="hover:bg-muted/10 transition-colors">
                          <td className="px-4 py-3 font-semibold text-muted-foreground">Type</td>
                          <td className="px-4 py-3 font-bold capitalize">{campaignMeta?.sponsoredType || "Sponsored Products"}</td>
                        </tr>
                        <tr className="hover:bg-muted/10 transition-colors">
                          <td className="px-4 py-3 font-semibold text-muted-foreground">Targeting</td>
                          <td className="px-4 py-3 font-bold capitalize">{campaignMeta?.targetingType || "Manual"}</td>
                        </tr>
                        <tr className="hover:bg-muted/10 transition-colors">
                          <td className="px-4 py-3 font-semibold text-muted-foreground">State</td>
                          <td className="px-4 py-3 font-bold">
                            <span className={cn("px-2 py-0.5 rounded-full text-[10px] font-bold uppercase", campaignMeta?.state === "ENABLED" ? "bg-green-500/10 text-green-600" : "bg-yellow-500/10 text-yellow-600")}>
                              {campaignMeta?.state || "—"}
                            </span>
                          </td>
                        </tr>
                        <tr className="hover:bg-muted/10 transition-colors">
                          <td className="px-4 py-3 font-semibold text-muted-foreground">Daily Budget</td>
                          <td className="px-4 py-3 font-bold">{campaignMeta?.dailyBudget ? cur(campaignMeta.dailyBudget, currency) : "—"}</td>
                        </tr>
                        <tr className="hover:bg-muted/10 transition-colors">
                          <td className="px-4 py-3 font-semibold text-muted-foreground">Created Date</td>
                          <td className="px-4 py-3 font-bold">{campaignMeta?.createdAt ? new Date(campaignMeta.createdAt).toLocaleDateString("en-IN") : "—"}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {activeTab === "placements" && (
                <div className="glass rounded-xl border border-border overflow-hidden">
                  <div className="p-4 border-b border-border bg-card/20 flex items-center justify-between">
                    <h3 className="font-bold text-sm">Placement Performance</h3>
                    <span className="text-xs text-muted-foreground">{filteredPlacements.length} placements</span>
                  </div>
                  {placementsLoading ? (
                    <div className="p-12 text-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin mx-auto text-primary mb-2" /> Loading...</div>
                  ) : filteredPlacements.length === 0 ? (
                    <div className="p-12 text-center text-muted-foreground">No placement data found.</div>
                  ) : (
                    <table className="w-full text-left text-xs divide-y divide-border">
                      <thead className="bg-muted/50 text-[10px] uppercase font-bold text-muted-foreground">
                        <tr>
                          <SortableHeader field="placementClassification" label="Placement" />
                          <SortableHeader field="spend" label="Spend" />
                          <SortableHeader field="sales" label="Sales" />
                          <SortableHeader field="acos" label="ACOS" />
                          <SortableHeader field="impressions" label="Impressions" />
                          <SortableHeader field="clicks" label="Clicks" />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {getSortedData(filteredPlacements).map((p: any, i: number) => (
                          <tr key={i} className="hover:bg-muted/10 transition-colors">
                            <td className="px-4 py-3 font-bold">{p.placementClassification || p.placement || "—"}</td>
                            <td className="px-4 py-3">{cur(p.spend, currency)}</td>
                            <td className="px-4 py-3 text-green-600 dark:text-green-400 font-bold">{cur(p.sales, currency)}</td>
                            <td className="px-4 py-3 font-bold">{p.acos ? pct(p.acos) : "—"}</td>
                            <td className="px-4 py-3">{num(p.impressions)}</td>
                            <td className="px-4 py-3">{num(p.clicks)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {activeTab === "products" && (
                <div className="glass rounded-xl border border-border overflow-hidden">
                  <div className="p-4 border-b border-border bg-card/20 flex items-center justify-between">
                    <h3 className="font-bold text-sm">Advertised Products</h3>
                    <span className="text-xs text-muted-foreground">{filteredProducts.length} products</span>
                  </div>
                  {productsLoading ? (
                    <div className="p-12 text-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin mx-auto text-primary mb-2" /> Loading...</div>
                  ) : filteredProducts.length === 0 ? (
                    <div className="p-12 text-center text-muted-foreground">No product data found in this campaign.</div>
                  ) : (
                    <table className="w-full text-left text-xs divide-y divide-border">
                      <thead className="bg-muted/50 text-[10px] uppercase font-bold text-muted-foreground">
                        <tr>
                          <SortableHeader field="adAsin" label="ASIN" />
                          <SortableHeader field="adProductName" label="Product Name" />
                          <SortableHeader field="spend" label="Spend" />
                          <SortableHeader field="sales" label="Sales" />
                          <SortableHeader field="orders" label="Orders" />
                          <SortableHeader field="clicks" label="Clicks" />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {getSortedData(filteredProducts).map((p: any, i: number) => (
                          <tr key={i} className="hover:bg-muted/10 transition-colors">
                            <td className="px-4 py-3 font-mono font-bold">{p.adAsin || p.asin || "—"}</td>
                            <td className="px-4 py-3 max-w-[200px] truncate" title={p.adProductName}>{p.adProductName || "—"}</td>
                            <td className="px-4 py-3">{cur(p.spend, currency)}</td>
                            <td className="px-4 py-3 text-green-600 dark:text-green-400 font-bold">{cur(p.sales, currency)}</td>
                            <td className="px-4 py-3">{num(p.orders)}</td>
                            <td className="px-4 py-3">{num(p.clicks)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {activeTab === "keywords" && (
                <div className="glass rounded-xl border border-border overflow-hidden">
                  <div className="p-4 border-b border-border bg-card/20 flex items-center justify-between">
                    <h3 className="font-bold text-sm">Keywords & Targets</h3>
                    <span className="text-xs text-muted-foreground">{filteredKeywords.length} keywords</span>
                  </div>
                  {keywordsLoading ? (
                    <div className="p-12 text-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin mx-auto text-primary mb-2" /> Loading...</div>
                  ) : filteredKeywords.length === 0 ? (
                    <div className="p-12 text-center text-muted-foreground">No keyword data found in this campaign.</div>
                  ) : (
                    <table className="w-full text-left text-xs divide-y divide-border">
                      <thead className="bg-muted/50 text-[10px] uppercase font-bold text-muted-foreground">
                        <tr>
                          <SortableHeader field="targetingValue" label="Keyword" />
                          <SortableHeader field="targetingType" label="Type" />
                          <SortableHeader field="spend" label="Spend" />
                          <SortableHeader field="sales" label="Sales" />
                          <SortableHeader field="acos" label="ACOS" />
                          <SortableHeader field="orders" label="Orders" />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {getSortedData(filteredKeywords).map((k: any, i: number) => (
                          <tr key={i} className="hover:bg-muted/10 transition-colors">
                            <td className="px-4 py-3 font-bold">{k.targetingValue || "—"}</td>
                            <td className="px-4 py-3 font-mono text-[10px]">{k.targetingType || "TARGET"}</td>
                            <td className="px-4 py-3">{cur(k.spend, currency)}</td>
                            <td className="px-4 py-3 text-green-600 dark:text-green-400 font-bold">{cur(k.sales, currency)}</td>
                            <td className="px-4 py-3 font-bold">{k.acos ? pct(k.acos) : "—"}</td>
                            <td className="px-4 py-3">{num(k.orders)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {activeTab === "searchterms" && (
                <div className="glass rounded-xl border border-border overflow-hidden">
                  <div className="p-4 border-b border-border bg-card/20 flex items-center justify-between">
                    <h3 className="font-bold text-sm">Search Terms</h3>
                    <span className="text-xs text-muted-foreground">{filteredSearchTerms.length} search terms</span>
                  </div>
                  {searchTermsLoading ? (
                    <div className="p-12 text-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin mx-auto text-primary mb-2" /> Loading...</div>
                  ) : filteredSearchTerms.length === 0 ? (
                    <div className="p-12 text-center text-muted-foreground">No search term data found.</div>
                  ) : (
                    <table className="w-full text-left text-xs divide-y divide-border">
                      <thead className="bg-muted/50 text-[10px] uppercase font-bold text-muted-foreground">
                        <tr>
                          <SortableHeader field="searchTerm" label="Search Term" />
                          <SortableHeader field="spend" label="Spend" />
                          <SortableHeader field="sales" label="Sales" />
                          <SortableHeader field="acos" label="ACOS" />
                          <SortableHeader field="clicks" label="Clicks" />
                          <SortableHeader field="orders" label="Orders" />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {getSortedData(filteredSearchTerms).map((s: any, i: number) => (
                          <tr key={i} className="hover:bg-muted/10 transition-colors">
                            <td className="px-4 py-3 font-bold">{s.searchTerm || "—"}</td>
                            <td className="px-4 py-3">{cur(s.spend, currency)}</td>
                            <td className="px-4 py-3 text-green-600 dark:text-green-400 font-bold">{cur(s.sales, currency)}</td>
                            <td className="px-4 py-3 font-bold">{s.acos ? pct(s.acos) : "—"}</td>
                            <td className="px-4 py-3">{num(s.clicks)}</td>
                            <td className="px-4 py-3">{num(s.orders)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
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
                      <p className="text-xs font-semibold">Gemini is analyzing your campaign performance...</p>
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
