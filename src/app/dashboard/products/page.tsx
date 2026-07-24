"use client";

import { useQuery } from "@tanstack/react-query";
import { useDashboard } from "@/lib/DashboardContext";
import { mcp, mcpAllInventory } from "@/lib/api";
import { KpiDrilldownModal } from "@/components/KpiDrilldownModal";
import { AiSuggestionModal } from "@/components/AiSuggestionModal";
import { DataTable } from "@/components/DataTable";
import { KPICard } from "@/components/KPICard";
import { PageHero } from "@/components/PageHero";
import { ScoreRing } from "@/components/ScoreRing";
import { Loader2, Package, Bot, Trophy, AlertTriangle, Boxes, Zap, MousePointerClick, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { categorizeTitle, resolveProductName, CATEGORY_COLORS } from "@/lib/categoryMap";
import { exportProductsWorkbook } from "@/lib/productsWorkbookExport";

const cur = (val: number, currency?: string) => {
  const sym = currency === "INR" ? "₹" : "$";
  if (!val) return `${sym}0`;
  return sym + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val));
};
const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));
const pct = (val: number) => `${(val || 0).toFixed(2)}%`;

// Deterministic per-ASIN AI score from live metrics
const productScore = (p: any) => {
  if (!p.spend && !p.totalSales) return 50;
  let score = 55 + Math.min(25, (p.roas || 0) * 4) - Math.min(30, Math.max(0, (p.acos || 0) - 20) * 0.7);
  if (p.organicSalesPercentage > 40) score += 8;
  if (p.returnRate > 10) score -= 10;
  if (p.adOrders === 0 && p.clicks > 15) score -= 15;
  return Math.max(5, Math.min(99, Math.round(score)));
};
const healthColor = (score: number) =>
  score >= 75 ? "bg-emerald-500" : score >= 55 ? "bg-blue-500" : score >= 35 ? "bg-amber-500" : "bg-red-500";

function ProductsContent() {
  const { keySlot, startDate, endDate, account, contextLoading, setSelectedAsin } = useDashboard();
  const searchParams = useSearchParams();
  const urlCategory = searchParams ? searchParams.get("category") : null;
  const [selectedCategory, setSelectedCategory] = useState<string>("All");
  const [kpiModal, setKpiModal] = useState<{ title: string; data: any[] } | null>(null);
  const [aiModal, setAiModal] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["products_tab", keySlot, account?.id, startDate, endDate],
    queryFn: async () => {
      const res = await mcp("get_advertised_product_performance", {
        amazon_account_id: account?.id,
        workspace_id: account?.workspace_id,
        start_date: startDate,
        end_date: endDate,
        page_size: 2000,
      }, keySlot);
      return res.data || res.products || [];
    },
    enabled: !!account,
  });

  // Previous equal-length period, immediately preceding the selected range — used only for the
  // Growth export sheet's period-over-period comparison. get_retail_product_performance rejects
  // start_date === end_date, so a single-day selection has no valid previous window; growthAvailable
  // below tells the export to show a "pick a wider range" note instead of a fake 100%/-100% growth.
  const hasDates = !!startDate && !!endDate;
  const rangeDaysForPrev = hasDates ? Math.max(1, Math.round((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86400000) + 1) : 1;
  const prevEndDate = (() => {
    if (!startDate) return "";
    const d = new Date(startDate + "T00:00:00Z");
    if (isNaN(d.getTime())) return "";
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  })();
  const prevStartDate = (() => {
    if (!prevEndDate) return "";
    const d = new Date(prevEndDate + "T00:00:00Z");
    if (isNaN(d.getTime())) return "";
    d.setUTCDate(d.getUTCDate() - (rangeDaysForPrev - 1));
    return d.toISOString().slice(0, 10);
  })();
  const growthAvailable = !!prevStartDate && !!prevEndDate && prevStartDate !== prevEndDate;

  const { data: prevRetailData } = useQuery({
    queryKey: ["products_tab_retail_prev", keySlot, account?.id, prevStartDate, prevEndDate],
    queryFn: async () => {
      if (!growthAvailable) return [];
      const res = await mcp("get_retail_product_performance", {
        amazon_account_id: account?.id,
        workspace_id: account?.workspace_id,
        start_date: prevStartDate,
        end_date: prevEndDate,
        page_size: 500,
      }, keySlot);
      return res.data || [];
    },
    enabled: !!account,
  });

  useEffect(() => {
    if (urlCategory) {
      setSelectedCategory(urlCategory);
    }
  }, [urlCategory]);
  // Retail data: total sales, organic sales, sessions, page views, buy box, etc. per ASIN
  const { data: retailData, isLoading: retailLoading } = useQuery({
    queryKey: ["products_tab_retail", keySlot, account?.id, startDate, endDate],
    queryFn: async () => {
      const res = await mcp("get_retail_product_performance", {
        amazon_account_id: account?.id,
        workspace_id: account?.workspace_id,
        start_date: startDate,
        end_date: endDate,
        page_size: 500,
      }, keySlot);
      return res;
    },
    enabled: !!account,
  });

  // Product catalog: gives SKU per ASIN (an ASIN can have multiple SKUs, e.g. FBA + FBM)
  const { data: catalogData } = useQuery({
    queryKey: ["products_tab_catalog", keySlot, account?.id],
    queryFn: async () => {
      // Paginate through the full catalog (200 per page) including suppressed
      // listings, so every advertised ASIN gets its SKU.
      const all: any[] = [];
      let offset = 0;
      for (let i = 0; i < 20; i++) {
        const res = await mcp("list_product_catalog", {
          amazon_account_id: account?.id,
          workspace_id: account?.workspace_id,
          limit: 200,
          offset,
          include_suppressed: true,
        }, keySlot);
        const page = res.products || [];
        all.push(...page);
        offset += page.length;
        if (page.length < 200 || offset >= (res.total || 0)) break;
      }
      return all;
    },
    enabled: !!account,
  });

  // FBA customer returns for the date range → count per ASIN
  const { data: returnsData } = useQuery({
    queryKey: ["products_tab_returns", keySlot, account?.id, startDate, endDate],
    queryFn: async () => {
      const all: any[] = [];
      for (let page = 0; page < 10; page++) {
        const res = await mcp("get_fba_customer_returns", {
          amazon_account_id: account?.id,
          workspace_id: account?.workspace_id,
          start_date: startDate,
          end_date: endDate,
          page,
          page_size: 500,
        }, keySlot);
        const rows = res.order_returns || [];
        all.push(...rows);
        if (!res.pagination?.hasMore || rows.length === 0) break;
      }
      return all;
    },
    enabled: !!account,
  });

  // Live inventory per ASIN → image, price, stock on hand (for stockout forecasting)
  const { data: inventoryData } = useQuery({
    queryKey: ["products_tab_inventory_all", keySlot, account?.id],
    queryFn: () => mcpAllInventory({
      amazon_account_id: account?.id,
      workspace_id: account?.workspace_id,
    }, keySlot),
    enabled: !!account,
  });

  const currency = account?.currency;

  // ASIN → returned units
  const returnsByAsin = new Map<string, number>();
  (returnsData || []).forEach((r: any) => {
    if (!r.asin) return;
    returnsByAsin.set(r.asin, (returnsByAsin.get(r.asin) || 0) + (r.quantity || 1));
  });

  // Genuine customer returns for the export sheet — excludes UNDELIVERABLE_* reasons, which are
  // courier RTO/refused-delivery shipments (the package was never actually received and returned
  // by a customer), not real product returns.
  const genuineReturns = (returnsData || []).filter(
    (r: any) => !String(r.reason || "").toUpperCase().startsWith("UNDELIVERABLE")
  );

  // ASIN → comma-joined unique SKUs
  const skusByAsin = new Map<string, string[]>();
  (catalogData || []).forEach((c: any) => {
    if (!c.asin || !c.sku) return;
    const list = skusByAsin.get(c.asin) || [];
    if (!list.includes(c.sku)) list.push(c.sku);
    skusByAsin.set(c.asin, list);
  });

  // ASIN → inventory record (image, price, stock)
  const inventoryByAsin = new Map<string, any>();
  const invArray = Array.isArray(inventoryData) ? inventoryData : ((inventoryData as any)?.items || []);
  invArray.forEach((i: any) => {
    if (i.asin) inventoryByAsin.set(i.asin, i);
  });

  const rangeDays = Math.max(1, Math.round((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86400000) + 1);

  // Merge advertised + retail metrics by ASIN
  const retailRows = retailData?.data || [];
  const retailByAsin = new Map<string, any>(retailRows.map((r: any) => [r.asin, r]));

  // ── Category Growth (for the export's Growth sheet) — every retail ASIN in the account (not
  // just advertised ones), grouped by department, ranked by Total Sales growth vs the prior
  // equal-length period. "Other"/"Discontinued" are excluded — only the 4 real departments. ──
  const catalogNameByAsin = new Map<string, string>();
  (catalogData || []).forEach((c: any) => {
    if (c.asin && c.itemName && !catalogNameByAsin.has(c.asin)) catalogNameByAsin.set(c.asin, c.itemName);
  });
  const prevSalesByAsin = new Map<string, number>((prevRetailData || []).map((r: any) => [r.asin, r.totalSales || 0]));
  const GROWTH_CATEGORIES = ["General", "Pulmonology", "Gynaecology", "Occupational Therapy"];
  const growthCandidates = retailRows
    .map((r: any) => {
      if (!r.asin) return null;
      const rawName = r.productName || catalogNameByAsin.get(r.asin) || r.asin;
      const sku = (skusByAsin.get(r.asin) || [])[0];
      const name = resolveProductName(rawName, sku) || rawName;
      const category = categorizeTitle(rawName, r.asin, sku);
      const curSales = r.totalSales || 0;
      const prevSales = prevSalesByAsin.get(r.asin) || 0;
      if (curSales === 0 && prevSales === 0) return null;
      const growthPct = prevSales > 0 ? (curSales - prevSales) / prevSales : curSales > 0 ? 1 : -1;
      return { asin: r.asin, name, sku: sku || "", category, curSales, prevSales, growthPct };
    })
    .filter((p: any): p is { asin: string; name: string; sku: string; category: string; curSales: number; prevSales: number; growthPct: number } =>
      p !== null && GROWTH_CATEGORIES.includes(p.category)
    );
  const growthByCategory = GROWTH_CATEGORIES.map((category) => {
    const inCat = growthCandidates.filter((p: any) => p.category === category);
    return {
      category,
      gainers: [...inCat].sort((a: any, b: any) => b.growthPct - a.growthPct).slice(0, 5),
      losers: [...inCat].sort((a: any, b: any) => a.growthPct - b.growthPct).slice(0, 5),
    };
  });
  const growthPeriodLabel = `${startDate} → ${endDate} vs ${prevStartDate} → ${prevEndDate}`;
  const allProducts = (data || []).map((p: any) => {
    const asin = p.adAsin || p.asin;
    const r = retailByAsin.get(asin) || {};
    const hasInv = inventoryByAsin.has(asin);
    const inv = inventoryByAsin.get(asin) || {};
    const sku = (skusByAsin.get(asin) || []).join(", ");
    const totalSales = r.totalSales || 0;
    const adSales = p.sales || r.adSales || 0;
    const totalOrders = r.totalOrderItems || 0;
    const adOrders = p.orders || r.adOrders || 0;
    const sessions = r.sessions || 0;
    const returns = returnsByAsin.get(asin) || 0;
    const unitsForRate = r.unitsOrdered || 0;
    // Only compute stock metrics when the ASIN actually appears in the
    // inventory report — a missing record means "unknown", not "0 units".
    const stock = hasInv ? (inv.fbm?.quantity || 0) + (inv.fba?.endingWarehouseBalance || 0) : null;
    const unitsPerDay = (r.unitsOrdered || 0) / rangeDays;
    const daysOfInventory = hasInv && stock != null && unitsPerDay > 0 ? stock / unitsPerDay : null;
    const rawName = p.adProductName || r.productName || inv.itemName;
    const category = categorizeTitle(rawName, asin, sku.split(", ")[0]);
    return {
      ...p,
      adProductName: resolveProductName(rawName, sku) || rawName,
      category,
      sku,
      image: inv.mainImageUrl || null,
      stock,
      daysOfInventory,
      inventoryValue: stock * (inv.price || 0),
      totalSales,
      adSales,
      organicSales: Math.max(0, totalSales - adSales),
      totalOrders,
      adOrders,
      organicOrders: Math.max(0, totalOrders - adOrders),
      organicSalesPercentage: totalSales ? Math.max(0, ((totalSales - adSales) / totalSales) * 100) : 0,
      returns,
      returnRate: unitsForRate ? (returns / unitsForRate) * 100 : 0,
      unitSessionPercentage: sessions ? ((r.unitsOrdered || 0) / sessions) * 100 : 0,
      adSpendPerUnit: r.adSpendPerUnit,
      unitsOrdered: r.unitsOrdered || 0,
      sessions: r.sessions || 0,
      pageViews: r.pageViews || 0,
      buyBoxPercentage: r.buyBoxPercentage,
      averageSellingPrice: r.averageSellingPrice,
      tacos: r.tacos,
      adSalesPercentage: r.adSalesPercentage,
      adCvr: r.adCvr,
    };
  });

  const products = allProducts.filter((p: any) => {
    if (p.category === "Discontinued") return false;
    if (selectedCategory === "All") return true;
    return p.category === selectedCategory;
  });

  // ── Executive KPIs ──
  const totalProducts = products.length;
  const sortedBySales = [...products].sort((a: any, b: any) => (b.sales || 0) - (a.sales || 0));
  const heroProduct = sortedBySales[0];
  const highAcosCount = products.filter((p: any) => p.acos > 50).length;
  const wastedClicksCount = products.reduce((acc: number, p: any) => p.orders === 0 ? acc + (p.clicks || 0) : acc, 0);
  const advertisedRevenue = products.reduce((a: number, p: any) => a + (p.totalSales || 0), 0);
  const totalAdSales = products.reduce((a: number, p: any) => a + (p.adSales || 0), 0);
  // Account-wide totals (every ASIN, not just the advertised ones above) so these
  // headline numbers agree with the Overview page for the same date range.
  const retailSummary = retailData?.summary || {};
  const totalRevenue = retailSummary.totalSales || advertisedRevenue;
  const totalOrganic = Math.max(0, totalRevenue - (retailSummary.totalAdSales || totalAdSales));
  const totalSpend = products.reduce((a: number, p: any) => a + (p.spend || 0), 0);
  const totalInvValue = products.reduce((a: number, p: any) => a + (p.inventoryValue || 0), 0);
  const stockoutRisk = products.filter((p: any) => p.daysOfInventory != null && p.daysOfInventory < 14 && p.unitsOrdered > 0);

  // ── AI Health scores ──
  const spenders = products.filter((p: any) => p.spend > 0);
  const advertisingHealth = spenders.length ? Math.round(spenders.reduce((a: number, p: any) => a + productScore(p), 0) / spenders.length) : 0;
  const inventoryHealth = products.length ? Math.max(5, Math.round(100 - (stockoutRisk.length / Math.max(1, products.filter((p: any) => p.stock > 0).length)) * 100)) : 0;
  const organicGrowth = totalRevenue ? Math.min(99, Math.round((totalOrganic / totalRevenue) * 100)) : 0;
  const conversionHealth = (() => {
    const withSessions = products.filter((p: any) => p.sessions > 0);
    if (!withSessions.length) return 0;
    const avgUsp = withSessions.reduce((a: number, p: any) => a + p.unitSessionPercentage, 0) / withSessions.length;
    return Math.min(99, Math.round(avgUsp * 4));
  })();

  // Insight lists
  const bleedingProducts = products.filter((p: any) => p.acos > 50 && p.spend > 100)
    .sort((a: any, b: any) => b.acos - a.acos);
  const clickNoOrderProducts = products.filter((p: any) => p.orders === 0 && p.clicks > 15)
    .sort((a: any, b: any) => b.clicks - a.clicks);
  const topROIProducts = products.filter((p: any) => p.roas > 4.5 && p.orders > 5)
    .sort((a: any, b: any) => b.sales - a.sales);
  const urgentRestock = [...stockoutRisk].sort((a: any, b: any) => (a.daysOfInventory ?? 999) - (b.daysOfInventory ?? 999));

  const columns = [
    {
      key: "adAsin",
      label: "Product",
      sortable: true,
      render: (val: string, row: any) => {
        const asin = val || row.asin;
        const score = productScore(row);
        return (
          <div className="flex items-center gap-3 min-w-[300px] max-w-[420px]">
            {row.image ? (
              <img src={row.image} alt="" className="w-10 h-10 rounded-xl object-cover border border-border flex-shrink-0" onError={(e: any) => e.target.style.display = "none"} />
            ) : (
              <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/15 flex items-center justify-center flex-shrink-0">
                <Package className="w-4 h-4 text-indigo-500" />
              </div>
            )}
            <div className="min-w-0">
              <button
                onClick={() => setSelectedAsin(asin)}
                className="font-bold text-foreground hover:text-primary text-left text-sm block max-w-[330px] truncate focus:outline-none"
                title={row.adProductName}
              >
                {row.adProductName?.split("|")[0].trim() || asin || "—"}
              </button>
              <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                <button onClick={() => setSelectedAsin(asin)} className="font-mono text-[10px] font-bold text-primary hover:underline focus:outline-none">{asin}</button>
                <span className={cn("text-[10px] font-extrabold px-1.5 py-px rounded-full text-white", healthColor(score))}>AI {score}</span>
                {row.daysOfInventory != null && row.daysOfInventory < 14 && (
                  <span className="text-[10px] font-extrabold px-1.5 py-px rounded-full bg-red-500/10 text-red-600 dark:text-red-400">
                    {Math.round(row.daysOfInventory)}d stock
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      },
    },
    {
      key: "sku",
      label: "SKU",
      sortable: true,
      render: (val: string) => (
        <span className="font-mono text-xs text-muted-foreground block min-w-[140px] max-w-[220px] whitespace-normal break-words leading-relaxed">
          {val || "—"}
        </span>
      ),
    },
    { key: "stock", label: "Stock", sortable: true, render: (val: number | null, row: any) => (
      <div>
        <span className={cn("font-bold", val === 0 ? "text-red-600 dark:text-red-400" : "text-foreground")}>{val == null ? "—" : num(val)}</span>
        {row.daysOfInventory != null && (
          <span className="text-[10px] text-muted-foreground font-bold block">{row.daysOfInventory > 90 ? "90+" : Math.round(row.daysOfInventory)} days</span>
        )}
      </div>
    ) },
    { key: "spend", label: "Spend", sortable: true, summable: true, render: (val: number) => <span className="font-bold text-foreground">{cur(val, currency)}</span> },
    { key: "adSales", label: "Ad Sales", sortable: true, summable: true, render: (val: number) => <span className="text-blue-600 dark:text-blue-400 font-extrabold">{cur(val, currency)}</span> },
    { key: "organicSales", label: "Organic Sales", sortable: true, summable: true, render: (val: number) => <span className="text-emerald-600 dark:text-emerald-400 font-extrabold">{cur(val, currency)}</span> },
    { key: "totalSales", label: "Total Sales", sortable: true, summable: true, render: (val: number) => <span className="text-violet-600 dark:text-violet-400 font-extrabold">{cur(val, currency)}</span> },
    { key: "tacos", label: "TACOS", sortable: true, render: (val: number) => val ? pct(val) : "—" },
    {
      key: "acos",
      label: "ACOS",
      sortable: true,
      render: (val: number) => (
        <span className={cn("px-2 py-0.5 rounded-full text-xs font-extrabold", val && val < 20 ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : val && val > 40 ? "bg-red-500/10 text-red-700 dark:text-red-400" : "bg-amber-500/10 text-amber-700 dark:text-amber-400")}>
          {val ? pct(val) : "—"}
        </span>
      ),
    },
    {
      key: "roas",
      label: "ROAS",
      sortable: true,
      render: (val: number) => (
        <span className={cn(
          "px-2 py-0.5 rounded-full text-xs font-extrabold",
          val > 5 ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : val > 3 ? "bg-blue-500/10 text-blue-600 dark:text-blue-400" : val > 0 ? "bg-amber-500/10 text-amber-600 dark:text-amber-400" : "text-muted-foreground"
        )}>
          {val ? `${val.toFixed(2)}x` : "—"}
        </span>
      ),
    },
    { key: "impressions", label: "Impressions", sortable: true, summable: true, render: (val: number) => num(val) },
    { key: "clicks", label: "Clicks", sortable: true, summable: true, render: (val: number) => num(val) },
    { key: "adOrders", label: "Ad Orders", sortable: true, summable: true, render: (val: number) => <span className="font-semibold text-blue-600 dark:text-blue-400">{num(val)}</span> },
    { key: "organicOrders", label: "Organic Orders", sortable: true, summable: true, render: (val: number) => <span className="font-semibold text-emerald-600 dark:text-emerald-400">{num(val)}</span> },
    { key: "totalOrders", label: "Total Orders", sortable: true, summable: true, render: (val: number) => <span className="font-bold text-violet-600 dark:text-violet-400">{num(val)}</span> },
    { key: "ctr", label: "CTR", sortable: true, render: (val: number) => val ? pct(val) : "—" },
    { key: "cpc", label: "CPC", sortable: true, render: (val: number) => cur(val, currency) },
    { key: "adCvr", label: "CVR", sortable: true, render: (val: number) => val ? pct(val) : "—" },
    { key: "unitsOrdered", label: "Units Ordered", sortable: true, summable: true, render: (val: number) => num(val) },
    { key: "sessions", label: "Sessions", sortable: true, summable: true, render: (val: number) => num(val) },
    { key: "pageViews", label: "Page Views", sortable: true, summable: true, render: (val: number) => num(val) },
    { key: "buyBoxPercentage", label: "Buy Box %", sortable: true, render: (val: number) => val ? pct(val) : "—" },
    { key: "averageSellingPrice", label: "Avg Price", sortable: true, render: (val: number) => val ? cur(val, currency) : "—" },
    { key: "adSalesPercentage", label: "Ad Sales %", sortable: true, render: (val: number) => val ? pct(val) : "—" },
    { key: "organicSalesPercentage", label: "Organic Sales %", sortable: true, render: (val: number) => val ? pct(val) : "—" },
    { key: "unitSessionPercentage", label: "Unit Session %", sortable: true, render: (val: number) => val ? pct(val) : "—" },
    { key: "adSpendPerUnit", label: "Ad Spend / Unit", sortable: true, render: (val: number) => val ? cur(val, currency) : "—" },
    { key: "returns", label: "Returns", sortable: true, summable: true, render: (val: number) => val ? <span className="font-semibold text-red-600 dark:text-red-400">{num(val)}</span> : "0" },
    {
      key: "returnRate",
      label: "Return Rate",
      sortable: true,
      render: (val: number) => (
        <span className={cn("px-2 py-0.5 rounded-full text-xs font-extrabold", !val ? "text-muted-foreground" : val > 10 ? "bg-red-500/10 text-red-700 dark:text-red-400" : val > 5 ? "bg-amber-500/10 text-amber-700 dark:text-amber-400" : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400")}>
          {val ? pct(val) : "—"}
        </span>
      ),
    },
  ];

  const handleExport = () => {
    exportProductsWorkbook({
      products,
      columns: columns as any,
      returns: genuineReturns,
      growthByCategory,
      growthAvailable,
      growthPeriodLabel,
      filename: `products-${startDate}-to-${endDate}`,
    });
  };

  return (
    <div className="space-y-8 pb-12">
      <PageHero
        title="AI Product Intelligence"
        subtitle="Monitor every advertised ASIN, analyze profitability, optimize advertising, inventory and organic growth using AI."
        workspace={account?.name?.split(" ").slice(0, 2).join(" ")}
        dateRange={`${startDate} → ${endDate}`}
        primaryAction="AI Product Report"
        onPrimaryAction={() => setAiModal(true)}
        onRefresh={() => refetch()}
        onExport={handleExport}
        chips={[
          { label: "Total Revenue", value: cur(totalRevenue, currency) },
          { label: "Ad vs Organic", value: `${cur(totalAdSales, currency)} / ${cur(totalOrganic, currency)}` },
          { label: "Inventory Value", value: cur(totalInvValue, currency) },
          { label: "Stockout Risk", value: `${stockoutRisk.length} ASINs` },
        ]}
      />

      {contextLoading || isLoading ? (
        <div className="flex h-[400px] items-center justify-center text-muted-foreground flex-col gap-4 glass rounded-[22px] border border-border">
          <Loader2 className="w-7 h-7 animate-spin text-primary" />
          <p className="font-semibold text-sm">{contextLoading ? "Connecting..." : "Loading Products..."}</p>
        </div>
      ) : (
        <>
          {/* ── Executive KPI Cards ── */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-6">
            <KPICard title="Advertised" value={num(totalProducts)} subtitle="Unique ASINs" accent="blue" delay={0.02} onClick={() => setKpiModal({ title: "Advertised Products", data: products })} />
            <KPICard title="Total Revenue" value={cur(totalRevenue, currency)} subtitle="Retail + Ads" accent="purple" delay={0.06} />
            <KPICard title="Ad Spend" value={cur(totalSpend, currency)} subtitle="This period" accent="cyan" delay={0.1} />
            <KPICard title="Organic Sales" value={cur(totalOrganic, currency)} subtitle={`${totalRevenue ? Math.round((totalOrganic / totalRevenue) * 100) : 0}% of revenue`} accent="green" delay={0.14} />
            <KPICard title="Bleeding ASINs" value={num(highAcosCount)} subtitle="ACOS > 50%" accent="pink" inverseTrend delay={0.18} onClick={() => setKpiModal({ title: "Bleeding ASINs", data: products.filter((p: any) => p.acos > 50) })} />
            <KPICard title="Stockout Risk" value={num(stockoutRisk.length)} subtitle="< 14 days inventory" accent="orange" inverseTrend delay={0.22} onClick={() => setKpiModal({ title: "Stockout Risk ASINs", data: stockoutRisk })} />
          </div>

          <KpiDrilldownModal 
            isOpen={!!kpiModal} 
            onClose={() => setKpiModal(null)} 
            title={kpiModal?.title || ""} 
            data={kpiModal?.data || []} 
            columns={columns} 
          />

          <AiSuggestionModal
            isOpen={aiModal}
            onClose={() => setAiModal(false)}
            title="AI Product Optimization Report"
            suggestions={[
              `You have ${highAcosCount} bleeding ASINs. Audit their attached campaigns immediately.`,
              `Warning: ${stockoutRisk.length} ASINs have high stockout risk (< 14 days of inventory). Lower bids to avoid running out.`,
              `Total organic sales is ${cur(totalOrganic, currency)}. Push top-converting products to boost organic ranking.`
            ]}
          />

          {/* ── AI Product Health ── */}
          <div className="glass gradient-border rounded-[22px] p-6">
            <div className="flex flex-col lg:flex-row lg:items-center gap-6 justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#6D5EF8] to-[#8B5CF6] flex items-center justify-center shadow-md shadow-indigo-500/20">
                  <Bot className="w-4.5 h-4.5 text-white" />
                </div>
                <div>
                  <h3 className="font-extrabold text-lg tracking-tight">AI Product Health</h3>
                  <p className="text-xs text-muted-foreground font-semibold max-w-xs">
                    {urgentRestock.length > 0
                      ? `${urgentRestock.length} products will stock out within 14 days at current velocity — restock now to protect ${cur(urgentRestock.reduce((a: number, p: any) => a + p.totalSales, 0), currency)} in monthly revenue.`
                      : "Inventory levels are safe. Focus on scaling hero products and trimming high-ACOS spend."}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-6 flex-wrap justify-center">
                <ScoreRing value={advertisingHealth} label="Advertising" color="#6C63FF" />
                <ScoreRing value={inventoryHealth} label="Inventory" color="#F59E0B" />
                <ScoreRing value={organicGrowth} label="Organic Share" color="#10B981" />
                <ScoreRing value={conversionHealth} label="Conversion" color="#3B82F6" />
              </div>
              <div className="text-center lg:text-right">
                <p className="text-[10px] font-extrabold uppercase tracking-widest text-muted-foreground">Hero Product Revenue</p>
                <p className="text-2xl font-extrabold text-violet-600 dark:text-violet-400">{heroProduct ? cur(heroProduct.totalSales || heroProduct.sales, currency) : "—"}</p>
                <p className="text-[11px] font-bold text-muted-foreground truncate max-w-[220px]" title={heroProduct?.adProductName}>{heroProduct?.adProductName?.split("|")[0].trim().slice(0, 34) || "No sales yet"}</p>
                <button className="mt-2.5 flex items-center gap-2 bg-gradient-to-r from-[#6D5EF8] to-[#8B5CF6] hover:opacity-90 text-white px-4 py-2 rounded-xl text-xs font-bold transition-all shadow-md shadow-indigo-500/20 mx-auto lg:ml-auto lg:mr-0">
                  <Zap className="w-3.5 h-3.5" /> Apply AI Optimizations
                </button>
              </div>
            </div>
          </div>

          {/* ── AI Opportunity Cards ── */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {topROIProducts.slice(0, 1).map((p: any) => (
              <div key={"hero" + (p.adAsin || p.asin)} className="p-4 rounded-2xl border border-emerald-200 dark:border-emerald-900 bg-gradient-to-br from-emerald-50/80 to-white dark:from-emerald-950/30 dark:to-transparent text-xs hover:-translate-y-0.5 transition-transform">
                <p className="font-extrabold text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5 text-sm"><Trophy className="w-4 h-4" /> Hero Product</p>
                <p className="font-bold mt-1.5 truncate text-[13px]" title={p.adProductName}>{p.adProductName?.split("|")[0].trim()}</p>
                <p className="text-muted-foreground mt-1 font-bold">ROAS {p.roas.toFixed(2)}x · Sales {cur(p.sales, currency)}</p>
                <div className="flex items-center justify-between mt-2.5">
                  <p className="font-extrabold text-emerald-700 dark:text-emerald-500">Increase budget +25%</p>
                  <span className="bg-emerald-500/10 text-emerald-600 font-extrabold px-2 py-0.5 rounded-full text-[10px]">+{cur(p.sales * 0.2, currency)} · 98%</span>
                </div>
              </div>
            ))}
            {bleedingProducts.slice(0, 1).map((p: any) => (
              <div key={"bleed" + (p.adAsin || p.asin)} className="p-4 rounded-2xl border border-red-200 dark:border-red-900 bg-gradient-to-br from-red-50/80 to-white dark:from-red-950/30 dark:to-transparent text-xs hover:-translate-y-0.5 transition-transform">
                <p className="font-extrabold text-red-700 dark:text-red-400 flex items-center gap-1.5 text-sm"><AlertTriangle className="w-4 h-4" /> High ACOS Product</p>
                <p className="font-bold mt-1.5 truncate text-[13px]" title={p.adProductName}>{p.adProductName?.split("|")[0].trim()}</p>
                <p className="text-muted-foreground mt-1 font-bold">ACOS {pct(p.acos)} · Spend {cur(p.spend, currency)}</p>
                <div className="flex items-center justify-between mt-2.5">
                  <p className="font-extrabold text-red-700 dark:text-red-500">Lower bids on this ASIN</p>
                  <span className="bg-red-500/10 text-red-600 font-extrabold px-2 py-0.5 rounded-full text-[10px]">Save {cur(p.spend * 0.3, currency)}</span>
                </div>
              </div>
            ))}
            {urgentRestock.slice(0, 1).map((p: any) => (
              <div key={"stock" + (p.adAsin || p.asin)} className="p-4 rounded-2xl border border-amber-200 dark:border-amber-900 bg-gradient-to-br from-amber-50/80 to-white dark:from-amber-950/30 dark:to-transparent text-xs hover:-translate-y-0.5 transition-transform">
                <p className="font-extrabold text-amber-700 dark:text-amber-400 flex items-center gap-1.5 text-sm"><Boxes className="w-4 h-4" /> Inventory Risk</p>
                <p className="font-bold mt-1.5 truncate text-[13px]" title={p.adProductName}>{p.adProductName?.split("|")[0].trim()}</p>
                <p className="text-muted-foreground mt-1 font-bold">{num(p.stock)} units left · ~{Math.round(p.daysOfInventory)} days</p>
                <div className="flex items-center justify-between mt-2.5">
                  <p className="font-extrabold text-amber-700 dark:text-amber-500">Restock ~{num(Math.ceil((p.unitsOrdered / rangeDays) * 45))} units</p>
                  <span className="bg-amber-500/10 text-amber-600 font-extrabold px-2 py-0.5 rounded-full text-[10px]">45-day cover</span>
                </div>
              </div>
            ))}
            {clickNoOrderProducts.slice(0, 1).map((p: any) => (
              <div key={"conv" + (p.adAsin || p.asin)} className="p-4 rounded-2xl border border-blue-200 dark:border-blue-900 bg-gradient-to-br from-blue-50/80 to-white dark:from-blue-950/30 dark:to-transparent text-xs hover:-translate-y-0.5 transition-transform">
                <p className="font-extrabold text-blue-700 dark:text-blue-400 flex items-center gap-1.5 text-sm"><MousePointerClick className="w-4 h-4" /> Traffic, No Conversion</p>
                <p className="font-bold mt-1.5 truncate text-[13px]" title={p.adProductName}>{p.adProductName?.split("|")[0].trim()}</p>
                <p className="text-muted-foreground mt-1 font-bold">{p.clicks} clicks · 0 orders · {cur(p.spend, currency)}</p>
                <div className="flex items-center justify-between mt-2.5">
                  <p className="font-extrabold text-blue-700 dark:text-blue-500">Improve listing / check price</p>
                  <span className="bg-blue-500/10 text-blue-600 font-extrabold px-2 py-0.5 rounded-full text-[10px]">+18% CVR est</span>
                </div>
              </div>
            ))}
          </div>

          {/* ── Inventory Intelligence strip ── */}
          {urgentRestock.length > 0 && (
            <div className="glass gradient-border rounded-[22px] p-6">
              <div className="flex items-center gap-2.5 mb-4">
                <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
                  <Boxes className="w-4 h-4 text-amber-500" />
                </div>
                <div>
                  <h3 className="font-extrabold text-lg tracking-tight">Inventory Intelligence</h3>
                  <p className="text-xs text-muted-foreground font-semibold">Stockout forecast from current sales velocity ({rangeDays}-day window)</p>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {urgentRestock.slice(0, 6).map((p: any) => (
                  <div key={p.adAsin || p.asin} className="flex items-center gap-3 p-3 rounded-2xl border border-border bg-card/60">
                    {p.image && <img src={p.image} alt="" className="w-10 h-10 rounded-xl object-cover border border-border flex-shrink-0" onError={(e: any) => e.target.style.display = "none"} />}
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-bold truncate" title={p.adProductName}>{p.adProductName?.split("|")[0].trim()}</p>
                      <div className="flex items-center justify-between mt-1">
                        <span className={cn("text-[10px] font-extrabold px-1.5 py-px rounded-full", p.daysOfInventory < 7 ? "bg-red-500/10 text-red-600" : "bg-amber-500/10 text-amber-600")}>
                          {Math.round(p.daysOfInventory)} days left
                        </span>
                        <span className="text-[10px] font-bold text-muted-foreground">{num(p.stock)} units</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-muted overflow-hidden mt-1.5">
                        <div
                          className={cn("h-full rounded-full", p.daysOfInventory < 7 ? "bg-red-500" : "bg-amber-500")}
                          style={{ width: `${Math.min(100, (p.daysOfInventory / 30) * 100)}%` }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Category Filtering Tabs */}
          <div className="flex items-center gap-2 overflow-x-auto pb-1.5 scrollbar-none">
            {["All", "General", "Pulmonology", "Gynaecology", "Occupational Therapy", "Other"].map((cat) => {
              const isActive = selectedCategory === cat;
              const color = CATEGORY_COLORS[cat] || "#6c63ff";
              return (
                <button
                  key={cat}
                  onClick={() => setSelectedCategory(cat)}
                  className={cn(
                    "px-4 py-2 rounded-xl text-xs font-black transition-all border whitespace-nowrap focus:outline-none cursor-pointer",
                    isActive
                      ? "bg-white dark:bg-slate-900 text-slate-800 dark:text-white shadow-sm"
                      : "bg-slate-100 dark:bg-slate-900/60 border-transparent text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-850"
                  )}
                  style={isActive ? { borderColor: color, color: color } : {}}
                >
                  {cat === "All" ? "All Categories" : cat}
                </button>
              );
            })}
          </div>

          <DataTable data={products} columns={columns} defaultSort="spend" exportName="products" />
        </>
      )}
    </div>
  );
}

export default function ProductsPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center min-h-[400px] w-full">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    }>
      <ProductsContent />
    </Suspense>
  );
}
