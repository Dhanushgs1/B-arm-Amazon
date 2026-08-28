"use client";

import { useQuery } from "@tanstack/react-query";
import { useDashboard } from "@/lib/DashboardContext";
import { mcp, fetchSkuMap } from "@/lib/api";
import { X, Loader2, Target, KeyRound, Search, Package, TrendingUp, Sparkles, HelpCircle, ArrowUpDown, ArrowUp, ArrowDown, RefreshCw, AlertTriangle, Download } from "lucide-react";
import { useState, useEffect, useMemo } from "react";
import { cn } from "@/lib/utils";
import { classifySearchTerm, buildProductIndex } from "@/lib/searchTermProductMatch";
import { exportToExcel } from "@/lib/excelExport";

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
  const [loadingProgress, setLoadingProgress] = useState<number>(0);
  const [insightError, setInsightError] = useState<string>("");
  // True when geminiInsights holds the local rule-based fallback (generateInstantCampaignFallback)
  // instead of a real Gemini response — drives the "Quick Summary" vs "Gemini AI" badge below so a
  // fallback is never silently presented as AI output.
  const [isFallbackInsight, setIsFallbackInsight] = useState<boolean>(false);

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
    setInsightError("");
    setIsFallbackInsight(false);
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

  // 1. Fetch campaign performance
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

  const campaignPerf = (campaignPerfData?.data || []).find((c: any) => c.campaignName === selectedCampaignName);
  const campaignMeta = (campaignListData?.campaigns || []).find((c: any) => c.name === selectedCampaignName);

  // 2. Placements
  const { data: placementsData, isLoading: placementsLoading } = useQuery({
    queryKey: ["campaign_detail_placements", keySlot, account?.id, campaignMeta?.campaignId, startDate, endDate],
    queryFn: () => mcp("get_placement_performance", {
      ...baseArgs,
      campaign_ids: campaignMeta?.campaignId ? [campaignMeta.campaignId] : undefined,
      page_size: 500
    }, keySlot),
    enabled: !!account && !!selectedCampaignName && !!campaignMeta?.campaignId && activeTab === "placements",
  });
  const filteredPlacements = placementsData?.placements || [];

  // 3. Products
  const { data: productsData, isLoading: productsLoading } = useQuery({
    queryKey: ["campaign_detail_products", keySlot, account?.id, campaignMeta?.campaignId, startDate, endDate],
    queryFn: () => mcp("get_advertised_product_performance", {
      ...baseArgs,
      campaign_ids: campaignMeta?.campaignId ? [campaignMeta.campaignId] : undefined,
      page_size: 500
    }, keySlot),
    // Also fetched for the Search Terms tab — its rows need the campaign's own advertised
    // product name(s) to tell a genuinely mismatched search term apart from a normal one.
    enabled: !!account && !!selectedCampaignName && !!campaignMeta?.campaignId && (activeTab === "products" || activeTab === "searchterms"),
  });
  const filteredProducts = productsData?.data || [];
  const campaignProductNames = Array.from(
    new Set(filteredProducts.map((p: any) => p.adProductName).filter(Boolean))
  ) as string[];
  const campaignAsins = Array.from(
    new Set(filteredProducts.map((p: any) => p.adAsin).filter(Boolean))
  ) as string[];

  // Account-wide advertised products (every campaign, not just this one) — lets the Search
  // Terms tab tell a search term apart as "belongs to campaign X" instead of a generic "looks
  // like some product", by checking every OTHER live campaign's own advertised product names.
  // Only fetched for the Search Terms tab, same lazy pattern as the rest of this drawer.
  //
  // Needs TWO calls, not one: SellerMate only returns the real listing title in adProductName
  // when adProductName ISN'T one of the group_by fields — ask it to group by adProductName
  // (needed to get one row per product) and adProductName silently becomes the raw ASIN
  // instead (confirmed by testing both shapes directly). So: one ungrouped call for
  // ASIN -> real title, one grouped-by-ASIN+campaign call for ASIN -> campaign, joined by ASIN.
  const { data: allProductNamesData } = useQuery({
    queryKey: ["all_product_names", keySlot, account?.id, startDate, endDate],
    queryFn: () => mcp("get_advertised_product_performance", { ...baseArgs, page_size: 2000 }, keySlot),
    enabled: !!account && activeTab === "searchterms",
    staleTime: 5 * 60 * 1000,
  });
  const { data: allProductCampaignsData } = useQuery({
    queryKey: ["all_product_campaigns", keySlot, account?.id, startDate, endDate],
    queryFn: () => mcp("get_advertised_product_performance", {
      ...baseArgs,
      group_by: ["adAsin", "campaignName"],
      page_size: 2000,
    }, keySlot),
    enabled: !!account && activeTab === "searchterms",
    staleTime: 5 * 60 * 1000,
  });
  const liveProductIndex = useMemo(() => {
    const nameRows: any[] = allProductNamesData?.data || [];
    const campaignRows: any[] = allProductCampaignsData?.data || [];
    if (!nameRows.length || !campaignRows.length) return null;
    const nameByAsin = new Map<string, string>();
    for (const r of nameRows) if (r.adAsin && r.adProductName) nameByAsin.set(r.adAsin, r.adProductName);
    return buildProductIndex(
      campaignRows
        .filter((r) => r.adAsin && r.campaignName && nameByAsin.has(r.adAsin))
        .map((r) => ({ name: nameByAsin.get(r.adAsin)!, campaignName: r.campaignName, asin: r.adAsin }))
    );
  }, [allProductNamesData, allProductCampaignsData]);

  // 4. Keywords
  const { data: keywordsData, isLoading: keywordsLoading } = useQuery({
    queryKey: ["campaign_detail_keywords", keySlot, account?.id, campaignMeta?.campaignId, startDate, endDate],
    queryFn: () => mcp("get_targeting_performance", {
      ...baseArgs,
      campaign_ids: campaignMeta?.campaignId ? [campaignMeta.campaignId] : undefined,
      group_by: ["targetingValue", "targetingType", "campaignName"],
      page_size: 500
    }, keySlot),
    enabled: !!account && !!selectedCampaignName && !!campaignMeta?.campaignId && activeTab === "keywords",
  });
  const filteredKeywords = keywordsData?.data || [];

  // 5. Search Terms
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

  // Instant fallback rule generator for campaign
  const generateInstantCampaignFallback = () => {
    const spendVal = campaignPerf?.spend || 0;
    const salesVal = campaignPerf?.sales || 0;
    const ordersVal = campaignPerf?.orders || 0;
    const acosVal = campaignPerf?.acos || 0;
    const roasVal = campaignPerf?.roas || 0;
    const clicksVal = campaignPerf?.clicks || 0;
    const impressionsVal = campaignPerf?.impressions || 0;
    const budgetVal = campaignMeta?.budget?.budget || 0;

    let verdict = `Campaign "${selectedCampaignName}" generated ${cur(salesVal, account?.currency)} in sales from ${cur(spendVal, account?.currency)} spend across ${num(ordersVal)} orders.`;
    if (acosVal > 35) {
      verdict += ` ACOS is currently high at ${pct(acosVal)} (target 30%). Ad cost is eating into profit margins.`;
    } else if (roasVal > 4) {
      verdict += ` Highly efficient campaign with a ROAS of ${roasVal.toFixed(2)}x and healthy ACOS of ${pct(acosVal)}.`;
    } else {
      verdict += ` Campaign efficiency is moderate with ACOS at ${pct(acosVal)} and ROAS at ${roasVal.toFixed(2)}x.`;
    }

    let kwAdvice = `Total clicks: ${num(clicksVal)} across ${num(impressionsVal)} impressions.`;
    if (acosVal > 35) {
      kwAdvice += ` Review keyword targeting — lower bids by 15-25% on search terms with ACOS > 40% and add non-converting search terms (>15 clicks, 0 orders) as Negative Exact.`;
    } else if (roasVal > 4) {
      kwAdvice += ` Scale exact match targets. Increase bids by 10-15% on high-converting keywords with ROAS > 5x.`;
    } else {
      kwAdvice += ` Optimize bids towards high-conversion search terms to improve overall campaign ROAS.`;
    }

    let budgetAdvice = `Daily budget is currently ${cur(budgetVal, account?.currency)}/day.`;
    if (roasVal > 4) {
      budgetAdvice += ` Campaign is operating near capacity with high ROAS — consider boosting daily budget by 20% to prevent missing out on high-intent evening traffic.`;
    } else if (acosVal > 45) {
      budgetAdvice += ` Reallocate budget to Top-of-Search placement only if Top-of-Search ACOS is significantly better than product pages.`;
    } else {
      budgetAdvice += ` Budget allocation is balanced for current volume.`;
    }

    let actions = `- Adjust keyword bids based on target ACOS threshold.\n- Add zero-order keywords (>15 clicks) as Negative Exact.\n- ${roasVal > 4 ? "Increase daily campaign budget to capture extra profitable demand." : "Optimize placement modifier bids (Top of Search vs Product Pages)."}`;

    return `1. PERFORMANCE VERDICT\n${verdict}\n\n2. KEYWORD & BID ADVICE\n${kwAdvice}\n\n3. PLACEMENT & BUDGET STRATEGY\n${budgetAdvice}\n\n4. TOP 3 ACTION ITEMS\n${actions}`;
  };

  // Generate Gemini Insights with smooth percentage progress bar
  const generateInsights = async () => {
    setLoadingInsights(true);
    setLoadingProgress(10);
    setGeminiInsights("");
    setInsightError("");
    setIsFallbackInsight(false);

    // Progress bar simulation interval
    const progressInterval = setInterval(() => {
      setLoadingProgress((prev) => {
        if (prev >= 92) return prev;
        if (prev < 40) return prev + 15;
        if (prev < 75) return prev + 10;
        return prev + 5;
      });
    }, 400);

    const spendVal = campaignPerf?.spend || 0;
    const salesVal = campaignPerf?.sales || 0;
    const ordersVal = campaignPerf?.orders || 0;
    const clicksVal = campaignPerf?.clicks || 0;
    const impressionsVal = campaignPerf?.impressions || 0;
    const acosVal = campaignPerf?.acos || 0;
    const roasVal = campaignPerf?.roas || 0;

    const prompt = `You are an Amazon PPC analyst. Analyze this REAL campaign performance and provide sharp, direct insights in English:

CAMPAIGN: ${selectedCampaignName}
Period: ${startDate} to ${endDate}
- Daily Budget: ${cur(campaignMeta?.budget?.budget || 0, account?.currency)}/day
- Ad Spend: ${cur(spendVal, account?.currency)}
- Ad Sales: ${cur(salesVal, account?.currency)}
- Orders: ${num(ordersVal)}
- Clicks: ${num(clicksVal)}
- Impressions: ${num(impressionsVal)}
- ACOS: ${pct(acosVal)} ${(acosVal > 30) ? "(HIGH)" : "(Healthy)"}
- ROAS: ${roasVal.toFixed(2)}x

Provide analysis in 4 clear sections using bullet points:
1. PERFORMANCE VERDICT
2. KEYWORD & BID ADVICE
3. PLACEMENT & BUDGET STRATEGY
4. TOP 3 ACTION ITEMS`;

    // Client timeout must exceed the server route's worst case (3 models x 8s each =
    // 24s, see src/app/api/gemini-insights/route.ts) or the fallback fires on every
    // request that needs more than one model attempt, not just genuine failures.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);

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
        data = { error: `Server response error (${response.status})` };
      }

      if (!response.ok) {
        throw new Error(data.error || `API error ${response.status}`);
      }

      if (data.text) {
        setGeminiInsights(data.text);
        setIsFallbackInsight(false);
      } else {
        setGeminiInsights(generateInstantCampaignFallback());
        setIsFallbackInsight(true);
      }
    } catch (e: any) {
      clearTimeout(timeoutId);
      clearInterval(progressInterval);
      setLoadingProgress(100);
      console.warn("Gemini fetch fallback triggered:", e);
      // Instant real telemetry fallback on delay or error
      setGeminiInsights(generateInstantCampaignFallback());
      setIsFallbackInsight(true);
    } finally {
      setLoadingInsights(false);
    }
  };

  useEffect(() => {
    if (activeTab === "insights" && !geminiInsights && !loadingInsights) {
      generateInsights();
    }
  }, [activeTab]);

  if (!selectedCampaignName) return null;

  const currency = account?.currency;
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
            sortOrder === "asc" ? <ArrowUp size={12} className="text-primary" /> : <ArrowDown size={12} className="text-primary" />
          ) : (
            <ArrowUpDown size={12} className="opacity-30" />
          )}
        </div>
      </th>
    );
  };

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
      <div className="absolute inset-0" onClick={() => setSelectedCampaignName(null)} />
      <div className="relative w-full max-w-3xl h-full bg-background border-l border-border shadow-2xl flex flex-col z-10 animate-in slide-in-from-right duration-300">
        {/* Header */}
        <div className="p-6 border-b border-border flex items-center justify-between bg-card/30">
          <div className="min-w-0">
            <span className="text-xs text-muted-foreground font-mono">
              Campaign: {selectedCampaignName}
            </span>
            <h2 className="text-base font-bold tracking-tight truncate text-foreground pr-4" title={selectedCampaignName}>
              {selectedCampaignName}
            </h2>
          </div>
          <button
            onClick={() => setSelectedCampaignName(null)}
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

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {cpLoading ? (
            <div className="flex h-[300px] items-center justify-center flex-col gap-4 text-muted-foreground">
              <Loader2 className="w-7 h-7 animate-spin text-primary" />
              <p className="font-semibold text-sm">Loading campaign details...</p>
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
                      <h3 className="font-bold text-sm">Campaign Settings & Metadata</h3>
                    </div>
                    <table className="w-full text-left text-xs divide-y divide-border">
                      <tbody className="divide-y divide-border bg-card/5">
                        <tr className="hover:bg-muted/10 transition-colors">
                          <td className="px-4 py-3 font-semibold text-muted-foreground w-1/3">Campaign ID</td>
                          <td className="px-4 py-3 font-mono font-bold">{campaignMeta?.campaignId || "—"}</td>
                        </tr>
                        <tr className="hover:bg-muted/10 transition-colors">
                          <td className="px-4 py-3 font-semibold text-muted-foreground">Status</td>
                          <td className="px-4 py-3 font-bold">
                            <span className={cn("px-2 py-0.5 rounded-full text-[10px] font-bold uppercase", (campaignMeta?.state || "").toUpperCase() === "ENABLED" ? "bg-green-500/10 text-green-600" : "bg-muted text-muted-foreground")}>
                              {campaignMeta?.state || "UNKNOWN"}
                            </span>
                          </td>
                        </tr>
                        <tr className="hover:bg-muted/10 transition-colors">
                          <td className="px-4 py-3 font-semibold text-muted-foreground">Targeting Type</td>
                          <td className="px-4 py-3 font-bold uppercase font-mono">{campaignMeta?.targetingType || "—"}</td>
                        </tr>
                        <tr className="hover:bg-muted/10 transition-colors">
                          <td className="px-4 py-3 font-semibold text-muted-foreground">Daily Budget</td>
                          <td className="px-4 py-3 font-bold">{campaignMeta?.budget?.budget ? cur(campaignMeta.budget.budget, currency) + "/day" : "—"}</td>
                        </tr>
                        <tr className="hover:bg-muted/10 transition-colors">
                          <td className="px-4 py-3 font-semibold text-muted-foreground">Bidding Strategy</td>
                          <td className="px-4 py-3 font-bold">{campaignMeta?.bidding?.strategy || "—"}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {activeTab === "placements" && (
                <div className="glass rounded-xl border border-border overflow-hidden">
                  <div className="p-4 border-b border-border bg-card/20 flex justify-between items-center">
                    <h3 className="font-bold text-sm">Placement Performance</h3>
                    <span className="text-xs text-muted-foreground font-bold">{filteredPlacements.length} placements</span>
                  </div>
                  {placementsLoading ? (
                    <div className="p-8 text-center text-muted-foreground flex items-center justify-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin text-primary" /> Loading placement data...
                    </div>
                  ) : filteredPlacements.length === 0 ? (
                    <div className="p-8 text-center text-muted-foreground text-xs font-semibold">No placement metrics recorded in date range.</div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs divide-y divide-border">
                        <thead className="bg-muted/50 text-[10px] uppercase font-bold text-muted-foreground">
                          <tr>
                            <SortableHeader field="placementClassification" label="Placement" />
                            <SortableHeader field="spend" label="Spend" />
                            <SortableHeader field="sales" label="Sales" />
                            <SortableHeader field="acos" label="ACOS" />
                            <SortableHeader field="clicks" label="Clicks" />
                            <SortableHeader field="orders" label="Orders" />
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {getSortedData(filteredPlacements).map((p: any, i: number) => (
                            <tr key={i} className="hover:bg-muted/10 transition-colors">
                              <td className="px-4 py-3 font-bold whitespace-nowrap">{p.placementClassification || p.placement || "—"}</td>
                              <td className="px-4 py-3 whitespace-nowrap">{cur(p.spend, currency)}</td>
                              <td className="px-4 py-3 text-green-600 dark:text-green-400 font-bold whitespace-nowrap">{cur(p.sales, currency)}</td>
                              <td className="px-4 py-3 font-bold whitespace-nowrap">{p.acos ? pct(p.acos) : "—"}</td>
                              <td className="px-4 py-3 whitespace-nowrap">{num(p.clicks)}</td>
                              <td className="px-4 py-3 whitespace-nowrap">{num(p.orders)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {activeTab === "products" && (
                <div className="glass rounded-xl border border-border overflow-hidden">
                  <div className="p-4 border-b border-border bg-card/20 flex justify-between items-center">
                    <h3 className="font-bold text-sm">Advertised Products in Campaign</h3>
                    <span className="text-xs text-muted-foreground font-bold">{filteredProducts.length} products</span>
                  </div>
                  {productsLoading ? (
                    <div className="p-8 text-center text-muted-foreground flex items-center justify-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin text-primary" /> Loading product metrics...
                    </div>
                  ) : filteredProducts.length === 0 ? (
                    <div className="p-8 text-center text-muted-foreground text-xs font-semibold">No product telemetry recorded in date range.</div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs divide-y divide-border">
                        <thead className="bg-muted/50 text-[10px] uppercase font-bold text-muted-foreground">
                          <tr>
                            <SortableHeader field="adAsin" label="Product / ASIN" />
                            <SortableHeader field="spend" label="Spend" />
                            <SortableHeader field="sales" label="Sales" />
                            <SortableHeader field="acos" label="ACOS" />
                            <SortableHeader field="clicks" label="Clicks" />
                            <SortableHeader field="orders" label="Orders" />
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {getSortedData(filteredProducts).map((prod: any, i: number) => (
                            <tr key={i} className="hover:bg-muted/10 transition-colors">
                              <td className="px-4 py-3 max-w-[240px]">
                                <p className="font-bold truncate" title={prod.adProductName}>{prod.adProductName || "—"}</p>
                                <span className="text-[10px] text-muted-foreground font-mono font-bold">ASIN: {prod.adAsin || prod.asin || "—"}</span>
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap">{cur(prod.spend, currency)}</td>
                              <td className="px-4 py-3 text-green-600 dark:text-green-400 font-bold whitespace-nowrap">{cur(prod.sales, currency)}</td>
                              <td className="px-4 py-3 font-bold whitespace-nowrap">{prod.acos ? pct(prod.acos) : "—"}</td>
                              <td className="px-4 py-3 whitespace-nowrap">{num(prod.clicks)}</td>
                              <td className="px-4 py-3 whitespace-nowrap">{num(prod.orders)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {activeTab === "keywords" && (
                <div className="glass rounded-xl border border-border overflow-hidden">
                  <div className="p-4 border-b border-border bg-card/20 flex justify-between items-center">
                    <h3 className="font-bold text-sm">Targeting & Keywords</h3>
                    <span className="text-xs text-muted-foreground font-bold">{filteredKeywords.length} targets</span>
                  </div>
                  {keywordsLoading ? (
                    <div className="p-8 text-center text-muted-foreground flex items-center justify-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin text-primary" /> Loading target data...
                    </div>
                  ) : filteredKeywords.length === 0 ? (
                    <div className="p-8 text-center text-muted-foreground text-xs font-semibold">No target telemetry in date range.</div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs divide-y divide-border">
                        <thead className="bg-muted/50 text-[10px] uppercase font-bold text-muted-foreground">
                          <tr>
                            <SortableHeader field="targetingValue" label="Keyword / Target" />
                            <SortableHeader field="spend" label="Spend" />
                            <SortableHeader field="sales" label="Sales" />
                            <SortableHeader field="acos" label="ACOS" />
                            <SortableHeader field="clicks" label="Clicks" />
                            <SortableHeader field="orders" label="Orders" />
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {getSortedData(filteredKeywords).map((k: any, i: number) => (
                            <tr key={i} className="hover:bg-muted/10 transition-colors">
                              <td className="px-4 py-3 whitespace-nowrap">
                                <p className="font-bold">{k.targetingValue || k.keywordText || "—"}</p>
                                <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-px rounded font-mono font-bold uppercase">{k.targetingType || "KEYWORD"}</span>
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap">{cur(k.spend, currency)}</td>
                              <td className="px-4 py-3 text-green-600 dark:text-green-400 font-bold whitespace-nowrap">{cur(k.sales, currency)}</td>
                              <td className="px-4 py-3 font-bold whitespace-nowrap">{k.acos ? pct(k.acos) : "—"}</td>
                              <td className="px-4 py-3 whitespace-nowrap">{num(k.clicks)}</td>
                              <td className="px-4 py-3 whitespace-nowrap">{num(k.orders)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {activeTab === "searchterms" && (() => {
                const classifiedTerms = getSortedData(filteredSearchTerms).map((s: any) => ({
                  ...s,
                  _classification: classifySearchTerm(s, campaignProductNames, liveProductIndex, selectedCampaignName || undefined, campaignAsins),
                }));
                const negativeCount = classifiedTerms.filter((s: any) => s._classification.negative).length;

                const handleExport = () => {
                  // Grouped, not interleaved — every Positive row first (in the on-screen sort
                  // order), then every Negative row after, so the two are visually separated in
                  // the sheet instead of scattered wherever spend/clicks happened to sort them.
                  const groupedForExport = [
                    ...classifiedTerms.filter((s: any) => !s._classification.negative),
                    ...classifiedTerms.filter((s: any) => s._classification.negative),
                  ];
                  exportToExcel(
                    groupedForExport,
                    [
                      { key: "searchTerm", label: "Search Term" },
                      { key: "spend", label: "Spend" },
                      { key: "sales", label: "Sales" },
                      { key: "acos", label: "ACOS" },
                      { key: "clicks", label: "Clicks" },
                      { key: "orders", label: "Orders" },
                      {
                        key: "_classification",
                        label: "Classification",
                        exportValue: (val: any) => (val.negative ? "Negative" : "Positive"),
                      },
                      {
                        key: "_classification",
                        label: "Reason",
                        exportValue: (val: any) => (val.reasons.length ? val.reasons.join("; ") : "—"),
                      },
                    ],
                    `${(selectedCampaignName || "campaign").replace(/[^a-z0-9]+/gi, "-")}-search-terms`
                  );
                };

                return (
                  <div className="glass rounded-xl border border-border overflow-hidden">
                    <div className="p-4 border-b border-border bg-card/20 flex justify-between items-center gap-3">
                      <h3 className="font-bold text-sm">Customer Search Terms</h3>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-muted-foreground font-bold">{filteredSearchTerms.length} terms</span>
                        {negativeCount > 0 && (
                          <span className="text-[10px] font-bold px-2 py-1 rounded-full bg-red-100 dark:bg-red-500/15 text-red-700 dark:text-red-400">
                            {negativeCount} negative
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={handleExport}
                          disabled={classifiedTerms.length === 0}
                          className="flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1.5 rounded-lg border border-border bg-card hover:bg-muted/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <Download className="w-3 h-3" /> Download
                        </button>
                      </div>
                    </div>
                    {searchTermsLoading ? (
                      <div className="p-8 text-center text-muted-foreground flex items-center justify-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin text-primary" /> Loading search term performance...
                      </div>
                    ) : filteredSearchTerms.length === 0 ? (
                      <div className="p-8 text-center text-muted-foreground text-xs font-semibold">No search term telemetry in date range.</div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs divide-y divide-border">
                          <thead className="bg-muted/50 text-[10px] uppercase font-bold text-muted-foreground">
                            <tr>
                              <SortableHeader field="searchTerm" label="Search Term" />
                              <SortableHeader field="spend" label="Spend" />
                              <SortableHeader field="sales" label="Sales" />
                              <SortableHeader field="acos" label="ACOS" />
                              <SortableHeader field="clicks" label="Clicks" />
                              <SortableHeader field="orders" label="Orders" />
                              <th className="px-4 py-2.5">Classification</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {classifiedTerms.map((s: any, i: number) => (
                              <tr key={i} className="hover:bg-muted/10 transition-colors">
                                <td className="px-4 py-3 font-bold whitespace-nowrap">{s.searchTerm || "—"}</td>
                                <td className="px-4 py-3 whitespace-nowrap">{cur(s.spend, currency)}</td>
                                <td className="px-4 py-3 text-green-600 dark:text-green-400 font-bold whitespace-nowrap">{cur(s.sales, currency)}</td>
                                <td className="px-4 py-3 font-bold whitespace-nowrap">{s.acos ? pct(s.acos) : "—"}</td>
                                <td className="px-4 py-3 whitespace-nowrap">{num(s.clicks)}</td>
                                <td className="px-4 py-3 whitespace-nowrap">{num(s.orders)}</td>
                                <td className="px-4 py-3 whitespace-nowrap" title={s._classification.reasons.join("; ")}>
                                  {s._classification.negative ? (
                                    <span className="text-[10px] font-bold px-2 py-1 rounded-full bg-red-100 dark:bg-red-500/15 text-red-700 dark:text-red-400">
                                      Negative
                                    </span>
                                  ) : (
                                    <span className="text-[10px] font-bold px-2 py-1 rounded-full bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
                                      Positive
                                    </span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })()}

              {activeTab === "insights" && (
                <div className="space-y-4">
                  {/* Header */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-primary font-bold text-sm">
                      <Sparkles className="w-4 h-4" />
                      <span>{isFallbackInsight ? "Quick Summary" : "Gemini AI Campaign Analysis"}</span>
                      {isFallbackInsight ? (
                        <span className="text-[10px] text-amber-600 dark:text-amber-400 font-normal bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-full" title="Gemini didn't respond in time — this is a rule-based summary from your real campaign numbers, not AI-generated text.">
                          Offline fallback · Real Telemetry
                        </span>
                      ) : (
                        <span className="text-[10px] text-muted-foreground font-normal bg-muted px-2 py-0.5 rounded-full">Real Telemetry</span>
                      )}
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
                          <span className="text-foreground">Gemini is analyzing campaign performance...</span>
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
                        {loadingProgress < 35 ? "Gathering campaign performance telemetry..." : loadingProgress < 75 ? "Evaluating ACOS, ROAS & placement efficiency..." : "Formulating campaign recommendations..."}
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

                  {/* Insights Content */}
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
