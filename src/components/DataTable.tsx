"use client";

import { useState, useTransition } from "react";
import { ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Search, Columns3, FileSpreadsheet, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { exportToExcel } from "@/lib/excelExport";

interface Column<T> {
  key: string;
  label: string;
  sortable?: boolean;
  render?: (val: any, row: T) => React.ReactNode;
  summable?: boolean;
}

interface DataTableProps<T> {
  data: T[];
  columns: Column<T>[];
  defaultSort?: string;
  rowClassName?: (row: T) => string;
  exportName?: string;
  pageSize?: number;
  onRowClick?: (row: T) => void;
  disablePagination?: boolean;
}

export function DataTable<T>({ 
  data, 
  columns, 
  defaultSort, 
  rowClassName, 
  exportName, 
  pageSize = 25, 
  onRowClick,
  disablePagination = true
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(defaultSort || null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [search, setSearch] = useState("");
  const [displaySearch, setDisplaySearch] = useState("");
  const [page, setPage] = useState(0);
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(new Set());
  const [showColPicker, setShowColPicker] = useState(false);
  const [currentPageSize, setCurrentPageSize] = useState(pageSize);
  const [isPending, startTransition] = useTransition();

  const visibleColumns = columns.filter((c) => !hiddenCols.has(c.key));

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

  const effectivePageSize = disablePagination ? Math.max(1, filtered.length) : currentPageSize;
  const pageCount = Math.max(1, Math.ceil(filtered.length / effectivePageSize));
  const safePage = Math.min(page, pageCount - 1);
  const view = filtered.slice(safePage * effectivePageSize, (safePage + 1) * effectivePageSize);

  const handleExport = () => {
    exportToExcel(filtered, columns as any, exportName || "export");
  };

  const hasTotalsRow = visibleColumns.some((c) => c.summable);
  const totals: Record<string, number> = {};
  if (hasTotalsRow) {
    visibleColumns.forEach((c) => {
      if (!c.summable) return;
      totals[c.key] = filtered.reduce((sum: number, row: any) => sum + (Number(row[c.key]) || 0), 0);
    });
  }

  return (
    <div className="glass gradient-border rounded-[22px] flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="p-4 border-b border-border flex items-center justify-between gap-3 flex-wrap bg-card/50">
        <div className="relative w-64">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            placeholder="Quick search..."
            value={displaySearch}
            onChange={(e) => {
              const val = e.target.value;
              setDisplaySearch(val);
              startTransition(() => {
                setSearch(val);
                setPage(0);
              });
            }}
            className="w-full bg-background border border-border text-foreground pl-9 pr-9 py-2 rounded-xl text-sm font-semibold focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none transition-all"
          />
          {isPending && (
            <Loader2 className="w-3.5 h-3.5 absolute right-3 top-1/2 -translate-y-1/2 text-primary animate-spin" />
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs font-bold text-muted-foreground bg-muted px-2.5 py-1 rounded-full">{filtered.length.toLocaleString("en-IN")} rows</span>
          {!disablePagination && (
            <select
              value={currentPageSize}
              onChange={(e) => { setCurrentPageSize(Number(e.target.value)); setPage(0); }}
              className="bg-background border border-border text-foreground px-2.5 py-1.5 rounded-xl text-xs font-bold focus:border-primary focus:outline-none cursor-pointer"
            >
              {[25, 50, 100, 200].map((s) => (
                <option key={s} value={s}>{s} / page</option>
              ))}
            </select>
          )}

          {/* Column picker */}
          <div className="relative">
            <button
              onClick={() => setShowColPicker(!showColPicker)}
              className="flex items-center gap-2 bg-background border border-border px-3 py-2 rounded-xl text-xs font-bold hover:border-primary transition-colors"
            >
              <Columns3 className="w-4 h-4" /> Columns
            </button>
            {showColPicker && (
              <div className="absolute right-0 top-full mt-2 w-52 max-h-72 overflow-y-auto bg-popover border border-border rounded-2xl shadow-xl z-30 p-2">
                {columns.map((c) => (
                  <label key={c.key} className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg hover:bg-muted cursor-pointer text-xs font-bold">
                    <input
                      type="checkbox"
                      checked={!hiddenCols.has(c.key)}
                      onChange={() => {
                        const next = new Set(hiddenCols);
                        if (next.has(c.key)) next.delete(c.key);
                        else if (visibleColumns.length > 1) next.add(c.key);
                        setHiddenCols(next);
                      }}
                      className="accent-[#6C63FF]"
                    />
                    {c.label}
                  </label>
                ))}
              </div>
            )}
          </div>

          <button onClick={handleExport} className="flex items-center gap-2 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white border border-emerald-500/50 px-3 py-2 rounded-xl text-xs font-bold hover:shadow-md hover:-translate-y-0.5 transition-all">
            <FileSpreadsheet className="w-4 h-4" /> Export Excel
          </button>
        </div>
      </div>

      <div className="overflow-x-auto max-h-[640px] overflow-y-auto">
        <table className="w-full text-left text-sm whitespace-nowrap">
          <thead className="bg-muted/80 backdrop-blur-sm text-[11px] uppercase tracking-wider text-muted-foreground sticky top-0 z-10 border-b border-border">
            <tr>
              {visibleColumns.map((c) => (
                <th
                  key={c.key}
                  onClick={() => {
                    if (!c.sortable) return;
                    if (sortKey === c.key) setSortDir(sortDir === "asc" ? "desc" : "asc");
                    else { setSortKey(c.key); setSortDir("desc"); }
                  }}
                  className={cn("px-4 py-3.5 font-extrabold select-none", c.sortable && "cursor-pointer hover:text-foreground")}
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
                <td colSpan={visibleColumns.length} className="px-4 py-16 text-center">
                  <p className="text-3xl mb-2">🔍</p>
                  <p className="font-bold text-muted-foreground">No data found</p>
                  <p className="text-xs text-muted-foreground mt-1">Try adjusting your search or filters.</p>
                </td>
              </tr>
            ) : (
              view.map((row: any, i) => (
                <tr
                  key={i}
                  onClick={() => onRowClick?.(row)}
                  className={cn(
                    "transition-colors group/row",
                    onRowClick && "cursor-pointer",
                    "hover:bg-indigo-50/60 dark:hover:bg-indigo-950/20",
                    rowClassName?.(row)
                  )}
                >
                  {visibleColumns.map((c) => (
                    <td key={c.key} className="px-4 py-3 font-medium">
                      {c.render ? c.render(row[c.key], row) : row[c.key] ?? "—"}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
          {hasTotalsRow && filtered.length > 0 && (
            <tfoot className="sticky bottom-0 z-10 bg-muted/90 backdrop-blur-sm border-t-2 border-border">
              <tr>
                {visibleColumns.map((c, idx) => (
                  <td key={c.key} className="px-4 py-3 font-extrabold">
                    {idx === 0
                      ? "Total"
                      : c.summable
                      ? (c.render ? c.render(totals[c.key], {} as T) : totals[c.key])
                      : "—"}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* Pagination */}
      {pageCount > 1 && (
        <div className="p-3.5 border-t border-border flex items-center justify-between bg-card/50">
          <span className="text-xs font-bold text-muted-foreground">
            Page {safePage + 1} of {pageCount} · showing {view.length} of {filtered.length.toLocaleString("en-IN")}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              disabled={safePage === 0}
              onClick={() => setPage(safePage - 1)}
              className="w-8 h-8 rounded-lg border border-border flex items-center justify-center hover:border-primary disabled:opacity-40 disabled:hover:border-border transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            {Array.from({ length: Math.min(5, pageCount) }, (_, idx) => {
              const start = Math.max(0, Math.min(safePage - 2, pageCount - 5));
              const p = start + idx;
              return (
                <button
                  key={p}
                  onClick={() => setPage(p)}
                  className={cn(
                    "w-8 h-8 rounded-lg text-xs font-extrabold transition-colors",
                    p === safePage
                      ? "bg-gradient-to-r from-[#6D5EF8] to-[#8B5CF6] text-white shadow-sm"
                      : "border border-border hover:border-primary"
                  )}
                >
                  {p + 1}
                </button>
              );
            })}
            <button
              disabled={safePage >= pageCount - 1}
              onClick={() => setPage(safePage + 1)}
              className="w-8 h-8 rounded-lg border border-border flex items-center justify-center hover:border-primary disabled:opacity-40 disabled:hover:border-border transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
