"use client";

// Home: the first page after sign-in, in the B-ARM ERP's style (user, 12 Nov 2026) — a greeting,
// five headline cards with a link each, an "Ask anything" chat, and KPI tiles on the right.
// Figures: the Business overview dataset (/api/bi/dataset). Chat: answers from that data first
// (lib/home/chatAnswers.ts); other questions go to AI through /api/hub-llm when a key is set there.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowUp, ChevronRight, Loader2, Sparkles, TrendingDown, TrendingUp } from "lucide-react";
import type { BiDataset } from "@/lib/bi/types";
import { answerFromData, dataSummaryForAi, type ChatAnswer } from "@/lib/home/chatAnswers";
import { homeHeadlines, homeTiles } from "@/lib/home/headlines";
import { cn } from "@/lib/utils";

const SUGGESTIONS = ["How much did we sell last month?", "What are our top 5 products?", "Which products are out of stock?", "Which product has the most returns?", "Ad spend last 30 days"];

type Msg = { role: "user" | "bot"; text: string; href?: string; hrefLabel?: string };

/** "**bold**" → <strong>; one line per row. */
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

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}
const dayLong = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
};

async function askAi(ds: BiDataset, question: string): Promise<string> {
  const cfg = await fetch("/api/hub-llm").then((r) => (r.ok ? r.json() : { groq: false, anthropic: false })).catch(() => ({ groq: false, anthropic: false }));
  if (!cfg.anthropic && !cfg.groq) {
    return "I can answer questions about **sales**, **orders**, **top products**, **stock**, **returns** and **ad spend** from your data — try one of the suggestions below. Other questions need an AI key (ANTHROPIC_API_KEY or GROQ_API_KEY) set on the server.";
  }
  const system = `You are the analyst for B-ARM's Marketplace360 dashboard. Answer briefly (under 120 words), in plain English, using only the data below. Use ₹ and the Indian number format. If the data does not cover the question, say so.\n\n${dataSummaryForAi(ds)}`;
  const provider = cfg.anthropic ? "anthropic" : "groq";
  const payload = provider === "anthropic"
    ? { model: "claude-sonnet-5-5", system, messages: [{ role: "user", content: question }], max_tokens: 600, temperature: 0.2 }
    : { model: "llama-3.3-70b-versatile", messages: [{ role: "system", content: system }, { role: "user", content: question }], max_tokens: 600, temperature: 0.2 };
  const r = await fetch("/api/hub-llm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, payload }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || j?.error || `HTTP ${r.status}`);
  const text = provider === "anthropic" ? j?.content?.[0]?.text : j?.choices?.[0]?.message?.content;
  return String(text || "No answer came back.");
}

export function HomeDashboard() {
  const { data: ds, isLoading, isError, error, refetch } = useQuery<BiDataset>({
    queryKey: ["bi-dataset"],
    queryFn: async () => {
      const r = await fetch("/api/bi/dataset");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      return j as BiDataset;
    },
    staleTime: 10 * 60_000,
  });

  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [messages, busy]);

  const ask = async (q: string) => {
    const question = q.trim();
    if (!question || !ds || busy) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", text: question }]);
    const local: ChatAnswer | null = answerFromData(ds, question);
    if (local) { setMessages((m) => [...m, { role: "bot", ...local }]); return; }
    setBusy(true);
    try {
      const text = await askAi(ds, question);
      setMessages((m) => [...m, { role: "bot", text }]);
    } catch (e) {
      setMessages((m) => [...m, { role: "bot", text: `The AI answer could not be fetched (${e instanceof Error ? e.message : "error"}). Questions about sales, products, stock, returns and ad spend are answered from your data.` }]);
    } finally { setBusy(false); }
  };

  const headlines = ds ? homeHeadlines(ds) : [];
  const tiles = ds ? homeTiles(ds) : [];
  const erpThrough = ds?.misCoverage ? Object.values(ds.misCoverage).map((c) => c?.end).filter((d): d is string => !!d).sort()[0] : undefined;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_300px] gap-5 pb-10">
      {/* main card */}
      <section className="rounded-3xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.04)] p-6 sm:p-8 flex flex-col min-h-[640px]">
        <header className="mb-6">
          <h1 className="font-serif text-[34px] leading-tight font-semibold tracking-tight text-slate-900 dark:text-white">{greeting()}</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            {ds ? <>Figures to {dayLong(ds.asOf)}{erpThrough ? <> · ERP figures to {dayLong(erpThrough)}</> : null}</> : "Loading your figures…"}
          </p>
        </header>

        {isLoading && (
          <div role="status" aria-label="Loading" className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-16 rounded-2xl bg-slate-100 dark:bg-slate-800 animate-pulse" />)}
            <p className="text-xs text-slate-500">The first load after a restart takes up to a minute; later loads are instant.</p>
          </div>
        )}
        {isError && (
          <div className="rounded-2xl border border-red-200 bg-red-50 dark:bg-red-950/20 px-4 py-3 text-sm text-red-700 dark:text-red-300">
            Couldn&apos;t load the figures ({error instanceof Error ? error.message : "error"}).{" "}
            <button onClick={() => refetch()} className="font-semibold underline">Try again</button>
          </div>
        )}

        {/* headlines + conversation share one scrolling column */}
        <div className="flex-1 space-y-4 overflow-y-auto pr-1">
          {headlines.map((h, i) => (
            <div key={i} className="flex items-start gap-3">
              <span className={cn("mt-1 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-white", h.tone === "bad" ? "bg-rose-500" : h.tone === "good" ? "bg-emerald-500" : "bg-blue-600")} aria-hidden>
                <Sparkles className="h-4 w-4" />
              </span>
              <div className="rounded-2xl bg-slate-50 dark:bg-slate-800/60 px-4 py-3 text-[15px] leading-relaxed text-slate-700 dark:text-slate-300 max-w-3xl">
                <Rich text={h.text} />
                <Link href={h.href} className="mt-1.5 inline-flex items-center gap-0.5 text-sm font-semibold text-blue-600 hover:text-blue-700 dark:text-blue-400">
                  {h.linkLabel} <ChevronRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            </div>
          ))}

          {messages.map((m, i) => m.role === "user" ? (
            <div key={`m${i}`} className="flex justify-end">
              <div className="rounded-2xl rounded-br-md bg-blue-600 text-white px-4 py-2.5 text-[15px] max-w-xl">{m.text}</div>
            </div>
          ) : (
            <div key={`m${i}`} className="flex items-start gap-3">
              <span className="mt-1 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-blue-600 text-white" aria-hidden><Sparkles className="h-4 w-4" /></span>
              <div className="rounded-2xl rounded-tl-md bg-slate-50 dark:bg-slate-800/60 px-4 py-3 text-[15px] leading-relaxed text-slate-700 dark:text-slate-300 max-w-3xl">
                <Rich text={m.text} />
                {m.href && <Link href={m.href} className="mt-1.5 inline-flex items-center gap-0.5 text-sm font-semibold text-blue-600 hover:text-blue-700 dark:text-blue-400">{m.hrefLabel ?? "Open"} <ChevronRight className="h-3.5 w-3.5" /></Link>}
              </div>
            </div>
          ))}
          {busy && (
            <div className="flex items-center gap-2 pl-11 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Thinking…</div>
          )}
          <div ref={endRef} />
        </div>

        {/* ask */}
        <div className="mt-6 space-y-3">
          <div className="flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => ask(s)} disabled={!ds || busy} className="rounded-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3.5 py-1.5 text-sm text-slate-600 dark:text-slate-300 hover:border-blue-300 hover:text-blue-700 transition-colors disabled:opacity-50">
                {s}
              </button>
            ))}
          </div>
          <form onSubmit={(e) => { e.preventDefault(); ask(input); }} className="flex items-center gap-2 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 pl-5 pr-2 py-2 focus-within:border-blue-400 focus-within:ring-4 focus-within:ring-blue-500/10 transition">
            <label htmlFor="home-ask" className="sr-only">Ask anything about the business</label>
            <input id="home-ask" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask anything about the business" disabled={!ds} className="flex-1 bg-transparent py-1.5 text-[15px] text-slate-800 dark:text-slate-100 placeholder:text-slate-400 outline-none" />
            <button type="submit" disabled={!input.trim() || !ds || busy} aria-label="Send" className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-300 transition-colors">
              <ArrowUp className="h-4 w-4" />
            </button>
          </form>
        </div>
      </section>

      {/* KPI tiles */}
      <aside className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-1 gap-4 content-start">
        {(isLoading ? Array.from({ length: 5 }).map(() => null) : tiles).map((t, i) => t === null ? (
          <div key={i} className="h-32 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 animate-pulse" />
        ) : (
          <Link key={t.label} href={t.href} className="block rounded-3xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] hover:border-blue-200 hover:shadow-md transition">
            <p className="text-sm font-medium text-slate-500 dark:text-slate-400">{t.label}</p>
            <p className="mt-2 text-[30px] leading-none font-bold tracking-tight text-slate-900 dark:text-white tabular-nums">{t.value}</p>
            <p className="mt-2.5 flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400">
              {t.change !== null && Number.isFinite(t.change) && (
                <span className={cn("inline-flex items-center gap-0.5 font-semibold", (t.change >= 0) !== !!t.inverse ? "text-emerald-600" : "text-rose-600")}>
                  {t.change >= 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}{Math.abs(t.change).toFixed(1)}%
                </span>
              )}
              <span>{t.sub}</span>
            </p>
          </Link>
        ))}
      </aside>
    </div>
  );
}
