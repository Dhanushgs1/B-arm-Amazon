"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Search, Download } from "lucide-react";
import { cn } from "@/lib/utils";

interface Column<T> {
  key: string;
  label: string;
  sortable?: boolean;
  render?: (val: any, row: T) => React.ReactNode;
}

interface DataTableProps<T> {
  data: T[];
  columns: Column<T>[];
  defaultSort?: string;
}

export function DataTable<T>({ data, columns, defaultSort }: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(defaultSort || null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const pageSize = 25;

  let filtered = data;
  if (search) {
    const q = search.toLowerCase();
    filtered = data.filter((row: any) =>
      columns.some((c) => String(row[c.key] || "").toLowerCase().includes(q))
    );
  }

  if (sortKey) {
    filtered = [...filtered].sort((a: any, b: any) => {
      const x = a[sortKey];
      const y = b[sortKey];
      if (x == null) return 1;
      if (y == null) return -1;
      const cmp = typeof x === "number" ? x - y : String(x).localeCompare(String(y));
      return sortDir === "asc" ? cmp : -cmp;
    });
  }

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const view = filtered.slice(page * pageSize, (page + 1) * pageSize);

  return (
    <div className="glass rounded-2xl border border-border shadow-sm flex flex-col overflow-hidden">
      <div className="p-4 border-b border-border flex items-center justify-between bg-card/50">
        <div className="relative w-64">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            placeholder="Filter rows..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            className="w-full bg-background border border-border text-foreground pl-9 pr-4 py-1.5 rounded-lg text-sm focus:border-primary focus:outline-none transition-colors"
          />
        </div>
        <div className="flex items-center gap-4">
          <span className="text-xs font-semibold text-muted-foreground">{filtered.length} rows</span>
          <button className="flex items-center gap-2 bg-background border border-border px-3 py-1.5 rounded-lg text-xs font-bold hover:border-primary transition-colors">
            <Download className="w-4 h-4" /> Export CSV
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm whitespace-nowrap">
          <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground sticky top-0 z-10 border-b border-border">
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  onClick={() => {
                    if (!c.sortable) return;
                    if (sortKey === c.key) setSortDir(sortDir === "asc" ? "desc" : "asc");
                    else { setSortKey(c.key); setSortDir("desc"); }
                  }}
                  className={cn("px-4 py-3 font-bold", c.sortable && "cursor-pointer hover:text-foreground")}
                >
                  <div className="flex items-center gap-1">
                    {c.label}
                    {sortKey === c.key && (
                      sortDir === "asc" ? <ChevronUp className="w-3 h-3 text-primary" /> : <ChevronDown className="w-3 h-3 text-primary" />
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {view.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-12 text-center text-muted-foreground">
                  No data found.
                </td>
              </tr>
            ) : (
              view.map((row: any, i) => (
                <tr key={i} className="hover:bg-muted/30 transition-colors">
                  {columns.map((c) => (
                    <td key={c.key} className="px-4 py-3 font-medium">
                      {c.render ? c.render(row[c.key], row) : row[c.key] ?? "—"}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="p-3 border-t border-border flex items-center justify-between bg-card/50 text-xs font-semibold text-muted-foreground">
        <span>Page {page + 1} of {pages}</span>
        <div className="flex gap-2">
          <button
            onClick={() => setPage(Math.max(0, page - 1))}
            disabled={page === 0}
            className="px-3 py-1.5 rounded-md border border-border hover:bg-muted disabled:opacity-50"
          >
            Prev
          </button>
          <button
            onClick={() => setPage(Math.min(pages - 1, page + 1))}
            disabled={page >= pages - 1}
            className="px-3 py-1.5 rounded-md border border-border hover:bg-muted disabled:opacity-50"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
