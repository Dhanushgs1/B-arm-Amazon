"use client";

// Home: the first page after sign-in. Neutral and quiet (user, 12 Nov 2026: no colour): a greeting,
// the key figures in one row, and a briefing list with a link from each line to the page behind
// it. Questions go to the chat button at the bottom-right (components/chat/ChatWidget.tsx).
// Figures: the Business overview dataset (/api/bi/dataset).

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Boxes, Megaphone, MessageSquare, Package, RotateCcw, TrendingUp, type LucideIcon } from "lucide-react";
import type { BiDataset } from "@/lib/bi/types";
import { homeHeadlines, homeTiles, type Headline } from "@/lib/home/headlines";

const ICON: Record<Headline["kind"], LucideIcon> = { sales: TrendingUp, units: Package, stock: Boxes, ads: Megaphone, returns: RotateCcw };

/** "**bold**" → <strong> */
function Rich({ text }: { text: string }) {
  return <>{text.split(/(\*\*[^*]+\*\*)/g).map((part, j) => (part.startsWith("**") && part.endsWith("**") ? <strong key={j} className="font-semibold text-slate-900 dark:text-white">{part.slice(2, -2)}</strong> : <span key={j}>{part}</span>))}</>;
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}
const dayLong = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });
};
const dayShort = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
};

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

  const headlines = ds ? homeHeadlines(ds) : [];
  const tiles = ds ? homeTiles(ds) : [];
  const erpThrough = ds?.misCoverage ? Object.values(ds.misCoverage).map((c) => c?.end).filter((d): d is string => !!d).sort()[0] : undefined;

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-24">
      <header className="pt-2">
        <h1 className="font-serif text-[34px] leading-tight font-semibold tracking-tight text-slate-900 dark:text-white">{greeting()}</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
          {ds ? <>Figures to {dayLong(ds.asOf)}{erpThrough ? <> · ERP figures to {dayShort(erpThrough)}</> : null}</> : "Loading your figures…"}
        </p>
      </header>

      {isError && (
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
          Couldn&apos;t load the figures ({error instanceof Error ? error.message : "error"}).{" "}
          <button onClick={() => refetch()} className="font-semibold underline underline-offset-2">Try again</button>
        </div>
      )}

      {/* key figures */}
      <section aria-label="Key figures" className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-px rounded-2xl overflow-hidden border border-slate-200 dark:border-slate-800 bg-slate-200 dark:bg-slate-800">
        {(isLoading ? Array.from({ length: 5 }).map(() => null) : tiles).map((t, i) => t === null ? (
          <div key={i} className="bg-white dark:bg-slate-900 p-5 h-[120px]"><div className="h-full rounded-lg bg-slate-100 dark:bg-slate-800 animate-pulse" /></div>
        ) : (
          <Link key={t.label} href={t.href} className="group bg-white dark:bg-slate-900 p-5 hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors">
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400 flex items-center justify-between gap-2">
              {t.label}
              <ArrowUpRight className="w-3.5 h-3.5 text-slate-300 group-hover:text-slate-500 transition-colors" aria-hidden />
            </p>
            <p className="mt-2 text-[26px] leading-none font-semibold tracking-tight text-slate-900 dark:text-white tabular-nums">{t.value}</p>
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              {t.change !== null && Number.isFinite(t.change) && (
                <span className="font-semibold text-slate-700 dark:text-slate-200 mr-1">{t.change >= 0 ? "▲" : "▼"} {Math.abs(t.change).toFixed(1)}%</span>
              )}
              {t.sub}
            </p>
          </Link>
        ))}
      </section>

      {/* briefing */}
      <section aria-label="Briefing" className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="flex items-baseline justify-between gap-2 px-6 pt-5 pb-3">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Briefing</h2>
          {ds && <span className="text-xs text-slate-400">last 7 to 30 days, and last month</span>}
        </div>
        {isLoading && (
          <div className="px-6 pb-6 space-y-3" role="status" aria-label="Loading">
            {Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-12 rounded-lg bg-slate-100 dark:bg-slate-800 animate-pulse" />)}
            <p className="text-xs text-slate-500">The first load after a restart can take up to a couple of minutes; later loads are instant.</p>
          </div>
        )}
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {headlines.map((h, i) => {
            const Icon = ICON[h.kind];
            return (
              <li key={i} className="flex items-start gap-4 px-6 py-4">
                <span className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400" aria-hidden>
                  <Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] leading-relaxed text-slate-600 dark:text-slate-300"><Rich text={h.text} /></p>
                  <Link href={h.href} className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-slate-900 dark:text-white underline decoration-slate-300 underline-offset-4 hover:decoration-slate-900">
                    {h.linkLabel} <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <p className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
        <MessageSquare className="w-4 h-4" aria-hidden /> Have a question? Use the chat button at the bottom-right — it answers from your sales, stock and ads data.
      </p>
    </div>
  );
}
