"use client";

import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  MARKETPLACE_META,
  generateMarketplaceOverview,
  generateMarketplaceCampaigns,
  type MarketplaceId
} from "@/lib/marketplace";
import { fetchFlipkartOverview } from "@/lib/flipkartData";
import { useDashboard } from "@/lib/DashboardContext";
import { PageHero } from "@/components/PageHero";
import { Bot, Send, Sparkles, Wand2, ArrowRight, Loader2 } from "lucide-react";

interface MarketplaceAiProps {
  marketplace: Exclude<MarketplaceId, "amazon">;
}

export function MarketplaceAi({ marketplace }: MarketplaceAiProps) {
  const meta = MARKETPLACE_META[marketplace];
  const { startDate, endDate, loggedInUser } = useDashboard();
  const [messages, setMessages] = useState([
    {
      sender: "ai",
      text: `Hello! I am your ${meta.label} AI Growth Assistant. Ask me anything about your ${meta.label} performance or strategy.`,
    },
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  // Real uploaded data (see src/lib/flipkartData.ts, backed by Supabase) takes
  // priority over the deterministic demo generator — Flipkart has no live Ads
  // API, but once real reports are uploaded via the Upload Data hub, the
  // assistant should reason over those instead of illustrative numbers.
  const { data: realOverview } = useQuery({
    queryKey: ["flipkart_ai_overview", marketplace, loggedInUser, startDate, endDate],
    queryFn: () => fetchFlipkartOverview(loggedInUser, startDate, endDate),
    enabled: !!loggedInUser && !!startDate && !!endDate,
    staleTime: 60_000,
  });
  const hasRealData = !!realOverview && (realOverview.grossSales > 0 || realOverview.topProducts.length > 0 || realOverview.topCampaigns.length > 0);

  // Swap the opening greeting once we know whether real data exists — but only
  // while the conversation hasn't started yet, so we never rewrite history
  // out from under an in-progress chat.
  useEffect(() => {
    if (realOverview === undefined) return;
    setMessages((prev) => {
      if (prev.length !== 1) return prev;
      const greeting = hasRealData
        ? `Hello! I am your ${meta.label} AI Growth Assistant, connected to your uploaded ${meta.label} account data. Ask me anything about your performance or strategy.`
        : `Hello! I am your ${meta.label} AI Growth Assistant. ${meta.label} has no live Seller API connected and no reports have been uploaded yet, so I'm reasoning over the same illustrative demo data shown on your ${meta.label} pages — ask me anything about it, or about ${meta.label} strategy in general.`;
      return [{ sender: "ai", text: greeting }];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realOverview, hasRealData]);

  // Canned, fully local fallback — only used if the live Gemini call itself fails
  // (network error, rate limit, etc.), never presented as if it were the AI reply.
  const localFallback = (userText: string) => {
    let reply = `Based on your ${meta.label} performance data: I recommend setting up an ACOS guardrail rule at 30% and boosting bids on top sellers with >4x ROAS.`;
    if (userText.toLowerCase().includes("rule") || userText.toLowerCase().includes("acos")) {
      reply = `For ${meta.label}, setting up a Smart ROI Guardrail rule to lower bids when ACOS exceeds 35% will save ~₹7,500 monthly.`;
    }
    return reply;
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || sending) return;

    const userText = input;
    setMessages((prev) => [...prev, { sender: "user", text: userText }]);
    setInput("");
    setSending(true);

    let dataDisclaimer: string;
    let snapshotBlock: string;
    let topCampaignsBlock: string;

    if (hasRealData && realOverview) {
      dataDisclaimer = `The data below is real, live data from this ${meta.label} account's uploaded reports — you can describe it as real/live.`;
      snapshotBlock = `Live ${meta.label} snapshot (${startDate} to ${endDate}):
- Gross Sales: ₹${Math.round(realOverview.grossSales)}
- Net Sales: ₹${Math.round(realOverview.netSales)}
- Units Sold: ${realOverview.units}
- Ad Spend: ₹${Math.round(realOverview.adSpend)}
- Ad Sales: ₹${Math.round(realOverview.adSales)}
- ROAS: ${realOverview.roas.toFixed(2)}x
- ACOS: ${realOverview.acos.toFixed(1)}%
- TACOS: ${realOverview.tacos.toFixed(1)}%
- Growth vs prior period: ${realOverview.growthPct == null ? "no comparable data (retail sales report not uploaded)" : `${realOverview.growthPct.toFixed(1)}%`}`;
      topCampaignsBlock = realOverview.topCampaigns.length
        ? realOverview.topCampaigns.map((c) => `${c.name}: spend ₹${Math.round(c.spend)}, sales ₹${Math.round(c.sales)}, ROAS ${c.roas.toFixed(2)}x`).join("\n")
        : "No campaign-level data uploaded for this range yet.";
    } else {
      dataDisclaimer = `${meta.label} has no live Seller/Ads API connected for this account yet, and no reports have been uploaded — the data below is deterministic demo data standing in for a real account, not a live feed. Never claim these numbers are live/real; it's fine to give strategic advice using them as an example.`;
      const overview = generateMarketplaceOverview(marketplace, startDate, endDate);
      const campaigns = generateMarketplaceCampaigns(marketplace);
      snapshotBlock = `Demo ${meta.label} snapshot (${startDate} to ${endDate}):
- Total Sales: ₹${Math.round(overview.totalSales)}
- Total Orders: ${overview.totalOrders}
- Return Rate: ${overview.returnRatePct.toFixed(1)}%
- Growth vs prior period: ${overview.growthPct.toFixed(1)}%
- Average Rating: ${overview.rating.toFixed(1)}`;
      topCampaignsBlock = campaigns
        .slice()
        .sort((a, b) => b.sales - a.sales)
        .slice(0, 5)
        .map((c) => `${c.name}: spend ₹${c.spend}, sales ₹${c.sales}, ACOS ${c.acos}%, ROAS ${c.roas}x, status ${c.status}`)
        .join("\n");
    }

    const systemPrompt = `You are the ${meta.label} AI Growth Assistant inside a multi-marketplace ads dashboard. IMPORTANT: ${dataDisclaimer}

${snapshotBlock}

Top campaigns by sales:
${topCampaignsBlock}

Based on this, provide a concise, expert, and direct answer. Use bold text and bullet points where helpful. User question: "${userText}"`;

    try {
      const response = await fetch("/api/gemini-insights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: systemPrompt }),
      });

      if (response.ok) {
        const data = await response.json();
        setMessages((prev) => [...prev, { sender: "ai", text: data.text || localFallback(userText) }]);
        setSending(false);
        return;
      }
    } catch {
      // fall through to local handling below
    }

    setMessages((prev) => [...prev, { sender: "ai", text: localFallback(userText) }]);
    setSending(false);
  };

  return (
    <motion.div 
      initial={{ opacity: 0 }} 
      animate={{ opacity: 1 }} 
      transition={{ duration: 0.4 }}
      className="space-y-6 pb-12"
    >
      <PageHero
        title={`${meta.label} AI Assistant`}
        subtitle={`Ask questions, get rule recommendations, and optimize your ${meta.label} store.`}
      />

      <div className="bg-popover/80 border border-border rounded-2xl h-[500px] flex flex-col overflow-hidden shadow-xl">
        <div className="p-4 bg-white dark:bg-slate-950 border-b border-slate-200 dark:border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <Bot className="w-4 h-4" />
            </div>
            <div>
              <h4 className="font-extrabold text-xs text-slate-900 dark:text-white">{meta.label} AI Advisor</h4>
              <span className={`text-[10px] font-bold ${hasRealData ? "text-emerald-400" : "text-amber-400"}`}>
                {hasRealData ? "● Connected · Live Data" : "● Connected · Demo Data"}
              </span>
            </div>
          </div>
        </div>

        <div className="flex-1 p-4 overflow-y-auto space-y-3">
          {messages.map((m, i) => (
            <div
              key={i}
              className={`flex ${m.sender === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] p-3.5 rounded-2xl text-xs ${
                  m.sender === "user"
                    ? "bg-indigo-600 text-white rounded-br-none"
                    : "bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200 rounded-bl-none"
                }`}
              >
                {m.text}
              </div>
            </div>
          ))}
          {sending && (
            <div className="flex justify-start">
              <div className="max-w-[80%] p-3.5 rounded-2xl rounded-bl-none text-xs bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Thinking...
              </div>
            </div>
          )}
        </div>

        <form onSubmit={handleSend} className="p-3 bg-white dark:bg-slate-950 border-t border-slate-200 dark:border-border flex items-center gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={sending}
            placeholder={`Ask ${meta.label} AI... (e.g., "What rules should I enable for Flipkart PLA?")`}
            className="flex-1 px-4 py-2.5 rounded-xl bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 text-xs focus:outline-none focus:border-indigo-500 disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={sending}
            className="px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-all disabled:opacity-60"
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </form>
      </div>
    </motion.div>
  );
}
