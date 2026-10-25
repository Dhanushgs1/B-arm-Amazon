"use client";

import { Search, X } from "lucide-react";

/** Search box for the product-wise tables; matching is matchesProductQuery (lib/productSearch). */
export function ProductSearchBox({ value, onChange, shown, total, placeholder = "Search product name or SKU…", noun = "products" }: { value: string; onChange: (v: string) => void; shown: number; total: number; placeholder?: string; noun?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative flex-1 min-w-[200px] max-w-sm">
        <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
        <input
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={`Search ${noun}`}
          className="w-full rounded-xl border border-border bg-background pl-8 pr-8 py-2 text-xs outline-none focus:ring-2 focus:ring-primary/30"
        />
        {value && (
          <button type="button" onClick={() => onChange("")} aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md text-muted-foreground hover:text-foreground">
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {value && (
        <span className="text-[11px] text-muted-foreground">
          {shown} of {total} {noun}
        </span>
      )}
    </div>
  );
}
