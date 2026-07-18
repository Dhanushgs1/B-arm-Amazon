"use client";

import { useDashboard } from "@/lib/DashboardContext";
import { BarChart3, FileSpreadsheet, Download, FileText, CheckCircle2, Loader2, RotateCcw } from "lucide-react";
import { useState } from "react";
import { mcp, mcpAllPages, mcpAllInventory } from "@/lib/api";
import { exportAmazonSalesReport, SalesReportGranularity } from "@/lib/amazonSalesExport";
import * as XLSX from "xlsx-js-style";

export default function ReportsPage() {
  const { account, startDate, endDate, keySlot } = useDashboard();
  const [generating, setGenerating] = useState<string | null>(null);
  const [history, setHistory] = useState<{ filename: string; timestamp: Date }[]>([]);

  const handleDownload = async (type: string) => {
    setGenerating(type);
    
    try {
      let content = "";
      let filename = "";
      const baseArgs = { 
        amazon_account_id: account?.id, 
        workspace_id: account?.workspace_id,
        start_date: startDate,
        end_date: endDate
      };
      
      const dateSuffix = `${startDate}_to_${endDate}`;

      if (type.includes("Amazon Daily") || type.includes("Amazon Weekly") || type.includes("Amazon Monthly")) {
        const granularity: SalesReportGranularity = type.includes("Daily") ? "daily" : type.includes("Weekly") ? "weekly" : "monthly";
        const gLabel = granularity === "daily" ? "Daily" : granularity === "weekly" ? "Weekly" : "Monthly";
        await exportAmazonSalesReport({ account, keySlot, startDate, endDate, granularity });
        setHistory(prev => [{ filename: `Amazon_${gLabel}_Sales_Report_${dateSuffix}.xlsx`, timestamp: new Date() }, ...prev]);
        setGenerating(null);
        return;

      } else if (type.includes("Campaign")) {
        const res = await mcp("get_campaign_performance", { ...baseArgs, page_size: 500 }, keySlot);
        const rows = res.data || res.rows || [];
        content = "Campaign,State,Spend,Sales,ACOS,ROAS,Impressions,Clicks,Orders\n";
        content += rows.map((r: any) => 
          `${r.campaignName || "Unknown"},${r.state || "UNKNOWN"},${r.spend || 0},${r.sales || 0},${r.acos || 0}%,${r.roas || 0}x,${r.impressions || 0},${r.clicks || 0},${r.orders || 0}`
        ).join("\n");
        filename = `Campaign_Performance_Summary_${dateSuffix}.csv`;
        
      } else if (type.includes("Product")) {
        const res = await mcp("get_advertised_product_performance", { ...baseArgs, page_size: 500 }, keySlot);
        const invData = await mcpAllInventory({ amazon_account_id: account?.id, workspace_id: account?.workspace_id }, keySlot).catch(() => []);
        const skuMap = new Map();
        invData.forEach((item: any) => {
          if (item.asin && item.sku) skuMap.set(item.asin, item.sku);
        });

        const rows = res.data || res.rows || [];
        content = "ASIN,SKU,Product_Name,Spend,Sales,Orders,Clicks,ACOS,ROAS\n";
        content += rows.map((r: any) => 
          `${r.adAsin || "Unknown"},${r.sku || skuMap.get(r.adAsin) || ""},"${(r.adProductName || "").replace(/"/g, '""')} ",${r.spend || 0},${r.sales || 0},${r.orders || 0},${r.clicks || 0},${r.acos || 0}%,${r.roas || 0}x`
        ).join("\n");
        filename = `Product_Advertising_Profitability_${dateSuffix}.csv`;
        
      } else if (type.includes("Search Term")) {
        const res = await mcp("get_search_term_performance", { ...baseArgs, page_size: 500 }, keySlot);
        const rows = res.data || res.rows || [];
        content = "Search_Term,Targeting,Campaign,Spend,Sales,Orders,Clicks,ACOS,ROAS\n";
        content += rows.map((r: any) => 
          `"${(r.searchTerm || "").replace(/"/g, '""')}","${(r.keywordText || "").replace(/"/g, '""')}","${(r.campaignName || "").replace(/"/g, '""')}",${r.spend || 0},${r.sales || 0},${r.orders || 0},${r.clicks || 0},${r.acos || 0}%,${r.roas || 0}x`
        ).join("\n");
        filename = `Targeting_Search_Term_Harvest_${dateSuffix}.csv`;
        
      } else if (type.includes("Inventory")) {
        const res = await mcp("get_inventory", { ...baseArgs, page_size: 500 }, keySlot);
        const rows = res.items || [];
        content = "ASIN,SKU,FBA_Quantity,FBM_Quantity,Price,Total_Value\n";
        content += rows.map((r: any) => {
          const fba = r.fba?.endingWarehouseBalance || 0;
          const fbm = r.fbm?.quantity || 0;
          return `${r.asin || "Unknown"},${r.sku || ""},${fba},${fbm},${r.price || 0},${(fba + fbm) * (r.price || 0)}`;
        }).join("\n");
        filename = `Inventory_Forecasting_Report_${dateSuffix}.csv`;
        
      } else if (type.includes("Automation")) {
        const res = await mcp("list_automations", { amazon_account_id: account?.id, workspace_id: account?.workspace_id, page_size: 500 }, keySlot).catch(() => ({ automations: [] }));
        const rows = res.automations || [];
        content = "Automation_Name,Status,Metric,Threshold,Action\n";
        if (rows.length === 0) {
          content += `"No active automations found for this account","-","-","-","-"\n`;
        } else {
          content += rows.map((r: any) => 
            `"${(r.name || "").replace(/"/g, '""')}","${r.status || ""}","${r.metric || ""}",${r.threshold || 0},"${r.action || ""}"`
          ).join("\n");
        }
        filename = `Advertising_Automations_${dateSuffix}.csv`;

      } else if (type.includes("Returns")) {
        const res = await mcp("get_fba_customer_returns", { ...baseArgs, page_size: 500 }, keySlot);
        const rows = res.order_returns || [];
        content = "Return_Date,ASIN,Product_Name,Reason,Status\n";
        content += rows.map((r: any) => 
          `${r.returnDate || ""},${r.asin || ""},"${(r.productName || "").replace(/"/g, '""')}","${(r.reason || "").replace(/"/g, '""')}","${(r.status || "").replace(/"/g, '""')}"`
        ).join("\n");
        filename = `Customer_Returns_Log_${dateSuffix}.csv`;
        
      } else if (type.includes("Full")) {
        // Calculate previous dates for comparison
        const sDate = new Date(startDate + "T00:00:00Z");
        const eDate = new Date(endDate + "T00:00:00Z");
        const diffDays = Math.ceil(Math.abs(eDate.getTime() - sDate.getTime()) / 86400000) + 1;
        const pEnd = new Date(sDate.getTime() - 86400000);
        const pStart = new Date(pEnd.getTime() - (diffDays - 1) * 86400000);
        const prevStartDate = pStart.toISOString().slice(0, 10);
        const prevEndDate = pEnd.toISOString().slice(0, 10);

        // Fetch all pages using the pagination helpers
        const cpData = await mcpAllPages("get_campaign_performance", baseArgs, keySlot).catch(() => []);
        const prodData = await mcpAllPages("get_advertised_product_performance", baseArgs, keySlot).catch(() => []);
        const stData = await mcpAllPages("get_search_term_performance", baseArgs, keySlot).catch(() => []);
        const returnsRes = await mcp("get_fba_customer_returns", { ...baseArgs, page_size: 500 }, keySlot).catch(() => ({ order_returns: [] }));
        
        // Fetch retail for overview summaries
        const retailRes = await mcp("get_retail_product_performance", { ...baseArgs, page_size: 500 }, keySlot).catch(() => ({ summary: {} }));
        const prevRetailRes = await mcp("get_retail_product_performance", { ...baseArgs, start_date: prevStartDate, end_date: prevEndDate, page_size: 500 }, keySlot).catch(() => ({ summary: {} }));
        
        const cpRes = await mcp("get_campaign_performance", { ...baseArgs, page_size: 500 }, keySlot).catch(() => ({ summary: {} }));
        const prevCpRes = await mcp("get_campaign_performance", { ...baseArgs, start_date: prevStartDate, end_date: prevEndDate, page_size: 500 }, keySlot).catch(() => ({ summary: {} }));

        const invArgs = { amazon_account_id: account?.id, workspace_id: account?.workspace_id };
        const invData = await mcpAllInventory(invArgs, keySlot).catch(() => []);

        // Create ASIN to SKU map since Advertising API often misses SKUs
        const skuMap = new Map();
        invData.forEach((item: any) => {
          if (item.asin && item.sku) skuMap.set(item.asin, item.sku);
        });

        const wb = XLSX.utils.book_new();

        // 1. Overview Sheet with Comparisons
        const overviewData = [
          { Metric: "Date Range", "Current Period": `${startDate} to ${endDate}`, "Previous Period": `${prevStartDate} to ${prevEndDate}` },
          { Metric: "Total Sales", "Current Period": retailRes.summary?.totalSales || 0, "Previous Period": prevRetailRes.summary?.totalSales || 0 },
          { Metric: "Total Units Ordered", "Current Period": retailRes.summary?.totalUnitsOrdered || 0, "Previous Period": prevRetailRes.summary?.totalUnitsOrdered || 0 },
          { Metric: "Total Ad Spend", "Current Period": cpRes.summary?.totalSpend || 0, "Previous Period": prevCpRes.summary?.totalSpend || 0 },
          { Metric: "Total Ad Sales", "Current Period": cpRes.summary?.totalSales || 0, "Previous Period": prevCpRes.summary?.totalSales || 0 },
          { Metric: "Overall ACOS", "Current Period": cpRes.summary?.totalSales > 0 ? ((cpRes.summary.totalSpend / cpRes.summary.totalSales) * 100).toFixed(2) + "%" : "0%", "Previous Period": prevCpRes.summary?.totalSales > 0 ? ((prevCpRes.summary.totalSpend / prevCpRes.summary.totalSales) * 100).toFixed(2) + "%" : "0%" },
        ];
        const wsOverview = XLSX.utils.json_to_sheet(overviewData);
        // Style Overview Header
        ['A1', 'B1', 'C1'].forEach(cell => {
          if (wsOverview[cell]) wsOverview[cell].s = { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "2F75B5" } } };
        });
        wsOverview['!cols'] = [{ wch: 25 }, { wch: 30 }, { wch: 30 }];
        XLSX.utils.book_append_sheet(wb, wsOverview, "Overview");

        // 2. Campaigns Sheet
        const wsCp = XLSX.utils.json_to_sheet(cpData);
        XLSX.utils.book_append_sheet(wb, wsCp, "Campaigns");

        // 3. Ad Products Sheet (Rich data + Colors)
        const prodRows = prodData.map((p: any) => ({
          ASIN: p.adAsin,
          SKU: p.sku || skuMap.get(p.adAsin) || "",
          Product_Name: p.adProductName || "",
          State: p.state || "",
          Spend: p.spend || 0,
          Sales: p.sales || 0,
          Orders: p.orders || 0,
          Clicks: p.clicks || 0,
          ACOS: p.acos || 0,
          ROAS: p.roas || 0
        }));
        const wsProd = XLSX.utils.json_to_sheet(prodRows);
        
        // Color code ACOS column (I column)
        const range = XLSX.utils.decode_range(wsProd['!ref'] || "A1");
        for (let R = 1; R <= range.e.r; ++R) {
          const acosCell = wsProd[XLSX.utils.encode_cell({ c: 8, r: R })]; // Col I (ACOS)
          if (acosCell && acosCell.v !== undefined) {
            const acos = parseFloat(acosCell.v as string);
            let color = "FFCC00"; // Orange
            if (acos < 25) color = "92D050"; // Green
            else if (acos > 40) color = "FF0000"; // Red
            
            acosCell.s = { fill: { fgColor: { rgb: color } }, font: { color: { rgb: acos > 40 ? "FFFFFF" : "000000" }, bold: true } };
          }
        }
        wsProd['!cols'] = [{ wch: 15 }, { wch: 15 }, { wch: 50 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }];
        XLSX.utils.book_append_sheet(wb, wsProd, "Ad Products");

        // 4. Search Terms Sheet
        const wsSt = XLSX.utils.json_to_sheet(stData);
        XLSX.utils.book_append_sheet(wb, wsSt, "Search Terms");
        
        // 5. Inventory Sheet
        const invFormatted = invData.map((r: any) => ({
          ASIN: r.asin, SKU: r.sku, Item_Name: r.itemName || "", Price: r.price, FBA_Qty: r.fba?.endingWarehouseBalance || 0, FBM_Qty: r.fbm?.quantity || 0,
          Total_Value: ((r.fba?.endingWarehouseBalance || 0) + (r.fbm?.quantity || 0)) * (r.price || 0)
        }));
        const wsInv = XLSX.utils.json_to_sheet(invFormatted);
        wsInv['!cols'] = [{ wch: 15 }, { wch: 15 }, { wch: 40 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 15 }];
        XLSX.utils.book_append_sheet(wb, wsInv, "Inventory");

        // 6. Returns Sheet
        const wsReturns = XLSX.utils.json_to_sheet(returnsRes.order_returns || []);
        XLSX.utils.book_append_sheet(wb, wsReturns, "Returns");

        XLSX.writeFile(wb, `BARM_Full_Executive_Report_${dateSuffix}.xlsx`);
        setHistory(prev => [{ filename: `BARM_Full_Executive_Report_${dateSuffix}.xlsx`, timestamp: new Date() }, ...prev]);
        setGenerating(null);
        return;
      }

      if (content) {
        const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", filename);
        link.style.visibility = "hidden";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setHistory(prev => [{ filename, timestamp: new Date() }, ...prev]);
      }
    } catch (err) {
      console.error("Failed to generate report", err);
      alert("Failed to generate report. Check console.");
    } finally {
      setGenerating(null);
    }
  };

  const reports = [
    { id: "amazon-daily", title: "Amazon Daily Sales Report", desc: "Day-by-day Orders, Returns, Price, Total Sales, and Growth % per product, plus a Top Losers/Gainers summary — Amazon only, no Flipkart. The most recent 1-2 days may show provisional figures (Amazon's own reporting sync lag).", format: "Excel (.xlsx)", size: "Live" },
    { id: "amazon-weekly", title: "Amazon Weekly Sales Report", desc: "Week-by-week Orders, Returns, Price, Total Sales, and Growth % per product, plus a Top Losers/Gainers summary — Amazon only, no Flipkart. Matches the classic weekly revenue sheet layout.", format: "Excel (.xlsx)", size: "Live" },
    { id: "amazon-monthly", title: "Amazon Monthly Sales Report", desc: "Month-by-month Orders, Returns, Price, Total Sales, and Growth % per product, plus a Top Losers/Gainers summary — Amazon only, no Flipkart.", format: "Excel (.xlsx)", size: "Live" },
    { id: "full", title: "Full Executive Report", desc: "A comprehensive multi-sheet Excel file containing Overview, Campaigns, Products, Targeting, Inventory, and Returns.", format: "Excel (.xlsx)", size: "Live" },
    { id: "performance", title: "Campaigns (Full)", desc: "Detailed breakdown of clicks, spend, sales, ACOS, and ROAS across all campaigns.", format: "CSV", size: "Live" },
    { id: "products", title: "Product Details (Full)", desc: "Analyze which products perform best in ads and match against inventory stock.", format: "CSV", size: "Live" },
    { id: "keywords", title: "Search Terms (Full)", desc: "List of all converting keywords and search terms for bid optimization.", format: "CSV", size: "Live" },
    { id: "inventory", title: "Inventory", desc: "Estimate run-rate and stockout risks based on current FBA velocity.", format: "CSV", size: "Live" },
    { id: "returns", title: "Returns & Cancellations", desc: "Detailed log of all FBA customer returns, ASINs, and reasons for return.", format: "CSV", size: "Live" },
    { id: "automations", title: "Advertising Automation Rules", desc: "Export active automations, schedules, and thresholds applied to your campaigns.", format: "CSV", size: "Live" },
  ];

  return (
    <div className="space-y-8 pb-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight mb-0.5">Report Center</h1>
        <p className="text-muted-foreground text-sm">
          {account?.name} · Download and export analytics reports
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {reports.map((report) => (
          <div key={report.id} className="glass rounded-2xl border border-border p-6 shadow-sm flex flex-col justify-between hover:border-primary/50 transition-colors">
            <div>
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                  {report.id === "performance" ? <BarChart3 size={20} /> : <FileSpreadsheet size={20} />}
                </div>
                <div>
                  <h3 className="font-bold text-sm text-foreground">{report.title}</h3>
                  <span className="text-[10px] text-muted-foreground uppercase font-black tracking-wider">{report.format} · {report.size}</span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">{report.desc}</p>
            </div>
            
            <button
              onClick={() => handleDownload(report.title)}
              disabled={generating !== null}
              className="mt-5 w-full py-2 bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-bold rounded-lg transition-colors flex items-center justify-center gap-2 shadow-md disabled:opacity-50"
            >
              {generating === report.title ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <Download size={14} />
                  Export Report
                </>
              )}
            </button>
          </div>
        ))}
      </div>

      {/* Audit Log / Generated Reports */}
      <div className="glass rounded-2xl border border-border p-6 shadow-sm">
        <h3 className="font-bold text-sm mb-4">Export History</h3>
        <div className="space-y-4">
          {history.length === 0 ? (
            <p className="text-xs text-muted-foreground">No reports have been exported during this session.</p>
          ) : (
            history.map((h, i) => (
              <div key={i} className="flex items-center justify-between text-xs pb-3 border-b border-border last:border-0 last:pb-0">
                <div className="flex items-center gap-3">
                  <FileText className="text-muted-foreground" size={16} />
                  <div>
                    <p className="font-semibold truncate max-w-[250px]" title={h.filename}>{h.filename}</p>
                    <p className="text-[10px] text-muted-foreground">Generated at {h.timestamp.toLocaleTimeString()}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-green-600 dark:text-green-400 font-bold">
                  <CheckCircle2 size={14} /> Downloaded
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
