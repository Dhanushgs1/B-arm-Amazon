"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useDashboard } from "@/lib/DashboardContext";
import { mcpAllTargets } from "@/lib/api";

/**
 * Invisible component — mounts in the dashboard layout and silently
 * prefetches the bid target inventory into the React Query cache as
 * soon as the account context is resolved.
 *
 * By the time the user navigates to /dashboard/bids the data is already
 * cached, so the page renders instantly instead of waiting 1–5 minutes.
 */
export function BidsPrefetcher() {
  const { keySlot, account, contextLoading } = useDashboard();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (contextLoading || !account) return;

    const cacheKey = ["bid_targets", keySlot, account.id];

    // Only prefetch if not already in cache
    const existing = queryClient.getQueryData(cacheKey);
    if (existing) return;

    // Fire-and-forget — prefetch silently in the background
    queryClient.prefetchQuery({
      queryKey: cacheKey,
      queryFn: () =>
        mcpAllTargets(
          {
            amazon_account_id: account.id,
            workspace_id: account.workspace_id,
            state: ["ENABLED"],
          },
          keySlot,
          6
        ),
      staleTime: 15 * 60 * 1000, // 15 min
    });
  }, [contextLoading, account, keySlot, queryClient]);

  // Renders nothing — purely a side-effect component
  return null;
}
