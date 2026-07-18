"use client";

import { useDashboard } from "@/lib/DashboardContext";
import { useQuery } from "@tanstack/react-query";
import { mcp } from "@/lib/api";
import { Bot, Send, User, Sparkles, Loader2, ArrowRight } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";

const cur = (val: number, currency?: string) => {
  const sym = currency === "INR" ? "₹" : "$";
  if (!val) return `${sym}0`;
  return sym + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val));
};
const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));

export default function AIPage() {
  const { keySlot, startDate, endDate, account, contextLoading } = useDashboard();
  const [messages, setMessages] = useState<any[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const baseArgs = {
    amazon_account_id: account?.id,
    workspace_id: account?.workspace_id,
    start_date: startDate,
    end_date: endDate,
  };
  const currency = account?.currency;

  // Load live data for AI Context
  const { data: cpData } = useQuery({
    queryKey: ["cp_ai", keySlot, account?.id, startDate, endDate],
    queryFn: () => mcp("get_campaign_performance", { ...baseArgs, page_size: 100 }, keySlot),
    enabled: !!account,
  });

  const { data: inventoryData } = useQuery({
    queryKey: ["inventory_ai", keySlot, account?.id],
    queryFn: () => mcp("get_inventory", { amazon_account_id: account?.id, workspace_id: account?.workspace_id, page_size: 100 }, keySlot),
    enabled: !!account,
  });

  useEffect(() => {
    setMessages([
      { role: "assistant", content: `Hello! I am your BARM AI Assistant. I have live access to your ${account?.name || "Amazon"} advertising data. Ask me anything about your campaigns, ACOS, keywords, or inventory forecasts!` }
    ]);
    
    // Check if there is a pre-filled query in the URL
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const q = params.get("q");
      if (q) {
        setInput(q);
      }
    }
  }, [account]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || sending) return;

    const userMsg = input.trim();
    setInput("");
    setMessages(prev => [...prev, { role: "user", content: userMsg }]);
    setSending(true);

    // Compute live metrics for Gemini system prompt
    const spendVal = cpData?.summary?.totalSpend || 0;
    const salesVal = cpData?.summary?.totalSales || 0;
    const acosVal = cpData?.summary?.overallAcos || 0;
    const roasVal = cpData?.summary?.overallRoas || 0;
    const items = inventoryData?.items || [];
    const totalQty = items.reduce((acc: number, i: any) => acc + ((i.fbm?.quantity || 0) + (i.fba?.endingWarehouseBalance || 0)), 0);
    const totalVal = items.reduce((acc: number, i: any) => acc + ((i.fbm?.quantity || 0) + (i.fba?.endingWarehouseBalance || 0)) * (i.price || 0), 0);

    const systemPrompt = `You are the BARM AI PPC Assistant. You have access to the user's live dashboard data:
- Account: ${account?.name || "Barm Account"}
- Currency: ${currency}
- Total Ad Spend: ${cur(spendVal, currency)}
- Total Ad Sales: ${cur(salesVal, currency)}
- Overall ACOS: ${acosVal.toFixed(2)}%
- Overall ROAS: ${roasVal.toFixed(2)}x
- Inventory Units On-Hand: ${num(totalQty)} units
- Total Inventory Value: ${cur(totalVal, currency)}

Based on these metrics, provide a concise, expert, and direct answer to the user's question. Avoid generic fluff. Use markdown for tables or lists when helpful.
User question: "${userMsg}"`;

    try {
      const response = await fetch("/api/gemini-insights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: systemPrompt })
      });

      if (response.ok) {
        const data = await response.json();
        setMessages(prev => [...prev, { role: "assistant", content: data.text || "I was unable to analyze that query." }]);
        setSending(false);
        return;
      }
    } catch (err) {
      // Silently catch network errors
    }

    // Dynamic Fallback response using LIVE DATA from the UI state!
    let reply = "I encountered an error connecting to the AI models, but based on your live metrics: your account is performing steadily. Check the Bid Adjustment tab to optimize your top targets.";
    const lowerInput = userMsg.toLowerCase();
    
    // Determine the requested date range
    let dStrStart = "";
    let dStrEnd = "";
    let dateText = "the selected date range";
    
    if (lowerInput.includes("yesterday")) {
      const targetDate = new Date();
      targetDate.setDate(targetDate.getDate() - 1);
      dStrStart = targetDate.toISOString().slice(0, 10);
      dStrEnd = dStrStart;
      dateText = "yesterday";
    } else if (lowerInput.includes("today")) {
      const targetDate = new Date();
      dStrStart = targetDate.toISOString().slice(0, 10);
      dStrEnd = dStrStart;
    } else {
      const matchDays = lowerInput.match(/(?:last\s+)?(\d+)\s*day/);
      const matchDate = lowerInput.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
      const matchMonthDate = lowerInput.match(/(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})/);
      
      if (matchDate) {
        dStrStart = matchDate[1];
        dStrEnd = matchDate[1];
        dateText = matchDate[1];
      } else if (matchMonthDate) {
        const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
        const mStr = matchMonthDate[1].substring(0, 3);
        const monthIndex = monthNames.indexOf(mStr);
        const day = parseInt(matchMonthDate[2]);
        const year = new Date().getFullYear();
        const d = new Date(year, monthIndex, day);
        if (d > new Date()) d.setFullYear(year - 1); // If it's a future date, assume last year
        
        dStrStart = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
        dStrEnd = dStrStart;
        dateText = matchMonthDate[0];
      } else if (matchDays) {
        const days = parseInt(matchDays[1]);
        const end = new Date();
        const start = new Date();
        start.setDate(start.getDate() - days);
        dStrStart = start.toISOString().slice(0, 10);
        dStrEnd = end.toISOString().slice(0, 10);
        dateText = `the last ${days} days`;
      }
    }
    
    if (lowerInput.includes("inventory") || lowerInput.includes("stock") || lowerInput.includes("fba")) {
      const lowStock = items.filter((i: any) => ((i.fbm?.quantity || 0) + (i.fba?.endingWarehouseBalance || 0)) < 15 && i.itemName);
      if (lowStock.length > 0) {
        reply = `Your overall inventory value is ${cur(totalVal, currency)}. However, I found ${lowStock.length} products with critically low stock that are at risk of stocking out soon:\n\n${lowStock.slice(0, 5).map((i: any) => "- " + (i.itemName?.slice(0,50) + "...")).join('\n')}\n\nPlease check the **Inventory** tab to plan your next shipment!`;
      } else {
        reply = `Good news! Your inventory is healthy. Your total inventory value is ${cur(totalVal, currency)} across ${items.length} active SKUs, and no items are critically low on stock right now.`;
      }
    } 
    else if (lowerInput.includes("product") || lowerInput.includes("asin") || lowerInput.includes("sku")) {
      const isWorst = lowerInput.includes("worst") || lowerInput.includes("bad") || lowerInput.includes("bleed");
      try {
        const pArgs = dStrStart ? { ...baseArgs, start_date: dStrStart, end_date: dStrEnd, page_size: 100 } : { ...baseArgs, page_size: 100 };
        const pData = await mcp("get_advertised_product_performance", pArgs, keySlot);
        let prods = [...(pData?.data || [])];
        if (isWorst) {
          prods = prods.filter((p: any) => (p.spend / (p.sales || 1)) > 0.3 || (p.spend > 0 && !p.sales)).sort((a: any, b: any) => b.spend - a.spend).slice(0, 3);
          if (prods.length > 0) {
            reply = `The highest bleeding products for ${dateText} are:\n\n${prods.map(p => `- **${p.adAsin || p.sku || "Product"}** (${cur(p.spend, currency)} spend, ${cur(p.sales || 0, currency)} sales)`).join('\n')}\n\nCheck the **Bid Adjustment** tab to quickly lower bids on these targets.`;
          } else {
            reply = `I don't see any products bleeding massive budget for ${dateText}. Good job!`;
          }
        } else {
          prods = prods.sort((a: any, b: any) => b.sales - a.sales).slice(0, 3);
          if (prods.length > 0) {
            reply = `Your top performing products for ${dateText} are:\n\n${prods.map(p => `- **${p.adAsin || p.sku || "Product"}** (${cur(p.sales, currency)} sales)`).join('\n')}\n\nReview the **Products** tab for detailed ROAS breakdowns.`;
          } else {
            reply = `I don't see any active products generating sales for ${dateText}.`;
          }
        }
      } catch (e) {
        reply = "I couldn't fetch the product data right now.";
      }
    }
    else if (lowerInput.includes("keyword") || lowerInput.includes("search term") || lowerInput.includes("search team") || lowerInput.includes("target")) {
      const isWorst = lowerInput.includes("worst") || lowerInput.includes("bad") || lowerInput.includes("bleed");
      try {
        const kArgs = dStrStart ? { ...baseArgs, start_date: dStrStart, end_date: dStrEnd, page_size: 100 } : { ...baseArgs, page_size: 100 };
        const kData = await mcp("get_targeting_performance", kArgs, keySlot);
        let kws = [...(kData?.data || [])];
        if (isWorst) {
          kws = kws.filter((k: any) => (k.spend / (k.sales || 1)) > 0.3 || (k.spend > 0 && !k.sales)).sort((a: any, b: any) => b.spend - a.spend).slice(0, 3);
          if (kws.length > 0) {
            reply = `The highest bleeding keywords/targets for ${dateText} are:\n\n${kws.map(k => `- **${k.keywordText || k.targetingText || "Target"}** (${cur(k.spend, currency)} spend, ${cur(k.sales || 0, currency)} sales)`).join('\n')}\n\nNavigate to the **Bid Adjustment** tab to apply the 'Reduce' suggestions immediately.`;
          } else {
            reply = `I don't see any keywords bleeding massive budget for ${dateText}.`;
          }
        } else {
          kws = kws.sort((a: any, b: any) => b.sales - a.sales).slice(0, 3);
          if (kws.length > 0) {
            reply = `Your top performing keywords/targets for ${dateText} are:\n\n${kws.map(k => `- **${k.keywordText || k.targetingText || "Target"}** (${cur(k.sales, currency)} sales, ${k.acos ? k.acos.toFixed(1) : 0}% ACOS)`).join('\n')}\n\nCheck the **Bid Adjustment** tab to scale these up!`;
          } else {
            reply = `No major keyword data found for ${dateText}.`;
          }
        }
      } catch (e) {
        reply = "I couldn't fetch the keyword data right now.";
      }
    }
    else if (lowerInput.includes("summary") || lowerInput.includes("kpi") || lowerInput.includes("metrics")) {
      try {
        const cArgs = dStrStart ? { ...baseArgs, start_date: dStrStart, end_date: dStrEnd, page_size: 1 } : { ...baseArgs, page_size: 1 };
        const rArgs = dStrStart ? { ...baseArgs, start_date: dStrStart, end_date: dStrEnd, page_size: 1 } : { ...baseArgs, page_size: 1 };
        
        const [cData, rData] = await Promise.all([
          mcp("get_campaign_performance", cArgs, keySlot),
          mcp("get_retail_product_performance", rArgs, keySlot)
        ]);

        const cSum = cData?.summary || {};
        const rSum = rData?.summary || {};

        const adSpend = cSum.totalSpend || 0;
        const adSales = cSum.totalSales || 0;
        const totalSales = rSum.totalSales || adSales;
        const orgSales = totalSales - adSales;
        const roas = cSum.overallRoas || 0;
        const tacos = rSum.overallTacos || (totalSales ? (adSpend / totalSales) * 100 : 0);

        reply = `Here is your Executive Summary for ${dateText}:\n\n- **Total Sales**: ${cur(totalSales, currency)}\n- **Ad Sales**: ${cur(adSales, currency)}\n- **Organic Sales**: ${cur(orgSales, currency)}\n- **Ad Spend**: ${cur(adSpend, currency)}\n- **ROAS**: ${roas.toFixed(2)}x\n- **TACOS**: ${tacos.toFixed(2)}%\n\nYour account is generating steady volume. I recommend checking the **Optimization** tab to find new dayparting opportunities!`;
      } catch (e) {
        reply = "I couldn't fetch the summary metrics right now.";
      }
    }
    else if (lowerInput.includes("campaign") || lowerInput.includes("performance") || lowerInput.includes("sales") || lowerInput.includes("top") || lowerInput.includes("best") || lowerInput.includes("worst") || lowerInput.includes("bad")) {
      let campsData = [...(cpData?.data || [])];
      let sVal = salesVal;
      let aVal = acosVal;
      
      if (dStrStart) {
        try {
          const customData = await mcp("get_campaign_performance", { ...baseArgs, start_date: dStrStart, end_date: dStrEnd, page_size: 100 }, keySlot);
          campsData = customData?.data || [];
          sVal = customData?.summary?.totalSales || 0;
          aVal = customData?.summary?.overallAcos || 0;
        } catch (e) {}
      }

      const isWorst = lowerInput.includes("worst") || lowerInput.includes("bad") || lowerInput.includes("bleed");
      let camps = campsData;
      if (isWorst) {
        camps = camps.filter((c: any) => (c.spend / (c.sales || 1)) > 0.3 || (c.spend > 0 && !c.sales)).sort((a: any, b: any) => b.spend - a.spend).slice(0, 3);
        if (camps.length > 0) {
          reply = `Your overall ACOS for ${dateText} is ${aVal.toFixed(2)}%, but the highest bleeding campaigns are:\n\n${camps.map(c => `- **${c.campaignName || c.name || "Campaign"}** (${((c.spend / (c.sales || 1)) * 100).toFixed(1)}% ACOS, ${cur(c.spend, currency)} spend)`).join('\n')}\n\nNavigate to the **Bid Adjustment** tab to apply the 'Reduce' suggestions immediately to save wasted spend.`;
        } else {
          reply = `I don't see any campaigns bleeding massive budget for ${dateText}. Great job!`;
        }
      } else {
        camps = camps.sort((a: any, b: any) => b.sales - a.sales).slice(0, 3);
        if (camps.length > 0) {
          reply = `Your total ad sales for ${dateText} were ${cur(sVal, currency)} with an overall ACOS of ${aVal.toFixed(2)}%. Your top performing campaigns driving this velocity are:\n\n${camps.map(c => `- **${c.campaignName || c.name || "Campaign"}** (${cur(c.sales, currency)} sales)`).join('\n')}\n\nI recommend reviewing these in the **Campaigns** tab to double down on what's working!`;
        } else {
          reply = `Your total ad sales for ${dateText} stand at ${cur(sVal, currency)} with a ${aVal.toFixed(2)}% ACOS. I don't see any active campaigns generating massive volume for this specific date, so let's focus on keyword discovery.`;
        }
      }
    } 
    else if (lowerInput.includes("acos") || lowerInput.includes("bid") || lowerInput.includes("reduce") || lowerInput.includes("trim")) {
      const bleeders = [...(cpData?.data || [])].filter((c: any) => (c.spend / (c.sales || 1)) > 0.4).sort((a: any, b: any) => b.spend - a.spend);
      if (bleeders.length > 0) {
        reply = `Your overall ACOS is ${acosVal.toFixed(2)}%, but some campaigns are burning budget! The biggest bleeders are:\n\n${bleeders.slice(0, 3).map(c => `- **${c.campaignName || c.name || "Campaign"}** (${((c.spend / (c.sales || 1)) * 100).toFixed(1)}% ACOS, ${cur(c.spend, currency)} spend)`).join('\n')}\n\nNavigate to the **Bid Adjustment** tab and apply the 'Reduce' suggestions immediately to save wasted spend.`;
      } else {
        reply = `Your overall ACOS is ${acosVal.toFixed(2)}%, and I don't see any major campaigns bleeding budget right now. Great job! Check the **Bid Adjustment** tab for 'Scale Up' candidates instead.`;
      }
    }
    else if (lowerInput.includes("hi") || lowerInput.includes("hello") || lowerInput.includes("hey")) {
      reply = "Hello! I am your BARM AI PPC Assistant. I can help you analyze your ACOS, spot wasted spend, check inventory levels, and identify top-performing campaigns, products, or keywords. What would you like to dive into today?";
    }
    
    setMessages(prev => [...prev, { role: "assistant", content: reply }]);
    setSending(false);
  };

  const suggestions = [
    "What is my overall ACOS and ROAS status?",
    "Show me my inventory value and stock count details",
    "Should I increase ad budgets or trim bids?",
  ];

  return (
    <div className="flex flex-col h-[calc(100vh-80px)] max-w-4xl mx-auto pb-4">
      {/* Header */}
      <div className="pb-4 flex items-center justify-between border-b border-border mb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight mb-0.5 flex items-center gap-2">
            <Bot className="text-primary" /> AI Assistant
          </h1>
          <p className="text-muted-foreground text-sm">
            Ask questions and get instant insights from your advertising account
          </p>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto space-y-4 pr-2 mb-4 scrollbar-thin">
        {messages.map((m, idx) => (
          <div key={idx} className={cn("flex gap-3 text-sm p-4 rounded-2xl max-w-[85%]", m.role === "assistant" ? "bg-card border border-border mr-auto" : "bg-primary text-white ml-auto")}>
            <div className="w-6 h-6 rounded-lg bg-muted flex items-center justify-center text-foreground flex-shrink-0">
              {m.role === "assistant" ? <Bot size={14} className="text-primary" /> : <User size={14} />}
            </div>
            <div className="leading-relaxed font-medium whitespace-pre-wrap">{m.content}</div>
          </div>
        ))}
        {sending && (
          <div className="flex gap-3 text-sm p-4 bg-card border border-border mr-auto rounded-2xl flex-shrink-0 items-center">
            <Loader2 className="w-4 h-4 animate-spin text-primary" />
            <span className="text-muted-foreground">AI is analyzing your ad data...</span>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* Suggestions */}
      {messages.length === 1 && (
        <div className="mb-4">
          <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Suggested Prompts</p>
          <div className="flex flex-wrap gap-2">
            {suggestions.map((s, i) => (
              <button
                key={i}
                onClick={() => setInput(s)}
                className="text-xs px-3 py-2 rounded-xl bg-card border border-border hover:border-primary/50 text-foreground transition-all flex items-center gap-1 shadow-sm font-semibold"
              >
                {s} <ArrowRight size={12} className="text-muted-foreground" />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Input */}
      <form onSubmit={handleSend} className="relative flex items-center">
        <input
          required
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Ask AI assistant about your metrics..."
          className="w-full bg-card border border-border text-foreground pl-4 pr-12 py-3 rounded-2xl text-sm shadow-md focus:border-primary focus:outline-none transition-colors font-medium"
        />
        <button
          type="submit"
          disabled={sending}
          className="absolute right-2.5 w-8 h-8 rounded-xl bg-primary text-white flex items-center justify-center hover:bg-primary/95 transition-colors disabled:opacity-50"
        >
          <Send size={14} />
        </button>
      </form>
    </div>
  );
}
