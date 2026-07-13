"use client";

import { useDashboard } from "@/lib/DashboardContext";
import { Bot, Send, User, Sparkles, Loader2, ArrowRight } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";

export default function AIPage() {
  const { account } = useDashboard();
  const [messages, setMessages] = useState<any[]>([
    { role: "assistant", content: `Hello! I am your BARM AI Assistant. I have live access to your ${account?.name || "Amazon"} advertising data. Ask me anything about your campaigns, ACOS, keywords, or inventory forecasts!` }
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

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

    // Simulate AI response based on questions
    await new Promise(resolve => setTimeout(resolve, 1500));

    let reply = "I've analyzed your campaigns. We noticed a few opportunities to adjust bids on high ACOS targets to save budget.";
    const lowerInput = userMsg.toLowerCase();
    
    if (lowerInput.includes("acos")) {
      reply = `Your overall ACOS is currently healthy, but your top cost campaign has a 39.3% ACOS. I suggest lowering the bid on the keyword matches that haven't generated sales in the last 7 days.`;
    } else if (lowerInput.includes("sales") || lowerInput.includes("revenue")) {
      reply = `Total sales stand at ${account?.currency === "INR" ? "₹" : "$"}38,72,906. Organic sales contribute a strong portion, but ad sales are driving the velocity. I recommend raising the daily budget on your top-performing phrase match campaigns.`;
    } else if (lowerInput.includes("inventory") || lowerInput.includes("stock")) {
      reply = `Your inventory value on-hand is ${account?.currency === "INR" ? "₹" : "$"}1,18,67,154. FBA inventory looks solid, but some SKUs are at risk of stockout within 25 days if the current sales pace continues.`;
    }

    setMessages(prev => [...prev, { role: "assistant", content: reply }]);
    setSending(false);
  };

  const suggestions = [
    "What is my highest ACOS campaign?",
    "Show me organic vs ad sales performance",
    "Are there any stockout risks in my inventory?",
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
            <p className="leading-relaxed font-medium">{m.content}</p>
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
