"use client";

import { Fragment, useMemo } from "react";
import { parseMarkdown, type Inline } from "@/lib/simpleMarkdown";
import { cn } from "@/lib/utils";

function Inlines({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.t === "b" ? <strong key={i} className="font-bold text-foreground">{p.v}</strong>
        : p.t === "code" ? <code key={i} className="px-1 py-0.5 rounded bg-muted text-[0.9em] font-mono">{p.v}</code>
        : p.t === "link" ? (
          <a key={i} href={p.href} target={p.href.startsWith("http") ? "_blank" : undefined} rel="noreferrer" className="font-semibold text-indigo-600 dark:text-indigo-400 hover:underline">{p.v}</a>
        )
        : <Fragment key={i}>{p.v}</Fragment>,
      )}
    </>
  );
}

const H_CLS = { 1: "text-2xl font-black mt-2", 2: "text-lg font-black mt-6 pt-4 border-t border-border", 3: "text-sm font-black mt-4", 4: "text-xs font-black uppercase tracking-wider mt-3 text-muted-foreground" };

/** Renders a repo Markdown doc (see lib/simpleMarkdown) with a contents list of its ## sections. */
export function MarkdownDoc({ markdown }: { markdown: string }) {
  const blocks = useMemo(() => parseMarkdown(markdown), [markdown]);
  const toc = blocks.filter((b) => b.type === "h" && b.level === 2);
  return (
    <div className="space-y-3 text-sm text-muted-foreground leading-relaxed">
      {toc.length > 2 && (
        <nav className="rounded-xl border border-border bg-muted/30 p-3 flex flex-wrap gap-x-4 gap-y-1">
          {toc.map((h) => h.type === "h" && (
            <a key={h.id} href={`#${h.id}`} className="text-xs font-bold text-indigo-600 dark:text-indigo-400 hover:underline">
              {h.text.map((p) => p.v).join("")}
            </a>
          ))}
        </nav>
      )}
      {blocks.map((b, i) => {
        switch (b.type) {
          case "h": {
            const Tag = (`h${b.level}`) as "h1" | "h2" | "h3" | "h4";
            return <Tag key={i} id={b.id} className={cn("text-foreground scroll-mt-4", H_CLS[b.level])}><Inlines parts={b.text} /></Tag>;
          }
          case "p":
            return <p key={i}><Inlines parts={b.text} /></p>;
          case "ul":
          case "ol": {
            const List = b.type;
            return (
              <List key={i} className={cn("pl-5 space-y-1", b.type === "ul" ? "list-disc" : "list-decimal")}>
                {b.items.map((it, j) => <li key={j}><Inlines parts={it} /></li>)}
              </List>
            );
          }
          case "table":
            return (
              <div key={i} className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50">
                    <tr>{b.head.map((c, j) => <th key={j} className="text-left px-3 py-2 font-black text-foreground"><Inlines parts={c} /></th>)}</tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j} className="border-t border-border/60 align-top">
                        {r.map((c, k) => <td key={k} className="px-3 py-2"><Inlines parts={c} /></td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "code":
            return <pre key={i} className="rounded-xl bg-muted p-3 text-xs font-mono overflow-x-auto">{b.text}</pre>;
          case "hr":
            return <hr key={i} className="border-border" />;
        }
      })}
    </div>
  );
}
