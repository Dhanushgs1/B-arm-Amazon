"use client";

// Floating "Ask Marketplace360" chat, bottom-right on every dashboard page (user, 12 Nov 2026).
// Answers from our own data first (chatAnswers.ts: sales, orders, top products, stock, returns, ad
// spend), other questions through AI when a key is set on the server (askAi.ts). Data: the Business
// overview dataset, loaded only when the chat is first opened.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowUp, ChevronRight, Loader2, MessageSquare, Sparkles, X } from "lucide-react";
import type { BiDataset } from "@/lib/bi/types";
import { answerFromData, followUpQuestion } from "@/lib/home/chatAnswers";
import { askAi } from "@/lib/home/askAi";
import { useDashboard } from "@/lib/DashboardContext";

const SUGGESTIONS = ["How much did we sell last month?", "Top 5 products", "Which products are out of stock?", "Most returns", "Ad spend last 30 days"];
type Msg = { role: "user" | "bot"; text: string; href?: string; hrefLabel?: string };

function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, i) => (
        <p key={i} className={i ? "mt-1" : undefined}>
          {line.split(/(\*\*[^*]+\*\*)/g).map((part, j) => (part.startsWith("**") && part.endsWith("**") ? <strong key={j} className="font-semibold text-slate-900 dark:text-white">{part.slice(2, -2)}</strong> : <span key={j}>{part}</span>))}
        </p>
      ))}
    </>
  );
}

export function ChatWidget() {
  const { loggedInUser } = useDashboard();
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // same query key as Home and the Business overview: one shared load
  const { data: ds, isLoading, isError } = useQuery<BiDataset>({
    queryKey: ["bi-dataset"],
    queryFn: async () => {
      const r = await fetch("/api/bi/dataset");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      return j as BiDataset;
    },
    staleTime: 10 * 60_000,
    enabled: open,
  });

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [messages, busy, open]);
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // the dataset covers B-ARM's channels only
  if (loggedInUser === "Lkn") return null;

  const ask = async (q: string) => {
    const question = q.trim();
    if (!question || !ds || busy) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", text: question }]);
    // a follow-up naming only a period ("i ask today") reuses the previous question
    const prevUser = [...messages].reverse().find((m) => m.role === "user")?.text;
    const follow = followUpQuestion(question, prevUser, ds.asOf);
    const local = answerFromData(ds, question) ?? (follow ? answerFromData(ds, follow) : null);
    if (local) { setMessages((m) => [...m, { role: "bot", ...local }]); return; }
    setBusy(true);
    try {
      setMessages((m) => [...m, { role: "bot", text: "" }]);
      const history = messages.filter((m) => m.text).slice(-6).map((m) => ({ role: m.role === "user" ? ("user" as const) : ("assistant" as const), content: m.text }));
      const text = await askAi(ds, question, history);
      setMessages((m) => [...m.slice(0, -1), { role: "bot", text }]);
    } catch (e) {
      setMessages((m) => [...m.slice(0, -1), { role: "bot", text: `The AI answer could not be fetched (${e instanceof Error ? e.message : "error"}). Questions about sales, products, stock, returns and ad spend are answered from your data.` }]);
    } finally { setBusy(false); }
  };

  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.section
            role="dialog"
            aria-label="Ask Marketplace360"
            initial={reduceMotion ? false : { opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.98 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="fixed z-50 bottom-24 right-4 sm:right-6 w-[min(400px,calc(100vw-32px))] h-[min(600px,calc(100vh-140px))] flex flex-col rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-[0_24px_60px_-20px_rgba(15,23,42,0.35)] overflow-hidden"
          >
            <header className="flex items-center justify-between px-4 py-3 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center gap-2.5">
                <span className="w-8 h-8 rounded-full bg-slate-900 dark:bg-white text-white dark:text-slate-900 flex items-center justify-center"><Sparkles className="w-4 h-4" aria-hidden /></span>
                <div>
                  <p className="text-sm font-semibold text-slate-900 dark:text-white leading-tight">Ask Marketplace360</p>
                  <p className="text-[11px] text-slate-500">{ds ? `Your data to ${ds.asOf.split("-").reverse().join(".")}` : "Answers from your sales, stock and ads data"}</p>
                </div>
              </div>
              <button onClick={() => setOpen(false)} aria-label="Close chat" className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"><X className="w-4 h-4" /></button>
            </header>

            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 text-sm">
              {messages.length === 0 && (
                <div className="text-slate-600 dark:text-slate-300 space-y-3">
                  <p>Hi! Ask about sales, orders, products, stock, returns or ad spend — for any marketplace and any period.</p>
                  {isLoading && <p className="flex items-center gap-2 text-xs text-slate-500"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading your data…</p>}
                  {isError && <p className="text-xs text-red-600">Couldn&apos;t load the data. Close and open the chat to try again.</p>}
                </div>
              )}
              {messages.map((m, i) => m.role === "user" ? (
                <div key={i} className="flex justify-end">
                  <div className="rounded-2xl rounded-br-md bg-slate-900 dark:bg-white text-white dark:text-slate-900 px-3.5 py-2 max-w-[85%]">{m.text}</div>
                </div>
              ) : (
                <div key={i} className="rounded-2xl rounded-bl-md bg-slate-50 dark:bg-slate-800 px-3.5 py-2.5 text-slate-700 dark:text-slate-300 max-w-[92%] leading-relaxed">
                  {m.text ? <Rich text={m.text} /> : <span className="flex items-center gap-2 text-slate-500"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Thinking…</span>}
                  {m.href && <Link href={m.href} onClick={() => setOpen(false)} className="mt-1.5 inline-flex items-center gap-0.5 text-xs font-semibold text-slate-900 dark:text-white underline underline-offset-2">{m.hrefLabel ?? "Open"} <ChevronRight className="h-3 w-3" /></Link>}
                </div>
              ))}
              <div ref={endRef} />
            </div>

            <div className="border-t border-slate-100 dark:border-slate-800 p-3 space-y-2">
              <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-none">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => ask(s)} disabled={!ds || busy} className="flex-shrink-0 rounded-full border border-slate-200 dark:border-slate-700 px-3 py-1 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50">{s}</button>
                ))}
              </div>
              <form onSubmit={(e) => { e.preventDefault(); ask(input); }} className="flex items-center gap-2 rounded-xl border border-slate-200 dark:border-slate-700 pl-3.5 pr-1.5 py-1.5 focus-within:border-slate-400">
                <label htmlFor="chat-ask" className="sr-only">Ask a question</label>
                <input id="chat-ask" ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask anything about the business" disabled={!ds} className="flex-1 bg-transparent text-sm text-slate-800 dark:text-slate-100 placeholder:text-slate-400 outline-none py-1" />
                <button type="submit" disabled={!input.trim() || !ds || busy} aria-label="Send" className="w-8 h-8 rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 flex items-center justify-center disabled:opacity-30"><ArrowUp className="w-4 h-4" /></button>
              </form>
            </div>
          </motion.section>
        )}
      </AnimatePresence>

      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Close chat" : "Ask Marketplace360"}
        aria-expanded={open}
        className="fixed z-50 bottom-5 right-4 sm:right-6 h-14 w-14 rounded-full bg-slate-900 dark:bg-white text-white dark:text-slate-900 shadow-[0_12px_32px_-8px_rgba(15,23,42,0.45)] flex items-center justify-center hover:scale-105 active:scale-95 transition-transform focus:outline-none focus-visible:ring-4 focus-visible:ring-slate-400/40"
      >
        {open ? <X className="w-5 h-5" /> : <MessageSquare className="w-5 h-5" />}
      </button>
    </>
  );
}
