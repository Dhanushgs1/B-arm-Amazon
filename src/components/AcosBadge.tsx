"use client";

import { cn } from "@/lib/utils";

// Business rule: ACOS above 13% is unhealthy (red); 13% and below is healthy (green).
export const ACOS_LIMIT = 13;

export function AcosBadge({ value }: { value: number }) {
  if (!value) {
    return <span className="text-muted-foreground text-xs font-semibold">—</span>;
  }
  const isHigh = value > ACOS_LIMIT;
  return (
    <span
      className={cn(
        "px-2 py-0.5 rounded-full text-xs font-bold inline-flex items-center gap-1",
        isHigh
          ? "bg-red-500/15 text-red-700 dark:text-red-400 border border-red-300/50 dark:border-red-800"
          : "bg-green-500/10 text-green-700 dark:text-green-400 border border-green-300/50 dark:border-green-900"
      )}
    >
      {isHigh && <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />}
      {value.toFixed(2)}%
    </span>
  );
}

export function acosRowClass(row: { acos?: number }) {
  return row.acos && row.acos > ACOS_LIMIT
    ? "bg-red-500/[0.04] hover:bg-red-500/[0.08] dark:bg-red-500/[0.06] dark:hover:bg-red-500/10"
    : "";
}
