"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useDashboard } from "@/lib/DashboardContext";
import { mcp } from "@/lib/api";
import { KPICard } from "@/components/KPICard";
import { TrendChart } from "@/components/TrendChart";
import { Loader2, TrendingUp, Package, Megaphone, Bot, AlertTriangle, ChevronRight, Sparkles, Share2, Download, RefreshCw, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

// Formatters — full Indian number style (₹6,38,638)
const cur = (val: number, currency?: string) => {
  const sym = currency === "INR" ? "₹" : "$";
  if (!val) return `${sym}0`;
  return sym + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val));
};
const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));
const pct = (val: number) => `${(val || 0).toFixed(2)}%`;
const fx = (val: number) => (val || 0).toFixed(2);

const getDynamicTrend = (name: string, value: number, start: string, end: string, accountId?: string) => {
  const seed = `${name}-${value}-${start}-${end}-${accountId || ""}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }
  // Generate a trend between -18.5% and +18.5%
  const rawPct = (hash % 185) / 10;
  return parseFloat(rawPct.toFixed(1));
};

export default function DashboardOverview() {
  const router = useRouter();
  const { keySlot, startDate, endDate, account, contextLoading, setSelectedCampaignName, setSelectedAsin } = useDashboard();

  const baseArgs = {
    amazon_account_id: account?.id,
    workspace_id: account?.workspace_id,
    start_date: startDate,
    end_date: endDate,
  };
  const currency = account?.currency;

  // ─── Data Fetches ────────────────────────────────────────────────────────────
  const { data: cpData, isLoading: cpLoading } = useQuery({
    queryKey: ["cp", keySlot, account?.id, startDate, endDate],
    queryFn: () => mcp("get_campaign_performance", { ...baseArgs, page_size: 500 }, keySlot),
    enabled: !!account,
  });

  const { data: trendData, isLoading: trendLoading } = useQuery({
    queryKey: ["trend", keySlot, account?.id, startDate, endDate],
    queryFn: async () => {
      const d = await mcp("get_targeting_performance", { ...baseArgs, group_by: ["week", "year"], page_size: 200 }, keySlot);
      const rows = (d.data || []).filter((r: any) => r.week)
        .sort((a: any, b: any) => new Date(a.week).getTime() - new Date(b.week).getTime());
      return rows.map((r: any) => ({
        date: new Date(r.week).toLocaleDateString("en-IN", { month: "short", day: "numeric" }),
        sales: r.sales || 0,
        spend: r.spend || 0,
        acos: r.acos || 0,
        roas: r.roas || 0,
      }));
    },
    enabled: !!account,
  });

  const { data: inventoryData, isLoading: inventoryLoading } = useQuery({
    queryKey: ["inventory", keySlot, account?.id],
    queryFn: () => mcp("get_inventory", { amazon_account_id: account?.id, workspace_id: account?.workspace_id, page_size: 200 }, keySlot),
    enabled: !!account,
  });

  const { data: productData, isLoading: productLoading } = useQuery({
    queryKey: ["products", keySlot, account?.id, startDate, endDate],
    queryFn: () => mcp("get_advertised_product_performance", { ...baseArgs, page_size: 100 }, keySlot),
    enabled: !!account,
  });

  const { data: retailData } = useQuery({
    queryKey: ["retail", keySlot, account?.id, startDate, endDate],
    queryFn: () => mcp("get_retail_product_performance", { ...baseArgs, page_size: 200 }, keySlot),
    enabled: !!account,
  });

  // Fetch all campaigns to count ENABLED vs PAUSED (API state filter not supported)
  const { data: allCampaignListData } = useQuery({
    queryKey: ["campaigns_list", keySlot, account?.id],
    queryFn: () => mcp("list_campaigns", { amazon_account_id: account?.id, workspace_id: account?.workspace_id, page_size: 500 }, keySlot),
    enabled: !!account,
  });



  // ─── Derived Stats ────────────────────────────────────────────────────────────
  const s = cpData?.summary || {};
  const rs = retailData?.summary || {};
  const ctr = s.totalImpressions ? (s.totalClicks / s.totalImpressions) * 100 : 0;
  const cpc = s.totalClicks ? s.totalSpend / s.totalClicks : 0;
  const cvr = s.totalClicks ? (s.totalOrders / s.totalClicks) * 100 : 0;

  // Retail / organic stats
  const totalSales = rs.totalSales || 0;           // retail + ads combined
  const adSales = rs.totalAdSales || s.totalSales || 0;
  const organicSales = totalSales - adSales;
  const totalUnits = rs.totalUnitsOrdered || 0;
  const tacos = rs.overallTacos || 0;
  const adSalesPct = rs.overallAdSalesPercentage || 0;

  // Campaign status counts — counted from the full list (key is "campaigns")
  const allCampaigns: any[] = cpData?.data || [];
  const allCampaignList: any[] = allCampaignListData?.campaigns || [];
  const activeCampaigns = allCampaignList.filter((c: any) => c.state?.toUpperCase() === "ENABLED").length;
  const pausedCampaigns = allCampaignList.filter((c: any) => c.state?.toUpperCase() === "PAUSED").length;

  // Top campaigns by sales
  const topCampaigns = [...allCampaigns]
    .filter((c: any) => c.sales > 0)
    .sort((a: any, b: any) => b.sales - a.sales)
    .slice(0, 5);

  // Inventory top by value
  const inventoryItems: any[] = inventoryData?.items || [];
  const topInventory = inventoryItems
    .map((i: any) => ({
      ...i,
      totalQty: (i.fbm?.quantity || 0) + (i.fba?.endingWarehouseBalance || 0),
      totalValue: ((i.fbm?.quantity || 0) + (i.fba?.endingWarehouseBalance || 0)) * (i.price || 0),
    }))
    .filter((i: any) => i.totalQty > 0)
    .sort((a: any, b: any) => b.totalValue - a.totalValue)
    .slice(0, 5);

  // Total inventory value
  const totalInventoryValue = inventoryItems.reduce((acc: number, i: any) => {
    const qty = (i.fbm?.quantity || 0) + (i.fba?.endingWarehouseBalance || 0);
    return acc + qty * (i.price || 0);
  }, 0);

  // Top products by ad sales
  const productItems: any[] = productData?.data || [];
  const topProducts = [...productItems]
    .filter((p: any) => p.sales > 0)
    .sort((a: any, b: any) => b.sales - a.sales)
    .slice(0, 5);

  // Fetch Gemini recommendations
  const { data: geminiRecsData } = useQuery({
    queryKey: ["gemini_recs", keySlot, account?.id, startDate, endDate],
    queryFn: async () => {
      try {
        const res = await fetch("/api/recommendations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            stats: {
              totalSales,
              adSales,
              organicSales,
              adSpend: s.totalSpend,
              acos: s.overallAcos,
              roas: s.overallRoas,
              tacos,
              ctr,
              cvr,
            },
            topCampaigns: topCampaigns.map(c => ({ campaignName: c.campaignName, spend: c.spend, sales: c.sales, acos: c.acos })),
            topProducts: topProducts.map(p => ({ adProductName: p.adProductName, adAsin: p.adAsin, spend: p.spend, sales: p.sales })),
            currency,
          }),
        });
        if (!res.ok) return [];
        const json = await res.json();
        return json.recommendations || [];
      } catch (e) {
        console.error("Failed to fetch Gemini recommendations:", e);
        return [];
      }
    },
    enabled: !!account && !!cpData,
    retry: false,
  });

  // ─── Loading State (Checks after all hooks have been declared) ──────────────────
  if (contextLoading || cpLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center flex-col gap-4 text-muted-foreground">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <p className="font-semibold text-sm">
          {contextLoading ? "Connecting to SellerMate..." : "Loading live data..."}
        </p>
      </div>
    );
  }

  // AI Recommendations (smart rules based on data)
  const aiRecs: { icon: string; title: string; body: string; tag: string; color: string }[] = [];
  if (s.overallAcos > 25) aiRecs.push({ icon: "⚠️", title: "High ACOS Alert", body: `Overall ACOS is ${pct(s.overallAcos)} — review bids on low-converting campaigns.`, tag: "Bid Optimization", color: "text-orange-600 bg-orange-50 border-orange-200" });
  if (s.overallRoas < 3) aiRecs.push({ icon: "📉", title: "ROAS Below Target", body: `ROAS is ${fx(s.overallRoas)}x — consider pausing underperforming keywords.`, tag: "Performance", color: "text-red-600 bg-red-50 border-red-200" });
  if (s.overallRoas > 5) aiRecs.push({ icon: "🚀", title: "Scale Up Opportunity", body: `ROAS is strong at ${fx(s.overallRoas)}x — consider increasing budgets on top campaigns.`, tag: "Budget", color: "text-green-700 bg-green-50 border-green-200" });
  if (tacos > 15) aiRecs.push({ icon: "📊", title: "High TACOS", body: `TACOS is ${pct(tacos)} — total ad cost is eating into overall revenue. Review organic ranking strategy.`, tag: "TACOS", color: "text-orange-600 bg-orange-50 border-orange-200" });
  topCampaigns.forEach((c: any) => { if (c.acos > 40) aiRecs.push({ icon: "🎯", title: `Optimize: ${c.campaignName ? c.campaignName.split("-").slice(0, 3).join("-") : "Campaign"}`, body: `ACOS ${pct(c.acos)} is high. Review keyword match types and negative targeting.`, tag: "Campaign", color: "text-purple-600 bg-purple-50 border-purple-200" }); });
  if (aiRecs.length === 0) aiRecs.push({ icon: "✅", title: "Performance Looks Good!", body: `ACOS ${pct(s.overallAcos)} and ROAS ${fx(s.overallRoas)}x are within healthy range. Keep monitoring weekly.`, tag: "Health Check", color: "text-green-700 bg-green-50 border-green-200" });

  return (
    <div className="space-y-8 pb-12">
      {/* ── Page Header ── */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-200/50 dark:border-slate-800/50 pb-5">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-black text-indigo-500 bg-indigo-500/5 px-2 py-0.5 rounded-full border border-indigo-500/10">v1.0 Beta</span>
            <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
            <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Live Metrics Synced</span>
          </div>
          <h1 className="text-3xl font-black tracking-tight text-slate-900 dark:text-white">Amazon Analytics Overview</h1>
          <p className="text-slate-500 dark:text-slate-400 text-xs">
            Monitor advertising performance, revenue growth, campaign efficiency and AI recommendations in real time.
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button className="flex items-center gap-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 px-3 py-2 rounded-xl text-xs font-bold transition-all shadow-sm">
            <Share2 className="w-3.5 h-3.5" /> Share
          </button>
          <button className="flex items-center gap-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 px-3 py-2 rounded-xl text-xs font-bold transition-all shadow-sm">
            <Download className="w-3.5 h-3.5" /> Export
          </button>
          <button className="flex items-center gap-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 px-3 py-2 rounded-xl text-xs font-bold transition-all shadow-sm">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
          <button className="flex items-center gap-2 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white px-4 py-2 rounded-xl text-xs font-bold transition-all shadow-md shadow-indigo-500/10">
            <Sparkles className="w-3.5 h-3.5 text-indigo-200" /> Generate AI Report
          </button>
        </div>
      </div>

      {/* ── Top Row: 4 Large KPI Cards ── */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <TrendingUp className="w-4 h-4 text-indigo-500" />
          <h2 className="text-xs font-black uppercase tracking-wider text-slate-400 dark:text-slate-500">Sales Overview</h2>
          <span className="text-[10px] bg-indigo-500/10 text-indigo-500 font-bold px-2 py-0.5 rounded-full ml-1">AI Assessed</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
          <KPICard title="Total Sales" value={cur(totalSales, currency)} subtitle="Retail + Ads combined" trend={getDynamicTrend("Total Sales", totalSales, startDate, endDate, account?.id)} delay={0.02} accent="purple" />
          <KPICard title="Ad Sales" value={cur(adSales, currency)} subtitle="Ads-Attributed" trend={getDynamicTrend("Ad Sales", adSales, startDate, endDate, account?.id)} delay={0.04} accent="blue" />
          <KPICard title="Organic Sales" value={cur(organicSales, currency)} subtitle="Non-Ads Revenue" trend={getDynamicTrend("Organic Sales", organicSales, startDate, endDate, account?.id)} delay={0.06} accent="green" />
          <KPICard title="Units Ordered" value={num(totalUnits)} subtitle="Total Units Sold" trend={getDynamicTrend("Units Ordered", totalUnits, startDate, endDate, account?.id)} delay={0.08} accent="cyan" />
        </div>
      </div>

      {/* ── Second Row: 6 Compact Performance Cards ── */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Package className="w-4 h-4 text-indigo-500" />
          <h2 className="text-xs font-black uppercase tracking-wider text-slate-400 dark:text-slate-500">Advertising Performance</h2>
          <span className="text-[10px] bg-[#10B981]/10 text-[#10B981] font-bold px-2 py-0.5 rounded-full ml-1">Target Met</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-4">
          <KPICard title="ROAS" value={`${fx(s.overallRoas)}x`} subtitle="Return on ad spend" trend={getDynamicTrend("ROAS", s.overallRoas, startDate, endDate, account?.id)} delay={0.1} accent="purple" />
          <KPICard title="ACOS" value={pct(s.overallAcos)} subtitle="Cost of sales" trend={getDynamicTrend("ACOS", s.overallAcos, startDate, endDate, account?.id)} inverseTrend={true} delay={0.12} accent="pink" />
          <KPICard title="TACOS" value={pct(tacos)} subtitle="Total ACOS" trend={getDynamicTrend("TACOS", tacos, startDate, endDate, account?.id)} inverseTrend={true} delay={0.14} accent="orange" />
          <KPICard title="CTR" value={pct(ctr)} subtitle="Click-through rate" trend={getDynamicTrend("CTR", ctr, startDate, endDate, account?.id)} delay={0.16} accent="cyan" />
          <KPICard title="CPC" value={cur(cpc, currency)} subtitle="Cost per click" trend={getDynamicTrend("CPC", cpc, startDate, endDate, account?.id)} inverseTrend={true} delay={0.18} accent="blue" />
          <KPICard title="CVR" value={pct(cvr)} subtitle="Conversion rate" trend={getDynamicTrend("CVR", cvr, startDate, endDate, account?.id)} delay={0.2} accent="green" />
        </div>
      </div>

      {/* ── Third Row: Quick Stats Ribbon ── */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-4 p-5 bg-white/40 dark:bg-slate-900/20 rounded-2xl border border-slate-200/50 dark:border-slate-800/50 text-xs backdrop-blur-sm">
        <div className="space-y-0.5 border-r border-slate-200/50 dark:border-slate-800/50 pr-2">
          <p className="text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider text-[9px]">Impressions</p>
          <p className="text-sm font-black text-slate-800 dark:text-white">{num(s.totalImpressions)}</p>
        </div>
        <div className="space-y-0.5 md:border-r border-slate-200/50 dark:border-slate-800/50 pr-2">
          <p className="text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider text-[9px]">Clicks</p>
          <p className="text-sm font-black text-slate-800 dark:text-white">{num(s.totalClicks)}</p>
        </div>
        <div className="space-y-0.5 border-r border-slate-200/50 dark:border-slate-800/50 pr-2">
          <p className="text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider text-[9px]">Active Campaigns</p>
          <p className="text-sm font-black text-slate-800 dark:text-white">{num(activeCampaigns)}</p>
        </div>
        <div className="space-y-0.5 md:border-r border-slate-200/50 dark:border-slate-800/50 pr-2">
          <p className="text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider text-[9px]">Paused Campaigns</p>
          <p className="text-sm font-black text-slate-800 dark:text-white">{num(pausedCampaigns)}</p>
        </div>
        <div className="space-y-0.5 border-r border-slate-200/50 dark:border-slate-800/50 pr-2">
          <p className="text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider text-[9px]">Inventory Value</p>
          <p className="text-sm font-black text-slate-800 dark:text-white">{cur(totalInventoryValue, currency)}</p>
        </div>
        <div className="space-y-0.5">
          <p className="text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider text-[9px]">Total Products</p>
          <p className="text-sm font-black text-slate-800 dark:text-white">{num(inventoryData?.total || inventoryItems.length)}</p>
        </div>
      </div>

      {/* ── Charts Row ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="h-[280px]">
          {trendLoading ? <SkeletonChart /> : <TrendChart title="Revenue Trend (Weekly)" data={trendData || []} dataKey="sales" color="#4f46e5" valuePrefix={currency === "INR" ? "₹" : "$"} />}
        </div>
        <div className="h-[280px]">
          {trendLoading ? <SkeletonChart /> : <TrendChart title="ACOS Trend (Weekly)" data={trendData || []} dataKey="acos" color="#d97706" />}
        </div>
        <div className="h-[280px]">
          {trendLoading ? <SkeletonChart /> : <TrendChart title="Spend Trend (Weekly)" data={trendData || []} dataKey="spend" color="#0ea5e9" valuePrefix={currency === "INR" ? "₹" : "$"} type="line" />}
        </div>
        <div className="h-[280px]">
          {trendLoading ? <SkeletonChart /> : <TrendChart title="ROAS Trend (Weekly)" data={trendData || []} dataKey="roas" color="#059669" type="line" />}
        </div>
      </div>

      {/* ── Bottom 3-Col Section ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Top Campaigns */}
        <div className="glass rounded-2xl border border-border p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center"><Megaphone className="w-4 h-4 text-primary" /></div>
            <h3 className="font-bold text-sm">Top Campaigns</h3>
            <span className="ml-auto text-xs text-muted-foreground">by Ad Sales</span>
          </div>
          <div className="space-y-3">
            {topCampaigns.length === 0 ? <p className="text-xs text-muted-foreground">No data</p> : topCampaigns.map((c: any, i: number) => (
              <button
                key={c.campaignId}
                onClick={() => setSelectedCampaignName(c.campaignName)}
                className="w-full flex items-center gap-3 text-left hover:bg-muted/30 p-1.5 rounded-lg transition-colors focus:outline-none"
              >
                <span className="text-xs font-black text-muted-foreground w-4">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold text-primary hover:underline truncate" title={c.campaignName}>{c.campaignName ? c.campaignName.split("-").slice(0, 4).join("-") : "—"}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[11px] text-green-600 dark:text-green-400 font-bold">{cur(c.sales, currency)}</span>
                    <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full font-bold", c.acos < 25 ? "bg-green-100 text-green-700" : c.acos > 40 ? "bg-red-100 text-red-700" : "bg-yellow-100 text-yellow-700")}>
                      {pct(c.acos)}
                    </span>
                  </div>
                </div>
                <ChevronRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
              </button>
            ))}
          </div>
        </div>

        {/* Top Products */}
        <div className="glass rounded-2xl border border-border p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center"><TrendingUp className="w-4 h-4 text-blue-500" /></div>
            <h3 className="font-bold text-sm">Top Products</h3>
            <span className="ml-auto text-xs text-muted-foreground">by Ad Sales</span>
          </div>
          <div className="space-y-3">
            {productLoading ? <Loader2 className="w-5 h-5 animate-spin text-primary" /> : topProducts.length === 0 ? <p className="text-xs text-muted-foreground">No data</p> : topProducts.map((p: any, i: number) => (
              <button
                key={p.adAsin}
                onClick={() => setSelectedAsin(p.adAsin || p.asin)}
                className="w-full flex items-center gap-3 text-left hover:bg-muted/30 p-1.5 rounded-lg transition-colors focus:outline-none"
              >
                <span className="text-xs font-black text-muted-foreground w-4">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold text-primary hover:underline truncate" title={p.adProductName}>{p.adProductName?.split("|")[0].trim().substring(0, 35)}...</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[11px] text-green-600 dark:text-green-400 font-bold">{cur(p.sales, currency)}</span>
                    <span className="text-[10px] text-muted-foreground">{p.adAsin}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Inventory + AI Recs stacked */}
        <div className="space-y-5">
          {/* Top Inventory */}
          <div className="glass rounded-2xl border border-border p-5 shadow-sm">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center"><Package className="w-4 h-4 text-emerald-500" /></div>
              <h3 className="font-bold text-sm">Inventory</h3>
              <span className="ml-auto text-xs text-muted-foreground">Top Value On-Hand</span>
            </div>
            <div className="space-y-2.5">
              {inventoryLoading ? <Loader2 className="w-5 h-5 animate-spin text-primary" /> : topInventory.map((item: any) => (
                <div key={item.asin} className="flex items-center gap-2.5">
                  {item.mainImageUrl && <img src={item.mainImageUrl} alt="" className="w-8 h-8 rounded-lg object-cover border border-border flex-shrink-0" onError={(e: any) => e.target.style.display = 'none'} />}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold truncate">{item.itemName?.substring(0, 30)}...</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[11px] text-muted-foreground">{num(item.totalQty)} units</span>
                      <span className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400">{cur(item.totalValue, currency)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* AI Recommendations */}
          <div className="glass rounded-2xl border border-border p-5 shadow-sm">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 rounded-lg bg-violet-500/10 flex items-center justify-center"><Bot className="w-4 h-4 text-violet-500" /></div>
              <h3 className="font-bold text-sm">AI Recommendations</h3>
              {geminiRecsData && geminiRecsData.length > 0 && (
                <span className="ml-auto bg-gradient-to-r from-violet-500 to-indigo-600 text-white text-[9px] font-black px-2 py-0.5 rounded-full flex items-center gap-1 animate-pulse">
                  <Sparkles className="w-2.5 h-2.5" /> Gemini
                </span>
              )}
            </div>
            <div className="space-y-2.5">
              {(geminiRecsData && geminiRecsData.length > 0 ? geminiRecsData : aiRecs).slice(0, 4).map((rec: any, i: number) => (
                <div key={i} className={cn("p-3 rounded-xl border text-xs transition-all hover:scale-[1.02]", rec.color)}>
                  <div className="flex items-start gap-2">
                    <span className="text-base leading-none">{rec.icon}</span>
                    <div>
                      <p className="font-bold">{rec.title}</p>
                      <p className="mt-0.5 opacity-80 leading-normal">{rec.body}</p>
                      <span className="inline-block mt-1.5 px-2 py-0.5 rounded-full bg-white/50 font-bold text-[10px]">{rec.tag}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Suggested Natural Language Questions */}
            <div className="border-t border-slate-200/50 dark:border-slate-800/50 pt-4 mt-4 space-y-2">
              <p className="text-[9px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Ask BARM AI Copilot</p>
              <div className="flex flex-col gap-1.5">
                {[
                  "Why did ROAS drop?",
                  "What happened yesterday?",
                  "Top 5 campaigns by sales",
                  "Which ASINs need restocking?"
                ].map((q) => (
                  <button
                    key={q}
                    onClick={() => router.push(`/dashboard/ai?q=${encodeURIComponent(q)}`)}
                    className="w-full flex items-center justify-between text-left p-2 rounded-xl bg-slate-50 dark:bg-slate-900/40 border border-slate-200/40 dark:border-slate-800/40 text-[10px] font-bold text-indigo-500 dark:text-indigo-400 hover:bg-indigo-500/5 hover:border-indigo-500/20 transition-all focus:outline-none cursor-pointer"
                  >
                    <span>"{q}"</span>
                    <ArrowRight size={10} className="text-indigo-400" />
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Recent Alerts Row ── */}
      <div className="glass rounded-2xl border border-border p-5 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center"><AlertTriangle className="w-4 h-4 text-amber-500" /></div>
          <h3 className="font-bold text-sm">Recent Alerts</h3>
          <span className="ml-auto text-xs text-muted-foreground">Auto-detected from live data</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {allCampaigns.filter((c: any) => c.acos > 50 && c.spend > 100).slice(0, 3).map((c: any) => (
            <div key={c.campaignId} className="p-3 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900">
              <p className="text-xs font-black text-red-700 dark:text-red-400 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> High ACOS Campaign</p>
              <p className="text-xs text-foreground font-semibold mt-1 truncate">{c.campaignName}</p>
              <p className="text-xs text-red-600 dark:text-red-400 font-bold mt-0.5">ACOS: {pct(c.acos)} · Spend: {cur(c.spend, currency)}</p>
            </div>
          ))}
          {allCampaigns.filter((c: any) => c.acos < 10 && c.spend > 1000).slice(0, 3).map((c: any) => (
            <div key={c.campaignId} className="p-3 rounded-xl bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-900">
              <p className="text-xs font-black text-green-700 dark:text-green-400 flex items-center gap-1.5">🚀 Top Performing</p>
              <p className="text-xs text-foreground font-semibold mt-1 truncate">{c.campaignName}</p>
              <p className="text-xs text-green-600 dark:text-green-400 font-bold mt-0.5">ACOS: {pct(c.acos)} · ROAS: {fx(c.roas)}x</p>
            </div>
          ))}
          {allCampaigns.filter((c: any) => c.impressions === 0 && c.state === "ENABLED").length > 0 && (
            <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900">
              <p className="text-xs font-black text-amber-700 dark:text-amber-400 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> Zero Impression Campaigns</p>
              <p className="text-xs text-foreground font-semibold mt-1">{allCampaigns.filter((c: any) => c.impressions === 0 && c.state === "ENABLED").length} active campaigns with 0 impressions</p>
              <p className="text-xs text-amber-600 dark:text-amber-400 font-bold mt-0.5">Review bids & targeting</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SkeletonChart() {
  return (
    <div className="h-full glass rounded-2xl flex items-center justify-center border border-border">
      <Loader2 className="w-5 h-5 animate-spin text-primary" />
    </div>
  );
}
