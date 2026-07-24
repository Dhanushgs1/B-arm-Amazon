"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { 
  MARKETPLACE_META, 
  type MarketplaceId 
} from "@/lib/marketplace";
import { PageHero } from "@/components/PageHero";
import { Bot, Send, Sparkles, Wand2, ArrowRight } from "lucide-react";

interface MarketplaceAiProps {
  marketplace: Exclude<MarketplaceId, "amazon">;
}

export function MarketplaceAi({ marketplace }: MarketplaceAiProps) {
  const meta = MARKETPLACE_META[marketplace];
  const [messages, setMessages] = useState([
    {
      sender: "ai",
      text: `Hello! I am your ${meta.label} AI Growth Assistant. How can I optimize your ${meta.label} ad campaigns or rules today?`,
    },
  ]);
  const [input, setInput] = useState("");

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    const userText = input;
    setMessages((prev) => [...prev, { sender: "user", text: userText }]);
    setInput("");

    setTimeout(() => {
      let reply = `Based on your ${meta.label} performance data: I recommend setting up an ACOS guardrail rule at 30% and boosting bids on top sellers with >4x ROAS.`;
      if (userText.toLowerCase().includes("rule") || userText.toLowerCase().includes("acos")) {
        reply = `For ${meta.label}, setting up a Smart ROI Guardrail rule to lower bids when ACOS exceeds 35% will save ~₹7,500 monthly.`;
      }
      setMessages((prev) => [...prev, { sender: "ai", text: reply }]);
    }, 1000);
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
              <span className="text-[10px] text-emerald-400 font-bold">● Connected</span>
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
        </div>

        <form onSubmit={handleSend} className="p-3 bg-white dark:bg-slate-950 border-t border-slate-200 dark:border-border flex items-center gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`Ask ${meta.label} AI... (e.g., "What rules should I enable for Flipkart PLA?")`}
            className="flex-1 px-4 py-2.5 rounded-xl bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 text-xs focus:outline-none focus:border-indigo-500"
          />
          <button
            type="submit"
            className="px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-all"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>
    </motion.div>
  );
}
