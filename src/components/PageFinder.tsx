"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, CornerDownLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { findPages, type PageEntry } from "@/lib/pageFinderRules";

// The header search box. It used to be an input with no handler; it now finds a dashboard page by
// name (or by a word in its description) and opens it. Ctrl+K / ⌘K focuses it from anywhere.
// Only pages that work with uploaded data are listed — the SellerMate-only screens are hidden.

export function PageFinder({ className }: { className?: string }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => findPages(q), [q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = (p: PageEntry | undefined) => {
    if (!p) return;
    setQ("");
    setOpen(false);
    inputRef.current?.blur();
    router.push(p.href);
  };

  const listId = "page-finder-results";
  const showList = open && q.trim().length > 0;

  return (
    <div className={cn("relative", className)}>
      <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500 pointer-events-none" aria-hidden="true" />
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => { setQ(e.target.value); setActive(0); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, Math.max(results.length - 1, 0))); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
          else if (e.key === "Enter") { e.preventDefault(); go(results[active]); }
          else if (e.key === "Escape") { setQ(""); setOpen(false); }
        }}
        placeholder="Find a page…  Ctrl K"
        aria-label="Find a dashboard page"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && results[active] ? `${listId}-${active}` : undefined}
        className="w-full bg-slate-100/80 dark:bg-slate-900 ring-1 ring-slate-200/70 dark:ring-slate-800 text-foreground pl-10 pr-4 py-2.5 rounded-xl text-xs font-semibold placeholder:text-slate-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      />
      {showList && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Matching pages"
          className="absolute left-0 min-w-full w-[320px] max-w-[calc(100vw-2rem)] mt-2 z-50 rounded-xl border border-border bg-popover backdrop-blur-xl shadow-xl p-1.5 text-xs"
        >
          {results.length === 0 ? (
            <li className="px-3 py-2.5 text-muted-foreground font-semibold">No page matches “{q.trim()}”</li>
          ) : (
            results.map((p, i) => (
              <li
                key={p.href}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => { e.preventDefault(); go(p); }}
                onMouseEnter={() => setActive(i)}
                className={cn("flex items-center justify-between gap-3 px-3 py-2 rounded-lg cursor-pointer", i === active ? "bg-primary text-primary-foreground" : "text-foreground")}
              >
                <span className="font-bold truncate">{p.label}</span>
                <span className={cn("flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide flex-shrink-0", i === active ? "text-primary-foreground/80" : "text-muted-foreground")}>
                  {p.group}
                  {i === active && <CornerDownLeft className="w-3 h-3" aria-hidden="true" />}
                </span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
