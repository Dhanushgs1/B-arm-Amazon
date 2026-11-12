"use client";

// Total sales per day for one channel, for the marketplace pages' trend charts. Read from the
// Business overview dataset (/api/bi/dataset: the B-ARM ERP's figures for the months it covers, the
// order reports otherwise — the same basis as each page's Gross Sales card). Same query key as the
// Business overview page, so they share one load.

import { useQuery } from "@tanstack/react-query";
import type { BiDataset, SalesChannelId } from "@/lib/bi/types";

export function useBiDailySales(channel: SalesChannelId): Map<string, number> {
  const q = useQuery<BiDataset>({
    queryKey: ["bi-dataset"],
    queryFn: async () => {
      const r = await fetch("/api/bi/dataset");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      return j as BiDataset;
    },
    staleTime: 10 * 60_000,
  });
  const out = new Map<string, number>();
  const ch = q.data?.channels.find((c) => c.id === channel);
  if (q.data && ch) q.data.dates.forEach((d, i) => { const v = ch.revenue[i]; if (v !== null && v !== undefined) out.set(d, v); });
  return out;
}
