"use client";

import { useDashboard } from "@/lib/DashboardContext";
import { useQuery } from "@tanstack/react-query";
import { mcp, mcpAllInventory } from "@/lib/api";
import {
  Bot, Send, User, Sparkles, Loader2, ArrowRight,
  TrendingUp, TrendingDown, Package, Megaphone,
  Zap, BarChart3, Target, Brain, ChevronRight,
  RotateCcw, Star, AlertTriangle, CheckCircle2, Info
} from "lucide-react";
import { useState, useRef, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { motion, AnimatePresence } from "framer-motion";

const cur = (val: number, currency?: string) => {
  const sym = currency === "INR" ? "₹" : "$";
  if (!val) return `${sym}0`;
  return sym + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(val));
};
const num = (val: number) => new Intl.NumberFormat("en-IN").format(Math.round(val || 0));

type Message = {
  role: "user" | "assistant";
  content: string;
  timestamp?: Date;
};

type Suggestion = {
  label: string;
  prompt: string;
  icon: React.ReactNode;
  color: string;
};

const SUGGESTION_GROUPS: { title: string; items: Suggestion[] }[] = [
  {
    title: "📊 Performance",
    items: [
      { label: "Overall KPI Summary", prompt: "Give me a full KPI summary of my account", icon: <BarChart3 className="w-3.5 h-3.5" />, color: "from-indigo-500 to-violet-600" },
      { label: "Top Campaigns", prompt: "Show me my top performing campaigns by sales", icon: <TrendingUp className="w-3.5 h-3.5" />, color: "from-emerald-500 to-teal-600" },
      { label: "Worst Bleeders", prompt: "Which campaigns are bleeding the most budget with bad ACOS?", icon: <TrendingDown className="w-3.5 h-3.5" />, color: "from-red-500 to-rose-600" },
    ]
  },
  {
    title: "💡 Optimization",
    items: [
      { label: "ACOS Analysis", prompt: "Analyze my ACOS and suggest which bids I should reduce", icon: <Target className="w-3.5 h-3.5" />, color: "from-orange-500 to-amber-600" },
      { label: "Keyword Health", prompt: "Show me my top performing keywords and targets", icon: <Zap className="w-3.5 h-3.5" />, color: "from-yellow-500 to-orange-600" },
      { label: "Scale Opportunities", prompt: "Which campaigns have low ACOS that I should scale up?", icon: <Star className="w-3.5 h-3.5" />, color: "from-pink-500 to-rose-600" },
    ]
  },
  {
    title: "📦 Inventory & Products",
    items: [
      { label: "Inventory Status", prompt: "Show me my inventory levels and any low-stock alerts", icon: <Package className="w-3.5 h-3.5" />, color: "from-cyan-500 to-blue-600" },
      { label: "Best Products", prompt: "Which products are generating the most ad revenue?", icon: <CheckCircle2 className="w-3.5 h-3.5" />, color: "from-green-500 to-emerald-600" },
      { label: "Bleeding Products", prompt: "Which products are spending the most with zero or low sales?", icon: <AlertTriangle className="w-3.5 h-3.5" />, color: "from-red-400 to-red-600" },
    ]
  }
];

function TypingIndicator() {
  return (
    <div className="flex gap-3 max-w-[85%] mr-auto">
      <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center flex-shrink-0 shadow-md shadow-indigo-500/30">
        <Bot size={15} className="text-white" />
      </div>
      <div className="flex items-center gap-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl px-4 py-3 shadow-sm">
        <div className="flex gap-1">
          {[0, 0.2, 0.4].map((delay, i) => (
            <motion.div
              key={i}
              animate={{ y: [0, -6, 0] }}
              transition={{ repeat: Infinity, duration: 0.8, delay, ease: "easeInOut" }}
              className="w-2 h-2 rounded-full bg-gradient-to-br from-indigo-400 to-violet-500"
            />
          ))}
        </div>
        <span className="text-[11px] text-slate-400 font-semibold">AI is analyzing your data...</span>
      </div>
    </div>
  );
}

function MessageBubble({ message, index }: { message: Message; index: number }) {
  const isAssistant = message.role === "assistant";

  // Simple markdown renderer for bold, bullets, and code
  const renderContent = (content: string) => {
    const lines = content.split("\n");
    return lines.map((line, i) => {
      if (line.startsWith("- ")) {
        const text = line.slice(2).replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
        return <li key={i} className="ml-4 list-disc" dangerouslySetInnerHTML={{ __html: text }} />;
      }
      const text = line.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
      return <p key={i} className="leading-relaxed" dangerouslySetInnerHTML={{ __html: text }} />;
    });
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 12, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.3, delay: index * 0.03 }}
      className={cn("flex gap-3", isAssistant ? "max-w-[88%] mr-auto" : "max-w-[80%] ml-auto flex-row-reverse")}
    >
      <div className={cn(
        "w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 shadow-md",
        isAssistant
          ? "bg-gradient-to-br from-indigo-500 to-violet-600 shadow-indigo-500/30"
          : "bg-gradient-to-br from-emerald-500 to-teal-600 shadow-emerald-500/30"
      )}>
        {isAssistant ? <Bot size={15} className="text-white" /> : <User size={15} className="text-white" />}
      </div>

      <div className={cn(
        "rounded-2xl px-4 py-3 text-sm shadow-sm",
        isAssistant
          ? "bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-200"
          : "bg-gradient-to-br from-indigo-500 to-violet-600 text-white"
      )}>
        <div className="space-y-1 font-medium leading-relaxed text-[13px]">
          {renderContent(message.content)}
        </div>
        {message.timestamp && (
          <p className={cn("text-[10px] mt-2 font-semibold", isAssistant ? "text-slate-400" : "text-white/60")}>
            {message.timestamp.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
          </p>
        )}
      </div>
    </motion.div>
  );
}

export default function AIPage() {
  const { keySlot, startDate, endDate, account, contextLoading } = useDashboard();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const baseArgs = {
    amazon_account_id: account?.id,
    workspace_id: account?.workspace_id,
    start_date: startDate,
    end_date: endDate,
  };
  const currency = account?.currency;

  const { data: cpData } = useQuery({
    queryKey: ["cp_ai", keySlot, account?.id, startDate, endDate],
    queryFn: () => mcp("get_campaign_performance", { ...baseArgs, page_size: 100 }, keySlot),
    enabled: !!account,
  });

  const { data: inventoryData } = useQuery({
    queryKey: ["inventory_ai", keySlot, account?.id],
    // get_inventory paginates with limit/offset, not page_size — mcpAllInventory fetches every
    // page instead of silently capping at the API's ~50-item default, so the assistant's
    // stockout detection actually sees the full catalog.
    queryFn: () => mcpAllInventory({ amazon_account_id: account?.id, workspace_id: account?.workspace_id }, keySlot),
    enabled: !!account,
  });

  useEffect(() => {
    setMessages([
      {
        role: "assistant",
        content: `Hello! I'm your **Marketplace360 Assistant** — powered by live advertising data from your ${account?.name || "Amazon"} account.\n\nI can help you with:\n- Campaign performance & ACOS analysis\n- Bid optimization recommendations\n- Inventory forecasting & stock alerts\n- Product-level revenue breakdown\n\nWhat would you like to explore today?`,
        timestamp: new Date(),
      }
    ]);

    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const q = params.get("q");
      if (q) setInput(q);
    }
  }, [account]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  // Live stats summary
  const spendVal = cpData?.summary?.totalSpend || 0;
  const salesVal = cpData?.summary?.totalSales || 0;
  const acosVal = cpData?.summary?.overallAcos || 0;
  const roasVal = cpData?.summary?.overallRoas || 0;
  const items = inventoryData || [];
  const totalQty = items.reduce((acc: number, i: any) => acc + ((i.fbm?.quantity || 0) + (i.fba?.endingWarehouseBalance || 0)), 0);
  const totalVal = items.reduce((acc: number, i: any) => acc + ((i.fbm?.quantity || 0) + (i.fba?.endingWarehouseBalance || 0)) * (i.price || 0), 0);

  const handleSend = useCallback(async (e: React.FormEvent | null, overrideInput?: string) => {
    if (e) e.preventDefault();
    const userMsg = (overrideInput || input).trim();
    if (!userMsg || sending) return;

    setInput("");
    setShowSuggestions(false);
    setMessages(prev => [...prev, { role: "user", content: userMsg, timestamp: new Date() }]);
    setSending(true);

    const systemPrompt = `You are the Marketplace360 PPC Assistant. You have access to the user's live dashboard data:
- Account: ${account?.name || "Barm Account"}
- Currency: ${currency}
- Total Ad Spend: ${cur(spendVal, currency)}
- Total Ad Sales: ${cur(salesVal, currency)}
- Overall ACOS: ${acosVal.toFixed(2)}%
- Overall ROAS: ${roasVal.toFixed(2)}x
- Inventory Units On-Hand: ${num(totalQty)} units
- Total Inventory Value: ${cur(totalVal, currency)}
- Date Range: ${startDate} to ${endDate}

Based on these metrics, provide a concise, expert, and direct answer. Avoid generic fluff. Use bold text and bullet points. Be specific with numbers from the data. User question: "${userMsg}"`;

    try {
      const response = await fetch("/api/gemini-insights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: systemPrompt })
      });

      if (response.ok) {
        const data = await response.json();
        setMessages(prev => [...prev, { role: "assistant", content: data.text || "I was unable to analyze that query.", timestamp: new Date() }]);
        setSending(false);
        return;
      }
    } catch (err) {
      // fallthrough to local handling
    }

    // Smart local fallback
    let reply = "I encountered an error connecting to the AI models. Based on your live metrics, your account is performing steadily. Check the Bid Adjustment tab to optimize your top targets.";
    const lowerInput = userMsg.toLowerCase();

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
      if (matchDate) {
        dStrStart = matchDate[1];
        dStrEnd = matchDate[1];
        dateText = matchDate[1];
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
        reply = `Your overall inventory value is **${cur(totalVal, currency)}**. However, I found **${lowStock.length} products** with critically low stock:\n\n${lowStock.slice(0, 5).map((i: any) => "- " + (i.itemName?.slice(0, 55) + "...")).join('\n')}\n\nPlease check the **Inventory** tab to plan your next shipment!`;
      } else {
        reply = `Good news! Your inventory is healthy. Total inventory value: **${cur(totalVal, currency)}** across **${items.length} active SKUs**. No items are critically low right now.`;
      }
    } else if (lowerInput.includes("summary") || lowerInput.includes("kpi") || lowerInput.includes("metrics")) {
      try {
        const cArgs = dStrStart ? { ...baseArgs, start_date: dStrStart, end_date: dStrEnd, page_size: 1 } : { ...baseArgs, page_size: 1 };
        const [cData, rData] = await Promise.all([
          mcp("get_campaign_performance", cArgs, keySlot),
          mcp("get_retail_product_performance", cArgs, keySlot)
        ]);
        const cSum = cData?.summary || {};
        const rSum = rData?.summary || {};
        const adSpend = cSum.totalSpend || 0;
        const adSales = cSum.totalSales || 0;
        const totalSales = rSum.totalSales || adSales;
        const orgSales = totalSales - adSales;
        const roas = cSum.overallRoas || 0;
        const tacos = rSum.overallTacos || (totalSales ? (adSpend / totalSales) * 100 : 0);
        reply = `Here is your **Executive KPI Summary** for ${dateText}:\n\n- **Total Sales**: ${cur(totalSales, currency)}\n- **Ad Sales**: ${cur(adSales, currency)}\n- **Organic Sales**: ${cur(orgSales, currency)}\n- **Ad Spend**: ${cur(adSpend, currency)}\n- **ROAS**: ${roas.toFixed(2)}x\n- **TACOS**: ${tacos.toFixed(2)}%\n\nYour account is generating steady volume. I recommend checking the **Optimization** tab to find new dayparting opportunities!`;
      } catch (e) {
        reply = "I couldn't fetch the summary metrics right now.";
      }
    } else if (lowerInput.includes("campaign") || lowerInput.includes("performance") || lowerInput.includes("sales") || lowerInput.includes("top") || lowerInput.includes("best") || lowerInput.includes("worst") || lowerInput.includes("bad") || lowerInput.includes("bleed")) {
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

      const isWorst = lowerInput.includes("worst") || lowerInput.includes("bad") || lowerInput.includes("bleed") || lowerInput.includes("scale");
      let camps = campsData;
      if (isWorst) {
        camps = camps.filter((c: any) => (c.spend / (c.sales || 1)) > 0.3 || (c.spend > 0 && !c.sales)).sort((a: any, b: any) => b.spend - a.spend).slice(0, 4);
        if (camps.length > 0) {
          reply = `Your overall ACOS for ${dateText} is **${aVal.toFixed(2)}%**, but these campaigns need attention:\n\n${camps.map(c => `- **${c.campaignName || c.name || "Campaign"}** — ${((c.spend / (c.sales || 1)) * 100).toFixed(1)}% ACOS, ${cur(c.spend, currency)} spend`).join('\n')}\n\nNavigate to the **Bid Adjustment** tab and apply 'Reduce' suggestions to save wasted spend.`;
        } else {
          reply = `I don't see any campaigns bleeding massive budget for ${dateText}. Great job! Overall ACOS: **${aVal.toFixed(2)}%**.`;
        }
      } else {
        camps = camps.sort((a: any, b: any) => b.sales - a.sales).slice(0, 4);
        if (camps.length > 0) {
          reply = `Your total ad sales for ${dateText} were **${cur(sVal, currency)}** with an overall ACOS of **${aVal.toFixed(2)}%**. Your top campaigns:\n\n${camps.map(c => `- **${c.campaignName || c.name || "Campaign"}** — ${cur(c.sales, currency)} sales`).join('\n')}\n\nReview these in the **Campaigns** tab to double down on what's working!`;
        } else {
          reply = `Your total ad sales for ${dateText} stand at **${cur(sVal, currency)}** with a **${aVal.toFixed(2)}% ACOS**.`;
        }
      }
    } else if (lowerInput.includes("acos") || lowerInput.includes("bid") || lowerInput.includes("reduce")) {
      const bleeders = [...(cpData?.data || [])].filter((c: any) => (c.spend / (c.sales || 1)) > 0.4).sort((a: any, b: any) => b.spend - a.spend);
      if (bleeders.length > 0) {
        reply = `Your overall ACOS is **${acosVal.toFixed(2)}%**, but some campaigns are burning budget!\n\n${bleeders.slice(0, 3).map(c => `- **${c.campaignName || c.name || "Campaign"}** — ${((c.spend / (c.sales || 1)) * 100).toFixed(1)}% ACOS, ${cur(c.spend, currency)} spend`).join('\n')}\n\nNavigate to the **Bid Adjustment** tab and apply 'Reduce' suggestions immediately.`;
      } else {
        reply = `Your overall ACOS is **${acosVal.toFixed(2)}%**, and no major campaigns are bleeding budget right now. Great job! Check the **Bid Adjustment** tab for 'Scale Up' candidates instead.`;
      }
    } else if (lowerInput.includes("product") || lowerInput.includes("asin") || lowerInput.includes("sku")) {
      try {
        const pArgs = dStrStart ? { ...baseArgs, start_date: dStrStart, end_date: dStrEnd, page_size: 100 } : { ...baseArgs, page_size: 100 };
        const pData = await mcp("get_advertised_product_performance", pArgs, keySlot);
        const isWorst = lowerInput.includes("worst") || lowerInput.includes("bad") || lowerInput.includes("bleed");
        let prods = [...(pData?.data || [])];
        if (isWorst) {
          prods = prods.filter((p: any) => (p.spend / (p.sales || 1)) > 0.3 || (p.spend > 0 && !p.sales)).sort((a: any, b: any) => b.spend - a.spend).slice(0, 4);
          reply = prods.length > 0
            ? `The highest bleeding products for ${dateText}:\n\n${prods.map(p => `- **${p.adAsin || p.sku || "Product"}** — ${cur(p.spend, currency)} spend, ${cur(p.sales || 0, currency)} sales`).join('\n')}\n\nCheck the **Bid Adjustment** tab to lower bids on these targets.`
            : `I don't see any products bleeding massive budget for ${dateText}. Good job!`;
        } else {
          prods = prods.sort((a: any, b: any) => b.sales - a.sales).slice(0, 4);
          reply = prods.length > 0
            ? `Your top performing products for ${dateText}:\n\n${prods.map(p => `- **${p.adAsin || p.sku || "Product"}** — ${cur(p.sales, currency)} sales`).join('\n')}\n\nReview the **Products** tab for detailed ROAS breakdowns.`
            : `No active products generating sales for ${dateText}.`;
        }
      } catch (e) {
        reply = "I couldn't fetch the product data right now.";
      }
    } else if (lowerInput.match(/^(hi|hello|hey|sup|start|help)/)) {
      reply = "Hello! I'm your **Marketplace360 PPC Assistant**. I can help you:\n\n- Analyze ACOS and spot wasted spend\n- Check inventory levels and stock alerts\n- Identify top-performing campaigns, products, and keywords\n- Generate bid optimization recommendations\n\nWhat would you like to dive into today?";
    }

    setMessages(prev => [...prev, { role: "assistant", content: reply, timestamp: new Date() }]);
    setSending(false);
  }, [input, sending, account, currency, spendVal, salesVal, acosVal, roasVal, totalQty, totalVal, items, cpData, keySlot, baseArgs, startDate, endDate]);

  return (
    <div className="flex flex-col h-[calc(100vh-72px)] max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between py-4 px-1 mb-2">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/30">
            <Brain className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-black tracking-tight text-slate-900 dark:text-white flex items-center gap-2">
              Marketplace360 Assistant
              <span className="text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-500">LIVE DATA</span>
            </h1>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 font-semibold">Ask anything about your campaigns, inventory & revenue</p>
          </div>
        </div>

        {/* Live Stats Strip */}
        {cpData && (
          <div className="hidden lg:flex items-center gap-2">
            {[
              { label: "Spend", val: cur(spendVal, currency), color: "text-rose-500" },
              { label: "Sales", val: cur(salesVal, currency), color: "text-emerald-500" },
              { label: "ACOS", val: `${acosVal.toFixed(1)}%`, color: acosVal > 40 ? "text-red-500" : "text-amber-500" },
              { label: "ROAS", val: `${roasVal.toFixed(2)}x`, color: "text-indigo-500" },
            ].map((s) => (
              <div key={s.label} className="text-center px-3 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">{s.label}</p>
                <p className={cn("text-xs font-black", s.color)}>{s.val}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Chat Area */}
      <div className="flex-1 overflow-y-auto space-y-4 pr-1 pb-2 scrollbar-thin">
        <AnimatePresence>
          {messages.map((m, idx) => (
            <MessageBubble key={idx} message={m} index={idx} />
          ))}
        </AnimatePresence>
        {sending && <TypingIndicator />}
        <div ref={endRef} />
      </div>

      {/* Suggestion Chips */}
      <AnimatePresence>
        {showSuggestions && messages.length <= 1 && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            className="py-4 space-y-3"
          >
            {SUGGESTION_GROUPS.map((group) => (
              <div key={group.title}>
                <p className="text-[10px] font-extrabold uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-2 px-1">{group.title}</p>
                <div className="flex flex-wrap gap-2">
                  {group.items.map((s) => (
                    <button
                      key={s.label}
                      onClick={() => handleSend(null, s.prompt)}
                      className="group flex items-center gap-2 text-[12px] px-3.5 py-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-indigo-500/50 dark:hover:border-indigo-500/40 text-slate-700 dark:text-slate-300 transition-all shadow-sm font-semibold hover:shadow-md hover:-translate-y-0.5"
                    >
                      <span className={cn("w-5 h-5 rounded-lg bg-gradient-to-br flex items-center justify-center text-white flex-shrink-0", s.color)}>
                        {s.icon}
                      </span>
                      {s.label}
                      <ChevronRight className="w-3 h-3 text-slate-400 group-hover:text-indigo-500 transition-colors" />
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Quick chips when chat is ongoing */}
      {!showSuggestions && (
        <div className="flex flex-wrap gap-1.5 pb-2 pt-1">
          {["Top campaigns", "ACOS analysis", "Inventory status", "KPI summary"].map((chip) => (
            <button
              key={chip}
              onClick={() => handleSend(null, chip)}
              className="text-[11px] px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:border-indigo-500/50 hover:text-indigo-600 dark:hover:text-indigo-400 transition-all font-semibold"
            >
              {chip}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <form onSubmit={handleSend} className="relative flex items-center gap-2">
        <div className="relative flex-1">
          <input
            ref={inputRef}
            required
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Ask about campaigns, ACOS, inventory, keywords..."
            className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-foreground pl-4 pr-12 py-3.5 rounded-2xl text-[13px] shadow-md focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30 focus:outline-none transition-all font-medium"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend(null);
              }
            }}
          />
          <kbd className="absolute right-12 top-1/2 -translate-y-1/2 hidden sm:inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-[9px] font-black text-slate-400 dark:text-slate-500 pointer-events-none select-none">
            Enter
          </kbd>
        </div>
        <button
          type="submit"
          disabled={sending || !input.trim()}
          className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white flex items-center justify-center hover:from-indigo-600 hover:to-violet-700 transition-all shadow-lg shadow-indigo-500/30 disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
        >
          {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
        </button>
      </form>

      {/* Footer note */}
      <p className="text-center text-[10px] text-slate-400 dark:text-slate-600 font-semibold mt-2 mb-1">
        Responses use your live {account?.name || "Amazon"} account data · {startDate} – {endDate}
      </p>
    </div>
  );
}
